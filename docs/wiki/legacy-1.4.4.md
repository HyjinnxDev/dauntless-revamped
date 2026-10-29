# Legacy stack: Dauntless 1.4.4 (Dauntless Revived)

> Verified against code 2026-10-24.

## What it is

`versions/1.4.4/` is the older server stack for the October 2020 Dauntless **1.4.4** client (Unreal Engine 4). It came from the open-source projects *Undaunted* (gwog) and *Dauntless Revived* (mixutin) and was later rebranded "Dauntless Forever". It is **not the live game**: the live game is 1.14.7 (see [backend](backend.md), [director](director.md), [runtime](runtime.md)). The 1.4.4 tree is kept as reference and as the source of features ported to 1.14.7 (guilds, friends/parties, store logic, the launcher shell). It was pulled in with `git subtree` from `mixutin/dauntless-revived`, so names and docs still say "Dauntless Revived" or "Forever".

| | 1.4.4 stack | 1.14.7 stack |
|---|---|---|
| Backend | Express 5 + SQLite (`better-sqlite3`, Drizzle) | Express + MongoDB |
| Game server | retail client exe run with `-server`, driven by an injected DLL (`UndauntedInternalServer.dll`) | `MysticParadox.dll` (see [runtime](runtime.md)) |
| Spawner | `UndauntedDeployServer` (port 61001) | `ParadoxDirector` |
| Public access | TLS `UndauntedGateway` + firewall UDP allowlist | different hosting setup (see [setup](setup.md)) |
| Names | PascalCase `Undaunted*` | `Paradox*` |

## Pages

| Page | Covers |
|---|---|
| [legacy-1.4.4-metagame](legacy-1.4.4-metagame.md) | `UndauntedMetagame/`: backend, port 61000 |
| [legacy-1.4.4-internal-server](legacy-1.4.4-internal-server.md) | `UndauntedInternalServer/`: the injected C++ DLL (server and client mode) |
| [legacy-1.4.4-gateway-deploy](legacy-1.4.4-gateway-deploy.md) | `UndauntedDeployServer/`, `UndauntedGateway/`, `deploy/` kits: file-by-file |
| [legacy-1.4.4-launcher](legacy-1.4.4-launcher.md) | `UndauntedLauncher/`: file-by-file |
| [legacy-1.4.4-content-bot-tools](legacy-1.4.4-content-bot-tools.md) | `UndauntedContent/`, `UndauntedDiscordBot/`, `tools/`, `client-mods/`, `friend-kit/`, `brand/`: file-by-file |
| [legacy-1.4.4-docs-site](legacy-1.4.4-docs-site.md) | `docs/` Jekyll site (one row per page), top-level READMEs, `.github/` workflows |

## Top-level folders

Under `versions/1.4.4/` (skipped on purpose: `UndauntedInternalServer/SDK/` and `MinHook/`, a generated Unreal SDK dump and a vendored hooking library):

| Path | Purpose |
|---|---|
| `UndauntedMetagame/` | Backend: accounts, login/JWT, saves, inventory, store, parties, guilds, matchmaking, XMPP chat (61099). Port 61000 |
| `UndauntedInternalServer/` | C++ DLL injected into the game exe. Server mode: dedicated game server. Client mode: points the client at our backend |
| `UndauntedDeployServer/` | Spawns and watches game-server processes, routes to remote workers. Port 61001, loopback only |
| `UndauntedGateway/` | Public TLS front door (443) plus the firewall allowlist helper (61005) |
| `UndauntedContent/` | Content server (61002, plain `node:http`): 410 pinned game files by manifest, art pack, news |
| `UndauntedLauncher/` | Electron player launcher (ancestor of the live [launcher](launcher.md)) |
| `UndauntedDiscordBot/` | Discord bot: `/key` invites and account links, `/counter`. Separate from the live [discord-bot](discord-bot.md) |
| `deploy/` | Install/run kits: `windows-server/`, `linux-server/`, `openbsd-server/`, `unix-common/` |
| `tools/` | Owner dashboard (61110), worker health (61111), Discord status webhook, manifest builder, friend-kit builder, CI checks, `xref.py` |
| `client-mods/` | Optional UE4SS 3.0.1 + Lua mods, hash-pinned in `manifest.json` |
| `friend-kit/` | Script-only alternative to the launcher (`setup.ps1`, `play.ps1`) |
| `brand/` | Brand masters and `build.py` that renders every derived image |
| `docs/` | Jekyll documentation site (English + Finnish) |
| `data/` | Git-ignored build output (friend-kit zip) |
| `.github/` | CI (`ci.yml`) and launcher release workflow |
| `README.md`, `ROADMAP.md`, `NOTICE.md`, `LICENSE.txt`, ... | Upstream project docs (AGPL-3.0-only) |

## How it connects

```
 player PC                                     server PC
 game exe + dxgi.dll + UndauntedInternalServer.dll (client mode)
   |  http://127.0.0.1:61000   (public mode: the launcher's relay)
   v
 UndauntedLauncher relay ==TLS 443, pinned cert==> UndauntedGateway ---> 127.0.0.1:61000 Metagame
                                                       |        |-----> 127.0.0.1:61002 Content
                                                       |        '-----> 127.0.0.1:61099 chat (WebSocket, inside Metagame)
                                                       '--allow IP--> 127.0.0.1:61005 allowlist helper (admin) -> firewall rule for UDP 8770-8777

 Metagame --POST /api/matchmaker/handle-matchmaking-for-player--> DeployServer 127.0.0.1:61001
 DeployServer --spawn--> game exe -server (UndauntedInternalServer.dll, server mode), UDP 8770-8777
 DeployServer --SSH tunnel--> worker DeployServers (EU overflow, aus, ger, us)
 game servers --HTTP + x-undaunted-gameserver-apikey--> Metagame 127.0.0.1:61000 (saves, progression, hunt results)
 Players' UDP game traffic goes straight to the game server (not via the gateway)
```

Main flows:

1. **Join.** The launcher parses an invite (`dauntless-forever://join?...` or older `dauntless-revived://`), registers with the Metagame (`POST /undaunted/api/Register`), gets a long account key.
2. **Install.** The launcher downloads 1.4.4 files from the Content server (or its CDN `downloadBaseUrl`), checks each against the compiled-in SHA-256 manifest, copies two pinned DLLs next to the exe.
3. **Play.** The launcher spawns the exe with `host:port` as argv[1] plus `-AUTH_PASSWORD=<key>`. The client DLL rewrites the game's online endpoints to our Metagame. Login: `POST /account/api/oauth/token` (account key in, 24 h RS256 JWT out).
4. **Matchmaking.** `/candidate/join` on the Metagame asks the DeployServer for a server (local or a worker) and gets host and UDP port.
5. **Game-server calls.** Game servers authenticate to the Metagame with the gameserver key header, from the same machine only (workers via tunnel).

## Config

Each service has its own `.env`; the Windows kit writes them from `data\config\server.json`. Shared contracts:

- Metagame `PORT` 61000, `DEPLOYSERVER_URL` (host:port, no scheme), `GATEWAY_SECRET` (public mode), `CHAT` (on unless `0`).
- DeployServer `PORT` 61001, `GAMESERVER_BINARY_PATH`, `METAGAME_API_KEY`, `PORT_RANGE_BEGIN/END`, `MY_IP`.
- Content `PORT` 61002, `CONTENT_GAME_DIR`, `METAGAME_URL`.
- Gateway `GATEWAY_PORT` 443, `GATEWAY_SECRET`, `ALLOWLIST_SECRET`.
- Full lists on the sub-pages and in `docs/reference/configuration.md`.

## Gotchas

- **Do not push to upstream.** Only `origin` (HyjinnxDev/dauntless-revamped) is a push target. Never push or open issues against `mixutin/dauntless-revived`.
- **One pinned exe.** The DLL hooks fixed addresses in one `Dauntless-Win64-Shipping.exe` (sha256 `d3d41e61...`, `UndauntedLauncher/src/main/constants.ts`). Any other build crashes or misbehaves.
- **Project name drift.** Packages say `dauntless-revived-*` or `dauntless-forever-launcher`; URLs point at `HyjinnxDev/dauntless-revived`; the monorepo is "Revamped". Same codebase.
- **Never in git:** game files, `.env` files, certificates, account keys. `tools/ci/check-repo.js` enforces this in upstream CI.
- **Port numbers are baked in.** 61000/61001/61002/61005/61099/61110/61111 TCP and 8770-8777 UDP appear in the DLL, launcher, gateway, tools and kit scripts.
- `node_modules/`, `dist/`, `build/` inside the tree are build output.

## See also

[index](index.md) - [setup](setup.md) - [legacy-1.4.4-metagame](legacy-1.4.4-metagame.md) - [legacy-1.4.4-internal-server](legacy-1.4.4-internal-server.md) - [legacy-1.4.4-gateway-deploy](legacy-1.4.4-gateway-deploy.md) - [legacy-1.4.4-launcher](legacy-1.4.4-launcher.md) - [legacy-1.4.4-content-bot-tools](legacy-1.4.4-content-bot-tools.md) - [legacy-1.4.4-docs-site](legacy-1.4.4-docs-site.md) - [launcher](launcher.md) - [discord-bot](discord-bot.md) - [deploy](deploy.md)
