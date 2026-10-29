# ParadoxBackend scripts and game data

> Verified against code 2026-10-24.

All paths are under `versions/1.14.7/ParadoxBackend/`. Scripts live in `scripts/`; the dev-account fixture is in
`migration-fixtures/`; generated game data lands in `game-data/`. Part of the [backend](backend.md); the Mongo
collections these scripts touch are described in [backend persistence](backend-persistence.md).

## Conventions

- **One database.** Scripts read the same `.env` as the backend (`MONGODB_URI`, `MONGODB_DB`). There is no staging DB, so a script run against `.env` hits live data.
- **Mongo scripts:** run with `tsx --env-file=.env scripts/<name>.ts` (or `node --env-file=.env` for `.cjs`). Most are dry-run by default and need `--apply` plus an exact `--confirm=<TOKEN>` to write. Several skip `GetPersistenceLifecycle().start()` on purpose so a dry run does no writes. A script that does call `start()` also runs `EnsureMongoIndexes()` (index builds plus startup backfills).
- **Game-data generators** read extracted game files under `<repo>/versions/1.14.7/Items_Analysis/` (CatalogExporter output, see [tools](tools.md)) or `game-data/raw/`, and write `game-data/*.json`. The backend reads those files at startup only, so a regenerated file needs a backend restart.
- **Dry run varies.** `generate_*.cjs` and `fetch_*.cjs` preview without `--apply`. `generate_*.ts`, `enrich_ladyluck_store.ts` and `generate_middleman_cells.cjs` always write.

## Mongo data scripts (run by hand)

| File | What it does | Writes to Mongo | Run / npm script | When |
|---|---|---|---|---|
| `scripts/backfill_cell_core_upgrades.ts` | Replays every past cell-core open (completed `inventoryTransactions` rows with a `+1` cell and `CURRENCY_CELLDUST`) through `RollCellCoreUpgrade`. Swaps rolled `+1` cells (`CELL_*_UC`) for their `+2`/`+3` version. All swaps for a character go through one `RunInventoryTransaction` with the fixed id `backfill-cellcore-20261023-<characterId>`, so a re-run cannot pay twice. Rolls are random, so each dry run prints different swaps. | `inventories` + an `inventoryTransactions` ledger row, only with `--apply` | `tsx --env-file=.env scripts/backfill_cell_core_upgrades.ts --user-id=<id> [--user-id=...] [--apply]` | One-off for cores opened before the +2/+3 rule (2026-10-23). |
| `scripts/bootstrap_admin.ts` | Adds the `admin` and `owner` roles to one password launcher account (looked up by `--username`, `--from-email` or `--email`), sets its email, `status: active` and `approvalStatus: approved`. The only way to grant `owner`. Refuses accounts without a username or password. | `accounts` (calls `start()`, so also index/backfill work) | `npm run admin:bootstrap -- --email=... [--from-email=... \| --username=...] --confirm=GRANT_ADMIN_ROLE` | First admin on a new database. See [security and admin](backend-security-admin.md). |
| `scripts/clone_account.ts` | Copies the dev account (`CLONE_SOURCE_USER`, default `mystpax`) into a new launcher account: new userId, new characterIds, argon2 password. Copies `accounts`, `characters`, `inventories`, `loadouts`, `breadcrumbs`, `encounteredContent`, `wallets`, `progressionTracks`, `progressionObjectives`, `playerJourney`. Insert-only; the source is untouched. | Inserts only | `npx tsx --env-file=.env scripts/clone_account.ts "<DisplayName>" "<email>" "<password>"` | Making a playable copy of the dev save. |
| `scripts/credit_challenge_rewards.ts` | Credits `CURRENCY_SEASONAL_COIN` for named, already-claimed season challenges that the old prestige gate refused, and marks each claim credited (`WithRewardCredit`), all in one transaction. Checks each bounty exists, is a season challenge, is claimed and has no credit yet. | `wallets`, `bountyStates` | `tsx --env-file=.env scripts/credit_challenge_rewards.ts --user-id=<id> --grant=<bountyId>:<amount> ... [--apply --confirm=APPLY_CHALLENGE_REWARD_CREDIT]` | One-off (2026-10-10). |
| `scripts/migrate_ace_chips.ts` | Converts every `CURRENCY_TOKEN_EXCHANGE_SPEED_UP` (Ace Chips) balance to `CURRENCY_CELLDUST` at 3 dust per chip. The update filter pins the read balance, so a concurrent change is reported as a conflict. Re-run is a no-op. | `wallets` | `tsx --env-file=.env scripts/migrate_ace_chips.ts [--apply --confirm=APPLY_ACE_CHIP_MIGRATION]` | One-off (2026-10-16), done. |
| `scripts/migrate_banner_instance_ids.ts` | Repairs `loadouts.persistent.banner` values that hold a `BN_*` catalog id instead of the banner's inventory instance id (`PlanBannerInstanceMigration` in `src/bannerInstanceMigration.ts`). Revision compare-and-set per loadout. Filters `--user-id`, `--character-id`. | `loadouts` | `npm run banner:instance-migrate -- [--apply --confirm=APPLY_BANNER_INSTANCE_ID_MIGRATION]` | Legacy-data repair. |
| `scripts/migrate_inventory_storage.ts` | Re-shapes inventory arrays to match `inventory_storage_policy.json` (`MigrateInventoryStorageArrays`): moves items between instanced and stacked and flags issues for review. Writes through `inventories.updateBothIfRevisionMatches`. `--report=<path>` writes a JSON report. | `inventories` | `npm run inventory:storage-migrate -- [--user-id=] [--character-id=] [--report=] [--apply --confirm=APPLY_INVENTORY_STORAGE_MIGRATION]` | After the storage policy changes an item's storage shape. |
| `scripts/migrate_launcher_approval.ts` | Launcher accounts with no `approvalStatus` become `pending`, except `--keep-user` and admins, who become `approved`. Prints up to 100 accounts in dry run. | `accounts` (calls `start()`) | `npm run approval:migrate -- [--apply --keep-user=<userId> --confirm=MOVE_LEGACY_LAUNCHER_ACCOUNTS_TO_PENDING]` | One-off when approval gating was introduced. |
| `scripts/migrate_loadout_slot_entitlements.ts` | Matches each loadout's `unlockedTotalSlots` and slot array to the character's Slayer's Path `LoadoutSlot_01..05` nodes (`ResolvePlayerJourneyTotalLoadoutSlots`). Missing slots are cloned from slot 0 with fresh metadata; existing slots are never deleted. Revision compare-and-set. | `loadouts` | `npm run loadout:slots-migrate -- [--user-id=] [--character-id=] [--apply --confirm=APPLY_LOADOUT_SLOT_ENTITLEMENT_MIGRATION]` | After loadout-slot rules change. |
| `scripts/migrate_reward_cache_currency.ts` | Moves `CURRENCY_S19_COIN` and `CURRENCY_REWARDCACHE` balances 1:1 into `CURRENCY_SEASONAL_COIN` (the 1.14.7 Reward Cache coin). One atomic update per wallet with every read balance pinned. `--report=` writes JSON. | `wallets` | `tsx --env-file=.env scripts/migrate_reward_cache_currency.ts [--user-id=] [--report=] [--apply --confirm=APPLY_REWARD_CACHE_COIN_MIGRATION]` | One-off (2026-10-08), done. |
| `scripts/reset_mastery.cjs` | **Destructive.** Deletes every `MasteryTrack_*` row in `progressionTracks` and every `MasteryObjective_*` row in `progressionObjectives`, for all accounts. Keeps `progressionObjectiveEvents`. `--apply` requires `--confirm=RESET_ALL_MASTERY` (exit 2 otherwise). | Deletes | `node --env-file=.env scripts/reset_mastery.cjs [--apply --confirm=RESET_ALL_MASTERY]` | Only with every player offline (game servers cache objective state). Used once (2026-10-14). |
| `scripts/export-discord-issues.cjs` | Reads the legacy `discord_issues` and `discord_issue_config` collections (from when the Discord bot ran inside the backend) and writes the bot's `issues.json`. Refuses to overwrite an existing file. | Read-only | `node --env-file=.env scripts/export-discord-issues.cjs <path to issues.json>` | One-off hand-over to `discord-bot/`. See [Discord bot](discord-bot.md). |
| `scripts/init-replset.cjs` | Runs `replSetInitiate` for a one-member replica set `rs0` on the given host (default `127.0.0.1:27018`) and waits up to 60 s for a writable primary. Safe to re-run. | Replica-set config only | `node scripts/init-replset.cjs 127.0.0.1:27018` | First start of a new `mongod`. Used by `deploy/install.ps1` ([deploy](deploy.md)). |
| `migration-fixtures/migrate_mysticparadox_bootstrap.cjs` | Checks the dev account (`DEV_USER_ID`, default `mystpax`) baseline (starter instanced items, unique 26-char instance ids, slot-0 loadout references, numeric wallet). Then, in one transaction, clears the legacy starter `itemData` and tags inventory, loadout and wallet with `bootstrapVersion: starter-1.12-v1`. Idempotent. | `inventories`, `loadouts`, `wallets` | `node --env-file=.env migration-fixtures/migrate_mysticparadox_bootstrap.cjs` | Fixture era, one-off for `mystpax`. |
| `migration-fixtures/dev_inventory.example.json` | Synthetic placeholder for the old dev starter inventory. Not loaded at runtime any more (`controllers/inventory.ts` says so). | - | - | Reference only. |

## Game-data generators

The backend reads these files through `src/gameData/loader.ts` (directory override `PARADOX_GAME_DATA_DIR`). The real
files are Phoenix Labs data and gitignored (`versions/1.14.7/.gitignore`: `ParadoxBackend/game-data/*.json` and
`game-data/raw/`); only `*.example.json` placeholders and `game-data/README.md` are committed.

| File | Reads | Writes | npm script | Notes |
|---|---|---|---|---|
| `scripts/generate_slayers_path.cjs` | `Items_Analysis/slayers_path_<1_14_7\|1_12>/player_journey_nodes.jsonl`, plus the existing `slayers_path.json` as base | `game-data/slayers_path.json` (timestamped `.bak` first) | `generate:slayers-path` | Dry run prints the diff. `--source=1_12` uses the 1.12 export. Copy `slayers_path.example.json` first on a fresh checkout. |
| `scripts/generate_slayers_path_definitions.cjs` | same export | `game-data/slayers_path_definitions.json` | none | Node rewards, costs and edges for `controllers/slayersPath.ts`. `--source=1_12` reproduces the old hand-written file. |
| `scripts/generate_progression_config.cjs` | `game-data/raw/progression_config.source.json` (or `PARADOX_GAME_DATA_RAW_DIR`), `Items_Analysis/progression_1_14_7/mastery-tracks.jsonl` and the XP tables | `game-data/progression_config.json` (`.bak` first) | `generate:progression-config` | Also adds `Linked_Slayer_Slot_1..3` (chests at 5/400/800/1600 XP) and hunt-pass slots `season43..50` (100 ranks x 100 XP; rewards filled at serve time from `hunt_passes*.json`). Read by `controllers/progression.ts`, `routes/progression.ts`, `routes/system.ts`, `controllers/wallet.ts`, `platinumWallet.ts`. |
| `scripts/generate_ladyluck_store.cjs` | `game-data/raw/ladyluck_store.source.json` | `game-data/ladyluck_store.json` (`.bak` first) | `generate:ladyluck-store` | Validates and normalizes a raw source array of store entries. `enrich_ladyluck_store.ts` instead rebuilds the file from the live 1.14.7 capture. |
| `scripts/enrich_ladyluck_store.ts` | catalog jsonl, `DauntlessEndpointDocumentation/Store/Product/Skus/ladyluckstore.json`, current `ladyluck_store.json` | `game-data/ladyluck_store.json` | `ladyluck:enrich` (then regenerates the storage policy) | Live 1.14.7 rotation at live prices. Skips SKUs whose items the catalog lacks. Keeps existing storage flags. |
| `scripts/generate_reward_cache_store.ts` | catalog jsonl | `game-data/reward_cache_store.json` | `reward-cache:generate` (then the storage policy) | Reconstructed Reward Cache, priced in `id_currency_seasonal_coin`. SKU ids keep the `season19_rewardcache_` prefix (purchase history keys on them). |
| `scripts/generate_platinum_store.ts` | catalog and `store_item_images` jsonl (1.12 export if present, else 1.14.7), endpoint captures, `game-data/wiki_store_prices.json`, `reward_cache_store.json`, `ladyluck_store.json` | `game-data/platinum_store.json` | `platinum:generate` (then the storage policy) | Tier A = captured price, Tier B = wiki price. Skips platform packs, loadout-slot SKUs and `prestige_*` rows. Avoids items the other two stores already sell, so build those first. |
| `scripts/generate_inventory_storage_policy.ts` | catalog jsonl, every `.ts`/`.json` under `src/` and `game-data/` | `game-data/inventory_storage_policy.json` | `inventory:storage-policy:generate` | Lists every catalog id the code or game data mentions, with `instanced`/`stacked`, `maxQuantity`, tags and the catalog SHA-256. Read by `src/inventoryStoragePolicy.ts` (the grant authority). |
| `scripts/generate_middleman_cells.cjs` | catalog jsonl | `game-data/middleman_cells.json` | none | Cell families with a `+1` (`_UC`) cell; read by `controllers/store.ts` for the Middleman's weekly offers. |
| `scripts/fetch_hunt_passes.cjs` | Dauntless fandom wiki API (network) | `game-data/hunt_passes.json` with `--apply` | none | Five 100-level Slayer Commission passes. Read by `src/huntPassRotation.ts`. |
| `scripts/fetch_cosmetic_passes.cjs` | wiki API, catalog jsonl | `game-data/hunt_passes_cosmetic.json` with `--apply` | none | Season, cosmetic and event passes, names matched to catalog ids. `--check <page> <truth json> <progression_id>` validates the matcher. Read by `src/huntPassRotation.ts`. |
| `scripts/fetch_wiki_store_prices.cjs` | wiki API, catalog jsonl | `game-data/wiki_store_prices.json` with `--apply` | none | Items the wiki says the Platinum store sold on their own, with price. Input to `generate_platinum_store.ts`. |
| `scripts/audit_tier1_catalog.cjs` | catalog jsonl, `inventory_storage_policy.json` | stdout JSON only | none | Read-only review queue: stackable catalog items missing from the policy, quantity mismatches, digest check. Exit 1 on mismatch. |
| `game-data/README.md` | - | - | - | Lists the seven required files, the smoke-test copy of `*.example.json`, and the generator order. |

Run order on a fresh checkout (from `game-data/README.md`): copy `slayers_path.example.json`, then
`generate:slayers-path -- --apply`, `generate_slayers_path_definitions.cjs --apply`,
`generate:progression-config -- --apply`, `generate:ladyluck-store -- --apply`, `reward-cache:generate`,
`platinum:generate`.

`game-data/` also holds files the README table does not list: `hunt_passes.json`, `hunt_passes_cosmetic.json`,
`middleman_cells.json`, `wiki_store_prices.json`, many `*.bak*` backups, and `raw/progression_config.source.json`.

## Build, test and rehearsal scripts

| File | What it does | npm script |
|---|---|---|
| `scripts/ensure-build-fresh.cjs` | Prestart guard: if any `src/**/*.ts` is newer than its `build/**/*.js` (or `package.json`/`tsconfig.json` is newer than `build/server.js`), runs one full `npm run build`. Exists because a stale build once served an old route for hours. | `prestart`, `prestart:api` |
| `scripts/run-tests.cjs` | Runs every `src/**/*.test.ts` with `node --import tsx --test`. Skips `*.gamedata.test.ts` when any of the seven required game-data files is missing. | `test` |
| `scripts/test_bootstrap_regression.cjs` | **Destructive integration test** of starter bootstrap and recovery. Refuses unless `ALLOW_DB_INTEGRATION_TESTS=true` and `MONGODB_TEST_DB` differs from `MONGODB_DB`; redirects the app's Mongo client to the test DB; uses `test_*` ids and asserts zero leftovers. | `test:bootstrap` (builds first) |
| `scripts/test_mongo_schema_migration_rehearsal.cjs` | Seeds a disposable DB (name must match `mysticparadox_guard_migration_it_*`), runs the compiled `EnsureMongoIndexes` from `build/`, and checks completed inventory ledger rows survive. Needs `ALLOW_DB_INTEGRATION_TESTS=true`. | `test:mongo-migration-rehearsal` |
| `scripts/test_mongo_schema_migration_rehearsal.test.cjs` | Unit test of the rehearsal script's refuse/cleanup paths with a fake `MongoClient`. | `pretest:mongo-migration-rehearsal` |
| `scripts/test_api_listener_failclosed.ps1` | Starts a throwaway `mongod` replica set, holds the HTTPS port, launches `build/server.js` with `NODE_ENV=production`, and asserts the API exits on the bind error instead of running half-up. Output under `local-evidence/test-output/`. | none (`-MongoDPath` required) |
| `scripts/encrypt_mongo_backup.cjs` | AES-256-GCM envelope (`MGC1` magic, nonce, tag, ciphertext) for a backup file: `encrypt\|decrypt --input --output --key-hex <64 hex>`. Prints sizes, SHA-256 and a key fingerprint, never the key. No caller in the repo. | none |

## Gotchas

- `reset_mastery.cjs` wipes mastery for everyone; it needs `--apply --confirm=RESET_ALL_MASTERY`.
- `bootstrap_admin.ts`, `clone_account.ts` and `migrate_launcher_approval.ts` call the lifecycle `start()`, so they also build indexes and run the startup backfills.
- Regenerating the platinum store before the Reward Cache and Lady Luck files exist fails (it reads both to avoid overlaps).
- Regenerated `game-data` needs a backend restart; the files are read once.
</content>
</invoke>
