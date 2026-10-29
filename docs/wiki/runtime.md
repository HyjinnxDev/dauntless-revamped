# ParadoxRuntime (MysticParadox.dll)

> Verified against code 2026-10-24.

File-by-file reference (every source file, every hook with its RVA, all 108 `*.flag` switches, env vars, stdout
markers and the full log-tag table): [runtime-files](runtime-files.md).

## What it is

`versions/1.14.7/ParadoxRuntime` builds one C++ DLL, `MysticParadox.dll`, that is loaded into the Dauntless 1.14.7 game process. The same binary runs in two roles:

- **Client** (a player's game): fixes login, redirects the game's HTTP traffic to our backend, adds UI (login branding, voice, cinematic camera, nameplates, health bar, join-in-progress popup), and patches bugs.
- **Dedicated server** (a hub or hunt started by the [Director](director.md), command line contains `-server`): forces dedicated-server flags, brings up networking, authenticates to the backend with the gameserver API key, and applies many server-side fixes.

It works by hooking the game with MinHook at **hard-coded RVAs** (offsets into the shipped exe, build CL 647472) and by hooking `UObject::ProcessEvent` to react to Blueprint/native function calls. It is derived from the Mystic Paradox project (AGPL-3.0, see file headers). Never push to the upstream repo.

## Key files

Everything lives in `versions/1.14.7/ParadoxRuntime/`. Full table in [runtime-files](runtime-files.md#files).

| Path | Purpose |
|---|---|
| `dllmain.cpp` | ~24.7k lines. Entry points, both `ProcessEvent` hooks, the server tick hook, URL redirect and almost every feature. Area map in [runtime-files](runtime-files.md#dllmaincpp-map). |
| `ParadoxRuntime/Networking.cpp`, `ParadoxRuntime/Networking.h` | Server listen (`Networking::Listen`, `AnnounceEngineReady`), READY marker, per-tick driver maintenance, actor-channel helpers. |
| `RuntimeShared.h` | Helpers and globals `dllmain.cpp` shares with the side files. |
| `Voice.cpp` | In-game voice (WASAPI + Opus + UDP relay) and hub proximity reports. |
| `CrashReporter.cpp` | Own crash reporter (replaces Unreal's CrashReportClient). |
| `JoinPrompt.cpp` | Join-in-progress offer polling (client). |
| `HuntStats.cpp` | Posts per-player hunt damage to the backend (server). |
| `WindowLock.cpp` | Keeps the player's window size/border across map loads (client). |
| `CineCamMenu.cpp`, `CineCamPath.cpp`, `CineCamShared.h`, `tools/CineCamPathCheck.cpp` | Cinematic camera menu, path math, shared state, standalone math check. |
| `P2PHooks.h`, `P2PHooksStub.cpp` | Seam for an optional player-hosted mode; the stub makes every server a normal Director gameserver. |
| `_build.bat`, `build-loader.bat`, `MysticParadox.sln`, `MysticParadox.vcxproj`, `BUILD.md` | Build. |
| `MysticParadox.rc`, `resource.h`, `assets/` | Embedded login PNGs. |
| `deployment_config.generated.h` | `MP_PUBLIC_HOST`, the compiled-in backend host. Gitignored; template `deployment_config.generated.h.example`; made by `versions/1.14.7/scripts/configure-selfhost.ps1`. |
| `SDK/`, `SDK.hpp`, `*.inl`, ... | Dumper-7 SDK dump. Gitignored, regenerated per `versions/1.14.7/docs/GENERATING_SDK.md`. |
| `MinHook/`, `imgui/`, `opus/` | Vendored MinHook, Dear ImGui 1.91.5, libopus 1.5.2. |
| `tools/compat-inventory.ps1` | Lists every hook RVA, raw RVA, vtable call and field offset in the source for a compatibility audit. |

## How it works

### 1. Loading

1. The game folder holds a `winmm.dll` proxy (Rust, `versions/1.14.7/tools/RuntimeLoader`). The game loads it as the normal Windows multimedia DLL; it forwards calls to the real system `winmm` and loads `MysticParadox.dll` (or legacy `MystPaxInternalServer.dll` if newer) plus any extra DLLs listed in `mystic_loader.ini`. See [tools](tools.md).
2. `DllMain(DLL_PROCESS_ATTACH)` calls `Init()`. `InitLog` is a no-op on purpose (loader lock), so `[Init]` lines never appear. But `Init` calls `InitClientHooks`/`InitServerHooks` from inside `DllMain`, and those do call `MpLog` and start threads.
3. `Init()` sets `Globals::AmServer` if the command line contains `-server`, and `Globals::BaseAddress` to the exe base.
4. On `DLL_PROCESS_DETACH` it sets `g_MpProcessDetaching` so nothing logs after the CRT shuts down (logging after detach crashed every client exit before 0.2.96).

### 2. Client vs server mode

- **Server**: `Init()` reads `MYSTICPARADOX_AUTH_MODE` (empty or `GLOBAL_GAMESERVER` = normal; anything else is invalid with the stub and `MainThread` exits with `0xE102`). It writes `GIsServer=1`, `GIsClient=0` into the exe. With more than 8 argv entries (a Director launch) it copies `argv[1]` gameserver API key, `[2]` port, `[3]` map, `[4]` behemoth, `[5]` matchmaker hunt id, `[6]` expected player roster, `[7]` IP:port. With fewer it is "manual test mode" (port 8777 or `Port=` from the command line, map `Ramsgate` or the first argument, empty-server watchdog off). Then `InitServerHooks()`.
- **Client**: `InitClientHooks()`, which also starts the crash reporter, voice, join prompt and window lock.
- Both then start `MainThread`. Server: it waits up to 30 s for a `UWorld` and sets `Globals::DoListen`; the next `GameEngineTickHook` calls `Networking::Listen`. With `MAP_URL_LISTEN.flag` the map URL gets `?listen`, the engine creates the listener, and the tick only announces readiness once `UWorld::NetDriver` exists. Either way the READY line is `MYSTICPARADOX_GAMESERVER_READY launchId=... port=...` on stdout, printed only when `MYSTICPARADOX_GAMESERVER_LAUNCH_ID` is set. The Director waits for it. Client: after 3 s `MainThread` flags console setup; the game thread spawns a `UConsole` on F2.

### 3. Hook installation

- `MH_Initialize`, then `MH_CreateHook` / `MH_EnableHook` on `BaseAddress + RVA` (or a named Win32 API). Most results are logged (`create=... enable=...`).
- Key hooks: `UObject::ProcessEvent` (`0x02861880`, `ProcessEventClientHook` / `ProcessEventHook`), `FCurlHttpRequest::ProcessRequest` (`0x032C5FE0`), `UEngine::Tick` (`0x03E10AB0`, server), `FCommandLine::Get` (`0x025E8F70`), `ApplyPlayerRole`, `HasFinishedLoading`, `IsEOSEnabled`, replication-graph routing, and exit/exception APIs for crash forensics. Full tables with every RVA: [runtime-files](runtime-files.md#hooks-installed).
- Some code patches are byte-guarded (`MpPatchBytesVerified` checks expected bytes first and fails closed): the 1-second party poll, the inventory resync cap, the 5 s crash-report wait, the WARP gate and the opt-in Move10 patches.
- Behaviour is switched with **`*.flag` files next to the game exe** (108 names). `DISABLE_*.flag` turns a default fix off; `ENABLE_*`/probe flags turn on opt-in or diagnostic code. `VERBOSE_DIAG.flag` and debug damage also need env `MYSTICPARADOX_RUNTIME_PROFILE=development`. A few flags are read only by dead code (`URL_LOG.flag`, `XMPP_TRACE.flag`, `CHARACTER_ASSOC_PROBE.flag`) or ignored (`DISABLE_EAC_LOAD.flag`).

### 4. Talking to the backend

The game itself does its HTTP calls (through its curl wrapper); the runtime redirects them.

1. The `ProcessRequest` hook calls `MpRewriteRequestUrl`. If the request host is on the allowlist (`steelyard.ca`, `steelyard.online`, `ol.epicgames.com`, `api.epicgames.dev`, apex or dot-subdomain), the URL at request `+0x70` becomes `<MpApiBase>/__origin/<original-host>/<original-path>`, reallocated with the engine allocator. In-flight requests are left alone. The backend uses the `__origin` prefix to route as if it were that service. See [backend](backend.md).
2. `MpApiBase` is `https://` + `MP_PUBLIC_HOST` (compiled in) unless env `MYSTICPARADOX_API_BASE` (`http(s)://host:port`, no path) is set. The launcher uses that override to point the game at its local relay (see [launcher](launcher.md)).
3. On a gameserver (`GLOBAL_GAMESERVER` mode) the same hook adds header `x-mysticparadox-gameserver-apikey` to every request through the request's virtual `SetHeader` (vtable index 16).
4. XMPP: the runtime does **not** redirect XMPP. `InstallXmppConfigRedirectHook` exists but is never called (`InitClientHooks` logs "XMPP config hook skipped"). The player launcher writes an `[OnlineSubsystemMcp.XMPP]` section (`ServerAddr="ws://127.0.0.1"`, relay port, `bUseSSL=false`) into the game's `Engine.ini` (`launcher/src/main/launch.ts` `withXmppSection`). Backend side: [backend-realtime](backend-realtime.md).
5. Login: `IsEOSEnabled` returns 0 and the engine command line gains `-DisableEOS` and `-NoEAC`, so login uses the backend's MCP/EOS emulation and EAC never loads (the `EnableEasyAntiCheatFeatures` byte is also cleared).
6. QoS: lookups of `*.gce.latency-test.steelyard.ca` resolve to `127.0.0.1` so the client's region pings (plain HTTP port 80) get an answer.

Calls made by the runtime's own code (not the game's HTTP stack), via WinHTTP or UDP:

| Caller | Request | Auth |
|---|---|---|
| `HuntStats.cpp` | `POST /mystic/hunt-stats` (JSON per-kill damage) | gameserver API key header |
| `JoinPrompt.cpp` | `GET /mystic/party/hunt-offer` every 1 s, `POST /mystic/party/join-hunt` | `X-Mystic-Ticket` (launcher voice ticket) |
| `CrashReporter.cpp` | `PUT /crash/v1/reports/<id>/report.json`, `minidump.dmp`, `context.xml` | none |
| `Voice.cpp` (client) | UDP to `MYSTICPARADOX_VOICE_ADDR` | ticket in the hello packet (`'H' + ticket`) |
| `Voice.cpp` (hub server) | UDP `P` position reports to `MYSTICPARADOX_VOICE_RELAY` (default `127.0.0.1:8791`) | HMAC-SHA256 with the gameserver key |

Servers also talk to the Director on stdout: the READY line and, on hunts, `MYSTICPARADOX_HUNT_STATE hpPct= players= subState=` on change and every 5 s.

### 5. Build and publish

1. Build: `_build.bat` (vswhere -> MSBuild, `MysticParadox.sln` Release x64) -> `x64\Release\MysticParadox.dll`. Needs Visual Studio with the v145 toolset, the generated SDK and `deployment_config.generated.h`. `build-loader.bat` builds the `winmm.dll` proxy (Rust).
2. Check the import list: no `MSVCP140.dll`, `VCRUNTIME140*.dll` or `api-ms-win-crt-*` (static CRT, see Gotchas).
3. Publish from `versions/1.14.7/ParadoxLauncher` with `scripts/publish-runtime-update.mjs` (full command in the repo root `CLAUDE.md`: `--dll ../ParadoxRuntime/x64/Release/MysticParadox.dll --extra <prev version dir>/winmm.dll --target client --version <bump> --changelist 647472 --channel stable --output 'D:\MysticParadoxData\updates' --key .secrets/...`). It SHA-256 hashes and Ed25519-signs the DLL (reusing the old signature if the hash is unchanged), and writes `manifest.json` + `latest.json`. Run it again with `--target server` for the same DLL.
4. The backend serves the feed at `/launcher/v1/runtime/<target>/<channel>/windows-x86_64`. Clients: the Revamped launcher fetches the client release on every Play and replaces `MysticParadox.dll`/`winmm.dll` when the SHA-256 differs (hash only, no signature check), so a hand-copied DLL is overwritten. Servers: the Director's `runtimeUpdater.ts` fetches the server release and verifies its Ed25519 signature. No backend restart is needed. See [launcher](launcher.md) and [paradox-launcher](paradox-launcher.md).

### 6. Logging

- `MpLog` appends to `mysticparadox_dll_port<N>.log` next to the game exe (N = server port, 0 on a client). Format `[HH:MM:SS.mmm] pid=<pid> <message>`; every call opens and flushes the file. `Networking.cpp`'s `NetLog` writes to the same file without timestamp or pid.
- Lines are tagged with a bracketed prefix, for example `[HuntStats]`, `[Voip]`, `[InvHeal]`, `[NetRate]`, `[LateJoin]`, `[UrlRedirect]`, `[Move10]`, `[CineCam]`. Every tag: [runtime-files](runtime-files.md#log-tags).
- Hunt servers also write `HuntCombat\hunt_<start>_port<N>.log` beside the exe (`MpHuntCombatLog`).
- `CrashReporter.cpp` writes `MysticReport.json` and `MysticDump.dmp` into Unreal's `UE4CC-*` crash folder (or `%TEMP%\MysticCrash-<id>`) and uploads them with the engine's `CrashContext.runtime-xml`.

## Feature map

Search for the symbol or the `[Tag]` to find the code.

### Networking, backend and login

| Area | What it does |
|---|---|
| `ProcessRequest`, `MpRewriteRequestUrl` | URL redirect to `/__origin/...`, gameserver API key header. |
| `HookFCommandLineGet`, `HookIsEOSEnabled`, `HookEasyAntiCheatHandleError` | `-NoEAC -DisableEOS` on the engine command line (plus `-nullrhi` on servers launched with it); EOS off; only the expected EAC client-init error is absorbed. |
| `InstallQosHostResolutionHook` | QoS latency-test hosts -> loopback. |
| `InstallSocketDiagnostics` | sendto/recvfrom logging, only with `SOCKET_DIAG.flag`. |
| Party poll patch (`InitClientHooks`) | Party poll 5-10 s -> 1 s (`DISABLE_FAST_PARTY_POLL.flag` reverts). |
| Inventory resync cap (`InitClientHooks`) | Client never force-reloads inventory on an item-state hash mismatch (`DISABLE_INVENTORY_RESYNC_CAP.flag` reverts). |
| `Networking.cpp` | `Listen`, `AnnounceEngineReady`, `TickNetworking`, `BootstrapActorChannel`, `GetActorChannelIndexForConnection`. The native replication graph is the only replication path on 1.14.7. |
| `ApplyNetRateBoost` | Per-connection bandwidth caps raised to 100000 B/s (`DISABLE_NET_RATE_BOOST.flag`). |
| `CreateRepDriverHook`, `MpDriveReplicationGraph`, `ArchonRouteAddNetworkActorHook`, `TickRepGraphRelevanceSettings` | Install and drive `ArchonReplicationGraph`, route roles/weapons/drones, relevance settings. |
| `PlayerControllerSetChannelActorGuardHook`, `ReplicateActorFreqHook` | Never send a PlayerController's first bunch to the wrong connection. |
| `P2PHooks*` | Optional player-hosted mode seam; stubbed here. |

### Client UI / HUD

| Area | What it does |
|---|---|
| `namespace LoginBranding` | Login screen: `LoginLoop.mp4` background video if installed, else embedded PNG; Revamped logo; hides the patch-notes title (`DISABLE_LOGIN_BRANDING.flag`, `DISABLE_LOGIN_VIDEO.flag`). |
| `namespace CreditsBranding`, `PressStartBranding` | Credits block; press-start text, popup auto-skipped. |
| `namespace BehemothHealthBar` | Native HP bar and number for live behemoths within 35 m (UE4SS cannot call UFunctions on 1.14.7). |
| `namespace StaffNameplates` | Staff and Patreon name styles on nameplates (tags come from backend `staffRoles.ts`). |
| `namespace VoiceSettings` | Push to Talk binding and Open Mic toggle in the options menu; feeds `Voice.cpp`. |
| `namespace VoiceIndicators` | Talking/muted icons on party HUD, own health bar and nameplates. |
| `namespace JoinPopup` | Shows the join-in-progress offer in the game's own popup. |
| `namespace InventoryProbe` | `[InvProbe]` inventory change log, `[InvHeal]` re-query when a hunt map shows a blank inventory, `[LoadoutHeal]` re-resolve of gear slots left empty by a replication race. |
| `LoadMapDiagHook` | Renames a pending-kill hub world package before `LoadMap` so hub re-entry does not crash (`DISABLE_ZOMBIE_WORLD_TRASH.flag`). |
| `InstallHuntPassClaimGuard`, `InstallCellOfferProbe` | Guard a hunt pass claim crash; log Middleman cell-offer prices. |
| `InstallFeatureFlagForce` | Forces blueprint feature flags listed in `FORCE_FEATURE_FLAGS.txt` (seasonal Ramsgate such as Frostfall). Client and server. |

### Voice (`Voice.cpp`)

Mic capture (WASAPI, 48 kHz mono) -> Opus 20 ms frames -> UDP to the backend voice relay -> jitter buffer per speaker -> mix -> WASAPI out. Two threads; never touches UObjects. Needs env `MYSTICPARADOX_VOICE_ADDR` and `MYSTICPARADOX_VOICE_TICKET` from the launcher; off with `DISABLE_VOIP.flag`. Proximity in Ramsgate: the hub server sends player ids and positions to the relay (`MpVoiceProximityTick` -> `MpVoiceReportPositions`, about 5 per second); the client only pans and fades. Backend side: [backend-realtime](backend-realtime.md).

### Cinematic camera (`CineCam*`)

F8/F9/F10 camera (state in `dllmain.cpp` `namespace CineCam`, menu in `CineCamMenu.cpp`). The menu is Dear ImGui drawn in a D3D11 `Present` hook (D3D11 only). Path math (Catmull-Rom / Kochanek-Bartels) in `CineCamPath.cpp`. Settings in `CINECAM.ini`, shots in `CINECAM_shots\`. Owner accounts only: `OwnerOnly` requires the local player name to start with `[Owner] `. Off with `DISABLE_CINECAM.flag`.

### Window lock (`WindowLock.cpp`)

Hooks `SetWindowPos`, `MoveWindow`, `SetWindowLong(Ptr)W`. If the engine repeats its previous request (a map-load re-apply), the window keeps its current rect and border, so a user-set borderless window survives. After a kept re-apply it posts `WM_MOVE`/`WM_SIZE` with the real client rect: Slate caches the size it requested, so without this the game renders and maps the mouse for the engine's rect (stretched picture, offset clicks). It also subclasses the game window: a captionless window that does not fill its monitor (e.g. shrunk by Borderless Gaming) gets 8 px drag-resize edges. A window filling the monitor has none, so shrink it once with the tool or the options menu. Off with `DISABLE_WINDOW_LOCK.flag`.

### Server fixes and headless hub

| Area | What it does |
|---|---|
| `InstallServerHeadlessSetup`, `InstallServerWindowSuppressionHooks` | Hide every server window (`SHOW_SERVER_WINDOW.flag` keeps it); the engine's own `-nullrhi` cache picks the null RHI. |
| Server audio (`ProcessEventHook`, `InstallHeadlessAudioHook`) | Wwise `PostEvent` calls are skipped on servers (`ENABLE_SERVER_AUDIO.flag` restores). Removing the audio device is opt-in with `DISABLE_SERVER_AUDIO.flag` and was measured to crash. |
| `InstallWarpForceHooks` | Boot the client-build binary without a GPU (WARP renderer, `MP_FORCE_WARP.flag`). |
| `GetGameDefaultMap` | Builds the map URL from argv: `?MonsterClass`, `?HuntId`, `?PlayerHuntIds`, `?MaxPlayers` (`HUB_MAX_PLAYERS.txt`, default 4), Gauntlet options, optional `?listen`. |
| Phantom local player (`MpSuppressPhantomReplication`, `MpDestroyPhantomPawn`, `MpIsPhantomThatMayNotRestart`) | The client build spawns a phantom local player on servers; on hubs its pawn is destroyed and it is never restarted. A synthetic net id for it is opt-in (`ENABLE_SYNTHETIC_NETID.flag`). Move10 patches that would stop the phantom are opt-in (`ENABLE_MOVE10_1147.flag`) and stop boot on this build. |
| `StartEmptyWatchdogThread`, `MpReapExit` | Terminate a disposable instance 50 s after its last client left (5 min if nobody came, 180 s if the game thread stops); Ramsgate/Training are exempt but exit if their port has been free 45 s so the Director restarts them. |
| `ArchonLoadManagerLoadFailedHook` | One retry of a stuck player-data loader. |
| `OnPlayerDataLoadCompleteHook` | Backfill an empty `PlayerHuntId` so drop-in players get rewards. |
| Progression probes (`InstallProgressionDiagnostics`, `...CacheProbe`, `...ReadinessProbe`) | Read-only probes plus flag-gated queries; six riskier probes are not installed. |
| `InstallInteractionCalloutSetDisabledGuard`, `InstallInteractionCalloutClassGuards`, `InteractionCalloutHideHoldTextHook` | Avoid null-widget crashes in `UInteractionCalloutWidget` on server roles. |
| `InstallServerCrashWaitBound`, `InstallInventoryRefreshGuard` | Engine crash-report wait 60 s -> 5 s; guard equipped-item refresh before a joiner's loadout slot exists. |
| `MpServerProjectileTickFix` | Server projectile actors tick again so projectiles deal damage. |
| Player role (`ApplyPlayerRoleHook`, `TickPlayerRoleRetries`, `RoutePlayerRoleTo*`) | Omnicell apply/retry and routing; client replays the apply after travel. |
| Escalation (`EnsureEscalationBoonsUnlocked`, `TickEscalationBuffChoiceSpawn`) | Every boon row unlocked so the pool is never empty (`ESCALATION_KEEP_BOON_UNLOCKS.flag` reverts); seasons whose relic tag filter leaves <15 boons (frost) get the filter dropped (`ESCALATION_KEEP_RELIC_TAGS.flag` reverts); per-player buff choices at round end. |
| Trials (`SchedulerInitializeHook`) | Rewrites all 181 arena rows into rotating windows (`TRIALS_ROTATION_MINUTES`, default 7 days) before the scheduler copies them; an arena process is pinned with `MYSTICPARADOX_TRIALS_WEEK`. |
| `GameEngineTickHook` | Idle-hub throttle, re-asserts server flags, listen, voice proximity, hunt join/stats, role retries, party restart hold, empty reaper, net rate. |

### Gauntlet, join in progress, hunt stats

| Area | What it does |
|---|---|
| Gauntlet (`LaunchGauntletLevel`, `GetGameDefaultMap`, `MpTickGauntletProbe`) | Reads `MYSTICPARADOX_GAUNTLET_LEVEL` from the Director launch, adds `?GauntletLevel=`. Any hunt: `MYSTICPARADOX_GAME_MODE` (row `GameModeOverride`) -> `?game=`, so Gauntlet, story missions, events and patrols run their own mode instead of the map default. See [director](director.md). |
| `MpHuntJoinTick` | Once a second on hunts: rescales behemoth HP when the player count rises (`DISABLE_LATE_JOIN_RESCALE.flag`) and prints `MYSTICPARADOX_HUNT_STATE`. |
| `MpHoldRestartForParty` | Holds launch-roster players pawn-less until all have joined, up to 40 s (`DISABLE_PARTY_ARRIVAL_HOLD.flag`). Party drop-in arrival is opt-in with `ENABLE_PARTY_DROP_IN.flag`. |
| `JoinPrompt.cpp` + `JoinPopup` | Client worker thread polls `/mystic/party/hunt-offer`; the game thread shows the popup; the answer posts `join-hunt`. |
| `MpHuntStatsTick` + `HuntStats.cpp` | Keeps each player's max damage per behemoth/part, weapon and downs; when the target behemoth dies, adds the game's combat telemetry and posts JSON to the backend -> Slayer's Ledger. `DISABLE_HUNT_STATS.flag` off. |

### Crash reporter (`CrashReporter.cpp`)

Intercepts `kernelbase!CreateProcessW` when the engine tries to start CrashReportClient, plus `UnhandledExceptionFilter`. Writes a JSON report (exception, module+RVA, stack, registers, log tail) and a minidump, uploads them and the engine's CrashContext to the backend, and refuses the original launch. Clients get a "Dauntless crashed" message box. Reports are filed to a GitHub repo by the backend (see [backend-security-admin](backend-security-admin.md)). Off with `DISABLE_CRASH_REPORTER.flag`.

## Connects to

- [Backend](backend.md): all game HTTP via `/__origin/...`; `/mystic/hunt-stats`, `/mystic/party/*`, `/crash/v1/reports/*`; voice relay UDP (port handed out with the voice ticket; backend default `VOICE_UDP_PORT=8791`, `voiceRelay.ts`). Realtime details in [backend-realtime](backend-realtime.md).
- [Director](director.md): launches servers with the argv layout above and env (`MYSTICPARADOX_GAMESERVER_LAUNCH_ID`, `MYSTICPARADOX_GAUNTLET_LEVEL`, `MYSTICPARADOX_TRIALS_WEEK`, ...); reads the READY and HUNT_STATE lines from stdout; installs the signed server runtime.
- [Player launcher](launcher.md): installs the client DLL and `winmm.dll`, writes the XMPP `Engine.ini` section, injects env (`MYSTICPARADOX_API_BASE`, `MYSTICPARADOX_VOICE_ADDR`, `MYSTICPARADOX_VOICE_TICKET`). [launcher-bridge](launcher-bridge.md) is the older copy.
- [ParadoxLauncher](paradox-launcher.md): `publish-runtime-update.mjs` signs and publishes the DLL.
- [Tools](tools.md): the RuntimeLoader proxy and CatalogExporter (its `StoreRuntimeExporter.cpp` is compiled into the DLL).

## Config

Environment (full table in [runtime-files](runtime-files.md#environment-variables)):

| Variable | Used for |
|---|---|
| `MYSTICPARADOX_API_BASE` | Override backend base URL (`http(s)://host:port`). |
| `MYSTICPARADOX_AUTH_MODE` | Server auth mode; default `GLOBAL_GAMESERVER`. |
| `MYSTICPARADOX_GAMESERVER_LAUNCH_ID` | Echoed in the READY marker; no marker without it. |
| `MYSTICPARADOX_GAUNTLET_LEVEL`, `MYSTICPARADOX_GAME_MODE`, `MYSTICPARADOX_TRIALS_WEEK`, `TRIALS_ROTATION_MINUTES`, `MYSTICPARADOX_BLEEDOUT_SECONDS`, `MYSTICPARADOX_PHANTOM_ACCOUNT_ID` | Server launch parameters. |
| `MYSTICPARADOX_VOICE_ADDR`, `MYSTICPARADOX_VOICE_TICKET`, `MYSTICPARADOX_VOICE_RELAY` | Voice relay address and auth (the ticket also authorises the join prompt). |
| `MYSTICPARADOX_RUNTIME_PROFILE` | `development` unlocks verbose diagnostics and debug damage. |
| `MYSTICPARADOX_ALLOW_DAMAGE_DEBUG`, `MYSTICPARADOX_DEBUG_DAMAGE_MULTIPLIER` | Debug damage tooling. |

Files beside the game exe: the `*.flag` toggles, `FORCE_FEATURE_FLAGS.txt`, `HUB_MAX_PLAYERS.txt`, `CINECAM.ini`, `CINECAM_menu.ini`, `CINECAM_shots\`, `VOIP_OPEN_MIC.flag` (written by the game's Open Mic toggle), `mystic_loader.ini` (loader), the log files and `HuntCombat\`. Build-time: `MP_PUBLIC_HOST` in `deployment_config.generated.h`. Hard-coded: build number 647472, all RVAs.

## Gotchas

- **Game build locked.** RVAs and struct offsets are for 1.14.7 / CL 647472. A game patch silently breaks hooks. Only some patches are byte-verified; some newer guards check `.pdata` function entries before hooking.
- **Publish both feeds.** Publish the same DLL hash for `client` and `server`. The player launcher overwrites a hand-copied client DLL with the published one.
- **Static CRT (`/MT`).** Do not switch to `/MD`; the game ships old `msvcp140.dll` and the loader prefers it. Check the import list after a build. After `DLL_PROCESS_DETACH` nothing may log.
- **Loader lock.** `InitLog` is empty, but `InitClientHooks`/`InitServerHooks` run inside `DllMain` and call `MpLog`, read files and create threads. It works today; unverified whether that is safe in all cases.
- **Engine memory.** FStrings written by the DLL must be grown with the engine allocator (`EngineRealloc`), never `malloc`.
- **Gear replicates as a CRC.** `FItemInstanceIdRepl` sends only `ItemInstanceIdCrc`; the client maps it to an item through its own inventory. A gear slot that replicates before the client's inventory actor never resolves on its own (equipment screen empty, power 0, potions still shown); `[LoadoutHeal]` covers it. Loadout cosmetics (banner, title, emotes, accessories) use the same type through other resolvers and are not healed.
- **Inventory hash ping-pong.** After every server item op the client hashes its item-state array (sorted `{crc(InstanceID), crc(CatalogId), Quantity, crc(CustomData)}`) against the op's `PostOperationHash`; the engine answers a mismatch with a full client HTTP reload plus a server reload, up to 10 times (`CurrentMismatchCount`). On this stack the hashes disagree at most map joins even after both sides reload from the same backend data (2026-10-25 logs: 9 bursts of ~10 bearer + ~10 gameserver `GET /inventory` in one second, `[InvProbe] mismatch 0->10`), so the menu and gear slots were rebuilt under the player 10 times per join (blank inventory, naked character). The resync cap patch stops the reloads; which item makes the hashes differ is still unknown.
- **Game thread vs. worker threads.** Voice, join prompt, hunt-stats upload, crash reporter and the empty-server watchdog run on their own threads and must not touch UObjects; they hand data over via atomics/mutexes.
- **`.flag` files are a user-visible switch.** A leftover `ENABLE_*` or probe flag changes behaviour (and log size, for example `REPGRAPH_DIAG.flag`). Remove the flag rather than editing code. Most are cached at first read, so set them before launch.
- **Dead code.** `InstallXmppConfigRedirectHook`, `MpLogUrlObservation`, `HookGetCommandLineW/A`, `GetCommandLineHook`, `MpProbeCharacterRequestAssociation` and six progression probes are defined but never installed or called. Do not assume a comment describes live behaviour; check `InitClientHooks`/`InitServerHooks`.
- **Big single file.** `dllmain.cpp` is one huge file with many retired probes and long history comments. Search by `[Tag]` or flag name.
- **`p2p\` and `anticheat\` folders do not exist** in this repo; the stub compiles. Do not reference them from `dllmain.cpp`.
- **`deployment_config.generated.h` and the SDK are gitignored.** A fresh clone will not build until both exist.
- **Gameserver key in argv.** The API key is `argv[1]` of the server process; treat server hosts as trusted.
- **QoS loopback.** Latency-test hosts resolve to `127.0.0.1` on the player's own machine; the backend's port-80 pong only answers there when the player runs on the server box.

See also: [index](index.md), [setup](setup.md), [runtime-files](runtime-files.md), [paradox-launcher](paradox-launcher.md), [director](director.md), [backend](backend.md), [tools](tools.md).
