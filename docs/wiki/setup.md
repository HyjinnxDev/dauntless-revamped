# Running the server locally

> Verified against code 2026-10-24.

This page gets the Dauntless Revamped 1.14.7 stack (MongoDB, backend, Director, game servers) running on
one Windows PC. It is a short path through the full guide,
[`versions/1.14.7/docs/SELF_HOSTING.md`](../../versions/1.14.7/docs/SELF_HOSTING.md). Use that guide
for public hosting (DNS, TLS, firewall, launcher distribution).

> The repo holds **source code only**. Game files, generated game data and the Unreal SDK come from your
> own Dauntless 1.14.7 install and are never committed.

## What you need

| Thing | Notes |
|---|---|
| Windows 10/11 x64 | Game servers are the Windows game client run headless (`-server`) |
| Dauntless 1.14.7 | Build `rel-1.14.7-Archon`, changelist **647472**. Other builds will not work |
| Node.js 20+ and npm | Backend, Director, launcher, bot |
| MongoDB 7+ | Must run as a **replica set**: the backend uses multi-document transactions |
| Visual Studio C++ build tools | Only to build `MysticParadox.dll` ([Runtime](runtime.md)) |
| Rust (msvc target) | Only to build `winmm.dll` ([Tools](tools.md)) or the Tauri [ParadoxLauncher](paradox-launcher.md) |
| Dumper-7 SDK + generated game data | See `versions/1.14.7/docs/GENERATING_SDK.md` and `GENERATING_GAME_DATA.md` |

## Folder layout on this machine

The live PC uses these fixed paths. `host/restart-server.ps1` reads them from environment variables, so
another machine can override them:

| Path | Default | Override |
|---|---|---|
| Game install used by servers | `D:\Dev\dauntless 1.14.7\Dauntless_1.14.7\` | `REVAMPED_GAME_DIR` |
| Runtime data (logs, mongo, certs, updates) | `D:\MysticParadoxData` | `REVAMPED_DATA_DIR` |
| `mongod.exe` | `C:\Program Files\MongoDB\Server\9.0\bin\mongod.exe` | `REVAMPED_MONGOD` |

## Step 1: generate config (first time only)

From `versions/1.14.7`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\configure-selfhost.ps1 -PublicHost <host> `
  -GameServerBinaryPath '<game>\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe' `
  -TlsCertificatePath '<certs>\fullchain.pem' -TlsPrivateKeyPath '<certs>\privkey.pem' `
  -GameServerPublicAddress <ip> -InstallDependencies
```

It writes the gitignored files the stack needs: `ParadoxBackend/.env`, `ParadoxDirector/.env`, a fresh JWT
signing key pair, the shared gameserver API key, the API-key hashing secret, a runtime-update signing key
under `ParadoxLauncher/.secrets/` (kept if present), `ParadoxLauncher/.env`,
`ParadoxRuntime/deployment_config.generated.h` and `versions/1.14.7/.selfhost/`. **Back these up**: they
exist only on your machine. Never run it with `-Force` on a working install; that rotates credentials.
Its Mongo default is `mongodb://127.0.0.1:27017` with no replica set; pass `-MongoDbUri` for the 27018
`rs0` setup below. All parameters are listed in [Tools](tools.md).

The two `.env.example` files list every setting with comments:
`versions/1.14.7/ParadoxBackend/.env.example` and `versions/1.14.7/ParadoxDirector/.env.example`.
Settings worth knowing first:

- Backend: `MONGODB_URI`, `MONGODB_DB`, `AUTH_SIGNING_PRIVKEY_B64` / `AUTH_SIGNING_PUBKEY_B64`,
  `GAMESERVER_API_KEYS`, `API_KEY_HASH_SECRET`, `DEPLOYSERVER_URL` (where the Director is),
  `REALTIME_XMPP_ENABLED`, `VOICE_UDP_PORT`, `NODE_ENV`.
- Director: `PORT`, `MY_IP`, `PORT_RANGE_BEGIN`/`PORT_RANGE_END` (game UDP ports),
  `GAMESERVER_BINARY_PATH`, `METAGAME_API_KEY` (must equal one of the backend's `GAMESERVER_API_KEYS`),
  `MAX_CONCURRENT_HUNT_SERVERS`.

> Set `NODE_ENV=production` on any server other people connect to. Without it the backend skips its
> startup safety checks (see [Security and admin](backend-security-admin.md) and
> [FINDINGS](../FINDINGS.md)).

## Step 2: build and test

```powershell
cd versions\1.14.7\ParadoxBackend;  npm ci; npm run build; npm test
cd ..\ParadoxDirector;             npm ci; npm run build; npm test
```

`npm test` skips the `*.gamedata.test.ts` files until the real game data is present. Never run
`npm run test:bootstrap` against a real database: it is destructive.

The runtime DLL builds with `versions\1.14.7\ParadoxRuntime\_build.bat` (output
`x64\Release\MysticParadox.dll`). Players only receive it through a signed publish; see
[ParadoxLauncher](paradox-launcher.md).

## Step 3: start everything

The one-command way (asks for UAC once, logs to `<data>\logs`):

```powershell
versions\1.14.7\host\restart-server.ps1             # mongod (if down) + backend + Director
versions\1.14.7\host\restart-server.ps1 -DirectorOnly
versions\1.14.7\host\restart-server.ps1 -Stop
```

What it does, if you want to do it by hand:

1. **MongoDB** on port 27018 as replica set `rs0`, bound to 127.0.0.1:
   `mongod --port 27018 --bind_ip 127.0.0.1 --replSet rs0 --dbpath <data>\mongo`.
   On a brand-new data dir run `rs.initiate()` once in `mongosh --port 27018`.
2. **Backend**: `npm start` in `ParadoxBackend` (rebuilds itself if `build/` is stale). Ready when the log
   prints `paradox=ready`. HTTP on `PORT` (default 3000), HTTPS on `HTTPS_PORT` (default 3443; 443 on the live box).
3. **Director**: `npm run build` then `node --env-file=.env dist/server.js` in `ParadoxDirector`. It listens on
   `127.0.0.1:<PORT>` (3001 live) and starts Ramsgate and the Training Dojo; watch `director.log` for
   `ramsgate ready`. `GET http://127.0.0.1:3001/health/ready` turns 200 after the hub boot attempts.

For quick work without the scripts: `npm run dev` in `ParadoxBackend` (`tsx watch`, reloads on change) or
`ParadoxDirector` (plain `tsx`, no watch).

## Step 4: check it

- `GET http://127.0.0.1:3000/health/live` returns `{ ok: true }`.
- `GET http://127.0.0.1:3000/health/ready` returns 200 once Mongo and HTTPS are up (it also reports the
  online player count).
- The staff console is served by the backend at `/admin` (see
  [Security and admin](backend-security-admin.md)). Create the first staff account with
  `npm run admin:bootstrap` in `ParadoxBackend`.

## Step 5: play against it

Run the player launcher from source (`launcher/`):

```powershell
cd launcher; npm ci; npm start
```

Add your server with an invite link, register, and launch. See [Launcher](launcher.md) for how invites,
certificate pinning and runtime downloads work.

## Optional pieces

- **Discord bot** (status channel, `/issue`, launcher news): `discord-bot/`, `npm start` or
  `start-bot.ps1`. See [Discord bot](discord-bot.md).
- **A second test server** on another machine: [Deploy](deploy.md). Note the bundle copies live secrets.
- **Isolated test stack** on the same PC: `host/test-stack.ps1`, see [Host scripts](host-scripts.md).

## Common problems

| Symptom | Likely cause |
|---|---|
| Launcher says it can't reach the server | `mongod` on 27018 is not running, so the backend never got ready |
| Backend exits with `MYSTPAX_` rename error | Old env key names; rename them to `MYSTICPARADOX_` |
| Transactions fail / "Transaction numbers are only allowed on a replica set" | Mongo started without `--replSet` or `rs.initiate()` never ran |
| Game servers start then exit | Wrong `GAMESERVER_BINARY_PATH`, missing game data, or runtime DLL not beside the exe |
| Code change has no effect | Backend/Director need a restart. `npm start` (both) and `restart-server.ps1` rebuild first; a bare `node dist/server.js` runs the old build |
| Director starts but every hunt fails with capacity errors | Hunt cap reached (`MAX_CONCURRENT_HUNT_SERVERS`, default 3; a blank value now means 3) or another blank `X=` reading as 0; check the Director log for `Hunt server capacity reached` |

Note: `SELF_HOSTING.md` describes the upstream defaults (MongoDB on 27017, the Tauri ParadoxLauncher as the
player launcher). This repo's live setup uses Mongo on 27018 and the Electron `launcher/`.

## Repository files and docs

| File | What it does |
|---|---|
| `README.md` | Public front page: what Revamped is, how to play (installer from `HyjinnxDev/dauntless-revamped-releases`), feature list, repo layout, pointer to `SELF_HOSTING.md` and `deploy/README.md`, security contact, credits (Mystic Paradox, Dauntless Revived, Undaunted), AGPL-3.0-only. |
| `CLAUDE.md` | Rules for Claude sessions: read and keep this wiki current, repo layout, machine paths outside the repo, gitignored-but-required files, common commands (restart, runtime build, runtime publish), push/branch/restart rules. |
| `.gitignore` | Root ignores: `.env`, `.env.*` (except `.env.example`), `*.pem/key/crt/pfx`, `.secrets/`; `node_modules/`, `out/`, `release/`, `release-linux/`, `.vite/`, `.test-build/`, `dist/`, `x64/`, `.codegraph/`; `MysticCrashReports/`, `*.bak*`; `versions/1.14.7/DauntlessEndpointDocumentation/`. |
| `versions/1.14.7/.gitignore` | Version-folder ignores: secrets, `ParadoxCertificates/`, `deployment_config.generated.h`, the Dumper-7 SDK files, `*/game-data/*.json` (not `*.example.json`), `game-data/raw/`, `Items_Analysis/`, logs, Rust `target/`, MSVC outputs. |
| `versions/1.14.7/docs/SELF_HOSTING.md` | Full upstream self-host guide: DNS/TLS/firewall, game install check, SDK, game data, MongoDB, `configure-selfhost.ps1`, build, DLLs, launcher distribution. |
| `versions/1.14.7/docs/GENERATING_GAME_DATA.md` | Which `game-data` files each service needs and how to produce each one from CatalogExporter output and the `generate:*` scripts. |
| `versions/1.14.7/docs/GENERATING_SDK.md` | Dumper-7 SDK for CL 647472, where to copy it, `MP_PUBLIC_HOST`, building ParadoxRuntime and CatalogExporter. |
| `versions/1.14.7/docs/INSTALLING_DAUNTLESS.md` | Downloading the 1.14.7 build with Legendary, verifying it, pointing the upstream launcher at it, keeping it on 1.14.7. |
| `versions/1.14.7/docs/DAUNTLESS_1_14_7_PORT.md` | Upstream progress notes for the 1.12 to 1.14.7 port. |
| `versions/1.14.7/docs/STAFF_GUIDE.md` | Staff roles, signing in to `/admin`, bans, server control, first-owner setup. |
| `versions/1.14.7/docs/FAQ.md`, `SCOPE_AND_LEGAL.md` | Upstream FAQ; what is not included, responsible use, license, no warranty. |
| `versions/1.14.7/docs/assets/banner.webp` | Banner image of the upstream `versions/1.14.7/README.md`. |

See also: [Index](index.md) · [Backend](backend.md) · [Director](director.md) · [Host scripts](host-scripts.md)
