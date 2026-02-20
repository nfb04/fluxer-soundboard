import 'dotenv/config';
import { Client, Events, EmbedBuilder, Routes } from '@fluxerjs/core';
import { getVoiceManager } from '@fluxerjs/voice';
import * as nodeEmoji from 'node-emoji';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createReadStream, createWriteStream, writeFileSync, readFileSync, unlinkSync, existsSync, statSync, mkdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';

const execAsync = promisify(exec);

// Timestamped logging
const ts = () => `[${new Date().toISOString()}]`;
const log = (...args) => console.log(ts(), ...args);
const logError = (...args) => console.error(ts(), ...args);
const logWarn = (...args) => console.warn(ts(), ...args);

const client = new Client();
const voiceManager = getVoiceManager(client);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to sounds config file (persistent storage)
const SOUNDS_CONFIG_PATH = join(__dirname, 'sounds-config.json');
const RECONNECT_DELAYS_MS = [10_000, 20_000, 30_000, 60_000, 60_000]; // then keeps 60s
const KEEPALIVE_INTERVAL_MS = 60_000; // check REST connectivity every 60s
let reconnecting = false;
let keepaliveInterval = null;
let voiceCheckInterval = null;
const MAX_SOUND_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_SOUND_DURATION_SEC = 25;
const ALLOWED_AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i;
// Optional: shortcode name -> unicode for emojis not in node-emoji (e.g. Fluxer/Discord shortcodes)
const EMOJI_SHORTCODES_PATH = join(__dirname, 'emoji-shortcodes.json');

let loadedShortcodes = null;
function getShortcodeToUnicodeMap() {
  if (loadedShortcodes !== null) return loadedShortcodes;
  loadedShortcodes = {};
  if (existsSync(EMOJI_SHORTCODES_PATH)) {
    try {
      const data = JSON.parse(readFileSync(EMOJI_SHORTCODES_PATH, 'utf8'));
      if (data && typeof data === 'object') {
        Object.assign(loadedShortcodes, data);
      }
    } catch (e) {
      logWarn('Could not load emoji-shortcodes.json:', e?.message);
    }
  }
  return loadedShortcodes;
}

// ============================================================
// SOUNDS CONFIG - Loaded from file or defaults
// ============================================================
let SOUNDS = {};

// Load sounds from config file or use defaults
function loadSoundsConfig() {
  if (existsSync(SOUNDS_CONFIG_PATH)) {
    try {
      const data = readFileSync(SOUNDS_CONFIG_PATH, 'utf8');
      const raw = JSON.parse(data);

      let migrated = false;
      const normalized = {};

      for (const [key, sound] of Object.entries(raw ?? {})) {
        const k = String(key ?? '').trim();
        if (!k) continue;

        let nk = k;

        // If config ever stored a percent-encoded emoji, normalize back to raw
        try {
          if (/%[0-9A-Fa-f]{2}/.test(nk)) nk = decodeURIComponent(nk);
        } catch {
          // ignore
        }

        // Convert :shortcode: -> unicode when known (prevents reaction API errors)
        const shortcodeMatch = nk.match(/^:(\w+):$/);
        if (shortcodeMatch) {
          const codeName = shortcodeMatch[1];
          if (nodeEmoji.has(nk)) {
            nk = nodeEmoji.get(nk);
          } else {
            const extra = getShortcodeToUnicodeMap();
            if (extra[codeName]) nk = extra[codeName];
          }
        }

        // Normalize custom emoji markup to name:id for matching
        const mMarkup = nk.match(/^<a?:(\w+):(\d+)>$/);
        if (mMarkup) nk = `${mMarkup[1]}:${mMarkup[2]}`;

        // Keys that are just bare words (e.g. "zipper_mouth") are not valid
        // reaction identifiers; skip them so they don't break reactions.
        if (/^\w+$/.test(nk)) {
          logWarn(`Skipping invalid emoji key in config: ${nk}`);
          migrated = true;
          continue;
        }

        if (nk !== k) migrated = true;

        // If duplicates happen, keep the first one to avoid accidental overwrites
        if (!normalized[nk]) {
          normalized[nk] = { ...sound };
          if (sound.animated === true) normalized[nk].animated = true;
        }
      }

      SOUNDS = normalized;
      log(`Loaded ${Object.keys(SOUNDS).length} sounds from config`);

      if (migrated) {
        log('Sounds config migrated (normalized emoji keys)');
        saveSoundsConfig();
      }
    } catch (error) {
      logError('Error loading sounds config:', error.message);
      SOUNDS = getDefaultSounds();
    }
  } else {
    SOUNDS = getDefaultSounds();
    saveSoundsConfig();
  }

  // Resolve full paths
  for (const [emoji, sound] of Object.entries(SOUNDS)) {
    sound.path = join(__dirname, 'sounds', sound.file);
  }

  // Ensure sounds directory exists (fresh install has no sounds/ yet)
  const soundsDir = join(__dirname, 'sounds');
  if (!existsSync(soundsDir)) {
    mkdirSync(soundsDir, { recursive: true });
  }
}

function getDefaultSounds() {
  return {};
}

function saveSoundsConfig() {
  try {
    // Save without the 'path' property (we regenerate that on load)
    const configToSave = {};
    for (const [emoji, sound] of Object.entries(SOUNDS)) {
      configToSave[emoji] = { name: sound.name, file: sound.file };
      if (sound.animated) configToSave[emoji].animated = true;
    }
    writeFileSync(SOUNDS_CONFIG_PATH, JSON.stringify(configToSave, null, 2));
    log('Sounds config saved');
  } catch (error) {
    logError('Error saving sounds config:', error.message);
  }
}

// Initialize
loadSoundsConfig();

const isPlaying = new Map();
const soundDurations = new Map();

// ============================================================
// HELPERS
// ============================================================

function displayEmojiForEmbed(key, animated = false) {
  const s = String(key ?? '');
  if (s.startsWith('<:') || s.startsWith('<a:')) return s;
  const m = s.match(/^(\w+):(\d+)$/);
  if (m) return animated ? `<a:${m[1]}:${m[2]}>` : `<:${m[1]}:${m[2]}>`;
  return s;
}

/** Fluxer 1.18+ resolveEmoji returns encodeURIComponent(unicode) for shortcodes. Store raw unicode or name:id for keys. */
function normalizeEmojiKeyForStorage(resolved) {
  if (/^\w+:\d+$/.test(resolved)) return resolved;
  try {
    if (/%[0-9A-Fa-f]{2}/.test(resolved)) return decodeURIComponent(resolved);
  } catch {
    // ignore
  }
  return resolved;
}

function buildReactionRoute(channelId, messageId, routeSegment) {
  // Fluxer 1.18+ resolveEmoji returns already-encoded unicode; custom is "name:id". Don't double-encode.
  const base = `/channels/${channelId}/messages/${messageId}/reactions`;
  const segment = /%[0-9A-Fa-f]{2}/.test(routeSegment) ? routeSegment : encodeURIComponent(routeSegment);
  return `${base}/${segment}/@me`;
}

/** Returns true if emojiKey is a custom emoji (name:id) that exists in the given guild. */
async function isCustomEmojiFromGuild(guildId, emojiKey) {
  const m = String(emojiKey).match(/^\w+:(\d+)$/);
  if (!m || !guildId) return false;
  const id = m[1];
  try {
    const emojis = await client.rest.get(Routes.guildEmojis(guildId));
    const list = Array.isArray(emojis) ? emojis : Object.values(emojis ?? {});
    return list.some((e) => e?.id === id);
  } catch {
    return false;
  }
}

async function reactAsBot(message, emoji, guildId, options = {}) {
  const emojiRaw = await client.resolveEmoji(emoji, guildId ?? message?.guildId ?? undefined);
  // API wants name:id for custom (not <:name:id>). Use as-is for custom; unicode already correct.
  const routeSegment = emojiRaw;
  const route = buildReactionRoute(message.channelId, message.id, routeSegment);
  log('[reaction] PUT', route);
  log('[reaction]   segment (raw):', JSON.stringify(routeSegment));
  try {
    await client.rest.put(route);
  } catch (err) {
    if (err?.message?.includes('Invalid form body') && /^\w+:\d+$/.test(emojiRaw) && !options.animated) {
      const retrySegment = `a:${emojiRaw}`;
      const retryRoute = buildReactionRoute(message.channelId, message.id, retrySegment);
      log('[reaction] retry PUT', retryRoute);
      await client.rest.put(retryRoute);
    } else {
      throw err;
    }
  }
}

async function getAudioDuration(filePath) {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout.trim());
  } catch (error) {
    logError('Error getting duration:', error.message);
    return 3;
  }
}

// Download file from URL
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = createWriteStream(destPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      unlinkSync(destPath);
      reject(err);
    });
  });
}

// Convert audio file to webm using ffmpeg
async function convertToWebm(inputPath, outputPath) {
  try {
    // -y forces overwrite so ffmpeg doesn't block waiting for interactive confirmation
    await execAsync(`ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 128k "${outputPath}"`);
    return true;
  } catch (error) {
    logError('Conversion error:', error.message);
    return false;
  }
}

// Sanitize filename
function sanitizeFilename(name) {
  return name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
}

function buildEmbedDescription() {
  const soundList = Object.entries(SOUNDS)
    .map(([emoji, sound]) => `${displayEmojiForEmbed(emoji, sound.animated)} ${sound.name}`)
    .join('\n');

  return `**React to play sounds**\n\n${soundList}\n\n` +
    '`!leave` - Make bot leave voice channel\n' +
    '`!soundboard reload` - Reload soundboard\n' +
    '`!soundboard add "<name>" <emoji>` - Add sound (attach audio)\n' +
    '`!soundboard remove <emoji>` - Remove sound';
}

function buildEmbed() {
  return new EmbedBuilder()
    .setTitle('🎵 Soundboard')
    .setDescription(buildEmbedDescription())
    .setColor(0x00FF41)
    .setFooter({ text: 'Join a voice channel and react!' });
}

async function postSoundboard(channelId, guildId) {
  const channel = client.channels.get(channelId);
  const resolvedGuildId = guildId ?? channel?.guildId;

  const message = await client.channels.send(channelId, {
    embeds: [buildEmbed().toJSON()]
  });

  for (const [emoji, sound] of Object.entries(SOUNDS)) {
    try {
      await reactAsBot(message, emoji, resolvedGuildId, { animated: sound.animated });
    } catch (err) {
      logError(`Failed to react with ${emoji} in channel ${channelId}:`, err.message);
    }
  }

  return message;
}

async function deleteBotMessages(channelId) {
  try {
    const messages = await client.rest.get(`/channels/${channelId}/messages`, {
      query: { limit: 100 }
    });

    const botMessages = messages.filter(msg => msg.author.id === client.user.id);

    for (const msg of botMessages) {
      try {
        await client.rest.delete(`/channels/${channelId}/messages/${msg.id}`);
      } catch (e) {
        // Ignore
      }
    }

    return botMessages.length;
  } catch (error) {
    return 0;
  }
}

function findSoundboardChannel(guildId, guildChannels) {
  const list = Array.isArray(guildChannels) ? guildChannels : Array.from(guildChannels?.values?.() ?? []);
  const textChannels = list.filter(c => (c.guildId === guildId || c.guild_id === guildId) && (c.type === 0 || c.type === 'GUILD_TEXT' || c.type == null));

  return (
    textChannels.find(c => c.name?.toLowerCase() === 'soundboard') ||
    textChannels.find(c => c.name?.toLowerCase() === 'sounds') ||
    textChannels.find(c => c.name?.toLowerCase() === 'bot') ||
    textChannels.find(c => c.name?.toLowerCase() === 'bot-commands') ||
    textChannels[0] ||
    null
  );
}

/** Pick a text channel from raw API channel list (array of { id, name, type }). */
function pickTextChannelFromApiList(channels, _guildId) {
  const list = Array.isArray(channels) ? channels : Object.values(channels ?? {});
  const text = list.filter(c => c.type === 0 || c.type === 'GUILD_TEXT');
  return (
    text.find(c => (c.name || '').toLowerCase() === 'soundboard') ||
    text.find(c => (c.name || '').toLowerCase() === 'sounds') ||
    text.find(c => (c.name || '').toLowerCase() === 'bot') ||
    text.find(c => (c.name || '').toLowerCase() === 'bot-commands') ||
    text[0] ||
    null
  );
}

/** When gateway has 0 guilds in cache, fetch guilds from API and post soundboard in each. */
async function setupSoundboardsFromApi() {
  try {
    const data = await client.rest.get(Routes.currentUserGuilds());
    const guilds = Array.isArray(data) ? data : (data?.guilds ?? Object.values(data ?? {}));
    if (!guilds.length) {
      log('No guilds returned from /users/@me/guilds');
      return;
    }
    log(`Fetched ${guilds.length} guild(s) from API`);
    for (const g of guilds) {
      const guildId = g.id ?? g.guild_id;
      const guildName = g.name ?? guildId;
      if (!guildId) continue;
      try {
        const channelsData = await client.rest.get(Routes.guildChannels(guildId));
        const ch = pickTextChannelFromApiList(channelsData, guildId);
        if (!ch) {
          logWarn(`No text channel found for guild ${guildName} (${guildId})`);
          continue;
        }
        const channelId = ch.id;
        log(`Using channel #${ch.name || channelId} (${channelId}) for ${guildName}`);
        await deleteBotMessages(channelId);
        await postSoundboard(channelId, guildId);
        log('Soundboard posted successfully!');
      } catch (e) {
        logError(`Failed to setup soundboard for ${guildName}:`, e?.message ?? e);
      }
    }
  } catch (e) {
    logError('Failed to fetch guilds from API:', e?.message ?? e);
  }
}

async function setupSoundboard(guildId, guildName) {
  log(`\nSetting up soundboard for: ${guildName} (${guildId})`);

  const guild = client.guilds.get(guildId);
  let channels = guild?.channels ?? client.channels;
  let channelCount = Array.isArray(channels) ? channels.length : (channels?.size ?? 0);

  if (!channelCount || channelCount === 0) {
    log(`No channels in cache, fetching from API...`);
    try {
      if (guild && typeof guild.fetchChannels === 'function') {
        await guild.fetchChannels();
        channels = guild.channels;
        channelCount = channels?.size ?? 0;
      }
    } catch (e) {
      logError(`Failed to fetch channels: ${e?.message}`);
    }
  }

  const soundboardChannel = findSoundboardChannel(guildId, channels);

  if (!soundboardChannel) {
    log(`No suitable text channel found in ${guildName} (${channelCount} channel(s) checked)`);
    return;
  }

  const channelId = soundboardChannel.id;
  log(`Using channel: #${soundboardChannel.name} (${channelId})`);

  const deleted = await deleteBotMessages(channelId);
  if (deleted > 0) {
    log(`Deleted ${deleted} old bot message(s)`);
  }

  try {
    await postSoundboard(channelId, guildId);
    log(`Soundboard posted successfully!`);
  } catch (error) {
    logError(`Failed to post soundboard: ${error?.message}`);
  }
}

/** Actual users (excluding bot) in channel from gateway voice state. Source of truth for leave decision. */
function getActualUserCountInChannel(guildId, channelId) {
  const guildVoiceStates = voiceManager.voiceStates?.get(guildId);
  if (!guildVoiceStates) return 0;
  let count = 0;
  for (const [userId, chId] of guildVoiceStates) {
    if (userId === client.user.id) continue;
    if (chId === channelId) count++;
  }
  return count;
}

async function checkAndLeaveIfEmpty(guildId, botChannelId) {
  const actualCount = getActualUserCountInChannel(guildId, botChannelId);

  log(`checkAndLeaveIfEmpty: ${actualCount} user(s) in channel`);

  if (actualCount === 0) {
    log('No users left, leaving voice channel...');
    voiceManager.leave(guildId);
    isPlaying.delete(guildId);
  } else {
    log(`Staying: ${actualCount} user(s) still in channel`);
  }
}

// Reload all soundboards in all guilds (uses API when gateway cache has 0 guilds)
async function reloadAllSoundboards() {
  const guildCount = client.guilds?.size ?? 0;
  if (guildCount > 0) {
    for (const [guildId, guild] of client.guilds) {
      const soundboardChannel = findSoundboardChannel(guildId, guild?.channels ?? client.channels);
      if (!soundboardChannel) continue;

      await deleteBotMessages(soundboardChannel.id);

      try {
        await postSoundboard(soundboardChannel.id, guildId);
        log(`Reloaded soundboard in ${guild.name}`);
      } catch (error) {
        logError(`Failed to reload soundboard in ${guild.name}:`, error.message);
      }
    }
    return;
  }
  // Gateway had 0 guilds: use API to find guilds/channels and reload
  try {
    const data = await client.rest.get(Routes.currentUserGuilds());
    const guilds = Array.isArray(data) ? data : (data?.guilds ?? Object.values(data ?? {}));
    for (const g of guilds) {
      const guildId = g.id ?? g.guild_id;
      const guildName = g.name ?? guildId;
      if (!guildId) continue;
      try {
        const channelsData = await client.rest.get(Routes.guildChannels(guildId));
        const ch = pickTextChannelFromApiList(channelsData, guildId);
        if (!ch) continue;
        await deleteBotMessages(ch.id);
        await postSoundboard(ch.id, guildId);
        log(`Reloaded soundboard in ${guildName}`);
      } catch (e) {
        logError(`Failed to reload soundboard for ${guildName}:`, e?.message ?? e);
      }
    }
  } catch (e) {
    logError('Failed to fetch guilds for reload:', e?.message ?? e);
  }
}

// ============================================================
// EVENT HANDLERS (wrapped so errors don't crash the process)
// ============================================================

function safeHandler(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      logError('[handler error]', err?.message ?? err);
      if (err?.stack) logError(err.stack);
    }
  };
}

client.on(Events.MessageCreate, safeHandler(async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  const content = message.content.trim();

  // !leave command
  if (content === '!leave') {
    const guildId = message.guildId;
    const botVoiceChannelId = voiceManager.getVoiceChannelId(guildId, client.user.id);

    if (botVoiceChannelId) {
      voiceManager.leave(guildId);
      isPlaying.delete(guildId);
      await message.reply('Left voice channel');
    } else {
      await message.reply('Not in a voice channel');
    }
    return;
  }

  // !soundboard reload command
  if (content === '!soundboard reload' || content === '!soundboard_reload') {
    const guildId = message.guildId;
    const guild = client.guilds.get(guildId);

    if (!guild) {
      await message.reply('Could not find guild');
      return;
    }

    await message.reply('🔄 Reloading soundboard...');
    log(`\nReloading soundboard for: ${guild.name} (${guildId})`);

    const allGuildChannels = Array.from(client.channels.values())
      .filter(c => c.guildId === guildId && c.type === 0);

    for (const channel of allGuildChannels) {
      await deleteBotMessages(channel.id);
    }

    const soundboardChannel = findSoundboardChannel(guildId, guild?.channels ?? client.channels) || client.channels.get(message.channelId);

    if (!soundboardChannel) {
      await message.reply('❌ No suitable text channel found');
      return;
    }

    const channelId = soundboardChannel.id;
    log(`Using channel: #${soundboardChannel.name} (${channelId})`);

    try {
      await postSoundboard(channelId, guildId);
      log(`Soundboard reloaded successfully!`);
      await message.reply(`Soundboard reloaded in <#${channelId}>`);
    } catch (error) {
      log(`Failed to reload soundboard: ${error.message}`);
      await message.reply('❌ Failed to reload soundboard');
    }
    return;
  }

  // !soundboard remove <emoji>
  if (content.startsWith('!soundboard remove ')) {
    const emojiInput = content.slice('!soundboard remove '.length).trim();
    if (!emojiInput) {
      await message.reply('❌ Usage: `!soundboard remove <emoji>` (e.g. `!soundboard remove 🎵` or `!soundboard remove :test:`)');
      return;
    }
    let emojiKey;
    try {
      const resolved = await client.resolveEmoji(emojiInput, message.guildId);
      emojiKey = normalizeEmojiKeyForStorage(resolved);
    } catch (e) {
      await message.reply(`❌ Invalid emoji: ${e.message}`);
      return;
    }
    const sound = SOUNDS[emojiKey];
    if (!sound) {
      await message.reply(`❌ That emoji isn't on the soundboard. Use an emoji that's currently listed.`);
      return;
    }
    if (sound.path && existsSync(sound.path)) {
      try {
        unlinkSync(sound.path);
      } catch (err) {
        logWarn('Could not delete sound file:', sound.path, err?.message);
      }
    }
    delete SOUNDS[emojiKey];
    soundDurations.delete(emojiKey);
    saveSoundsConfig();
    await reloadAllSoundboards();
    await message.reply(`✅ Removed "${sound.name}" (${displayEmojiForEmbed(emojiKey, sound.animated)}).`);
    return;
  }

  // !soundboard add "<name>" <emoji> command (with audio attachment)
  if (content.startsWith('!soundboard add ')) {
    const args = content.slice('!soundboard add '.length).trim();
    const parts = args.match(/^"([^"]+)"\s+(.+)$/);

    if (!parts) {
      await message.reply('❌ Usage: `!soundboard add "Sound Name" 😀` (attach audio file)');
      return;
    }

    const soundName = parts[1];
    const emojiInput = parts[2].trim();
    let emojiKey;

    try {
      const resolved = await client.resolveEmoji(emojiInput, message.guildId);
      emojiKey = normalizeEmojiKeyForStorage(resolved);
    } catch (e) {
      await message.reply(`❌ Invalid emoji: ${e.message}`);
      return;
    }

    if (/^\w+:\d+$/.test(emojiKey) && message.guildId) {
      const fromThisServer = await isCustomEmojiFromGuild(message.guildId, emojiKey);
      if (!fromThisServer) {
        await message.reply(
          '❌ That custom emoji is from another server. You can only use custom emojis from **this server** or unicode emojis (e.g. 🎵).'
        );
        return;
      }
    }

    // Fluxer.js uses Collection (Map-like) for message.attachments, not an array
    let attachment = null;
    if (message.attachments) {
      if (typeof message.attachments.values === 'function' && message.attachments.size > 0) {
        const first = message.attachments.first?.() ?? message.attachments.values().next().value;
        attachment = first ?? Array.from(message.attachments.values())[0];
      } else if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        attachment = message.attachments[0];
      } else if (typeof message.attachments === 'object') {
        const values = Object.values(message.attachments);
        if (values.length > 0) attachment = values[0];
      }
    }

    const attachmentUrl = attachment?.url ?? attachment?.proxy_url;
    if (!attachment || !attachmentUrl) {
      await message.reply('❌ Please attach an audio file (MP3, WAV, OGG, etc.)');
      return;
    }

    const attachmentSize = attachment.size ?? attachment.content_length;
    if (attachmentSize != null && attachmentSize > MAX_SOUND_FILE_BYTES) {
      await message.reply(`❌ File is too large (max ${MAX_SOUND_FILE_BYTES / 1024 / 1024} MB).`);
      return;
    }

    const attachmentName = attachment.filename ?? attachment.file_name ?? '';
    if (!ALLOWED_AUDIO_EXT.test(attachmentName)) {
      await message.reply('❌ Unsupported format. Use MP3, WAV, OGG, M4A, AAC, FLAC, or WebM.');
      return;
    }

    if (SOUNDS[emojiKey]) {
      await message.reply(`❌ Emoji ${displayEmojiForEmbed(emojiKey, SOUNDS[emojiKey].animated)} is already in use for "${SOUNDS[emojiKey].name}"`);
      return;
    }

    await message.reply(`⏳ Processing "${soundName}" with ${displayEmojiForEmbed(emojiKey)}...`);

    try {
      const soundsDir = join(__dirname, 'sounds');
      if (!existsSync(soundsDir)) mkdirSync(soundsDir, { recursive: true });

      const tempFile = join(__dirname, 'sounds', `temp_${Date.now()}.tmp`);
      const filename = sanitizeFilename(soundName);
      const webmFile = join(__dirname, 'sounds', `${filename}.webm`);

      log(`Downloading ${attachmentUrl}...`);
      await downloadFile(attachmentUrl, tempFile);

      if (existsSync(tempFile)) {
        const tempSize = statSync(tempFile).size;
        if (tempSize > MAX_SOUND_FILE_BYTES) {
          unlinkSync(tempFile);
          await message.reply(`❌ File is too large (max ${MAX_SOUND_FILE_BYTES / 1024 / 1024} MB).`);
          return;
        }
      }

      log(`Converting to webm...`);
      const success = await convertToWebm(tempFile, webmFile);
      unlinkSync(tempFile);

      if (!success) {
        await message.reply('❌ Failed to convert audio file. Make sure it\'s a valid audio format.');
        return;
      }

      const duration = await getAudioDuration(webmFile);
      if (duration > MAX_SOUND_DURATION_SEC) {
        unlinkSync(webmFile);
        await message.reply(`❌ Audio is too long (max ${MAX_SOUND_DURATION_SEC} seconds). Got ${duration.toFixed(1)}s.`);
        return;
      }

      SOUNDS[emojiKey] = {
        name: soundName,
        file: `${filename}.webm`,
        path: webmFile
      };
      if (/^<a:\w+:\d+>$/i.test(String(emojiInput).trim())) {
        SOUNDS[emojiKey].animated = true;
      }

      soundDurations.set(emojiKey, duration);
      saveSoundsConfig();
      await reloadAllSoundboards();

      await message.reply(`✅ Added "${soundName}" (${displayEmojiForEmbed(emojiKey, SOUNDS[emojiKey].animated)}) - Duration: ${duration.toFixed(2)}s`);
      log(`Added sound: ${soundName} (${emojiInput})`);
    } catch (error) {
      logError('Error adding sound:', error);
      await message.reply(`❌ Error: ${error.message}`);
    }
    return;
  }
}));


client.on(Events.Ready, safeHandler(async () => {
  log('✅ Soundboard ready!');

  // When gateway closes we may not get Events.Disconnect; wire 'close' so we reconnect
  attachCloseHandler();
  if (!keepaliveInterval) {
    keepaliveInterval = setInterval(keepaliveCheck, KEEPALIVE_INTERVAL_MS);
  }

  log('Loading sound durations...');
  for (const [emoji, sound] of Object.entries(SOUNDS)) {
    const duration = await getAudioDuration(sound.path);
    soundDurations.set(emoji, duration);
    log(`  ${sound.name}: ${duration.toFixed(2)}s`);
  }

  const guildCount = client.guilds?.size ?? 0;
  log(`Guilds in cache: ${guildCount}`);

  if (guildCount > 0) {
    for (const [guildId, guild] of client.guilds) {
      await setupSoundboard(guildId, guild.name);
    }
  } else {
    log('Gateway had 0 guilds; fetching guilds from API and posting soundboards...');
    await setupSoundboardsFromApi();
  }

  log('All soundboards posted!');

  // Backup check every 30 seconds (only start once, Ready can fire multiple times on reconnect)
  if (!voiceCheckInterval) {
    voiceCheckInterval = setInterval(async () => {
      try {
        for (const [guildId] of client.guilds) {
          const botChannelId = voiceManager.getVoiceChannelId(guildId, client.user.id);
          if (!botChannelId) continue;

          const actualCount = getActualUserCountInChannel(guildId, botChannelId);
          log(`[30s check] Guild ${guildId}: ${actualCount} user(s) in bot's channel`);

          if (actualCount === 0) {
            log('Channel is empty, leaving...');
            voiceManager.leave(guildId);
            isPlaying.delete(guildId);
          }
        }
      } catch (err) {
        logError('[30s check error]', err?.message);
      }
    }, 30000);
  }
}));

client.on(Events.VoiceStateUpdate, safeHandler(async (voiceState) => {
  const { guild_id, user_id, channel_id } = voiceState;

  if (user_id === client.user.id) return;
  if (channel_id !== null) return;

  const botVoiceChannelId = voiceManager.getVoiceChannelId(guild_id, client.user.id);
  if (!botVoiceChannelId) return;

  await new Promise(resolve => setTimeout(resolve, 500));
  await checkAndLeaveIfEmpty(guild_id, botVoiceChannelId);
}));

// v1.2.1: MessageReactionAdd emits (reaction, user) only; messageId/channelId/emoji/userId on reaction/user
client.on(Events.MessageReactionAdd, safeHandler(async (reaction, user) => {
  const reactingUserId = user?.id ?? null;

  if (!reactingUserId) return;
  if (reactingUserId === client.user.id) return;

  const channelId = reaction.channelId;
  const messageId = reaction.messageId;
  const emoji = reaction.emoji;

  // Fluxer: emojiIdentifier is unicode (e.g. 🥸) or "name:id" for custom (GatewayReactionEmoji.id is optional)
  const emojiIdentifier =
    reaction?.emojiIdentifier ||
    (emoji?.id ? `${emoji.name}:${emoji.id}` : emoji?.name);

  // Try multiple key formats to match the stored emoji
  const emojiName = emoji?.name ?? reaction?.emoji?.name;
  const emojiId = emoji?.id ?? reaction?.emoji?.id;
  const primaryKey = emojiId ? `${emojiName}:${emojiId}` : emojiName;

  const sound =
    (emojiIdentifier && SOUNDS[emojiIdentifier]) ||
    (primaryKey && SOUNDS[primaryKey]) ||
    (emojiName && SOUNDS[`:${emojiName}:`]) ||
    (emojiId && SOUNDS[emojiId]) ||
    (emojiName && SOUNDS[emojiName]) ||
    (emojiId && SOUNDS[`<:${emojiName}:${emojiId}>`]) ||
    (emojiId && SOUNDS[`<a:${emojiName}:${emojiId}>`]);
  if (!sound) return;

  const channel = client.channels.get(channelId);
  if (!channel) return;

  const guildId = channel.guildId;

  const removeReaction = async () => {
    try {
      if (reactingUserId === client.user.id) return;
      const emojiRaw = emojiIdentifier || primaryKey;
      if (!emojiRaw) return;
      const route = `${Routes.channelMessageReaction(channelId, messageId, emojiRaw)}/${reactingUserId}`;
      await client.rest.delete(route);
    } catch (error) {
      // Ignore
    }
  };

  if (isPlaying.get(guildId)) {
    log('Blocked - already playing');
    await removeReaction();
    return;
  }

  const voiceChannelId = voiceManager.getVoiceChannelId(guildId, reactingUserId);

  if (!voiceChannelId) {
    log('User not in voice');
    await removeReaction();
    return;
  }

  isPlaying.set(guildId, true);

  try {
    const voiceChannel = client.channels.get(voiceChannelId);
    if (!voiceChannel) {
      isPlaying.delete(guildId);
      await removeReaction();
      return;
    }

    log(`Playing ${sound.name}`);

    const connection = await voiceManager.join(voiceChannel);

    await new Promise(resolve => setTimeout(resolve, 200));

    const stream = createReadStream(sound.path);

    connection.play(stream).catch(err => {
      logError('Play error:', err.message);
    });

    // Try multiple key formats to find duration
    const durationKey = emojiIdentifier || primaryKey || emojiName || (emojiName ? `:${emojiName}:` : null);
    const duration = 
      (durationKey && soundDurations.get(durationKey)) ||
      (emojiName && soundDurations.get(emojiName)) ||
      (emojiName && soundDurations.get(`:${emojiName}:`)) ||
      3;
    const waitTime = (duration * 1000) + 250;

    log(`Waiting ${waitTime}ms for ${sound.name} to finish...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));

    log(`${sound.name} finished`);

  } catch (error) {
    logError('Error:', error.message);
  } finally {
    isPlaying.delete(guildId);
    await removeReaction();
  }
}));

client.on('error', (error) => {
  logError('Client error:', error?.message ?? error);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('Unhandled rejection:', reason?.message ?? reason);
  if (reason?.stack) logError(reason.stack);
});

process.on('uncaughtException', (error) => {
  logError('Uncaught exception:', error?.message ?? error);
  if (error?.stack) logError(error.stack);
});

async function destroyClient() {
  try {
    if (typeof client.destroy === 'function') await client.destroy();
  } catch (_) {
    // ignore
  }
}

async function loginWithRetry() {
  for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await destroyClient();
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)];
      log(`Retrying in ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try {
      await client.login(process.env.FLUXER_BOT_TOKEN);
      log('Connected successfully!');
      return;
    } catch (e) {
      logError(`Login attempt ${attempt + 1} failed:`, e?.message ?? e);
    }
  }
  log('Will keep retrying every 60s...');
  while (true) {
    await destroyClient();
    await new Promise(resolve => setTimeout(resolve, 60_000));
    try {
      await client.login(process.env.FLUXER_BOT_TOKEN);
      log('Connected successfully!');
      return;
    } catch (e) {
      logError('Login failed:', e?.message ?? e);
    }
  }
}

/** Shared reconnect loop (backoff then 60s forever). Prevents parallel runs via reconnecting flag. */
async function runReconnectLoop() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    log('Reconnecting with backoff...');
    for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
      await destroyClient();
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await client.login(process.env.FLUXER_BOT_TOKEN);
        log('Reconnected successfully!');
        return;
      } catch (e) {
        logError(`Reconnect attempt ${attempt + 1} failed:`, e?.message ?? e);
      }
    }
    log('Will keep retrying every 60s...');
    while (true) {
      await destroyClient();
      await new Promise(resolve => setTimeout(resolve, 60_000));
      try {
        await client.login(process.env.FLUXER_BOT_TOKEN);
        log('Reconnected successfully!');
        return;
      } catch (e) {
        logError('Reconnect failed:', e?.message ?? e);
      }
    }
  } finally {
    reconnecting = false;
  }
}

client.on(Events.Disconnect, () => { runReconnectLoop(); });

/** When gateway closes, the library may not emit Disconnect; wire 'close' so we reconnect. */
function attachCloseHandler() {
  try {
    client.ws.on('close', () => {
      log('Gateway connection closed.');
      runReconnectLoop();
    });
  } catch (_) {
    // client.ws not available yet
  }
}

/** Periodic REST check; if we can't reach Discord, force destroy + reconnect. */
async function keepaliveCheck() {
  if (reconnecting) return;
  if (!client.isReady?.()) return;
  try {
    await client.rest.get(Routes.currentUser());
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(msg)) {
      logWarn('Keepalive failed, reconnecting...', msg);
      runReconnectLoop();
    }
  }
}

await loginWithRetry();
