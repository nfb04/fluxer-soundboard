# Changelog

## [1.0.1] - 2026-02-22

### Added

- **Role-based access:** Only users with **Manage Server** or a configured role can use `!soundboard leave`, `!soundboard reload`, and add/remove sounds. Everyone can still **react** to play sounds. Configure roles with `!soundboard config role add/remove/list <role>` (Manage Server only). Stored in `soundboard-roles-config.json` (restart-safe).
- **Permission checks:** Leave, reload, add, and remove require a server context and the above permission; config commands require Manage Server.

### Changed

- **`!leave` renamed to `!soundboard leave`** for consistency with other soundboard commands.
- **Embed help:** The posted soundboard message no longer lists commands (most users can’t use add/remove); it only shows “React to play sounds” and the sound list.

### Fixed

- (none this release)

---

## [1.0.0] - 2026-02-19

### Added

- Soundboard message with emoji reactions; react to play sounds in voice
- Commands: `!leave`, `!soundboard reload`, `!soundboard add "Name" <emoji>` (with attachment), `!soundboard remove <emoji>`
- Sounds stored in `sounds-config.json` and `sounds/`; optional `emoji-shortcodes.json`
- Reconnect with backoff on startup and on gateway close; keepalive check for silent disconnects
- Timestamped logging; README with install, token setup, and Fluxer token instructions

[1.0.0]: https://github.com/nfb04/fluxer-bot/releases/tag/v1.0.0
