# ParadoxBackend (overview)

> Verified against code 2026-10-24.

## What it is

`versions/1.14.7/ParadoxBackend` is the Node/TypeScript "metagame" server for Dauntless 1.14.7. It is one Express 5 app that answers everything the game client, the dedicated game servers, the Director, the player launcher and the staff console ask for: login, characters, inventory, store, progression, matchmaking, parties, guilds, launcher auth and runtime-update downloads, and the admin API. It stores data in MongoDB and also runs the XMPP chat/presence gateway and the voice relay in the same process. This page covers the HTTP layer (bootstrap, config, routes, controllers, services, middleware, tests). The other folders have their own pages (see "Connects to").

**Every source file is described in [Backend files](backend-files.md)**, which also holds the full [Route index](backend-files.md#route-index) (method, path, auth, file).

## Key files

All paths are under `versions/1.14.7/ParadoxBackend/`.

| Path | Purpose |
|---|---|
| `package.json` | npm scripts (dev, build, start, tests, generators, migrations). |
| `src/server.ts` | Process entry: safety checks, Mongo start, HTTP + HTTPS listeners, QoS listener, voice relay, graceful shutdown. |
| `src/app.ts` | Builds the Express `app`: middleware order, request logging, all `app.use` router mounts, 404 fallback. |
| `src/config/` | Env readers and startup guards (`runtimeSafety.ts`, `serviceRole.ts`, `mongoRuntime.ts`, `loggingPolicy.ts`). |
| `src/routes/*.ts` | One Express `Router` per feature area. Mostly thin: parse request, call controller/repository, shape the response. Some (`slayerLinks.ts`, `launcherUpdates.ts`, `crashReports.ts`, `content.ts`, `launcherCard.ts`) hold their own logic. |
| `src/controllers/*.ts` | Business logic (wallet, inventory transactions, matchmaking, party, store, admin, launcher auth...). Many return plain data rather than touching `res`. |
| `src/services/operationsPolicy.ts` | The only file in `services/`: singleton "operations policy" document (Guard enforcement mode + diagnostics profile). |
| `src/middleware/` | `HasParadoxBackendAuth.ts` (game/gameserver), `HasLauncherAuth.ts` (launcher), `HasAdminAuth.ts` (staff cookie session + `RequireStaff`). |
| `src/extensions/p2p.ts` | Hook interface for an optional player-hosted-hunt module; no-op defaults when absent. |
| `src/*.ts` (top level) | Domain helpers, most with `*.test.ts` siblings: `platinumWallet`, `slayerLinks`, `bountyState`, `cooldownState`, `escalationProgress`, `gauntlet`, `huntStats`, `huntPassRotation`, `ramsRewards`, `matchmakingParty`, `travelHost`, `encryptionKeyStore`, `voiceRelay`, `characterSlots`, `loadoutSlots`, `inventoryStoragePolicy`, `skuProgression`, `bannerInstanceMigration`, `validation`, `logger`. |
| `.env.example` | Template for `.env` (copy it; the real `.env` is gitignored). Some variables exist only in code; see [Config](#config). |
| `game-data/` | Local exported game data and generated store/progression JSON (Phoenix Labs data, gitignored). `game-data/README.md` explains generation. |
| `admin-ui/` | Static staff dashboard (`index.html`, `admin.js`) served at `/admin`. |
| `scripts/` | Build guard, test runner, data generators, one-off migrations, bootstrap regression test. |
| `migration-fixtures/` | Fixtures for the Mongo migration rehearsal test. |

Folders on other pages: `src/realtime/` ([realtime](backend-realtime.md)), `src/persistence/` ([persistence](backend-persistence.md)), `src/security/`, `src/observability/`, `src/diagnostics/` ([security and admin](backend-security-admin.md)).

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | `tsx watch --env-file=.env src/server.ts` (auto-reload, no build). |
| `npm run build` | Deletes `build/`, runs `tsc`. |
| `npm start` / `start:api` | `node --env-file=.env build/server.js`. `prestart` runs `scripts/ensure-build-fresh.cjs` (build freshness guard). |
| `npm test` | `scripts/run-tests.cjs`: runs every `src/**/*.test.ts` with the Node test runner (`node --import tsx --test`). |
| `test:matchmaking`, `test:realtime`, `test:auth-security`, `test:store`, `test:platinum`, `test:loadout`, `test:escalation`, `test:progression`, `test:banner-instance`, `test:inventory-storage` | Focused subsets of the same tests. |
| `test:bootstrap` | Build, then `scripts/test_bootstrap_regression.cjs`: destructive Mongo integration test. Needs `ALLOW_DB_INTEGRATION_TESTS` and a separate `MONGODB_TEST_DB`. |
| `test:mongo-migration-rehearsal` | Runs `scripts/test_mongo_schema_migration_rehearsal.cjs` against `migration-fixtures/`. |
| `platinum:generate`, `reward-cache:generate`, `ladyluck:enrich`, `generate:progression-config`, `generate:slayers-path`, `generate:ladyluck-store`, `inventory:storage-policy:generate` | Regenerate JSON under `game-data/`. A backend restart is needed afterwards. |
| `inventory:storage-migrate`, `banner:instance-migrate`, `loadout:slots-migrate`, `approval:migrate` | One-off Mongo data migrations (read `.env`). |
| `admin:bootstrap` | `scripts/bootstrap_admin.ts`: creates the first staff account. |

## How it works

### Startup (`src/server.ts`)

1. `AssertRuntimeSafety()` (`config/runtimeSafety.ts`). Refuses to boot on stale `MYSTPAX_*` env names. When `NODE_ENV=production` it also rejects `AUTH_MODE=NONE`, `ALLOW_NO_AUTH_DEV_MODE`, body/raw inventory capture flags, `REALTIME_XMPP_DEV_CITY_MUC` not `false`, a missing or `combined` `MYSTICPARADOX_SERVICE_ROLE`, a missing `MYSTICPARADOX_METRICS_TOKEN` (api role) or `MONGODB_URI`, out-of-range Mongo settings and bad ports.
2. Reads the service role. This entry point only serves `combined` (local default) or `api`.
3. Loads the TLS cert/key. In production, no valid cert means startup fails.
4. `AssertApiKeyHashSecret()` (needs `API_KEY_HASH_SECRET`), then `GetPersistenceLifecycle().start()` (Mongo connect + indexes), then registers gameserver and user API keys (`DrainAndRegisterAPIKeys`, `DrainAndRegisterUserAPIKeys`).
5. Starts the party outbox dispatcher and the optional P2P module.
6. Listens on plain HTTP (`PORT`, default 3000, bound to `HTTP_HOST`, default `127.0.0.1`) and HTTPS (`HTTPS_PORT`, default 3443). `initRealtime()` attaches the XMPP WebSocket upgrade handler to the HTTPS server. Readiness flips to ready once HTTPS listens (or at once, as `HTTP_ONLY_DEVELOPMENT`, when there is no cert outside production).
7. Starts a tiny HTTP "pong" listener on `QOS_PORT` (default 80). The game pings regions there; a bind failure is only a warning.
8. Starts the party voice relay (`voiceRelay.ts`, UDP `VOICE_UDP_PORT`, default 8791). Bind failure only loses voice.
9. SIGINT/SIGTERM: stop realtime, stop outbox, stop the P2P module, close listeners, stop persistence, with a 10 s forced exit. In production a listener error also triggers this shutdown with exit code 1.

Importing `controllers/adminServers.ts` also starts a 15 s host-metrics sampler (see [security and admin](backend-security-admin.md#admin-console)).

### Request pipeline (`src/app.ts`), in order

1. `trust proxy = loopback`.
2. `RequestContextMiddleware`: request id for every log line.
3. `/__origin/<host>/...` stripper. The injected client DLL rewrites official backend hosts (steelyard.ca, steelyard.online, ol.epicgames.com, api.epicgames.dev) to this server with the original host in the path. The middleware validates the host against an allowlist, saves it on `req.originHost`, and rewrites `req.url` so normal path routers match.
4. Optional response-body logging for `/__origin` requests (`MYSTICPARADOX_LOG_ORIGIN_BODIES=1`).
5. `Extension.http.mountEarlyRoutes`, then `express.json()` and `express.urlencoded()`.
6. Request/response logger plus Prometheus-style counters (`[REQ]` / `[RES]` lines, metric class `admin` / `health` / `launcher` / `game`). Optional body capture (`MYSTICPARADOX_BODY_CAPTURE`, refused in production).
7. `GET /`, `GET /health/live`, `GET /health/ready` (outside the rate limiter; ready needs the readiness flag and healthy Mongo; also reports online player count).
8. `express-rate-limit` for all routers below (`security/rateLimit.ts`).
9. Routers, all mounted at `/`, in this order: metrics, login, eos, system, character, inventory, store, guild, tuning, matchmaking, party, progression, loadout, friends, slayerLinks, huntStats, launcherAuth, launcherUpdates, content, news, launcherCard, launcherLogs, crashReports, adminLauncherLogs, admin. Then the `/admin` static dashboard with its CSP, extension routes, then `launcherGuardRouter`.
10. 404 fallback logs `Unstubbed route <method> <path>`. Unknown routes arriving from a `leaderboard` origin host get a canned 200 and a `[TrialsSubmitProbe]` log line (a probe for the unknown Trials submit contract, marked for removal in a code comment).

### Auth by middleware

| Middleware | Used by | Behavior |
|---|---|---|
| `HasParadoxBackendAuth` | Game routes | Accepts (a) `x-mysticparadox-gameserver-apikey` (validated by `controllers/apikeys.ts`), optionally with a player bearer JWT, or (b) a bearer game JWT (`controllers/auth.ts`). Sets `req.AuthData` (`IsGameserver: true` for server calls). Rejects accounts that are no longer eligible. See Gotchas for the `INVALID` sentinel rewrite. Several handlers add their own check (gameserver only, player only, or own userId only); see the [Route index](backend-files.md#route-index). |
| `HasLauncherAuth` | Most `/launcher/v1/*` routes, `/content/v1/files/*`, non-stable runtime downloads (plus the tester role) | Validates a launcher-audience JWT and an active refresh-session family. Game and launcher tokens are intentionally not interchangeable. Sets `req.LauncherAuthData`. Register, login, refresh, Discord start/callback/complete, `GET /launcher/v1/username`, `/launcher/v1/status`, `/launcher/v1/info*`, stable runtime downloads and the launcher updater are public. |
| `HasAdminAuth` + `RequireStaff(permission)` | `/admin/v1/*` (except login and Discord sign-in) | Cookie `mysticparadox_admin`, hashed session lookup, staff-rank check, `x-csrf-token` header for non-GET. Details in [backend-security-admin.md](backend-security-admin.md). |

## Route modules (mounted at `/` in `app.ts`)

Path prefix -> route file -> where the logic lives. Per-route auth is in the [Route index](backend-files.md#route-index).

| Path prefix | Route file | Logic lives in | Auth (mostly) |
|---|---|---|---|
| `/internal/v1/metrics` | `routes/metrics.ts` | `observability/metrics.ts` | metrics token |
| `/login`, `/accountinfo*`, `/tags`, `/gamesession/epic*`, `/migration/*`, `/features/platform/win`, `/account/link/epic/*`, `/isbanned` | `routes/login.ts` | `controllers/login.ts` | game (the last three none) |
| `/account/api/oauth/*`, `/account/api/public/account*` (EOS-style account API) | `routes/eos.ts` | `controllers/auth.ts`, `controllers/login.ts`, `security/runtimeAuthorization.ts` | none (token exchange, lookups) / game (bulk lookup) |
| `/dauntless-status`, `/heartbeat`, `/event`, `/crash/CrashReporter/*`, `/survey/config`, `/motd/`, `/entitlementsv2`, `/playertreatments`, `/escalation/*`, `/cooldown/*`, `/bounty/*`, `/huntpass/*`, `/progression/config`, `/trials/leaderboards/*`, `/all/`, `/patchnotes/*`, Gauntlet host routes | `routes/system.ts` | `controllers/entitlements.ts`, `escalationProgress.ts`, `cooldowns.ts`, `bounty.ts`, `progression.ts`, top-level `gauntlet.ts`, `huntPassRotation.ts` | game (status stubs none) |
| `/character` | `routes/character.ts` | `controllers/character.ts` | game |
| `/inventory*` | `routes/inventory.ts` | `controllers/inventory.ts`, `wallet.ts`, `challengeRewards.ts` | game; grants/spends gameserver only |
| `/reconcile`, `/creator`, `/balance`, `/product/sku*`, `/token/*`, `/notification/*` | `routes/store.ts` | `controllers/store.ts`, `wallet.ts`, `auth.ts` | game |
| `/guild*` | `routes/guild.ts` | `controllers/guild.ts` | player (create also gameserver) |
| `/game_tuning/*` | `routes/tuning.ts` | static data in the route file | none |
| `/candidate*`, `/key/generate`, `/key/consume`, `/QoS` | `routes/matchmaking.ts` | `controllers/matchmaking.ts`, `party.ts`, top-level `matchmakingParty.ts`, `travelHost.ts`, `encryptionKeyStore.ts` | game |
| `/party*`, `/mystic/party/*` (hunt offer, join-hunt) | `routes/party.ts` | `controllers/party.ts`, `matchmaking.ts` | game; `/mystic/party/*` voice ticket |
| `/encountered-content*`, `/progression/*`, `/pjm*`, `/breadcrumbs*`, `/weapon_tracker/*` | `routes/progression.ts` | `controllers/progression.ts`, `slayersPath.ts`, `wallet.ts` | game; writes gameserver only |
| `/loadout/*` | `routes/loadout.ts` | `controllers/loadout.ts`, `starterManifest.ts`, top-level `loadoutSlots.ts` | game |
| `/friends/api/*` | `routes/friends.ts` | repositories directly | game (stubs none) |
| `/slayerlink/*` | `routes/slayerLinks.ts` | top-level `slayerLinks.ts`, inventory controller | player (rewards and unlink also gameserver) |
| `/mystic/hunt-stats` | `routes/huntStats.ts` | top-level `huntStats.ts` | gameserver |
| `/launcher/v1/auth/*`, `/launcher/v1/me`, `/launcher/v1/username`, `/launcher/v1/game-sessions`, `/launcher/v1/characters*`, `/launcher/v1/policy`, `/launcher/v1/status` | `routes/launcherAuth.ts` | `controllers/launcherAuth.ts`, `characters.ts`, `discordAuth.ts`, `launcherPolicy.ts` | launcher / none |
| `/launcher/v1/runtime/*`, `/launcher/v1/guard-manifests/*`, `/launcher/v1/admin/*`, `/launcher/v1/updates/*` (signed runtime and launcher downloads, publishing) | `routes/launcherUpdates.ts` | the route file itself (files under `LAUNCHER_UPDATE_ROOT`) | stable public, other channels tester, publishing publisher key |
| `/launcher/v1/guard/*` | `routes/launcherGuard.ts` (mounted last) | `controllers/launcherGuard.ts` | launcher |
| `/content/v1/manifest`, `/content/v1/files/*` | `routes/content.ts` | the route file (`GAME_CONTENT_MANIFEST`, `GAME_CONTENT_DIR`) | manifest none, files launcher |
| `/content/v1/news*` | `routes/news.ts` | Discord bot HTTP API at `DISCORD_BOT_URL` | none |
| `/launcher/v1/info*`, `/admin/v1/launcher-card*` | `routes/launcherCard.ts` | Mongo collection `launcher_card` | none / staff `operations` |
| `/launcher/v1/logs/*` | `routes/launcherLogs.ts` | files under `LAUNCHER_LOG_STORAGE_DIR` | launcher + tester role |
| `/crash/v1/reports/*` | `routes/crashReports.ts` | files under `CRASH_REPORT_STORAGE_DIR`, GitHub issues (`GITHUB_CRASH_REPO`, `GITHUB_CRASH_TOKEN`) | none (rate limited) |
| `/admin/v1/launcher-logs*` | `routes/adminLauncherLogs.ts` | same files as `launcherLogs.ts` | `x-sync-token` (`LAUNCHER_LOG_SYNC_TOKEN`) |
| `/admin/v1/*` (auth, players, audit, operations, servers) | `routes/admin.ts` | `controllers/admin.ts`, `adminDiscordAuth.ts`, `adminOperations.ts`, `adminServers.ts` | staff |

## Controllers and services

- Controllers are grouped by feature, one file each (see [Backend files](backend-files.md#srccontrollers)). Biggest: `inventory.ts` (transactional inventory changes with canonical-hash idempotency and conflict errors), `progression.ts`, `guild.ts`, `matchmaking.ts`, `character.ts`, `starterManifest.ts` (new-player bootstrap manifest), `launcherAuth.ts`, `store.ts`.
- `wallet.ts` owns currencies and prestige gating; `store.ts` turns `game-data/*_store.json` (plus generated hunt pass, coin toss and Middleman SKUs) into SKUs by store tag (tested by `storeRegistry.gamedata.test.ts`).
- `controllers/apikeys.ts` and `controllers/auth.ts` hash and register gameserver and user API keys at startup, and sign/validate the game JWT and store purchase tokens (keys from `AUTH_SIGNING_*`).
- Every dedicated-server inventory grant passes `ramsRewards.ts` (Rams/Patrol Key/Platinum payout rules and, since 2026-10-23, the cell-core upgrade roll) inside `RunInventoryTransaction`.
- `services/operationsPolicy.ts`: reads/writes one Mongo document (`operationsPolicy`, id `global`) with an optimistic `version`. Fields: `guardEnforcement` (`ENFORCE` default, or `OBSERVE`) and `diagnosticsProfile` (`PRODUCTION` default, or `DEVELOPMENT`). Weakening either is flagged by `OperationsPolicyWeakeningCodes`. Changed through `PATCH /admin/v1/operations/policy`; the bundled `admin-ui` has no page for it.
- `extensions/p2p.ts`: `GetP2PExtension()` loads an optional `src/p2p` folder if present (not in this repo). Shared code only calls its hooks (http mount/auth/metric class, server start/stop, safety checks, inventory authorization, hunt routing). `MYSTICPARADOX_P2P_MODULE=off` forces the dedicated-only defaults.
- Most matchmaking state (candidates, party hunt instances, UDP encryption keys) lives in process memory and is lost on restart.

## Tests layout

- No separate `tests/` folder. Tests sit next to the code as `src/**/*.test.ts` (Node built-in runner via `tsx`).
- Files named `*.gamedata.test.ts` read the real local `game-data/` JSON. `scripts/run-tests.cjs` skips them when any required game-data file is missing (fresh public checkout) and lists what was skipped. `PARADOX_GAME_DATA_DIR` points it elsewhere.
- `src/characterDelete.test.ts` needs a real replica set in `CHARACTER_TEST_MONGODB_URI` and is skipped otherwise.
- `scripts/test_bootstrap_regression.cjs` and the migration rehearsal are integration-style and live in `scripts/`. `scripts/test_api_listener_failclosed.ps1` checks listener fail-closed behavior.

## Connects to

- MongoDB: via `persistence/` and `config/mongoRuntime.ts`. See [backend-persistence.md](backend-persistence.md).
- XMPP chat/presence, party outbox, voice relay, WebSocket upgrade on the HTTPS port: see [backend-realtime.md](backend-realtime.md).
- Security helpers (JWT, rate limit, staff roles, API key hashing), metrics, diagnostics, admin console: see [backend-security-admin.md](backend-security-admin.md).
- Game client (through the DLL's `/__origin` redirect over HTTPS, 3443 or 443): see [runtime.md](runtime.md).
- Director and game servers: game servers call the backend with the gameserver API key (`GAMESERVER_API_KEYS` here matches the Director's `METAGAME_API_KEY`). The backend calls the Director at `http://$DEPLOYSERVER_URL`: matchmaker and hub/hunt status routes without a key, `/api/admin/*` with header `x-api-key` set to the first gameserver key. See [director.md](director.md).
- Launcher: [launcher.md](launcher.md) uses `/launcher/v1/*` and `/content/v1/*`; runtime update files come from the publish flow in [paradox-launcher.md](paradox-launcher.md).
- Discord bot: [discord-bot.md](discord-bot.md) (news through `DISCORD_BOT_URL`; status uses `/health/ready` player count).
- Slayer's Ledger companion site reads the `huntStats` collection written by `POST /mystic/hunt-stats`.
- Restart and hosting: [host-scripts.md](host-scripts.md), [setup.md](setup.md).

## Config

Real values live in the gitignored `.env`. It is loaded by `--env-file=.env` in the dev/start scripts, not by app code; a variable already set in the process environment wins over `.env`.

### Variables in `.env.example`

| Variable | Default | Effect |
|---|---|---|
| `PORT` | 3000 | Plain HTTP port (health, Director/game-server calls, bot). |
| `HTTPS_PORT` | 3443 | HTTPS + XMPP port for game clients and launchers; 443 in production. |
| `PARADOX_CERT_PEM_PATH`, `PARADOX_KEY_PEM_PATH` | `../ParadoxCertificates/paradox.mysticfox.dev-chain.pem` / `-key.pem` | TLS full chain and key. The cert is also read for the launcher-card invite fingerprint. |
| `PARADOX_KEY_PASSPHRASE` | none | Passphrase of the encrypted key; without it HTTPS does not start. |
| `AUTH_MODE` | none (login then answers 500) | `LAUNCHER` (exchange codes from the launcher), `APIKEY` (exchange_code is a user API key) or `NONE` (dev). |
| `ALLOW_NO_AUTH_DEV_MODE` | off | Literal `true` plus non-production enables `AUTH_MODE=NONE` and, in `LAUNCHER` mode, logs in an unknown exchange code as a user of that name. |
| `AUTH_SIGNING_PRIVKEY_B64`, `AUTH_SIGNING_PUBKEY_B64` | required | Base64 PEM RS256 keypair for every JWT (game, launcher, voice, store). |
| `API_KEY_HASH_SECRET` | required | 32+ chars; HMAC secret for stored API key hashes. Rotating it invalidates every stored key. |
| `GAMESERVER_API_KEYS` | empty | Comma-separated gameserver keys. Non-empty = the complete set, re-synced at boot; empty keeps the stored keys. The first key is also used to call the Director's admin API; every key may sign hub voice position reports. |
| `MYSTICPARADOX_RATE_LIMIT` | on | `off`/`0`/`false`/`no` disables the global per-IP budget. |
| `MYSTICPARADOX_RATE_LIMIT_PER_MINUTE` | 600 | Requests per minute per IP. |
| `MYSTICPARADOX_GAMESERVER_RATE_LIMIT_PER_MINUTE` | 6000 | Same, for gameserver-keyed requests. |
| `MYSTICPARADOX_BOUNTY_PERSISTENCE` | on | `off` makes `/bounty/*` stubs that discard saves. |
| `MYSTICPARADOX_COOLDOWN_PERSISTENCE` | on | `off` makes `/cooldown/*` stubs that discard saves. |
| `MYSTICPARADOX_ECONOMY_MONITOR` | on | `off` silences `[PrestigeMon]`/`[DraftMon]`/`[GrantMon]`. |
| `MONGODB_URI` | required | Mongo connection string (replica set). |
| `MONGODB_DB` | `mystpax` | Database name. |
| `MONGODB_APP_NAME` | `paradox-backend` | Driver app name. |
| `MONGODB_CONNECT_TIMEOUT_MS`, `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | 5000 | 250-30000. |
| `MONGODB_MAX_POOL_SIZE` | 20 | 1-500. |
| `MONGODB_MAX_IDLE_TIME_MS` | 60000 | 0-300000 (0 = no limit). |
| `MONGODB_TRANSACTION_MAX_COMMIT_TIME_MS` | 2000 | 250-30000. |
| `MYSTICPARADOX_SERVICE_ROLE` | `combined` | `combined` (local) or `api`; production must set `api` explicitly. |
| `ALLOW_DB_INTEGRATION_TESTS`, `MONGODB_TEST_DB` | blank | Opt-in and target DB for the destructive `test:bootstrap` suite. Leave blank in deployments. |
| `TARGET_CHANGELIST` | none | The supported game build (647472). Unset fails every launch closed; also used in `serverInfo.buildId` and the runtime/Guard manifest checks. |
| `QOS_TARGET_URL` | none | The single region URL served by `/candidate/regions`. |
| `MATCHMAKING_MODE` | none | `DEPLOYSERVER` (use the Director) or `DISABLED`; anything else logs fatal and refuses travel. |
| `DEPLOYSERVER_URL` | none | Director `host:port` (plain HTTP). |
| `MYSTICPARADOX_METRICS_TOKEN` | none | Token for `/internal/v1/metrics`; required in production. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | none | Discord app for launcher and staff sign-in. |
| `DISCORD_REDIRECT_URI` | none | Launcher Discord OAuth redirect. |
| `LAUNCHER_DEEPLINK_SCHEME` | `mysticparadox` | Deep-link scheme the Discord callback redirects to. |
| `LAUNCHER_ALLOWED_ORIGINS` | none | Extra CORS origins for `/launcher/*` (always allowed: `http://localhost:1420`, `https://tauri.localhost`). |
| `APPROVED_EXECUTABLE_SHA256` | none | Comma-separated lowercase SHA-256 of approved game exes; empty rejects every launch. |
| `ADMIN_ALLOWED_ORIGINS` | dev: `http://localhost:4173`, `http://localhost:5174`; production: none | Cross-origin callers allowed on `/admin/v1` (the same-origin `/admin` page always works). |
| `ADMIN_TOTP_SECRET` | none | Base32 TOTP for password staff login; required in production. |
| `ADMIN_OPERATIONS_TOTP_SECRET` | `ADMIN_TOTP_SECRET` | Step-up TOTP for weakening the operations policy. |
| `ADMIN_COOKIE_SECURE` | auto | `true`/`1` forces `Secure` on staff cookies outside production. |
| `ADMIN_DISCORD_REDIRECT_URI` | none | Staff Discord OAuth redirect (HTTPS). |
| `ADMIN_FRONTEND_URL` | none | Where staff Discord sign-in lands. |
| `ADMIN_DISCORD_ALLOWED_IDS` | none | Discord user ids allowed to sign in as admin. |
| `LAUNCHER_UPDATE_ROOT` | `./updates` | Root of runtime/launcher/Guard release files. |
| `UPDATE_PUBLISHER_API_KEY` | none | `x-update-api-key` secret for the publish routes. |
| `UPDATE_PUBLIC_BASE_URL` | `https://paradox.mysticfox.dev` | Base of the download URLs written into published runtime manifests. |
| `UPDATE_PUBLISHER_ALLOWED_IPS` | none (deny) | Source IPs allowed to publish. |
| `RUNTIME_EXTRA_FILES` | none | Extra runtime file names accepted besides `winmm.dll`. |
| `REALTIME_XMPP_ENABLED` | off | Literal `true` enables the XMPP WebSocket. See [realtime](backend-realtime.md). |
| `REALTIME_XMPP_CAPTURE` | on when enabled | `false` silences XMPP protocol capture logs. |
| `REALTIME_XMPP_WS_PATHS` | `//,/,/__ws/xmpp` | Accepted WebSocket upgrade paths. |
| `REALTIME_XMPP_ALLOWED_HOSTS` | any | Host allow-list for the upgrade. |
| `REALTIME_XMPP_DEV_CITY_MUC` | on when unset (`.env.example` sets `false`) | Lets any user join any City MUC (Ramsgate chat). Must be `false` in production. |
| `MYSTICPARADOX_INV_CAPTURE`, `MYSTICPARADOX_INV_CAPTURE_RAW`, `MYSTICPARADOX_INV_CAPTURE_FILTER` | off | `[INV-CAP]` inventory capture; `_RAW` adds full JSON (refused in production); `_FILTER` regex of catalog ids. |
| `MYSTICPARADOX_BODY_CAPTURE` | off | Logs POST bodies of economy paths; refused in production. |
| `LOG_LEVEL` | `info` | Production log level (info/warn/error/fatal only). |
| `MYSTICPARADOX_DEVELOPMENT_LOG_LEVEL` | `debug` | Log level while the DEVELOPMENT diagnostics profile is active. |
| `HUNT_GO_NOW_MIN_DELAY_MS`, `HUNT_GO_NOW_MAX_DELAY_MS` | 10000 / 20000 | Release window after a hunt server is ready. |
| `CRASH_REPORT_STORAGE_DIR` | `../MysticCrashReports` | Crash report folder. |
| `GITHUB_CRASH_REPO`, `GITHUB_CRASH_TOKEN` | none | Crash reports to GitHub issues (both needed). |
| `ADMIN_LOG_DIR` | none | Folder with `backend.log`, `director.log`, `director-build.log`, `restart.log`; `host-metrics.csv` is written there. Unset hides the Logs page. |
| `ADMIN_RESTART_SCRIPT` | none | PowerShell script the restart buttons run. Unset disables them. |

### Variables read only in code

| Variable | Default | Effect |
|---|---|---|
| `NODE_ENV` | unset | `production` turns on the safety checks, Secure cookies, the staff MFA requirement and stricter defaults. |
| `HTTP_HOST` | `127.0.0.1` | Bind address of the plain HTTP port. |
| `QOS_PORT` | 80 | QoS "pong" listener. |
| `VOICE_UDP_PORT` | 8791 | Voice relay UDP port (also returned to the launcher). |
| `DEV_USER_ID` | `dev-user` in `routes/eos.ts`, `mystpax` elsewhere | Dev account id and the fallback no-player identity. |
| `DEV_USER_NAME` | `Dev Slayer` | Name of an auto-created dev account. |
| `GAMESERVER_NO_PLAYER_USER_ID` | `DEV_USER_ID` | Account used for gameserver requests with no player (hub phantom player). |
| `LAUNCHER_INVITE_CODES` | none | Comma-separated invite codes; registering with one approves the account at once (email optional). The first valid one goes into the launcher-card invite link. |
| `LAUNCHER_LOG_SYNC_TOKEN` | none | `x-sync-token` for `/admin/v1/launcher-logs*`. |
| `LAUNCHER_LOG_STORAGE_DIR` | `../MysticLauncherLogs` | Tester log upload folder. |
| `GAME_CONTENT_MANIFEST`, `GAME_CONTENT_DIR` | none | Game file manifest JSON and install folder for `/content/v1/*`; either unset = 404. |
| `GAME_CONTENT_DOWNLOAD_BASE_URL` | none | HTTPS CDN base (R2) added to the manifest as `downloadBaseUrl`. |
| `DISCORD_BOT_URL` | none | Discord bot HTTP base for launcher news; unset = 404. |
| `GUARD_ENFORCEMENT_OVERRIDE` | none | `OBSERVE` forces observe mode in the served policy. |
| `MAX_CHARACTER_SLOTS` | 2 | Characters per launcher account. |
| `GAUNTLET_SEASON` | season index % 5 + 1 | Pins the Gauntlet season number. |
| `GAMESERVER_HUNTPASS_ID` | none | Pins every player's internal hunt pass slot (debugging); it is still published as `season43`. |
| `GAMESERVER_WIDEN_HUNTPASS_WINDOWS` | 1 | `0` serves `progression_config.json` without hunt pass window rewriting. |
| `GAMESERVER_RECENT_SEASONS` | `season43..season50` | Placeholder season paths added to the config. |
| `GAMESERVER_OBJECTIVES_AS_CONFIG` | 0 | `1` serves the paths config at `/progression/objectives/:userId` (old A/B test). |
| `GAMESERVER_CHARACTER_EMPTY_ID`, `_EMPTY_LIST`, `_DECODE_NESTED`, `_DATA_OBJECT`, `_SINGLE_OBJECT` | 0 | `/character` response-shape experiments; leave off. |
| `COHORT_TREATMENT_LEGACY` | 1 | `0` serves an empty `/playertreatments` list. |
| `GUILD_MAX_MEMBERS` | 100 | Guild member cap (1-10000). |
| `GUILD_INVITE_TTL_DAYS` | 7 | Guild invite lifetime. |
| `GUILD_NAME_DENYLIST` | none | Extra banned words for guild names. |
| `GUILD_RESERVED_NAMES` | on | `0` allows reserved guild names. |
| `GUILD_CREATE_ACTIVITY_FALLBACK` | off | `1` lets a gameserver guild create pass with any recent validate by the leader. |
| `MYSTICPARADOX_LOG_ORIGIN_BODIES` | 0 | `1` logs response bodies of `/__origin` requests. |
| `MYSTICPARADOX_P2P_MODULE` | on | `off` ignores an installed P2P module. |
| `REALTIME_XMPP_DEV_HUNT_MUC`, `REALTIME_XMPP_RECONNECT_GRACE_MS` | on / 45000 | Realtime options; see [realtime](backend-realtime.md). |
| `PARADOX_GAME_DATA_DIR` | `game-data/` | Game-data folder (tests and runtime). |
| `CHARACTER_TEST_MONGODB_URI` | none | Enables `characterDelete.test.ts`. |

## Gotchas

- Code changes and game-data regeneration need a backend restart. Ask before restarting the live server.
- All routers mount at `/`, so mount order in `app.ts` matters. `system.ts` holds regex Gauntlet routes (`/progression/...`, `/rewards/...`, `/leaderboard/...`) and a POST catch-all that act only for a `gauntlet` origin host and pass everything else on with `next()`. `/progression/config` in `system.ts` wins over `GET /progression/:userId` in `progression.ts` because it is mounted first.
- Everything the real game calls arrives with the `/__origin/<host>` prefix first. If a new client call 404s, look for `origin=` in the `[REQ]` line and the "Unstubbed route" warning.
- `HasParadoxBackendAuth` has a single-account fallback for the hub's phantom local player: a gameserver GET with `INVALID` in the path is rewritten to `GAMESERVER_NO_PLAYER_USER_ID` (else `DEV_USER_ID`, else `mystpax`). A gameserver request with no player bearer is also attributed to that user id. Set it deliberately on public servers.
- A gameserver request that forwards an expired or invalid player bearer gets 401 from `HasParadoxBackendAuth` (it does not fall back to the no-player identity). A hunt that outlasts the player's token loses that player's gameserver writes.
- Slayer's Path node objectives are live `UObjective`s on the game server; `objective_amount` in `/pjm` and rows in `/progression/objectives` do not drive them (the server overwrites `objective_amount` on its next `/pjm` save and keeps `objective_status`). The banked-XP nodes' `PrestigeXP_PJMNode_0N` are `ObjectiveData_PrestigeTrackXP` (`PrestigeCount` 1/2/4/6/8, counted on `OnPlayerExperiencePrestiged`), i.e. weapon prestige levels, which need XP on `PrestigeTrack_Weapon_*`. The game counts them only per reforge made while the objective listens; the server DLL's `MpReforgeObjectiveSync` raises them to the player's real reforge count (`PrestigeTrack_Weapon_*` progress, +1 per reforge). `progression_config.json` gives those tracks 1000 XP ranks while a reforge grants 1 XP; the client's own table has one rank, so do not read reforge level from that curve.
- Production refuses to start with dev conveniences on (`AUTH_MODE=NONE`, capture flags, `combined` role). Local dev works with a blank role.
- Two tokens, two audiences: a launcher JWT never works on game routes and vice versa.
- `*.gamedata.test.ts` files are skipped on machines without `game-data/`; update their expected counts when data is regenerated on purpose.
- The plain HTTP port is loopback-only by default. Set `HTTP_HOST` only if the Director or bot runs on another machine.
- The old `MYSTPAX_` env prefix was renamed `MYSTICPARADOX_`; old names stop the server at startup.
- Port 80 (`QOS_PORT`) must be free or region pings fail (the game still works but travels with no region).
- The base bounty game data (`routes/tuning.ts`) must carry grant windows covering now: the bounty component derives its season dates from them (no active window = the hub leaves the map). The end date rolls (1 January two years ahead).
- **Hunt pass seasons flip every two weeks** (Thursday 17:00 UTC, `huntPassRotation.ts`). A player gets the new pass at their next login; the persistent hubs (Ramsgate, Dojo) cache `/progression/config` until they restart. The client's Challenges (`UBountyComponent_Weekly`, "Week N") follow `season43`'s window, which is why every player's served pass is published as `season43` (a 2099 placeholder there showed "~27000 days" to unlock). Week N opens at the path's `start_date` + 7 days x (N-1), so `HuntPassPathWindow` starts the path 10 weeks before the season: all 11 challenge weeks (`43_<week>_<n>_Challenge_Season_*`, 10 each) are open from day one, and the window stays 84 days (the client builds one week entry per 7 days; an 80-year window once froze it). The backend never resets challenge progress (`bountyState.ts` serves one fixed bounty season 2020-2099 and keeps weekly claims); whether the game server resets it when season43's window moves (`UBountyComponent_Weekly::ServerResetChallengeSeason`) is unverified. If it does not, the 110 challenges are a one-time set.
- Matchmaking candidates, party hunt instances and UDP keys are in memory: a backend restart forgets in-flight travel.
- Party hunts launch once per party at a time (`PartyLaunchInFlight` in `controllers/matchmaking.ts`): a second `/candidate/join` for the same hunt while the server is still starting waits for that launch and reuses it. Members who cancelled since the launch began (`WasCancelledSince`) are not written back in.
- The log file `../debug/metagame/metagame.log` is truncated on every start.
- `app.ts` ends with a JSON error handler (`{error: "bad_request"|"internal_error"}`, 5xx logged as `[HTTP] ... failed`). Without it Express sent stack traces with local paths as HTML. A failed startup (`Main()` throws) now exits with code 1 through `GracefulShutdown("STARTUP_FAILED")` instead of staying up with nothing serving.
- A store SKU that is only progression (rank skips: no `items`, no `entitlements`) and would grant nothing (already at max rank) is refused with 409 `nothing_to_grant` and the debit rolled back (`NothingToGrantError` in `controllers/store.ts`).
- `GET /product/sku/:id` resolves the hunt pass Elite for the player's served slot (the id stays `season43_premium` for every pass), the same SKU `PurchaseStoreSku` sells.

## See also

[backend-files.md](backend-files.md), [index.md](index.md), [setup.md](setup.md), [backend-realtime.md](backend-realtime.md), [backend-persistence.md](backend-persistence.md), [backend-security-admin.md](backend-security-admin.md), [director.md](director.md), [runtime.md](runtime.md), [launcher.md](launcher.md)
