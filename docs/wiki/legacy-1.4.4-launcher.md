# Legacy 1.4.4: UndauntedLauncher (player launcher)

> Verified against code 2026-10-24.

## What it is

`versions/1.4.4/UndauntedLauncher/` is the Electron Forge + Vite + TypeScript app that players of the 1.4.4 stack install. It takes an invite link, registers an account on the host's server, downloads and verifies the 1.4.4 game files, installs two pinned DLLs and optional UE4SS mods next to the exe, and starts the game with the right arguments. Package `dauntless-forever-launcher`, product "Dauntless Forever Launcher" (`package.json` version `0.1.34`), Windows plus Linux (Proton/Wine). UI in English, Finnish and Spanish. It is the ancestor of the live launcher in `launcher/` ([launcher](launcher.md)); it is not the launcher used for the live 1.14.7 game. Part of the [legacy 1.4.4 stack](legacy-1.4.4.md).

No framework in the renderer: plain TypeScript building DOM nodes, strict CSP, all network access in the main process.

## File reference

All paths under `versions/1.4.4/UndauntedLauncher/`. Tests in `test/` are not listed.

### Package root

| File | What it does |
|---|---|
| `UndauntedLauncher/forge.config.ts` | Electron Forge config. Makers: Squirrel + ZIP (Windows), AppImage, deb, rpm, ZIP (Linux; `DAUNTLESS_REVIVED_SKIP_RPM=1` drops rpm). Vite plugin, Electron fuses. `extraResource`: `assets/dxgi.dll`, `assets/UndauntedInternalServer.dll`, `assets/icon.png`, `THIRD-PARTY-NOTICES.txt`, `../client-mods` |
| `UndauntedLauncher/index.html` | The renderer page: CSP, layer shells for the built-in scene, loads `styles.css` then `forever.css` and `src/renderer/index.ts` |
| `UndauntedLauncher/vite.main.config.ts` | Vite config for main: aliases `@game-manifest` to `../UndauntedContent/data/dauntless-1.4.4.json` so the manifest is compiled in |
| `UndauntedLauncher/vite.preload.config.ts` | Empty Vite config for the preload bundle |
| `UndauntedLauncher/vite.renderer.config.ts` | Vite config for the renderer: `assetsInlineLimit: 0` (no data URLs, keeps CSP strict) |
| `mockup/launcher-mockup.html` | Standalone HTML/JS design mockup of the launcher (drawer layout). Not built or shipped |
| `scripts/collect-release.ps1` | After `npm run make` on Windows: copies Squirrel installer, `RELEASES`, full `.nupkg`, renamed portable zip `DauntlessForeverLauncher-<version>-win32-x64.zip` into `release\` and writes `SHA256SUMS.txt` (LF). Used by CI and `launcher-release.yml` |
| `scripts/collect-linux-release.mjs` | Linux equivalent: copies AppImage/deb/rpm with versioned names, tars the packaged app, writes `SHA256SUMS-LINUX.txt` |
| `scripts/make-icon.mjs` | Copies icons and in-app logo images byte for byte from `brand/` (made by `brand/build.py`) into `assets/` and `src/renderer/brand/` |
| `scripts/run-tests.mjs` | `npm test`: compiles `test/` with tsc, runs `node:test`; optional name filter argument |
| `README.md`, `README.fi.md`, `LINUX.md` | Player docs (stale branding, see Gotchas) |

### Main process entry and bridge

| File | What it does |
|---|---|
| `src/main.ts` | Electron main. Single-instance lock, `dauntless-forever://` protocol registration (packaged builds only; legacy `dauntless-revived://` accepted from argv), window creation, IPC handlers with sender-frame checks (`isTrustedPageUrl`) and `ipc-validate.ts` argument checks, `dr-art://` privileged scheme that serves art-pack images, builds the `Controller` with platform pieces. Updates: Windows `updateElectronApp` against `UPDATE_FEED_URL` hourly; Linux `findLinuxUpdate` hourly. Env: `DAUNTLESS_REVIVED_RELAY_PORT` (relay port override), `DAUNTLESS_REVIVED_STORAGE_BOOTSTRAPPED` (internal) |
| `src/preload.ts` | `LauncherApi` bridge via `contextBridge`: fixed typed calls (`getSnapshot`, `checkInvite`, `submitInvite`, `register`, `startInstall`, `repair`, `play`, `setSettings`, `openExternal`, window controls, `onSnapshot`/`onProgress`/`onInviteLink` events, etc.). No generic invoke; the account key never crosses it |

### `src/main/`

| File | What it does |
|---|---|
| `main/controller.ts` | `Controller`: the state machine, no Electron imports. Owns state and `snapshot()`. Methods: `checkInvite`, `submitInvite`, `switchServer`, `forgetServer`, `connect`, `pollStatus`/`setStatusPolling` (every `STATUS_POLL_MS`), `getNews`, `getBranding`, `register`, `useExistingKey`, `importKeyFile`, `saveKeyBackup`, `inspectInstall`, `startInstall`, `repair`, `useExistingGameFolder`/`useExistingGamePath`, `pauseTask`/`resumeTask`/`cancelTask`, `play`, `setSettings`, `logout`, `shutdown`. `endpointFor` maps a stored server to an `Endpoint` |
| `main/autoregion.ts` | `tcpLatency`, `fastestRegion`, `chooseClosestRegion`: TCP-connect timing per region probe, picks lowest |
| `main/client-mods.ts` | `installClientMods`, `readClientModsManifest`: copies UE4SS + Lua mods from the `client-mods` resource only when each file's SHA-256 matches `manifest.json`, re-checks after copy. "keep" files (`mods.txt`, `UE4SS-settings.ini`) only written when missing; `disableModLines`/`addMissingModLines` edit `mods.txt`. Skipped under Wine/Proton. Failures never block play |
| `main/constants.ts` | Pins and URLs: `PINNED_EXE_SHA256` (`d3d41e61...`), `PINNED_EXE_SIZE` 103673520, `PINNED_DLLS` (dxgi + UndauntedInternalServer hashes), `EXE_RELATIVE_PATH` (`Archon/Binaries/Win64/...`), `VC_RUNTIME_FILES`, `XMPP_PORT` 61099, `STATUS_POLL_MS` 15000, `DISK_MARGIN_BYTES` 1 GiB, `DOWNLOAD_CONCURRENCY` 4, `UPDATE_FEED_URL`, project/upstream/Tailscale/VC++ URLs, `APP_ID`, `SQUIRREL_NAME` |
| `main/display-repair.ts` | `repairDisplaySettings`: called by `applyGameConfig`; when a saved `GameUserSettings.ini` resolution is below 1 or above 16384 (D3D11 texture limit), replaces the resolution lines with a 1280x720 window |
| `main/dlls.ts` | `dllStatus`, `installPinnedDlls`: copy `dxgi.dll` and `UndauntedInternalServer.dll` from resources into `Archon/Binaries/Win64`, hash before and after, strip Zone.Identifier (`unblock`) |
| `main/downloader.ts` | `DownloadJob`: resumable download of manifest files from `/content/v1/files/<path>` (or the manifest's `downloadBaseUrl` CDN, `contentDownloadBase`), 4 at a time, `.part` files, Range resume after re-hash, exponential backoff, `retryAfterMs`, pause/resume/cancel, `SpeedMeter` |
| `main/engineini.ts` | `applyGameConfig`: rewrites `Engine.ini` `[SystemSettings]` (memory lines, forced graphics level, `r.EyeAdaptation.MethodOverride=2` for "Basic adaptive" exposure) and `[OnlineSubsystemMcp.XMPP]` (`ServerAddr="ws://<host>"`, `ServerPort`), and `GameUserSettings.ini`; atomic write, keeps encoding |
| `main/game-folder.ts` | `locateExistingGame`/`findExistingGameRoot`: accepts a pasted folder that is the game root, its `Dauntless` child, or `Archon` itself; no search |
| `main/game-manifest.ts` | `GAME_MANIFEST`, `GAME_MANIFEST_PROBLEM`, `GAME_MANIFEST_FINGERPRINT`: the compiled-in manifest (via `@game-manifest`) validated at load |
| `main/hostapi.ts` | Calls to the invite host: `fetchServerStatus` (`GET /undaunted/api/ServerStatus`, falls back to `/dauntless-status`), `registerAccount` (`POST Register`), `fetchUserInfo` (`GET GetUserInfo`), `saveHuntRegion` (`POST HuntRegion`), `endPlaying` (`POST PlayingEnded`), `probeContent`/`fetchContentManifest` (`/content/v1/manifest`), `fetchNews`/`parseNews`, `fetchBrandingIndex`/`fetchBrandingImage` (+ `sniffImage` magic check, `MAX_ART_BYTES`). Key only in `x-undaunted-user-api-key` |
| `main/http.ts` | `request`: HTTP to the invite host only, never follows redirects, body-size caps. Private mode plain HTTP; public mode HTTP/1.1 over the pinned TLS socket. `checkEndpoint`, `parseJsonBody`, `HttpError` |
| `main/ipc-validate.ts` | `boundedString`, `settingsPatch`, `externalTarget`, `relayPortOverride`, `isTrustedPageUrl`: renderer argument validation |
| `main/keystore.ts` | `KeyStore`: one key per server, encrypted with `safeStorage` under `userData/keys`. Slot id `serverId` = truncated SHA-256 of `host:port` (or `public:host:port`). Public keys are bound to the cert fingerprint; `rebind()` only after user confirms. Also writes a **plaintext** recovery copy to `Documents/Dauntless Forever/Account Keys/<id>.txt` and reads it back if the encrypted file is gone. `backupFileText` formats the user backup |
| `main/launch.ts` | `buildLaunchArgs` (`host:port` first, `-AUTH_PASSWORD=<key>`, `FIXED_ARGS` Epic placeholders (`-AUTH_LOGIN=unused -AUTH_TYPE=exchangecode -EpicPortal -epicapp=... -NoEAC` etc.), locale from `gameLocale`, optional `-windowed -ResX=1280 -ResY=720`), `maskArgs` (hides the key in logs), `GameProcess` spawn wrapper, `findRunningClients` (ignores `-server` processes) |
| `main/links.ts` | `FIXED_LINKS`, `fixedLinkUrl`, `isAllowedExternalUrl`: renderer names a link target; main picks and checks the URL before `shell.openExternal` |
| `main/linux-dependencies.ts` | `linuxDependencyInstallPlan`, `runLinuxDependencyInstall` (pkexec), `repairLinuxDesktopEnvironment`: detect and install missing Linux packages |
| `main/linux-runtime.ts` | `detectLinuxRuntime`, `prepareLinuxGameLaunch`: finds Proton (Steam) or Wine, sets `STEAM_COMPAT_DATA_PATH`/`WINEPREFIX` under userData. Env overrides `DAUNTLESS_REVIVED_PROTON`, `DAUNTLESS_REVIVED_WINE`, `DAUNTLESS_REVIVED_AUTO_INSTALL`. Throws `LinuxRuntimeMissingError` |
| `main/linux-updater.ts` | `findLinuxUpdate` (GitHub `releases/latest` of `HyjinnxDev/dauntless-revived`, picks AppImage/deb/rpm asset), `installLinuxUpdate` (replaces AppImage and relaunches, or `pkexec apt install`/`rpm -U`) |
| `main/log.ts` | `log`, `redact`, `addSecret`/`removeSecret`, `logToFile`, `describeError`: logger that strips registered secrets, key-shaped strings and `-AUTH_PASSWORD=` |
| `main/manifest.ts` | Manifest types, `validateManifest`, `isSafeRelativePath`, `resolveInside`, `compareManifests` (server manifest must equal the compiled-in one), `manifestFingerprint`, `EXPECTED_BUILD` |
| `main/pinned.ts` | `pinnedConnect`, `PinnedAgent`, `certificateFingerprint`: TLS handshake, compare SHA-256 of the peer cert DER with the invite `fp` before writing any byte. `CertificatePinError`, `ConnectTimeoutError` |
| `main/relay.ts` | `Relay`: public mode HTTP->pinned-TLS relay on `127.0.0.1:61000` (`DEFAULT_RELAY_PORT`), forwards HTTP and the chat WebSocket to the gateway. `localRequestProblem` refuses browser-looking requests (DNS rebinding), `filterHeaders` drops hop-by-hop headers |
| `main/settings.ts` | `SettingsStore` for `userData/settings.json` (no secrets). Fields: `server`, `savedServers` (max `MAX_SAVED_SERVERS`), `installDir`, `verifiedDir`, `graphics`, `exposure`, `windowed`, `streamerMode`, `language`, `gameLanguage`, `showConsole`, `huntRegion` (`auto/main/aus/ger/us`), `usernames`, `backupOffered`. `sanitizeSettings` |
| `main/system.ts` | `findTailscale`, `freeBytes`, `missingVcRuntime`: PC prerequisite checks |
| `main/verify.ts` | `verifyInstall`, `checkFile`, `hashFile`, `removePartFiles`, `VerifiedCache`: size then SHA-256 against the manifest |
| `main/windows-runtime.ts` | `missingDirectX` (XINPUT1_3, X3DAudio1_7, XAPOFX1_5 in System32), `gameExitDetail` (explains 0xC0000135 / 0xC000007B exit codes) |

### `src/shared/` (used by main and renderer)

| File | What it does |
|---|---|
| `shared/invite.ts` | `parseInvite`/`formatInvite`: strict v1 (private, Tailscale/loopback host, port 61000) and v2 (public, `mode=public`, `fp`, port 443) invites. `INVITE_SCHEME` `dauntless-forever`, `LEGACY_INVITE_SCHEME` `dauntless-revived`. Host/port/code/fingerprint/share-URL validators |
| `shared/status.ts` | `parseServerStatus`: cleans the `ServerStatus` JSON (players, instances, registration mode). `limitedView`, `sortInstances` |
| `shared/types.ts` | Shared types: `Snapshot`, `Settings`, `Phase`, `ErrorCode`, `NoticeCode`, `TaskProgress`, `IPC` channel names, `LANGUAGES`, `GRAPHICS_PRESETS`, `EXPOSURE_MODES`, `GAME_LANGUAGES` |
| `shared/ui-model.ts` | Pure UI decisions from a `Snapshot`: `primaryButton`, `stepIndex`, `taskView`, label keys, `updateReason` |
| `shared/i18n.ts` | `STRINGS` (English, Finnish, Spanish; same keys and placeholders), `translate`, `systemLanguage` |
| `shared/credits.ts` | Credits page data: `PROJECT_PEOPLE`, `REVIVED_PEOPLE`, `UPSTREAM_PEOPLE`, `PATRONS`, `SOFTWARE`, localized roles |
| `shared/format.ts` | `formatBytes`, `formatSpeed`, `formatDuration`, `formatPercent`, `formatRunningTime`, `formatDate` |
| `shared/text.ts` | `UNSAFE_CHARS`, `UNSAFE_CHARS_MULTILINE`: control and bidi characters stripped from network text |
| `shared/username.ts` | `checkUsername` (3-16, `A-Za-z0-9_`), `isPlausibleAccountKey`, `extractAccountKey` (from a pasted backup file) |

### `src/renderer/`

| File | What it does |
|---|---|
| `renderer/index.ts` | The page: draws Snapshots (Play, Servers, Settings, Mods, Credits drawers), sends intents through the preload API. No network access of its own |
| `renderer/dom.ts` | `h`, `s`, `icon`, `githubMark`, `renderRegion`: DOM helpers that only use `textContent`/`setAttribute` |
| `renderer/scene.ts` | `buildScene`: draws the built-in night-mountain background from a fixed seed (used when the host has no art pack) |
| `renderer/styles.css` | Base stylesheet: brand palette tokens (`--dr-*` from `brand/palette.json`), layout, scene animation |
| `renderer/forever.css` | "Dauntless Forever" theme loaded after `styles.css`: one main screen with hero art and a PLAY button, other pages as drawers |
| `renderer/dauntless-style.css` | Alternative "game menu" look (blue bevelled bars). Not referenced by `index.html` or any import: dead file |

`assets/dxgi.dll` and `assets/UndauntedInternalServer.dll` are the pinned binaries shipped in the app (see [internal-server](legacy-1.4.4-internal-server.md)).

## How it works

### Invite and server modes

An invite is parsed strictly (`shared/invite.ts`); host, port and fingerprint decide where the account key goes.

| | Private (v=1) | Public (v=2) |
|---|---|---|
| Link | `dauntless-forever://join?v=1&host=&port=61000&code=&name=[&share=]` | `...?v=2&mode=public&host=&port=443&fp=<sha256>&code=&name=` |
| Host allowed | Tailscale `100.64.0.0/10`, `*.ts.net`, loopback | public IPv4 or DNS name |
| Transport | plain HTTP inside the tailnet | TLS pinned to `fp` |

`dauntless-revived://` is still accepted when pasted or passed in argv; only `dauntless-forever://` is registered with the OS. The 1.4.4 Discord bot still emits `dauntless-revived://` invites.

### Connect and register

1. `submitInvite` stores the server (settings + keystore slot). `connect()` polls `GET /undaunted/api/ServerStatus` every 15 s for name, registration mode, players.
2. `register(username)` calls `POST /undaunted/api/Register` with the invite code; the server returns a long account key, stored via `KeyStore` (encrypted + plaintext recovery copy). `useExistingKey` / `importKeyFile` restore one.
3. Public keys are bound to the cert fingerprint; a different fingerprint for the same host:port needs the player to confirm re-binding.

### Install and verify

1. `inspectInstall()` checks the folder. `startInstall()` downloads missing or wrong files, 4 at a time, resumable, only manifest paths. A server whose manifest differs is refused. Needs the remaining bytes plus a 1 GiB margin.
2. `repair()` re-hashes everything. "Use existing game files" verifies in place and replaces files that differ.
3. `installPinnedDlls()` and `installClientMods()` run on install, repair and before every launch.

### Play (`Controller.play`)

1. Refuse if a client is already running (`findRunningClients`).
2. Load the key, `GET GetUserInfo` to confirm. Pick the hunt region (`autoregion.ts` when `auto`) and `POST HuntRegion`.
3. Verify exe hash and size and the DLLs; reinstall DLLs/mods if needed.
4. Public mode: start `Relay` on `127.0.0.1:61000` first.
5. `applyGameConfig`: XMPP chat at host:61099 (private) or the relay (public); display repair.
6. Spawn `Dauntless-Win64-Shipping.exe` (Proton/Wine on Linux) with `buildLaunchArgs`; env `DR_SHOW_CONSOLE=1` when `showConsole`. On exit: `POST PlayingEnded`, stop the relay.

### Updates

Windows packaged builds: `update-electron-app` with a static feed `UPDATE_FEED_URL` (rolling GitHub release `launcher-updates`), hourly. Linux: `linux-updater.ts`, hourly.

## Connects to

| Peer | How |
|---|---|
| [Metagame](legacy-1.4.4-metagame.md) | `x-undaunted-user-api-key` on `Register`, `GetUserInfo`, `ServerStatus`, `HuntRegion`, `PlayingEnded`; game login happens inside the game |
| [Content server](legacy-1.4.4-content-bot-tools.md) (61002) | `/content/v1/manifest`, `/files/<path>`, `/branding`, `/branding/<file>`, `/news` |
| [Gateway](legacy-1.4.4-gateway-deploy.md) | pinned TLS to 443 (public mode); gateway only passes `Register`, `GetUserInfo`, `ServerStatus`, `HuntRegion`, `RegistrationStatus` under `/undaunted/api` |
| [Internal server DLL](legacy-1.4.4-internal-server.md) | `host:port` as argv[1]; chat endpoint via `Engine.ini` |
| `client-mods/` | resource folder bundled into the app |
| GitHub | update feed, Linux release API, project links (whitelisted in `links.ts`) |

## Gotchas

- **`PlayingEnded` is blocked in public mode.** `endPlaying` posts `/undaunted/api/PlayingEnded`, but the gateway's `PUBLIC_UNDAUNTED_API` does not list it, so it gets 403 through the gateway; it only works in private mode.
- **Plaintext key copy.** `KeyStore` writes each account key unencrypted to `Documents/Dauntless Forever/Account Keys/`. Treat that folder as credentials (cloud-synced Documents included).
- **Stale user docs.** `README.md` says "Dauntless Revived Launcher" and shows `dauntless-revived://`; code registers `dauntless-forever://`. Project URLs point at `HyjinnxDev/dauntless-revived`.
- **Pins are code.** A different exe or rebuilt DLL is refused until `constants.ts` and `assets/*.dll` change together (CI `tools/ci/check-repo.js` checks the DLL pins).
- **Never log keys.** Route new logging through `log.ts`. The key reaches the game only as a command-line argument.
- **Renderer is untrusted.** Every IPC call checks the sender frame and arguments; links are chosen by name in main.
- **Relay port 61000 must be free** on the player's PC in public mode (`port_busy`), unless `DAUNTLESS_REVIVED_RELAY_PORT` overrides it.
- **Linux updater has no checksum check**: it installs the downloaded GitHub asset (AppImage/deb/rpm) without comparing it against `SHA256SUMS-LINUX.txt`.
- UE4SS mods are Windows-only; skipped under Wine/Proton.
- `renderer/index.ts` is one 2000+ line file; `dauntless-style.css` is unused.

## See also

[index](index.md) - [legacy-1.4.4](legacy-1.4.4.md) - [legacy-1.4.4-metagame](legacy-1.4.4-metagame.md) - [legacy-1.4.4-gateway-deploy](legacy-1.4.4-gateway-deploy.md) - [legacy-1.4.4-internal-server](legacy-1.4.4-internal-server.md) - [legacy-1.4.4-content-bot-tools](legacy-1.4.4-content-bot-tools.md) - [launcher](launcher.md) - [launcher-bridge](launcher-bridge.md)
