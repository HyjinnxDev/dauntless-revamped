# ParadoxLauncher (Tauri launcher and runtime-update publishing)

> Verified against code 2026-10-24.

File-by-file reference: [ParadoxLauncher files](paradox-launcher-files.md).

## What it is

`versions/1.14.7/ParadoxLauncher` is the upstream Mystic Paradox desktop launcher: a Tauri 2 app (Rust shell, React 19 + TypeScript + Vite UI, WebView2). It signs a player in, finds their Dauntless 1.14.7 install, downloads and verifies signed runtime files, asks the backend for a one-time game ticket and starts the game.

### Is it shipped to players?

**No.** Players install the Electron launcher in `launcher/` ([Launcher](launcher.md)), which self-updates from GitHub releases (`UPDATE_FEED_URL` in `main/constants.ts`). The Tauri app is not built or published by this project: the live update root has no `launcher/` tree, `.secrets/` has no Tauri updater key, and `release:launcher` cannot finish (see Gotchas). Root `CLAUDE.md` describes the folder as "runtime update publishing + signing key".

What this project does use:

- `scripts/publish-runtime-update.mjs`: the **only** way a new client `MysticParadox.dll` reaches players.
- `.secrets/selfhost-runtime-update.private.pem`: the signing key it uses.
- The Tauri source as the reference for the update and Play protocol the backend expects.

Its compiled-in defaults point at the upstream domain (`paradox.mysticfox.dev`) and the upstream public key, so a build for this fork would need the self-host env from `scripts/configure-selfhost.ps1`.

## Runtime publish pipeline

### Command

Run from `versions/1.14.7/ParadoxLauncher` (relative defaults resolve against the cwd). The live form is in root `CLAUDE.md`:

    node scripts/publish-runtime-update.mjs --dll ../ParadoxRuntime/x64/Release/MysticParadox.dll \
      --extra <prev version dir>/winmm.dll --target client --version <bump> --changelist 647472 \
      --channel stable --output 'D:\MysticParadoxData\updates' --base-url https://paradox.test \
      --key .secrets/selfhost-runtime-update.private.pem

Takes effect at once. No backend restart. Ask before publishing, because players are affected.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--dll` | none (required) | The runtime DLL. Must be 1 byte to 200 MB. |
| `--version` | none (required) | SemVer (`^\d+\.\d+\.\d+([-+]...)?$`). Names the version folder. |
| `--target` | `client` | `client` or `server`. Anything else throws. |
| `--changelist` | `647472` | Positive safe integer. Written as `targetChangelist`. |
| `--channel` | `stable` | Folder name. Not validated by the script. The backend and launcher only know `stable`, `beta`, `dev`. |
| `--output` | `../ParadoxBackend/updates` | Update root. Live: `D:\MysticParadoxData\updates` (= backend `LAUNCHER_UPDATE_ROOT`). |
| `--base-url` | `https://paradox.mysticfox.dev` | Prefix baked into `url` fields. Trailing `/` stripped. Live: `https://paradox.test`. |
| `--key` | `.secrets/mystic-runtime-update.private.pem` | PKCS#8 Ed25519 private key. Live: `.secrets/selfhost-runtime-update.private.pem`. |
| `--force` | off | Overwrite an already published version folder (otherwise the script refuses). |
| `--extra` | none, repeatable | Companion file. Base name must be `winmm.dll` or listed in optional `scripts/p2p/runtime-extra-names.json` (absent in this tree). 1 byte to 200 MB. |

Parsing: `arg()` takes the first occurrence of a flag. `argList()` collects every `--extra` whose next token does not start with `--`.

### What it does

1. Validates the version, target and changelist. Reads the DLL and checks its size.
2. SHA-256 of the DLL. Artifact name `MysticParadox-<version>-<target>-<changelist>.dll`.
3. Reads the previous `latest.json` for this target/channel, if any.
4. Refuses if the version folder already exists (`--force` overwrites). Main DLL: always signed with `crypto.sign(null, bytes, key)` (pure Ed25519, no prehash, deterministic: same file + key = same signature) and copied. Logs `DLL unchanged since vX` when the hash matches `latest.json`.
5. Each `--extra`: allowlist check, hash, always signed, copied and given a fresh entry (so a new `--key` or `--base-url` applies to unchanged files too). Logged as new/unchanged/changed. Previous extras **not** passed again are dropped.
6. Writes `<version>/manifest.json` and `latest.json` (same content, 2-space JSON plus newline) and prints a summary JSON (`target`, `version`, `sha256`, `artifact`, `manifest`).

There is no overwrite guard. Re-running with an existing `--version` overwrites that folder.

### Output layout

```
<update root>/                                 D:\MysticParadoxData\updates (live)
  serving.json                                 optional; backend kill switch {runtimeEnabled, updatedAt}
  runtime/<target>/<channel>/windows-x86_64/
      latest.json                              what everyone fetches
      <version>/manifest.json                  copy kept per version
      <version>/MysticParadox-<version>-<target>-<changelist>.dll
      <version>/winmm.dll                      each extra under its own name
  launcher/windows/x86_64/                     Tauri self-update tree (publish-launcher-update.ps1); absent live
  guard/<channel>/windows-x86_64/              signed Guard manifests (admin route); absent live
```

The live tree on 2026-10-24 has only `runtime/client/stable/windows-x86_64` (versions 0.2.7 to 0.2.65). No `server` target has been published.

### Manifest (`latest.json`)

| Field | Type | Notes |
|---|---|---|
| `schema` | `1` | |
| `component` | `"ParadoxRuntime"` | The Director also accepts `"MystPaxInternalServer"` (older manifests). |
| `target` | `client` / `server` | |
| `version` | SemVer string | Must equal the `runtimeManifestVersion` the launcher sends to `game-sessions`. |
| `channel` | string | |
| `targetChangelist` | number | 647472. Every consumer rejects other values. |
| `platform` | `"windows-x86_64"` | |
| `size` | bytes | Main DLL. |
| `sha256` | lowercase hex | Main DLL. |
| `signature` | base64, 64 bytes | Ed25519 over the raw DLL bytes. |
| `file` | artifact name | The backend download route serves `<version>/<file>`. |
| `publishedAt` | ISO time | Refreshed on every run. |
| `url` | `<base-url>/launcher/v1/runtime/<target>/<channel>/windows-x86_64/download` | |
| `extraFiles[]` | `{name, size, sha256, signature, url}` | `url` = `.../windows-x86_64/extra/<name>`. Must include `winmm.dll`. |

### Signing scheme

- Key: Ed25519, from `scripts/generate-runtime-key.mjs` (PKCS#8 private PEM, SPKI public PEM, raw 32-byte public key in base64).
- Signature: `sign(null, fileBytes, key)` per file, base64 in the manifest. There is no manifest-level signature. Only file bytes are signed.
- `.secrets/` (gitignored) holds `selfhost-runtime-update.private.pem`, `.public.pem` and `.public.raw.b64`, made by `scripts/configure-selfhost.ps1`. Never open or print the private key.
- Public key copies, checked 2026-10-24:

| Holder | Key | Matches the self-host key? |
|---|---|---|
| Tauri `commands/updates.rs` `DEFAULT_RUNTIME_UPDATE_PUBLIC_KEY_B64` (override: build env `MYSTICPARADOX_RUNTIME_PUBLIC_KEY_B64`) | upstream | Only with the env override |
| Tauri `launch/guard.rs` `PUBLIC_KEY_B64` (Guard manifests, no override) | upstream | No |
| Director `runtimeUpdater.ts` `RUNTIME_PUBLIC_KEY` | upstream | **No** |
| Backend `routes/launcherUpdates.ts` `RUNTIME_PUBLIC_KEY` (admin upload and Guard manifest check) | upstream | No |
| Revamped launcher | none, signature not checked | n/a |

### Who consumes the feed

| Consumer | Reads | Checks |
|---|---|---|
| Backend `routes/launcherUpdates.ts` | `GET /launcher/v1/runtime/:target/:channel/:platform` (and legacy `/:channel/:platform` = client) serves `latest.json` with no-cache. `/download` streams `<version>/<file>`. `/extra/:filename` streams a file only if it is listed in `extraFiles`. | `stable` is public. `beta`/`dev` need a signed-in tester (`AUTH_TESTER_REQUIRED`). `serving.json` with `runtimeEnabled:false` makes every manifest answer 204. Rate limit bucket `update-download`. |
| Backend `security/runtimeAuthorization.ts` | `runtime/client/<channel>/windows-x86_64/latest.json` on every `POST /launcher/v1/game-sessions` | The reported `runtimeManifestVersion` must equal `version`. Reported hashes must match `sha256` and `extraFiles`. The manifest must contain `MysticParadox.dll` and `winmm.dll`, otherwise every Play fails with `RUNTIME_BUILD_UNSUPPORTED`. Optional extras are all or none. |
| Revamped launcher `launcher/src/main/hostapi.ts` (`fetchRuntimeRelease`, `parseRuntimeRelease`, `downloadRuntimeFile`) | Fixed `/launcher/v1/runtime/client/stable/windows-x86_64`, then `/download` and `/extra/winmm.dll` on the invite's own server | `version` SemVer, `targetChangelist` 647472, `sha256` and the winmm `sha256`. Ignores manifest `url`s. **No signature check.** Files up to 64 MB. |
| Tauri launcher `commands/updates.rs` | `<MYSTICPARADOX_RUNTIME_ENDPOINT>/<channel>/windows-x86_64` (legacy route = client), then manifest `url`s | `url` must be HTTPS on the endpoint's host and port. Changelist, size, SHA-256, Ed25519. Extras too. |
| Director `runtimeUpdater.ts` `EnsureServerRuntimeUpdated` (at startup, if `SERVER_RUNTIME_AUTO_UPDATE`) | `SERVER_RUNTIME_MANIFEST_URL` (required, no default). Main DLL only, no extras. | Target `server`, changelist, size, `MZ` header, SHA-256, Ed25519 with the self-host public key (`RUNTIME_PUBLIC_KEY`). HTTPS unless `SERVER_RUNTIME_ALLOW_HTTP`. Refuses while any `Dauntless-Win64-Shipping.exe` runs. Failure is fatal only with `SERVER_RUNTIME_UPDATE_REQUIRED`. |

Admin routes in the same backend file (not used by the script): `POST /launcher/v1/admin/updates/runtime/:target/:channel/:platform` (raw body, headers `x-update-api-key`, `x-update-version`, `x-update-changelist`, `x-update-signature`; 409 if that version exists), `POST .../extra`, `GET`/`POST /launcher/v1/admin/updates/serving`, `POST /launcher/v1/admin/guard-manifests/:channel/:platform`. All need `UPDATE_PUBLISHER_API_KEY` and a source IP in `UPDATE_PUBLISHER_ALLOWED_IPS` (an empty list denies). Uploads are verified against the upstream public key, so self-host-signed uploads fail.

### Launcher self-update channel (Tauri only, unused here)

| Step | What |
|---|---|
| `npm run release:launcher` -> `scripts/build-launcher-release.ps1` | `-SigningKey` (default `.secrets\mystic-launcher.key`), `-SigningPasswordFile` (default `.secrets\mystic-launcher.password`). Sets `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` for the child only. Runs `tauri build --bundles nsis`, then `node ..\..\scripts\extract-nsis-launcher-payload.mjs --installer ... --output src-tauri\target\release\installed\launcher.exe --replace`. |
| `npm run publish:launcher` -> `scripts/publish-launcher-update.ps1` | `-UpdateRoot` (default `..\..\ParadoxBackend\updates`), `-BaseUrl` (default upstream), `-Notes`, `-SkipBuild`. Copies `<productName>_<version>_x64-setup.exe` to `launcher\windows\x86_64\<version>\`. Writes `manifest.json` and `latest.json` = `{version, notes, pub_date, file, url: <BaseUrl>/launcher/v1/updates/windows/x86_64/download, signature: <.sig text>}`. |
| Served by | `GET /launcher/v1/updates/:target/:arch/:currentVersion` always returns `latest.json` (204 if none). The Tauri updater compares versions. `.../download` streams `<version>/<file>`. |
| Client | `tauri.conf.json` `plugins.updater` (minisign pubkey, endpoint `.../updates/{{target}}/{{arch}}/{{current_version}}`, `installMode: passive`). The UI checks at start and every 30 min (`App.tsx`, `api/updates.ts`). |

Keep the version identical in `package.json`, `src-tauri/Cargo.toml` and `tauri.conf.json` (all 0.1.53). `Cargo.lock` follows Cargo.toml.

## How the Tauri launcher works

| Phase | What happens |
|---|---|
| Startup (`src/lib.rs` `run`) | Plugins: single-instance (forwards a second launch's `mysticparadox://` argv), opener, dialog, deep-link, window-state (never restores decorations), process, updater. Then `deep_link::listen`/`check_startup_url`, `start_runtime_prefetch` (silent repair for the account's policy channel), `guard_loop::start`. On exit: `launch::shutdown_all`. |
| Sign-in | `commands/auth.rs` -> `/launcher/v1/auth/{login,register,refresh,logout,discord/start,discord/complete}`, `/launcher/v1/{status,policy,me,username}`. The refresh token lives in Credential Manager (`dev.mysticfox.launcher`/`refresh-token`), with a DPAPI `session.dpapi` fallback. Refreshes are serialised (`REFRESH_SESSION_LOCK`) because the backend rotates tokens and treats reuse as theft. |
| Runtime repair | `install_runtime_update`: under `runtime_install_lock`, fetch the manifest. If any file differs by size or hash and no Dauntless process (client or `-server`) runs, download, verify, and swap via `.new`/`.bak`. Extras first, then the main DLL. |
| Play (`commands/launch.rs` `secure_launch`) | Single-flight lock. Session log folder. Runtime repair for `expected_channel`. Take the runtime lock. Hash the exe, `MysticParadox.dll` and `winmm.dll`. Refresh the token. Re-fetch policy and require the same channel. Reconcile `.flag` files. `GET /launcher/v1/status`. `POST /launcher/v1/game-sessions` `{buildChangelist, executableSha256, runtimeChannel, runtimeManifestVersion, runtimeArtifacts}` -> `exchangeCode`. Write `metadata.json`. `process::spawn_game`. |
| Spawn (`launch/process.rs`) | Suspended, reparented under Explorer (fixes audio under Parallels), assigned to a kill-on-close Job Object, then resumed. Private env block: drops `MYSTICPARADOX_RUNTIME_PROFILE`, `MYSTICPARADOX_ALLOW_DAMAGE_DEBUG` and `MYSTICPARADOX_DEBUG_DAMAGE_MULTIPLIER`, then sets `MYSTICPARADOX_RUNTIME_PROFILE` from the policy's `diagnosticsProfile`. Args: `-DisableEOS -EpicPortal -NoEAC -AUTH_TYPE=exchangecode -AUTH_LOGIN=<id> -AUTH_PASSWORD=<code> -epicapp=Archon -epicenv=Prod -epicusername/-epicuserid/-epicaccountid -epicsandboxid=jackal -epicdeploymentid=...`. Emits `game-exited`. The game dies when the launcher exits. |
| Guard Lite (`launch/guard.rs`, `guard_loop.rs`) | Observe-only. Every 20 s (backing off to 300 s) it verifies the signed Guard manifest (`GET /launcher/v1/guard-manifests/<channel>/windows-x86_64`), then `POST /launcher/v1/guard/sessions` and `/guard/heartbeat` with signed heartbeats. It never ends a game. |

## Connects to

| Peer | How |
|---|---|
| [Backend](backend.md) | Serves the update tree (`routes/launcherUpdates.ts`), checks Play hashes (`security/runtimeAuthorization.ts`), takes log uploads (`routes/launcherLogs.ts`, `PUT /launcher/v1/logs/sessions/:id/:file`). |
| [Launcher](launcher.md) | Revamped Electron launcher, the real consumer of the client feed (hash-only). |
| [Director](director.md) | Optional server-target consumer. Its key is upstream, see Gotchas. |
| [Runtime](runtime.md) | Builds the published DLL (`x64/Release/MysticParadox.dll`). |
| [Tools](tools.md) | `RuntimeLoader` builds `winmm.dll`. `scripts/configure-selfhost.ps1` runs `generate-runtime-key.mjs ".secrets/selfhost-runtime-update"` and writes `.selfhost/build-env.ps1` plus `.selfhost/tauri.selfhost.conf.json` (CSP for the custom origin). |
| Local disk (Tauri) | `install.json`, `session.dpapi`, `guard-rollback.json` in the app config dir. `%LOCALAPPDATA%\MysticParadox\Logs\Sessions\<id>\` and `Logs\launcher-exit.log`. Game folder: `MysticParadox.dll`, `winmm.dll`, `VERBOSE_DIAG.flag`, `.mysticparadox-managed-flags.json`. |

## Config

| Name | Where | Meaning |
|---|---|---|
| `MYSTICPARADOX_API_BASE_URL` | Rust build env (`option_env!`) | Native API origin. Debug default `http://127.0.0.1:3000`, release default upstream. |
| `MYSTICPARADOX_RUNTIME_ENDPOINT` | Rust build env | Runtime feed base (default `https://paradox.mysticfox.dev/launcher/v1/runtime`). |
| `MYSTICPARADOX_RUNTIME_PUBLIC_KEY_B64` | Rust build env | Raw Ed25519 public key for runtime files. |
| `VITE_API_BASE_URL` | `.env` (template `.env.example` = `http://127.0.0.1:3000`) | Frontend origin for `api/client.ts`. Must also be allowed by the CSP. |
| `TAURI_DEV_HOST` | env for `vite.config.ts` | Dev server host and HMR. |
| Backend | `ParadoxBackend/.env` | `LAUNCHER_UPDATE_ROOT`, `UPDATE_PUBLIC_BASE_URL`, `UPDATE_PUBLISHER_API_KEY`, `UPDATE_PUBLISHER_ALLOWED_IPS`, `RUNTIME_EXTRA_FILES`, `TARGET_CHANGELIST`. |
| Director | `ParadoxDirector/.env` | `SERVER_RUNTIME_AUTO_UPDATE`, `SERVER_RUNTIME_UPDATE_REQUIRED`, `SERVER_RUNTIME_MANIFEST_URL`, `SERVER_RUNTIME_ALLOW_HTTP`, `GAMESERVER_RUNTIME_DLL_PATH`. |

npm scripts: `dev`, `build` (`tsc && vite build`), `preview`, `tauri`, `test:workflow`, `release:launcher`, `publish:launcher`. Rust: `cargo fmt/clippy/test` in `src-tauri`.

## Gotchas

- **Always pass `winmm.dll` as `--extra`.** The new manifest lists only the extras you pass. Without winmm, the backend rejects every Play (`RUNTIME_BUILD_UNSUPPORTED`) and the Revamped launcher reports `runtime_unavailable`.
- **Always pass `--base-url` and `--key`.** The defaults are the upstream domain and a key file (`mystic-runtime-update.private.pem`) that does not exist here.
- **Bump `--version`.** The backend checks the reported version against `latest.json`. Re-using a version overwrites its folder.
- **Key rotation:** every publish re-signs every file with `--key`, so a rotation takes effect on the next publish. The embedded public key in Director `runtimeUpdater.ts` and backend `routes/launcherUpdates.ts` (`RUNTIME_PUBLIC_KEY`) must be changed with it. The Revamped launcher does not verify signatures.
- **Server-target publishing** works with the self-host key (Director and backend upload routes embed its public half since 2026-10-24); Guard manifests still use the upstream key (`UPSTREAM_RUNTIME_PUBLIC_KEY`, key id `runtime-2026-01`). The live server DLL is still deployed by hand; Director auto-update is off in the live `.env`.
- `npm run test:publish` (`scripts/publish-runtime-update.test.mjs`) runs the real script with throwaway keys: signatures, version guard, key rotation, base URL.
- **`generate-runtime-key.mjs` default output is `../.secrets/mystic-runtime-update`** (one level above the cwd). The publish default reads `.secrets/` in the cwd. Always pass paths.
- **`release:launcher` is broken here.** `.secrets/mystic-launcher.key`/`.password` are absent, and `versions/1.14.7/scripts/extract-nsis-launcher-payload.mjs` does not exist anywhere in the repo.
- **Runtime updates refuse while any Dauntless runs.** Both the Tauri launcher and the Director check for client and dedicated-server processes (`-server`).
- **WebPKI roots only.** The Tauri native client (rustls) ignores the Windows certificate store, so a private-CA backend does not work for it.
- **Optional modules.** `build.rs` sets `cfg(mystic_p2p)` / `cfg(mystic_anticheat)` only if `src/p2p/mod.rs` (and `src/anticheat/mod.rs`) exist. Neither is in the public tree, so the build is dedicated-only with Guard Lite.
- **Do not open `.secrets/`.** Back it up outside the repo.

## See also

[ParadoxLauncher files](paradox-launcher-files.md), [Index](index.md), [Setup](setup.md), [Backend](backend.md), [Director](director.md), [Runtime](runtime.md), [Tools](tools.md), [Launcher](launcher.md), [Host scripts](host-scripts.md)
