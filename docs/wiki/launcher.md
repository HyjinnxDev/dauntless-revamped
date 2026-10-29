# Launcher (Electron player launcher)

> Verified against code 2026-10-24.

## What it is

`launcher/` is **Dauntless Revamped Launcher**, the Windows app players install. It joins a server from an invite link, creates or signs in to an account, downloads and verifies the pinned Dauntless 1.14.7 client, installs the server's runtime DLLs, then starts the game through a local pinned-TLS relay. It is an Electron Forge + Vite + TypeScript app (version `0.2.9` in `launcher/package.json`), UI in English, Finnish and Spanish. No game files are in the repo; they come from the host's backend (or a CDN the backend names) and every file is checked against a manifest compiled into the launcher (about 610 files, 16.5 GB).

Every source file, IPC channel, backend endpoint, on-disk file and settings key is listed in [Launcher file reference](launcher-files.md).

It is a descendant of the Dauntless Revived / Undaunted launcher. The older Forever-branded copy is in [launcher-bridge](launcher-bridge.md). The Tauri tool the host uses to publish runtime updates is a different thing: [paradox-launcher](paradox-launcher.md).

## Key files

Full per-file table: [launcher-files](launcher-files.md).

| Path | Purpose |
|---|---|
| `launcher/src/main.ts` | Electron main process: window, session hardening, IPC registration, tray, protocol handler, auto-update |
| `launcher/src/preload.ts` | The only renderer-to-main bridge: a fixed typed `window.launcher` API via `contextBridge` |
| `launcher/src/main/controller.ts` | Core state machine (1300 lines): servers, account, characters, install/repair task, play, relay start/stop, news/cards |
| `launcher/src/main/ipc-validate.ts` | Argument checks for IPC (bounded strings, settings patch, link names, trusted page URL) |
| `launcher/src/main/hostapi.ts` | All calls to the invite's server: `/launcher/v1/*` (accounts, characters, game session, runtime, info card) and `/content/v1/*` (manifest, news, branding) |
| `launcher/src/main/http.ts` | Tiny HTTP client over pinned TLS; never follows redirects; size and time caps |
| `launcher/src/main/pinned.ts` | TLS socket/agent that checks the server cert's SHA-256 against the invite fingerprint before sending anything |
| `launcher/src/main/downloader.ts` | Parallel, resumable (`.part` + Range) game-file downloader with retry/backoff, pause/resume/cancel |
| `launcher/src/main/verify.ts` | Size then SHA-256 check of installed files against the manifest |
| `launcher/src/main/manifest.ts` | Manifest validation, safe-path rules (`isSafeRelativePath`, `resolveInside`), manifest comparison |
| `launcher/src/main/game-manifest.ts` | Loads the compiled-in manifest (`launcher/data/dauntless-1.14.7.json`, aliased as `@game-manifest` in `vite.main.config.ts`) |
| `launcher/src/main/runtime.ts` | Installs `MysticParadox.dll` + `winmm.dll` from the server's release, SHA-256 checked |
| `launcher/src/main/relay.ts` | Local HTTP/WebSocket relay on `127.0.0.1` (any free port) forwarding to the server over pinned TLS |
| `launcher/src/main/launch.ts` | Builds game args, spawns `Dauntless-Win64-Shipping.exe`, points XMPP/voice at the relay |
| `launcher/src/main/keystore.ts` | Per-server refresh token stored via Electron `safeStorage` (DPAPI) |
| `launcher/src/main/settings.ts` | `settings.json` in userData (no secrets) |
| `launcher/src/main/links.ts`, `main/constants.ts` | Fixed URLs the launcher may open; pinned exe hash/size, changelist, update feed URL |
| `launcher/src/main/game-folder.ts` | "I already have the game files": locates an existing install (drive-letter paths only) |
| `launcher/src/main/migrate.ts` | One-time carry-over of the old Forever 1.14.7 launcher's data and uninstall of it |
| `launcher/src/shared/` | Code shared by main and renderer: `types.ts` (IPC names, Snapshot), `invite.ts`, `i18n.ts`, `status.ts`, `ui-model.ts` |
| `launcher/src/renderer/` | UI: `index.ts` (about 2200 lines), `dom.ts` (safe DOM builders), `scene.ts`, `styles.css` + `forever.css` (loaded), `dauntless-style.css` (dead), `brand/` art |
| `launcher/forge.config.ts` | Packaging: Squirrel installer + portable ZIP, Electron fuses |
| `launcher/scripts/` | `run-tests.mjs`, `make-invite.mjs`, `make-game-manifest.mjs`, `make-icon.mjs`, `collect-release.ps1`, `live-check.ts` |
| `launcher/test/` | `node:test` unit tests (see Tests) |

## How it works

### Process split and security model

- **Main** (`main.ts`) has all privileges: file system, network, spawning the game. It is the only place that talks to servers.
- **Preload** (`preload.ts`) exposes `window.launcher` with one function per feature (39 invoke calls plus 4 event subscriptions). Every call is `ipcRenderer.invoke(<fixed channel>, ...args)`; there is no generic send/invoke passthrough. Arguments are coerced (`String(x)`, `Number(x)`).
- **Renderer** (`src/renderer`) is a sandboxed page. `webPreferences`: `contextIsolation: true`, `nodeIntegration: false` (also in workers and subframes), `sandbox: true`, `webSecurity: true`, `webviewTag: false`, `devTools` only when not packaged. `app.enableSandbox()` is also called globally.
- **Page isolation**: strict CSP (`default-src 'none'`, scripts/styles/connect `'self'`, images `'self' dr-art: data:`), all permission requests denied, downloads prevented, `webRequest.onBeforeRequest` cancels everything except `file:`, `dr-art:`, `data:` and the dev server, new windows denied, navigation and redirects away from the app page blocked, `will-attach-webview` blocked.
- **DOM safety**: `renderer/dom.ts` builds elements with `textContent` and `setAttribute`, and the renderer has no `innerHTML` use, so server text (news, MOTD, server name) cannot become HTML.
- **Electron fuses** (`forge.config.ts`): `RunAsNode` off, `NODE_OPTIONS` and inspector flags off, cookie encryption on, ASAR integrity validation on, `OnlyLoadAppFromAsar` on.

### IPC

Channel names live in `IPC` in `src/shared/types.ts` (values like `dr:get-snapshot`). `main.ts` registers each through a local `handle()` wrapper that:

1. Refuses the call unless the sender is the main window's main frame **and** its URL is the packaged `index.html` (or the Vite dev server origin) - `trusted()` using `isTrustedPageUrl`.
2. Runs the handler in try/catch; failures return `{ ok: false, error: { code: "unknown" } }`.

Handler groups:

| Group | Channels (preload name) |
|---|---|
| State | `getSnapshot`, `setStatusPolling`, `refreshStatus` (no renderer caller), `getNews`, `getBranding` |
| Servers | `checkInvite`, `submitInvite`, `retryConnect`, `forgetServer`, `switchServer`, `removeSavedServer`, `addServer`, `takeInviteLink` |
| Account | `register`, `signIn`, `logout` |
| Characters | `selectCharacter`, `createCharacter`, `renameCharacter`, `setCharacterNameStyle`, `deleteCharacter` |
| Game files | `chooseInstallDir`, `useExistingGameFolder`, `useExistingGamePath`, `startInstall`, `pauseTask`, `resumeTask`, `cancelTask`, `repair`, `openGameFolder` |
| Play | `play`, `closeStrayGames` |
| Misc | `setSettings`, `openExternal`, `installUpdate`, `dismissNotice`, `dismissError`, window min/max/close |

Validation helpers in `ipc-validate.ts`: `boundedString(v, max)` (usernames 32, passwords 256, identifiers 254, invites 2048, game path 260), `settingsPatch` (only `windowed`, `streamerMode`, `language`, `gameLanguage`, whitelisted values), `externalTarget` (see below). Server ids must match `^[0-9a-f]{24}$`. Main to renderer events: `snapshot`, `progress`, `inviteLink`, `windowState`.

`openExternal`: the page sends a **target name** (for example `project_source`, `discord`), never a URL. `links.ts` maps names to fixed URLs, and `isAllowedStaticUrl` additionally limits to exact github.com pages and the Discord invite.

### Invite and server join

1. An invite string `dauntless-revamped://join?v=1&host=&port=&fp=&code=&name=` arrives pasted or through the OS protocol handler (the legacy `dauntless-forever-1147://` scheme still works). `shared/invite.ts` parses it strictly (host must be IPv4 or a plain DNS name, port, 64-hex certificate fingerprint `fp`, invite code, name).
2. `fp` is the SHA-256 of the server's TLS certificate. Every connection (status, account, downloads, the game's relayed traffic) goes through `pinned.ts`, which finishes the handshake, compares the cert hash and only then writes bytes. A self-signed cert is fine.
3. A sign-in is bound to host:port **and** fingerprint. A changed fingerprint for a known address makes the launcher ask first (`acceptNewCertificate`), then `keystore.rebind()`.
4. Up to `MAX_SAVED_SERVERS` servers are kept in `settings.json`; the Servers tab shows a card per server (online, players, ping, title, MOTD, logo) refreshed at most every 30 s from `GET /launcher/v1/info` (`hostapi.fetchServerCard`; a 404 means online with an empty card). Cards are produced by the backend, see [backend](backend.md).

### Login

- `register(username, password)` / `signIn(identifier, password)` call the backend's `/launcher/v1/*` account routes with a per-PC `deviceId`. The password is never stored.
- The backend returns an access token (short-lived, about 12 minutes, kept in memory only) and a rotating refresh token. The refresh token is saved by `keystore.ts` through `safeStorage` (Windows DPAPI), one per server, and never sent to the renderer. `controller.accessToken()` refreshes as needed (the downloader asks for a token per request because a download outlasts it).
- After sign-in the launcher loads the account's characters (`listCharacters` etc.); the chosen slot is sent when asking for a game session.

### Game download and verify

1. `launcher/data/dauntless-1.14.7.json` (generated by `scripts/make-game-manifest.mjs`) is compiled into the main bundle. `validateManifest` requires the right build id, unique case-insensitive safe paths, correct total, and the pinned game exe hash and size (`constants.ts`: `PINNED_EXE_SHA256`, `PINNED_EXE_SIZE`). Runtime DLL paths may not appear in it.
2. The server's `/content/v1/manifest` must be **identical** to the compiled one (`compareManifests`), otherwise the host is refused.
3. `verify.ts` checks size, then SHA-256 (it can skip the hash for files it already hashed with the same size and mtime). Missing or different files form the download list. Disk space is checked with a 1 GiB margin.
4. `DownloadJob` fetches at most 4 files at once, biggest first, from either the backend (`/content/v1/files/<path>`, Bearer token, pinned TLS) or, if the backend advertises `downloadBaseUrl`, a plain HTTPS CDN (R2 at `cdn.hyjinnx.com`, see [backend](backend.md)). CDN requests carry no credentials. Each file goes to `<file>.part`, resumes with `Range` (re-hashing the partial file first), and is renamed to its real name only after size and SHA-256 match. Retries use exponential backoff; 429/503 honour `Retry-After`; 401/403 means session expired; 404 or a differing ETag stops the job.
5. "I already have the game files" (`game-folder.ts`) accepts drive-letter paths only (UNC, device and root-relative paths are refused before any file call), then runs the same verify and download-the-difference flow.
6. Repair re-runs verify/download. Progress is pushed to the page through the `progress` event.

There is no archive extraction: files are individual downloads, so the usual zip-slip risk does not exist. Path safety is `isSafeRelativePath` + `resolveInside` (rejects `..`, drive letters, streams, Windows device names, trailing dots/spaces).

### Runtime install

`ensureRuntime` (called on every Play) fetches `/launcher/v1/runtime/client/stable/windows-x86_64` and `installRuntime` writes `MysticParadox.dll` and `winmm.dll` next to the game exe (`Archon/Binaries/Win64`), only if the SHA-256 differs. It writes `<name>.new`, renames, clears the Zone.Identifier mark and re-hashes. The hash comes from the same server over pinned TLS; the release's Ed25519 signature is **not** checked by the launcher (noted in a `ponytail:` comment in `hostapi.ts`). The release is produced by [paradox-launcher](paradox-launcher.md) and served by the backend.

### Play

`controller.play()`:
1. Refuses if another Dauntless client is running (`findRunningClients`).
2. Re-verifies that files are present and hashes the game exe against the pin on every launch.
3. Installs/updates the runtime.
4. Requests a game session from the backend (`requestGameSession`): sends exe hash, runtime version and artifact hashes, and the character slot; gets a 60-second one-time `exchangeCode`, optional `gameUserId` and a voice ticket/port.
5. Starts the relay (`relay.ts`) on `127.0.0.1`, on any free port (`Controller.startRelay` passes port 0; `DAUNTLESS_REVAMPED_RELAY_PORT` fixes it; the DLL learns the port from `MYSTICPARADOX_API_BASE`), rewrites the game's XMPP config to the relay, applies the bundled intro video, and spawns the game with fixed args (`-DisableEOS`, `-EpicPortal`, `-NoEAC`, `-AUTH_TYPE=exchangecode`, ... ) plus `-AUTH_PASSWORD=<exchange code>` (masked in logs). `launch.ts` validates code/user/name formats before building args.
6. While the game runs the window hides to a tray icon; closing is blocked until the relay stops (quitting from the tray asks first).

The relay forwards the game's plain HTTP (and WebSocket) to the backend over pinned TLS, drops hop-by-hop headers, and rejects requests that look like they come from a browser (`Sec-Fetch-*` headers, foreign `Origin` or `Host`) as DNS-rebinding protection. Game UDP traffic goes straight to the server; see [director](director.md).

### News and server cards

- News: `fetchNews` GETs `/content/v1/news` (max 30 items, text cleaned, 4000 char cap). The backend builds it from the Discord announcements channel through the [discord bot](discord-bot.md). News pictures use `/content/v1/news/image/<id>` (regex-checked path), are type-sniffed from magic bytes (not the Content-Type), capped at 15 MB, stored under `userData/art-cache/<sha256>` and shown through the `dr-art://bg/<hash>` scheme (ids must be 64 hex and previously downloaded).
- Branding: `/content/v1/branding` would list up to 8 background images (regex path) and an accent colour, but the 1.14.7 backend has no such route (always 404), so the page always rotates its bundled `brand/bg/shot1-6.jpg` over the built-in `scene.ts` background.
- News refresh is throttled to once per 60 s.

### Auto-update

Only Squirrel installs update (`Update.exe` must exist one folder up; the portable ZIP never updates). `update-electron-app` uses `UpdateSourceType.StaticStorage` with `baseUrl` = `UPDATE_FEED_URL` (`https://github.com/HyjinnxDev/dauntless-revamped-releases/releases/latest/download`), so Squirrel reads `RELEASES` and the `*-full.nupkg` of the newest GitHub release there (the comment on `UPDATE_FEED_URL` saying "hourly" is stale). The library minimum interval is 5 minutes, so `main.ts` also calls `autoUpdater.checkForUpdates()` every minute and on window focus. When a download finishes `controller.setUpdateReady()` shows a button; `installUpdate` calls `quitAndInstall`. A render-process crash relaunches once with `--safe-mode` (hardware acceleration off).

### Build and release

Release flow (all by hand on the owner's PC, no CI):

1. Bump `version` in `launcher/package.json` (it becomes the Squirrel/nupkg version and the tag).
2. `npm run release` = `electron-forge make --platform win32` + `scripts/collect-release.ps1 -Publish`.
3. `collect-release.ps1` copies `DauntlessRevampedLauncher-Setup.exe`, `RELEASES`, `*-full.nupkg` and the ZIP (renamed `DauntlessRevampedLauncher-<version>-win32-x64.zip`) into `launcher/release/`, writes `SHA256SUMS.txt` (LF), then `gh release create v<version> --repo HyjinnxDev/dauntless-revamped-releases`.
4. Open launchers pick it up within about a minute (60 s recheck) and show the update button.

Builds are **not code-signed** (no signing config in `forge.config.ts`); the README tells players to check `SHA256SUMS.txt` and expect a SmartScreen prompt. Integrity at run time relies on the Electron asar-integrity fuse, not a signature. Other commands: `npm start` (dev with Vite server), `npm run package`, `npm run typecheck`, `npm run icon`.
- `scripts/make-invite.mjs --host --cert --code --name` builds an invite link for a host.
- `app userData` is pinned to `%APPDATA%\Dauntless Revamped Launcher`; default game folder is `%LOCALAPPDATA%\DauntlessRevamped\Game`. `migrate.ts` copies the old Forever launcher's userData and runs its `Update.exe --uninstall`.

### Tests

`npm test` (`scripts/run-tests.mjs`) compiles `test/` with `tsc -p tsconfig.test.json` into `.test-build/` and runs `node --test` with concurrency 1; `npm test -- invite` filters by filename. Files cover: invite parsing, manifest validation, downloader (resume, retries, CDN), verify/game-folder, keystore, pinned TLS and relay (including the browser-refusal rules), links allow-list, controller flows with fakes (`test/fakes.ts`, test certs in `test/certs.ts`), settings, UI model, credits, brand assets, migration. `scripts/live-check.ts` is a manual check against a live server.

## Connects to

| Target | How |
|---|---|
| [Backend](backend.md) launcher API | `https://<host>:<port>/launcher/v1/*` (accounts, characters, game session, runtime, info card), pinned TLS |
| [Backend](backend.md) content API | `/content/v1/manifest`, `/files/<path>`, `/news`, `/news/image/<id>`, `/branding` |
| R2 CDN | `downloadBaseUrl` from the backend, HTTPS, hash-verified |
| Game process | spawns `Dauntless-Win64-Shipping.exe` with the runtime from [runtime](runtime.md); the DLL talks to the relay via `MYSTICPARADOX_API_BASE` |
| [Backend realtime](backend-realtime.md) | XMPP chat and voice relayed through the local relay / env set by `relayEnv` |
| GitHub releases repo | auto-update feed and launcher distribution |
| [Discord bot](discord-bot.md) | indirectly: backend news comes from the bot |
| Windows | protocol handler for `dauntless-revamped://`, DPAPI via `safeStorage`, tray |

## Config

Launcher has no `.env`. Inputs are:

- Env: `DAUNTLESS_REVAMPED_RELAY_PORT` (fixes the otherwise random relay port, 1024-65535), `LOCALAPPDATA`.
- CLI: `--safe-mode` (also set automatically after a renderer crash), an invite URL as argument.
- Files: `userData/settings.json` (keys in [launcher-files](launcher-files.md#settings-keys-settingsjson-storedsettings)), `userData/sessions/*.session`, `userData/verified-files.json`, `userData/logs`, `userData/art-cache`.
- Constants in `src/main/constants.ts`: update feed URL, project URLs, `TARGET_CHANGELIST = 647472`, `CONNECT_TIMEOUT_MS` 5 s, `STATUS_POLL_MS` 15 s.
- Build inputs: `launcher/data/dauntless-1.14.7.json`, `assets/` (icon, intro and login-loop videos).

## Gotchas

- The compiled-in manifest decides what a "correct" install is. If the live game files or the hosted CDN copy change, regenerate it with `scripts/make-game-manifest.mjs` and ship a new launcher; otherwise the server is refused ("manifest differs").
- The comment at the top of `src/main/game-manifest.ts` still says `dauntless-1.4.4.json`; the real alias is `data/dauntless-1.14.7.json`.
- The runtime DLL pair is fetched from whichever server the invite points at and only hash-checked against that server's own release. Players are trusting the host with code execution; see leads.
- Changing the server certificate breaks every player's sign-in (fingerprint pin) until they confirm the new one.
- The relay must stay running while the game runs; closing the launcher cuts the game off, which is why the window only hides to the tray.
- Only Squirrel installs auto-update. ZIP users must update by hand.
- `userData` is deliberately pinned by name; renaming the product would otherwise lose sign-ins.
- Almost the whole tree is duplicated in [launcher-bridge](launcher-bridge.md); security fixes to `pinned.ts`, `relay.ts`, `downloader.ts`, `verify.ts` need to be made in both if the bridge is still shipped.
- The page cannot reach the network at all (CSP + request filter). When adding UI that needs data, add an IPC call and fetch in main.
- Dead code to know about: `renderer/dauntless-style.css` and its `dl-*.svg` (never linked), the server-status panel (`shared/status.ts` parser; `Snapshot.status` is always null), `refreshStatus` IPC (no caller), `VC_REDIST_URL`.
- Stale comments: `relay.ts` header (1.4.4, port 61000), `game-manifest.ts` header (1.4.4 json), `UPDATE_FEED_URL` ("hourly").
- **Refresh tokens rotate on every use and the server revokes the family on reuse.** `refresh()` therefore saves the rotated token for the server it started on even if the player switched servers meanwhile, and `logout` waits for an in-flight refresh before removing the key (2026-10-28). Server-switch races elsewhere use `generation`: `connect()` and `loadExtras()` drop answers from a server the player left.
- `accessToken()` returns null both when the sign-in is gone and when a refresh failed for a moment; the account staying set means the latter. The download job treats that as a retry, not "session expired".
- `settings.json` and the verified-file cache write one at a time (`writing` chain): they share a `.tmp` file.

See also: [index](index.md), [setup](setup.md), [launcher-bridge](launcher-bridge.md), [paradox-launcher](paradox-launcher.md), [backend](backend.md), [discord-bot](discord-bot.md), [deploy](deploy.md).
