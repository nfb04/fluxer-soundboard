import 'dotenv/config';
import { Client, Events, EmbedBuilder, Routes, PermissionFlags } from '@fluxerjs/core';
import { getVoiceManager } from '@fluxerjs/voice';
import {
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { opus as prismOpus } from 'prism-media';
import { OpusDecoder } from 'opus-decoder';
import * as nodeEmoji from 'node-emoji';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createReadStream, createWriteStream, writeFileSync, readFileSync, unlinkSync, existsSync, statSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { Readable } from 'stream';

// Chunk size for preloaded buffer. Pipeline: our stream → prism-media WebmDemuxer → parseOpusPacketBoundaries → OpusDecoder → 10ms AudioFrame (480 samples) → LiveKit captureFrame. Too small (e.g. 2KB) can make the demuxer wait for reads and cause small stalls; ~12KB keeps it fed without one huge burst.
const VOICE_STREAM_CHUNK_BYTES = 12 * 1024;

/** Create a readable stream from a buffer that pushes data in steady chunks (reduces stutter with LiveKit/WebRTC 20ms-style pipelines). */
function bufferToChunkedStream(buffer, chunkSize = VOICE_STREAM_CHUNK_BYTES) {
  return new Readable({
    read() {
      if (this.offset === undefined) this.offset = 0;
      while (this.offset < buffer.length) {
        const end = Math.min(this.offset + chunkSize, buffer.length);
        const chunk = buffer.subarray(this.offset, end);
        this.offset = end;
        if (!this.push(chunk)) return;
      }
      this.push(null);
    }
  });
}

// --- LiveKit play-from-PCM (decode entire buffer first, like Fluxer in-app soundboard) ---
//
// Browser example (zero stutter): Blob → decodeAudioData → AudioBuffer → BufferSource → createMediaStreamDestination()
// → getAudioTracks()[0] → publishTrack(track). Then source.start(). The track is fed by the BROWSER'S NATIVE
// audio thread at exact sample rate—no JS in the hot path. Node has no AudioContext/MediaStream; @livekit/rtc-node
// only offers AudioSource + captureFrame(audioFrame), so we must call captureFrame in a JS loop. Every await
// yields to the event loop (GC, timers, 30s check), which can delay the next frame and cause stutter.
const LK_SAMPLE_RATE = 48_000;
const LK_CHANNELS = 1;
// 50ms frames = fewer JS↔native round-trips
const LK_FRAME_SAMPLES = 2400; // 50 ms at 48 kHz

function parseOpusPacketBoundaries(buffer) {
  if (buffer.length < 2) return null;
  const toc = buffer[0];
  const c = toc & 3;
  const tocSingle = (toc & 252) | 0;
  if (c === 0) {
    return { frames: [buffer.subarray(0)], consumed: buffer.length };
  }
  if (c === 1) {
    if (buffer.length < 2) return null;
    const L1 = buffer[1] + 1;
    if (buffer.length < 2 + L1) return null;
    const L2 = buffer.length - 2 - L1;
    const frame0 = new Uint8Array(1 + L1);
    frame0[0] = tocSingle;
    frame0.set(buffer.subarray(2, 2 + L1), 1);
    const frame1 = new Uint8Array(1 + L2);
    frame1[0] = tocSingle;
    frame1.set(buffer.subarray(2 + L1), 1);
    return { frames: [frame0, frame1], consumed: buffer.length };
  }
  if (c === 2) {
    if (buffer.length < 3) return null;
    const frameLen = Math.floor((buffer.length - 2) / 2);
    if (frameLen < 1) return null;
    const frame0 = new Uint8Array(1 + frameLen);
    frame0[0] = tocSingle;
    frame0.set(buffer.subarray(2, 2 + frameLen), 1);
    const frame1 = new Uint8Array(1 + frameLen);
    frame1[0] = tocSingle;
    frame1.set(buffer.subarray(2 + frameLen, 2 + 2 * frameLen), 1);
    return { frames: [frame0, frame1], consumed: 2 + 2 * frameLen };
  }
  if (c === 3) {
    if (buffer.length < 2) return null;
    const N = buffer[1];
    if (N < 1 || N > 255) return null;
    const numLengthBytes = N - 1;
    if (buffer.length < 2 + numLengthBytes) return null;
    const lengths = [];
    for (let i = 0; i < numLengthBytes; i++) lengths.push(buffer[2 + i] + 1);
    const headerLen = 2 + numLengthBytes;
    const sumKnown = lengths.reduce((a, b) => a + b, 0);
    const lastLen = buffer.length - headerLen - sumKnown;
    if (lastLen < 0) return null;
    lengths.push(lastLen);
    const frames = [];
    let offset = headerLen;
    for (let i = 0; i < lengths.length; i++) {
      const L = lengths[i];
      if (offset + L > buffer.length) return null;
      const frame = new Uint8Array(1 + L);
      frame[0] = tocSingle;
      frame.set(buffer.subarray(offset, offset + L), 1);
      frames.push(frame);
      offset += L;
    }
    return { frames, consumed: offset };
  }
  return null;
}

function concatUint8Arrays(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function floatToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = float32[i];
    if (!Number.isFinite(s)) { int16[i] = 0; continue; }
    s = Math.max(-1, Math.min(1, s));
    const scale = s < 0 ? 32768 : 32767;
    int16[i] = Math.max(-32768, Math.min(32767, Math.round(s * scale)));
  }
  return int16;
}

/** Decode a WebM/Opus buffer to 48kHz mono Int16 PCM (same approach as Fluxer in-app: decode whole file then play). */
async function decodeWebmOpusToPcm(buffer, logPrefix = '[PCM decode]') {
  const decoder = new OpusDecoder({ sampleRate: LK_SAMPLE_RATE, channels: LK_CHANNELS });
  await decoder.ready;
  const demuxer = new prismOpus.WebmDemuxer();
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  log(`${logPrefix} input size: ${buf.length} bytes`);
  const inputStream = Readable.from([buf]);
  inputStream.pipe(demuxer);
  const chunks = [];
  let opusBuffer = new Uint8Array(0);
  let opusFramesDecoded = 0;
  const drain = () => {
    while (opusBuffer.length > 0) {
      const parsed = parseOpusPacketBoundaries(opusBuffer);
      if (!parsed) break;
      opusBuffer = opusBuffer.subarray(parsed.consumed);
      for (const frame of parsed.frames) {
        try {
          const result = decoder.decodeFrame(frame);
          if (result?.channelData?.[0]?.length) {
            chunks.push(floatToInt16(result.channelData[0]));
            opusFramesDecoded++;
          }
        } catch (e) {
          logWarn(`${logPrefix} decodeFrame error:`, e?.message ?? e);
        }
      }
    }
  };
  await new Promise((resolve, reject) => {
    demuxer.on('data', (chunk) => {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(ArrayBuffer.isView(chunk) ? chunk.buffer : chunk);
      opusBuffer = concatUint8Arrays(opusBuffer, bytes);
      drain();
    });
    demuxer.on('error', reject);
    demuxer.on('end', () => {
      drain();
      resolve();
    });
  });
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  const durationSec = total / LK_SAMPLE_RATE;
  const firstSamples = total > 0 ? Array.from(pcm.subarray(0, Math.min(8, pcm.length))) : [];
  log(`${logPrefix} decoded: ${opusFramesDecoded} Opus frames → ${total} samples (${durationSec.toFixed(2)}s)${firstSamples.length ? `, first 8: [${firstSamples.join(', ')}]` : ''}`);
  return pcm;
}

/** Play sound via LiveKit by publishing a track and feeding pre-decoded PCM (smooth, like in-app soundboard). */
async function playSoundboardSoundLiveKit(connection, sound) {
  const room = connection.room;
  if (!room?.isConnected) {
    throw new Error('LiveKit: not connected');
  }
  const logPrefix = `[PCM play ${sound.name}]`;
  let pcm = sound.pcmBuffer;
  if (!pcm && sound.buffer) {
    pcm = await decodeWebmOpusToPcm(sound.buffer, logPrefix);
    sound.pcmBuffer = pcm;
  }
  if (!pcm?.length) {
    throw new Error('No PCM buffer (sound may not be WebM/Opus or decode failed)');
  }
  const source = new AudioSource(LK_SAMPLE_RATE, LK_CHANNELS);
  const track = LocalAudioTrack.createAudioTrack('soundboard', source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);
  const totalFrames = Math.ceil(pcm.length / LK_FRAME_SAMPLES);
  log(`${logPrefix} track published, feeding ${totalFrames} frames (${(LK_FRAME_SAMPLES / 48).toFixed(0)}ms each, fewer round-trips)`);
  await new Promise((r) => setTimeout(r, 50));
  let offset = 0;
  let framesSent = 0;
  const QUEUE_TARGET_MS = 800;
  const waitForPlayoutWithTimeout = (maxMs = 5000) => {
    if (typeof source.waitForPlayout !== 'function') return Promise.resolve();
    return Promise.race([
      source.waitForPlayout(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('waitForPlayout timeout')), maxMs)),
    ]).catch(() => {});
  };
  try {
    while (offset < pcm.length) {
      if ((source.queuedDuration ?? 0) > QUEUE_TARGET_MS) {
        await waitForPlayoutWithTimeout();
      }
      const slice = pcm.subarray(offset, Math.min(offset + LK_FRAME_SAMPLES, pcm.length));
      offset += slice.length;
      const samplesThisFrame = slice.length;
      const frameSamples =
        samplesThisFrame < LK_FRAME_SAMPLES
          ? (() => {
              const pad = new Int16Array(LK_FRAME_SAMPLES);
              pad.set(slice);
              return pad;
            })()
          : new Int16Array(slice);
      const samplesPerChannel = frameSamples.length;
      const audioFrame = new AudioFrame(frameSamples, LK_SAMPLE_RATE, LK_CHANNELS, samplesPerChannel);
      await source.captureFrame(audioFrame);
      framesSent++;
      if (framesSent <= 2 || framesSent % 200 === 0 || framesSent === totalFrames) {
        log(`${logPrefix} frame ${framesSent}/${totalFrames}, queuedDuration=${(source.queuedDuration ?? 0).toFixed(0)}ms`);
      }
    }
    log(`${logPrefix} done: ${framesSent} frames sent (playout continues from queue)`);
  } finally {
    await track.close().catch(() => {});
    await source.close().catch(() => {});
  }
}

import { exec } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Self-host mode: node index.js self → load FLUXER_BOT_TOKEN and API_URL from self-host.txt
const SELF_HOST_ARG = 'self';
const SELF_HOST_FILE = join(__dirname, 'self-host.txt');
const isSelfHost = process.argv[2] === SELF_HOST_ARG;

if (isSelfHost) {
  if (!existsSync(SELF_HOST_FILE)) {
    console.error(`[self-host] Missing ${SELF_HOST_FILE}. Copy from self-host.txt.example and set FLUXER_BOT_TOKEN and API_URL.`);
    process.exit(1);
  }
  const raw = readFileSync(SELF_HOST_FILE, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) process.env[key] = value;
  }
  if (process.env.API_URL) process.env.API_URL = process.env.API_URL.replace(/\/+$/, '');
  console.log('[self-host] Loaded config from self-host.txt');
}

const execAsync = promisify(exec);

// Timestamped logging
const ts = () => `[${new Date().toISOString()}]`;
const log = (...args) => console.log(ts(), ...args);
const logError = (...args) => console.error(ts(), ...args);
const logWarn = (...args) => console.warn(ts(), ...args);

// Client options: self-host mode uses custom API URL from process.env.API_URL (set from self-host.txt)
const clientOptions = { intents: 0 };
if (isSelfHost && process.env.API_URL) {
  // @fluxerjs/core may use rest.api or rest.baseURL for the REST base URL
  clientOptions.rest = { baseURL: process.env.API_URL, api: process.env.API_URL };
  log('Self-host mode: using API_URL', process.env.API_URL);
}

const client = new Client(clientOptions);
const voiceManager = getVoiceManager(client);

// Path to sounds config file (persistent storage)
const SOUNDS_CONFIG_PATH = join(__dirname, 'sounds-config.json');
// Path to soundboard role config: which roles can add/remove sounds (per guild). Restart-safe.
const ROLES_CONFIG_PATH = join(__dirname, 'soundboard-roles-config.json');
const RECONNECT_DELAYS_MS = [10_000, 20_000, 30_000, 60_000, 60_000]; // then keeps 60s
const KEEPALIVE_INTERVAL_MS = 60_000; // check REST connectivity every 60s
let reconnecting = false;
let keepaliveInterval = null;
let voiceCheckInterval = null;
const MAX_SOUND_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_SOUND_DURATION_SEC = 25;
const ALLOWED_AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i;
// Optional: shortcode name -> unicode for emojis not in node-emoji (e.g. Fluxer shortcodes)
const EMOJI_SHORTCODES_PATH = join(__dirname, 'emoji-shortcodes.json');
// guildId -> soundboard message ID (only reactions on this message trigger sounds)
const soundboardMessageIds = new Map();

/** Guard: Ready can fire multiple times on reconnect; only run initial soundboard setup once per process. */
let initialSoundboardSetupDone = false;

/** Dedupe MessageCreate by id so we only handle each message once (avoids double replies from duplicate gateway events or reconnects). */
const processedMessageIds = new Set();
const MESSAGE_DEDUPE_TTL_MS = 15_000;

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

/** Load all sound files into memory (sound.buffer) for stutter-free playback. */
async function preloadSoundBuffers() {
  let count = 0;
  let bytes = 0;
  for (const [emoji, sound] of Object.entries(SOUNDS)) {
    if (!sound.path || !existsSync(sound.path)) continue;
    try {
      sound.buffer = await readFile(sound.path);
      count++;
      bytes += sound.buffer.length;
    } catch (e) {
      logWarn(`Could not preload "${sound.name}":`, e?.message);
    }
  }
  if (count > 0) log(`Preloaded ${count} sound(s) into RAM (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
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

// ============================================================
// SOUNDBOARD ROLES CONFIG - Which roles can add/remove sounds (per guild)
// Only users with Manage Guild can change this config.
// ============================================================
/** guildId -> array of role IDs allowed to add/remove sounds */
let ROLES_CONFIG = {};

function loadRolesConfig() {
  if (existsSync(ROLES_CONFIG_PATH)) {
    try {
      const data = readFileSync(ROLES_CONFIG_PATH, 'utf8');
      const raw = JSON.parse(data);
      ROLES_CONFIG = typeof raw === 'object' && raw !== null ? raw : {};
      log(`Loaded roles config for ${Object.keys(ROLES_CONFIG).length} guild(s)`);
    } catch (error) {
      logError('Error loading roles config:', error.message);
      ROLES_CONFIG = {};
    }
  } else {
    ROLES_CONFIG = {};
  }
}

function saveRolesConfig() {
  try {
    writeFileSync(ROLES_CONFIG_PATH, JSON.stringify(ROLES_CONFIG, null, 2));
    log('Roles config saved');
  } catch (error) {
    logError('Error saving roles config:', error.message);
  }
}

function getAllowedRoleIds(guildId) {
  if (!guildId) return [];
  const list = ROLES_CONFIG[guildId];
  return Array.isArray(list) ? [...list] : [];
}

function setAllowedRoleIds(guildId, roleIds) {
  if (!guildId) return;
  ROLES_CONFIG[guildId] = Array.isArray(roleIds) ? roleIds : [];
  saveRolesConfig();
}

function addAllowedRole(guildId, roleId) {
  const list = getAllowedRoleIds(guildId);
  if (list.includes(roleId)) return false;
  list.push(roleId);
  setAllowedRoleIds(guildId, list);
  return true;
}

function removeAllowedRole(guildId, roleId) {
  const list = getAllowedRoleIds(guildId).filter((id) => id !== roleId);
  setAllowedRoleIds(guildId, list);
  return true;
}

// Initialize
loadSoundsConfig();
loadRolesConfig();

const isPlaying = new Map();
const soundDurations = new Map();

// ============================================================
// HELPERS
// ============================================================

/** Resolve the author of the message as a guild member (null in DMs or if not in guild). */
async function getMessageMember(message) {
  if (!message.guildId) return null;
  const guild = client.guilds.get(message.guildId);
  if (!guild) return null;
  const members = guild.members?.cache ?? guild.members;
  return members?.get?.(message.author.id) ?? members?.resolve?.(message.author.id) ?? null;
}

/** True if the member can change soundboard role config (Manage Guild permission). */
function canConfigureRoles(member) {
  return member && member.permissions && member.permissions.has(PermissionFlags.ManageGuild);
}

/** True if the member can add/remove sounds: has Manage Guild or has one of the allowed roles. */
function canManageSoundboard(member, guildId) {
  if (!member) return false;
  if (member.permissions && member.permissions.has(PermissionFlags.ManageGuild)) return true;
  const allowed = getAllowedRoleIds(guildId);
  if (allowed.length === 0) return false;
  const cache = member.roles?.cache;
  if (!cache) return false;
  return allowed.some((roleId) => cache.has(roleId));
}

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

/** Add bot's reaction to a message by channel/message id (for re-add after clear_emoji removal). */
async function addBotReactionToMessage(channelId, messageId, emojiRaw, guildId, options = {}) {
  const segment = options.animated && /^\w+:\d+$/.test(emojiRaw) ? `a:${emojiRaw}` : emojiRaw;
  const route = buildReactionRoute(channelId, messageId, segment);
  try {
    await client.rest.put(route);
  } catch (err) {
    if (err?.message?.includes('Invalid form body') && /^\w+:\d+$/.test(emojiRaw) && !segment.startsWith('a:')) {
      await client.rest.put(buildReactionRoute(channelId, messageId, `a:${emojiRaw}`));
    } else {
      throw err;
    }
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

// Opus bitrate for soundboard clips (lower = less bandwidth, may reduce stutter; 96k is plenty for short clips)
const OPUS_BITRATE = '96k';

// Convert audio file to webm using ffmpeg
async function convertToWebm(inputPath, outputPath) {
  try {
    await execAsync(`ffmpeg -y -i "${inputPath}" -c:a libopus -b:a ${OPUS_BITRATE} "${outputPath}"`);
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

  return `**React to play sounds**\n\n${soundList || '_No sounds yet._'}`;
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

  soundboardMessageIds.set(resolvedGuildId, message.id);

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

  // Dedupe: only handle each message once (gateway can emit duplicate MESSAGE_CREATE e.g. on reconnect)
  const msgId = message.id;
  if (msgId && processedMessageIds.has(msgId)) return;
  if (msgId) {
    processedMessageIds.add(msgId);
    setTimeout(() => processedMessageIds.delete(msgId), MESSAGE_DEDUPE_TTL_MS);
  }

  const content = message.content.trim();

  // !soundboard leave command — requires Manage Server or configured role
  if (content === '!soundboard leave') {
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply('❌ This command can only be used in a server.');
      return;
    }
    const member = await getMessageMember(message);
    if (!canManageSoundboard(member, guildId)) {
      await message.reply('❌ You don\'t have permission. You need **Manage Server** or a role configured with `!soundboard config role add`.');
      return;
    }
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

  // !soundboard reload command — requires Manage Server or configured role
  if (content === '!soundboard reload' || content === '!soundboard_reload') {
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply('❌ This command can only be used in a server.');
      return;
    }
    const member = await getMessageMember(message);
    if (!canManageSoundboard(member, guildId)) {
      await message.reply('❌ You don\'t have permission. You need **Manage Server** or a role configured with `!soundboard config role add`.');
      return;
    }
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

  // !soundboard config role add/remove/list — requires Manage Guild
  if (content.startsWith('!soundboard config role ')) {
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply('❌ This command can only be used in a server.');
      return;
    }
    const guild = client.guilds.get(guildId);
    if (!guild) {
      await message.reply('❌ Could not find this server.');
      return;
    }
    const member = await getMessageMember(message);
    if (!member) {
      await message.reply('❌ Could not resolve your member data.');
      return;
    }
    if (!canConfigureRoles(member)) {
      await message.reply('❌ You need the **Manage Server** permission to change soundboard role config.');
      return;
    }

    const rest = content.slice('!soundboard config role '.length).trim();
    const subParts = rest.split(/\s+/);
    const subCmd = subParts[0]?.toLowerCase();

    if (subCmd === 'add' && subParts.length >= 2) {
      const roleArg = subParts.slice(1).join(' ').trim();
      const roleId = /^\d+$/.test(roleArg) ? roleArg : null;
      const role = roleId ? guild.roles.get(roleId) : Array.from(guild.roles.values()).find((r) => r.name.toLowerCase() === roleArg.toLowerCase());
      if (!role) {
        await message.reply(`❌ Role not found: \`${roleArg}\`. Use a role name or role ID.`);
        return;
      }
      const added = addAllowedRole(guildId, role.id);
      if (added) {
        await message.reply(`✅ Role ${role} (\`${role.name}\`) can now add and remove sounds.`);
      } else {
        await message.reply(`ℹ️ Role ${role} was already allowed.`);
      }
      return;
    }

    if (subCmd === 'remove' && subParts.length >= 2) {
      const roleArg = subParts.slice(1).join(' ').trim();
      const roleId = /^\d+$/.test(roleArg) ? roleArg : null;
      const role = roleId ? guild.roles.get(roleId) : Array.from(guild.roles.values()).find((r) => r.name.toLowerCase() === roleArg.toLowerCase());
      if (!role) {
        await message.reply(`❌ Role not found: \`${roleArg}\`. Use a role name or role ID.`);
        return;
      }
      removeAllowedRole(guildId, role.id);
      await message.reply(`✅ Role ${role} (\`${role.name}\`) can no longer add or remove sounds.`);
      return;
    }

    if (subCmd === 'list') {
      const ids = getAllowedRoleIds(guildId);
      if (ids.length === 0) {
        await message.reply('No roles are configured. Only users with **Manage Server** can add/remove sounds. Use `!soundboard config role add <role>` to add one.');
        return;
      }
      const roles = ids.map((id) => guild.roles.get(id)).filter(Boolean);
      const names = roles.map((r) => `${r} (\`${r.name}\`)`).join(', ');
      await message.reply(`Roles that can add/remove sounds: ${names || '(none)'}`);
      return;
    }

    await message.reply(
      '❌ Usage: `!soundboard config role add <role name or ID>` | `remove <role>` | `list`'
    );
    return;
  }

  // !soundboard remove <emoji>
  if (content.startsWith('!soundboard remove ')) {
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply('❌ This command can only be used in a server.');
      return;
    }
    const member = await getMessageMember(message);
    if (!canManageSoundboard(member, guildId)) {
      await message.reply('❌ You don\'t have permission to remove sounds. You need **Manage Server** or a role configured with `!soundboard config role add`.');
      return;
    }
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
    const guildId = message.guildId;
    if (!guildId) {
      await message.reply('❌ This command can only be used in a server.');
      return;
    }
    const member = await getMessageMember(message);
    if (!canManageSoundboard(member, guildId)) {
      await message.reply('❌ You don\'t have permission to add sounds. You need **Manage Server** or a role configured with `!soundboard config role add`.');
      return;
    }
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
      try {
        SOUNDS[emojiKey].buffer = await readFile(webmFile);
      } catch (e) {
        logWarn('Could not preload new sound buffer:', e?.message);
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

  // Ready can fire multiple times on reconnect; only post soundboards once per process to avoid duplicates
  if (initialSoundboardSetupDone) {
    log('Skipping soundboard setup (already done this process).');
    return;
  }
  initialSoundboardSetupDone = true;

  log('Loading sound durations...');
  for (const [emoji, sound] of Object.entries(SOUNDS)) {
    const duration = await getAudioDuration(sound.path);
    soundDurations.set(emoji, duration);
    log(`  ${sound.name}: ${duration.toFixed(2)}s`);
  }

  log('Preloading sound buffers...');
  await preloadSoundBuffers();

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
      if (isPlaying.size > 0) return; // skip while feeding PCM to avoid event-loop stalls and stutter
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

  // Only accept reactions on the soundboard message for this guild
  if (reaction.messageId !== soundboardMessageIds.get(guildId)) return;

  const emojiRawForRemoval = emojiIdentifier || primaryKey;

  const removeReaction = async (opts = {}) => {
    if (reactingUserId === client.user.id) return;
    if (!emojiRawForRemoval) return;
    try {
      const baseRoute = Routes.channelMessageReaction(channelId, messageId, emojiRawForRemoval);
      await client.rest.delete(baseRoute);
      await addBotReactionToMessage(channelId, messageId, emojiRawForRemoval, guildId, { animated: opts.animated });
    } catch (error) {
      logWarn('[reaction] Remove failed:', error?.message ?? error);
    }
  };

  if (isPlaying.get(guildId)) {
    log('Blocked - already playing');
    await removeReaction({ animated: sound?.animated });
    return;
  }

  const voiceChannelId = voiceManager.getVoiceChannelId(guildId, reactingUserId);

  if (!voiceChannelId) {
    log('User not in voice');
    await removeReaction({ animated: sound?.animated });
    return;
  }

  isPlaying.set(guildId, true);

  try {
    const voiceChannel = client.channels.get(voiceChannelId);
    if (!voiceChannel) {
      isPlaying.delete(guildId);
      await removeReaction({ animated: sound?.animated });
      return;
    }

    log(`Playing ${sound.name}`);

    const connection = await voiceManager.join(voiceChannel);

    await new Promise(resolve => setTimeout(resolve, 500));

    // When Fluxer uses LiveKit and we have a preloaded buffer, use pre-decoded PCM for stutter-free playback
    const useLiveKitPcm = connection.room?.isConnected && sound.buffer;
    let played = false;
    if (useLiveKitPcm) {
      try {
        if (typeof connection.stop === 'function') await Promise.resolve(connection.stop()).catch(() => {});
        await playSoundboardSoundLiveKit(connection, sound);
        played = true;
      } catch (err) {
        logError('LiveKit PCM play error, falling back to stream:', err?.message ?? err);
        delete sound.pcmBuffer;
      }
    }
    if (!played) {
      log(`Using stream path for ${sound.name} (no LiveKit PCM or fallback)`);
      const stream = sound.buffer
        ? bufferToChunkedStream(sound.buffer)
        : createReadStream(sound.path, { highWaterMark: 512 * 1024 });

      const playResult = connection.play(stream);
      (playResult && typeof playResult.catch === 'function' ? playResult : Promise.resolve()).catch(err => {
        logError('Play error:', err.message);
      });

      const durationKey = emojiIdentifier || primaryKey || emojiName || (emojiName ? `:${emojiName}:` : null);
      const duration =
        (durationKey && soundDurations.get(durationKey)) ||
        (emojiName && soundDurations.get(emojiName)) ||
        (emojiName && soundDurations.get(`:${emojiName}:`)) ||
        3;
      const waitTime = (duration * 1000) + 250;
      log(`Waiting ${waitTime}ms for ${sound.name} to finish...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    log(`${sound.name} finished`);

  } catch (error) {
    logError('Error:', error.message);
  } finally {
    isPlaying.delete(guildId);
    await removeReaction({ animated: sound?.animated });
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

/** When gateway closes, the library may not emit Disconnect; wire 'close' so we reconnect. Only one listener per ws (remove before add to avoid leak on reconnect). */
let lastCloseHandlerWs = null;
const gatewayCloseHandler = () => {
  log('Gateway connection closed.');
  runReconnectLoop();
};
function attachCloseHandler() {
  try {
    const ws = client.ws;
    if (!ws) return;
    if (ws !== lastCloseHandlerWs) {
      if (lastCloseHandlerWs?.off) lastCloseHandlerWs.off('close', gatewayCloseHandler);
      lastCloseHandlerWs = ws;
      ws.on('close', gatewayCloseHandler);
      if (typeof ws.setMaxListeners === 'function') ws.setMaxListeners(20);
    }
  } catch (_) {
    // client.ws not available yet
  }
}

/** Periodic REST check; if we can't reach Fluxer, force destroy + reconnect. This might not be needed as it should reconnect automatically, needs more testing when servers are more stable*/
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
