# Dauntless Revamped wiki

Dauntless Revamped is a community server for **Dauntless 1.14.7**, built on the open-source
[Mystic Paradox](https://github.com/pranav158/Mystic-Paradox) stack. The official game servers are gone, so
this repo replaces everything the game used to talk to: accounts, inventory, store, matchmaking, chat and the
game servers themselves. It also ships the launcher players install.

New here? Read this page, then [Setup](setup.md), then the page for the part you are working on.
Known problems are tracked in [FINDINGS](../FINDINGS.md).

## The big picture

```
 Player PC                                         Server PC (Windows)
 ─────────                                         ───────────────────
 Revamped launcher (Electron)  ── HTTPS ──────────▶ ParadoxBackend (Node/Express)
   │ downloads + verifies game                       │  REST game APIs, launcher auth, store,
   │ installs signed runtime DLL                     │  XMPP chat (WebSocket), staff console
   ▼                                                 │  voice relay (UDP 8791)
 Dauntless-Win64-Shipping.exe                        │        │
   + winmm.dll (loader)                              │        ▼
   + MysticParadox.dll (runtime) ── HTTPS + XMPP ───▶│     MongoDB (127.0.0.1:27018, replica set)
        │ rewrites official URLs to the backend      │
        │ voice over UDP ───────────────────────────▶│
        │                                            │ HTTP 127.0.0.1:3001
        │                                            ▼
        └──── game UDP (8780+ range) ──────────▶ ParadoxDirector (Node)
                                                    spawns + watches game servers:
                                                    Ramsgate hub, Training Dojo, hunts, Gauntlet
                                                    (the same game exe run with -server
                                                     + MysticParadox.dll in server mode)
```

How one session flows:

1. The **launcher** signs the player in (`/launcher/v1/auth/*`), checks the game files against a
   compiled-in hash list, and downloads the runtime DLL from the server. See [Launcher](launcher.md).
2. It asks the backend for a one-minute **exchange code** and starts the game with it. The backend also
   hands out a voice ticket.
3. Inside the game, **MysticParadox.dll** hooks the HTTP layer and rewrites every official backend URL to
   `https://<server>/__origin/<original-host>/...`. The backend strips that prefix and routes the request
   normally. See [Runtime](runtime.md) and [Backend](backend.md).
4. The game logs in (EOS-style OAuth on `/account/api/oauth/token`), loads characters, inventory and
   loadouts, and opens an **XMPP** WebSocket for friends, parties and chat. See
   [Backend realtime](backend-realtime.md).
5. When the player travels or starts a hunt, the backend asks the **Director** for a server. The Director
   reuses a live one or spawns a new game-server process and returns its address. See
   [Director](director.md).
6. **Game servers** report results back to the backend with the shared gameserver API key
   (`x-mysticparadox-gameserver-apikey`): inventory grants, XP, bounty claims, hunt stats. Only that key
   may grant items or currency. See [Security and admin](backend-security-admin.md).
7. Everything persistent lives in **MongoDB**. See [Backend persistence](backend-persistence.md).

## Pages

### Live 1.14.7 stack (`versions/1.14.7/`)

| Page | What it covers |
|---|---|
| [Backend](backend.md) | `ParadoxBackend`: startup, request pipeline, routes, controllers, config (every env var) |
| [Backend files](backend-files.md) | Every backend source file, plus the full route index (method, path, auth, file) |
| [Backend scripts](backend-scripts.md) | Every `scripts/` generator, migration and test runner; what each writes, whether it is destructive |
| [Backend realtime](backend-realtime.md) | XMPP chat/presence/parties, party outbox, UDP voice relay |
| [Backend persistence](backend-persistence.md) | Mongo connection, repositories, collections, migrations |
| [Security and admin](backend-security-admin.md) | How each caller is authenticated, staff roles and bans, `/admin` console, metrics |
| [Director](director.md) | `ParadoxDirector`: spawning, reusing and reaping game servers, ports |
| [Runtime](runtime.md) | `ParadoxRuntime`: `MysticParadox.dll` client and server hooks, features |
| [Runtime files](runtime-files.md) | Every DLL source file, hook tables (RVAs), all `*.flag` files, env vars, log tags (`[Tag]` -> file -> meaning) |
| [ParadoxLauncher](paradox-launcher.md) | Upstream Tauri launcher (not shipped) and the signed runtime-publish pipeline (used) |
| [ParadoxLauncher files](paradox-launcher-files.md) | Every ParadoxLauncher source file |
| [Tools](tools.md) | CatalogExporter (game-data export), RuntimeLoader (`winmm.dll`), helper scripts |
| [Host scripts](host-scripts.md) | `restart-server.ps1`, firewall, test stack, sizing log |

### Around it

| Page | What it covers |
|---|---|
| [Launcher](launcher.md) | `launcher/`: the Electron launcher players install |
| [Launcher files](launcher-files.md) | Every launcher file, IPC channels, backend endpoints, files written on the player PC, settings keys |
| [Launcher bridge](launcher-bridge.md) | `launcher-bridge/`: legacy Forever→Revamped hand-over launcher |
| [Discord bot](discord-bot.md) | `discord-bot/`: status channel, `/issue` tickets, launcher news |
| [Deploy](deploy.md) | `deploy/`: bundling the stack for a second (test) machine |
| [Legacy 1.4.4](legacy-1.4.4.md) | `versions/1.4.4/`: the older Dauntless Revived stack (hub for its sub-pages below) |
| [1.4.4 Metagame](legacy-1.4.4-metagame.md) · [InternalServer](legacy-1.4.4-internal-server.md) · [Launcher](legacy-1.4.4-launcher.md) · [Gateway/Deploy](legacy-1.4.4-gateway-deploy.md) · [Content/bot/tools](legacy-1.4.4-content-bot-tools.md) · [Docs site](legacy-1.4.4-docs-site.md) | Per-component file references |

### Getting started

- [Setup](setup.md): run the stack locally.
- Keeping the wiki current: see the "Wiki" section of the root `CLAUDE.md`. `node docs/wiki/check-coverage.mjs [prefix]` lists source files no page mentions.
- [FINDINGS](../FINDINGS.md): bugs, security issues and maintenance hazards, ranked.

## Where things run (ports)

| Port | Who | Exposure |
|---|---|---|
| TCP 443 (`HTTPS_PORT`) | Backend HTTPS + XMPP WebSocket | Public |
| TCP 3000 (`PORT`) | Backend plain HTTP (health, QoS ping) | Private |
| TCP 3001 | Director API (no auth on matchmaker routes; bound to 127.0.0.1) | Loopback only |
| TCP 27018 | MongoDB | Loopback only |
| UDP 8791 (`VOICE_UDP_PORT`) | Voice relay | Public |
| UDP `PORT_RANGE_BEGIN`–`END` | Game servers | Public |

## Words you will see

| Term | Meaning |
|---|---|
| Metagame | The backend. Upstream name for "everything that is not a game server" |
| DeployServer | Old name for the Director (`DEPLOYSERVER_URL`) |
| Hub | A persistent game server: Ramsgate (city) or the Training Dojo |
| Gameserver key | Shared secret game servers send; grants authority to change player data |
| `__origin` | URL prefix the DLL adds so the backend knows which official host a request was meant for |
| Changelist 647472 | The only supported game build |
| `INVALID` | Placeholder user id the hub's phantom local player sends; mapped to a configured account |
| `ponytail:` comment | A deliberate shortcut, with its limit and the upgrade path |

## Rules of the repo (from `CLAUDE.md`)

- `main` is what is deployed. Work on a branch, merge when tested.
- Push only to `HyjinnxDev/dauntless-revamped`. Pull upstream fixes with `git subtree pull`.
- Backend/Director changes need a restart; client DLL changes reach players only through a signed publish.
- Keep each version folder's AGPL-3.0 LICENSE/NOTICE files and the existing source header style.
- Never commit `.env`, `.secrets/`, the SDK or `game-data/*.json`.

See also: [Setup](setup.md) · [FINDINGS](../FINDINGS.md)
