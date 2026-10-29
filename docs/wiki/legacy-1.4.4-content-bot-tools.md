# Legacy 1.4.4: Content server, Discord key bot, tools, client mods, friend kit, brand

> Verified against code 2026-10-24.

Smaller parts of the [legacy 1.4.4 stack](legacy-1.4.4.md) under `versions/1.4.4/`. None of them run in the live 1.14.7 game.

## UndauntedContent (content server, port 61002)

Package `dauntless-revived-content`. Plain `node:http` (no Express), no database. Serves the 410 pinned 1.4.4 game files (by manifest) to registered accounts, plus the host's news and art pack, to the [launcher](legacy-1.4.4-launcher.md). Only dependency `yauzl` (used by `tools/make-game-manifest.js`, not by `src/`). Scripts: `start` (`dist/server.js`), `verify` (`dist/verify.js`), `test`, `test:integration`.

### Routes (all GET/HEAD, else 405)

| Route | Auth | Answer |
|---|---|---|
| `/content/v1/manifest` | none | Manifest JSON plus `downloadBaseUrl` (when set); strong ETag, 304 |
| `/content/v1/files/<path>` | `x-undaunted-user-api-key` checked with the Metagame | One manifest file; single Range (206/416), weak ETag, If-Range. 400 `bad_path`, 401 `unauthorized`, 503 `auth_unavailable`, 429 `too_many_streams`, 503 `server_busy`, 503 `file_unavailable` |
| `/content/v1/branding` | none | `{accent, backgrounds:[{url, credit}]}` from the art pack |
| `/content/v1/branding/<file>` | none | One art-pack image (magic bytes must match extension) |
| `/content/v1/news` | none | `{items:[{date,title,body}]}` |

### File reference (`versions/1.4.4/UndauntedContent/`)

| File | What it does |
|---|---|
| `src/server.ts` | Entry: `LoadConfig`, `LoadManifest` (warns if build != `EXPECTED_BUILD`), `CheckGameDir` (fatal if no file present), builds `CreateContentHandler` deps, listens on each `BIND_HOST` (30 s request timeout, 120 s socket timeout, 512 connections), SIGINT/SIGTERM stop |
| `src/app.ts` | `CreateContentHandler`: the routes above, JSON access logs, CORS for the public JSON/images, stream limiter acquire/release, file streaming with size/mtime re-check at open |
| `src/config.ts` | `LoadConfig`: `PORT` (61002), `BIND_HOST` (default 127.0.0.1, comma list; only loopback/Tailscale unless `CONTENT_ALLOW_ANY_BIND=1`, `IsPrivateBindHost`), `METAGAME_URL` (http://127.0.0.1:61000), `CONTENT_GAME_DIR` (required), `CONTENT_MANIFEST`, `CONTENT_DOWNLOAD_BASE_URL` (HTTPS CDN, no creds/query), `CONTENT_BRANDING_DIR`, `CONTENT_NEWS_FILE`, `CONTENT_MAX_STREAMS_PER_ACCOUNT` (6), `CONTENT_MAX_STREAMS_TOTAL` (48), `CONTENT_AUTH_CACHE_SECONDS` (300) |
| `src/auth.ts` | `AuthCache` (results cached by `HashKey` = SHA-256 of the key, never the key), `IsPlausibleKey`, `MetagameLookup` (`GET <METAGAME_URL>/undaunted/api/GetUserInfo`; 200+UserId = account, 401/403 = refused, else unavailable) |
| `src/manifest.ts` | `ValidateManifest`, `LoadManifest`, `IndexManifest` (exact-match map), `IsSafeManifestPath`, `OnDiskPath`, `DefaultManifestPath` (`data/dauntless-1.4.4.json`), `EXPECTED_BUILD` |
| `src/gamedir.ts` | `CheckGameDir`: startup size check of every manifest file; a file is served only while "ok" |
| `src/paths.ts` | `ParseFileRequestPath`, `FILES_PREFIX`: rejects encoded `/ \ . NUL`, control chars, Windows-special characters before the map lookup |
| `src/range.ts` | `ParseRange` (single range per RFC 9110), `IfRangeAllowsPartial`, `IfNoneMatchHits` |
| `src/limits.ts` | `StreamLimiter`: per-account and total concurrent download slots |
| `src/branding.ts` | `Branding`/`ScanBranding`: optional art pack from `CONTENT_BRANDING_DIR` (jpg/png/webp + optional `branding.json` with `accent` and `backgrounds`), rescanned periodically; `MagicMatches`, `CleanAccent`, `CleanCredit`, `BRANDING_PREFIX` |
| `src/news.ts` | `News`/`ParseNews`: news from `CONTENT_NEWS_FILE` (re-read on change, last good kept) and optionally `CONTENT_NEWS_URL` (must be a `raw.githubusercontent.com` file, fetched once a minute in the background, max 1 MB); plain-text bodies, max 50 items |
| `src/log.ts` | JSON-line logger (`Log`, `logger`, `SetLogSink`, `SetLogLevel`; `LOG_LEVEL`); never receives keys |
| `src/verify.ts` | `npm run verify [-- --quick] [--game-dir] [--manifest]`: hashes the game folder against the manifest at low priority; exit 0 only when everything matches |
| `data/dauntless-1.4.4.json` | The manifest (path, size, SHA-256 of 410 files, build id). Also compiled into the launcher via `@game-manifest` |
| `README.md` | Endpoint and status-code reference |

## UndauntedDiscordBot (Discord key bot)

Package `dauntless-revived-discord-keys`, `discord.js` 14.27.0, Node >= 22.12. Hands out single-use launcher invites and links Discord users to accounts. Separate from the live [discord-bot](discord-bot.md). Talks to the Metagame on loopback only, with a Metagame admin key.

Slash commands: `/key claim` (DM a v2 invite; falls back to the private reply if DMs fail), `/key status`, `/key link key:` (link an existing account by its launcher key), `/key resend` (resend the saved unused invite), `/key recover [confirm:]` (rotate a linked account's key; only registered when `KEY_RECOVERY_SERVICE_SECRET` is set), `/counter category_id:` (owner-only live member counter).

| File | What it does |
|---|---|
| `UndauntedDiscordBot/bot.mjs` | Entry. Env `DISCORD_BOT_TOKEN`, `METAGAME_ADMIN_KEY` (required), `KEY_STATE_FILE` (`./data/keys.json`), `SERVER_CONFIG_FILE`, `METAGAME_URL` (http://127.0.0.1:61000), `DISCORD_GUILD_ID`, `COUNTER_STATE_FILE`, `KEY_RECOVERY_SERVICE_SECRET`. Instance lock, Discord client, command sync, per-user 10 s cooldown, result-to-message table, member-intent detection (counter disabled without it), exits after 120 s without a ready connection so the supervisor restarts it |
| `UndauntedDiscordBot/commands.mjs` | `keyCommand` definition and `syncKeyCommands` (patch/post the global `/key` only when its shape changed; delete old guild copies) |
| `UndauntedDiscordBot/keys.mjs` | `loadState`/`saveState` (atomic JSON state), `backend()` Metagame client (`InviteCodes`, `RegisterInviteCode`, `DiscordLink`, `DiscordLink/<id>`, `GetUserInfo` for key identity; loopback HTTP only), `Keys` class (`migrateLinks`, `deliver`, `deliverPrivate`, `link`, `run`, `handle`): one invite per Discord user, never re-issued after redeem/revoke |
| `UndauntedDiscordBot/invite.mjs` | `loadInviteConfig` (reads `server.json`: `Mode` must be `Public`, `PublicHost`, `Ports.gateway`, `CertFingerprint`, `ServerName`), `launcherInvite` (builds `dauntless-revived://join?v=2&mode=public...`), `inviteMessage` |
| `UndauntedDiscordBot/link-input.mjs` | `linkInput`: extracts a key from pasted text (code fences, quotes, `Key:` line), rejects pasted invites; `keyInstructions` text |
| `UndauntedDiscordBot/recovery.mjs` | `recoveryRequest` (`POST /internal/key-recovery/<begin/confirm/link>` with `x-key-recovery-service`, loopback only), `recoverInteraction`, `resendInteraction`, `sendPrivately` (DM, else ephemeral) |
| `UndauntedDiscordBot/dm-history.mjs` | `findInviteMessage`: scans up to 2000 DMs for the bot's own invite message (delivery reconciliation) |
| `UndauntedDiscordBot/instance.mjs` | `acquireInstance`: single-instance lock via a named pipe (Windows) or loopback port derived from the state-file hash |
| `UndauntedDiscordBot/counter.mjs` | `/counter`: `Counters` keeps "Bots / Users / Total" voice channels in a category up to date (10 s debounce, 5 min resync). Owner id hardcoded as `COUNTER_OWNER` |
| `UndauntedDiscordBot/Run-Bot.ps1` | Windows supervisor loop: runs `bot.mjs` from `<Root>\discord-keys` with `data/config/discord-keys.env`, logs to `data/logs`, backoff 5-60 s |
| `README.md` | Setup and `/key` behaviour (mentions only claim/status; code has more) |

## tools/

Run from `versions/1.4.4/`. Owner dashboard and status tools read the Metagame with the owner (admin) key.

| File | What it does |
|---|---|
| `tools/dashboard.mjs` | Owner dashboard server on `127.0.0.1:61110` (`DASHBOARD_PORT`), header `x-dashboard-key`. Routes: `/` (page), `/dashboard.js`, `GET /api/status` (sample + fleet), `/api/log?`, `/api/accounts?` (`DashboardAccounts`), `/api/account-key?` (`AccountRecovery/<id>`), `POST /api/invites` (`CreateInvite`), `/api/moderation` (`Moderation`). Polls Metagame `GetAllUsers`, `ServerStatus`, `DiscordKeyStats`, `BackendHealth`. Env `DASHBOARD_OWNER_KEY_FILE`, `DASHBOARD_BACKEND`, `DASHBOARD_LOG_CONFIG_FILE`/`DASHBOARD_LOG_FILES`, `DASHBOARD_SERVER_CONFIG`, `DASHBOARD_PERFORMANCE_DIR`, `DASHBOARD_WORKER_URL`, `DASHBOARD_AUS_URL`, `DASHBOARD_GERMANY_URL`. `scrubLog` drops credential-looking log lines |
| `tools/dashboard.html` | Dashboard page (Overview, Server #1-#4, Backend health, Players & accounts, Invites, Logs); key kept in tab memory only |
| `tools/dashboard-client.js` | Dashboard page script: fetches `/api/*`, draws canvas charts and tables, invite and moderation forms |
| `tools/dashboard-fleet.mjs` | `fleetSummary`: per-server rows (main + EU overflow, Australia, Germany workers) and totals, freshness checks |
| `tools/dashboard-performance.mjs` | `parsePerformance`, `readPerformance`: reads the newest kit performance CSV cohort (numeric fields only) |
| `tools/dashboard-worker.mjs` | `monitorWorker`: polls a worker's `GET /health` over a loopback tunnel, keeps 720 samples |
| `tools/worker-health.mjs` | Worker monitor on `127.0.0.1:61111` `GET /health` (loopback, no proxy headers): CPU, RAM, disk, uptime, DeployServer `/gameservers`, allowlist `/status` (`ALLOWLIST_SECRET`), Metagame `/dauntless-status`, process list. Env `WORKER_ROOT` |
| `tools/worker-processes.ps1` | Run by `worker-health.mjs` every minute: JSON of game and stack processes (by listening port 61001/61005/61111, UDP 8750-8800), CPU seconds, memory, network bytes |
| `tools/discord-status.mjs` | Status worker: every 5 s samples `ServerStatus` and the dashboard `/api/status`, edits one Discord webhook message with players, fleet availability, hunts per server. Env `STATUS_OWNER_KEY_FILE`, `STATUS_WEBHOOK_FILE`, `STATUS_STATE_FILE`, `STATUS_BACKEND`, `STATUS_DASHBOARD`, `STATUS_ERROR_FILE`. `webhookUrl` only accepts `discord.com/api/webhooks/...` |
| `tools/summarize-performance.mjs` | CLI: `parseSamples`/`statistics`/`summarize` over a kit performance CSV |
| `tools/make-game-manifest.js` | Builds `UndauntedContent/data/dauntless-1.4.4.json` from the verified game zip (pinned zip SHA-256, streamed via `yauzl`, CRC/size checks, safe paths, `--compare-dir`/`--compare-all`) |
| `tools/make-friend-kit.ps1` | Builds the friend-kit zip from `friend-kit/` + pinned DLLs + licence + `SOURCE.txt` (refuses a dirty tree); default `-Out C:\dr\dist` |
| `tools/build-llms.js` | Generates `docs/llms.txt` and `docs/llms-full.txt` from the docs front matter |
| `tools/sync-roadmap.js` | Regenerates `docs/roadmap.md` from `ROADMAP.md` |
| `tools/xref.py` | PE string cross-references and annotated disassembly (`find <text>`, `func <addr>`); needs `pefile`, `capstone` |
| `ci/check-repo.js` | CI hygiene: no secrets or game files tracked (names, `.gitignore` bypass, manifest hashes, key/JWT/private-key/token patterns), DLL pins match launcher and kit, launcher version is valid. `--history <range>` checks commits too |
| `ci/launcher-version.js` | Launcher version rules: `valid`, `compare`, `newest`, `nuget`, `from-nupkg` subcommands (semver without build metadata) |
| `DASHBOARD.md`, `DISCORD-STATUS.md`, `dashboard.env.example` | Dashboard and status-worker docs and env template |

## client-mods/

Optional client-side UE4SS 3.0.1 (`dwmapi.dll` proxy + `ue4ss/UE4SS.dll`) and Lua mods under `ue4ss/Mods/`: `BehemothHealthBars`, `BehemothTracker`, `CraftStar`, `Keybinds`, `ModMenu`, `shared`. Installed by the launcher (`main/client-mods.ts`) and `friend-kit/setup.ps1` only when hashes match `manifest.json`. Windows only.

| File | What it does |
|---|---|
| `client-mods/update-manifest.ps1` | Rebuilds `manifest.json` (SHA-256 + size of every bundle file). Marks `mods.txt` and `UE4SS-settings.ini` as "keep" (never overwritten), lists removed files (old `ZFXStatus` mod) for installers to delete. Run after any change and commit both |
| `client-mods/manifest.json`, `README.md` | Hash list; install and mod docs |

## friend-kit/

Script-only alternative to the launcher for private (Tailscale) servers. Packaged by `tools/make-friend-kit.ps1`; a built copy lives in the git-ignored `data/friend-kit/`.

| File | What it does |
|---|---|
| `friend-kit/setup.ps1` | One-time setup: `-Server <tailscale ip[:port]>`, `-Game` (default `C:\D144\Dauntless`). Checks game files, installs the two pinned DLLs and hash-checked client mods, registers the account, saves the key |
| `friend-kit/play.ps1` | Launch: rewrites `Engine.ini` (XMPP to host, optional `-Graphics 0..4`), starts the exe with host:port and `-AUTH_PASSWORD`, optional `-Windowed` 1280x720 |
| `friend-kit/Play Dauntless.cmd` | Double-click wrapper for `play.ps1` |

## brand/

| File | What it does |
|---|---|
| `brand/build.py` | Builds every derived brand image from `logo-full.png`, `emblem.png` and `palette.json` (checks contrast pairs): `web/`, `icons/`, `launcher/`, `social-preview.png`, `og.png`, `../.github/assets/banner.png`, copies into `../docs/assets/`. Needs Python 3.10+, Pillow (WebP, libimagequant), `rsvg-convert`, Inter and JetBrains Mono fonts |
| `brand/README.md`, `palette.json` | What goes where; the eight brand colours |

## Gotchas

- Content `BIND_HOST` refuses public addresses unless `CONTENT_ALLOW_ANY_BIND=1`; in public mode it stays on loopback behind the [gateway](legacy-1.4.4-gateway-deploy.md).
- The key bot emits `dauntless-revived://` invites and needs a public-mode `server.json`; Tailscale-only servers use kit invites.
- Run exactly one bot per state file (`acquireInstance` enforces it). Back up `KEY_STATE_FILE` with the DB.
- `COUNTER_OWNER` in `counter.mjs` is a hardcoded Discord user id.

## See also

[legacy-1.4.4](legacy-1.4.4.md) - [legacy-1.4.4-launcher](legacy-1.4.4-launcher.md) - [legacy-1.4.4-gateway-deploy](legacy-1.4.4-gateway-deploy.md) - [legacy-1.4.4-metagame](legacy-1.4.4-metagame.md) - [legacy-1.4.4-docs-site](legacy-1.4.4-docs-site.md)
