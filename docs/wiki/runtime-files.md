# ParadoxRuntime file reference

> Verified against code 2026-10-24 (Middleman tile fill, reforge objectives 2026-10-29).

File-by-file reference for `versions/1.14.7/ParadoxRuntime/` (`MysticParadox.dll`). The narrative (what the DLL
is, how a session flows, gotchas) is in [runtime](runtime.md). This page is for lookups: which file, which hook,
which flag, which log tag. C = client role, S = dedicated-server role (`-server` on the command line).

## Files

### Build, project and resources

| File | What it does |
|---|---|
| `ParadoxRuntime/_build.bat` | Finds MSBuild with `vswhere.exe` (needs the C++ workload), builds `MysticParadox.sln` Release x64 (`/m`, x64 host tools). Returns MSBuild's exit code; copies nothing into the game folder. Exit 3 when vswhere or MSBuild is missing. Output `x64\Release\MysticParadox.dll`. |
| `ParadoxRuntime/build-loader.bat` | `cargo build --release` in `versions/1.14.7/tools/RuntimeLoader`; checks that `target\release\winmm.dll` exists. See [tools](tools.md). |
| `MysticParadox.sln` | One project (`MysticParadox.vcxproj`), Debug/Release x Win32/x64. Only Release x64 is used. |
| `MysticParadox.vcxproj` | DynamicLibrary, toolset v145, Unicode, `TargetName` `MysticParadox`, C++ `stdcpplatest` (x64), no PCH (x64). Release x64: static CRT `/MT` (`MultiThreaded`), links `delayimp.lib`, delay-loads `D3DCOMPILER_47.dll` and `d3d11.dll`. Compiles `dllmain.cpp`, `CrashReporter.cpp`, `Voice.cpp`, `CineCamMenu.cpp`, `JoinPrompt.cpp`, `HuntStats.cpp`, `WindowLock.cpp`, `CineCamPath.cpp`, `Networking.cpp`, imgui, MinHook, `..\tools\CatalogExporter\StoreRuntimeExporter.cpp`, and ten generated SDK function files (`SDK\Basic.cpp`, `CoreUObject_functions.cpp`, `Engine_functions.cpp`, `Archon_functions.cpp`, `BPGM_Archon_Prototype_functions.cpp`, `BP_EB_Weapon_functions.cpp`, `BP_PlayerCharacter_functions.cpp`, `UMG_functions.cpp`, `GameplayAbilities_functions.cpp`, `island_arrival_cinematic_trigger_bp_functions.cpp`). Conditional: `P2PHooksStub.cpp` unless `p2p\PlayerHost.cpp` exists; then `p2p\AntiCheatHooksStub.cpp` or `anticheat\HuntGuard.cpp`. Neither folder exists in this repo. |
| `MysticParadox.vcxproj.filters` | Visual Studio Solution Explorer folders only. No build effect. |
| `BUILD.md` | Official build notes: one combined DLL for both roles, optional P2P module, `/MT` rule and import check, publish the same DLL to client and server feeds. |
| `.gitignore` | Ignores build output (`x64/`, `*.dll`, `*.pdb`, ...) but keeps `opus/lib/opus.lib`. The SDK and `deployment_config.generated.h` are ignored by `versions/1.14.7/.gitignore`. |
| `MysticParadox.rc` | Embeds `assets\mp_login_background.png` (`IDR_MP_LOGIN_BACKGROUND` 101) and `assets\mp_login_logo.png` (`IDR_MP_LOGIN_LOGO` 102) as `RCDATA`. |
| `resource.h` | The two resource ids above. Used by `LoginBranding` in `dllmain.cpp`. |
| `assets/mp_login_background.png`, `assets/mp_login_logo.png` | Login-screen still background and the Dauntless Revamped wordmark for the `ArchonLogoMat` slot. |
| `deployment_config.generated.h.example` | Template: `#define MP_PUBLIC_HOST L"paradox.example.com"`. Copy to `deployment_config.generated.h` (gitignored, made by `versions/1.14.7/scripts/configure-selfhost.ps1`; `host/test-stack.ps1` copies it, with the SDK, from the live checkout into a test checkout). `MP_PUBLIC_HOST` is the compiled-in backend host (`https://` + host is `MpApiBase` unless `MYSTICPARADOX_API_BASE` is set). |
| `ParadoxRuntime/constants.h` | `MYSTICPARADOX_INTERNAL_VERSION = "0.0.3"`. Not the published runtime version (that comes from the publish script's `--version`). |
| `ParadoxRuntime/framework.h` | `WIN32_LEAN_AND_MEAN` + `<windows.h>`. Template leftover. |

### Runtime sources

| File | What it does |
|---|---|
| `dllmain.cpp` | ~24.7k lines. `DllMain`, `Init`, `InitClientHooks`, `InitServerHooks`, `MainThread`, both `ProcessEvent` hooks, `GameEngineTickHook`, URL redirect, all client UI features and all server fixes. Map below. |
| `ParadoxRuntime/Networking.cpp` | `namespace Networking` (server). `Listen`: finds the `FWorldContext`, calls `CreateNamedNetDriver` (RVA `0x0425FDA0`) for `GameNetDriver`, sets the driver's world, calls `UNetDriver::Listen` (vtable byte offset `0x290`) with `UWorld+0x28` as network notify, then prints `MYSTICPARADOX_GAMESERVER_READY launchId=<id> port=<port>` to stdout (only when `MYSTICPARADOX_GAMESERVER_LAUNCH_ID` is set). `AnnounceEngineReady`: same marker when the engine built the listener (`MAP_URL_LISTEN.flag`). `TickNetworking`: per-tick driver maintenance; the hand-written actor replication loop runs only with `EMERGENCY_LEGACY_REPLICATION.flag` and is refused on 1.14.7 (`[LegacyReplication]`), so the native replication graph is the only path. `BootstrapActorChannel`, `GetActorChannelIndexForConnection`. Own `NetLog` writes to the same per-port log but with no timestamp or pid. |
| `ParadoxRuntime/Networking.h` | Declares the above plus `ActorChannelPushDiag` (why `ReplicateActor` wrote nothing: dormancy/reentrancy vs nothing dirty). |
| `RuntimeShared.h` | The API `dllmain.cpp` exports to the side files: `Globals::{AmServer, BaseAddress, Port, ExpectedPlayerString}`, `MpLog`, `MpPtr`, `MpReadEnvironment`, `MpExeRelativeFlagPresent`, `DevelopmentRuntimeProfile`, `IsReadablePointer`, `IsRegisteredLiveObject`, `SafeObjectNameForDiagnostic`, `CoreCapFString`, `MpApiBaseForCrashReports`, `MpQuitGame`, and the entry points of `CrashReporter.cpp`, `Voice.cpp`, `JoinPrompt.cpp`, `HuntStats.cpp`, `WindowLock.cpp`. |
| `P2PHooks.h` | Seam for an optional player-hosted (P2P) server mode: `ClaimAuthMode`, `ReadLaunch`, `InstallServerHooks`, `DescribeRole`, `StartServer`, `PrepareListen`, `ReportsReadiness`, `ReportReady`, `TickShutdown`, `OnListenFailed`, `RequestHeader`, `ObserveServerEvent`. |
| `P2PHooksStub.cpp` | Dedicated-only implementation: claims no auth mode, so any `MYSTICPARADOX_AUTH_MODE` other than `GLOBAL_GAMESERVER` makes the server exit before listen (`[ServerAuth]`, exit `0xE102`). Every other hook is a no-op/true. |
| `Voice.cpp` | In-game voice (C) and hub proximity reports (S). See the section below. |
| `CrashReporter.cpp` | Own crash reporter (C+S). See below. |
| `JoinPrompt.cpp` | Join-in-progress offer worker thread (C). See below. |
| `HuntStats.cpp` | `MpHuntStatsPost(Json, ApiKey)` (S): detached thread, one `POST <MpApiBase>/mystic/hunt-stats` via WinHTTP with `Content-Type: application/json` and `x-mysticparadox-gameserver-apikey`, no proxy, 3/3/5/5 s timeouts, one attempt. Logs `[HuntStats] backend -> <status>`. The JSON is built by `MpHuntStatsTick` in `dllmain.cpp`. |
| `WindowLock.cpp` | `MpWindowLockStart` (C): hooks `user32!SetWindowPos`, `MoveWindow`, `SetWindowLongW`, `SetWindowLongPtrW` with `MH_CreateHookApiEx`. Only the game's own top-level unowned `UnrealWindow` is affected. An engine request identical to its previous one (the map-load re-apply) keeps the window's current rect and border bits; a new request (options menu change) passes. A kept rect is re-announced with posted `WM_MOVE`/`WM_SIZE` (Slate caches the size it asked for). Subclasses the game window (`GameWndProc`): a captionless window not filling its monitor gets 8 px resize edges (`WM_NCHITTEST`). `DISABLE_WINDOW_LOCK.flag`. Tag `[WindowLock]`. |
| `CineCamMenu.cpp` | F10 cinematic-camera menu (C): Dear ImGui drawn from an `IDXGISwapChain::Present` hook (vtable 8; `ResizeBuffers` vtable 13), found by creating a throwaway D3D11 device + swap chain. Subclasses the game window's `WndProc` so the menu eats its input. D3D11 only (menu off on D3D12; hotkeys still work). Saves menu layout to `CINECAM_menu.ini`, shots to `CINECAM_shots\` beside the exe. Never touches UObjects; asks the game thread via `Cine::G` commands. Tag `[CineCam]`. |
| `CineCamPath.cpp` | Pure path math (C): `PathAt` (Hermite with Kochanek-Bartels tangents; tension 0 = Catmull-Rom), `PathLength`, `EvenSpeed`, `ShakeAt`, `ToSpace`/`FromSpace` (world / target-relative key spaces), `ParseKey` (saved shot lines), `FovToMm`/`MmToFov` (36 mm sensor). |
| `CineCamShared.h` | `namespace Cine`: `Key`, `Pose`, `Settings` (camera, rig, guides, lens, look), `State G` with its `Lock` and the menu-to-game-thread command queue; declares the path math and `MenuStart`. |
| `tools/CineCamPathCheck.cpp` | Standalone assert check of `CineCamPath.cpp` (keys hit on time, ease keeps the ends, ...). Build line in its header: `cl /EHsc /std:c++20 /I. tools\CineCamPathCheck.cpp CineCamPath.cpp`. Not part of the DLL. |
| `tools/compat-inventory.ps1` | Reads `dllmain.cpp`, `Networking.cpp` (and `p2p\*.cpp` if present) and lists every `MH_CreateHook` RVA, other `BaseAddress + 0x...` reference, vtable call and raw field offset, marking an RVA VERIFIED if it appears in `Progress\36_DAUNTLESS_1_14_7_ENDPOINT_AND_RVA_MAP.md`. Writes `Progress\37_DAUNTLESS_1_14_7_COMPATIBILITY_INVENTORY.md`. Both paths are relative to `-Root` (default `versions/1.14.7`); that `Progress\` folder is not in this repo, so pass `-Out` to a path that exists. |
| `versions/1.14.7/tools/CatalogExporter/StoreRuntimeExporter.cpp` | Not in this folder but compiled into the DLL. `RunStoreRuntimeExportWhenReady` is run by `RewardCacheCaptureThread` (C, only with `REWARD_CACHE_CAPTURE.flag`): waits up to 15 min for the season store view model, then exports it. See [tools](tools.md). |

### Generated and vendored

| Path | What it is |
|---|---|
| `SDK/`, `SDK.hpp`, `UnrealContainers.hpp`, `UtfN.hpp`, `PropertyFixup.hpp`, `Assertions.inl`, `NameCollisions.inl` | Dumper-7 CppSDK dump of the 1.14.7 game (classes, structs, offsets, function thunks; ~5k files). Game-derived, gitignored, never hand-edited. Regenerate per `versions/1.14.7/docs/GENERATING_SDK.md` (build Dumper-7, inject into a running 1.14.7 client, copy the CppSDK output here). Without it nothing builds. |
| MinHook (`MinHook/MinHook.h`, `MinHook/buffer.h`, `MinHook/trampoline.h`, `hook.c`, `buffer.c`, `trampoline.c`, `hde/hde32.h`, `hde/hde64.h`, `hde/pstdint.h`, `hde/table32.h`, `hde/table64.h`, `hde32.c`, `hde64.c`) | MinHook (Tsuda Kageyu, BSD-2). Inline x86/x64 hooking used for every detour. |
| Dear ImGui (`imgui/imgui.cpp`, `imgui/imgui.h`, `imgui/imgui_internal.h`, `imgui/imgui_draw.cpp`, `imgui/imgui_tables.cpp`, `imgui/imgui_widgets.cpp`, `imgui/imgui_impl_dx11.cpp`, `imgui/imgui_impl_dx11.h`, `imgui/imgui_impl_win32.cpp`, `imgui/imgui_impl_win32.h`, `imgui/imconfig.h`, `imgui/imstb_rectpack.h`, `imgui/imstb_textedit.h`, `imgui/imstb_truetype.h`, `LICENSE.txt`) | Dear ImGui 1.91.5 (MIT) with Win32 + DX11 backends. Only `CineCamMenu.cpp` uses it. |
| libopus (`opus/include/opus.h`, `opus/include/opus_custom.h`, `opus/include/opus_defines.h`, `opus/include/opus_multistream.h`, `opus/include/opus_projection.h`, `opus/include/opus_types.h`, `opus/lib/opus.lib`, `COPYING`, `README.txt`) | libopus 1.5.2 (BSD-3), prebuilt static `/MT` x64 lib (build line in `opus/README.txt`). Used by `Voice.cpp`. |
| `x64/Release/` | Build output: `MysticParadox.dll`, `.pdb`, `.lib`/`.exp`, plus stray `MysticParadox.main-backup.dll` / `.pdb.old` copies. Gitignored. |
| `MysticParadox/` | MSBuild intermediate folder. Gitignored. |

## dllmain.cpp map

Search by symbol or `[Tag]`; the file has long dated history comments above most features.

| Area | Key symbols | Role | What it does |
|---|---|---|---|
| Globals and logging | `namespace Globals`, `InitLog` (no-op), `MpLog`, `MpLogDir`, `MpExeRelativeFlagPresent`, `DevelopmentRuntimeProfile`, `VerboseDiag`, `MpReadEnvironment`, `g_MpProcessDetaching` | C+S | Launch globals (port, map, behemoth, hunt id, roster, API key). `MpLog` appends to `<exe dir>\mysticparadox_dll_port<Port>.log` (port 0 on clients), opening and flushing per line; nothing after `DLL_PROCESS_DETACH`. |
| Safety helpers | `IsReadablePointer` (per-frame region cache), `IsRegisteredLiveObject`, `SafeRead*`/`SafeWrite*`, `MpPatchBytesVerified`, `ResolveFunctionStartRva`/`MpFunctionStartForAddress` (from `.pdata`, follows chained unwind entries), `EngineRealloc` | C+S | Guarded memory access, byte-verified code patches, and engine-allocator `FString` growth. |
| Exit and crash forensics | `ExitProcessHook`, `RtlExitUserProcessHook`, `NtTerminateProcessHook`, `TerminateProcessHook`, `RaiseExceptionHook`, `Ucrt*`/`Msvcrt*` exit/abort hooks, `VectoredExceptionTrace`, `MpLogStack`, `InstallApiHook` | C+S | Log every exit path and first-chance exception with a stack (`[ExitTrace]`, `[ExceptionTrace]`). The VEH also recovers the known spline-evaluator fault. |
| Command line, EOS, EAC | `HookFCommandLineGet`, `InstallEngineCommandLineHook`, `HookIsEOSEnabled`, `HookEasyAntiCheatHandleError`, `LogEacStartupFlags` | C (+S for `-nullrhi`) | Engine `FCommandLine::Get` gains `-NoEAC`, `-DisableEOS` (and `-nullrhi` on a server launched with it). `IsEOSEnabled` returns 0 so login uses the backend's MCP path. The `EnableEasyAntiCheatFeatures` byte is cleared. EAC's `IGameClient` init error is absorbed; other EAC errors pass. `HookGetCommandLineW/A`, `HookFCommandLineSet` and `GetCommandLineHook` are defined but never installed. |
| QoS and sockets | `InstallQosHostResolutionHook`, `HookGetAddrInfoW/A`, `InstallSocketDiagnostics` | C (QoS), C+S (sockets) | `*.gce.latency-test.steelyard.ca` resolves to `127.0.0.1` so region pings get an answer. Socket send/recv logging only with `SOCKET_DIAG.flag`. |
| Login and auth logging | `HookLoginOperationFailed`, `HookLoginOperationSuccess`, `HookEnqueueDisconnectError`, `RedactForLog` | C | Logs login results and disconnect reasons (redacted). |
| Main thread | `MainThread`, `MpSpawnConsoleOnGameThread`, `RewardCacheCaptureThread` | C+S | Server: refuses an invalid auth mode, waits up to 30 s for a `UWorld`, sets `Globals::DoListen`. Client: after 3 s flags console setup; the game thread then spawns a `UConsole` bound to F2. |
| Client autoplay (test only) | `AutoPressStartFromEvent`, `AutoPlayFromEvent`, `AutoTravelToCityFromEvent` | C | With `AUTO_PRESS_START.flag`: dismiss press-start, press Play, travel to Ramsgate, for scripted repros. |
| Bleedout | `EnsureBleedoutDuration`, `BleedoutWatch*`, `BleedoutNoteEvent`, `SampleBleedoutGrace` | S | Sets GameMode bleedout duration (`MYSTICPARADOX_BLEEDOUT_SECONDS` or fallback), watches for stuck bleedouts. |
| Branding | `namespace LoginBranding`, `CreditsBranding`, `PressStartBranding` | C | Login background (`LoginLoop.mp4` video from `Archon\Content\Movies\Windows\` if installed, else embedded PNG), Revamped logo, hides the patch-notes title; "Mystic Paradox" credits block; press-start text and auto-skip. All via reflected UFunctions, no RVAs. |
| Empty-server reaper | `GameModeEmptyState`, `StartEmptyWatchdogThread`, `MpReapExit`, `AfkExemptionTick`, `MpLogHungGameThread` | S | Background thread (2 s poll) terminates a disposable instance (not Ramsgate/Training) 50 s after its last client left, 5 min if nobody ever joined, or 180 s after the game thread stops ticking. A persistent hub whose UDP port has been free 45 s also exits so the Director restarts it. Same 50 s rule on the tick path. `AfkExemptionTick` sets `bNoAFK` on local controllers. |
| Map URL | `GetGameDefaultMap`, `HubMaxPlayers`, `LaunchExpectedPlayerCount`, `LaunchGauntletLevel`, `MpTickGauntletProbe` | S | Builds `<map>?MonsterClass=..?HuntId=..?PlayerHuntIds=..?MaxPlayers=N[?GauntletLevel=L][?game=<MYSTICPARADOX_GAME_MODE>][?listen]` into the engine's own `FString`. `N` = `HUB_MAX_PLAYERS.txt` or 4. |
| GPU-less boot | `MpForceWarpEnabled`, `InstallWarpForceHooks`, `D3D11CreateDeviceHook`, `LoadLibraryExWHook` | S | With `MP_FORCE_WARP.flag`: patch the D3D11 `IsSupported` gate and force the WARP software device. |
| Player-data load recovery | `ArchonLoadManagerLoadFailedHook`, `ClaimPlayerDataLoadRetry`, `RearmIncompletePlayerDataLoaders` | S | One retry of stuck player-data loaders instead of the 66 s timeout that failed the map reload. `DISABLE_PLAYERDATA_LOAD_RETRY.flag`. |
| Manual net tick | `NativeNetTick`, `SafeManualTickDispatch`, `SafeManualTickFlush`, `SanitizeNetDriver*`, `RegisterNetDriverInLevelCollections`, `ApplyNetRateBoost` | S | Native-only net tick by default; SEH-guarded manual dispatch for A/B flags. Raises `MaxClientRate`/`MaxInternetClientRate` and each connection's `CurrentNetSpeed` to 100000 B/s. |
| Voice options | `namespace VoiceSettings` | C | Game Audio "Voice chat" toggle + volume feed `Voice.cpp`; adds a Push to Talk binding row (repurposes hidden `Binding_ToggleHUD_Gamepad`, default Mouse4) and an "Open Mic" toggle saved as `VOIP_OPEN_MIC.flag`. |
| Behemoth HP bar | `namespace BehemothHealthBar` | C | Native bar + `12,345/15,654` number for live behemoths within 35 m (last damaged first), one row per behemoth. |
| Nameplates | `namespace StaffNameplates` | C | Strips `[Owner]/[Admin]/[Mod]` and Patreon tags (`[Wanderer]`, `[Scout]`, `[Slayer]`, `[Legend]`, `[Emerald]`) from overhead plates, adds a role title line and animated name styles; switches every plate's widget component to draw at desired size so names are not clipped. Tags come from backend `staffRoles.ts`. |
| Inventory | `namespace InventoryProbe` (`Read`, `Heal`, `FindUnresolvedGearSlots`, `LoadoutHeal`, `Tick`) | C | Logs changes in the client's two inventory views (`[InvProbe]`); if inventory stays empty 5 s on a live controller, calls `ClientQueryInventory(true)` (max 3 tries, 10 s apart) (`[InvHeal]`). Once the inventory has finished loading, re-resolves gear slots (`UArchonLoadoutItemSlot`) that hold an item CRC but no instance id - fills a null slot `Inventory` from the controller and re-runs `OnRep_ItemInstanceIdChanged` (max 5 passes per controller) (`[LoadoutHeal]`). Skips while `s_lmDepth` > 0 (inside LoadMap) and only touches controller, inventory and slots that pass `IsRegisteredLiveObject`: after travel `s_LastPossessedPC` points at the freed old controller (crash reports #10/#11, 0.2.67). |
| Fountain core popup | `MpFountainCorePopupFix` | C | Rewrites `ArchonInventory.ClientContainerUnlocked` before the UI: Patrol Key line = game roll +2 (clamped 4-6) and an appended `CURRENCY_PLATINUM` x20 line, matching backend `ramsRewards.ts`. Keep both in step. |
| Cell core popup | `MpNoteContainerUnlock`, `MpCellCorePopupFix` | C | Remembers cell cores sent in `ServerUnlockContainer`, then replays backend `UpgradeCoreCells` (same seed + chances as `CellCoreRandom`/`CELL_CORE_UPGRADE`) on the next `ClientContainerUnlocked`: one `_UC` line renamed to `_R`/`_E`, or split off a stack. Keep both in step. |
| Server tick | `GameEngineTickHook` | S | Idle-hub throttle (~5 fps with no client unless `NO_IDLE_THROTTLE.flag`), engine Hz report, re-assert `GIsServer=1/GIsClient=0`, phantom suppression, replication-graph drive, voice proximity, hunt join/stats, role retries, escalation buff spawns, party restart hold, roster `ExpectedPlayerCount` sync, Listen / engine-listener READY, empty reaper, net rate, pawn rep boost and `TickStamina`. F7 on the server console dumps non-authority actors. |
| HTTP redirect | `ProcessRequest`, `MpRewriteRequestUrl`, `MpIsRedirectHost`, `MpSplitUrl`, `MpBuildRedirectUrl`, `MpGetApiOverride`, `MpApiBase` | C+S | See [runtime](runtime.md#4-talking-to-the-backend). `MpLogUrlObservation`/`MpUrlLogEnabled` are dead code. |
| XMPP config (dead) | `InstallXmppConfigRedirectHook`, `GetConfigStringHook`, `MpXmppServerAddr` | none | Never called; `InitClientHooks` logs "XMPP config hook skipped". XMPP address comes from the launcher's `Engine.ini` section. |
| Loading gate | `HasFinishedLoadingHook`, `IsLocalArchonControllerReadinessObject` | C+S | Forces "finished loading" only for the exact local `AArchonPlayerController` (client) and keeps the legacy server override. |
| Net mode | `InternalNetModeHook`, `WorldNetModeHook` | S | Keep the listen-server binary reporting dedicated-server net mode. |
| Replication graph | `CreateRepDriverHook`, `SetReplicationDriverHook`, `MpDriveReplicationGraph`, `ArchonGraphSraHook`, `ArchonRouteAddNetworkActorHook`, `ArchonRouteRemoveNetworkActorHook`, `RepGraphApplyGlobalSettings`, `TickRepGraphRelevanceSettings`, `OwnerPawnRelevancyFix`, `PlayerRepBoost`, `PlayerAlwaysRelevant` | S | Installs and drives the game's `ArchonReplicationGraph`, routes player roles/weapons/drones to the right connections, relevance fixes. |
| PlayerController channel guards | `PlayerControllerSetChannelActorGuardHook`, `ReplicateActorFreqHook`, `RepGraphReplicateSingleActorGuardHook`, `QueuePlayerControllerChannelQuarantine` | S | Fail-closed: never send a PlayerController's initial bunch to another player's connection. |
| Player role / omnicell | `ApplyPlayerRoleHook`, `TickPlayerRoleRetries`, `TickPlayerRolePostActivationRefresh`, `RefreshPlayerRoleGameplayLifecycle`, `RoutePlayerRoleTo*`, `RunClientRolePumpGuarded`, `TriggerArchonInputActivation`, `ReconcileAirshipGameplayHUD` | C+S | Omnicell (player role) apply, retry and HUD re-bind after travel. |
| Phantom local player | `MpSuppressPhantomReplication`, `MpDestroyPhantomPawn`, `MpPhantomPawnDestroyPolicy`, `MpIsPhantomThatMayNotRestart`, synthetic net id (`MpSynthNetId*`, `EnsureSyntheticNetId`, `MpCaptureGenuineNetIdType`) | S | The client-build server spawns a phantom local player; its pawn is destroyed on hubs and it never restarts. A synthetic net id is opt-in (`ENABLE_SYNTHETIC_NETID.flag`). |
| Party arrival | `MpHoldRestartForParty`, `MpTickPartyRestartHold` | S | Hold launch-roster players pawn-less until all have joined (cap 40 s), then restart together. |
| Projectiles | `MpServerProjectileTickFix` | S | Re-enable actor tick on projectiles at BeginPlay so they hit. |
| Combat log | `MpHuntCombatLog` | S | Per-hunt `<exe dir>\HuntCombat\hunt_<start>_port<N>.log` (montage / try / ok / REJECT / dmg). Summarised by `host\hunt-combat-report.ps1`. |
| Hunt pass probe | `MpHuntPassProbe` | C+S | `HUNTPASS_PROBE.flag` only. |
| Voice icons | `namespace VoiceIndicators` | C | Talking/muted icons on party HUD, own health bar and nameplates. |
| Cinematic camera | `namespace CineCam` | C | F8/F9/F10 camera, keyframe paths, HUD hide, `CINECAM.ini`; owner accounts only (`OwnerOnly` checks the `[Owner] ` name prefix). |
| Join popup | `namespace JoinPopup` | C | Shows `JoinPrompt.cpp` offers through `UArchonGlobalUI::DisplayPopup`, returns the choice. |
| Client ProcessEvent | `ProcessEventClientHook` | C | Reentrancy guard; drives branding, autoplay, console, client probes, role pump, and ticks `BehemothHealthBar`, `StaffNameplates`, `VoiceSettings`, `VoiceIndicators`, `InventoryProbe`, `CineCam`, `JoinPopup`; `[ClientPerf]` once a minute. |
| Server ProcessEvent | `ProcessEventHook` | S | Reentrancy guard; forces `PlayerCanRestart` (except the phantom/held party), installs the synthetic net id when flagged, suppresses Wwise `PostEvent` on servers, projectile tick fix, escalation hooks, combat log, debug damage, P2P observer. |
| Escalation | `EnsureEscalationBoonsUnlocked`, `NoteEscalationStateChangeForBuffChoices`, `TickEscalationBuffChoiceSpawn`, `TraceEscalationFlow*` | S | Unlock every boon row once per server so the pool is never empty; spawn per-player buff choices at round end. |
| Tempest / Artificer diagnostics | `TempestScaleDiagEnabled`, `TraceTempestDamage*`, `TickTempestModifierEnsure`, `TickTempestChargeDiag`, `TraceArtificerDroneEvent`, `TickFrankDroneDiagnostics` | S | Weapon diagnostics; Tempest scale diag is refused on 1.14.7 (1.12 RVAs). `TickTempestModifierEnsure` re-applies Tempest modifiers. |
| LoadMap fix | `LoadMapDiagHook`, `MpLmTrashZombieWorlds`, `InstallLoadMapDiagHooks` | C | Before `UEngine::LoadMap`, renames a pending-kill zombie world package to `TRASH_<pid>_<n>` so hub re-entry loads a fresh world. `DISABLE_ZOMBIE_WORLD_TRASH.flag` falls back to a GC request. |
| Hunt pass / Middleman | `HuntPassClaimResultGuard`, `CellOfferBuildProbe` | C | Skip claim result with no track (crash fix); log Middleman cell-offer prices and copy the offer's Platinum/Aetherdust price into the tile view model when the client's price map left it at -1 (the map drops `CURRENCY_CELLDUST`). |
| Forced feature flags | `InstallFeatureFlagForce`, `MpFeatureForced` | C+S | Class names in `FORCE_FEATURE_FLAGS.txt` (one per line, `#` comments) answer true from `IsFeatureEnabled`/`IsLocalFeatureEnabled` (seasonal Ramsgate). |
| Move10 patches | `Move10_*`, Move10 block in `InitServerHooks` | S | GIsClient/GIsServer writer patches; opt-in `ENABLE_MOVE10_1147.flag` and known to stop boot. |
| Hunt id backfill | `OnPlayerDataLoadCompleteHook`, `ServerSharedPlayerHuntId` | S | Fills an empty `PlayerHuntId` from the launch roster via `DebugSetPlayerHuntID`, so drop-in players get rewards. |
| Trials | `SchedulerInitializeHook`, `PatchArenaScheduleForCurrentTime`, `ApplyTrialsScheduleOffset`, `TrialsRotationMinutes`, `TrialsLaunchWeekOverride` | S | Rewrites all 181 arena schedule rows into contiguous windows (default 10080 min = 7 days, `TRIALS_ROTATION_MINUTES`) before the scheduler copies them; an arena process is pinned to `MYSTICPARADOX_TRIALS_WEEK`. |
| Headless server | `InstallServerHeadlessSetup`, `StartServerWindowHider`, `InstallServerWindowSuppressionHooks`, `InstallHeadlessAudioHook` | S | Logs `[InitRole]`, leaves the nullrhi cache to the engine, hides any window (`SHOW_SERVER_WINDOW.flag` keeps it). |
| Banked XP and reforge objectives | `MpBankedXpQuestTick`, `MpBankedXpQuestScan`, `MpReforgeObjectiveSync` | S | Hub, every 5 s: in-progress "earn N banked XP" quest objectives raised to the player's banked weapon XP; in-progress Slayer's Path reforge objectives (`ObjectiveData_PrestigeTrackXP`) raised to the player's reforge count (`PrestigeTrack_Weapon_*` total of that weapon, summed when `bAnyWeaponTrack`) and completed at `PrestigeCount`. The game only counts reforges made while an objective is listening (`+0x1D66CF0` ignores the prestige level). |
| Voice proximity / hunt state / stats | `MpPlayerStateAccountId`, `MpVoiceProximityTick`, `MpHuntJoinTick`, `MpHuntStatsTick` | S | Hub: account id + position of every client to the relay ~5/s. Hunt: late-join HP rescale, `MYSTICPARADOX_HUNT_STATE` stdout line, per-player damage post on kill. |
| Progression probes | `InstallProgressionDiagnostics`, `InstallProgressionCacheProbe`, `InstallProgressionReadinessProbe`, `CallHuntPassSeasonQuery`, `CallFindActiveHuntPassRow` | S | Read-only progression/hunt-pass readiness probes; the boot hunt-pass query only with `CALL_HUNTPASS_QUERY.flag`. Six riskier probes (`InstallActiveHuntPassDriver`, `InstallLoadCompleteProbe` except with `HUNTPASS_PROBE.flag`, `InstallFindRowProbe`, `InstallConfigCompleteProbe`, `InstallGameInstanceQueryHook`, `InstallMasteryProbe`) are not installed. |
| Interaction callout guards | `InstallInteractionCalloutSetDisabledGuard`, `InstallInteractionCalloutClassGuards`, `InteractionCalloutHideHoldTextHook` | S | Null-widget guards for `UInteractionCalloutWidget` on headless servers. |
| Crash wait / inventory guard | `InstallServerCrashWaitBound`, `InstallInventoryRefreshGuard` | S | Engine crash-report wait 60 s -> 5 s; skip equipped-item refresh before a joiner's loadout slot exists. |
| Identity diag | `InstallLoadMgrBeginHook`, `LoadMgrBeginHook`, `LogPlayerIdentityChain` | C+S | Logs the player-data gate's owner chain; `ENABLE_PHANTOM_LOAD_SKIP.flag` skips the phantom's load. |
| Entry | `InitClientHooks`, `InitServerHooks`, `Init`, `DllMain` | C / S | See [runtime](runtime.md). |

## Hooks installed

Addresses are RVAs into `Dauntless-Win64-Shipping.exe` CL 647472 unless an API is named.

### Client (`InitClientHooks`)

| Target | Address | Detour | Purpose |
|---|---|---|---|
| `UNetConnection::Close` | `0x03F62B90` | `NetConnectionCloseHook` | Log who closes a connection (also on server). |
| `UEngine::LoadMap`, `UWorld::SetGameMode`, `ProcessAsyncResults` | `0x04271370`, `0x042D9AA0`, `0x04153460` | `LoadMapDiagHook`, `LmSetGameModeHook`, `LmProcessAsyncHook` | Zombie-world fix and `[LoadMapPL]` census. |
| Hunt pass claim result | `0x01F69E20` | `HuntPassClaimResultGuard` | Skip null track (`DISABLE_HUNTPASS_CLAIM_GUARD.flag`). |
| Cell offer view model build | `0x01EBF620` | `CellOfferBuildProbe` | `[CellOffer]` (`DISABLE_CELL_OFFER_PROBE.flag`). |
| `IsFeatureEnabled`, `IsLocalFeatureEnabled` | `0x00E9F090`, `0x00E9F530` | `IsFeatureEnabledForceHook`, `IsLocalFeatureEnabledForceHook` | Only when `FORCE_FEATURE_FLAGS.txt` lists a class (also on server). |
| HasFinishedLoading | `0x01BA5E40` | `HasFinishedLoadingHook` | Loading gate (also on server). |
| `UObject::ProcessEvent` | `0x02861880` | `ProcessEventClientHook` | Client feature driver. |
| `ApplyPlayerRole` | `0x01B92B90` | `ApplyPlayerRoleHook` | Omnicell apply/retry (also on server). |
| `FCurlHttpRequest::ProcessRequest` | `0x032C5FE0` | `ProcessRequest` | URL redirect (also on server, plus API-key header). |
| `IsEOSEnabled` | `0x01C30030` | `HookIsEOSEnabled` | Return 0. |
| `LoginOperationFailed`, `LoginOperationSuccess` | `0x01C3A160`, `0x01C3A590` | `HookLoginOperationFailed`, `HookLoginOperationSuccess` | Log. |
| `UArchonLoadManager` Begin | `0x01C997A0` | `LoadMgrBeginHook` | Identity diag (also on server). |
| `FCommandLine::Get` | `0x025E8F70` | `HookFCommandLineGet` | Append `-NoEAC -DisableEOS` (also on server). |
| `ws2_32!GetAddrInfoW`, `getaddrinfo` | API | `HookGetAddrInfoW/A` | QoS hosts -> loopback. |
| `ws2_32!sendto`, `recvfrom`, `WSARecvFrom`, `WSARecv` | API | `HookSendTo`, ... | Only with `SOCKET_DIAG.flag` (also on server). |
| EAC `HandleError` | `0x01476F20` | `HookEasyAntiCheatHandleError` | Absorb the expected IGameClient init failure only. |
| `UArchonGameInstance::EnqueueDisconnectError` | `0x018FB4D0` | `HookEnqueueDisconnectError` | Log disconnect reason. |
| Exit/abort APIs | `kernel32!ExitProcess`, `ntdll!RtlExitUserProcess`, `ntdll!NtTerminateProcess`, `kernelbase!TerminateProcess`, `kernelbase!RaiseException`, `ucrtbase!exit/_exit/abort`, `msvcrt!exit/_exit/abort` | `*Hook` | `[ExitTrace]` (also on server). Plus `AddVectoredExceptionHandler(VectoredExceptionTrace)`. |
| Crash reporter | `kernelbase!CreateProcessW`, `kernelbase!UnhandledExceptionFilter`, VEH `RecordException` | `CrashReporter.cpp` | Also on server. |
| Window lock | `user32!SetWindowPos`, `MoveWindow`, `SetWindowLongW`, `SetWindowLongPtrW` | `WindowLock.cpp` | |
| CineCam menu | `IDXGISwapChain::Present` (vtable 8), `ResizeBuffers` (vtable 13), `WndProc` subclass | `CineCamMenu.cpp` | Installed lazily by `Cine::MenuStart` from the game thread. |

### Server (`InitServerHooks`)

| Target | Address | Detour | Purpose |
|---|---|---|---|
| `FCommandLine::Get` | `0x025E8F70` | `HookFCommandLineGet` | Also carries `-nullrhi` into the engine's command line. |
| `user32!CreateWindowExW`, `ShowWindow` | API | `HookCreateWindowExW`, `HookShowWindowApi` | Hide server windows (`SHOW_SERVER_WINDOW.flag` skips). |
| `UObject::ProcessEvent` | `0x02861880` | `ProcessEventHook` | Server feature driver. |
| `OnPlayerDataLoadComplete` | `0x01CB33B0` | `OnPlayerDataLoadCompleteHook` | Hunt id backfill. |
| `FGameplayScheduler::Initialize` | `0x01D95B70` | `SchedulerInitializeHook` | Trials rotation. |
| `ApplyPlayerRole` | `0x01B92B90` | `ApplyPlayerRoleHook` | |
| GetGameDefaultMap | `0x02F00330` | `GetGameDefaultMap` | Map URL. |
| `UEngine::Tick` | `0x03E10AB0` | `GameEngineTickHook` | Server tick driver. |
| `UInteractionCalloutWidget::HideHoldText` | `0x01E42F00` | `InteractionCalloutHideHoldTextHook` | Null guard. |
| `UArchonLoadingScreen::ScreenFadeIn` | `0x01E0FBB0` | `ArchonLoadingScreenFadeInHook` | Null guard (server only; client hook disabled). |
| `UNetDriver::TickDispatch` inner helper | `0x03FAE420` | `NetDriverTickDispatchInnerHook` | Sanitise bad connection entries. |
| `UNetDriver::SetReplicationDriver` | `0x03FACF60` | `SetReplicationDriverHook` | |
| Spline direction query | `0x03D47A90` | `SplineDirectionGuard` | Zero direction for a corrupt curve (`DISABLE_SPLINE_GUARD.flag`). |
| Spline curve evaluator | `0x01091D50` | `SplineCurveEvalGuard` | Only with `ENABLE_SPLINE_EVAL_HOOK.flag` (measured unsafe). |
| `UArchonReplicationGraph::ServerReplicateActors` | `0x01C034C0` | `ArchonGraphSraHook` | Counter / `SRA_RATE_CAP.flag`. |
| `RouteAddNetworkActorToNodes`, `RouteRemoveNetworkActorToNodes` | `0x01BFE430`, `0x01BFE4C0` | `ArchonRouteAddNetworkActorHook`, `ArchonRouteRemoveNetworkActorHook` | Actor routing fixes / diag. |
| `SetChannelActor` | `0x03D8FB20` | `PlayerControllerSetChannelActorGuardHook` | PC ownership guard. |
| `UActorChannel::ReplicateActor` | `0x03D8A2D0` | `ReplicateActorFreqHook` | PC channel guard + `[RepFreq]`. |
| `CreateReplicationDriver` | `0x03F8D8E0` | `CreateRepDriverHook` | Force the graph to exist. |
| `InternalGetNetMode`, `UWorld::GetNetMode` | `0x03F91EB0`, `0x042CC560` | `InternalNetModeHook`, `WorldNetModeHook` | |
| `UNetConnection::Close` | `0x03F62B90` | `NetConnectionCloseHook` | |
| HasFinishedLoading | `0x01BA5E40` | `HasFinishedLoadingHook` | |
| GetViewportSize exec thunk | `0x0398BB50` | `ExecGetViewportSizeHook` | Avoid divide by zero on 0x0 viewport (`VIEWPORT_FALLBACK.flag` -> 1920x1080). |
| Server boot crash handler | `0x02659A20` | `ServerBootCrash` | Log fatal boot errors. |
| `UArchonLoadManager::LoadFailed` | `0x01CB0010` | `ArchonLoadManagerLoadFailedHook` | Player-data load retry. |
| `UArchonLoadManager` Begin | `0x01C997A0` | `LoadMgrBeginHook` | |
| Progression config loaded / `CompleteLoadInternal` | `0x019053A0`, `0x01A4DE80` | `ProgConfigLoadedHook`, `ProgCompleteLoadInternalHook` | Progression diag. |
| Wwise device init | `0x017B1620` | `WwiseDeviceInitHook` | Only with `DISABLE_SERVER_AUDIO.flag` (measured to crash). |
| Progression cache lookup | `0x01902E60` | `ProgCacheLookupHook` | |
| Progression readiness predicate | `0x01A69560` | `ProgReadyHook` | |
| Hunt pass `LoadComplete` | `0x01A19450` | `LoadCompleteProbeHook` | Only with `HUNTPASS_PROBE.flag`. |
| `UInteractionCalloutWidget::OnSetDisabled` | function containing `0x01E5414E` | `InteractionCalloutSetDisabledHook` | Null `InteractionHint` guard. |
| `UInteractionCalloutWidget` family | `0x01E3EB10` RefreshInputKeys, `0x01E4BA00` NativeConstruct, `0x01E4E050` NativeOnInputSwap, `0x01E50A70` NativeTick, `0x01E544B0` OnShowFillProgress, `0x01E52450` OnHideFillProgress, `0x01E542C0` / `0x01E54320` OnSetShowDisabled*WhenEnabled | `Cw*Detour` | Byte-verified as a group; any mismatch installs none (`DISABLE_CALLOUT_GUARDS.flag`). |
| Inventory equipped refresh | `0x01B86160` | `InventoryEquippedRefreshGuard` | `DISABLE_INVENTORY_REFRESH_GUARD.flag`. |
| `IsFeatureEnabled`, `IsLocalFeatureEnabled` | as client | | |
| `d3d11!D3D11CreateDevice`, `D3D11CreateDeviceAndSwapChain`, `kernel32!LoadLibraryExW` | API | `D3D11CreateDeviceHook`, ... | Only with `MP_FORCE_WARP.flag`. |

Defined but not installed: `InstallActiveHuntPassDriver` (`0x018FD230`), `InstallFindRowProbe` (`0x018E6C70`), `InstallConfigCompleteProbe` (`0x00E73D40`), `InstallGameInstanceQueryHook`, `InstallMasteryProbe` (`0x019FBCD0`), `InstallXmppConfigRedirectHook` (`0x025E6890`), Tempest scale diag (`0x0156D7D0`, `0x03CCF210`), `KnockoutHook`.

### Byte patches and global writes

| Site | Role | Change | Switch |
|---|---|---|---|
| `GIsServer` `0x06E1EADA`, `GIsClient` `0x06E1EAD9` | S | Written 1/0 in `Init`, re-asserted every `GameEngineTickHook` | always |
| Party poll `movss` loads `0x01C8BB97`, `0x01C8BBED`, `0x01C8BC38` | C | Point at the image's `1.0f` (`0x05038754`): party poll 5-10 s -> 1 s | `DISABLE_FAST_PARTY_POLL.flag` |
| Inventory hash resync cap `0x01B65AC4` (in `HandleItemStateUpdates` `0x01B65290`) | C | `cmp ecx, 0xA` -> `cmp ecx, 0`: a client/server item-state hash mismatch no longer runs `ClientQueryInventory(true)` + `ServerHandleInventoryHashMismatch(true)` (up to 10 full reloads per map join) | `DISABLE_INVENTORY_RESYNC_CAP.flag` |
| `EnableEasyAntiCheatFeatures` `0x06CFBD44` | C | Byte set to 0 | always |
| ReportCrash `mov edx,60000` `0x0265CF15` | S | 60000 -> 5000 ms | `DISABLE_CRASH_WAIT_SHORTEN.flag` |
| D3D11 `IsSupported` gate `0x034AB73D` | S | Force supported | `MP_FORCE_WARP.flag` |
| Move10 `0x9F9433`, `0x9F95F2`, `0x9F95FE`, `0x9F4F19`, `0x9F4F25` | S | Force GIsClient 0 / GIsServer 1 during map init | `ENABLE_MOVE10_1147.flag` (breaks boot) |
| `CDO` / actor fields (net update frequency, `bAlwaysRelevant`, `CanMove_`, ...) | S | Various runtime writes, see `PlayerRepBoost`, `PlayerAlwaysRelevant` | per flag |

## Side files in detail

### Voice.cpp

| Item | Value |
|---|---|
| Client entry | `MpVoiceStart` (from `InitClientHooks`). Off on servers, with `DISABLE_VOIP.flag`, or without both `MYSTICPARADOX_VOICE_ADDR` (`host:port`) and `MYSTICPARADOX_VOICE_TICKET`. |
| Threads | `NetThread` (UDP recv, hello every 5 s while voice is enabled), `AudioThread` (WASAPI capture/render, Opus encode/decode, jitter buffer per speaker, mix). |
| Audio | 48 kHz mono, 20 ms frames (960 samples), Opus VOIP 24 kbps, 200 ms tail after PTT release, open-mic RMS gate. `SelfTest` round-trips Opus at start. |
| Wire (client) | Sends `H`+ticket (hello), `V`+seq+Opus. Receives `A` (ack) and `W` (sender key u32, seq u16, flags: 1 = has position, 2 = party; optional xyz; Opus). Format owned by backend `voiceRelay.ts`. |
| Game-thread API | `MpVoiceApplySettings` (enabled, volume; slider 0.5 = unity), `MpVoiceSetPttKey`, `MpVoiceSetOpenMic`, `MpVoiceSetSelfMuted`, `MpVoiceSetListener` (pan/fade from pawn + camera yaw), `MpVoiceSelfState`, `MpVoiceKeyForId` (first 4 bytes of sha256(account id)), `MpVoiceKeyTalking`. |
| Server entry | `MpVoiceServerStart(apiKey, port)` from `MpVoiceProximityTick` on hubs. Relay `MYSTICPARADOX_VOICE_RELAY` or `127.0.0.1:8791`. `MpVoiceReportPositions` sends `P` + ts(ms) + game port + up to 20 `(id, x, y, z)` + HMAC-SHA256 (key = gameserver API key). |
| Log tag | `[Voip]` |

### CrashReporter.cpp

| Item | Value |
|---|---|
| Entry | `MpCrashReporterInstall` (C and S). `DISABLE_CRASH_REPORTER.flag` leaves the engine reporter in place. |
| Hooks | `kernelbase!CreateProcessW` (refuses any `CrashReportClient` launch with `ERROR_FILE_NOT_FOUND`), `kernelbase!UnhandledExceptionFilter`, plus a VEH that remembers the last real exception. |
| Report | `MysticReport.json` (exception, module+RVA with Ghidra address, unwound stack, registers, memory, log tail) and `MysticDump.dmp` in Unreal's `UE4CC-*` folder from the reporter command line, else `%TEMP%\MysticCrash-<id>`. |
| Upload | `PUT <MpApiBase>/crash/v1/reports/<id>/report.json`, then `minidump.dmp` (max 32 MB) and `context.xml` (`CrashContext.runtime-xml`) only if the first returns 201. No auth header. Backend: `routes/crashReports.ts`. |
| UI | Client shows a "Dauntless crashed" message box with the report id or folder; servers do not. One report per process; other crashing threads wait. |
| Log tag | `[CrashReporter]` |

### JoinPrompt.cpp

| Item | Value |
|---|---|
| Entry | `MpJoinPromptStart` (C). Off with `DISABLE_JOIN_PROMPT.flag` or without `MYSTICPARADOX_VOICE_TICKET`. |
| Loop | Every 1 s `GET /mystic/party/hunt-offer` with `X-Mystic-Ticket`. Shows an offer only when `"offer":{` and `"blocked":null`, once per member+hunt. |
| Answer | `MpJoinPromptAnswer(true)` -> `POST /mystic/party/join-hunt`; a notice says "Joining <name>'s hunt." or "Can't join." + reason (`FULL`, `NEARLY_DONE`, `ENDING`). Polling pauses 10 s after a join. |
| Game thread | `MpJoinPromptTakeOffer` / `MpJoinPromptTakeNotice` (one-shot strings) read by `JoinPopup` in `dllmain.cpp`. |
| Log tag | `[JoinPrompt]` |

### HuntStats (dllmain.cpp `MpHuntStatsTick` + HuntStats.cpp)

Once a second from `MpHuntJoinTick` on hunt servers: for every `AArchonPlayerState` with a backend account id, keep the max of `DamagesDealt` per behemoth and `MonsterPartDamagesDealt` (part, wound) per part. When the target behemoth's `hpPct` falls to 0, build `{"hunt":"<port>-<time>","playerHuntId":"..","players":[{"userId","damage","partDamage","woundDamage","behemoths":[..]}]}` (values filtered to `[A-Za-z0-9_.:-]`) and `MpHuntStatsPost` it. Since 2026-10-26 each post also has `seconds` (target first seen at hpPct > 0 -> kill) and per player `weapon` (`PS->Weapon`), `grade` and `stats`: a down counter (`bBleedoutState` rising edges) merged with the game's own telemetry, read at each kill by `MpHuntStatsReadTelemetry` (GObjects walk for `UArchonTelemetryComponent_Combat`, owner = `Outer` controller/pawn -> PlayerState; `PlayerData` damage by type/element, staggers, interrupts, breaks, damage/hits taken, bleedouts, dodges, healing, lantern, stamina, distance, time; max kept). Logs `[HuntStats] telemetry matched=N of M`; 0 means the server never created the component and only damage/weapon/downs/seconds go out. `DISABLE_HUNT_STATS.flag`. Backend: `routes/huntStats.ts`.

## Flags beside the game exe

`MpExeRelativeFlagPresent(L"X.flag")` = file `<dir of Dauntless-Win64-Shipping.exe>\X.flag` exists. Most are read once and cached, so create them before launch. 108 names. Default = behaviour with no file.

### Production switches (fix on, file turns it off)

| Flag | Role | Effect of the file |
|---|---|---|
| `DISABLE_BEHEMOTH_HEALTH_BAR.flag` | C | No native HP bar. |
| `DISABLE_CALLOUT_GUARDS.flag` | S | No `UInteractionCalloutWidget` family guards. |
| `DISABLE_CELL_OFFER_PROBE.flag` | C | No `[CellOffer]` probe hook. |
| `DISABLE_CINECAM.flag` | C | No cinematic camera. |
| `DISABLE_CLIENT_ROLE_LIFECYCLE_REPLAY.flag` | C | No client replay of the PlayerRole apply after travel. |
| `DISABLE_CRASH_REPORTER.flag` | C+S | Engine's own CrashReportClient runs instead. |
| `DISABLE_CRASH_WAIT_SHORTEN.flag` | S | Keep the 60 s engine crash wait. |
| `DISABLE_CREDITS_BRANDING.flag` | C | Stock credits. |
| `DISABLE_EAC_LOAD.flag` | C | No effect: the condition is hard-coded true, so the EAC byte is always cleared. |
| `DISABLE_EXPECTED_PLAYER_ZERO.flag` | S | Do not sync GameMode/GameState `ExpectedPlayerCount` from the launch roster. |
| `DISABLE_FAST_PARTY_POLL.flag` | C | Keep the 5-10 s party poll. |
| `DISABLE_FOUNTAIN_POPUP_FIX.flag` | C | Fountain core popup shows the game's own roll (fewer keys, no Platinum line). |
| `DISABLE_GRAPH_DRIVE.flag` | S | Do not drive the replication graph (hub loses PlayerState channels). |
| `DISABLE_HUNTPASS_CLAIM_GUARD.flag` | C | No hunt-pass claim crash guard. |
| `DISABLE_HUNT_COMBAT_LOG.flag` | S | No `HuntCombat\` files. |
| `DISABLE_HUNT_STATS.flag` | S | No hunt-stats posts. |
| `DISABLE_INVENTORY_HEAL.flag` | C | Probe only, no `ClientQueryInventory` heal. |
| `DISABLE_LOADOUT_HEAL.flag` | C | No `[LoadoutHeal]` gear-slot re-resolve. |
| `DISABLE_INVENTORY_RESYNC_CAP.flag` | C | Restore the engine's hash-mismatch reload (10 client+server inventory reloads per mismatching join). |
| `DISABLE_INVENTORY_PROBE.flag` | C | No inventory probe or heal. |
| `DISABLE_INVENTORY_REFRESH_GUARD.flag` | S | No equipped-refresh guard. |
| `DISABLE_JOIN_PROMPT.flag` | C | No join-in-progress polling. |
| `DISABLE_LATE_JOIN_RESCALE.flag` | S | No behemoth HP rescale when players join late. |
| `DISABLE_LOGIN_BRANDING.flag` | C | Stock login screen. |
| `DISABLE_LOGIN_VIDEO.flag` | C | Still image instead of `LoginLoop.mp4`. |
| `DISABLE_NET_RATE_BOOST.flag` | S | Keep engine bandwidth caps. |
| `DISABLE_OWNER_PAWN_RELEVANCY.flag` | S | No owner-connection ViewTarget fix at ClientRestart. |
| `DISABLE_PARTY_ARRIVAL_HOLD.flag` | S | Restart each roster player as soon as they join. |
| `DISABLE_PLAYERDATA_LOAD_RETRY.flag` | S | Original LoadFailed handling. |
| `DISABLE_PLAYER_HUNTID_BACKFILL.flag` | S | No `PlayerHuntId` backfill. |
| `DISABLE_PLAYER_REP_BOOST.flag` | S | Keep pawn net update frequency (no 60/30 Hz boost). |
| `DISABLE_PLAYER_ROLE_GLOBAL_ROUTE.flag`, `DISABLE_PLAYER_ROLE_OWNER_ROUTE.flag`, `DISABLE_PLAYER_ROLE_REMOTE_ROUTE.flag`, `DISABLE_WEAPON_GLOBAL_ROUTE.flag` | S | Turn off one of the PlayerRole / weapon replication routes. |
| `DISABLE_PRESS_START_BRANDING.flag` | C | Stock press-start text. |
| `DISABLE_PRESS_START_SKIP.flag` | C | Show the press-start popup. |
| `DISABLE_PROJECTILE_TICK_FIX.flag` | S | Projectiles stop dealing damage again. |
| `DISABLE_REPGRAPH_RELEVANCE_FIX.flag` | S | No RepGraph global relevance settings. |
| `DISABLE_SPLINE_GUARD.flag` | S | No spline direction guard. |
| `DISABLE_STAFF_NAMEPLATES.flag` | C | Plain nameplates. |
| `DISABLE_VOICE_INDICATORS.flag` | C | No talking icons. |
| `DISABLE_VOIP.flag` | C+S | No voice and no hub proximity reports. |
| `DISABLE_WINDOW_LOCK.flag` | C | Engine may resize the window on map load. |
| `DISABLE_ZOMBIE_WORLD_TRASH.flag` | C | Only request GC for a zombie hub world. |
| `ESCALATION_KEEP_BOON_UNLOCKS.flag` | S | Do not unlock every escalation boon row. |
| `ESCALATION_KEEP_RELIC_TAGS.flag` | S | Keep season Required/Excluded relic tags even when the filtered pool is under 15 (frost). |
| `ESCALATION_NO_BUFF_CHOICE_SPAWN.flag` | S | Do not spawn per-player buff choices at round end. |
| `EMERGENCY_LEGACY_REPLICATION.flag` | S | Request the hand-written replication loop (refused on 1.14.7). |
| `ENABLE_SERVER_AUDIO.flag` | S | Let the server post Wwise sounds again. |
| `NO_IDLE_THROTTLE.flag` | S | Idle hubs keep full frame rate. |
| `SHOW_SERVER_WINDOW.flag` | S | Do not hide the server window. |

### Opt-in features and tuning

| Flag / file | Role | Effect |
|---|---|---|
| `ENABLE_PARTY_DROP_IN.flag` | C+S | Party drop-in arrival (other players' arrival triggers routed to everyone). |
| `ENABLE_SYNTHETIC_NETID.flag` | S | Give the phantom local player a synthetic net id. |
| `ENABLE_PHANTOM_LOAD_SKIP.flag` | S | Skip the phantom's player-data load (known to fail differently). |
| `ENABLE_PLAYERSTATE_OWNER_ROUTE.flag` | S | Route PlayerState owner-only. |
| `ENABLE_BASE_ACTOR_BOOTSTRAP.flag` | S | `MpRouteBaseActorsToConnections` bootstrap. |
| `ENABLE_MOVE10_1147.flag` | S | Apply Move10 patches (stops boot on this build). |
| `ENABLE_SPLINE_EVAL_HOOK.flag` | S | Install the spline evaluator detour (measured unsafe). |
| `PLAYER_ALWAYS_RELEVANT.flag` | S | Player pawns always relevant. |
| `KEEP_PHANTOM_PAWN.flag` | S | Hide the phantom pawn instead of destroying it. |
| `PHANTOM_PAWN_DESTROY_HUNTS.flag` | S | Also destroy the phantom pawn on hunts. |
| `MAP_URL_LISTEN.flag` | S | Add `?listen`; engine creates the listener, runtime only announces READY. |
| `DISABLE_MANUAL_LISTEN.flag` | S | Skip `Networking::Listen` (A/B; server never listens). |
| `MANUAL_NET_TICK.flag`, `NATIVE_NET_TICK.flag` | S | Manual = legacy double-driven net tick (A/B); native is default. |
| `MANUAL_TICK_HALF_RATE.flag`, `MANUAL_TICK_ZERO_DT.flag` | S | Manual tick variants (A/B). |
| `SRA_RATE_CAP.flag` | S | Cap graph `ServerReplicateActors` to the net tick rate. |
| `USE_LEGACY_ROLE_ONREP_REPAIR.flag` | S | Old OnRep-based PlayerRole repair. |
| `MP_FORCE_WARP.flag` | S | WARP software D3D11 for GPU-less hosts. |
| `VIEWPORT_FALLBACK.flag` | S | Report 1920x1080 instead of a 0x0 viewport. |
| `VOIP_OPEN_MIC.flag` | C | Open mic instead of push to talk. Written by the in-game toggle. |
| `AUTO_PRESS_START.flag` | C | Scripted repro: auto press-start, Play, travel to Ramsgate. |
| `REWARD_CACHE_CAPTURE.flag` | C | Run `StoreRuntimeExporter` capture thread. |
| `FORCE_PROGRESSION_CONFIG_READY.flag` | S | Force the progression config "loaded" result. |
| `CALL_HUNTPASS_QUERY.flag`, `CALL_FIND_ACTIVE_HUNTPASS.flag`, `CALL_IFACE_QUERY.flag` | S | Issue hunt-pass/progression queries from the probes. |
| `FORCE_ACTIVE_SEASON.flag`, `FORCE_PROGRESSION_READY.flag` | S | Only read by `InstallActiveHuntPassDriver`, which is not installed: no effect. |
| `FORCE_SERVER_MESH_POSE.flag`, `FORCE_SERVER_MESH_POSE_UNSAFE.flag` | S | First is retired (logs only); the second runs the old mesh-pose experiment. |
| `DEBUG_DAMAGE_MULTIPLIER.flag` | S | Debug damage multiplier, also needs `MYSTICPARADOX_RUNTIME_PROFILE=development`. |
| `FORCE_FEATURE_FLAGS.txt` | C+S | Feature-flag class names to force on, one per line. |
| `HUB_MAX_PLAYERS.txt` | S | Integer 1-64, `?MaxPlayers` cap (default 4). |
| `CINECAM.ini`, `CINECAM_menu.ini`, `CINECAM_shots\` | C | Camera settings, menu layout, saved keyframe shots (written by the runtime). |

### Diagnostics (off unless the file exists)

| Flag | Role | Logs |
|---|---|---|
| `VERBOSE_DIAG.flag` | C+S | `[NetTickTrace]`, `[GetGameDefaultMap]`, movement traces, PE name ring. Needs `MYSTICPARADOX_RUNTIME_PROFILE=development`. |
| `URL_LOG.flag`, `XMPP_TRACE.flag` | C | Read only by dead code: no effect. |
| `URL_PATH_DIAG.flag` | C+S | `[UrlPathDiag]` host+path of every request, rewritten or not. |
| `CHARACTER_ASSOC_PROBE.flag` | C+S | Read by uninstalled probes (`MpProbeCharacterRequestAssociation` is never called): no effect. |
| `SOCKET_DIAG.flag` | C+S | `[SocketDiag]`. |
| `REPGRAPH_DIAG.flag` | S | `[RepFreq]`, `[GraphState]`, `[SRA enter]/[SRA exit]` (large logs). |
| `ENABLE_HUB_REP_DIAGNOSTICS.flag` | S | `[RepConnDiag]` replication membership report; also runs the base-actor routing. |
| `ENABLE_CONTROLLER_WATCHPOINT.flag` | C | Hardware watchpoints on controller fields (`[ControllerWatch]`). |
| `NO_CONTROLLER_SPLIT_LOG.flag`, `NO_PAWN_ROLE_CENSUS.flag`, `NO_PLAYER_ROLE_CHANNEL_LOG.flag` | C/S | Silence `[ControllerSplit]`, `[PawnRoleCensus]`, `[PlayerRoleChannel]`. |
| `NETID_CONTRACT_PROBE.flag` | S | `[NetIdDiag]` net-id vtable probe. |
| `HUNTPASS_PROBE.flag` | C+S | `[HuntPassProbe]` and the hunt-pass `LoadComplete` hook. |
| `HITCH_SAMPLER.flag` | C | `[HitchSample]` game-thread hitch stacks. |
| `CORE_CAPTURE.flag` | S | `[CORE-CAP]` item consume calls. |
| `ACCESSORY_UNLOCK_DIAG.flag` | C | `[AccessoryUnlockDiag]`. |
| `PE_NAME_DIAG.flag` | S | `[SeasonFlowDiag]` ProcessEvent name filter. |
| `DIAG_NATURAL.flag` | C+S | Disable readiness bypasses to watch the natural init (`[Diag]`). |
| `TEMPEST_CHARGE_DIAG.flag`, `TEMPEST_DAMAGE_DIAG.flag` | S | Tempest weapon traces. |
| `TEMPEST_SCALE_DIAG.flag` | S | Refused on 1.14.7 (logs why). |
| `TRIALS_GRACE_DIAG.flag` | S | `[GraceDiag]` bleedout grace sampler. |
| `HYBRID_REPLICATION.flag`, `LEVEL_VISIBILITY_GATE.flag`, `NATIVE_REPLICATION_ONLY.flag`, `REVERSE_CONNECTION_ORDER.flag` | S | Variants of the legacy replication loop in `Networking.cpp`; only matter with `EMERGENCY_LEGACY_REPLICATION.flag`. |

## Environment variables

| Variable | Read by | Role | Meaning |
|---|---|---|---|
| `MYSTICPARADOX_API_BASE` | `MpGetApiOverride` | C (+S) | `http(s)://host:port`, no path. Replaces `https://MP_PUBLIC_HOST` for redirects, crash reports, join prompt, hunt stats. |
| `MYSTICPARADOX_AUTH_MODE` | `Init` | S | Empty or `GLOBAL_GAMESERVER` = normal; anything else exits before listen (stub P2P). |
| `MYSTICPARADOX_GAMESERVER_LAUNCH_ID` | `Networking::Listen`, `AnnounceEngineReady` | S | Echoed in the READY marker; no marker without it. |
| `MYSTICPARADOX_GAUNTLET_LEVEL` | `LaunchGauntletLevel` | S | Gauntlet level -> `?GauntletLevel=`. |
| `MYSTICPARADOX_GAME_MODE` | `GetGameDefaultMap` | S | Row `GameModeOverride` from the Director -> `?game=`. |
| `MYSTICPARADOX_TRIALS_WEEK` | `TrialsLaunchWeekOverride` | S | Pin the Trials row. |
| `TRIALS_ROTATION_MINUTES` | `TrialsRotationMinutes` | S | Trials rotation length, default 10080. |
| `MYSTICPARADOX_BLEEDOUT_SECONDS` | `EnsureBleedoutDuration` | S | Bleedout duration override. |
| `MYSTICPARADOX_PHANTOM_ACCOUNT_ID` | `MpSynthNetIdString` | S | Account id the synthetic net id reports (`ENABLE_SYNTHETIC_NETID.flag`). |
| `MYSTICPARADOX_VOICE_ADDR`, `MYSTICPARADOX_VOICE_TICKET` | `MpVoiceStart`, `MpJoinPromptStart` (ticket) | C | Voice relay `host:port` and the launcher's ticket (JWT, also the join-prompt auth). |
| `MYSTICPARADOX_VOICE_RELAY` | `MpVoiceServerStart` | S | Relay for hub proximity reports, default `127.0.0.1:8791`. |
| `MYSTICPARADOX_RUNTIME_PROFILE` | `DevelopmentRuntimeProfile` | C+S | `development` unlocks `VERBOSE_DIAG.flag` and debug damage. |
| `MYSTICPARADOX_ALLOW_DAMAGE_DEBUG`, `MYSTICPARADOX_DEBUG_DAMAGE_MULTIPLIER` | `ProcessEventHook` | S | Debug damage multiplier. |

Server argv (`CommandLineToArgvW`, more than 8 args): `[1]` gameserver API key, `[2]` port, `[3]` map, `[4]` behemoth class or `NO_BEHEMOTH`, `[5]` matchmaker hunt id or `NO_MM_HUNTID`, `[6]` roster `uid:huntId,...` or `NO_EXPECTED_PLAYERS`, `[7]` IP:port.

## stdout markers (read by the Director)

| Line | Emitted by | When |
|---|---|---|
| `MYSTICPARADOX_GAMESERVER_READY launchId=<id> port=<port>` | `Networking::Listen`, `Networking::AnnounceEngineReady` | After a successful listen, if `MYSTICPARADOX_GAMESERVER_LAUNCH_ID` is set. |
| `MYSTICPARADOX_HUNT_STATE hpPct=<n> players=<n> subState=<s>` | `MpHuntJoinTick` | Hunt servers, on change and every 5 s. Used by the join-in-progress gate. |

## Log tags

All go to `mysticparadox_dll_port<N>.log` beside the exe unless noted. `[Init]`, `[EngineRealloc]` and most `[InitServerHooks]`/`[MainThread]` progress lines go through `InitLog`, which is a no-op, so they never appear.

| Tag | File | Meaning |
|---|---|---|
| `[AbilityActivate]` | dllmain.cpp | S: ability activation trace on a component. |
| `[AccessoryUnlockDiag]` | dllmain.cpp | C: accessory/transmog unlock queries (`ACCESSORY_UNLOCK_DIAG.flag`). |
| `[ActiveHuntPass]`, `[ActiveHuntPassProbe]` | dllmain.cpp | S: active hunt pass row lookups and why they fail. |
| `[ActiveSeason]` | dllmain.cpp | S: wrote the game instance's active season row. |
| `[AddMovementInput]`, `[SetMovementMode]`, `[K2_OnMovementModeChanged]`, `[MovementDiag]` | dllmain.cpp | C: movement traces (verbose). |
| `[AfkExemption]` | dllmain.cpp | S: `bNoAFK` set on local controllers. |
| `[AirshipHUD]` | dllmain.cpp | C: gameplay HUD reconcile around the airship/arrival (faults caught). |
| `[ApiOverride]` | dllmain.cpp | `MYSTICPARADOX_API_BASE` accepted or why it was ignored. |
| `[ApplyPlayerRole]` (`[RetryTimeout]`, `[RetryWait]`) | dllmain.cpp | Omnicell apply hook and its retries. |
| `[ArchonInputActivate]` | dllmain.cpp | C: input activation / cinematic-mode reset after arrival. |
| `[ArchonLoadingScreenFadeIn]` | dllmain.cpp | Fade-in suppressed by the null-widget guard. |
| `[ArrivalCensus]` | dllmain.cpp | C: possession chain completed after arrival. |
| `[AutoPlay]`, `[AutoPressStart]`, `[AutoTravel]` | dllmain.cpp | C: `AUTO_PRESS_START.flag` steps. |
| `[BankedXPQuest]` | dllmain.cpp | S: banked XP quest objectives seen and raised. |
| `[BaseActorRoute]` | dllmain.cpp | S: base actor bootstrap routing (`ENABLE_BASE_ACTOR_BOOTSTRAP.flag`). |
| `[BehemothHealthBar]` | dllmain.cpp | C: HP bar setup/state (capped). |
| `[Bleedout]`, `[BleedoutBUG]`, `[BleedoutStuck]` | dllmain.cpp | S: bleedout duration set; zero-duration entry; player still downed after a long time. |
| `[BountyFlagDump]`, `[DailyBountyGuard]` | dllmain.cpp | S: bounty component flags; completing a stuck bounty loader. |
| `[CORE-CAP]` | dllmain.cpp | S: item consume capture (`CORE_CAPTURE.flag`). |
| `[CalloutGuard]` | dllmain.cpp | S: InteractionCallout family guards installed/aborted/skips. |
| `[CellOffer]` | dllmain.cpp | C: Middleman cell offer prices as the client holds them; `filled` = price copied into the tile. |
| `[ChannelCreate]`, `[RepActor]`, `[RepSkipInvisible]`, `[RepOrder]`, `[TickNetLoop]` | Networking.cpp | S: legacy replication loop (only with the emergency flag). |
| `[CharAssocProbe2]`, `[CharCreateProbe]`, `[CharDispatchProbe]`, `[CharLoaderProbe]`, `[CharParseProbe]` | dllmain.cpp | Character-request probes; their hooks are not installed. |
| `[CineCam]` | dllmain.cpp, CineCamMenu.cpp | C: camera on/off, owner gate, menu/Present hook state. |
| `[ClientPSGap]`, `[PSGapCensus]` | dllmain.cpp | C: missing-PlayerState trace and census of the client's player objects. |
| `[ClientPerf]` | dllmain.cpp | C: ProcessEvent calls/s and hook cost, once a minute. |
| `[ClientRestartObserved]`, `[ClientTravelGuard]`, `[ClientRolePump]` | dllmain.cpp | C: ClientRestart seen; role lifecycle deferred during travel; role pump fault caught. |
| `[CollectionFix]` | dllmain.cpp | S: net driver registered in level collections. |
| `[CommandLine]` | dllmain.cpp | Engine command line served with `-NoEAC`/`-DisableEOS`/`-nullrhi`. |
| `[ConfigCompleteProbe]`, `[FindRowProbe]`, `[GameInstanceQuery]`, `[LoadCompleteProbe]`, `[MasteryProbe]` | dllmain.cpp | S: progression/hunt-pass probes (mostly not installed; `[LoadCompleteProbe]` with `HUNTPASS_PROBE.flag`). |
| `[ControllerSplit]`, `[ControllerWatch]` | dllmain.cpp | C: local controller diverged from its player; watchpoint hits. |
| `[CorePopup]` | dllmain.cpp | C: every `ClientContainerUnlocked` notification list and `ServerUnlockContainer` ids; fountain core keys rewritten + Platinum line added; cell core `<cell> -> <upgraded>` / `no upgrade`. |
| `[CrashReporter]` | CrashReporter.cpp | Installed/disabled, report written, upload ok/FAILED. |
| `[CrashWait]` | dllmain.cpp | S: engine crash wait shortened or kept. |
| `[CreditsBranding]`, `[LoginBranding]`, `[PressStartBranding]` | dllmain.cpp | C: branding applied / widget or function not found. |
| `[DebugDamageMultiplier]` | dllmain.cpp | S: debug damage multiplier applied. |
| `[Diag]` | dllmain.cpp | Natural-mode (`DIAG_NATURAL.flag`) state. |
| `[EACFix]`, `[EACFlags]`, `[EACPopup]` | dllmain.cpp | C: EAC byte cleared; EAC command-line flags seen; expected EAC init failure absorbed. |
| `[EngineListen]` | Networking.cpp | S: READY marker emitted for the engine listener. |
| `[EnqueueDisconnectError]` | dllmain.cpp | C: disconnect reason and caller RVA. |
| `[EscalationBoonPool]`, `[EscalationBuffChoiceSpawn]`, `[EscalationFlow]` | dllmain.cpp | S: boon rows unlocked + per-season pool size / tag filter dropped; buff choices spawned; escalation state trace. |
| `[ExceptionTrace]`, `[ExitTrace]` | dllmain.cpp | Exception records and every process exit with stack. |
| `[ExpectedPlayerCount]` | dllmain.cpp | S: roster sync of `ExpectedPlayerCount`. |
| `[FMessageDialog]` | dllmain.cpp | Native OS message dialog suppressed. |
| `[FeatureFlags]` | dllmain.cpp | S: feature flag dump in progression probes. |
| `[FindArchonRepGraph]`, `[FindArchonRepGraphCDO]` | dllmain.cpp | S: locating the ArchonReplicationGraph class/CDO. |
| `[ForceCanMove]`, `[ForceMobility]`, `[ForceMovementMode]`, `[ForceRole]`, `[ForceTeleport]`, `[ForceVelocity]` | dllmain.cpp | Legacy movement-forcing writes (mostly disabled). |
| `[ForceFeature]` | dllmain.cpp | Feature flags listed in `FORCE_FEATURE_FLAGS.txt` and forced. |
| `[ForceServerMeshPose]` | dllmain.cpp | S: retired mesh-pose diagnostic. |
| `[FrankCanActivateBPHook]`, `[FrankDroneDiag]`, `[FrankPropertyInventory]`, `[FrankSetDronePositionActor]` | dllmain.cpp | Artificer drone diagnostics. |
| `[GameEngineTick]` | dllmain.cpp | S: tick hook first entry, Listen calls, engine listener READY. |
| `[Gauntlet]`, `[GauntletProbe]` | dllmain.cpp | S: Gauntlet level from env; Gauntlet component state changes. |
| `[GetActorChannel]`, `[ResolveNamedNetDriver]`, `[TickNetworking]` | Networking.cpp | S: invalid arrays / driver lookup problems. |
| `[GetGameDefaultMap]` | dllmain.cpp | S: map URL build (verbose). |
| `[GraceDiag]` | dllmain.cpp | S: bleedout grace sampler. |
| `[GraphDrive]`, `[GraphDriveProbe]`, `[GraphSRA]`, `[SRA enter]`, `[SRA exit ]`, `[SraRateCap]` | dllmain.cpp | S: replication graph drive and `ServerReplicateActors` calls. |
| `[GraphState]`, `[LoadoutRepFlags]`, `[LoadoutState]`, `[PlayerRoleDirectChannel]` | Networking.cpp | S: graph node/connection dump (`REPGRAPH_DIAG.flag`); loadout/role channel state. |
| `[HUDTrace]` | dllmain.cpp | C: HUD function trace. |
| `[HangSuspect]`, `[HangTrace]` | dllmain.cpp | S: game thread not ticking; sampled stacks of all threads. |
| `[HasDisconnectError]` | dllmain.cpp | C: disconnect error observed (hook not installed). |
| `[HeadlessAudio]`, `[HeadlessServer]` | dllmain.cpp | S: audio left intact / suppressed; window hidden, nullrhi cache state. |
| `[HitchSample]` | dllmain.cpp | C: hitch sampler episodes (`HITCH_SAMPLER.flag`). |
| `[HuntIdBackfill]` | dllmain.cpp | S: `PlayerHuntId` backfill. |
| `[HuntPassClaimGuard]` | dllmain.cpp | C: claim result with no track skipped. |
| `[HuntPassProbe]`, `[HuntPassQuery]`, `[HuntPassRows]` | dllmain.cpp | Hunt pass probe; boot hunt pass query; hunt pass table rows. |
| `[HuntStats]` | dllmain.cpp, HuntStats.cpp | S: posted JSON; telemetry components matched; backend status. |
| `[IdentityDiag]`, `[LoaderDump]` | dllmain.cpp | Player-data gate owner chain; load manager entries. |
| `[IfaceQueryCall]`, `[IfaceVtable]`, `[WindowLookup]` | dllmain.cpp | S: progression cache interface probes (`CALL_IFACE_QUERY.flag`). |
| `[InitClientHooks]`, `[InitServerHooks]` | dllmain.cpp | Hook create/enable results (`MH_StatusToString`) or "skipped" reasons. |
| `[InitRole]` | dllmain.cpp | S: role, auth mode, NullRHI. |
| `[InputConfigCascade]`, `[InputModeVal]`, `[PlayerRoleInput]` | dllmain.cpp | C: input config / mode traces. |
| `[InteractionCalloutHideHoldText]`, `[InteractionCalloutSetDisabled]` | dllmain.cpp | S: null-widget calls skipped. |
| `[InvHeal]`, `[InvProbe]` | dllmain.cpp | C: empty-inventory heal; inventory view changes. |
| `[LoadoutHeal]` | dllmain.cpp | C: gear slot re-resolved after its CRC lookup was skipped (empty equipment screen). |
| `[InventoryRefreshGuard]` | dllmain.cpp | S: equipped refresh skipped / guard not installed. |
| `[IsEOSEnabled]` | dllmain.cpp | C: forced to 0. |
| `[JoinPrompt]` | dllmain.cpp, JoinPrompt.cpp | C: polling, offers, answers, notices. |
| `[LateJoin]` | dllmain.cpp | S: behemoth HP rescaled for a higher player count. |
| `[LegacyReplication]`, `[NATIVE_GRAPH_ONLY]`, `[NATIVE_REPLICATION_ONLY]` | Networking.cpp | S: which replication path runs. |
| `[Lifecycle:<event>]` | dllmain.cpp | S: Archon lifecycle edges (`LogArchonLifecycle`, e.g. `ConnEdge`). |
| `[LoadFailedDiag]`, `[PlayerDataRecovery]` | dllmain.cpp | S: `LoadFailed` fires and the retry. |
| `[LoadMapPL]` | dllmain.cpp | C: LoadMap world census and zombie package trash. |
| `[LoginOpFailed]`, `[LoginOpSuccess]`, `[LoginScreenDiag]`, `[LoginTree]` | dllmain.cpp | C: login results and login-screen diagnostics. |
| `[MainThread]` | dllmain.cpp | Session banner; server UWorld wait. |
| `[ManualTickDT]`, `[ManualTickRate]`, `[ManualTickDispatchSEH]`, `[NativeNetTick]`, `[NetTickFault]`, `[NetTickTrace]`, `[TickDispatchInner]`, `[NetDriverTickDispatchInner]` | dllmain.cpp | S: net tick mode, caught faults, traces. |
| `[MatchStateChange]` | dllmain.cpp | S: match state change. |
| `[Move10]`, `[move10]` | dllmain.cpp | S: Move10 patch status. |
| `[MoveRate]` | dllmain.cpp | S: GameNetworkManager move send rates. |
| `[MustSpectate]`, `[PlayerCanRestart]`, `[PlayerStart]` | dllmain.cpp | S: spawn decisions. |
| `[NetConnEdge]`, `[NetConnectionClose]`, `[NotifyClientDisconnected]` | dllmain.cpp | Connection count edges and closes. |
| `[NetDiag]` | dllmain.cpp | S: `GIsServer`/`GIsClient` values. |
| `[NetIdDiag]`, `[SynthNetId]` | dllmain.cpp | S: net-id contract probe; synthetic net id. |
| `[NetRate]` | dllmain.cpp | S: original and raised bandwidth caps. |
| `[Networking::Listen]` | Networking.cpp | S: Listen steps (also printed to stdout). |
| `[NodeVtable]` | dllmain.cpp | S: RepGraph node vtables. |
| `[OwnerPawnRelevancy]` | dllmain.cpp | S: ViewTarget set to the pawn for its owner. |
| `[PCChannelBind]`, `[PCChannelQuarantine]`, `[PCConnActorInfoInvariant]`, `[PlayerControllerChannelGuard]`, `[PlayerControllerPreChannelGuard]`, `[PlayerControllerRouteGuard]` | dllmain.cpp | S: PlayerController channel guard actions. |
| `[PartyArrival]`, `[PartyDropIn]` | dllmain.cpp | S: party arrival hold; drop-in trigger routing. |
| `[PawnChannelGrace]`, `[PawnRoleCensus]` | dllmain.cpp | Pawn channel grace period; remote pawn role census. |
| `[PhantomLoadSkip]`, `[PhantomRep]` | dllmain.cpp | S: phantom load skipped; phantom replication suppressed. |
| `[Phase0P]`, `[Phase0f]` | dllmain.cpp | S: permanent replication settings at boot. |
| `[PlayerAlwaysRelevant]`, `[PlayerRepBoost]` | dllmain.cpp | S: pawn relevance/frequency writes. |
| `[PlayerRoleChannel]`, `[PlayerRoleCullGuard]`, `[PlayerRoleGlobalMembership]`, `[PlayerRoleGraphRoute]`, `[PlayerRoleLifecycle]`, `[PlayerRoleLifetimePurge]`, `[PlayerRolePostActiveRefresh]`, `[PlayerRoleRepNotify]`, `[PlayerRoleRouteGuard]`, `[PlayerStateGlobalMembership]`, `[PlayerStateRouteGuard]`, `[WeaponRouteGuard]` | dllmain.cpp | PlayerRole/PlayerState/weapon routing and lifecycle. |
| `[PossessionChain]`, `[PossessionRPC]` | dllmain.cpp | Possession chain gaps; possession RPCs. |
| `[ProcessEventClientHook]`, `[ProcessEventHook]` | dllmain.cpp | Reentrancy guard tripped. |
| `[ProgCacheProbe]`, `[ProgDiag]`, `[ProgReady]`, `[ProgResume]`, `[ReadinessCompat]` | dllmain.cpp | S: progression config/readiness probes and forced readiness. |
| `[ProjTickFix]` | dllmain.cpp | S: tick enabled on a projectile (first 20). |
| `[ProxVoice]` | dllmain.cpp | S: hub reporting a player id to the voice relay. |
| `[QoSFix]` | dllmain.cpp | C: latency-test host resolved to loopback. |
| `[ReforgeObjective]` | dllmain.cpp | S: Slayer's Path reforge objective raised (`amount a->b/required`). |
| `[RelicClickDiagnostic]` | dllmain.cpp | Relic choice click rejected/armed. |
| `[RepConnDiag]`, `[RepFields]`, `[RepFreq]`, `[SendPath]` | dllmain.cpp | S: replication diagnostics. |
| `[RewardCacheCapture]` | dllmain.cpp | C: store capture worker. |
| `[SeasonFlowDiag]` | dllmain.cpp | S: ProcessEvent name filter (`PE_NAME_DIAG.flag`). |
| `[ServerAuth]` | dllmain.cpp | S: unknown auth mode, terminating. |
| `[ServerBootCrash]` | dllmain.cpp | S: fatal boot error category and message. |
| `[ServerPatch]` | dllmain.cpp | S: legacy 1.12 boot patch disabled. |
| `[SocketDiag]` | dllmain.cpp | Socket traffic (`SOCKET_DIAG.flag`). |
| `[SplineGuard]`, `[SplineGuard2]` | dllmain.cpp | S: corrupt spline curve absorbed. |
| `[StaffNameplate]` | dllmain.cpp | C: nameplate styling (capped). |
| `[StoreRuntime]` | StoreRuntimeExporter.cpp | `OutputDebugString` only, not the log file. |
| `[TempestChargeDiag]`, `[TempestDamageDiag]`, `[TempestModifierEnsure]`, `[TempestPerfectDodge]`, `[TempestScaleDiag]` | dllmain.cpp | Tempest weapon traces and modifier re-apply. |
| `[TickRate]` | dllmain.cpp | S: engine Hz, once a minute. |
| `[TrialsSchedule]` | dllmain.cpp | S: Trials rows rewritten / launch-pinned row. |
| `[UrlPathDiag]`, `[UrlRedirect]` | dllmain.cpp | Request host/path (`URL_PATH_DIAG.flag`); redirect active (once). |
| `[VendorFix]`, `[ViewportFallback]` | dllmain.cpp | S: `UpdateCameraForAspect` absorbed; viewport fallback. |
| `[VoiceIcon]`, `[VoipMenu]` | dllmain.cpp | C: talking icons; options menu rows. |
| `[Voip]` | Voice.cpp, dllmain.cpp | Voice start/off reasons, relay ack, mode/mute changes, hub proximity. |
| `[Watchdog/thread]` | dllmain.cpp | S: empty-server reaper heartbeat and reap reason. |
| `[WARP]` | dllmain.cpp | S: WARP force state. |
| `[WeaponXP]` | dllmain.cpp | Weapon XP grant/HUD refresh traces. |
| `[WindowLock]` | WindowLock.cpp | C: hooks installed; resize edges on; engine re-apply overridden. |
| `[XmppConfig]` | dllmain.cpp | Dead code (XMPP hook not installed). |
| `[vhook]`, `[vtable]` | dllmain.cpp | stdout only: vtable hook/dump helpers. |

Not log tags: `[Owner] `, `[Admin] `, `[Mod] ` and `[Wanderer] `, `[Scout] `, `[Slayer] `, `[Legend] `, `[Emerald] ` are the backend's name prefixes that `StaffNameplates` strips.

See also: [runtime](runtime.md), [director](director.md), [backend](backend.md), [paradox-launcher](paradox-launcher.md), [tools](tools.md).
