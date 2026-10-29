# Launcher file reference

> Verified against code 2026-10-24.

File-by-file reference for `launcher/` (Dauntless Revamped Launcher 0.2.8, commit c0f31ba). How the parts work together is on [Launcher](launcher.md); the Forever-branded copy is on [Launcher bridge](launcher-bridge.md). Paths below are relative to `launcher/`.

## Main process (`src/`, `src/main/`)

Runs in Node with full privileges. Only `src/main.ts` imports Electron; everything in `src/main/` takes Electron pieces through the `Platform` interface so tests can run it in plain Node.

| File | What it does |
|---|---|
| `src/main.ts` | Electron entry. Pins `userData` to `%APPDATA%\Dauntless Revamped Launcher`, runs `migrateUserData` before ready, single-instance lock (`second-instance` delivers invite links), registers `dauntless-revamped:` and `dauntless-forever-1147:` protocol handlers (packaged only, pointing at the Squirrel stub exe), registers the privileged `dr-art:` scheme and its `protocol.handle` (serves `controller.resolveArt(id)` files), `hardenSessions` (deny permissions/downloads, `webRequest` filter, dev CSP header), `web-contents-created` navigation/window/webview blocks, `createWindow` (frameless, sized to the work area, sandboxed `webPreferences`, renderer-crash relaunch with `--safe-mode`), tray (`syncTray`, `hideToTray`, `quitFromTray`), `trusted()` + `handle()` IPC wrapper, `registerIpc` (all invoke channels, see IPC table), `makePlatform` (the `Platform` for `Controller`: safeStorage encryptor, folder dialog, `shell.openExternal`, snapshot/progress senders, `findRunningClients`, `autoUpdater.quitAndInstall`), startup (`uninstallOldLauncher`, `Controller.init`, `updateElectronApp` + 60 s/focus `autoUpdater.checkForUpdates`), `window-all-closed` -> `controller.shutdown()` |
| `src/preload.ts` | `contextBridge.exposeInMainWorld("launcher", api)`: one typed function per invoke channel plus `onSnapshot`, `onProgress`, `onInviteLink`, `onWindowState`. Coerces every argument (`String()`, `Number()`, `=== true`); `setSettings` copies only the four known keys. Exports type `LauncherApi` |
| `src/game-manifest.d.ts` | Declares module `@game-manifest` (the JSON aliased in `vite.main.config.ts`) |
| `main/controller.ts` | `Controller`: the whole launcher state machine; owns `SettingsStore`, `KeyStore`, `GameProcess`, `VerifiedCache`, `Relay`, `DownloadJob`. `computePhase` -> `Phase`; `snapshot()` builds the `Snapshot`; `publish()` emits it. Join flow (`checkInvite`, `submitInvite`, `switchServer`, `addServer`, `removeSavedServer`, `forgetServer`, private `join`, `certificateChange`, `resetServerState` bumps `generation`), `connect` (status -> `probeContent` -> `resumeSession` -> `inspectInstall` -> `loadExtras`), `setStatusPolling`/`pollStatus` (every `STATUS_POLL_MS`; 2 failed polls flip to connect unless the game runs), `refreshCards`/`checkCards` (server cards, 30 s throttle, plus `tcpPing`), news/art (`refreshNews` 60 s throttle, `newsImage`, `keepArt` writes `art-cache/<sha256>`, `resolveArt`), account (`register`, `signIn`, `logout`, `adopt`, single-flight `refresh`, `accessToken` renews 10 min after issue), characters (`loadCharacters`, `selectCharacter`, `characterAction` for create/rename/name-style/delete), install (`inspectInstall`, `runtimeOk`, `chooseInstallDir`, `useExistingGameFolder`, `useExistingGamePath`, `openGameFolder`, `runTask` = verify -> manifest compare -> disk check -> `DownloadJob` -> `ensureRuntime` -> `removePartFiles`), `play` (stray-client check, exe hash pin, `ensureRuntime`, `requestGameSession`, `startRelay`, `applyIntro`, `pointXmppAtRelay`, `GameProcess.start` with `relayEnv`), `closeStrayGames`, `setSettings`, `openExternal`, `installUpdate`, `shutdown`. Also exports `endpointFor`, interface `Platform` |
| `main/hostapi.ts` | Every request to the invite's server (see endpoint table). Exports `fetchServerStatus`, `fetchServerCard`/`parseServerCard`, `tcpPing`, `registerAccount`, `login`, `refreshSession`, `logout`, `listCharacters`, `createCharacter`, `renameCharacter`, `setCharacterNameStyle`, `deleteCharacter`, `requestGameSession`, `fetchRuntimeRelease`/`parseRuntimeRelease`, `downloadRuntimeFile` (64 MiB cap), `probeContent`, `fetchContentManifest`, `fetchNews`/`parseNews`/`cleanNewsBody`, `fetchBrandingIndex`/`parseBranding`, `fetchBrandingImage` (15 MiB cap, path regex, `sniffImage` magic bytes), `apiFailure` (`CODE_MAP` backend `error.code` -> `ErrorCode`). Validates every response shape (refresh token 64 hex, display name 3-16 alnum, exchange code 16-256, voice ticket) |
| `main/http.ts` | `request(ep, path, opts)`: HTTP/1.1 over a pinned TLS socket (`pinnedCreateConnection`), never follows redirects, hard `timeoutMs` and `maxBytes`, `AbortSignal`. Methods `GET/POST/PATCH/DELETE/HEAD`. Also `Endpoint`, `HttpError` (`timeout/network/too_large/aborted/bad_url/pin`), `checkEndpoint`, `endpointUrl`, `hostHeader`, `pinnedTarget`, `parseJsonBody` |
| `main/pinned.ts` | TLS pinned to the invite fingerprint: `pinnedConnect` finishes the handshake (`rejectUnauthorized: false`, TLS 1.2+, SNI only for names, ALPN http/1.1), compares SHA-256 of the peer DER cert, only then hands out the socket (with `setNoDelay`). `PinnedAgent` (http.Agent with pinned sockets), `pinnedCreateConnection`, `CertificatePinError`, `ConnectTimeoutError`, `certificateFingerprint`, `peerCertificateDer`, `isPinError` |
| `main/relay.ts` | `Relay`: local `http.createServer` on `127.0.0.1` (port from the controller: `DAUNTLESS_REVAMPED_RELAY_PORT` or 0 = any free port; `DEFAULT_RELAY_PORT` 61000 only applies when no port is passed) forwarding the game's HTTP and WebSocket upgrades to the server through a `PinnedAgent`. `filterHeaders` drops hop-by-hop and Host, `localRequestProblem` refuses `Sec-Fetch-*`, foreign `Origin`, non-loopback `Host`. Counters `requests`, `upgrades`, `failures`; `onPinError` callback. `RelayError` (`port_busy`, `listen_failed`). Header comment still describes 1.4.4 and port 61000 |
| `main/downloader.ts` | `DownloadJob`: up to 4 workers, queue sorted biggest first, `<file>.part` + `Range` resume (partial re-hashed), `Content-Range`/`Content-Length` checks, rename after size + SHA-256 match, `onFileVerified`. Retries `maxAttempts` 6 with `defaultBackoff` (1 s doubling to 30 s, jitter); 429/503 wait `retryAfterMs` (1-30 s); 401/403 -> `session_expired`; 404 -> `file_missing_on_server`; ETag != manifest hash (backend only) -> `file_different_on_server`; 416 deletes the part. `pause/resume/cancel/progress`, `SpeedMeter`. Source is the backend (`fileUrlPath` = `/content/v1/files/<enc path>`, Bearer from `auth()`, `PinnedAgent`) or, when `contentDownloadBase(manifest)` gives an https `downloadBaseUrl`, a plain `https.Agent` CDN with no credentials. `DownloadError` codes map to `ErrorCode` in `runTask` |
| `main/verify.ts` | `hashFile` (streamed SHA-256, abortable), `checkFile` (missing/size/hash), `verifyInstall` (size-only or `fullHash`, `trusted` skip, progress), `removePartFiles`, `VerifiedCache` (`userData/verified-files.json`: per-folder path -> size + mtime of files already hashed; `isTrusted`, `record`, `forget`, `save`), `AbortedError` |
| `main/manifest.ts` | `EXPECTED_BUILD` (`dauntless_rel-1.14.7_Shipping_2024-04-01_14-59-21_647472`), `isSafeRelativePath` (no `..`, drive letters, streams, device names, trailing dot/space; charset `[A-Za-z0-9_.+() -]`), `resolveInside`, `validateManifest` (build, unique case-insensitive paths, size sum, no runtime DLLs, pinned exe hash+size), `compareManifests` (server manifest must equal compiled one), `manifestFingerprint` |
| `main/game-manifest.ts` | Imports `@game-manifest`, validates it once: `GAME_MANIFEST`, `GAME_MANIFEST_PROBLEM`, `GAME_MANIFEST_FINGERPRINT`. Header comment wrongly says `dauntless-1.4.4.json` |
| `main/runtime.ts` | Runtime pair install: `win64Dir`, `installedRuntime`, `runtimeMatches`, `installRuntime` (skip if hash matches; else download, hash, write `<name>.new`, rename, delete `:Zone.Identifier`, re-hash), `RuntimeError` (`download/hash/disk/in_use`; EPERM/EBUSY = `in_use`) |
| `main/launch.ts` | Game start: `FIXED_ARGS` (`-DisableEOS -EpicPortal -NoEAC -AUTH_TYPE=exchangecode -epicapp=Archon -epicenv=Prod -epicsandboxid=jackal -epicdeploymentid=...`), `buildLaunchArgs` (validates code/user/name; adds `-AUTH_LOGIN`, `-AUTH_PASSWORD`, `-epicusername/userid/accountid`, `-epiclocale`, `-windowed -ResX=1280 -ResY=720`), `gameLocale`, `relayEnv` (`MYSTICPARADOX_API_BASE=http://127.0.0.1:<port>`, `MYSTICPARADOX_VOICE_ADDR`, `MYSTICPARADOX_VOICE_TICKET`), `pointXmppAtRelay`/`withXmppSection`/`withIniSection` (rewrites `[OnlineSubsystemMcp.XMPP]` in `%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient\Engine.ini`, keeps UTF-16 BOM), `defaultGameConfigDir`, `maskArgs`/`describeLaunch`, `GameProcess` (one child, `onChange(running, code)`), `findRunningClients` (`tasklist` then PowerShell `Get-CimInstance`, skips `-server` processes, returns PIDs only) |
| `main/keystore.ts` | `KeyStore`: one file per server `userData/sessions/<serverId>.session`, safeStorage-encrypted `DFS1\n<fp>\n<refresh token>`, written via `.tmp` + rename. `has`, `save`, `load` (only for the same fingerprint), `certificateOf`, `rebind`, `remove`; registers tokens with `log.addSecret`. `serverId(host, port)` = first 24 hex of SHA-256 `host:port`. `isPlausibleRefreshToken`, `KeyStoreError`, `Encryptor` |
| `main/settings.ts` | `SettingsStore` on `userData/settings.json` (atomic `.tmp` + rename, every write re-sanitized), `sanitizeSettings`, `defaultSettings`, `sameServer`, `MAX_SAVED_SERVERS` = 20, types `StoredServer`, `StoredSettings` (keys below) |
| `main/ipc-validate.ts` | `boundedString`, `settingsPatch` (rejects the whole patch on any unknown key/value), `externalTarget` (exact `ExternalTarget` names), `relayPortOverride` (1024-65535), `isTrustedPageUrl` (packaged `index.html` URL, or dev-server origin) |
| `main/links.ts` | `FIXED_LINKS` target -> URL (project source/license/contributors, Revived, Undaunted, Mystic Paradox, Discord `https://discord.gg/HpgNEmVbBb`), `fixedLinkUrl`, `isAllowedStaticUrl` (exact github.com pages or the Discord invite, https, no port/userinfo), `isAllowedExternalUrl` (second parameter unused) |
| `main/constants.ts` | `APP_ID`, `SQUIRREL_NAME` (`DauntlessRevampedLauncher`), project URLs, `UPDATE_FEED_URL` (`.../dauntless-revamped-releases/releases/latest/download`; comment "checks hourly" is stale), `TARGET_CHANGELIST` 647472, `WIN64_RELATIVE_DIR`, `EXE_NAME`, `EXE_RELATIVE_PATH`, `PINNED_EXE_SHA256`, `PINNED_EXE_SIZE`, `RUNTIME_FILE_NAMES`/`RUNTIME_RELATIVE_PATHS`, `CONNECT_TIMEOUT_MS` 5000, `STATUS_POLL_MS` 15000, `DISK_MARGIN_BYTES` 1 GiB, `VC_REDIST_URL` (unused) |
| `main/game-folder.ts` | "I already have the game files": `cleanGameFolderInput` (strips quotes; drive-letter only on Windows), `gameRootCandidates` (folder, `folder\Dauntless`, parent of `Archon`, three up from `Win64`), `locateExistingGame` (`ok` / `invalid_path` / `not_found` / `too_long` > `MAX_GAME_ROOT` 150), `findExistingGameRoot` (tests only), `MAX_GAME_INPUT` 260 |
| `main/migrate.ts` | Forever -> Revamped hand-over: `migrateUserData` copies `%APPDATA%\Dauntless Forever 1.14.7 Launcher` into the new userData once (skips Chromium caches and `lockfile`, writes `settings.json` last via `.migrating`, keeps a game in `%LOCALAPPDATA%\DauntlessForever1147\Game` by setting `installDir`); `uninstallOldLauncher` runs `%LOCALAPPDATA%\DauntlessForever1147Launcher\Update.exe --uninstall -s`. `OLD_USER_DATA_NAME`, `OLD_SQUIRREL_NAME` |
| `main/intro.ts` | `isIntroFile` (manifest's `Archon/Content/Movies/Windows/Logo.mp4`, accepted at any size), `applyIntro` copies bundled `intro-Logo.mp4` -> `Logo.mp4` and `login-loop.mp4` -> `LoginLoop.mp4` when sizes differ |
| `main/log.ts` | Redacting logger: `log.info/warn/error`, `logToFile` (`userData/logs/launcher.log`, rotates to `launcher.old.log` past 2 MiB), `redact` (registered secrets, `UUK_*`, `-AUTH_PASSWORD=`, `x-undaunted-user-api-key`), `addSecret`, `removeSecret`, `setSink`, `describeError` |
| `main/system.ts` | `freeBytes(dir)` via `fs.statfs` on the nearest existing parent |
| `main/windows-runtime.ts` | `gameExitDetail(code)`: hex exit code plus advice (0xC0000135 / 0xC000007B = missing DLL) |

## Shared (`src/shared/`)

Imported by both main and renderer; no Node or DOM APIs.

| File | What it does |
|---|---|
| `shared/types.ts` | The IPC contract: `IPC` channel names, `Snapshot`, `Phase`, `ConnectProblem`, `ErrorCode`, `NoticeCode`, `LauncherError`, `ActionResult`, `InviteCheck`, `TaskProgress`, `ServerInfo`, `SavedServerInfo`, `Settings`, `CharacterInfo`, `CHARACTER_LABEL_MAX` 24, `NAME_STYLES` (`wanderer scout slayer legend emerald`), `isNameStyle`, `NewsItem`, `Branding`, `ExternalTarget`, `RegisterOutcome`, `LANGUAGES` (`en fi es`), `GAME_LANGUAGES` |
| `shared/invite.ts` | Invite format `dauntless-revamped://join?v=1&host&port&fp&code&name` (also `dauntless-forever-1147://`). `parseInvite` (max 2048 chars, only known params), `isValidHost` (IPv4 or strict DNS name), `isValidIPv4`, `isValidPort`, `isValidInviteCode` (`[A-Za-z0-9-]{4,64}`), `isValidFingerprint`, `cleanServerName` (64 chars, no control/bidi), `isLoopbackHost`, `formatInvite`, `INVITE_SCHEME`, `LEGACY_INVITE_SCHEME`, `DEFAULT_PORT` 443 |
| `shared/i18n.ts` | All UI strings (`en`, `fi`, `es`; about 470 keys each), `STRINGS`, `StringKey`, `translate` (`{var}` placeholders), `isStringKey`, `systemLanguage(locale)` |
| `shared/status.ts` | `cleanText` (strip control/bidi, cap) and `cleanHttpsUrl`, used widely. The rest (`ServerStatus` types, `parseServerStatus`, `limitedView`, `sortInstances`) is the old Undaunted `/undaunted/api/ServerStatus` contract: no caller fetches it and `Snapshot.status` is always `null`, so the renderer's player/instance panel never shows |
| `shared/ui-model.ts` | Pure UI decisions: `primaryButton` (phase -> big button label/action; a ready launcher update replaces Play), `stepIndex`, `taskView`, `updateReason` (`missing`/`dlls`/`unverified`), `shortFile`, `whereKey`, `kindKey`, `playersKey` |
| `shared/credits.ts` | Credits data: `PROJECT_PEOPLE`, `MYSTIC_PEOPLE`, `REVIVED_PEOPLE`, `UPSTREAM_PEOPLE`, `SOFTWARE`, `localized` |
| `shared/format.ts` | `formatBytes`, `formatSpeed`, `formatDuration`, `formatPercent`, `formatRunningTime`, `formatDate` (per language) |
| `shared/text.ts` | `UNSAFE_CHAR`, `UNSAFE_CHARS`, `UNSAFE_CHARS_MULTILINE` (C0/C1 + bidi controls), `RLO`, `BELL` (test helpers) |
| `shared/username.ts` | `checkUsername` (3-16 `[A-Za-z0-9]`), `isValidUsername`, `isValidPassword` (8-256), limits |

## Renderer (`src/renderer/`, `index.html`)

Sandboxed page, no Node, no network (CSP + `webRequest` filter). Talks only through `window.launcher`.

| File | What it does |
|---|---|
| `launcher/index.html` | Page shell with the CSP meta tag, `data-style="forever"`, title bar, the built-in scene layers (SVG with `emblem-512.png` motif), hero art layers `#art-a/#art-b`, rail, drawer, action bar. Loads `styles.css`, `forever.css`, `index.ts`; logo `brand/logo-revamped.png`, title-bar `emblem-32/64.png` |
| `renderer/index.ts` | The whole UI (about 2200 lines, no framework). Views `play`, `news`, `server`, `settings`, `credits` (drawer over the play screen); modals `invite`, `cert_changed`, `logout`, `leave`, `remove_server`, `character_new`, `character_rename`, `character_delete`. Play-screen builders per phase (`playJoin`, `playConnect`, `playRegister`, `playInstall`, `playInstalling`, `playUpdate`, `playReady`, `playRunning`), `characterPicker`, `nameStylePicker`, server cards (`serverCard`, `addServerCard`), action bar (`renderActionBar`, `renderProgress`, `onPrimary` dispatches `primaryButton` actions), settings page (`renderSettings`, `dropdown`), credits, banners (update/notice/error), streamer mode (`blurred`, `secret`, reveal-with-eye), hero art rotation (`artList` uses host branding or the bundled `brand/bg/shot1-6.jpg`, 14 s interval, `--host-accent`), `loadExtras` (`getNews` + `getBranding`), `onSnapshot`, `initChrome`, `main`. Calls every preload function except `refreshStatus`; polling follows `document.hidden` |
| `renderer/dom.ts` | Safe DOM helpers: `$`, `h` (elements via `createElement`/`textContent`/`setAttribute`), `s` (SVG), `icon`/`IconName`, `githubMark`, `renderRegion`, `forceRender` |
| `renderer/scene.ts` | `buildScene()`: draws the built-in night-mountain SVG background from a fixed Park-Miller seed into the `index.html` layers; animation is CSS-only |
| `renderer/styles.css` | Base stylesheet: the eight `--dr-*` brand tokens (from `brand/palette.json`, contrast-checked by `test/brand.test.ts`), layout, cards, forms, modals, progress bar, scene animation and its reduced-motion/game-running stops |
| `renderer/forever.css` | Loaded after `styles.css`: the current Revamped one-screen theme (hero art, single PLAY, server pill, pages as drawers, gold tokens). Name is historical |
| `renderer/dauntless-style.css` | Dead: a game-menu skin scoped to `:root[data-style="dauntless"]`, but `index.html` neither links it nor sets that attribute. Only user of `brand/dl-button.svg`, `dl-tab.svg`, `dl-nav-active.svg` |
| `renderer/global.d.ts` | Types `window.launcher` as `LauncherApi` |
| `renderer/brand/` | Images bundled into the page: `logo-revamped.png` (top bar), `emblem-32/64/512.png`, `bg/shot1-6.jpg` (built-in hero art), `news-badge.svg`; `logo-inapp*.png` are copied in by `make-icon.mjs` but no page uses them; `dl-*.svg` only by the dead stylesheet |

## Build, scripts, tooling

| File | What it does |
|---|---|
| `launcher/forge.config.ts` | Electron Forge: asar, exe `DauntlessRevampedLauncher`, `extraResource` `assets/icon.png`, `assets/intro-Logo.mp4`, `assets/login-loop.mp4`, `THIRD-PARTY-NOTICES.txt`; `MakerSquirrel` (`DauntlessRevampedLauncher-Setup.exe`, `noMsi`) + `MakerZIP`, win32 only; `VitePlugin` (main, preload, renderer `main_window`); `FusesPlugin` (RunAsNode off, cookie encryption on, NODE_OPTIONS and inspect args off, asar integrity on, only-load-from-asar on). No code-signing config |
| `launcher/vite.main.config.ts` | Main bundle; alias `@game-manifest` -> `data/dauntless-1.14.7.json` |
| `launcher/vite.preload.config.ts` | Preload bundle; empty config |
| `launcher/vite.renderer.config.ts` | Renderer bundle; `assetsInlineLimit: 0` so no `data:` URLs need CSP room |
| `forge.env.d.ts` | Declares `MAIN_WINDOW_VITE_DEV_SERVER_URL`, `MAIN_WINDOW_VITE_NAME` |
| `scripts/collect-release.ps1` | After `npm run make`: copies `out/make/squirrel.windows/x64/*` (Setup.exe, `RELEASES`, `*-full.nupkg`) and the ZIP (renamed `DauntlessRevampedLauncher-<version>-win32-x64.zip`) into `release/`, writes LF `SHA256SUMS.txt`; `-Publish` runs `gh release create v<version> --repo HyjinnxDev/dauntless-revamped-releases` |
| `scripts/run-tests.mjs` | `npm test`: `tsc -p tsconfig.test.json` into `.test-build/`, then `node --test --test-concurrency=1` on `*.test.js` (optional filename filter arg) |
| `scripts/make-game-manifest.mjs` | `node scripts/make-game-manifest.mjs <install dir> <out.json>`: builds the pinned manifest from the install's own `Manifest.bin.json` + `Version.txt`, hashing every listed file |
| `scripts/make-invite.mjs` | `--host --cert <pem> --code --name [--port]`: prints a `dauntless-revamped://join?...` link with `fp` = SHA-256 of the first PEM cert |
| `scripts/make-icon.mjs` | `npm run icon [-- --check]`: byte-copies brand outputs into the app (`assets/icon.ico`, `assets/icon.png`, `src/renderer/brand/logo-inapp*.png`, `emblem-32/64/512.png`) |
| `scripts/live-check.ts` | Manual end-to-end check: `npx tsx scripts/live-check.ts "<invite>" <user> <pass>` registers/signs in, checks runtime + one game file, requests a game session and trades the exchange code through a `Relay` |
| `brand/build.py` | Python/Pillow generator for every derived brand image (web/, icons/, launcher/, og/social) from `logo-full.png` + `emblem.png` + `palette.json`, with contrast checks. Inherited from Dauntless Revived: it also writes `../docs/assets` and `../.github/assets` relative to `launcher/`, which do not exist here |
| `mockup/launcher-mockup.html` | Static HTML design mockup of the one-screen + drawer layout (`forever.css` look) with `mockup/art/*.jpg`; not built or shipped |
| `data/dauntless-1.14.7.json` | Compiled-in game manifest (build, `totalBytes`, files with size + sha256) |
| `assets/` | `icon.ico`, `icon.png`, `intro-Logo.mp4`, `login-loop.mp4` (shipped as extra resources) |
| `brand/revamped/` | Revamped logo/wordmark/favicon source art (README.txt lists them); not wired into `build.py` |
| `.eslintrc.json` | Leftover ESLint config; ESLint and its plugins are not in `devDependencies` and no script runs it |
| `tsconfig.json`, `tsconfig.test.json` | Strict TS, CommonJS; test config emits to `.test-build` |
| `THIRD-PARTY-NOTICES.txt` | License texts shipped as a resource (checked by `credits.test.ts`) |

## Tests (`test/`)

`node:test`, run by `scripts/run-tests.mjs`. Fixed loopback ports in the 62000-62421 range.

| File | Covers |
|---|---|
| `test/fakes.ts` | Fake Mystic Paradox backend (`/launcher/v1/*`) and content server (`/content/v1/*`) on 127.0.0.1 |
| `test/certs.ts` | Throwaway self-signed certs (node-forge) in a temp dir |
| `test/controller.test.ts` | Full Controller flow: invite -> status -> register -> install -> runtime -> Play, cert change, saved servers |
| `test/downloader.test.ts`, `test/cdn-download.test.ts` | Resume, retries, Range, ETag, CDN path without credentials |
| `test/pinned.test.ts`, `test/relay.test.ts` | Pin enforcement on every call; relay forwarding, upgrades, browser/DNS-rebinding refusal |
| `test/manifest.test.ts`, `test/game-folder.test.ts` | Manifest validation/safe paths; existing-game layouts and refused paths |
| `test/keystore.test.ts`, `test/migrate.test.ts` | Fingerprint-bound sessions; Forever data carry-over |
| `test/invite.test.ts`, `test/links.test.ts` | Invite parsing; link allow-list |
| `test/launch-settings.test.ts`, `test/windows-runtime.test.ts` | Launch args, locale, Engine.ini rewrite; exit-code text |
| `test/ui.test.ts`, `test/username-status.test.ts` | i18n completeness, `primaryButton`, formatting, real manifest; username/status parsing |
| `test/brand.test.ts`, `test/credits.test.ts` | Palette tokens and contrast in CSS; credits and shipped notices |

## IPC channels

All renderer -> main channels are `ipcMain.handle` in `src/main.ts` (`registerIpc`), guarded by `trusted()`; all callers are `renderer/index.ts` via `src/preload.ts`. A thrown handler returns `{ ok: false, error: { code: "unknown" } }`.

| Channel | Preload fn (payload) | Main handler -> controller | Purpose |
|---|---|---|---|
| `dr:get-snapshot` | `getSnapshot()` | `snapshot` | Current state |
| `dr:check-invite` | `checkInvite(text)` (<=2048) | `checkInvite` | Parse invite, report a cert change before joining |
| `dr:submit-invite` | `submitInvite(text, acceptNewCertificate)` | `submitInvite` | Join from invite (optionally rebind sign-in to new cert) |
| `dr:retry-connect` | `retryConnect()` | `connect` | Re-check the server |
| `dr:forget-server` | `forgetServer()` | `forgetServer` | Leave current server |
| `dr:switch-server` | `switchServer(id)` (24 hex) | `switchServer` | Join a saved server |
| `dr:remove-saved-server` | `removeSavedServer(id)` (24 hex) | `removeSavedServer` | Drop a saved server (not the current one) |
| `dr:add-server` | `addServer(invite)` | `addServer` | Add to list without joining (not length-bounded in main; `parseInvite` caps at 2048) |
| `dr:register` | `register(username<=32, password<=256)` | `register` | Create account (sends stored invite code) |
| `dr:sign-in` | `signIn(identifier<=254, password<=256)` | `signIn` | Sign in by username or email |
| `dr:logout` | `logout()` | `logout` | Sign out, delete session file |
| `dr:select-character` | `selectCharacter(slot)` | `selectCharacter` | Pick the slot Play starts |
| `dr:create-character` | `createCharacter(label<=24)` | `createCharacter` | New character |
| `dr:rename-character` | `renameCharacter(slot, label<=24)` | `renameCharacter` | Rename |
| `dr:set-character-name-style` | `setCharacterNameStyle(slot, style|null)` | `setCharacterNameStyle` | Patreon name plate |
| `dr:delete-character` | `deleteCharacter(slot, confirmLabel<=24)` | `deleteCharacter` | Delete (label must match) |
| `dr:choose-install-dir` | `chooseInstallDir()` | `chooseInstallDir` | Folder dialog for install dir |
| `dr:use-existing-game-folder` | `useExistingGameFolder()` | `useExistingGameFolder` | Folder dialog for an existing game, then repair |
| `dr:use-existing-game-path` | `useExistingGamePath(path<=260)` | `useExistingGamePath` | Pasted path for an existing game, then repair |
| `dr:start-install` | `startInstall()` | `startInstall` | Verify + download + runtime |
| `dr:pause-task` / `dr:resume-task` / `dr:cancel-task` | `pauseTask()` / `resumeTask()` / `cancelTask()` | same names | Control the running task |
| `dr:repair` | `repair()` | `repair` | Full-hash verify + fetch differences |
| `dr:open-game-folder` | `openGameFolder()` | `openGameFolder` | Explorer on install dir |
| `dr:play` | `play()` | `play` | Launch the game |
| `dr:close-stray-games` | `closeStrayGames()` | `closeStrayGames` | Kill Dauntless clients the launcher did not start |
| `dr:set-settings` | `setSettings({windowed, streamerMode, language, gameLanguage})` | `settingsPatch` -> `setSettings` | Change settings |
| `dr:set-status-polling` | `setStatusPolling(on)` | `setStatusPolling` | Start/stop the 15 s poll (page visibility) |
| `dr:refresh-status` | `refreshStatus()` | `refreshStatus` | One poll now; exposed but no renderer caller |
| `dr:get-news` | `getNews()` | `getNews` | Cached news items |
| `dr:get-branding` | `getBranding()` | `getBranding` | Cached host backgrounds/accent |
| `dr:open-external` | `openExternal(target)` | `externalTarget` -> `openExternal` | Open a fixed link by name |
| `dr:install-update` | `installUpdate()` | `installUpdate` | `quitAndInstall` when an update is ready |
| `dr:dismiss-notice` / `dr:dismiss-error` | `dismissNotice()` / `dismissError()` | same names | Clear banner |
| `dr:take-invite-link` | `takeInviteLink()` | main.ts `pendingInviteLink` | Fetch-and-clear the link from argv/protocol |
| `dr:window-minimize` / `dr:window-maximize` / `dr:window-close` | `minimize()` / `toggleMaximize()` / `close()` | `BrowserWindow` directly | Frameless window controls |

Main -> renderer events (`webContents.send`): `dr:snapshot` (`Snapshot`, on every `publish`), `dr:progress` (`TaskProgress`), `dr:invite-link` (no payload; page then calls `takeInviteLink`), `dr:window-state` (maximized boolean).

## Backend endpoints called

All over pinned TLS to the invite host:port, from `main/hostapi.ts` (helper) and the named controller method. Backend owners: `routes/launcherAuth.ts`, `routes/launcherCard.ts`, `routes/launcherUpdates.ts`, `routes/content.ts`, `routes/news.ts` in `versions/1.14.7/ParadoxBackend/src` (see [Backend](backend.md)).

| Method path | hostapi function | Caller | Notes |
|---|---|---|---|
| `GET /launcher/v1/status` | `fetchServerStatus` | `connect`, `pollStatus` | Needs `supportedBuildChangelist` 647472 and `online: true` |
| `GET /launcher/v1/info` | `fetchServerCard` | `checkCards` | Title/MOTD/logo/players; 404 = empty card |
| `GET /launcher/v1/info/logo?v=<16 hex>` | `fetchBrandingImage` | `checkCards` | Server-card logo |
| TCP connect to host:port | `tcpPing` | `checkCards` | Ping ms, no bytes sent |
| `POST /launcher/v1/auth/register` | `registerAccount` | `register` | `{displayName, password, inviteCode?, deviceId, deviceName}`; 202 = approval pending |
| `POST /launcher/v1/auth/login` | `login` | `signIn` | Identifier sent as `email` |
| `POST /launcher/v1/auth/refresh` | `refreshSession` | `refresh` | Rotating refresh token |
| `POST /launcher/v1/auth/logout` | `logout` | `logout` | Bearer |
| `GET/POST /launcher/v1/characters` | `listCharacters` / `createCharacter` | `loadCharacters` / `createCharacter` | Bearer; answer is the full list |
| `PATCH/DELETE /launcher/v1/characters/:slot` | `renameCharacter` / `deleteCharacter` | same | `{label}` / `{confirmLabel}` |
| `PATCH /launcher/v1/characters/:slot/name-style` | `setCharacterNameStyle` | same | `{style}` |
| `POST /launcher/v1/game-sessions` | `requestGameSession` | `play` | `{buildChangelist, executableSha256, runtimeChannel:"stable", runtimeManifestVersion, runtimeArtifacts, characterSlot}` -> `exchangeCode`, `gameUserId?`, `voiceTicket?`, `voicePort?` |
| `GET /launcher/v1/runtime/client/stable/windows-x86_64` | `fetchRuntimeRelease` | `runtimeOk`, `ensureRuntime` | Release JSON (`version`, `targetChangelist`, `sha256`, `extraFiles`) |
| `GET .../windows-x86_64/download` | `downloadRuntimeFile` | `installRuntime` | `MysticParadox.dll` |
| `GET .../windows-x86_64/extra/winmm.dll` | `downloadRuntimeFile` | `installRuntime` | Loader DLL |
| `HEAD /content/v1/manifest` | `probeContent` | `connect`, `runTask` | Is game download on |
| `GET /content/v1/manifest` | `fetchContentManifest` | `runTask` | Must equal compiled manifest; may carry `downloadBaseUrl` |
| `GET /content/v1/files/<path>` | `DownloadJob` (`main/downloader.ts`) | `runTask` | Bearer, Range; or the CDN `downloadBaseUrl` + path without auth |
| `GET /content/v1/news` | `fetchNews` | `refreshNews` | Up to 30 items |
| `GET /content/v1/news/image/<5-25 digits>` | `fetchBrandingImage` | `newsImage` | News picture |
| `GET /content/v1/branding` (+ `/content/v1/branding/<file>`) | `fetchBrandingIndex` / `fetchBrandingImage` | `loadExtras` | The 1.14.7 backend has no such route: always 404, so host backgrounds are never set and the bundled shots show |

Outside the invite host: the auto-update feed `UPDATE_FEED_URL` (Squirrel `RELEASES`/`.nupkg` via `update-electron-app`) and, when advertised, the CDN.

## What the launcher writes on the player's PC

| Location | Written by | Content |
|---|---|---|
| `%APPDATA%\Dauntless Revamped Launcher\settings.json` | `main/settings.ts` | Settings (keys below) |
| `...\sessions\<serverId>.session` | `main/keystore.ts` | DPAPI-encrypted refresh token + fingerprint |
| `...\verified-files.json` | `main/verify.ts` `VerifiedCache` | Hashed-file size/mtime cache |
| `...\art-cache\<sha256>` | `main/controller.ts` `keepArt` | News pictures, server logos, branding images |
| `...\logs\launcher.log`, `launcher.old.log` | `main/log.ts` | Redacted log, 2 MiB rotation |
| (whole folder, once) | `main/migrate.ts` | Copy of the Forever launcher's userData |
| `<install>\...` game files, `<file>.part` | `main/downloader.ts` | Game files from the manifest only |
| `<install>\Archon\Binaries\Win64\MysticParadox.dll`, `winmm.dll` (+ `.new`, removes `:Zone.Identifier`) | `main/runtime.ts` | Server runtime |
| `<install>\Archon\Content\Movies\Windows\Logo.mp4`, `LoginLoop.mp4` | `main/intro.ts` | Bundled intro and login loop |
| `%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient\Engine.ini` | `main/launch.ts` `pointXmppAtRelay` | `[OnlineSubsystemMcp.XMPP]` -> `ws://127.0.0.1:<relay port>` |
| Default install dir `%LOCALAPPDATA%\DauntlessRevamped\Game` | `src/main.ts` `makePlatform` | Used when `installDir` is null |
| Registry protocol handlers `dauntless-revamped`, `dauntless-forever-1147` | `src/main.ts` `registerProtocolClient` | Packaged builds only |

## Settings keys (`settings.json`, `StoredSettings`)

| Key | Meaning |
|---|---|
| `version` | Always 1 |
| `deviceId` | Random UUID sent with sign-ins |
| `server` | Current `StoredServer` `{host, port, name, fp, code}` (`code` = unused invite code, cleared after sign-in) |
| `savedServers` | Up to 20 `StoredServer` entries, current one always included |
| `installDir` | Chosen game folder (drive-letter, 4-199 chars) or null = default |
| `verifiedDir` | Folder last fully verified/downloaded; mismatch with `installDir` = phase `update` |
| `windowed` | Adds `-windowed -ResX=1280 -ResY=720` |
| `streamerMode` | Hide hosts, fingerprints, paths, names in UI |
| `language` | UI language `en`/`fi`/`es` |
| `gameLanguage` | `-epiclocale`; `auto` follows OS |
| `usernames` | Server id -> last username (display only) |

See also: [launcher](launcher.md), [launcher-bridge](launcher-bridge.md), [backend](backend.md), [paradox-launcher](paradox-launcher.md).
