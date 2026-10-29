# Tools and scripts (`versions/1.14.7/tools`, `versions/1.14.7/scripts`)

> Verified against code 2026-10-24.

## What it is

Three small helpers around the main services:

- **CatalogExporter** (C++ DLL). You inject it into your own running Dauntless 1.14.7 client. It reads data tables out of game memory and writes JSON Lines files. Those files feed the generators that produce the backend and Director `game-data/*.json`. This is how the project gets item catalogs, hunt tables and Slayer's Path data without shipping Phoenix Labs files.
- **RuntimeLoader** (Rust DLL). A `winmm.dll` proxy that sits next to the game exe. The game loads it as a normal Windows DLL. It forwards the real `winmm.dll` / `version.dll` calls to the system copies and also loads `MysticParadox.dll` (the runtime, see [Runtime](runtime.md)) into the game process.
- **scripts/**: two self-host helpers. `configure-selfhost.ps1` writes `.env` files and build settings for a new server, and `generate-selfhost-rsa-key.mjs` makes the backend's JWT signing key pair.

## File reference

| File | What it does |
|---|---|
| `tools/CatalogExporter/dllmain.cpp` | `DllMain` starts `ExporterThread`. Loads flags, waits for `GObjects` + `UArchonCatalog` (240 × 500 ms), runs each enabled export, writes `export_manifest_1_14_7.json`, beeps. Holds the catalog and equipment dumps (`DumpGeneralCatalog`, `DumpEquipmentCatalog`), the weapon-slot/part dumps (`DumpLiveWeaponSlots`, `DumpLiveWeaponParts`, `DumpWeaponPartCatalogRows`, `DumpLoadoutGearUI`), `DumpLiveCellSlots`, `Status` (appends to `catalog_export_status.txt` and `OutputDebugString`) and JSON helpers. |
| `tools/CatalogExporter/ExportFlags.hpp` | `ExportFlags` struct (13 flags) and `LoadExportFlags()`: parses `KEY=VALUE` lines, `#` comments; `1`, `true`, `TRUE` mean on. |
| `tools/CatalogExporter/ExportPaths.hpp` | `ExportOutDir()` (first existing of `<root>\Items_Analysis`, `.\Items_Analysis`, else creates the first) and `ExportFlagsFileCandidates()` (`<root>\tools\CatalogExporter\export_flags.txt`, then `.\export_flags.txt`). `<root>` = `MYSTICPARADOX_EXPORT_ROOT` from an optional gitignored `ExportPaths.local.h`. |
| `tools/CatalogExporter/HuntExporter.cpp` | `RunHuntExport` (`EXPORT_HUNTS`): reads tables by row struct into `hunts_1_14_7/`. Map soft paths via `FName::GetRawString`. FText fields omitted. |
| `tools/CatalogExporter/SlayersPathExporter.cpp` | `RunSlayersPathExport` (`EXPORT_SLAYERS_PATH`): `PlayerJourneyNodeData` rows (costs, rewards, child nodes). |
| `tools/CatalogExporter/StoreRuntimeExporter.cpp` | `RunStoreRuntimeExport` (`EXPORT_STORE_RUNTIME`): loaded `UStoreViewModel` / `UStoreItemViewModel` objects and store image rows. No `ProcessEvent`. |
| `tools/CatalogExporter/ProgressionExporter.cpp` | `RunProgressionExport` (`EXPORT_PROGRESSION`): experience, mastery, prestige, hunt-pass and award tables. |
| `tools/CatalogExporter/CombatExporter.cpp` | `RunCombatExport` (`EXPORT_COMBAT`): `DamageTableData`, `WeaponPowerTableData`. |
| `tools/CatalogExporter/SkinsExporter.cpp` | `RunSkinsExport` (`EXPORT_SKINS`, optional `EXPORT_SKINS_RESOLVE_STRINGTABLE` name lookup through `ProcessEvent`). |
| `tools/CatalogExporter/CurrencyExporter.cpp` | `RunCurrencyExport` (`EXPORT_CURRENCY_NAMES`): string-table names for currency items through `ProcessEvent`. |
| `tools/CatalogExporter/DropTableExporter.cpp` | `RunDropTableExport` (`EXPORT_DROP_TABLES`): `PlayFabDropTableTableData` weighted rows. |
| `tools/CatalogExporter/TableInventoryExporter.cpp` | `RunTableInventoryExport` (`EXPORT_TABLE_INVENTORY`): census of every loaded DataTable (runs last). |
| `tools/CatalogExporter/ExportFlags.md` | Long reference for each mode. Written for the 1.12 build; its header notes the code now writes `_1_14_7` names. |
| `tools/CatalogExporter/export_flags.example.txt` | Template for the flags file. Copy to `export_flags.txt` (gitignored). |
| `tools/CatalogExporter/CatalogExporter.vcxproj` | MSBuild project: Release x64 DLL, toolset v145, C++ latest, `SdkRoot = ..\..\ParadoxRuntime\`, compiles the SDK's `Basic.cpp` and `CoreUObject_functions.cpp`. |
| `tools/CatalogExporter/_build.bat` | Finds MSBuild with `vswhere` and builds Release x64 (exit 3 if Visual Studio/MSBuild is missing). |
| `tools/CatalogExporter/.gitignore` | `x64/`, `obj/`, `.vs/`, build artifacts, `ExportPaths.local.h`, `export_flags.txt`. |
| `tools/RuntimeLoader/src/lib.rs` | `DllMain`, `module_directory`, `select_runtime_dll`, `initialize`, `read_dll_list_from_ini`, `load_dll`; two unit tests. |
| `tools/RuntimeLoader/src/proxy.rs` | `get_proxied_func` / `load_proxied_dll` (system-directory DLL, cached per name) and the `proxy_function!` macro (default value or fallback call when the real export is missing). |
| `tools/RuntimeLoader/src/exports.rs` | The exported stubs: 180 `winmm.dll` and 17 `version.dll` functions (the four `...Ex` version functions fall back to the non-Ex ones). |
| `tools/RuntimeLoader/Cargo.toml`, `Cargo.lock` | Crate `paradox-runtime-loader` 0.1.0, edition 2024, lib name `winmm` (cdylib), dependency `winapi`. Release: LTO, strip, `opt-level = "z"`, one codegen unit, `panic = "abort"`. |
| `tools/RuntimeLoader/README.md`, `LICENSE`, `.gitignore` | Build notes; Apache-2.0 (derived from `coldloader-proxy`); ignores `/target`. |
| `scripts/configure-selfhost.ps1` | One-shot generator of both `.env` files, the runtime header, launcher env, runtime-update key, `.selfhost/` build files. |
| `scripts/generate-selfhost-rsa-key.mjs` | Prints a 4096-bit RSA key pair as JSON `{privateKeyB64, publicKeyB64}` (PKCS8 and SPKI PEM, base64). |

## How it works

### CatalogExporter

**Build.** `tools/CatalogExporter/_build.bat` runs MSBuild on `CatalogExporter.vcxproj`. The project compiles against the generated SDK in `versions/1.14.7/ParadoxRuntime/` (`SDK.hpp`, `SDK/`). That SDK is a Dumper-7 dump and is not in git. See `docs/GENERATING_SDK.md`. Output goes to `x64/Release/CatalogExporter.dll`. Rebuild for the exact game build: a DLL built against another SDK has the wrong object and name offsets.

**Run.**

1. Copy `export_flags.example.txt` to `export_flags.txt` and set the flags you need.
2. Optional: put `#define MYSTICPARADOX_EXPORT_ROOT L"D:\\your\\repo\\versions\\1.14.7"` in `ExportPaths.local.h` before building. Output then lands in `<root>\Items_Analysis` (where the generators look) and the flags are read from `<root>\tools\CatalogExporter\export_flags.txt`. Without it both are relative to the game's working directory.
3. Start your own client and open the screen each mode needs (table below).
4. Inject the DLL with any normal injector. The worker thread waits up to about 120 s for the object array and the catalog (`TIMEOUT: catalog never appeared` otherwise), then runs every enabled export once.
5. Check `catalog_export_status.txt` (appended, ends with `ALL DONE ...`) and `export_manifest_1_14_7.json`. Do not assume every table was written.

Flags are read once when the thread starts. To change them, edit the file and inject again.

**Flags file rule.** If `export_flags.txt` is missing, only `EXPORT_CATALOG` runs. Once the file exists it is authoritative: a key that is absent counts as 0.

| Flag | Output under `Items_Analysis` | Screen to reach first | Used by |
|---|---|---|---|
| `EXPORT_CATALOG` | `catalog_1_14_7.jsonl`, `equipment_1_14_7.jsonl` | Main menu or Ramsgate | Backend item data, Reward Cache, platinum store and storage-policy generators |
| `EXPORT_SLAYERS_PATH` | `slayers_path_1_14_7/player_journey_nodes.jsonl` | Slayer's Path screen | Backend `generate:slayers-path` |
| `EXPORT_HUNTS` | `hunts_1_14_7/`: `player_hunts.jsonl`, `matchmaker_hunts.jsonl`, `hunt_regions.jsonl`, `escalation_mode_specs.jsonl`, `hunt_modifiers.jsonl`, `game_activities.jsonl`, `activity_unlock_criteria.jsonl`, `schedule_data.jsonl`, `hunt_export_manifest.json` | Ramsgate, then the Hunt/Map screen | Director `npm run generate:hunt-tables` ([Director](director.md)) |
| `EXPORT_STORE_RUNTIME` | `store_item_images_1_14_7.jsonl`, `store_view_models_1_14_7.jsonl`, `store_item_view_models_1_14_7.jsonl` | Ramsgate, Journal > Challenges > Reward Cache | Platinum store data |
| `EXPORT_PROGRESSION` | `progression_1_14_7/` (`player-experience-tracks`, `weapon-experience-tracks`, `experience-tracks`, `huntpass-season-table`, `experience-awards`, `progression-tracks`, `online-track-info`, `mastery-tracks`, `prestige-tracks` `.jsonl`) | - | Research |
| `EXPORT_COMBAT` | `combat_1_14_7/damage-tables.jsonl`, `weapon-power-tables.jsonl` | - | Research |
| `EXPORT_SKINS` (+ `EXPORT_SKINS_RESOLVE_STRINGTABLE`) | `weapon_skins_1_14_7.jsonl` | - | Research |
| `EXPORT_WEAPON_SLOTS` | `weapon_slots_1_14_7.jsonl`, `live_weapon_parts_1_14_7.jsonl`, `weapon_part_catalog_rows_1_14_7.jsonl`, `loadout_gear_ui_1_14_7.jsonl` | A loaded inventory | Research |
| `EXPORT_CELLS` | `live_cell_slots_1_14_7.jsonl` | A loaded inventory | Research |
| `EXPORT_DROP_TABLES` | `drop_tables_1_14_7.jsonl` | Core Breaker, preview a core of each tier | Research |
| `EXPORT_CURRENCY_NAMES` | `currency_names_1_14_7.jsonl` | - | Research |
| `EXPORT_TABLE_INVENTORY` | `table_inventory_1_14_7.jsonl`, `table_inventory_1_14_7.txt` | - | Research |

The full path from export to final files (hunt tables, Slayer's Path, Reward Cache, progression config, Lady Luck store) is in `versions/1.14.7/docs/GENERATING_GAME_DATA.md`. Two backend files cannot be generated from exports (`progression_config` and `ladyluck_store`). You supply their source responses in `ParadoxBackend/game-data/raw`.

**How each exporter reads data.** They read engine tables by walking the object array and matching a table's *row struct* name, not its asset name. A name mismatch skips the table with a note in the status file rather than reading with wrong offsets. Rows are sorted by name, so two dumps can be diffed. Text values (`FText`) are deliberately not read, because calling `ToString()` on one crashed the game. Ids come from `FName` or plain data.

### RuntimeLoader

1. The game's import table loads `winmm.dll` from its own folder (the proxy) instead of the system one.
2. On `DLL_PROCESS_ATTACH`, `initialize()` finds the directory of the proxy and chooses a runtime DLL: of `MysticParadox.dll` and the legacy `MystPaxInternalServer.dll`, the one with the **newest modified time** wins (ties go to the canonical name). It calls `LoadLibraryW` on it. Errors are ignored silently.
3. It then reads optional `mystic_loader.ini` (one DLL path per line; text after `;` or `#` is a comment; `[section]` lines ignored; `key = value` uses the value). Each path is joined onto the proxy's folder (an absolute path stays absolute) and loaded if the file exists. Entries naming either runtime DLL are skipped.
4. Every `winmm.dll` and `version.dll` export is a stub made by the `proxy_function!` macro. On call it loads the real DLL from `GetSystemDirectoryW` (cached) and calls the same function. If the real one is missing, it returns a default (usually 0 or FALSE) or calls the fallback function.

Build: `cd tools\RuntimeLoader; cargo build --release`. The output is `target\release\winmm.dll`.

The loader is distributed with every runtime publish as an `--extra winmm.dll` file, see [Paradox Launcher](paradox-launcher.md). The launcher hashes `MysticParadox.dll` and `winmm.dll` at Play.

### scripts/configure-selfhost.ps1

Run once on a fresh checkout. Paths are relative to `versions/1.14.7` (the script's parent folder).

| Parameter | Default | Use |
|---|---|---|
| `-PublicHost` | required (`^[A-Za-z0-9.-]+$`) | Public DNS name; base URL `https://<host>` |
| `-GameServerBinaryPath` | required | Game exe; must exist; hashed for `APPROVED_EXECUTABLE_SHA256` |
| `-TlsCertificatePath`, `-TlsPrivateKeyPath` | required | Must exist |
| `-TlsPrivateKeyPassphrase` | `""` | `PARADOX_KEY_PASSPHRASE` |
| `-MongoDbUri`, `-MongoDbName` | `mongodb://127.0.0.1:27017`, `mysticparadox` | Backend Mongo (the live box uses 27018, replica set `rs0`) |
| `-GameServerPublicAddress` | `127.0.0.1` | Director `MY_IP` |
| `-BackendHttpPort`, `-BackendHttpsPort` | 3000, 443 | HTTPS must be 443 (the runtime is built for it) |
| `-DirectorPort` | 3001 | Director `PORT`, backend `DEPLOYSERVER_URL` |
| `-GamePortBegin`, `-GamePortEnd` | 8780, 8790 | Needs at least 3 ports |
| `-UseSyntheticData` | off | Copies every `*.example.json` to its real name in both `game-data` folders |
| `-InstallDependencies` | off | `npm ci` + `npm run build` in ParadoxBackend, ParadoxDirector, ParadoxLauncher |
| `-Force` | off | Overwrite existing backend/Director/launcher `.env` |

Steps:

1. Checks the three files exist, the HTTPS port and range, and that `node` and `npm` are on PATH.
2. Copies `ParadoxBackend/.env.example` and `ParadoxDirector/.env.example` to `.env` (refuses if one exists unless `-Force`).
3. Calls `generate-selfhost-rsa-key.mjs` for the backend JWT pair (`AUTH_SIGNING_PRIVKEY_B64`, `AUTH_SIGNING_PUBKEY_B64`). Generates a random 32-byte hex `GAMESERVER_API_KEYS` value (reused as the Director's `METAGAME_API_KEY`) and `API_KEY_HASH_SECRET`.
4. Backend values set: `PORT`, `AUTH_MODE=LAUNCHER`, `ALLOW_NO_AUTH_DEV_MODE=false`, the JWT pair, `MONGODB_URI`, `MONGODB_DB`, `MONGODB_APP_NAME=paradox-backend` and pool/timeouts, `TARGET_CHANGELIST=647472`, `QOS_TARGET_URL=<base>/QoS`, `MATCHMAKING_MODE=DEPLOYSERVER`, `DEPLOYSERVER_URL=127.0.0.1:<DirectorPort>`, `GAMESERVER_API_KEYS`, `API_KEY_HASH_SECRET`, `HTTPS_PORT`, `PARADOX_CERT_PEM_PATH`, `PARADOX_KEY_PEM_PATH`, `PARADOX_KEY_PASSPHRASE`, `LAUNCHER_ALLOWED_ORIGINS=http://localhost:1420,https://<host>`, `APPROVED_EXECUTABLE_SHA256`, `UPDATE_PUBLIC_BASE_URL`, `REALTIME_XMPP_ENABLED=true`, `REALTIME_XMPP_CAPTURE=false`, `REALTIME_XMPP_ALLOWED_HOSTS=<host>`, `REALTIME_XMPP_DEV_CITY_MUC=false`.
5. Director values set: `PORT`, `MY_IP`, `PORT_RANGE_BEGIN/END`, `GAMESERVER_BINARY_PATH`, `METAGAME_API_KEY`, `SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP=3`, `GAMESERVER_READY_TIMEOUT_MS=30000`, `MAX_CONCURRENT_HUNT_SERVERS=3`, `SERVER_RUNTIME_AUTO_UPDATE=false`, `SERVER_RUNTIME_UPDATE_REQUIRED=false`.
6. Writes `ParadoxRuntime/deployment_config.generated.h` (`MP_PUBLIC_HOST`), `ParadoxLauncher/.env` (`VITE_API_BASE_URL`), and, if missing, a runtime-update Ed25519 key pair `ParadoxLauncher/.secrets/selfhost-runtime-update.*` (through `ParadoxLauncher/scripts/generate-runtime-key.mjs`).
7. Writes `versions/1.14.7/.selfhost/build-env.ps1` (`MYSTICPARADOX_API_BASE_URL`, `MYSTICPARADOX_RUNTIME_ENDPOINT`, `MYSTICPARADOX_RUNTIME_PUBLIC_KEY_B64` for the Tauri launcher build) and `.selfhost/tauri.selfhost.conf.json` (a CSP allowing the custom origin).
8. Prints next steps (game data, build the runtime, start Mongo/backend/Director, dot-source `build-env.ps1`, `npm run tauri -- dev --config ..\.selfhost\tauri.selfhost.conf.json`).

`.env` values are written in double quotes (UTF-8, no BOM). Values with quotes or newlines are rejected.

## Connects to

| Peer | How |
|---|---|
| [Runtime](runtime.md) | CatalogExporter compiles against `ParadoxRuntime/SDK` and `SDK.hpp`. RuntimeLoader loads `MysticParadox.dll`. `configure-selfhost.ps1` writes `ParadoxRuntime/deployment_config.generated.h`. |
| [Director](director.md) | Hunt export (`EXPORT_HUNTS`) feeds `npm run generate:hunt-tables`, which writes `ParadoxDirector/game-data`. |
| [Backend](backend.md) | Catalog, Slayer's Path and store exports feed generators in `ParadoxBackend` (`generate:slayers-path`, `reward-cache:generate`, `platinum:generate`, `ladyluck:enrich`, ...). `configure-selfhost.ps1` writes its `.env`. |
| [Paradox Launcher](paradox-launcher.md) | RuntimeLoader's `winmm.dll` is published as the `--extra` file of each runtime update. The self-host configurator reuses `generate-runtime-key.mjs` and writes `ParadoxLauncher/.env`. |
| Local files | `versions/1.14.7/Items_Analysis/` (gitignored export data; the generators read it there), `export_flags.txt`, `ExportPaths.local.h`, `mystic_loader.ini`, `versions/1.14.7/.selfhost/`. |

## Config

| Item | Where | Notes |
|---|---|---|
| `export_flags.txt` | `<root>\tools\CatalogExporter\` or the game's working dir | `KEY=0/1` lines (list above). |
| `MYSTICPARADOX_EXPORT_ROOT` | `ExportPaths.local.h` macro (compile time) | Output root. Not an env var. |
| `mystic_loader.ini` | game dir, beside `winmm.dll` | Extra DLLs to load. |
| `PARADOX_GAME_DATA_DIR`, `PARADOX_GAME_DATA_RAW_DIR`, `MYSTICPARADOX_CATALOG_PATH`, `HUNT_EXPORT_DIR` | env, read by the generators | Where the final files, the supplied sources, the catalog and the hunt export live. |
| `configure-selfhost.ps1` parameters | command line | Table above. |

## Gotchas

- **Client only.** The exporter's UFunction wrappers (`GetAllItems` and others) call `ProcessEvent` from its worker thread. Inject it into a local client, never a shared server. `EXPORT_SKINS_RESOLVE_STRINGTABLE` and `EXPORT_CURRENCY_NAMES` call live engine functions and are the riskiest.
- **Screens must be open before injecting.** Data tables load lazily. If a table is not in memory, the status file says it was not found. Open the screen and inject again.
- **Rebuild per game build.** Wrong SDK means wrong offsets and a crash. The build also needs the Dumper-7 SDK, which is not committed.
- **Existing flags file wins.** Adding a key to an old `export_flags.txt` does not keep the old default for the rest.
- **`ExportFlags.md` is partly stale.** It describes 1.12 file names. The code writes `_1_14_7`.
- **Exports are Phoenix Labs data.** Keep `Items_Analysis/`, the hunt tables and anything generated out of git.
- **`Items_Analysis` lives in `versions/1.14.7/`**, not the repo root. Point `MYSTICPARADOX_EXPORT_ROOT` there.
- **Loader picks by mtime.** If you keep both runtime names in the game dir, the newer file loads. Copying an old DLL over a newer one can change what loads. The launcher only verifies `MysticParadox.dll`. Remove the legacy name if you do not need it.
- **Do not list untrusted DLLs in `mystic_loader.ini`.** They run inside the game. Paths are not restricted to the game folder.
- **`configure-selfhost.ps1` writes secrets** (JWT private key, API keys, update signing key) into ignored files. Keep them out of git and out of screenshots. `-Force` regenerates the JWT pair and API keys (the runtime key is kept if it exists).
- **`configure-selfhost.ps1` targets the upstream Tauri `ParadoxLauncher`**, not the Electron `launcher/`, and defaults Mongo to 27017 without a replica set. Pass `-MongoDbUri` to match your mongod.
- **Server DLL auto-update uses a fixed public key** compiled into the Director. A self-host runtime key does not work there unless you edit the Director source. See [Director](director.md).
- **Build outputs are in the tree.** `tools/CatalogExporter/x64/` and `tools/RuntimeLoader/target/` hold local builds. Both are gitignored.

## See also

[Index](index.md), [Setup](setup.md), [Runtime](runtime.md), [Director](director.md), [Backend](backend.md), [Paradox Launcher](paradox-launcher.md), [Host scripts](host-scripts.md)
