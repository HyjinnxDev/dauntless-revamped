# Legacy 1.4.4: Gateway, DeployServer and deploy kits

> Verified against code 2026-10-24.

## What it is

Three pieces that sit between the players and the game servers of the [legacy 1.4.4 stack](legacy-1.4.4.md):

- **`UndauntedDeployServer/`** - Node/Express service (loopback port 61001) that starts, tracks and stops game-server processes (the game exe with the [injected DLL](legacy-1.4.4-internal-server.md)). The 1.4.4 equivalent of [director](director.md). Can forward launches to remote worker DeployServers over loopback SSH tunnels (EU overflow, Australia, Germany, US).
- **`UndauntedGateway/`** - public front door in "public mode": a TLS reverse proxy (port 443) that exposes only the routes players need, plus an admin-rights helper that opens the game UDP ports in the Windows firewall only for IPs that logged in.
- **`deploy/`** - install and run kits for Windows Server (PowerShell), Linux (systemd, Proton/Wine) and OpenBSD (pf, rc.d, Linux game worker). Not the repo-root `deploy/` (see [deploy](deploy.md)).

## DeployServer file reference

All under `versions/1.4.4/UndauntedDeployServer/src/`. Package `dauntless-revived-deploy-server` 0.0.5. Runtime imports only `express` and `pino`; `better-sqlite3`, `drizzle-orm`, `jsonwebtoken`, `dotenv` in `package.json` are unused.

| File | What it does |
|---|---|
| `src/server.ts` | Entry. Throws if `SERVER_ROLE=database-only`. Listens on `BIND_HOST` (default 127.0.0.1):`PORT`, calls `StartupAndReportFailure`, runs `RunWatchdog` every 60 s |
| `src/app.ts` | Express app: JSON/urlencoded body parsers, mounts `matchmakingRouter` at `/api/matchmaker` and `gameserversRouter` at `/` |
| `src/logger.ts` | pino logger, level `LOG_LEVEL`, pino-pretty unless `NODE_ENV=production` |
| `routes/matchmaker.ts` | `POST /api/matchmaker/handle-matchmaking-for-player`. 403 unless `IsDirectLoopbackRequest`. Validates `Region` (`main/aus/ger/us/mixed`, else 400 `invalid_region`) and body via `CheckMatchmakingRequest` (400 `bad_request`). Calls `HandleMatchmakingRequest`; `CapacityUnavailable` -> 503 `capacity_unavailable` + `Retry-After: 10`; other errors -> 500 `no_game_server` |
| `routes/gameservers.ts` | `GET /gameservers` -> `{servers, complete, capacity}`: local servers (`DescribeGameservers` + `connectedPlayers` from native occupancy) plus overflow/aus/ger/us worker snapshots; `capacity` = `huntAdmission.status()` + CPU status. Exports `IsLoopbackAddress`, `IsDirectLoopbackRequest` (peer 127.x/::1 and none of the proxy headers `x-dauntless-gateway`, `x-forwarded-for`, `forwarded`, `x-real-ip`, `x-forwarded-host`, `x-forwarded-proto`, `via`) |
| `controllers/gameservers.ts` | Core. `Gameservers` list, port pool `FreePorts` (`PORT_RANGE_BEGIN`..`PORT_RANGE_END-2`; last port Ramsgate, one before it Training Dojo). `StartServer` (CPU check, `huntAdmission.reserve`, serial launch queue, `SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP` spacing) -> `StartServerNow` (memory reservation, port pick, ready file, spawn). `GetRamsgateConnectionDetails` (city pool or single Ramsgate), `GetTrainingDojoConnectionDetails` (on demand), `StartupGameserverWithArgs` (tutorial map+behemoth from GameArgs), `StartupGameserverWithHuntIdAndPlayers` (hunt tables lookup), Trials rotation (`TRIAL_ROTATION_START` default `2019-07-18T18:00Z`, `TrialBehemothForWeek`, `GetTrialsData`, `ValidateTrialPool`), `CleanupServer`, `StopExpiredHunt`, `KindOfGameserver` (`city/hunt/dojo/tutorial`), `DescribeGameservers`, `Startup`, `CityPoolEnabled` (`RAMSGATE_POOL!=0`), `IsPersistentWorldLivenessOn` (`PERSISTENT_WORLD_LIVENESS!=0`), test hooks |
| `controllers/matchmaker.ts` | `HandleMatchmakingRequest`: worker guards (`HUNT_WORKER=1` accepts only ISLAND, plus CITY with `WORKER_RAMSGATE=1`, SHARED with `WORKER_DOJO=1`; `AUS_RESERVED_HUNTS` keeps slots for explicit OCE on overflow requests). Wraps everything in `RegionalRouter`; inside, CITY with pool off and `CITY_OVERFLOW=1` goes to `CityRouter`, else `HuntRouter` -> `HandleLocalMatchmaking` (CITY -> Ramsgate, SHARED `ShatteredIsles_TrainingDojo` -> Dojo, ISLAND -> args or hunt id; unresolved -> Ramsgate on primary, error on worker). City occupancy for `CityRouter` from Metagame `GET 127.0.0.1:61000/undaunted/api/ServerStatus` with `CITY_STATUS_KEY` |
| `controllers/matchmakinginput.ts` | `CheckMatchmakingRequest`: hunt id `^[A-Za-z0-9_+]{1,128}$`, ISLAND GameArgs must be `/Game/...` map + behemoth asset path, ExpectedPlayers at most 16 account ids. Second line after the Metagame's own check |
| `controllers/capacity.ts` | `CapacityUnavailable` (`memory/ports/hunts/cpu`). `HuntLimit` (`MAX_LOCAL_HUNTS`, or `MAX_HUNTS` when `HUNT_WORKER=1`; `auto` = port range minus 2, needs CPU+memory guards). `HuntAdmission` (max 2 pending, running+pending < limit). `MemoryAdmission`/`memoryAdmission` (`GAMESERVER_MEMORY_GUARD=0` disables; `GAMESERVER_MIN_FREE_MB` 3072, `GAMESERVER_STARTUP_MB` 1536, `GAMESERVER_HUNT_STARTUP_MB`, `GAMESERVER_RESERVATION_SECONDS` 60) |
| `controllers/cpuadmission.ts` | `CpuAdmission`/`cpuAdmission`: samples all-CPU usage every 2 s, smoothed, blocks new hunts at `GAMESERVER_CPU_LIMIT_PERCENT` (80) until below `GAMESERVER_CPU_RESUME_PERCENT` (65). `CheckCpuAdmission` only when `GAMESERVER_CPU_GUARD=1`. Never evicts |
| `controllers/citypool.ts` | `CityPool`: pooled Ramsgate instances, `CITY_PLAYER_LIMIT` 20 each; serialised allocation, 180 s seat leases, cities that just emptied are treated as retiring, unknown counts never prove free seats; starts a new city when none fits |
| `controllers/cityrouter.ts` | `CityRouter.launch`: balances one Ramsgate between local and overflow worker by occupancy + 45 s reservations, limit `RAMSGATE_PLAYER_LIMIT` (default 28, max 32) |
| `controllers/overflow.ts` | `OverflowUrl` (`OVERFLOW_DEPLOYSERVER_URL`, must be `http://127.0.0.1:<port>/`). `RemoteLaunch`: probe worker `GET /gameservers`, then `POST /api/matchmaker/...` (120 s); refused/capacity -> `undefined` (local fallback), timeout/ambiguous -> throw (no duplicate). `HuntRouter`: ISLAND prefers worker once running+pending >= `OVERFLOW_AFTER_HUNTS` (4), falls back either way on capacity. `ReadWorkerSnapshot`, `DescribeOverflowSnapshot` |
| `controllers/regions.ts` | `AusUrl(region)` (`AUS_/GERMANY_/US_DEPLOYSERVER_URL`, loopback tunnels). `RegionalRouter.launch`: `ger`/`us` go only to that worker (checks `GERMANY_PUBLIC_HOST`/`US_PUBLIC_HOST`); `aus` goes to AUS first, no silent fallback (checks `AUS_PUBLIC_HOST`); `mixed` picks lower `Utilization`; `main` runs locally, on capacity spills to AUS (respecting `AUS_RESERVED_HUNTS`) and Germany. `DescribeAusSnapshot` |
| `controllers/readiness.ts` | `WaitForServerReady` (up to 90 s): ready file content `<pid>:<port>` from the DLL, or (older DLLs) two consecutive `IsUdpPortBound` samples; fails if the child exits. Deletes the ready file after |
| `controllers/nativeoccupancy.ts` | `NativeOccupancy`: parses `connections=` from the tail of `GAMESERVER_READY_DIR/native-fault-<pid>.log` (fresh within 90 s). `NativeCityOccupancy`: reads `city-occupancy-<pid>.txt` (`<pid> <count>`, fresh within 2.5 s) |
| `controllers/huntlifetime.ts` | `HuntLifetime.reason`: `maximum_age` after `HUNT_MAX_AGE_MINUTES` (120), `empty` after `HUNT_EMPTY_MINUTES` (3) of zero connections once past `HUNT_STARTUP_GRACE_MINUTES` (5). Ramsgate/Dojo exempt. `HuntLifetimeFromEnv` |
| `controllers/watchdog.ts` | `RunWatchdog`: dead process -> `CleanupServer` (Ramsgate/Dojo restart); live hunt past lifetime -> `StopExpiredHunt` |
| `src/vendor/*.json` | Game hunt tables: `matchmaker_hunts_table.json`, `player_hunts_table.json`, `trials_hard_table.json`, `trials_elite_table.json`, `trials_pool.json`. Game data: describe, do not paste |

### Launching a game

1. **Startup** (`Startup`): fill `FreePorts`. If `HUNT_WORKER=1` and `WORKER_RAMSGATE!=1`, stop. With the city pool off (`RAMSGATE_POOL=0`) start Ramsgate now; with the pool on (default) cities start on demand. Dojo at boot only with `ENABLE_DOJO=1`.
2. **Request** from the Metagame: `{GameMode, GameArgs, HuntId, ExpectedPlayers, Region?, Overflow?}`.
3. **Routing**: `RegionalRouter` -> (`CityRouter` for non-pooled city overflow) -> `HuntRouter` -> local.
4. **Admission**: CPU guard, hunt limit, max 2 pending, memory reservation, free port. Failure -> 503.
5. **Spawn** `GAMESERVER_BINARY_PATH` with argv `METAGAME_API_KEY`, port, map, behemoth (`NO_BEHEMOTH`), matchmaker hunt id (`NO_MM_HUNTID`), roster `account:playerHunt,...` (`NO_EXPECTED_PLAYERS`), `MY_IP:port`, `-EpicPortal -server -nullrhi`. Env adds `GAMESERVER_READY_DIR` (default a temp dir), `DR_SERVER_READY_FILE`, `DR_RAMSGATE_POOL`. Hunts hide their window; Ramsgate/Dojo stay visible.
6. **Readiness** (`WaitForServerReady`), then return `{host: MY_IP, port, sessionId}`.

## Gateway file reference

All under `versions/1.4.4/UndauntedGateway/`. Package `dauntless-revived-gateway`; only dependency `node-forge` (for `make-cert.js`). Scripts: `start` (gateway), `start:allowlist` (helper), `make-cert`.

| File | What it does |
|---|---|
| `src/server.ts` | Gateway entry: `LoadGatewayConfig`, reads cert/key, refuses an expired cert and warns 30 days ahead, starts `Gateway`, SIGINT/SIGTERM graceful stop |
| `src/gateway.ts` | `Gateway`: TLS server, connection caps (2048 total, 128 per IP) before handshake, `Classify` per request, `RateLimiter` buckets, body cap, header rewrite (`X-Forwarded-For` overwritten, `X-Forwarded-Proto: https`, `X-Dauntless-Gateway: <GATEWAY_SECRET>`, hop-by-hop dropped), streaming proxy to loopback, WebSocket upgrade to chat, 504 on 120 s upstream silence, one JSON access line per request, `AllowlistFeed` on success |
| `src/policy.ts` | Pure rules: `PUBLIC_UNDAUNTED_API` (`Register` POST; `GetUserInfo`, `ServerStatus`, `RegistrationStatus` GET/HEAD; `HuntRegion` GET/HEAD/POST), `GAMESERVER_KEY_HEADER` (any request carrying it -> 403), `SplitTarget`, `CheckPath` (no `..`, backslash, control chars, encoded `/ \ . NUL`), upstream choice (`/content*` -> content, upgrade -> ws, else metagame), limit class, feed kind (`heartbeat`, `token`) |
| `src/config.ts` | `LoadGatewayConfig`, `DEFAULT_LIMITS`, `DEFAULT_TIMEOUTS`, `ParseLoopbackUrl` (upstreams must be loopback), `CheckSecret`, `IsLoopbackHost` |
| `src/ratelimit.ts` | `RateLimiter` token buckets per key, `ParseBucketSpec` |
| `src/ip.ts` | `ParseIp`, `PeerAddress`, `RateLimitKey` (IPv6 by /64), `CheckAllowlistIp` (no reserved/multicast; private only if allowed) |
| `src/redact.ts` | `RedactText`, `RedactTarget`, `RedactUserAgent`: strip JWTs, keys and token-like strings from logged paths |
| `src/log.ts` | JSON-line logger (`Log`, `logger`, `SetLogSink`, `SetLogLevel`), `LogThrottle` |
| `src/feed.ts` | `AllowlistFeed`: after 2xx `POST /heartbeat` (bearer) or `POST /account/api/oauth/token`, posts the peer IP to `ALLOWLIST_URL` and `ALLOWLIST_ADDITIONAL_URLS` (max 4), at most once per IP per `GATEWAY_ALLOWLIST_REFRESH_SECONDS` (60); fire and forget |
| `allowlist/server.ts` | Helper entry: `LoadAllowlistConfig`, requires elevation (`IsElevated`) unless dry run, restores state, listens on `ALLOWLIST_BIND:ALLOWLIST_PORT`. `--close-ports` disables the rule once and exits (for stop scripts) |
| `allowlist/helper.ts` | `AllowlistHelper` HTTP handler: loopback peers only, header `x-allowlist-secret`; `POST /allow {"ip"}`, `GET /status`. `AuditLog` (`ALLOWLIST_AUDIT_LOG`), `DryRunRunner` |
| `allowlist/state.ts` | `AllowlistState`: TTL set (`ALLOWLIST_TTL_SECONDS` 600, `ALLOWLIST_MAX_ENTRIES` 256), deterministic sort (IPv4 then IPv6) |
| `allowlist/sync.ts` | `FirewallSync`: applies the desired set at most once per `ALLOWLIST_MIN_INTERVAL_MS` (3000), folds bursts, retries with backoff up to 1 min, final apply on shutdown |
| `allowlist/firewall.ts` | `RULE_NAME` `DauntlessRevived-GamePorts-Allowlist`, `BuildFirewallScript` (one inbound UDP rule on `ALLOWLIST_PORTS`, remote addresses = live set, disabled when empty), `PowerShellRunner` (script piped to PowerShell 5.1 stdin), `IsElevated` |
| `allowlist/config.ts` | `LoadAllowlistConfig` (all `ALLOWLIST_*` vars), `CheckPorts`, `DefaultPowerShell` |
| `tools/make-cert.js` | Self-signed RSA-2048/SHA-256 cert, 10 years, SANs from `--host`; prints the DER SHA-256 fingerprint for invite `fp=`. `--fingerprint <pem>` prints only |
| `README.md` | Detailed behaviour, measured limits, status-code tables (lists 4 public `/undaunted/api` routes; code also has `HuntRegion`; `ALLOWLIST_ADDITIONAL_URLS` undocumented) |

### Request flow

1. TLS accept (clients pin the cert SHA-256). Excess connections dropped pre-handshake.
2. `Classify`: bad target/path -> 400; gameserver key header -> 403; non-public `/undaunted/api/*` -> 403; route to upstream.
3. Rate limit per IP in six buckets (general, content, register, token, ws, connect) -> 429 + `Retry-After`. Body cap `GATEWAY_MAX_BODY_BYTES` (128 KiB).
4. Proxy to `GATEWAY_METAGAME_URL` (61000), `GATEWAY_CONTENT_URL` (61002) or `GATEWAY_WS_URL` (61099).
5. Successful login/heartbeat feeds the allowlist helper, which rebuilds the firewall rule.

## Deploy kit file reference

All under `versions/1.4.4/deploy/`.

### `windows-server/` (Windows Server 2019+, PowerShell 5.1)

| File | What it does |
|---|---|
| `windows-server/DauntlessServer.Common.ps1` | Dot-sourced by every script. Pins, paths (`Get-DRPaths`, `Resolve-DRRoot`), `server.json` (`Get-DRConfig`/`Save-DRConfig`), `.env` read/write, ACLs, reparse-point checks, invite strings (`New-DRInviteString`), cert fingerprint, Tailscale lookup, component processes and order (`$DRComponentOrder` = allowlist, metagame, content, gateway, deploy), downloads, build/switch of app versions (`Build-DRApp`, `Switch-DRApp`), backup folder helpers |
| `windows-server/DauntlessServer.Performance.ps1` | Performance sampler (dot-sourced by `Stack.ps1` and `Write-PerformanceLog.ps1`): one CSV row for the host plus one per stack process and game server, to `data\logs\performance\performance-<UTC date>.csv`, 30-day retention, counts only |
| `windows-server/Install-DauntlessServer.ps1` | Idempotent installer, `-Mode Public` or `-Mode Private` (Tailscale), `-WhatIf`. Writes `data\config\server.json` and the component `.env` files, keys, cert, firewall rules, low-privilege `dauntless` service account, scheduled tasks (stack, allowlist helper as SYSTEM in public mode, hourly backup) |
| `windows-server/Deploy-Remote.ps1` | Run on the admin PC: key-only SSH to the server, uploads kit + code + backup + game zip (resumable, SHA-256 checked via `Receive-Upload.ps1`), runs the installer, prints the cert fingerprint. Also `-Update`, `-InviteFor`, `-Status`, `-Chat On/Off` |
| `windows-server/Receive-Upload.ps1` | Server side of the chunked upload: `-Action Begin/Verify/Assemble/Clean`, emits `DRJSON:` lines |
| `windows-server/Stack.ps1` | `status/start/stop/restart [-Only component]/supervise`. Supervisor restarts a crashed component after 5-60 s, gives up after 5 crashes in 10 min, samples performance each minute; starts dashboard tasks if configured |
| `windows-server/Update-DauntlessServer.ps1` | Builds new code beside the running one, switches with a health check, rolls back on failure |
| `windows-server/Backup-DauntlessServer.ps1` | Hourly backup of DB (SQLite online backup), settings, keys, cert |
| `windows-server/backup-hidden.vbs` | Runs `Backup-DauntlessServer.ps1` with no window for the hourly scheduled task |
| `windows-server/Prune-DatabaseBackups.ps1` | Deletes old database backup copies, skipping open files and links |
| `windows-server/Receive-WeeklyDatabaseBackup.ps1` | Run on a worker (default root `C:\DauntlessGermany`): pulls the newest completed hourly DB snapshot from `-SourceHost` over SSH (`-IdentityFile`) into its `backups` folder |
| `windows-server/New-Invite.ps1` | Creates an invite code on the server and prints the launcher invite string |
| `windows-server/Get-ServerStatus.ps1` | Shows who is online and which worlds and hunts run |
| `windows-server/Set-Chat.ps1` | Turns in-game text chat on/off on a public server: writes `CHAT`, `CHAT_BIND_HOST`, `CHAT_PORT` in `metagame.env` and "Chat" in `server.json`, restarts the stack, waits 30 s for the 61099 listener, rolls back on failure. Restart drops in-memory parties and queues |
| `windows-server/Set-ProcessCpuBudget.ps1` | Dot-sourced before the DeployServer starts: creates a named Windows job object with a hard CPU rate cap (`-Percent`, default 50; `-Name` default `DauntlessGermanyCPU`) that the DeployServer and all its game processes share. `-VerifyOnly` checks it |
| `windows-server/Write-PerformanceLog.ps1` | Standalone runner of the performance sampler (CSV every minute) |
| `windows-server/Install-OwnerDashboard.ps1` | Copies `tools/dashboard*.{mjs,js,html}` to `<root>\dashboard`, writes its log config, registers the "Dauntless Revived dashboard" task (127.0.0.1:61110) |
| `windows-server/Open-OwnerDashboard.ps1` | Waits for 127.0.0.1:61110 and opens it in the browser (interactive session) |
| `windows-server/Install-DiscordStatus.ps1` | Installs `tools/discord-status.mjs` as a LocalService task; needs `data\keys\discord-status.key` (webhook) |
| `lib/dr-db.js` | `node dr-db.js <command> <metagame dir> <db>` via the Metagame's `better-sqlite3`: `integrity`, `backup` (online backup + check), `add-invite`/`del-invite`, `make-admin`, `gs-key` (registers the game-server key's SHA-256) |
| `lib/dr-keys.js` | `signing <out>`: writes fresh RSA-2048 `AUTH_SIGNING_PRIVKEY_B64`/`AUTH_SIGNING_PUBKEY_B64` lines for `metagame.env` |
| `lib/verify-game.js` | Checks a game folder against the content manifest (size + SHA-256, `--quick` size only) |
| `lib/backup-policy.cjs` | Bounds SQLite incremental backup work when external writes keep restarting it |
| `tests/Test-KitUnit.ps1`, `Test-Sandbox.ps1`, `Test-DeployRemote.ps1` | Kit tests; sandbox uses spare ports 62000-62499 |

### `linux-server/` (x86_64 Linux, systemd, nftables, Proton/Wine)

| File | What it does |
|---|---|
| `linux-server/install.sh` | Installer: `--game-dir`, `--my-ip`, `--mode`, `--source`, `--install-root`, `--data-dir`, `--no-services`, `--skip-build`...; `npm ci && npm run build` per package, runs `generate-config.mjs`, installs `systemd/` units into `/etc/systemd/system` |
| `linux-server/install-worker.sh` | Sets up a game-only worker: worker user, env file, `dr-game-worker` command link for SSH-forced commands |
| `linux-server/prepare-game.sh` | Refuses an exe that is not the pinned 1.4.4 build, then copies `dxgi.dll` and `UndauntedInternalServer.dll` (hash-pinned) next to it |
| `linux-server/stack.sh` | `start/stop/restart/status/logs [component]` over the `dauntless-*` systemd units |
| `linux-server/launch-gameserver.mjs` | `GAMESERVER_BINARY_PATH` target on Linux: `runWineGame(argv)` (exe under Proton/Wine) |
| `linux-server/worker-launch.mjs` | Worker side: loads `DR_WORKER_ENV` (default `/etc/dauntless-revived-worker.env`), `decodeWorkerPayload`, `runWineGame` |
| `linux-server/ssh-worker-command.sh` | SSH forced command: accepts only `dr-game-worker <base64url payload>` (<= 64 KiB), execs `worker-launch.mjs` |
| `linux-server/allowlist.mjs` | Allowlist helper backend on nftables: table `DR_NFT_TABLE` (`dauntless_revived`), sets `players4`/`players6`, accept listed IPs on the UDP range, drop the rest; optional `DR_FIREWALL_INTERFACE`, `DR_NFT_BINARY` |
| `linux-server/systemd/*.service` | Units for allowlist, content, deploy, gateway, metagame |

### `openbsd-server/` (OpenBSD 7.9 control plane; game runs on a Linux worker)

| File | What it does |
|---|---|
| `openbsd-server/install.ksh` | Installer: needs `--worker-host`, `--worker-ip`, `--worker-key`, pf interfaces |
| `openbsd-server/configure-pf.ksh` | Generates/installs pf rules (public/private, gateway port, UDP range, worker interface) |
| `openbsd-server/stack.ksh` | `start/stop/restart/status [component]` over `rc.d/` scripts |
| `openbsd-server/launch-gameserver.mjs` | `GAMESERVER_BINARY_PATH` target on OpenBSD: `buildSshLaunch` SSHes to the Linux worker (`DR_WORKER_HOST`, `DR_WORKER_USER`, `DR_WORKER_KEY`, `DR_WORKER_COMMAND`) with the game argv as base64url JSON |
| `openbsd-server/allowlist.mjs` | Allowlist backend on pf: `pfctl -a DR_PF_ANCHOR -t DR_PF_TABLE -T replace` |
| `openbsd-server/rc.d/*` | rc.d scripts for allowlist, content, deploy, gateway, metagame |

### `unix-common/` (shared by Linux and OpenBSD)

| File | What it does |
|---|---|
| `unix-common/allowlist-core.mjs` | `loadUnixAllowlistConfig`, `runUnixAllowlist({backendName, apply})`: same HTTP contract as the Windows helper (`/allow`, `/status`, secret, TTL) with a pluggable firewall `apply` |
| `unix-common/game-runner.mjs` | `buildWineLaunch` (Proton via `DR_PROTON_BINARY` or Wine via `DR_WINE_BINARY`, prefix, `WINEDLLOVERRIDES`, `DR_GAME_EXE`, optional Xvfb `DR_XVFB`/`DR_XVFB_RUN`), `runWineGame`, `terminateProcessTree`, `decodeWorkerPayload` |
| `unix-common/generate-config.mjs` | Writes `metagame.env`, `deployserver.env`, `content.env`, `gateway.env`, `allowlist.env`, `server.conf`, empty `news.json` (mode 0600), keeps existing secrets |
| `unix-common/new-invite.mjs` | Creates an invite code via `dr-db.cjs add-invite` and prints the invite string |
| `unix-common/dr-db.cjs` | DB helper: `integrity`, `add-invite`/`del-invite`, `make-admin`, `gs-key`, `backup` |

## Config

- **DeployServer:** `PORT` (61001), `BIND_HOST`, `GAMESERVER_BINARY_PATH`, `METAGAME_API_KEY`, `MY_IP`, `PORT_RANGE_BEGIN`, `PORT_RANGE_END`, `GAMESERVER_READY_DIR`, `GAMESERVER_STARTUP_GRACE_MS`, `SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP`, `MAX_LOCAL_HUNTS`/`MAX_HUNTS`, `GAMESERVER_CPU_GUARD`, `GAMESERVER_CPU_LIMIT_PERCENT`, `GAMESERVER_CPU_RESUME_PERCENT`, `GAMESERVER_MEMORY_GUARD`, `GAMESERVER_MIN_FREE_MB`, `GAMESERVER_STARTUP_MB`, `GAMESERVER_HUNT_STARTUP_MB`, `GAMESERVER_RESERVATION_SECONDS`, `RAMSGATE_POOL`, `RAMSGATE_PLAYER_LIMIT`, `ENABLE_DOJO`, `PERSISTENT_WORLD_LIVENESS`, `HUNT_MAX_AGE_MINUTES`, `HUNT_EMPTY_MINUTES`, `HUNT_STARTUP_GRACE_MINUTES`, `TRIAL_ROTATION_START`, `SERVER_ROLE`, `HUNT_WORKER`, `WORKER_RAMSGATE`, `WORKER_DOJO`, `CITY_OVERFLOW`, `CITY_STATUS_KEY`, `OVERFLOW_AFTER_HUNTS`, `OVERFLOW_DEPLOYSERVER_URL`, `AUS_DEPLOYSERVER_URL`, `GERMANY_DEPLOYSERVER_URL`, `US_DEPLOYSERVER_URL`, `AUS_RESERVED_HUNTS`, `AUS_PUBLIC_HOST`, `GERMANY_PUBLIC_HOST`, `US_PUBLIC_HOST`, `LOG_LEVEL`, `NODE_ENV`.
- **Gateway:** `GATEWAY_BIND` (0.0.0.0), `GATEWAY_PORT` (443), `GATEWAY_CERT`, `GATEWAY_KEY`, `GATEWAY_SECRET`, `GATEWAY_METAGAME_URL`, `GATEWAY_CONTENT_URL`, `GATEWAY_WS_URL`, `GATEWAY_ALLOWLIST` (`0` disables the feed), `ALLOWLIST_URL`, `ALLOWLIST_SECRET`, `ALLOWLIST_ADDITIONAL_URLS`, `GATEWAY_ALLOWLIST_REFRESH_SECONDS`, `GATEWAY_MAX_BODY_BYTES`, `GATEWAY_MAX_CONNECTIONS`, `GATEWAY_MAX_CONNECTIONS_PER_IP`, `GATEWAY_RATE_{GENERAL,CONTENT,REGISTER,TOKEN,WS,CONNECT}`, `GATEWAY_{HANDSHAKE,HEADERS,REQUEST,KEEPALIVE,IDLE,UPSTREAM_IDLE,WS_IDLE}_TIMEOUT_MS`, `GATEWAY_SHUTDOWN_GRACE_MS`.
- **Allowlist helper:** `ALLOWLIST_BIND`, `ALLOWLIST_PORT` (61005), `ALLOWLIST_SECRET`, `ALLOWLIST_PORTS` (8770-8777), `ALLOWLIST_TTL_SECONDS`, `ALLOWLIST_MIN_INTERVAL_MS`, `ALLOWLIST_MAX_ENTRIES`, `ALLOWLIST_ALLOW_PRIVATE`, `ALLOWLIST_DRY_RUN`, `ALLOWLIST_AUDIT_LOG`, `ALLOWLIST_STATE_FILE`, `ALLOWLIST_POWERSHELL`.
- **Kit:** `data\config\server.json` ("Components", ports, `CertFingerprint`, `PublicHost`), `data\config\metagame.env` (added lines kept across updates); parameters in `versions/1.4.4/docs/reference/scripts.md`.

## Connects to

| From -> To | Link |
|---|---|
| Metagame -> DeployServer | HTTP to `DEPLOYSERVER_URL` (127.0.0.1:61001), see [metagame](legacy-1.4.4-metagame.md) |
| DeployServer -> Metagame | `CITY_STATUS_KEY` call to `127.0.0.1:61000/undaunted/api/ServerStatus` (city overflow only) |
| DeployServer -> game exe | spawn + argv + env + ready file; see [internal-server](legacy-1.4.4-internal-server.md) |
| DeployServer -> workers | `GET /gameservers`, `POST /api/matchmaker/...` over loopback SSH tunnels |
| Gateway -> Metagame / Content / chat | loopback 61000 / 61002 / 61099 |
| Gateway -> allowlist helper(s) | `ALLOWLIST_URL` (61005) + `ALLOWLIST_ADDITIONAL_URLS` |
| Launcher -> Gateway | pinned TLS to 443; see [launcher](legacy-1.4.4-launcher.md) |
| `tools/worker-health.mjs` -> DeployServer, helper, Metagame | `GET /gameservers`, `GET /status`, `GET /dauntless-status` (see [tools](legacy-1.4.4-content-bot-tools.md)) |

## Gotchas

- **DeployServer has no authentication.** Only loopback binding plus `IsDirectLoopbackRequest`. Never expose 61001; worker tunnels deliberately forward it.
- **Game-server key in argv.** `METAGAME_API_KEY` is a command-line argument and the whole DeployServer environment is copied into each child.
- **Ambiguous worker failures never fall back locally** (avoids duplicate hunts); refused connections and 503 capacity do.
- **No UDP through the gateway.** Can log in but cannot join = allowlist helper (not running, wrong secret, `GATEWAY_ALLOWLIST=0`, address changed behind CGNAT). Needs admin rights.
- **Certificate expiry kills invites.** New cert = new fingerprint = new invites.
- **Gateway binds IPv4 0.0.0.0** so peer addresses match the UDP source addresses seen by the firewall.
- **Port range layout.** Last port Ramsgate, one before it Dojo; pooled extra cities and hunts take the rest.
- **Deploy DLL and DeployServer together**; mismatches fall back to slower UDP-bound readiness.
- Linux/OpenBSD kits are separate ports of the Windows kit. OpenBSD cannot run the game; it SSHes every launch to a Linux worker.

## See also

[index](index.md) - [legacy-1.4.4](legacy-1.4.4.md) - [legacy-1.4.4-metagame](legacy-1.4.4-metagame.md) - [legacy-1.4.4-internal-server](legacy-1.4.4-internal-server.md) - [legacy-1.4.4-launcher](legacy-1.4.4-launcher.md) - [legacy-1.4.4-content-bot-tools](legacy-1.4.4-content-bot-tools.md) - [director](director.md) - [deploy](deploy.md) - [setup](setup.md)
