# ParadoxLauncher files

> Verified against code 2026-10-24.

File-by-file reference for `versions/1.14.7/ParadoxLauncher`. The narrative (publish pipeline, consumers, gotchas) is on [ParadoxLauncher](paradox-launcher.md). Only `scripts/` is in active use. The Tauri app is not shipped to players.

## Root and config

| File | What it does |
|---|---|
| `ParadoxLauncher/package.json` | npm package `mystic-paradox-launcher` 0.1.53. Scripts `dev`, `build`, `preview`, `tauri`, `test:workflow`, `test:publish`, `release:launcher`, `publish:launcher`. Deps: React 19, `@tauri-apps/api` + plugins opener/process/updater/window-state, Fontsource Cinzel/Inter. |
| `ParadoxLauncher/index.html` | Vite entry page. `#root` plus `/src/main.tsx`. |
| `ParadoxLauncher/vite.config.ts` | Port 1420 (strict), HMR on 1421 when `TAURI_DEV_HOST` is set, ignores `src-tauri`. |
| `ParadoxLauncher/tsconfig.json`, `tsconfig.node.json` | TS compiler settings for `src/` and for the Vite config. |
| `ParadoxLauncher/.env.example` | `VITE_API_BASE_URL=http://127.0.0.1:3000`. |
| `ParadoxLauncher/README.md` | Build, self-host and security notes. |
| `ParadoxLauncher/UPDATE_CHANNEL.md` | Maintainer notes: signing material, backend env, publish steps, rotation order. |
| `ParadoxLauncher/.secrets/` | Gitignored. Holds `selfhost-runtime-update.private.pem`/`.public.pem`/`.public.raw.b64`. Never open. |

## scripts/

| File | What it does |
|---|---|
| `scripts/publish-runtime-update.mjs` | Signs a runtime DLL and its extras (Ed25519), writes `runtime/<target>/<channel>/windows-x86_64/<version>/` and `latest.json`. Flags and format: [ParadoxLauncher](paradox-launcher.md#runtime-publish-pipeline). |
| `scripts/generate-runtime-key.mjs` | `node scripts/generate-runtime-key.mjs [outPrefix]` (default `../.secrets/mystic-runtime-update`). Writes `<out>.private.pem` (PKCS#8, mode 600), `<out>.public.pem` (SPKI), `<out>.public.raw.b64` (last 32 bytes of the SPKI DER). Called by `scripts/configure-selfhost.ps1`. |
| `scripts/build-launcher-release.ps1` | `npm run release:launcher`. Loads the Tauri updater key and password from `.secrets`, runs `tauri build --bundles nsis`, then runs the missing `extract-nsis-launcher-payload.mjs` to unpack the installed `launcher.exe`. Logs whether the p2p/anticheat modules are present. |
| `scripts/publish-launcher-update.ps1` | `npm run publish:launcher`. Optionally builds, then copies the NSIS setup exe into `launcher\windows\x86_64\<version>\` and writes the Tauri updater `latest.json`. |
| `scripts/publish-runtime-update.test.mjs` | `npm run test:publish` (`node:test`). Runs the real publish script in a temp folder with throwaway Ed25519 keys: every file verifies against the signing key, same key + file gives the same signature, an existing version is refused (`--force` overrides), a new `--key`/`--base-url` applies to unchanged files. |
| `scripts/launch-workflow.test.cjs` | `npm run test:workflow` (`node:test` + jsdom). Transpiles the real `HomeTab.tsx`/`sessions.ts` with mocked IPC. Covers single-flight Play, the policy-outage refusal, Locate/Repair using the account channel, the `game-exited` event, build-mismatch callout, exit-code labels, policy coalescing, and late restore or Discord completion not signing back in. |

## src-tauri/ (Rust shell)

| File | What it does |
|---|---|
| `src-tauri/Cargo.toml` | Crate `launcher` 0.1.53, lib `launcher_lib`. Deps: tauri 2 + plugins (opener, deep-link, dialog, single-instance, window-state, process, updater), reqwest (rustls, blocking), ed25519-dalek, sha2, keyring, windows-sys, tokio, time, zeroize, dunce. |
| `src-tauri/build.rs` | Sets `cfg(mystic_p2p)` if `src/p2p/mod.rs` exists and `cfg(mystic_anticheat)` if `src/anticheat/mod.rs` also exists, then `tauri_build::build()`. |
| `src-tauri/tauri.conf.json` | Product "Mystic Paradox Launcher", id `dev.mysticfox.launcher`, frameless 1120x700 window, CSP (upstream origins only), deep-link scheme `mysticparadox`, updater pubkey and endpoint, NSIS per-user install. |
| `capabilities/default.json` | Main-window permissions: core, window minimize/toggle-maximize/close/drag, webview zoom, opener, dialog, deep-link, updater, process. |
| `src/main.rs` | Binary entry. Hides the console in release and calls `launcher_lib::run()`. |
| `src/lib.rs` | `run()`: registers plugins, the `launcher_commands!` handler list (21 commands, plus `p2p::native_get_p2p_host_settings` in P2P builds), setup (deep links, `start_runtime_prefetch`, `guard_loop::start`, `p2p::start`) and `launch::shutdown_all` on exit. |

### src-tauri/src/auth/

| File | What it does |
|---|---|
| `auth/mod.rs` | Declares `deep_link`, `secure_store`, `session_epoch`. |
| `auth/deep_link.rs` | `listen`, `check_startup_url`, `handle_url`. Parses `mysticparadox://auth/complete?code=` and emits `discord-auth-complete`, or `mysticparadox://auth/error?code=` and emits `discord-auth-error`. |
| `auth/secure_store.rs` | `save`/`load`/`clear` the refresh token. Credential Manager entry `dev.mysticfox.launcher`/`refresh-token`, with fallback `session.dpapi` (CryptProtectData, current user) in the app config dir. |
| `auth/session_epoch.rs` | Account-transition counter. `lock`, `current`, `check` fence in-flight Play and refresh work when the user signs out or switches account. |

### src-tauri/src/commands/

| File | What it does |
|---|---|
| `commands/mod.rs` | Declares `auth`, `install`, `launch`, `logs`, `updates`. |
| `commands/auth.rs` | `api_base_url`, a shared `http_client`, access-token cache (`current_access_token`, `send_authorized`, `invalidate_access_token`), serialised `refresh_native_session`. Commands: `native_restore_session`, `native_get_server_status` (`GET /launcher/v1/status`), `native_login`, `native_register`, `native_start_discord_login` (opens only `https://discord.com` URLs), `native_discord_complete`, `native_set_username` (`POST /launcher/v1/username`), `native_get_policy`, `native_refresh_account` (`GET /launcher/v1/me`), `native_logout` (local first, then background refresh + `/auth/logout`), `native_forget_session`. Sign-out also stops protected processes (`revoke_local_guard_state`). |
| `commands/install.rs` | `get_install_status` (saved exe, runtime presence, cached exe hash, `targetChangelist`) and `pick_install_path` (folder dialog -> `paths::find_game_executable` -> save). |
| `commands/launch.rs` | `is_game_running` and `secure_launch(expected_channel)`, the Play pipeline (runtime repair, hashes, policy re-check, `/status`, `POST /launcher/v1/game-sessions`, `process::spawn_game`). |
| `commands/logs.rs` | `native_get_log_paths`, `native_open_log_folder`, `native_recent_sessions(accountId, limit)` (reads each session's `metadata.json`, own account only), `native_upload_last_session` (PUTs `metadata.json`, `launcher.log`, `runtime-*.log` to `/launcher/v1/logs/sessions/<id>/<name>`). |
| `commands/updates.rs` | Runtime feed client. `check_runtime_update`, `install_runtime_update` (commands), `start_runtime_prefetch`, `runtime_install_lock`, `verify_manifest`, `install_extra_file`, `is_approved_runtime_url_for`. Constants `TARGET_CHANGELIST` 647472, `DEFAULT_RUNTIME_ENDPOINT`, `DEFAULT_RUNTIME_UPDATE_PUBLIC_KEY_B64`. |

### src-tauri/src/install/

| File | What it does |
|---|---|
| `install/mod.rs` | Declares `paths`, `verify`. |
| `install/paths.rs` | `install.json` in the app config dir (`load_saved_exe_path`, `save_exe_path`). `find_game_executable` accepts the folder itself, `Binaries\Win64\`, or `Archon\Binaries\Win64\`. `canonicalize_game_exe` requires the name `Dauntless-Win64-Shipping.exe`. `game_dir`. |
| `install/verify.rs` | `CORE_RUNTIME_ARTIFACT_NAMES` (`MysticParadox.dll`, `winmm.dll`), `required_runtime_artifact_names`, `hash_file_sha256` (always from disk, refuses reparse points) and `hash_file_sha256_cached` (keyed on file identity, for periodic checks), `verify_runtime_dlls_present`. |

### src-tauri/src/launch/

| File | What it does |
|---|---|
| `launch/mod.rs` | Module root. `is_shutting_down`, `shutdown_all` (refuse new work, drain supervisors for 7 s, kill the Job Object, drain again for 3 s, stop Guard). Each stage goes to the exit log. |
| `launch/process.rs` | Game process control. `spawn_game` (suspended, Explorer parent, Job Object, private env, auth and `-epic*` args, exit watcher that copies runtime logs, updates metadata and emits `game-exited`), `is_game_running`, `is_dauntless_process_running` (client or `-server`), `game_process_id`, active-session log helpers. |
| `launch/supervisor.rs` | One kill-on-close Job Object for the launcher's lifetime. `assign_process_handle`, `terminate_all(exit_code)`, `resume_initial_thread`. |
| `launch/logs.rs` | Session logs under `%LOCALAPPDATA%\MysticParadox\Logs\Sessions\<id>\`: `generate_launch_session_id`, `session_dir`, `append_launcher_log` (`launcher.log`), `write_metadata`, `copy_runtime_logs_best_effort` (copies `mysticparadox_dll_port*.log` from the game folder), `latest_session_dir`, `append_shutdown_log` (`Logs\launcher-exit.log`), RFC 3339 helpers. |
| `launch/flags.rs` | `reconcile(game_dir, managed_feature_ids)`. Maps policy feature `diagnostics.verbose` to `VERBOSE_DIAG.flag`. Deletes only flags it created, tracked in `.mysticparadox-managed-flags.json`. |
| `launch/guard.rs` | Guard client. Verifies the signed Guard manifest (key id `runtime-2026-01`, hardcoded upstream key, anti-rollback floor in `guard-rollback.json`), checks artifact bindings and process identity, collects signals (modules, debugger flag; heavy checks only with the anti-cheat module), and signs heartbeats to `/launcher/v1/guard/sessions` and `/launcher/v1/guard/heartbeat`. `installed_artifacts_by_role` serves the P2P module. |
| `launch/guard_loop.rs` | Background loop: one heartbeat per protected process (`client`, `host`) every 20 s, failure back-off up to 300 s. Stores verdicts (`latest_verdict`). `start`, `stop`, `clear`. Observe-only. |

## src/ (React UI)

| File | What it does |
|---|---|
| `src/main.tsx` | Boot: loads `dev/browserPreview` in dev without Tauri, applies the saved UI scale, installs pointer FX, renders `App`. |
| `src/App.tsx` | Providers (Auth, Policy, Services) and `AppShell`. Picks the screen from auth status (`checking`, `restoreFailed`, `signedOut`, `awaitingDiscord`, `awaitingUsername`, `pendingApproval`, `signedIn`). Launcher self-update check at start and every 30 min, shown as an update toast. |
| `src/index.css` | Imports the seven `styles/*.css` layers in order. |

### api/, auth/, policy/, services/

| File | What it does |
|---|---|
| `api/client.ts` | `fetch` wrapper on `VITE_API_BASE_URL` (fallback dev `127.0.0.1:3000`, else upstream). `LauncherApiError`. `launcherApi.checkUsername` (`GET /launcher/v1/username?name=`) and `launcherApi.status`. |
| `api/tauri.ts` | Typed `invoke` wrappers: `getInstallStatus`, `pickInstallPath`, `isGameRunning`, `onGameExited`, `secureLaunch`, `checkRuntimeUpdate`, `installRuntimeUpdate`, `getPolicy`, `getServerStatus`, `getLogPaths`, `openLogFolder`, `uploadLastSession`, `getRecentSessions`. |
| `api/types.ts` | Shared types: `LauncherErrorCode`, `LauncherAccount`, `UsernameAvailabilityResponse`, `ServerStatusResponse`, `LauncherPolicy`, `LogPaths`. |
| `api/updates.ts` | `checkLauncherUpdate` (Tauri updater, 15 s timeout) and `installLauncherUpdate` (lets the passive NSIS installer restart the app on Windows, relaunches elsewhere). |
| `auth/AuthContext.tsx` | `AuthProvider`/`useAuth`. Session restore, `login`, `register`, `setUsername`, `logout`, Discord start/complete (listens for the deep-link events), account refresh every 120 s, `describeAuthError`, `isLauncherApiError`. Guards against late responses after sign-out. |
| `policy/PolicyContext.tsx` | `PolicyProvider`/`usePolicy`. Fetches `native_get_policy` per signed-in account. `refreshPolicy` coalesces calls and drops stale-account responses. |
| `services/ServicesContext.tsx` | `ServicesProvider`/`useServices`. Polls `getServerStatus` every 45 s while visible. Health `online`/`degraded`/`unreachable` plus `supportedChangelist`. |

### lib/, dev/

| File | What it does |
|---|---|
| `lib/deviceId.ts` | `getDeviceId`: persistent random UUID in localStorage (`mysticparadox.deviceId`). Not a secret. |
| `lib/platform.ts` | `isTauri`, `prefersReducedMotion`, `withViewTransition`. |
| `lib/pointerFx.ts` | `installPointerFx`: one rAF-throttled pointer listener that sets CSS vars on `.glow` and `.parallax` elements. |
| `lib/prefs.ts` | UI prefs in localStorage `mysticparadox.ui.v1`: sidebar mode, motion, scale (0.85/0.92/1 as WebView zoom). `applyUiScale`, `setUiPrefs`, `useUiPrefs`, `useMediaQuery`. |
| `lib/sanitize.ts` | `sanitizeError`: strips URLs, paths, OS error noise from native error strings before display. |
| `lib/sessions.ts` | Pure helpers: `describeExit` (labels launcher exit codes), `formatDuration`, `formatWhen`, `formatClock`, `buildName`, `shortHash`. |
| `dev/browserPreview.ts` | Dev only. `mockIPC`/`mockWindows` with sample data so `npm run dev` renders in a browser. URL switches `?screen=`, `?running`, `?repair`, `?nolocate`, `?sessions=0`, `?channel=beta`, `?offline`. |

### components/

| File | What it does |
|---|---|
| `components/AetherMark.tsx` | Brand sigil SVG. |
| `components/ArtBackdrop.tsx` | Hero art background (`assets/home-shattered-isles.webp`) with fixed floating motes. Exports `heroArt`. |
| `components/AuthLayout.tsx` | `AuthLayout` and `AuthCard` frame for the sign-in screens. |
| `components/Banner.tsx` | Tone-coloured message banner. |
| `components/Button.tsx` | Button with variants `primary`/`secondary`/`ghost`/`danger`/`discord` and a `loading` state. |
| `components/TextField.tsx` | Labelled input with error and hint. |
| `components/UsernameField.tsx` | Username input with a debounced availability check (`launcherApi.checkUsername`). |
| `components/TitleBar.tsx` | Custom title bar for the frameless window: drag region, minimize, maximize/restore, close. |
| `components/icons.tsx` | Inline SVG icon components (nav, status, window controls, Discord). |

### screens/

| File | What it does |
|---|---|
| `screens/LoginScreen.tsx` | Email and password sign-in, plus Discord sign-in. |
| `screens/RegisterScreen.tsx` | Account creation (display name, email, password). |
| `screens/SetUsernameScreen.tsx` | Picks a username for accounts that need one. Can sign out. |
| `screens/DashboardShell.tsx` | Signed-in frame: title bar, sidebar (auto/expanded/compact) and tabs `home`, `library`, `account`, `settings`, `about`. |
| `dashboard/HomeTab.tsx` | Play panel (fresh policy -> `secureLaunch`, single-flight), Locate and Repair, running-game state via `game-exited`, cards for build match, runtime version and recent sessions. |
| `dashboard/LibraryTab.tsx` | Install path, runtime update check and Repair for the account's channel, Locate. |
| `dashboard/AccountTab.tsx` | Account details, manual refresh, sign out. |
| `dashboard/SettingsTab.tsx` | Interface size, sidebar mode, reduced motion. Log folder: copy path, open, upload the last session. |
| `dashboard/AboutTab.tsx` | Links to the upstream source, the AGPL-3.0 licence and Undaunted. |

### styles/

| File | What it does |
|---|---|
| `styles/tokens.css` | Design tokens (dark only). |
| `styles/base.css` | Reset, typography, shared motion. |
| `styles/components.css` | Reusable surfaces and controls (glass, buttons, fields). |
| `styles/shell.css` | Title bar, sidebar, scrolling main area. |
| `styles/home.css` | Home: hero art, launch panel, status cards, session history. |
| `styles/pages.css` | Library, Settings, Account, About. |
| `styles/auth.css` | Sign-in, register, username and status screens. |
