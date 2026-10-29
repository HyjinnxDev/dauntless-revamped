# Launcher bridge (legacy Forever launcher)

> Verified against code 2026-10-24.

## What it is

`launcher-bridge/` is the **last Dauntless Forever 1.14.7 launcher release** (`package.json`: name `dauntless-forever`, productName `Dauntless Forever`, version `0.1.18`). It is the final update existing Forever installs self-update to: on start (Squirrel install only) it launches Dauntless Revamped, downloading and running the Revamped installer first if needed, and quits. Revamped then copies the Forever userData (`launcher/src/main/migrate.ts`) and uninstalls Forever. Otherwise it is a full copy of an older state of [launcher](launcher.md) and still builds and runs as a launcher. Legacy: new work goes in `launcher/`.

## How it differs from `launcher/`

Method: `git diff --no-index --ignore-cr-at-eol launcher/src launcher-bridge/src` and `diff -rq --strip-trailing-cr` on the rest. Many files differ only in CRLF line endings; those count as identical below.

### Behaviour

| Area | `launcher-bridge` (Forever 0.1.18) | `launcher` (Revamped 0.2.8) |
|---|---|---|
| Startup | `src/main.ts` `handOverToRevamped()` when packaged and `Update.exe` is one folder up: if `%LOCALAPPDATA%\DauntlessRevampedLauncher\DauntlessRevampedLauncher.exe` exists, spawn it detached (forwarding an invite from argv); else show an info dialog, `net.fetch` `REVAMPED_SETUP_URL` (`.../dauntless-revamped-releases/releases/latest/download/DauntlessRevampedLauncher-Setup.exe`) to `%TEMP%`, spawn it. On success `app.exit(0)` before any window. On failure it logs and runs as a normal launcher | `migrateUserData()` before ready, `uninstallOldLauncher()` after ready |
| Identity | `APP_ID` `io.github.hyjinnxdev.dauntlessforever1147`, `SQUIRREL_NAME` `DauntlessForever1147Launcher`, userData `%APPDATA%\Dauntless Forever 1.14.7 Launcher`, window title "Dauntless Forever Launcher" | Revamped names (see [launcher-files](launcher-files.md)) |
| Invite scheme | Only `dauntless-forever-1147://` (`INVITE_SCHEME`; no `LEGACY_INVITE_SCHEME`) | `dauntless-revamped://` plus the Forever scheme |
| Characters | None: no `CharacterInfo`/`NAME_STYLES` types, no `dr:*-character*` IPC channels or preload calls, no `/launcher/v1/characters*` calls, no `CHARACTER_*` error codes, no `characterSlot`/`gameUserId` in `requestGameSession`; the game logs in as the account `userId` | Multi-character accounts with name styles |
| Tailscale | `main/system.ts` `tailscaleCandidates`/`findTailscale`; `shared/invite.ts` `isTailscaleIPv4` (100.64.0.0/10), `isTailnetHost` (`*.ts.net`); `ConnectProblem` `tailscale_missing`, `ServerInfo.tailnet`, `Snapshot.connect.tailscaleInstalled`, `Platform.findTailscale`; link target `tailscale_download` (`TAILSCALE_DOWNLOAD_URL`), and `links.ts` `isAllowedStaticUrl` allows **any** `tailscale.com` URL | Removed |
| HTTP methods | `main/http.ts` `GET/POST/HEAD` | adds `PATCH/DELETE` |
| Intro | `main/intro.ts` copies only `Logo.mp4`; no `assets/login-loop.mp4` and not in `extraResource` | Also `LoginLoop.mp4` |
| Update feed | `UPDATE_FEED_URL` `.../dauntless-forever-1147-releases/releases/latest/download` | `.../dauntless-revamped-releases/...` |
| Relay port env | `DAUNTLESS_FOREVER_RELAY_PORT` | `DAUNTLESS_REVAMPED_RELAY_PORT` |
| Default game folder | `%LOCALAPPDATA%\DauntlessForever1147\Game` | `%LOCALAPPDATA%\DauntlessRevamped\Game` |
| Discord link | Same URL (`https://discord.gg/HpgNEmVbBb`) with a stale `TODO(owner)` saying it is the Revived invite | Same URL, no TODO |
| UI | `launcher-bridge/index.html` uses `brand/logo-forever.png` and "Dauntless Forever" title; `renderer/index.ts` has the Tailscale connect guide, no character picker; `i18n.ts`, `styles.css`, `forever.css`, `credits.ts` carry Forever strings | Revamped branding, character UI |
| Release | `scripts/collect-release.ps1` publishes `DauntlessForever1147Launcher-*` to `HyjinnxDev/dauntless-forever-1147-releases`; `scripts/make-invite.mjs` prints `dauntless-forever-1147://` | Revamped repo and scheme |

Security model (sandbox, CSP, pinned TLS, relay checks, fuses) is the same code as `launcher/`; see [launcher](launcher.md). Bridge-only risk: `handOverToRevamped` executes a downloaded installer with no hash or signature check (trusts GitHub + TLS).

### File list

"Same" = identical to the `launcher/` file of the same path (ignoring line endings); its description is in [launcher-files](launcher-files.md).

| File | Status |
|---|---|
| `launcher-bridge/src/main.ts` | Differs: hand-over, Forever identity, no migrate, no character IPC, `findTailscale` in `makePlatform` |
| `launcher-bridge/src/preload.ts` | Differs: no character calls |
| `launcher-bridge/src/main/controller.ts` | Differs: no character code, Tailscale connect problem, `Account` without characters |
| `launcher-bridge/src/main/hostapi.ts` | Differs: no character calls or `CHARACTER_*` codes; `requestGameSession` without `characterSlot`/`gameUserId` |
| `launcher-bridge/src/main/constants.ts` | Differs: Forever ids, feed, `TAILSCALE_DOWNLOAD_URL` |
| `launcher-bridge/src/main/http.ts` | Differs: methods |
| `launcher-bridge/src/main/intro.ts` | Differs: Logo.mp4 only |
| `launcher-bridge/src/main/ipc-validate.ts` | Differs: `tailscale_download` target |
| `launcher-bridge/src/main/links.ts` | Differs: Tailscale link, TODO comment |
| `launcher-bridge/src/main/system.ts` | Differs: Tailscale detection plus `freeBytes` |
| `launcher-bridge/src/shared/types.ts` | Differs: Tailscale fields, no character types/channels |
| `launcher-bridge/src/shared/invite.ts` | Differs: single scheme, Tailscale helpers |
| `launcher-bridge/src/shared/i18n.ts` | Differs: Forever and Tailscale strings, no character strings |
| `launcher-bridge/src/shared/credits.ts` | Differs: one comment |
| `launcher-bridge/src/renderer/index.ts` | Differs: see UI row |
| `launcher-bridge/src/renderer/styles.css`, `launcher-bridge/src/renderer/forever.css` | Differ: Forever look, no character styles |
| `launcher-bridge/src/main/downloader.ts`, `launcher-bridge/src/main/verify.ts`, `launcher-bridge/src/main/manifest.ts`, `launcher-bridge/src/main/game-manifest.ts`, `launcher-bridge/src/main/pinned.ts`, `launcher-bridge/src/main/relay.ts`, `launcher-bridge/src/main/runtime.ts`, `launcher-bridge/src/main/launch.ts`, `launcher-bridge/src/main/keystore.ts`, `launcher-bridge/src/main/settings.ts`, `launcher-bridge/src/main/game-folder.ts`, `launcher-bridge/src/main/log.ts`, `launcher-bridge/src/main/windows-runtime.ts` | Same |
| `launcher-bridge/src/shared/status.ts`, `launcher-bridge/src/shared/ui-model.ts`, `launcher-bridge/src/shared/format.ts`, `launcher-bridge/src/shared/text.ts`, `launcher-bridge/src/shared/username.ts` | Same |
| `launcher-bridge/src/renderer/dom.ts`, `launcher-bridge/src/renderer/scene.ts`, `launcher-bridge/src/renderer/dauntless-style.css` (dead here too), `launcher-bridge/src/renderer/manifest.ts` (empty), `launcher-bridge/src/renderer/global.d.ts`, `launcher-bridge/src/game-manifest.d.ts` | Same |
| `launcher-bridge/src/main/migrate.ts` | Absent (only in `launcher/`) |
| `launcher-bridge/src/renderer/brand/` | `logo-forever.png` instead of `logo-revamped.png`; different `emblem-32/64/512.png` |
| `launcher-bridge/index.html` | Differs: Forever title and logo |
| `launcher-bridge/forge.config.ts` | Differs: Forever names, no `login-loop.mp4` resource |
| `launcher-bridge/package.json` | Differs: name/version, stale `"directory": "UndauntedLauncher"` |
| `launcher-bridge/vite.main.config.ts`, `launcher-bridge/vite.preload.config.ts`, `launcher-bridge/vite.renderer.config.ts`, `launcher-bridge/forge.env.d.ts`, `launcher-bridge/tsconfig.json`, `launcher-bridge/tsconfig.test.json`, `launcher-bridge/.eslintrc.json` | Same |
| `launcher-bridge/scripts/collect-release.ps1`, `launcher-bridge/scripts/make-invite.mjs` | Differ: see Release row |
| `launcher-bridge/scripts/run-tests.mjs`, `launcher-bridge/scripts/make-game-manifest.mjs`, `launcher-bridge/scripts/make-icon.mjs`, `launcher-bridge/scripts/live-check.ts` | Same |
| `launcher-bridge/brand/build.py`, `launcher-bridge/brand/README.md`, `launcher-bridge/brand/palette.json` | Same; no `brand/revamped/`; `brand/launcher/icon*` and `brand/web/emblem-*` images differ |
| `launcher-bridge/mockup/launcher-mockup.html` | Differs by one sample path string; `mockup/art/` same |
| `launcher-bridge/data/dauntless-1.14.7.json` | Same manifest |
| `launcher-bridge/assets/` | `icon.ico`, `icon.png`, `intro-Logo.mp4` differ; no `login-loop.mp4` |
| `launcher-bridge/README.md`, `launcher-bridge/README.fi.md` | Stale: the 1.4.4 "Dauntless Revived Launcher" README |
| `launcher-bridge/THIRD-PARTY-NOTICES.txt` | Differs: Forever name, source link |
| `launcher-bridge/test/` | Same as `launcher/test/` except `controller.test.ts`, `credits.test.ts`, `fakes.ts`, `invite.test.ts`, `links.test.ts`, `ui.test.ts` (Forever/Tailscale/no characters); no `migrate.test.ts` |

## Connects to

| Target | How |
|---|---|
| [launcher](launcher.md) | Hands over by spawning `%LOCALAPPDATA%\DauntlessRevampedLauncher\DauntlessRevampedLauncher.exe` (or installing it); data migrates through `launcher/src/main/migrate.ts` |
| GitHub releases | Old feed `HyjinnxDev/dauntless-forever-1147-releases` (how installs reach 0.1.18); installer download from `HyjinnxDev/dauntless-revamped-releases` latest |
| [Backend](backend.md) | Same `/launcher/v1` and `/content/v1` API as the main launcher, minus `/launcher/v1/characters*` |

## Config

Same as [launcher](launcher.md) with Forever names: env `DAUNTLESS_FOREVER_RELAY_PORT`, userData `Dauntless Forever 1.14.7 Launcher`, `settings.json`. Build with `npm run make` in `launcher-bridge/`; `npm run release` publishes to the Forever releases repo.

## Gotchas

- **Do not edit it expecting Revamped players to see it.** Only old Forever installs run this code. Fix bugs in [launcher](launcher.md).
- Shared-file security fixes (pinned TLS, relay, downloader, verify) must be copied by hand if the bridge ever ships again. There is no shared package.
- The hand-over runs only for a packaged Squirrel install (`Update.exe` one level up); the portable ZIP behaves as an old launcher.
- The installer fetched during hand-over is not hash- or signature-checked.
- README and `package.json` repository directory are stale.
- Once no Forever installs remain, the whole directory can be deleted.

See also: [index](index.md), [launcher](launcher.md), [launcher-files](launcher-files.md), [paradox-launcher](paradox-launcher.md), [legacy-1.4.4](legacy-1.4.4.md).
