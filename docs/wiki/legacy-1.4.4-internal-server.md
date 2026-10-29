# Legacy 1.4.4: UndauntedInternalServer (the injected DLL)

> Verified against code 2026-10-24.

## What it is

`versions/1.4.4/UndauntedInternalServer/` is a C++ Visual Studio project (toolset v143, x64, output `UndauntedInternalServer.dll`). It is the trick that makes 1.4.4 multiplayer possible. The retail Dauntless client has its server code compiled out, but the Unreal networking layer underneath is intact, so a DLL loaded into the **same game exe** can turn it into a dedicated game server (`-server`) and, in client mode, redirect the client's online calls to our Metagame. The same DLL runs in both roles. It is the 1.4.4 counterpart (and ancestor) of `MysticParadox.dll` in [runtime](runtime.md): `versions/1.14.7/ParadoxRuntime/dllmain.cpp` and `Networking.cpp` still carry the same hook layout and say which parts were "inherited from 1.4.4". Part of the [legacy 1.4.4 stack](legacy-1.4.4.md).

How it gets loaded: a prebuilt `dxgi.dll` proxy placed next to the exe loads it (`dxgi.dll` is a static import of the exe). The proxy's source is not in this tree; both DLLs ship as binaries in `UndauntedLauncher/assets/` and are hash-pinned (see [launcher](legacy-1.4.4-launcher.md)). Background: `versions/1.4.4/docs/findings/multiplayer.md`.

## How it works

### Role detection (`Init()` in `dllmain.cpp`)

`DllMain` (process attach) calls `Init()`, which installs hooks and starts `MainThread`.

- `Globals::AmServer` is true when the process command line contains `-server`.
- **Server:** patches the engine's `GIsServer`/`GIsClient` bytes, then reads positional args from the real command line (the DeployServer builds them; see [gateway-deploy](legacy-1.4.4-gateway-deploy.md)):

  | argv | Meaning |
  |---|---|
  | 1 | game-server API key (becomes the `x-undaunted-gameserver-apikey` header) |
  | 2 | UDP port |
  | 3 | map path |
  | 4 | behemoth path or `NO_BEHEMOTH` |
  | 5 | matchmaker hunt id or `NO_MM_HUNTID` |
  | 6 | expected players `accountId:playerHuntId,...` or `NO_EXPECTED_PLAYERS` |
  | 7 | `publicIp:port` |

  Fewer than 9 argv entries shows a message box "INVALID GAMESERVER ARGS" and exits. A Ramsgate map (`/ramsgate/ramsgate_01_persistent`) turns off the idle watchdog, turns on console logging, and with `DR_RAMSGATE_POOL=1` marks the process a pooled city.
- **Client:** argv[1] is the Metagame address (`host:port`), set by the launcher or friend kit. A console window is opened (not under Wine) and kept hidden unless `DR_SHOW_CONSOLE=1`.
- `MainThread` waits for `UWorld`, sleeps 3 s, then: client spawns a `UConsole` (console key F2); server sets `Globals::DoListen`, and the next tick calls `Networking::Listen`.

### Server mode hooks (`InitServerHooks`)

All hooks are MinHook detours at fixed offsets from the exe base address, so the DLL only works with the one pinned exe build. `InitServerHooks` first hooks `SetChannelActor` (`Networking::InitChannelTracking`) and sets `Globals::MetagameAddress = 127.0.0.1:61000`.

| Hook | Effect |
|---|---|
| `GetCommandLineHook` | Engine sees `-server -unattended -nullrhi -nosound -EpicPortal -RepDriverDisable`, never the real args |
| `GetGameDefaultMap` | Travel URL `map[?MonsterClass=<behemoth>][?HuntId=<id>][?PlayerHuntIds=<roster>]` from argv |
| `ConfigCacheInitGetStringHook` | Phoenix endpoint keys from `EvalEndpointMap()` resolve to `http://127.0.0.1:61000/...`; other config untouched |
| `GameEngineTickHook` | Per frame: frame limiter (`DR_SERVER_MAX_FPS`), pooled-city `MaxPlayers = 20`, engine tick, `TrialsSchedule::Tick`, `CellFusionTime::Tick`, `FallRecovery::Tick`, `Networking::TickNetworking()`, deferred `Listen`, connected-player snapshot, city occupancy file, idle shutdown (`TerminateProcess`), per-player `TickStamina` + `ReleaseStuckRamPat`, `PerfLog` |
| `ProcessRequest` | Adds `x-undaunted-gameserver-apikey`, `x-dauntless-hunt-completion` (JSON `{id, hunt, players}` of a finished hunt, empty otherwise) and, when `DR_SERVER_READY_FILE` gives a session id, `x-dauntless-game-session-id` + `x-dauntless-connected-player-ids` (JSON list; empty string = unknown) to every outgoing HTTP request |
| `ProcessEventHook` | Replaces `ServerTryActivateAbility[WithEventData]` with `ServerTryActivateAbilityInternal`; on `OnEndOfHuntStarted` / `MasteryComponent.OnHuntFinished` captures the hunt result for the header; clears it on `TransitionToIslandGameplay` |
| `GetStartSpotHook` | Phoenix's group/slot-aware `GetPlayerStartForPlayer`, with `PickPlayerStartFallback`; records the start for `FallRecovery` |
| `HasFinishedLoadingHook`, `IsNetReadyHook`, `IsLevelInitForActorHook` | Force "loaded"/"net ready"/"level init" true |
| `SetReplicationDriverHook`, `GetNetDriverInternalHook`, `FixupNetworkNotifyHook`, `NetModeHook` | Disable the replication driver, return our `Networking::NetDriver`, fix the world's `NetworkNotify`, report net mode 1 (dedicated) |
| `ServerBootCrash`, `EncounterableSetupHook` | No-ops that skip boot code which crashes headless (the second also hooked at the combat-text address) |
| `GetEscalationSeason` (misnamed) | Hunt-unlock check: Trials rows only for this week (`TrialsSchedule::IsTrialRowUnlocked`), Arena and Escalation (not "Mint") always unlocked |
| byte patches at the end of `InitServerHooks` | In-place code patches at fixed offsets (no symbols in source) |

Disabled in source: `MakeDoDamageHook`, `SprintHook`, `GetTrackProgress`, `GetActorCallspace`.

### Client mode hooks (`InitClientHooks`)

- `ConfigCacheInitGetStringHook` maps every Phoenix endpoint key (auth, account, character, inventory, progression, bounty, cooldown, Escalation, store, entitlements, matchmaking, Trials leaderboards, loadouts, Linked Slayers, guild `*_v2`...) to `http://<MetagameAddress>/...`. For sections containing `Mcp` it forces protocol `http` and Domain/RedirectUrl to the Metagame address.
- `EACClientInitHook` no-ops the EAC client plugin init (compile flag `DR_SKIP_EAC_CLIENT_INIT`), so no "Failed to create IGameClient" popup; the launcher also passes `-NoEAC`.
- `HasFinishedLoadingHook`, `GetEscalationSeason` (hunt unlocks, as above).
- `ProcessEventClientHook`: runs `TrialsSchedule::Tick`, `CellFusionTime::Tick`, `AutoPressStart`, `VendorTabs`, `NoPlatinumPrice`, `DeveloperStyle`, and lets tonics be bought while the Bosun potion quest is still open (`EquipmentItemViewModel.CanPurchase`).

### Handshake with the DeployServer

- `DR_SERVER_READY_FILE`: after `Listen` succeeds, `Networking::Listen` writes `<pid>:<port>` to that file; the DeployServer waits for it (`docs/hunt-readiness.md`). The file name also yields the game-session id (`ConnectedPlayerSnapshot::SessionIdFromReadyFile`) used in the headers.
- `GAMESERVER_READY_DIR`: folder for `native-fault-<pid>.log` (`DR_InitDiagnostics`), `perf-<pid>.log` (`PerfLog`) and, for pooled cities, `city-occupancy-<pid>.txt` (`<pid> <active connections>`, every second).
- Idle shutdown: hunts end 180 s after start with nobody ever connected, or 30 s after the last player left (`HuntIdlePolicy`); a pooled city ends as soon as it is empty after having had a player, or after 180 s with none (`CityIdlePolicy`).

## File reference

All under `versions/1.4.4/UndauntedInternalServer/`.

### Core

| File | What it does |
|---|---|
| `UndauntedInternalServer/dllmain.cpp` | `DllMain`, `Init`, `MainThread`, `EvalEndpointMap`, all hooks above, `InitServerHooks`, `InitClientHooks`; exports `DummyLinkFunc` and `DR_ServerTickCount` / `DR_ServerSimulatedSeconds` / `DR_EngineMicros` / `DR_ReplicationMicros` counters |
| `UndauntedInternalServer/Networking.cpp` | `Listen` (create `GameNetDriver`, bind UDP port, write ready file), `TickNetworking` (custom per-frame actor replication: `BuildConsiderList`, owner-only relevancy, cadence, channel open/replicate), `InitChannelTracking` (hook `SetChannelActor` for the channel index) |
| `UndauntedInternalServer/Networking.h` | Declares `Networking::NetDriver`, `LastActorCount`, `LastConsiderUs`, `InitChannelTracking`, `Listen`, `TickNetworking` |
| `UndauntedInternalServer/constants.h` | `UNDAUNTED_INTERNAL_VERSION` = "0.0.3" |
| `UndauntedInternalServer/framework.h` | `WIN32_LEAN_AND_MEAN` + `windows.h` |
| `UndauntedInternalServer/DataTables.h` | `FindDataTable(name)`: walks `GObjects` for a cooked `UDataTable` |
| `UndauntedInternalServer.sln`, `.vcxproj`, `.vcxproj.filters` | VS 2022 project; compiles `dllmain.cpp`, `Networking.cpp`, MinHook `.c` files and the SDK `*_functions.cpp` it needs |

### Server policies and replication

| File | What it does |
|---|---|
| `UndauntedInternalServer/ChannelLookup.h` | `ChannelIndex`: tick-local actor -> channel-slot index for O(1) lookup (stores keys and slots, never channel pointers) |
| `UndauntedInternalServer/OwnerRelevancy.h` | `IsConnectionOwner`: owner-chain walk (max depth 64) for owner-only actors |
| `UndauntedInternalServer/ReplicationCadence.h` | `ReplicationCadence`: honours low authored update rates with a 10 Hz floor, never delays movement, first delivery or teardown |
| `UndauntedInternalServer/ServerFrameLimit.h` | `ParseServerFrameLimit`: `DR_SERVER_MAX_FPS` 10-120, `0` = engine default, else 30 |
| `UndauntedInternalServer/PerfLog.h` | Aggregate timing telemetry to `<GAMESERVER_READY_DIR>\perf-<PID>.log` every 10 s (`DR_PERF_LOG=0` off, `DR_PERF_SAMPLE=N`, default 4) |
| `UndauntedInternalServer/NativeDiagnostics.h` | `DR_InitDiagnostics`: vectored exception handler logging access violations/stack/heap faults (address only, max 32) to `native-fault-<pid>.log`; `DR_TickStage` |
| `UndauntedInternalServer/HuntIdlePolicy.h` | 180 s grace before the first player, 30 s once empty |
| `UndauntedInternalServer/CityIdlePolicy.h` | Pooled city: stop when empty after a connection, or after 180 s with none |
| `UndauntedInternalServer/HuntCompletion.h` | `HuntCompletion::Cache`: game thread captures a successful result once per run; HTTP threads read the header JSON under a mutex |
| `UndauntedInternalServer/ConnectedPlayerSnapshot.h` | Thread-safe bounded list of connected account ids (max 128, 8 KB, 2 s age) and `SessionIdFromReadyFile` |
| `UndauntedInternalServer/FallRecovery.h` | Server-side rescue of players who fall through the world: anchors from the chosen player start, floor sweeps, owning-client recovery event |
| `UndauntedInternalServer/FallRecoveryPolicy.h` | Engine-free decision logic for `FallRecovery` (sustained floor contact, retries, rate limit) |
| `UndauntedInternalServer/RamPatPolicy.h` | `RamPatStuck`: a ram-pat synced animation older than 4 s is stuck |

### Data patches and client UI fixes

| File | What it does |
|---|---|
| `UndauntedInternalServer/TrialsRotation.h` | Weekly Trials pick (SHA-256-sorted pool, seeded cycle, epoch Thursday 2019-07-18 18:00 UTC); must match DeployServer and Metagame `controllers/trials.ts` |
| `UndauntedInternalServer/TrialsSchedule.h` | Rewrites the expired `gen_arena_hunts_schedule` rows in memory with the current pick; `IsTrialRowUnlocked` |
| `UndauntedInternalServer/CellFusionTime.h` | Sets every Middleman `cell_exchange_table` recipe to `FusionHours` (1 h), client and server |
| `UndauntedInternalServer/NoPlatinumPrice.h` | Hides the "-1 Platinum" option on offers with no platinum price |
| `UndauntedInternalServer/VendorTabs.h` | Shows the vendor Craft/Purchase tab bar that 1.4.4 leaves collapsed |
| `UndauntedInternalServer/AutoPressStart.h` | Auto-dismisses the old "Press Start" welcome screen |
| `UndauntedInternalServer/DeveloperStyle.h` | Cosmetic purple bold name style for staff names (`TFBT`, `TFBTA`, `ZFXSTATIC`); no privileges |

### Vendored / generated (not documented further)

| File | What it does |
|---|---|
| `SDK/`, `UndauntedInternalServer/SDK.hpp` | Dumper-7 style Unreal SDK for "4.25.3 dauntless rel-1.4.4" (about 4,100 files, tracked in git) |
| `UndauntedInternalServer/UnrealContainers.hpp`, `UtfN.hpp`, `PropertyFixup.hpp`, `Assertions.inl` (35 MB of offset `static_assert`s), `NameCollisions.inl` | SDK support headers |
| `MinHook/MinHook.h`, `MinHook/buffer.h`, `MinHook/trampoline.h`, `buffer.c`, `hook.c`, `trampoline.c` | Vendored MinHook (inline hooking) |
| `hde/hde32.h`, `hde/hde64.h`, `hde/pstdint.h`, `hde/table32.h`, `hde/table64.h`, `hde32.c`, `hde64.c` | MinHook's Hacker Disassembler Engine |

### Tests (`tests/`)

Single-file C++ programs for the pure headers: `channel-lookup.cpp`, `city-idle-policy.cpp`, `connected-player-snapshot.cpp`, `fall-recovery-policy.cpp`, `hunt-completion.cpp`, `hunt-idle-policy.cpp`, `owner-relevancy.cpp`, `perf-log.cpp`, `ram-pat-policy.cpp`, `replication-cadence.cpp`, `server-frame-limit.cpp`, `trials-rotation.cpp`. Design notes: `CHANNEL_LOOKUP_TESTING.md`, `CONNECTED_PLAYER_SNAPSHOT_TESTING.md`, `FALL_RECOVERY_TESTING.md`.

Build output (`x64/Release/UndauntedInternalServer.dll`, `Undaunte.*/` intermediates) is git-ignored local output; the launcher's pinned copy is in `UndauntedLauncher/assets/`.

## Connects to

| Peer | How |
|---|---|
| [Metagame](legacy-1.4.4-metagame.md) | all HTTP from the game exe (client endpoints and server saves) goes to `127.0.0.1:61000` (server) or `MetagameAddress` (client); the Metagame's `controllers/huntplatinum.ts` parses `x-dauntless-hunt-completion` |
| [DeployServer](legacy-1.4.4-gateway-deploy.md) | spawned by it with positional args; ready file + env vars |
| [Launcher](legacy-1.4.4-launcher.md) | launcher copies the pinned DLLs and passes `host:port` as argv[1] |
| Players | UDP game traffic on the port from argv[2] (8770-8777) |

## Config

Environment variables the DLL reads: `DR_SERVER_READY_FILE`, `GAMESERVER_READY_DIR`, `DR_SERVER_MAX_FPS` (default 30; `0` = engine default), `DR_RAMSGATE_POOL`, `DR_SHOW_CONSOLE`, `DR_PERF_LOG` (`0` disables), `DR_PERF_SAMPLE`. Version string is `constants.h`. There is no config file.

## Gotchas

- **Hard-coded addresses.** Every `Globals::BaseAddress + 0x...` offset is for exe sha256 `d3d41e61...` (pinned in `UndauntedLauncher/src/main/constants.ts`). A different exe will crash or silently corrupt memory; the DLL does not check.
- **Change the DLL, update the pin.** The launcher and friend kit verify the DLL by SHA-256 (`PINNED_DLLS`). A rebuilt DLL needs the new hash in `UndauntedLauncher/src/main/constants.ts` and `deploy/linux-server/prepare-game.sh` (the only places I found the DLL hash literally; the Windows kit and friend kit may read it from a file or SHA256SUMS, unverified).
- **Server and DeployServer builds go together** (`docs/hunt-readiness.md`): newer DLLs write the ready file after `Listen`; older DLLs make the DeployServer fall back to checking the UDP port is bound.
- **Game thread only.** Engine objects are touched only from the tick hook; HTTP worker threads read copied strings under a mutex (see `ConnectedPlayerSnapshot.h`, `HuntCompletion.h`). Keep it that way when adding hooks.
- **API key in argv.** The game-server key arrives as the first command-line argument, so it is visible in the process list on the host.
- **Headless exit.** A bad-args start calls `MessageBoxA` before `exit(0)`, which blocks in a non-interactive session.
- **Idle exit is `TerminateProcess`**, not a clean shutdown (CRT teardown hangs in an injected DLL).
- **Build:** open `UndauntedInternalServer.sln` in Visual Studio 2022 (not built or verified by this wiki).
- Console banner still credits "Undaunted v0.0.3 ... prod. gwog".

## See also

[index](index.md) - [legacy-1.4.4](legacy-1.4.4.md) - [legacy-1.4.4-metagame](legacy-1.4.4-metagame.md) - [legacy-1.4.4-gateway-deploy](legacy-1.4.4-gateway-deploy.md) - [legacy-1.4.4-launcher](legacy-1.4.4-launcher.md) - [runtime](runtime.md)
