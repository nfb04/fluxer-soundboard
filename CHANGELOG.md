# Changelog

## [1.0.0] - 2026-02-19

### Added

- Soundboard message with emoji reactions; react to play sounds in voice
- Commands: `!leave`, `!soundboard reload`, `!soundboard add "Name" <emoji>` (with attachment), `!soundboard remove <emoji>`
- Sounds stored in `sounds-config.json` and `sounds/`; optional `emoji-shortcodes.json`
- Reconnect with backoff on startup and on gateway close; keepalive check for silent disconnects
- Timestamped logging; README with install, token setup, and Fluxer token instructions

[1.0.0]: https://github.com/nfb04/fluxer-bot/releases/tag/v1.0.0
