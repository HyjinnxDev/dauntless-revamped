# ParadoxDirector (Deploy Server)

> Verified against code 2026-10-24.

## What it is

The Director is a small Node/Express service that starts, tracks and stops the dedicated Dauntless game servers. It runs two permanent "hubs" (Ramsgate, the city, and the Training Dojo) and spawns one extra game-server process per hunt on demand. [ParadoxBackend](backend.md) never starts a game server itself. It asks the Director over loopback HTTP, and the Director answers with a `host:port` the game client connects to.

Each game server is the normal `Dauntless-Win64-Shipping.exe` run headless (`-server -nullrhi`), with `MysticParadox.dll` loaded through the winmm proxy (see [Tools](tools.md) and [Runtime](runtime.md)). The DLL, not the Director, runs the game logic. The Director only launches, watches and kills processes.

The package is `paradox-director` 0.0.3 (`versions/1.14.7/ParadoxDirector`). Log lines and docs often call it "DeployServer". The backend env var is still `DEPLOYSERVER_URL`.

## File reference

All paths are under `versions/1.14.7/ParadoxDirector/`.

| File | What it does |
|---|---|
| `src/server.ts` | Entry point (`Main`). Refuses `MYSTPAX_*` env keys, runs `EnsureServerRuntimeUpdated`, listens on `127.0.0.1:PORT`, then calls `Startup()` (sets `/health/ready` when it resolves) and starts the 60 s `RunWatchdog` interval. Logs `Mystic Paradox DeployServer on port N`. |
| `src/app.ts` | Express `app`. Routes `/health/ready`, `/api/hub-status`, `/api/hunt-status`; mounts `adminRouter` at `/api/admin`, then `RequestContextMiddleware`, JSON/urlencoded parsers, the `[REQ]`/`[RES]` request logger, and `matchmakingRouter` at `/api/matchmaker`. `SetPersistentHubsReady(bool)` flips the readiness flag. |
| `src/routes/matchmaker.ts` | `matchmakingRouter`: `POST /handle-matchmaking-for-player` (calls `HandleMatchmakingRequest`; any throw = 500 `{"error":"matchmaking_failed"}`) and `POST /join-public-hunt` (calls `JoinPublicHunt`). Lets the P2P extension mount extra routes. |
| `src/routes/admin.ts` | `adminRouter`: `x-api-key` check (timing-safe compare with `METAGAME_API_KEY`, 401 `unauthorized`), `GET /gameservers`, `POST /gameservers/:id/stop`, `GET /gameservers/:id/log`. `TailFile` returns the last 256 KB from a line boundary. |
| `src/controllers/matchmaker.ts` | `HandleMatchmakingRequest(GameMode, GameArgs, HuntId, ExpectedPlayers, IsPrivate, GauntletLevel)`: maps a request to Ramsgate, the Dojo, a reused hunt or a new hunt (table below). |
| `src/controllers/gameservers.ts` | The core (about 1350 lines). Loads the seven hunt tables at import, owns `Gameservers` (live list), the `PortPool`, both `HubSupervisor`s and `ServerLaunchQueue` (hunt stagger). Key functions: `StartServer`, `WaitForServerReady`, `CleanupServer`, `ReapEmptyHunt`, `IsSupersededHunt`, `ParseHuntStateLine`, `GetRamsgateConnectionDetails`, `GetTrainingDojoConnectionDetails`, `GetPersistentHubStatus`, `GetHuntServerStatus`, `TryReuseSharedHuntServer`, `JoinablePublicHunt`, `JoinPublicHunt`, `StartupGameserverWithArgs`, `StartupGameserverWithHuntIdAndPlayers`, `ResolveHuntLaunchManifest`, `GetMatchmakerHuntIdFromPlayerHuntId`, `ResolveTagRoutedMatchmakerHuntIds`, `EvaluateTagQuery`, `FindMatchmakerRow`, `ReclaimOrphanedPortLeases`, `TickPersistentHubs`, `LogMissingHuntRequests`, `GetMissingHuntRequests`, `AuditHuntLaunchCoverage`, `ValidateHuntTableData`, `Startup`. Exports `NoHuntCapacityError`, `GameserverStartupError`, `MAX_CONCURRENT_HUNT_SERVERS`. |
| `src/controllers/hubSupervisor.ts` | `HubSupervisor<T>` (`ensure`, `onExit`, `tick`, `dispose`; getters `current`, `pending`, `failureCount`, `nextAttemptDueAt`, `retryArmed`) and `CreateSerialGate()`. Exports `DEFAULT_HUB_BACKOFF_MS`, `DEFAULT_HUB_STABLE_UPTIME_MS`. Pure: clock, timer and logger are injected; the default clock is `performance.now()`. |
| `src/controllers/portPool.ts` | `PortPool`: `add`, `take(owner)` (FIFO), `attachPid`, `release(port, owner)` (owner-checked), `reclaim(isOwnerLive, isPidAlive)`, `ownerOf`, `pidOf`, `freeCount`, `heldCount`. Pure. |
| `src/controllers/watchdog.ts` | `RunWatchdog()`: `kill(pid, 0)` over a snapshot of `Gameservers`, `CleanupServer` for dead ones, then `ReclaimOrphanedPortLeases`, `TickPersistentHubs`, `LogMissingHuntRequests`. |
| `src/runtimeUpdater.ts` | `EnsureServerRuntimeUpdated()`: optional signed update of the server `MysticParadox.dll` before the hubs start. Hard-coded Ed25519 public key (`RUNTIME_PUBLIC_KEY`, the self-host key's public half); `SERVER_RUNTIME_MANIFEST_URL` required, no default. |
| `src/gameData/loader.ts` | `gameDataDir`, `gameDataPath`, `loadGameData` (throws with a pointer to `docs/GENERATING_GAME_DATA.md` when the file is missing), `tryLoadGameData`. Folder: `PARADOX_GAME_DATA_DIR` or `ParadoxDirector/game-data`. Strips a UTF-8 BOM. |
| `src/extensions/p2p.ts` | `GetP2PExtension()`: loads a `p2p` folder beside `extensions/` in the build (`CreateP2PExtension()`) once if it exists, else a no-op. `MYSTICPARADOX_P2P_MODULE=0/false/off/no` forces the no-op. No `p2p` module is in the repo. |
| `src/observability/requestContext.ts` | `RequestContextMiddleware`: request id from `x-mysticparadox-request-id`, else `x-request-id`, else a new UUID (must match `^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$`). Echoed in the response header and kept in `AsyncLocalStorage` for `GetRequestId()`. |
| `src/logger.ts` | pino `logger`, level `LOG_LEVEL` (default `info`), `requestId` mixin. Two pino-pretty targets: coloured console, and a plain file `<cwd>/../debug/deployserver/deployserver.log` (truncated at each start, `append: false`). |
| `src/controllers/*.test.ts` | `portPool.test.ts`, `hubSupervisor.test.ts` (pure), `emptyHuntReap.test.ts` (`IsSupersededHunt`, `JoinablePublicHunt`), `gameservers.gamedata.test.ts` (real-table audit, skipped without data). |
| `scripts/run-tests.cjs` | `npm test`: runs every `src/**/*.test.ts` with `node --import tsx --test`; skips `*.gamedata.test.ts` when any of the seven real tables is missing. |
| `scripts/clean-dist.cjs` | `npm run clean`: deletes `dist/` file by file. Files locked by a running Director (EPERM/EBUSY/EACCES) are listed and left for `tsc` to overwrite. |
| `scripts/ensure-build-fresh.cjs` | `prestart`: runs `npm run build` when `dist/server.js` is missing, `package.json`/`tsconfig.json` is newer, any `src/*.ts` is newer than its `.js`, or `dist/` holds an orphan with no source (for example a stale `dist/p2p`). Exits non-zero if the build fails. |
| `scripts/import_hunt_tables.cjs` | `npm run generate:hunt-tables`: merges a CatalogExporter `EXPORT_HUNTS` capture into `game-data/` (see below). |
| `game-data/README.md` | Which tables exist, smoke-test copy loop, real-data import commands. |
| `game-data/*.example.json` | Synthetic one-row placeholders for the seven tables. The real `*.json` are gitignored by `versions/1.14.7/.gitignore`. |
| `package.json` | Scripts `dev` (`tsx --env-file=.env src/server.ts`, no watch), `clean`, `build` (clean + `tsc`), `prestart`, `start` (`node --env-file=.env dist/server.js`), `generate:hunt-tables`, `test`, `test:hunt-coverage`. Deps: express 5.2.1, pino, pino-pretty; `dotenv` and `jsonwebtoken` are listed but unused. |
| `tsconfig.json` | ES2022, CommonJS, `src` to `dist`, strict. |
| `.env.example` | Env template (see Config). |
| `.gitignore` | `node_modules/`, `dist/`, `build/`, temp folders, `*.db` (plus a stray `file` line). |

## HTTP routes

Bind: `127.0.0.1:PORT` only. `/health/ready`, `/api/hub-status`, `/api/hunt-status` and `/api/admin/*` are registered before the request logger, so they are never logged.

| Method + path | Auth | Request | Response |
|---|---|---|---|
| `GET /health/ready` | none | - | 200 `{ok:true, service:"deployserver"}` once `Startup()` resolved (even if a hub failed), else 503 |
| `GET /api/hub-status` | none | - | `{ramsgate, trainingDojo}`, each `null` or `{ready:true, host, port, processId}` (only if ready **and** pid alive) |
| `GET /api/hunt-status?port=N` | none | `port` query | `null`, or `{port, huntState}` for a ready, alive hunt server on that port (`huntState` may be `null`) |
| `POST /api/matchmaker/handle-matchmaking-for-player` | none | `{GameMode, GameArgs, HuntId, ExpectedPlayers, IsPrivate?, GauntletLevel?}` | 200 `{host, port}` or 500 `{error:"matchmaking_failed"}` |
| `POST /api/matchmaker/join-public-hunt` | none | `{HuntId: string, Players: string[1..4]}` | 200 `{host, port}`, 204 none joinable, 400 `{error:"bad_request"}` |
| `GET /api/admin/gameservers` | `x-api-key` | - | `{directorPid, directorStartedAt, huntCap, servers:[{id, kind (ramsgate/dojo/hunt), port, map, behemoth, matchmakerHuntId, expectedPlayers[uid], processId, state, startTime, readyTime}]}` |
| `POST /api/admin/gameservers/:id/stop` | `x-api-key` | - | `process.kill(pid)`; 200 `{ok:true}`, 404 `not_found`, 409 `kill failed: ...` |
| `GET /api/admin/gameservers/:id/log` | `x-api-key` | - | `{text}`: last 256 KB of that server's log file |

A bad or missing `x-api-key` (or an empty `METAGAME_API_KEY`) gives 401 `{error:"unauthorized"}`.

## How it works

### Startup (`server.ts`)

1. Refuse to start if any env key still has the old `MYSTPAX_` prefix. Spawned servers inherit the environment, and a stale key would silently switch a runtime feature off. Rename them to `MYSTICPARADOX_`.
2. `EnsureServerRuntimeUpdated()` (see "Runtime DLL auto-update" below). A failure is logged and ignored unless `SERVER_RUNTIME_UPDATE_REQUIRED` is `1/true/yes/on`.
3. Listen on **127.0.0.1** only, on `PORT`. The matchmaker routes have no auth, so the bind address is the protection.
4. `Startup()` runs `ValidateHuntTableData()` (`[HuntTableAudit]`, `[HuntLaunchCoverage]`, `[HuntTableCoverage]` log lines, first 20 problems), fills the port pool with `PORT_RANGE_BEGIN` .. `PORT_RANGE_END - 2`, then `RamsgateHub.ensure("boot")` and then `TrainingHub.ensure("boot")`, one after the other.
5. `/health/ready` flips to 200 once `Startup()` returns. It also returns 200 if a hub failed to start, because `Startup()` only logs hub failures (`Persistent hub startup reported failures ...`). The hubs keep retrying in the background.
6. A `setInterval` runs `RunWatchdog()` every 60 s. Errors are caught so a bad pass cannot kill the process.

Import-time side effects of `gameservers.ts`: all seven tables are loaded (a missing one throws and the process exits) and `GAMESERVER_LOG_DIR` is created.

### Ports

Everything is derived from `PORT_RANGE_BEGIN` and `PORT_RANGE_END` (UDP, game traffic):

| Port | Use |
|---|---|
| `PORT_RANGE_END` | Ramsgate (live range 8780-8790, so **8790**) |
| `PORT_RANGE_END - 1` | Training Dojo (**8789**) |
| `PORT_RANGE_BEGIN` to `PORT_RANGE_END - 2` | Hunt servers (8780-8788), leased from `PortPool` |

`PORT` is the Director's own loopback HTTP port (3001 live, 3101 on the test stack). Voice UDP (8791) belongs to the backend, not the Director.

The pool is FIFO (a just-freed port is reused last) and every lease records an owner (the launch id) and, once spawned, a pid. `release(port, owner)` frees a port only if the caller still owns it, so a late exit event from an old process cannot free a port a newer hunt is using. `reclaim()` returns leases whose owner is no longer in `Gameservers` and whose pid is dead or missing (used by the watchdog, logged as `[PortPool] reclaimed port ...`).

### Spawning one game server (`StartServer`)

1. **Hunts only:** wait on `ServerLaunchQueue`. Each hunt start is queued `SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP` seconds after the previous queued hunt, so several UE4 processes do not cold-start at once. Hubs skip this queue.
2. **Hunts only:** reap every "superseded" empty hunt (`IsSupersededHunt`, see Reaping), then enforce `MAX_CONCURRENT_HUNT_SERVERS` (count of non-hub entries in `Gameservers`). Over the cap throws `NoHuntCapacityError`. Then `Ports.take(launchId)`; none free throws `No free ports left!`.
3. Open (append) the log file `port<N>_<label>.log` in `GAMESERVER_LOG_DIR`. The label is `ramsgate`, `training_dojo`, the behemoth asset's short name, or `hunt`. A banner line records port, map, behemoth, matchmaker hunt id, Gauntlet level and players.
4. `spawn(GAMESERVER_BINARY_PATH, [...])` with `stdio: ["ignore","pipe","pipe"]` and `windowsHide` on (set `GAMESERVER_WINDOWS_HIDE=0` to see the window). Positional args, in order:
   - `METAGAME_API_KEY`
   - port
   - map path
   - behemoth asset path, or `NO_BEHEMOTH`
   - matchmaker hunt id, or `NO_MM_HUNTID`
   - expected players as `uid:playerHuntId,uid:playerHuntId`, or `NO_EXPECTED_PLAYERS`
   - `MY_IP:port` (the address the server advertises)
   - fixed UE args: `-EpicPortal -server -nullrhi -warp -nosound -RepDriverEnable` and `-LogCmds="LogPhoenixCharacter <GAMESERVER_CHARACTER_LOG>, LogOnline Verbose, LogLoad Off, LogGauntlet VeryVerbose, LogPhoenixGauntlet VeryVerbose"`
5. Child env = the Director's whole environment plus `MYSTICPARADOX_GAMESERVER_LAUNCH_ID` (a UUID), `MYSTICPARADOX_TRIALS_WEEK` (the `NNN` of an `Arena_MatchmakerHunt_{Easy,Hard,Elite}_NNN` row) `MYSTICPARADOX_GAUNTLET_LEVEL` (when a level was given) and `MYSTICPARADOX_GAME_MODE` (the matchmaker row's `GameModeOverride`, when it is a `/Game/...` class path; the server never applies it itself, so story missions ran the map's default Escalation mode). The launch header in the per-port log shows it as `game=`. A synchronous spawn failure returns the port lease.
6. stdout and stderr are piped into the log file with `end: false`; the log closes on the child's `close`, so the `=== Gameserver process exited ... ===` banner is always written (the first pipe to end used to close it). That pipe must always keep draining. An earlier readiness check paused the stream and froze the game thread. The long comment in `WaitForServerReady` explains it. Do not pause or destroy `Child.stdout`. The child is `unref()`ed.
7. Wait for the line `MYSTICPARADOX_GAMESERVER_READY launchId=<id> port=<n>` on stdout, up to `GAMESERVER_READY_TIMEOUT_MS`. The DLL prints it only after the UE listen socket exists. A mismatched launch id or port is ignored with a warning. On timeout, early exit or spawn error the server is marked `failed` and removed from the list; a still-running child is killed (its exit event returns the port), an already-dead hunt returns its port at once. `GameserverStartupError` is thrown.
8. Only after the ready line is the server `state: "ready"` (`<label> ready on MY_IP:port after Nms`). Until then it is never returned to a caller.

Process `exit` handler: a hunt is dropped from `Gameservers` and its port released (owner-checked). A hub exit calls `CleanupServer` (which tells its supervisor) only when `HUB_PROMPT_RESTART` is on; otherwise the hub stays listed until the watchdog finds it dead.

Hunt servers also print `MYSTICPARADOX_HUNT_STATE hpPct=N players=N subState=N` lines (`hpPct` is the lowest live behemoth HP percent or -1, `subState` is `EArchonInProgressGameSubState`, 4 = end of hunt). A second stdout listener parses them into `huntState` (with `at` = arrival time) and sets `hadPlayers` once `players > 0`. That state drives empty-hunt reaping, `/api/hunt-status` and the public-join gate.

### Matchmaking requests (`controllers/matchmaker.ts`)

`POST /api/matchmaker/handle-matchmaking-for-player`. `IsPrivate` is true unless the body has an explicit `false`. `GauntletLevel` is used only when it is an integer.

| `GameMode` | Result |
|---|---|
| `CITY` | `GetRamsgateConnectionDetails()` |
| `SHARED` with `HuntId = ShatteredIsles_TrainingDojo` | `GetTrainingDojoConnectionDetails()` |
| `SHARED` with another `HuntId` and non-empty `ExpectedPlayers` | `TryReuseSharedHuntServer` (only when `ENABLE_PUBLIC_HUNT_REUSE=1`), else `StartupGameserverWithHuntIdAndPlayers(HuntId, ExpectedPlayers)`. `IsPrivate` and `GauntletLevel` are **not** passed, so a SHARED hunt is always private. |
| `SHARED` with no `ExpectedPlayers` | Throws. |
| `ISLAND` with `GameArgs` | `StartupGameserverWithArgs`: map = text before the first `?`, behemoth = `MonsterClass`, matchmaker id = `HuntID` (or resolved from `HuntId`). Ignores `IsPrivate` and `GauntletLevel`. |
| `ISLAND` with `HuntId` and `ExpectedPlayers` | `StartupGameserverWithHuntIdAndPlayers(..., IsPrivate, GauntletLevel)`. Sets `isPrivate` and `sentAt` on the new server. |

Anything else throws, and the route returns HTTP 500 `{"error":"matchmaking_failed"}`. A success returns 200 `{host, port}`, where `host` is `MY_IP`. Hub getters throw `Ramsgate is not ready` / `Training Dojo is not ready` while a hub is down; callers treat that as "wait and retry".

### Resolving a hunt id to a map and behemoth

`ResolveHuntLaunchManifest(HuntId, ExpectedPlayers)` requires 1 to 4 non-empty player ids and then:

1. `GetMatchmakerHuntIdFromPlayerHuntId` looks up the player hunt id in `player_hunts_table.json`. A missing row is recorded in `MissingHuntRequests` (the first sighting logs `[HuntTableGap] ... CANNOT start`) and the request fails.
2. Direct `MatchmakerHuntIDs[].RowName` entries that exist in any registered table win. Only if there are none are the row's `MatchmakerHuntsByTag` lists evaluated (`ResolveTagRoutedMatchmakerHuntIds`): each list names a table (`MatchmakerTable.ObjectName`), and a row qualifies if it satisfies every query of the list. `EvaluateTagQuery` is a hand-written evaluator for UE's serialized `FGameplayTagQuery` token stream (expression types 1-6; tag matching is prefix-aware). An unregistered table logs `[HuntTagRouting] ... not registered`.
3. `MatchmakerTableSources`, in search order (the main table wins a name collision): `matchmaker_hunts_table`, `arena_easy_matchmaker_hunts`, `arena_hard_matchmaker_hunts`, `arena_elite_matchmaker_hunts`, `arena_hard_matchmaker_hunts_new`, `arena_elite_matchmaker_hunts_new`.
4. Tag-routed Trials rows (`Arena_MatchmakerHunt_{Easy,Hard,Elite}_NNN`) are pinned to the current featured week: `floor(nowMs / (TRIALS_ROTATION_MINUTES * 60000)) % 181 + 1`, zero-padded to 3 digits (`[TrialsRotation]` log). The DLL uses the same formula from the same env var, so the advertised row and the spawned row agree. No match falls back to a random numbered arena row. `_New_` rows never match the pin. Other hunts pick a random usable row.
5. Behemoth = `SpecificBehemoth.BehemothAsset.AssetPathName` (`None` or empty means Hunting Grounds: no `MonsterClass`). Map = a random `MapList[].MapAssetName` that starts with `/Game/` and contains a `.`, with the `.Object` suffix cut off.

`ValidateHuntTableData` (boot) and `AuditHuntLaunchCoverage` (boot and tests) walk every player row through the same resolver and report unresolvable rows, map-less rows, unique maps, game-mode overrides and `MaxPlayers` values.

### Persistent hubs (`HubSupervisor`)

Each hub (Ramsgate, Dojo) has a `HubSupervisor`:

- `ensure(reason)` is single-flight. Concurrent callers share one start and it never rejects. A failed start resolves `undefined` and arms a retry timer (one unref'd timer per hub). Before the backoff is due, `ensure` only re-arms the timer, so requests cannot skip the backoff. Reasons: `boot`, `exit: ...`, `retry`, `watchdog`, `request`.
- Backoff after the Nth failure: 5 s, 15 s, 30 s, 60 s, 120 s, then 300 s (cap).
- A hub that exits at least 120 s after ready restarts at once and resets the failure count. An earlier exit counts as a failure and waits for its backoff. `tick()` also resets the failure count once a hub has been up 120 s.
- `onExit` acts only for the **current** hub; a late exit of a failed start or an older run is ignored. A hub that is dead right after reporting ready counts as a failed start.
- Both hubs share one `CreateSerialGate()`, so their cold starts never overlap (a concurrent start once crashed Ramsgate's async loading thread). A non-boot start also waits for the hunt `ServerLaunchQueue` tail as it stands, capped at 60 s (`[HubSupervisor] ... cold-starting anyway`).
- The getters `GetRamsgateConnectionDetails()` and `GetTrainingDojoConnectionDetails()` check "ready **and** process alive". If not, they report a dead hub to `CleanupServer` or call `ensure("request")` for a missing one, then throw `... is not ready`. A stale cached address is never handed out.
- `HUB_PROMPT_RESTART=0` (or `false`, `no`, `off`) turns off exit-event and getter restarts. Then only the 60 s watchdog notices a dead hub. Failed starts still retry on the timer.

### Reaping and cleanup

There is deliberately **no wall-clock reaper**, so a long hunt is never cut short. A hunt ends in one of these ways:

- **The DLL exits itself.** It quits after a no-connection grace period (about 50 s after the last player leaves, 5 min if nobody ever arrived). The process `exit` event removes the server from the list and releases the port.
- **Instant empty-hunt reap** (2026-10-19, `ReapEmptyHunt`). The Director kills a hunt when its reported `players` drops from above 0 to 0 and stays 0 for `EMPTY_HUNT_GRACE_MS` (20 s; any later `players>0` line cancels it) ("last player left"; before 2026-10-28 the first 0 killed it while a party member was still loading), or, at the next hunt start, when it is ready, nobody ever arrived, and every player it was started for is in the new request (`IsSupersededHunt`). It is removed from the list at once, so the hunt cap frees up; the exit event releases the port.
- **Watchdog** (every 60 s): for any listed server whose pid is gone (`kill(pid, 0)` fails), call `CleanupServer` (hunt: release port; hub: `onExit`). Then `ReclaimOrphanedPortLeases()`, `TickPersistentHubs()` (restart a dead hub that sent no exit event, retry a missing hub whose backoff is due) and `LogMissingHuntRequests()` (`[HuntTableGap] N hunt id(s) requested but missing ...`).
- **Admin stop**: kills the process, and the normal exit path does the rest.

### Reuse and public join (two features, easy to confuse)

- **Reuse** (`TryReuseSharedHuntServer`, `ENABLE_PUBLIC_HUNT_REUSE=1`, default off). A `SHARED` request joins the first listed hunt with `state === "ready"` whose first roster entry has the same player hunt id and whose roster is shorter than `PUBLIC_HUNT_MAX_PLAYERS`. It does not check `isPrivate`, process liveness or the connected count, and the roster only grows. Joiner uids are appended so the DLL can credit kills and rewards (`[PublicHuntReuse]` log). `PUBLIC_HUNT_MAX_PLAYERS` must equal the DLL's `HUB_MAX_PLAYERS` (default 4).
- **Join public hunt** (`JoinPublicHunt` / `JoinablePublicHunt`, `POST /api/matchmaker/join-public-hunt`). Picks a ready hunt with `isPrivate === false` (only ISLAND hunts started with `IsPrivate: false`) on the same player hunt id. Gate: hunt state reported in the last 15 s, `subState != 4`, behemoth HP at least 20 % (or -1 = no behemoth yet), and `connected + players sent in the last 90 s + new players <= PUBLIC_HUNT_MAX_PLAYERS`. The fullest server wins. Joiners are appended to the roster and to `sentAt` (`[PublicMatch]` log).

### Runtime DLL auto-update (`runtimeUpdater.ts`)

Only when `SERVER_RUNTIME_AUTO_UPDATE` is `1/true/yes/on`. Needs `GAMESERVER_BINARY_PATH`. It fetches `SERVER_RUNTIME_MANIFEST_URL` (required, no default: throws when unset; 30 s timeout; redirects are an error), then:

1. HTTP 404 or 204 means "nothing published": stop.
2. Validates the manifest: schema 1, component `ParadoxRuntime` or legacy `MystPaxInternalServer`, target `server`, changelist **647472**, platform `windows-x86_64`, semver version, safe channel name, size 1 B to 200 MB, 64-hex SHA-256, string signature and url.
3. If the installed DLL (`GAMESERVER_RUNTIME_DLL_PATH`, default `MysticParadox.dll` beside the game exe) already has that hash, stop.
4. Refuse to replace the DLL while any `Dauntless-Win64-Shipping.exe` runs (`tasklist`).
5. Download from the same origin as the manifest, over HTTPS (`SERVER_RUNTIME_ALLOW_HTTP` allows HTTP for local dev; URLs with credentials are refused). Check the size, the `MZ` header, the SHA-256 and the 64-byte Ed25519 signature against the **public key compiled into the file**. Then swap atomically (`<dll>.update-<pid>.tmp`, old file kept as `<dll>.bak`, rolled back if the rename fails).

The signing side is [Paradox Launcher](paradox-launcher.md) (`publish-runtime-update.mjs --target server`).

### Hunt-table importer (`scripts/import_hunt_tables.cjs`)

| Flag / env | Effect |
|---|---|
| (none) | Dry run against `versions/1.14.7/Items_Analysis/hunts_1_14_7`. Prints per-table added / changed / vendor-only rows, a game-type census and a referential check. Writes nothing. |
| `--export <x>` or `HUNT_EXPORT_DIR` | Another capture: an absolute path, a path relative to the cwd, a folder under `Items_Analysis`, or a bare version (`1.12` becomes `hunts_1_12`). |
| `--apply` | Writes new rows and new tables. Refuses (exit 2) if any matchmaker row lacks a `/Game/` map path or an enum number does not decode. |
| `--update-existing` | Also merges changed fields into existing rows (only fields the export carries; FText, unlocks and other unexported fields are kept; `_importedFrom` / `_updatedFrom` markers added). |
| `--verbose` | Lists every changed field. |
| `PARADOX_GAME_DATA_DIR` | Target folder instead of `game-data/`. |

Inputs: `player_hunts.jsonl`, `matchmaker_hunts.jsonl` and `hunt_export_manifest.json` (its `gameVersion` must be one the enum table knows: `1.12.0` or `1.14.7`). Output: `game-data/<table>.json` (2-space JSON, LF, no trailing newline). Each rewritten file is first backed up as `<file>.<ISO stamp>.bak`. `MatchmakingGameType` is always written as its UE name. A new table is only read once it is added to `MatchmakerTableSources`.

## Timers and limits

| What | Value | Where |
|---|---|---|
| Watchdog pass | 60 s | `server.ts` |
| Ready marker wait | `GAMESERVER_READY_TIMEOUT_MS`, default 30000 | `WaitForServerReady` |
| Hunt stagger | `SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP` s (no code default; `configure-selfhost.ps1` writes 3) | `ServerLaunchQueue` |
| Hub restart backoff | 5, 15, 30, 60, 120, 300 s | `DEFAULT_HUB_BACKOFF_MS` |
| Hub "stable" uptime | 120 s | `DEFAULT_HUB_STABLE_UPTIME_MS` |
| Hub wait for hunt queue | max 60 s | `HUB_HUNT_QUEUE_WAIT_CAP_MS` |
| Empty hunt grace before "last player left" reap | 20 s | `EMPTY_HUNT_GRACE_MS` |
| Public join: state age / sent window / min HP | 15 s / 90 s / 20 % | `JOIN_STATE_MAX_AGE_MS`, `JOIN_SENT_WINDOW_MS`, `JOIN_MIN_HP_PCT` |
| Trials rows | 181, bucket `TRIALS_ROTATION_MINUTES` | `TRIALS_ROTATION_ROW_COUNT` |
| Admin log tail | 256 KB | `TailFile` |
| Readiness line buffer | trimmed to 4 KB past 64 KB without a newline | `WaitForServerReady` |
| Runtime update fetch | 30 s timeout, 200 MB max | `runtimeUpdater.ts` |

## Logs and files written

| Path | Content |
|---|---|
| stdout (`<data>\logs\director.log` when started by [restart-server.ps1](host-scripts.md)) | pino-pretty console log |
| `<cwd>/../debug/deployserver/deployserver.log` | Same log without colours, truncated per start. With the usual cwd: `versions/1.14.7/debug/deployserver/` |
| `GAMESERVER_LOG_DIR/port<N>_<label>.log` | Per game server stdout+stderr, appended, with launch and exit banners. Default `versions/1.14.7/debug/gameservers/` |
| `MysticParadox.dll` (+ `.bak`, `.update-<pid>.tmp`) | Only by the runtime auto-update |

## Connects to

| Peer | How |
|---|---|
| [ParadoxBackend](backend.md) matchmaking | `controllers/matchmaking.ts` POSTs to `http://$DEPLOYSERVER_URL/api/matchmaker/handle-matchmaking-for-player` and `/join-public-hunt`, and GETs `/api/hub-status` and `/api/hunt-status?port=N` for the join-in-progress and fencing checks. `DEPLOYSERVER_URL` is `127.0.0.1:<Director PORT>`. |
| Backend staff console | `controllers/adminServers.ts` calls `/api/admin/gameservers`, `/gameservers/:id/stop` and `/gameservers/:id/log` with an `x-api-key` header. The key is the first entry of the backend's `GAMESERVER_API_KEYS`, which must equal the Director's `METAGAME_API_KEY`. |
| Game server processes | Spawn with argv and env (above). Read their stdout for the ready and hunt-state markers. The servers call the backend with `METAGAME_API_KEY` (see [Runtime](runtime.md)). |
| Players | Never talk to the Director. They get `MY_IP:port` through the backend and connect over UDP. Open those ports with [host-firewall.ps1](host-scripts.md). |
| Hunt tables | `game-data/*.json`, produced by CatalogExporter (`EXPORT_HUNTS=1`) and `import_hunt_tables.cjs`, see [Tools](tools.md). |
| Host scripts | [restart-server.ps1](host-scripts.md) runs `npm run build`, then `node --env-file=.env dist/server.js` (bypassing `prestart`), output to `<data>\logs\director.log`. |
| Update server | The backend serves `/launcher/v1/runtime/server/<channel>/windows-x86_64` for `runtimeUpdater.ts`. |

## Config

All from `ParadoxDirector/.env` (template: `.env.example`). Node loads it with `--env-file`.

| Variable | Default | Effect |
|---|---|---|
| `PORT` | required | Director HTTP port (loopback). |
| `MY_IP` | required | Host handed to clients and passed to each server as `MY_IP:port`. |
| `PORT_RANGE_BEGIN`, `PORT_RANGE_END` | required | UDP range. Last port Ramsgate, second-to-last Dojo, the rest hunts. |
| `GAMESERVER_BINARY_PATH` | required | Full path to `Dauntless-Win64-Shipping.exe`. |
| `METAGAME_API_KEY` | required | First argv of every server; the `/api/admin` key. |
| `SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP` | none | Hunt stagger in seconds. |
| `GAMESERVER_READY_TIMEOUT_MS` | 30000 | Ready-marker wait. |
| `HUB_PROMPT_RESTART` | `1` | `0`, `false`, `no`, `off` (any case) disable prompt hub restarts. |
| `TRIALS_ROTATION_MINUTES` | 10080 | Trials week bucket. Not an integer 1 to 525600: warning, uses 10080. |
| `MAX_CONCURRENT_HUNT_SERVERS` | 3 | Hunt cap. Size to RAM (about 1 GB per hunt). |
| `ENABLE_PUBLIC_HUNT_REUSE` | `0` | Only the exact string `1` enables reuse. |
| `PUBLIC_HUNT_MAX_PLAYERS` | 4 | Reuse and public-join occupancy cap. |
| `GAMESERVER_CHARACTER_LOG` | `VeryVerbose` | `LogPhoenixCharacter` verbosity. Live uses `Log`. |
| `GAMESERVER_LOG_DIR` | `<cwd>/../debug/gameservers` | Per-server log folder. |
| `GAMESERVER_WINDOWS_HIDE` | on | `0` shows game-server windows. |
| `LOG_LEVEL` | `info` | pino level. |
| `SERVER_RUNTIME_AUTO_UPDATE` | off | `1/true/yes/on` runs the signed DLL update at boot. |
| `SERVER_RUNTIME_UPDATE_REQUIRED` | off | An update failure aborts startup. |
| `SERVER_RUNTIME_MANIFEST_URL` | none (required when auto-update is on) | Manifest URL, e.g. our backend's `/launcher/v1/runtime/server/stable/windows-x86_64`. Artifacts are verified with the self-host public key (`RUNTIME_PUBLIC_KEY`). |
| `GAMESERVER_RUNTIME_DLL_PATH` | `MysticParadox.dll` beside the exe | DLL to replace. |
| `SERVER_RUNTIME_ALLOW_HTTP` | off | Allow `http:` update URLs. |
| `PARADOX_GAME_DATA_DIR` | `ParadoxDirector/game-data` | Table folder (also read by `run-tests.cjs` and the importer). |
| `MYSTICPARADOX_P2P_MODULE` | on | `0/false/off/no` ignores a `p2p` build folder. |
| other `MYSTICPARADOX_*` | - | Not read by the Director; inherited by game servers (the test stack sets `MYSTICPARADOX_API_BASE` this way). |

Build and run: `npm run build` (clean + `tsc`), `npm start` (`prestart` rebuilds if stale), `npm run dev` (tsx, no watch). Tests: `npm test`, `npm run test:hunt-coverage`.

## Gotchas

- **Restart needed.** The Director does not hot-reload code or `.env`. After a change run `host/restart-server.ps1 -DirectorOnly`. That also kills every game server, so players in hunts drop.
- **`restart-server.ps1` rebuilds the Director before starting it.** Plain `npm start` also rebuilds if stale. The Director and `dist/` must match.
- **Ready is not alive.** A process exists long before UE listens. Trust only `state === "ready"`. The getters and status routes check both ready and `kill(pid, 0)`; reuse checks only `state`.
- **Hunt cap errors.** At the cap `NoHuntCapacityError` is thrown. There is no Ramsgate fallback: `routes/matchmaker.ts` catches it and returns 500 `{ error: "matchmaking_failed" }`, which the backend treats as a matchmaking failure. That is deliberate (`controllers/matchmaker.ts`: redirecting to Ramsgate would make the UI claim a hunt was found).
- **Empty values in `.env` are not "unset".** With `--env-file`, `X=` reads as `""`, and `Number("")` is 0. `MAX_CONCURRENT_HUNT_SERVERS` uses `?.trim() || "3"` so a blank means the default; other `Number(process.env.X ?? ...)` reads do not, so set a number or delete the line.
- **SHARED hunts are always private**, so `join-public-hunt` can only find ISLAND hunts the backend started with `IsPrivate: false`.
- **`[HuntTableGap]` errors** mean the client asked for a hunt id missing from `player_hunts_table.json`. Re-export with CatalogExporter and import (see `game-data/README.md`).
- **Game data is not in git.** A fresh checkout needs real tables or the `*.example.json` copies. With placeholders the Director boots but cannot launch real hunts. Loading happens at import time, so a missing table crashes startup with a clear error. `emptyHuntReap.test.ts` imports `gameservers.ts`, so it needs the tables too even though it is not named `*.gamedata.test.ts`.
- **Two keys named alike.** `METAGAME_API_KEY` (Director) and the backend's `GAMESERVER_API_KEYS` must match. It is passed on the game server's command line, so it is visible in the local process list.
- **Hub ports are the last two in the range.** Shrinking the range changes which ports are hubs. The range needs at least 3 ports. `host-firewall.ps1` defaults and `server-sizing-log.ps1` assume 8789 and 8790.
- **Do not add anything that pauses `Child.stdout`.** See the freeze comment in `WaitForServerReady`.
- **Status and admin routes are mounted before request logging**, so the dashboard and fencing polls do not flood the log.
- **Trials week is pinned per process** through `MYSTICPARADOX_TRIALS_WEEK`, so a Trial in progress keeps its row when the weekly bucket changes.
- **The update public key and default manifest URL are upstream's**, hardcoded in `runtimeUpdater.ts`. A self-host operator who signs with their own key cannot use the server auto-update without editing the source.
- **`deployserver.log` is truncated on every start.** Copy it before restarting if you need the old run.

## See also

[Index](index.md), [Setup](setup.md), [Backend](backend.md), [Runtime](runtime.md), [Host scripts](host-scripts.md), [Tools](tools.md), [Paradox Launcher](paradox-launcher.md)
