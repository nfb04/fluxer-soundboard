# Fluxer Soundboard Bot

A soundboard bot for [Fluxer](https://fluxer.app) that posts a message with reaction buttons in a channel; clicking an emoji plays the corresponding sound in the bot’s voice channel.

## Features

- Post a soundboard (message with emoji reactions) in a text channel

<img width="640" height="653" alt="image" src="https://github.com/user-attachments/assets/8dd86a5f-b682-4b8e-b1e8-4c8266d2d109" />

- Play sounds in voice when users react

### Commands

| Command | Who can use it | Description |
|--------|----------------|-------------|
| **React to an emoji** | **Everyone** | Play that sound in the bot’s voice channel (you must be in a voice channel). |
| `!soundboard leave` | Manage Server **or** configured role | Make the bot leave the voice channel (backup when it doesn’t auto-leave). |
| `!soundboard reload` | Manage Server **or** configured role | Reload the soundboard message in the channel. |
| `!soundboard add "Name" <emoji>` | Manage Server **or** configured role | Add a sound; attach an audio file to the message. |
| `!soundboard remove <emoji>` | Manage Server **or** configured role | Remove a sound from the board. |
| `!soundboard config role add <role>` | **Manage Server only** | Grant a role permission to use leave/reload/add/remove. `<role>` = role name or ID. |
| `!soundboard config role remove <role>` | **Manage Server only** | Remove that permission from a role. |
| `!soundboard config role list` | **Manage Server only** | Show which roles can use leave/reload/add/remove. |

### Who can do what by default

- **Everyone** can **react** to play sounds.
- **Only users with the “Manage Server” permission** can use `!soundboard leave`, `!soundboard reload`, and add/remove sounds until you configure roles. 
Once an admin runs `!soundboard config role add <RoleName>`, anyone with that role can use those commands too. Role config is stored in `soundboard-roles-config.json` (restart-safe).

The bot converts audio (e.g. MP3) to WebM automatically. Other formats are supported as per the allowed extensions in the code.

## Requirements

- **Node.js 20+**, Tested with 20.20.0
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

```
- **FFmpeg** (used for duration checks and audio validation when adding sounds)
```bash
sudo apt install -y ffmpeg
```
- A **Fluxer bot token**

## Install

```bash
cd /opt
git clone https://github.com/nfb04/fluxer-soundboard.git
cd fluxer-soundboard
npm install
```
For other paths make sure to update your `WorkingDirectory` in Systemd.

## Configuration

### Getting a Fluxer bot token

You need a **bot token** from Fluxer before the bot can connect. Steps (may vary slightly with the Fluxer UI):

1. Go to **Settings** (your account / user menu).
2. Open **Applications** in the developer section.
3. **Create a new application** (e.g. “My Soundboard Bot”).
4. In the application, create or select a **Bot** and ensure the **bot** scope is enabled.
5. Grant the rights the bot needs, for example:
   - Send messages, embed links, attach files
   - Read message history (to see commands and reactions)
   - Add reactions
   - Connect and speak in voice channels
   - Manage Messages (to delete and repost the soundboard message)
6. **Copy the bot token**. This is your `FLUXER_BOT_TOKEN`.
7. **Invite the bot** to your server using the invite link from the application (with the same scopes/permissions).

Never share or commit the token; it grants full access to the bot.

### Log config
```bash
sudo touch /var/log/fluxer-soundboard.log
sudo nano /etc/logrotate.d/fluxer-soundboard
```
Paste
```bash
/var/log/fluxer-soundboard.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

### Bot token / Start Service

Create env file:
```bash
sudo nano /etc/fluxer-soundboard/env
```
Insert your bot token in the env file:
```bash
FLUXER_BOT_TOKEN=your_bot_token_here
```

**Systemd** (e.g. `/etc/systemd/system/fluxer-soundboard.service`)
  ```ini
  [Unit]
  Description=Fluxer Soundboard Bot
  After=network.target

  [Service]
  Type=simple
  User=root
  WorkingDirectory=/opt/fluxer-soundboard
  EnvironmentFile=/etc/fluxer-soundboard/env
  ExecStart=/usr/bin/node /opt/fluxer-soundboard/index.js
  Restart=always
  RestartSec=5
  StandardOutput=append:/var/log/fluxer-soundboard.log
  StandardError=append:/var/log/fluxer-soundboard.log

  [Install]
  WantedBy=multi-user.target
  ```
Make sure to create the env file first and place the bot token in there. You can use the env.example file.
Alternatively you can also replace the line with
```ini
  Environment="FLUXER_BOT_TOKEN=---------------your_actual_bot_token_here------------"
```

### Bot settings
The bot will look for a "soundboard" channel first. You can change the lookups here. If it doesnt find a suitable channel, it will use the first textchannel.
```js
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
```
Max Sound File Size is set to 5MB. You can change it here:
```js
const MAX_SOUND_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
```

Max Sound Duration is set to 25 seconds. You can change it here:
```js
const MAX_SOUND_DURATION_SEC = 25;
```

## Run

```bash
sudo systemctl daemon-reload
sudo systemctl enable fluxer-soundboard
sudo systemctl start fluxer-soundboard
```

On first run the bot will create `sounds-config.json` (empty by default) and, when you use role config, `soundboard-roles-config.json`. Both are listed in `.gitignore` so they are not committed (sounds and permissions stay local).

To add sounds (requires Manage Server or a role granted via `!soundboard config role add`):

`!soundboard add "Sound Name" 😀`  
(with an audio file attached)

## Disclaimer
This is an early version. It works fairly stable for me but Fluxer / fluxerjs is updating frequently and things could break at any time.
This project is provided as-is. I may update it occasionally, but I do not guarantee support or active maintenance. Hopefully we get a native soundboard from Fluxer at some point!

## AI Disclaimer
This bot was mostly vibe-coded in Cursor. I dont know JS very well and there will surely be better implementations. Nobody is forcing you to use it :)
I just needed a soundboard, couldnt find one, so I made one.

Feel free to contact me on Fluxer: nfb#0000

## License
MIT
(Use and modify as you like; no warranty.)
