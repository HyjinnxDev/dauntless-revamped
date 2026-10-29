# ParadoxBackend file reference

> Verified against code 2026-10-24.

Every source file of `versions/1.14.7/ParadoxBackend/` except `src/persistence/`, `src/realtime/`, `scripts/`
and `migration-fixtures/` (those are on [Backend persistence](backend-persistence.md),
[Backend realtime](backend-realtime.md) and [Host scripts](host-scripts.md)). All paths below are relative to
`versions/1.14.7/ParadoxBackend/`. Narrative and config: [Backend](backend.md). Auth and staff console:
[Security and admin](backend-security-admin.md). The [Route index](#route-index) at the end lists every HTTP route.

Conventions used in the tables:

- "Repos" are repositories from `GetRepositories()` (`src/persistence`); the collection names are in
  [Backend persistence](backend-persistence.md). "Collections" are collections a file opens directly with
  `GetMongoDb()`.
- `gs` means a request carrying a valid `x-mysticparadox-gameserver-apikey` (`AuthData.IsGameserver`).
- "game-data" files are read from `game-data/` (or `PARADOX_GAME_DATA_DIR`) by `src/gameData/loader.ts`.

## Root

| File | What it does |
|---|---|
| `package.json` | npm scripts (dev/build/start/tests/generators/migrations, listed on [Backend](backend.md#npm-scripts)). Runtime deps: express 5.2.1, express-rate-limit, mongodb 7.5, jsonwebtoken, @node-rs/argon2, pino + pino-pretty, ws, ltx, dotenv. Dev: tsx, typescript 6. |
| `tsconfig.json` | `tsc` from `src/` to `build/`: target es2022, CommonJS, strict, `resolveJsonModule`. Includes `src/**/*.ts` (tests too). |
| `.env.example` | Template for `.env`. Every name it carries is in the [Config table](backend.md#config). |
| `.gitignore` | Ignores `node_modules/`, `build/`, `dist/`, `launcher-logs/`, temp dirs and the migration snapshot fixture. |

## src (top level)

| File | What it does |
|---|---|
| `src/server.ts` | Process entry (`Main`). Runs `AssertRuntimeSafety`, accepts only the `combined` or `api` role, loads TLS (`PARADOX_CERT_PEM_PATH`, `PARADOX_KEY_PEM_PATH`, `PARADOX_KEY_PASSPHRASE`; production refuses to start without a cert), `AssertApiKeyHashSecret`, starts persistence, registers API keys (`DrainAndRegisterAPIKeys`, `DrainAndRegisterUserAPIKeys`), starts `partyOutboxDispatcher` and the P2P extension. Listens on HTTP `PORT` (3000) at `HTTP_HOST` (127.0.0.1) and HTTPS `HTTPS_PORT` (3443) with `initRealtime` attached; readiness `API_AND_HTTPS_RUNNING` (or `HTTP_ONLY_DEVELOPMENT` without a cert outside production). Starts the QoS pong listener on `QOS_PORT` (80) and `StartVoiceRelay(VoicePort())`. `GracefulShutdown` on SIGINT/SIGTERM (10 s forced exit); a listener error in production also shuts down with exit 1. |
| `src/app.ts` | Builds and exports `app`: request context, `/__origin/<host>` stripper (`isAllowedOriginHost`, apexes `steelyard.ca`, `steelyard.online`, `ol.epicgames.com`, `api.epicgames.dev`), optional origin body log (`MYSTICPARADOX_LOG_ORIGIN_BODIES=1`), extension early routes, JSON/urlencoded parsers, `[REQ]`/`[RES]` logger with HTTP metrics and optional `[BODY-CAPTURE]` (`MYSTICPARADOX_BODY_CAPTURE`), `GET /`, `/health/live`, `/health/ready`, the global rate limiter, every router (mount order in [Backend](backend.md#request-pipeline-srcappts-in-order)), `/admin` static files from `admin-ui/` with its CSP, extension routes, `launcherGuardRouter`, then the 404 handler (`Unstubbed route`, plus the `[TrialsSubmitProbe]` 200 for `leaderboard` origin hosts). Mounts `huntStatsRouter`. |
| `src/logger.ts` | `logger` (pino). Two pino-pretty targets: coloured console and a plain file at `../debug/metagame/metagame.log` relative to the working directory (truncated on each start). Level from `ResolveOperationalLogLevel("PRODUCTION")`; every line gets the request id. `ApplyDiagnosticsLogProfile(profile)` switches the level when the operations policy changes. |
| `src/validation.ts` | Pure body validators returning an error string or null: `ValidateInventoryTransactionBody`, `ValidateInstancedItemUpdateBody`, `ValidateLoadoutWriteData` (index 0..5 or `persistent`, JSON object up to 1 MiB), plus `InventoryBodyHasGrantOrSpend` (true when any add/remove array is non-empty). Limits: 256-char ids, 4096 items per array, quantity up to 1e9, 256 KiB item data. Used by `routes/inventory.ts` and `controllers/loadout.ts`. |
| `src/huntStats.ts` | `HuntStatsRow` and `ParseHuntStats(body)`: validates a hunt server's per-player damage post (id regex, 1-8 players, up to 16 behemoth names, amounts 0..1e9) plus the optional extras of 2026-10-26+ DLLs: hunt `seconds`, per player `weapon` (EWeaponType 0..10), `grade`, and `stats` (only keys in `HUNT_STAT_KEYS`, the game's combat telemetry). Used by `routes/huntStats.ts`; the rows are read by the Slayer's Ledger companion site. |
| `src/ramsRewards.ts` | Rewrites dedicated-server grants inside every inventory transaction (`ApplyRamsRewards`, called by `RunInventoryTransaction`): fountain core gives the game's key roll +2 (clamped 4-6, deterministic so the client DLL's `MpFountainCorePopupFix` shows the same) + 20 Platinum; `PlayerLoot` Rams remapped to 200-750; `patrol_chest` Rams to 1500-5000; +5% Rams per extra party member (max 4) on those two; `UBountyComponent::OnClaimBountyComplete` adds 250/400/600 Rams and 2/4/6 Platinum by tier; `BUNDLE_GATHER*` adds 10 (25 special/chest) Rams. Since 2026-10-23: `UpgradeCoreCells`/`RollCellCoreUpgrade`/`CELL_CORE_UPGRADE` turn one +1 cell per opened cell core into +2 (`_R`) or +3 (`_E`): Gold core always (1% of those +3), Silver 10%, Bronze 1%. The roll is seeded from the game's own +1 cells (`CellCoreRandom`: FNV-1a over `ID xN;` + mulberry32) so the client popup (`MpCellCorePopupFix`) replays it; keep both in step. `NoteRemovedBounties` (called by `controllers/bounty.ts`) remembers the tier of a bounty deleted in the last 10 s per user (in memory). Logs `[RamsRewards]`. |
| `src/bountyState.ts` | Pure rules for `/bounty/*` (the game server's bounty components). `ValidateBountySave`, `MergeBountyState` (one draft key = replace that group, never delete on an empty list; same instance merges monotonically: max progress, `claimed` sticky), `DeleteFromBountyState` (season challenges are never removed), `BountyStatePayload` (season 2020-08-23..2099-01-01), `BountyGroupCounts`, `InferBountyGroup`, `IsAuthorizedBountyWriter` (gs only) / `Reader` (gs or self). Season-challenge reward funding: `CHALLENGE_REWARD_CURRENCIES` (`CURRENCY_SEASONAL_COIN`, max 1000), `FindFundableSeasonClaim`, `WithRewardCredit`. Used by `controllers/bounty.ts`, `controllers/challengeRewards.ts`, `routes/system.ts`. |
| `src/cooldownState.ts` | Pure rules for `/cooldown/*`: `ValidateCooldownSave` (`{cooldowns:[...]}` or a bare array, max 256), `MergeCooldownState` (latest write per id wins, nothing removed, cap 1024), `CooldownStatePayload` (id -> ISO date map, the shape the client reads), `CooldownList`, `IsAuthorizedCooldownWriter` (gs only) / `Reader`. Used by `controllers/cooldowns.ts`, `routes/system.ts`. |
| `src/escalationProgress.ts` | Pure rules for `/escalation/*`: `IsAuthorizedEscalationWriter`/`Reader` (gs or self; a player-host runtime never writes), `MergeEscalationProgress` (level never drops, talents replaceable, omitted fields kept, version +1), `RecordToEscalationPayload`, `DefaultEscalationProgress`. |
| `src/gauntlet.ts` | Gauntlet seasons and level access. `GauntletSeason` (season = the two-week hunt pass season window, id `ESC_SEASON_<1..5>` cycling each season, so clears reset every two weeks; `GAUNTLET_SEASON` pins the number), `NormalizeGauntletLevel` (strips the 10000000 season prefix), `PartyLevelAccess` (weakest member's cleared level + 1), `GuildsUnlocking` (2+ guildmates in one clear; retail is 3), `GetGauntletProgress`, `GetPartyLevelAccess`, `RecordGauntletClear` (`$max` upserts; pays 1 `CURRENCY_GAUNTLET_COIN` Crest when a milestone level, `IsCrestMilestone` = 1 or every 5th, raises the player's season best). Collections: `gauntletClears` (`_id` `<season>:<account>`), `gauntletGuildClears`, reads `guildMembers`. Called by the Gauntlet handlers in `routes/system.ts`. |
| `src/huntPassRotation.ts` | Hunt pass seasons (since 2026-10-24): one pass per **two-week** season, changing Thursday 17:00 UTC from 2026-10-22 (season 0 = Frostfall). Season r carries cosmetic pass `cosmetic[r % 59]` for everyone (internal slot `SEASON_PASS_SLOT` = `season43`); a player who completes it gets the season's Slayer Commission pass `currency[r % 5]` (internal slot `COMMISSION_PASS_SLOT` = `season50`) until the season ends. Clients and game servers only ever see `season43` (the client's Challenges weeks follow season43's window); `season44`..`season49` are unused placeholders. `PassForSlot`, `HuntPassStorageId` (`huntpass:<r>:<passId>`, per season so a returning pass starts fresh), `IsHuntPassStorageId`, `LegacyHuntPassStorageMoves` (old `season43+j:<cosmetic[j]>` -> season j, `season50:<currency[0]>` -> season 0), `HuntPassMaxXp`, `HuntPassClaimOwed` (ranks and summed stacked rewards a claim owes from stored progress), `HuntPassOverflowPlatinum` (each 100 XP past the Commission pass end pays 25-50 Platinum; paid in `controllers/progression.ts` `GrantProgressionXp`), `HuntPassCurve` (100 XP per level), `ServedSlotFor` (season pass until complete, then Commission; `GAMESERVER_HUNTPASS_ID` pins), `BuildHuntPassPath(slot, now, clientSlot)` (free track pays 1000 Platinum over the first 15 levels when the pass had free platinum, plus Combat Merit drops), `HuntPassSkus(slot, clientSlot)` (Elite track listed as `season43_premium`, 1000 Platinum; entitlement `<passId>_premium` for cosmetic passes, `<passId>_<r>_premium` per season for Commission passes), `HuntPassEntitlement`, `ActiveSeasonWindow` (the two-week season), `HuntPassPathWindow` (published on the path: starts 10 weeks before the season so all 11 Challenges weeks are open, ends with the season), `HuntPassRotationIndex`. game-data: `hunt_passes_cosmetic.json`, `hunt_passes.json`. Running the file directly (`npx tsx src/huntPassRotation.ts`) runs its asserts. |
| `src/inventoryStoragePolicy.ts` | Per-catalog-id storage kind (stacked vs instanced) from game-data `inventory_storage_policy.json`, loaded on first use. `GetInventoryStoragePolicy`, `IsOwnershipUnlock`, `NormalizeInventoryGrantCollections` (moves wrongly-typed ADD entries, deterministic instance ids per transaction), `MigrateInventoryStorageArrays` (repair; used at read time by `controllers/inventory.ts` and by `scripts/migrate_inventory_storage.ts`), `GetInventoryStoragePolicyMetadata`. |
| `src/loadoutSlots.ts` | Loadout slot math: 1 default + 5 Slayer's Path slots (`LoadoutSlot_01..05`, only `node_status` 2 counts). `ResolveVisibleTotalLoadoutSlots`, `ResolveRequestedTotalLoadoutSlots` (monotonic), `ResolvePlayerJourneyTotalLoadoutSlots`, `ResolveActiveLoadoutIndex`, `ResolveWireLoadoutSlotCounts` (always account 0/0, character N/6; stops the client's endless `/unlock` loop). Used by `routes/loadout.ts`, `controllers/loadout.ts`. |
| `src/matchmakingParty.ts` | `ResolveMatchmakingParty` (an ISLAND request must name the authoritative party id, offline members are dropped; CITY keeps the party) and `LateJoinBlockReason` (join-in-progress gate: `NO_HUNT_STATE`, `STALE_HUNT_STATE` > 15 s, `FULL` at 4, `ENDING`, `NEARLY_DONE` below 20% HP). Used by `routes/matchmaking.ts`, `controllers/matchmaking.ts`. |
| `src/travelHost.ts` | `PickTravelHost(clientAddress, advertisedHost)`: 127.0.0.1 for the same machine, this host's own address on the same private range (10/8, 172.16/12, 192.168/16, 100.64/10 Tailscale) for LAN players, else the advertised public host. Used by `GET /candidate/status`. |
| `src/encryptionKeyStore.ts` | `EncryptionKeyStore` (in memory, 30 min TTL) for `/key/generate` and `/key/consume`: lookup by candidate id, then by the issuing bearer token, then the most recent key. `NormalizeEncryptionKeyToken`, `EncryptionKeyTokenFingerprint` (sha256 prefix for logs). Used by `routes/matchmaking.ts`. |
| `src/platinumWallet.ts` | Platinum is 13 `CURRENCY_PLATINUM*` buckets shown as one number. `PLATINUM_SPEND_ORDER` (promotional first), `IsPlatinumCatalogId`, `SumPlatinum`, `ResolvePlatinumSpend` (per-bucket debit plan or not-enough), `ProjectBalances` (every currency under `CURRENCY_X` and `id_currency_x`, platinum aggregate on top). Pure; used by `controllers/wallet.ts` and `GET /balance`. |
| `src/skuProgression.ts` | `ResolveProgressionGrant` turns a store SKU's `skuProgression` (`xp` or `ranks`) into one XP increment using the track's rank curve; `RankForProgress`. Pure; used by `controllers/store.ts`. |
| `src/slayerLinks.ts` | Pure Slayer Links rules (the wire contract is in its header comment). 3 slots, invites 24 h, links 168 h, chests at 5/400/800/1600 XP, a 12-prize pool drawn from `LINK_REWARDS` (incl. the Crown `AC_HEAD_CROWN`), rewards granted by the backend after the week (`SettleLink`). Exports `Status`, `InvitesList`, `LinksList`, `Invite`, `Answer`, `DeleteInvites`, `DeleteLink`, `SaveRewards`, `RewardsGrant`, `DrawPrizePool`, `UnlockChests`, `ChestsReached`, `SettleLink`, `Availability`, `HuntedTogether`. Mongo I/O is in `routes/slayerLinks.ts`; `controllers/progression.ts` uses `HuntedTogether`. |
| `src/characterSlots.ts` | Several characters per launcher account. Collection `characterSlots` (`_id` = the character's game userId, `ownerUserId`, `slot`, `label`, `nameStyle`, `lastLaunchedAt`); slot 1 is the account's own userId and may have no row. `MAX_CHARACTER_SLOTS` (default 2). `OwnerOf`, `ListSlots`, `InsertNextSlot`, `MarkLaunched`, `SetLabel`, `SetNameStyle`, `GameNameTagFor` (staff + name-style prefix), `ActiveCharacters`, `CleanLabel`, `LabelOf`, `RankForXp`, `NextSlot`, and `CharacterAwareFriendships` (wraps the friendship repo so edges live between owners; wired in `persistence/mongo/index.ts`). |
| `src/voiceRelay.ts` | Party/proximity voice relay over UDP (wire format in the header). `SignVoiceTicket`/`ValidateVoiceTicket` (RS256, audience `mysticparadox-voice`, 24 h), `VoicePort` (`VOICE_UDP_PORT`, 8791), `ParsePositionReport` (hub position packets HMAC'd with a `GAMESERVER_API_KEYS` key), `VoiceRelayState` (party members hear you anywhere, others within 40 m on the same hub; 60 packets/s; peers expire after 15 s), `StartVoiceRelay`, `SetVoiceBlocked` (in-memory ban list), `DefaultRelayDeps`. Details: [Backend realtime](backend-realtime.md). |
| `src/bannerInstanceMigration.ts` | `PlanBannerInstanceMigration`: plans the repair of `persistent.banner` rows that hold a `BN_*` catalog id instead of the owned instance id. Pure; used only by `scripts/migrate_banner_instance_ids.ts` (`npm run banner:instance-migrate`). |
| `src/*.test.ts` | node:test unit tests for the sibling module. Notable: `characterDelete.test.ts` needs a real replica set (`CHARACTER_TEST_MONGODB_URI`, else skipped); `foreverLauncher.test.ts` covers invite codes and the content routes; `publicMatchmaking.test.ts` drives `controllers/matchmaking.ts` against a fake Director; `bountyTokens.test.ts` covers `IsGameBountyTokenGrant`; `*.gamedata.test.ts` read real `game-data/` and are skipped without it. |

## src/config

| File | What it does |
|---|---|
| `src/config/runtimeSafety.ts` | `AssertRuntimeSafety(env)`: always refuses `MYSTPAX_*` keys and a bad `MYSTICPARADOX_SERVICE_ROLE`; with `NODE_ENV=production` also refuses `AUTH_MODE=NONE`, `ALLOW_NO_AUTH_DEV_MODE=true`, `MYSTICPARADOX_BODY_CAPTURE`, `MYSTICPARADOX_INV_CAPTURE_RAW`, `REALTIME_XMPP_DEV_CITY_MUC` not `false`, a blank or `combined` role, no `MYSTICPARADOX_METRICS_TOKEN` (api role), no `MONGODB_URI`, bad Mongo bounds or ports, and extension issues. Called first by `server.ts`. |
| `src/config/serviceRole.ts` | `ReadMetagameServiceRole`: `combined` (blank default) or `api`, plus roles an extension adds. |
| `src/config/mongoRuntime.ts` | `ReadMongoRuntimeConfig`: bounded `MONGODB_APP_NAME`, `MONGODB_CONNECT_TIMEOUT_MS`, `MONGODB_SERVER_SELECTION_TIMEOUT_MS`, `MONGODB_MAX_POOL_SIZE`, `MONGODB_MAX_IDLE_TIME_MS`, `MONGODB_TRANSACTION_MAX_COMMIT_TIME_MS`; throws on out-of-range values. Used by `persistence/mongo/client.ts` and `runtimeSafety.ts`. |
| `src/config/loggingPolicy.ts` | `ResolveOperationalLogLevel(profile)`: PRODUCTION uses `LOG_LEVEL` (only info/warn/error/fatal, else info); DEVELOPMENT uses `MYSTICPARADOX_DEVELOPMENT_LOG_LEVEL` (any pino level, default debug). |
| `src/config/*.test.ts` | node:test unit tests for the sibling module. |

## src/controllers

| File | What it does |
|---|---|
| `src/controllers/admin.ts` | Staff console core: `AdminLogin` (6 tries/15 min/IP; email or launcher username; staff rank and eligible; TOTP from `ADMIN_TOTP_SECRET`, 503 in production when unset), `AdminLogout`, `AdminMe`, `ListPlayers` (page, limit up to 100, approval/status/search filters), `UpdatePlayerAccess` (approval/status/timed ban; moderators only bans up to 168 h; reason 3+ chars; no self-lockout; `CanActOn`; revokes refresh sessions and unused exchange codes, closes XMPP sockets, `SetVoiceBlocked`), `UpdatePlayerRoles` (only `tester`/`moderator`/`admin`; dropping tester revokes unused exchange codes), `DeletePlayer` (typed `DELETE <name>` + reason, `repos.admin.deletePlayerData`), `ListAudit`. Sets cookie `mysticparadox_admin` (Path `/admin/v1`, 8 h). Repos: admin, launcherAccounts, refreshSessions, gameExchangeCodes. |
| `src/controllers/adminDiscordAuth.ts` | Staff "Sign in with Discord": PKCE, HMAC-bound state plus browser-binding cookie `mysticparadox_admin_oauth` (5 min), Discord id must be in `ADMIN_DISCORD_ALLOWED_IDS`; creates an `admin` account or promotes an eligible linked one (audited), then issues an admin session and redirects to `ADMIN_FRONTEND_URL`. Env: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `ADMIN_DISCORD_REDIRECT_URI`, `ADMIN_FRONTEND_URL`, `ADMIN_COOKIE_SECURE`. Calls discord.com. Repos: discordOAuthTransactions, authIdentities, launcherAccounts, admin. |
| `src/controllers/adminOperations.ts` | `GetOperationsOverview` (policy + latest 100 `launcherGuardSessions`), `VerifyOperationsStepUp` (TOTP from `ADMIN_OPERATIONS_TOTP_SECRET` or `ADMIN_TOTP_SECRET`, 6 tries/15 min), `UpdateOperationsPolicy` (versioned, reason 8+ chars, step-up for weakening, transaction + audit, then `ApplyDiagnosticsLogProfile`). |
| `src/controllers/adminServers.ts` | Servers page. Proxies the Director at `http://$DEPLOYSERVER_URL/api/admin/*` with header `x-api-key` = first key of `GAMESERVER_API_KEYS`. A 15 s sampler (started at import) keeps 24 h of CPU/memory/players/servers in memory and appends `host-metrics.csv` to `ADMIN_LOG_DIR`. Lists node/mongod/game processes through PowerShell `Get-CimInstance`; checks elevation with `net session`. Exports `GetServersOverview` (also account counts), `GetServersHistory`, `StopGameserver`, `GetGameserverLog`, `RestartStack` (spawns `ADMIN_RESTART_SCRIPT` detached, `-DirectorOnly` for the Director; 409 unless elevated), `GetLog` (`backend`/`director`/`director-build`/`restart` `.log` in `ADMIN_LOG_DIR`), `ListOnlinePlayersDetailed`, `GetPlayerDetail`. Collections: accounts, characterSlots, characters, wallets, guildMembers, guilds, friendships, entitlements, progressionTracks, refreshSessions. |
| `src/controllers/apikeys.ts` | Gameserver API keys. `ParseConfiguredGameserverAPIKeys`, `SynchronizeConfiguredGameserverAPIKeys` (a non-empty `GAMESERVER_API_KEYS` replaces every stored hash), `DrainAndRegisterAPIKeys` (boot; otherwise drains the keys-to-register list), `IsValidGameserverAPIKey` (reads all hashes per call). Repo: apiKeys. |
| `src/controllers/auth.ts` | Game JWT and store tokens, keys from `AUTH_SIGNING_PRIVKEY_B64`/`AUTH_SIGNING_PUBKEY_B64`. `SignMetagameJWTForUid`/`ValidateMetagameJWTAndGetPayload` (RS256, issuer and audience `paradox-backend`, 24 h), `SignStorePurchaseToken`/`ValidateStorePurchaseToken` (issuer `mysticparadox-store`, audience `mysticparadox-store-purchase`, 10 min; Lady Luck aliases), `DrainAndRegisterUserAPIKeys`, `GetUserIDForAPIKey` (for `AUTH_MODE=APIKEY`). |
| `src/controllers/bounty.ts` | `GetBountyState`, `SaveBountyState`, `DeleteBounties`: version-checked writes (8 tries) through a `PerAccountQueue`. A successful delete calls `NoteRemovedBounties` so the next claim grant can be paid by tier. Repo: bountyStates. |
| `src/controllers/challengeRewards.ts` | Season-challenge coin funding: `IsChallengeRewardGrant`, `FundChallengeReward` (charges one claimed, uncredited season challenge inside the inventory transaction), `WaitForFundableSeasonClaim` (polls up to 1.5 s, used by `POST /inventory`). Repo: bountyStates. |
| `src/controllers/character.ts` | Game character documents (`characters` collection). `GetCharactersForUid`, `CreateCharacterForUid` (character + starter manifest in one transaction via `SeedNewAccountAtomically`), `UpdateCharacterForUid` (version check; gs writes force through on conflict; monotonic progression guard; restores the Training Dojo quest series from the Player Journey), `GetCharacterWithUid`, `IsFreshOnboarding`. Normalizes character data (forces onboarding complete, default appearance and flags). Also a `[QuestDiff]` log line for every changed `SERIE_*` key (Aether Winds diagnostic). Repos: characters, playerJourney. |
| `src/controllers/characters.ts` | Launcher character list (`/launcher/v1/characters*`): `ListCharacters` (level from `MasteryTrack_PlayerLevel`), `CreateCharacter` (5/h), `RenameCharacter` (20/h), `SetCharacterNameStyle` (30/h, owners only), `DeleteCharacter` (5/h; not slot 1; label must be typed; not online; not a guild leader; `repos.admin.deleteCharacterSlot` with audit). Announces a character switch to friends. |
| `src/controllers/cooldowns.ts` | `GetCooldownState`, `SaveCooldowns` (version-checked, `PerAccountQueue`). Repo: cooldownStates. |
| `src/controllers/discordAuth.ts` | Launcher Discord sign-in: `StartDiscordAuth` (PKCE, 5 min state), `HandleDiscordCallback` (creates a pending account with `usernameSet: false` for a new Discord user, returns a deep link `<LAUNCHER_DEEPLINK_SCHEME>://...` with a 60 s completion code), `CompleteDiscordLogin` (launcher session). Env: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `LAUNCHER_DEEPLINK_SCHEME`. |
| `src/controllers/entitlements.ts` | `GetEntitlementsForUser` (`{activatedDate, duration, name}` sorted), `DoesUserHoldEntitlement`, `GrantEntitlementsInTransaction` (idempotent, refuses unsafe names). Repo: entitlements. |
| `src/controllers/escalationProgress.ts` | `GetEscalationProgress`, `SaveEscalationProgress` (version-checked, 8 tries). Repo: escalationProgress. |
| `src/controllers/guild.ts` | Guilds (port of the 1.4.4 controller). Error codes `GUILD_CODE` (the client's `EGuildRequestError` strings), name rules (4-15 chars, profanity/reserved lists, `GUILD_NAME_DENYLIST`, `GUILD_RESERVED_NAMES=0` turns reserved names off), `GetOwnGuild`, `ListOwnGuildInvites`, `ValidateGuildCreate` (stores a 15 min in-memory ticket), `CreateGuild` (a gs create needs the leader's matching ticket; `GUILD_CREATE_ACTIVITY_FALLBACK=1` accepts any recent one), `DisbandGuild`, `InviteToGuild`, `AcceptGuildInvite`, `DeclineGuildInvite`, `LeaveGuild`, `KickGuildMember`, `ChangeGuildRank`, `IsGuildMember`. `GUILD_MAX_MEMBERS` (100), `GUILD_INVITE_TTL_DAYS` (7). Collections: guilds, guildMembers, guildInvites. No transactions. |
| `src/controllers/inventory.ts` | Inventory. `RunInventoryTransaction` (idempotent by `transactionId` + canonical request hash in the `inventoryTransactions` ledger; storage normalization; `ApplyRamsRewards`; wallet deltas via `ApplyCurrencyDeltas`; optional `onGrant` for store entitlements/progression; revision-checked write; drops game bounty-token grants), `GetInventoryForUserIdAndCharacterId` (ownership check, starter bootstrap repair, storage repair, banked daily `TOKEN_BOUNTY_DRAFT`: `BankedBountyTokens` adds `BOUNTY_TOKENS_DAILY` = 10 per UTC day up to `BOUNTY_TOKENS_BANK_CAP` = 50 (never lowers a stack; the first bank per character tops up to 50 as a make-good), tracked per character as cooldown `mp_bounty_token_bank:<characterId>`, log `[BountyTokens]`, wallet merged into stacked items), `UpdateInstancedItem`, `MintInstanceId` (26-char base32 for placeholder ids), errors `InsufficientStackedItemError`, `InventoryTransactionConflictError`, `InventoryTransactionMismatchError`. Repos: inventories, inventoryTransactions, cooldownStates, parties. |
| `src/controllers/launcherAuth.ts` | Launcher accounts. `RegisterAccount` (5/h/IP; username 3-16 letters/digits; a valid `LAUNCHER_INVITE_CODES` code approves at once and may skip email; else pending with no tokens), `LoginWithPassword` (10/5 min per IP and per email), `RefreshSession` (30-day rotating refresh tokens, reuse kills the family), `Logout`, `LogoutAll`, `RequestGameExchangeCode` (10/5 min; eligibility, runtime channel and artifact set, `TARGET_CHANGELIST`, `APPROVED_EXECUTABLE_SHA256`, chosen character slot not blocked by another online slot; stores a 60 s code; returns `voiceTicket`, `voicePort`, `gameUserId`), `CheckUsernameAvailable`, `SetUsername`, `GetAccountView`, `CreateSessionForUser`. Repos: launcherAccounts, refreshSessions, gameExchangeCodes, authIdentities. |
| `src/controllers/launcherGuard.ts` | Launcher Guard sessions: `StartLauncherGuard` (needs the current published Guard manifest and a minimum launcher version; Ed25519 public key; 5 min session, 15 s heartbeat), `SubmitLauncherGuardHeartbeat` (signed signals, sequence + challenge chaining, risk score 0-100, `HEALTHY`/`DEGRADED`), `GetLauncherGuardStatus`. Records only; it never blocks a launch. Repo: launcherGuard (`launcherGuardSessions`). |
| `src/controllers/launcherPolicy.ts` | `GetLauncherPolicy`: channel `beta` for testers else `stable`, `guardEnforcement`, `diagnosticsProfile`, `managedFeatureIds` (`diagnostics.verbose` only for tester/admin while DEVELOPMENT is active), `logUpload.auto`, plus extension fields. |
| `src/controllers/loadout.ts` | Loadouts. `GetLoadoutStateForUserIdAndCharacterId`, `GetAllLoadoutsForUserIdAndCharacterId`, `GetPersistentLoadoutForUserIdAndCharacterId`, `GetActiveLoadoutIndexForUserIdAndCharacterId`, `EnsureTotalLoadoutSlots`, `SetLoadoutDataForUserIdAndCharacterId` (`ValidateLoadoutWriteData`), `SetActiveLoadoutIndexForUserIdAndCharacterId`, `FillEmptyPlayerRoles` (serves an owned Omnicell when a slot has none). Runs the starter bootstrap repair first. Repos: loadouts, inventories. |
| `src/controllers/login.ts` | `GetUsernameForUserId` (launcher display name, else the legacy account name, else the id) and `GetDisplayNameForUserId` (adds the staff/name-style tag). |
| `src/controllers/matchmaking.ts` | Travel and hunts, all state in memory (`MatchmakingResultMap`, `PartyInstanceMap`, hub game-session ids). `HandlePlayerMatchmaking` (`MATCHMAKING_MODE` `DEPLOYSERVER` or `DISABLED`; extension may route the hunt; public hunts join a running one via the Director's `/api/matchmaker/join-public-hunt` or launch; private and party hunts launch via `/api/matchmaker/handle-matchmaking-for-player`; party fan-out reuse window 120 s), `CheckAndUpdateQueueStatus` (Go Now release delay `HUNT_GO_NOW_MIN_DELAY_MS`..`MAX`, default 10-20 s), `GetCandidateStatusPeriodMillis`, `GetPartyInstance`, `GetPlayerCandidate`, `FetchLiveHubStatus` (`/api/hub-status`), `FindLateJoinOffer`/`GrantLateJoin` (`/api/hunt-status?port=`), `CancelPlayerMatchmaking`, `WasCancelledSince`. Director calls carry no key. |
| `src/controllers/party.ts` | Parties in Mongo with revisions and the party outbox (max 4 members, invites 10 min). `GetPartyForPlayer`, `GetPartyById`, `GetOrCreateParty`, `InviteToParty`, `GetInvitesForPlayer`, `LeaveParty`, `AcceptInvite`, `KickMember`, `PromoteMember`; retries revision conflicts. Repo: parties (unit of work). |
| `src/controllers/perAccountQueue.ts` | `PerAccountQueue.run(key, work)`: serializes async work per key (bounty and cooldown saves). |
| `src/controllers/progression.ts` | Progression tracks and the Player Journey. `GrantProgressionXp` (approved tracks only, idempotent per grant id in `progressionGrants`; reforge `PrestigeTrack_Weapon_*` XP also pays Aetherhearts `CURRENCY_PJM_PRESTIGE_FILLED`; Slayer Link XP feeds a tenth to the hunt pass; hunt pass XP also fills hunted-together link tracks; levels past the Commission pass end pay platinum, `PayHuntPassOverflow`, log `[HuntPassOverflow]`), `GetTrackCurve`, `ProgressionStorageId` (internal hunt pass slot -> per-season storage id), `GetServedSlotForUser`, `RememberClientSlot`/`GetClientSlotForUser` (in-memory slot the player's client loaded at its last `/progression/config`; shown progress, rank confirms and `CommissionClaimStackedItems` follow it so completing the season pass mid-session does not look like a reset to 0; XP grants still go to the served slot; restart falls back to the served slot), `ResolveProgressionTrackId` (`selected_huntpass` and every hunt pass slot id resolve to the player's served slot; grants and rank confirms for `season43` land on the pass the player is on), `GetPersistedProgressionForUser` answers `season43` with the loaded pass's row, `CommissionClaimStackedItems` (a `season43 Claim Rewards` grant for a player on the Commission pass pays that pass and any season-pass ranks left unclaimed, not the game server's season-pass items; compare-and-set on confirmed ranks, log `[CommissionClaim]`), `ConfirmPublicProgressionRank`, `GetPersistedProgressionForUser`, `CaptureProgressionObjectiveEvent`, `GetPersistedObjectivesForUser`, `IsAuthorizedProgressionReporter`/`Reader`, encountered content, breadcrumbs, `GetPlayerJourney`/`SavePlayerJourney`/`MergePlayerJourneyNodes`, `IsCharacterOwnedByUser`. game-data: `progression_config.json`. Repos: progressionTracks, progressionGrants, playerJourney, breadcrumbs, encounteredContent; collection slayerLinks. |
| `src/controllers/slayersPath.ts` | Slayer's Path node rewards from game-data `slayers_path_definitions.json`: `GetNodeDefinition`, `GetNodeRewardItemIds`, `IsNodeUnlocked`, `GetUnlockedNodeIds`, `ComputeNewlyUnlockedNodeIds`, `GrantSlayersPathRewards` (reconciles every unlocked node against inventory with stable transaction ids; never charges costs, the client already pays them). |
| `src/controllers/starterManifest.ts` | New-player bootstrap: `BuildStarterManifest` (23 instanced Recruit items incl. weapon parts and Omnicell, 14 stacked, one loadout slot, `BOOTSTRAP_VERSION`), `GenerateStarterInstanceId`, `BuildStarterLoadoutSlot`, `SeedNewAccountAtomically` (character creation), `EnsureStarterBootstrapRecords`/`...InTransaction` (repairs a missing inventory/loadout and missing default parts on read), `CharacterOwnershipError`. Repos: characters, inventories, loadouts, wallets. |
| `src/controllers/store.ts` | SKU registry by store tag: hunt pass Elite SKU (`season43_pass` only; `GetStoreSkus(tag, servedSlot)` and `PurchaseStoreSku` return the Elite of the pass the player is on, `IsHuntPassSkuTag`), `exchange_vendor_slot_2/3`, `ladyluckstore`, `season_store` (Reward Cache + house `AETHERSPARK_SKUS`: 100 Aethersparks for 2000 / 500 for 8000 Cache Coins, `COMBAT_MERIT_CACHE_SKUS`: 250/1000 Combat Merits for 1500/5000, `AETHERDUST_CACHE_SKUS`: 120/600 Aetherdust for 1800/8000), `webstore`/`dyes`/`hp_level_skip_rank`/`huntpass_store` (platinum; `webstore` + house `BOUNTY_TOKEN_SKUS`: 5/14/32 Bounty Tokens for 100/250/500, `COMBAT_MERIT_PLATINUM_SKUS`: 250/1000 Combat Merits for 100/350, `AETHERDUST_PLATINUM_SKUS`: 120/600 Aetherdust for 100/400), `fountain_daily_free_bundle` (coin toss, rebuilt per read), `weekly_cell_offering` (Middleman cells + `RamsExchangeSku` 150 Aetherdust -> 1500 Rams, daily rotation from 18:00 UTC). `gauntlet_store` (Research Lab: 21 trackers + all 5 seasons' 15 +1 cells, 1 Crest `id_currency_gauntlet_coin` each; no Last Chance or bundles). `GetStoreSkus`, `FindStoreSkuByIdOrCatalogId`, `PurchaseStoreSku` (deterministic transaction id for one-time SKUs, runs `RunInventoryTransaction` with entitlement/progression `onGrant`), `PurchaseLadyLuckSku`, `OneTimeSkuOwned`, `FountainClaimedToday`, `PricesForCurrency`, `CurrencySlug`, `GetNotesForUser`. game-data: `ladyluck_store.json`, `reward_cache_store.json`, `platinum_store.json`, `middleman_cells.json`. |
| `src/controllers/wallet.ts` | Currencies (`wallets`). `STARTER_WALLET` (5000 Rams, 50 of each PJM merit...), `GetWallet` (creates with the starter grant on first read), `GetBalance`, `AddCurrency` (atomic, never negative), `ApplyCurrencyDeltas` (platinum split, prestige gate, challenge-reward funding), `IsPrestigeGatedReward`/`IsPrestigeSourceTrack` (Aetherhearts need banked `PrestigeTrack` progress from `progression_config.json`), `MergeWalletIntoStacked`, `BuildBalanceDict`, errors `InsufficientBalanceError`, `InsufficientPrestigeProgressError`. Repos: wallets, progressionTracks. |
| `src/controllers/*.test.ts` | node:test unit tests. `storeRegistry.gamedata.test.ts` checks SKU data against real `game-data/` (skipped without it); `matchmakingCancel.test.ts` covers `CancelPlayerMatchmaking`. |

## src/routes

Each file exports one Express `Router`, mounted at `/` in `src/app.ts`. The exact routes are in the
[Route index](#route-index).

| File | What it does |
|---|---|
| `src/routes/system.ts` | The catch-all for small game services: status/heartbeat/crash-reporter stubs, mailbox (`/survey/config`, `/all/`, `/patchnotes/*`), trials leaderboard stubs, entitlements, cohorts, escalation, `/progression/config` (served through `WidenHuntPassWindows`: a player's `season43` carries their served pass in the current season window and every other slot gets a 2099 placeholder window; the game server's config has `season43` + `season50` current; other pass windows clamped to ended; `GAMESERVER_WIDEN_HUNTPASS_WINDOWS=0` serves it raw, `GAMESERVER_RECENT_SEASONS` overrides the placeholder list), Gauntlet host routes (only for a `gauntlet` origin host, else `next()`), `/huntpass/:userId`, cooldowns, bounties. Env: `COHORT_TREATMENT_LEGACY` (default 1), `MYSTICPARADOX_BOUNTY_PERSISTENCE`, `MYSTICPARADOX_COOLDOWN_PERSISTENCE`. game-data: `progression_config.json`. Exports `WidenHuntPassWindows` (also used by `routes/progression.ts`). |
| `src/routes/login.ts` | Account info, tags, game session echo, migration stubs, `/isbanned` stub. `/login` requires `body.email` to equal the token's userId. |
| `src/routes/eos.ts` | EOS account API. `POST /account/api/oauth/token` implements `AUTH_MODE` (`LAUNCHER`: consume the launcher exchange code, re-check build, eligibility, runtime channel and hash; `APIKEY`; `NONE` dev only) and the `client_credentials` service token; display-name and bulk account lookups add the staff/name-style tag. Env: `AUTH_MODE`, `ALLOW_NO_AUTH_DEV_MODE`, `DEV_USER_ID` (`dev-user`), `DEV_USER_NAME`, `TARGET_CHANGELIST`. |
| `src/routes/character.ts` | `GET/PUT/POST /character`. Resolves the hub's no-player requests to `GAMESERVER_NO_PLAYER_USER_ID`/`DEV_USER_ID`; a conflicting client save gets the exact 1.12 HTML 409 page the client expects. Experiment flags (all default off): `GAMESERVER_CHARACTER_EMPTY_ID`, `GAMESERVER_CHARACTER_EMPTY_LIST` (only for gs-key requests with no bearer), `GAMESERVER_CHARACTER_DECODE_NESTED`, `GAMESERVER_CHARACTER_DATA_OBJECT`, `GAMESERVER_CHARACTER_SINGLE_OBJECT`. |
| `src/routes/inventory.ts` | Inventory reads and transactions. `POST /inventory`: validation, gs-only grants/spends, Commission pass claims swapped for `CommissionClaimStackedItems` (players may only save owned items), extension authorization for player-host runtimes, waits for a season-challenge claim before a coin grant, maps errors to 409 (`Insufficient balance`, prestige, stacked item, conflict, mismatch). Passes `body.source` to the transaction only for dedicated servers. `[INV-CAP]` and `[GrantMon]` diagnostics. |
| `src/routes/store.ts` | Store service: balances (the full currency dict with platinum aggregated), SKU listings by `requiredTags` (fountain hidden after today's claim, Middleman exchange greyed after a buy), purchase token mint (`/token/:currency/:catalogId`, binds user, character, store, SKU) and redeem (`/notification/:currency?token=`, 204 on success, 402 insufficient balance). |
| `src/routes/guild.ts` | Guild routes on `controllers/guild.ts`. `PlayerOnly` rejects gs-key requests; only `POST /guild` accepts a game server (leader from the body). |
| `src/routes/tuning.ts` | Static `/game_tuning/*` payloads (event schedule, hunt pass XP config, island content, bounty game data). Base bounty data carries grant windows (`BountyGrantWindows(Now)`: 2026-01-01 to 1 January two years ahead, rolling) the bounty component needs for season dates; `routes/tuning.test.ts` checks they always end at least a year out. |
| `src/routes/matchmaking.ts` | Candidate lifecycle: regions (`QOS_TARGET_URL`), UDP encryption keys (`EncryptionKeyStore`), `/candidate/status` (picks the travel host with `PickTravelHost`, re-verifies Ramsgate against the Director's live hub status, buildId from `TARGET_CHANGELIST`), `/candidate/join` (party resolution, private flag, Gauntlet level), cancel, `/QoS` pong. |
| `src/routes/party.ts` | Party service routes. `POST /party` reflects the party's shared hunt state. `/mystic/party/hunt-offer` and `/mystic/party/join-hunt` are the runtime's join-in-progress popup, authenticated by the voice ticket in `x-mystic-ticket`. |
| `src/routes/progression.ts` | Encountered content, objectives (`GAMESERVER_OBJECTIVES_AS_CONFIG=1` serves the paths config instead), breadcrumbs, XP grants (grant id from `x-mysticparadox-grant-id` or `idempotency-key`, else random), objective reports, rank confirm, reforge reset (`DELETE` on `ExperienceTrack_Weapon_*`) then banked XP apply (`POST /progression/purchase/...`, 1..3500 XP, the weapon's XP past rank 20), Player Journey (`/pjm`, grants Slayer's Path rewards on gs saves and reads), tracked-objectives stubs. game-data: `progression_config.json`, `slayers_path.json`. |
| `src/routes/loadout.ts` | Loadout reads and writes. Unlock requests are gs-only and reconcile the slot count from the Player Journey; repeated unlocks are counted and warned about. |
| `src/routes/friends.ts` | Epic friends service on the Mongo friendship graph: list (`?includePending=true`), invite/accept (POST), reject/remove (DELETE), with XMPP friend events (`PushFriendEvent`) and a presence swap on accept. Two characters of one owner cannot friend each other. Blocklist, recent players and settings are stubs. |
| `src/routes/slayerLinks.ts` | Mongo I/O for `src/slayerLinks.ts` (collection `slayerLinks`, `purgeAt` TTL). Reads settle links (draw pools, unlock chests, grant prizes via `RunInventoryTransaction` with a stable id). A link with XP cannot be deleted before its week ends. Resets `Linked_Slayer_Slot_<n>` tracks on accept. No transactions. |
| `src/routes/huntStats.ts` | `POST /mystic/hunt-stats` (gs only): bulk upserts `huntStats` rows `_id` `<hunt>:<userId>`, 204. |
| `src/routes/launcherAuth.ts` | `/launcher/v1/*` account routes on `controllers/launcherAuth.ts`, `characters.ts`, `discordAuth.ts`, `launcherPolicy.ts`. Owns the launcher CORS allow-list (`http://localhost:1420`, `https://tauri.localhost`, `LAUNCHER_ALLOWED_ORIGINS`) for every `/launcher/` path. Register answers 202 (pending) or 200 (invite). |
| `src/routes/launcherUpdates.ts` | Signed update distribution from `LAUNCHER_UPDATE_ROOT` (default `./updates`). Runtime manifests/downloads (`stable` public, other channels need a tester launcher session), extra runtime files (`RUNTIME_EXTRA_FILES`), Guard manifests (Ed25519, key id `runtime-2026-01`, embedded public key), publisher uploads (IP in `UPDATE_PUBLISHER_ALLOWED_IPS`, `x-update-api-key` = `UPDATE_PUBLISHER_API_KEY`, `x-update-signature` Ed25519; immutable versions), a serving switch (`serving.json`), and the Tauri launcher updater. Download URLs use `UPDATE_PUBLIC_BASE_URL`. Rate limits 180/min downloads, 30/min publishes per IP. Exports `GetPublishedGuardManifest` (used by `controllers/launcherGuard.ts`), `segment`, `validateGuardManifestWindow`, `AllowedRuntimeExtraFiles`. |
| `src/routes/launcherGuard.ts` | `/launcher/v1/guard/*` on `controllers/launcherGuard.ts`; mounted last in `app.ts`. |
| `src/routes/content.ts` | Game file distribution for the launcher: `GET/HEAD /content/v1/manifest` (public; `GAME_CONTENT_MANIFEST` JSON, plus `downloadBaseUrl` from `GAME_CONTENT_DOWNLOAD_BASE_URL`, https only) and `GET /content/v1/files/<path>` (launcher session; only manifest entries from `GAME_CONTENT_DIR`, strong ETag = sha256, Range resume). Read once; restart after changes. |
| `src/routes/news.ts` | `GET /content/v1/news` and `/content/v1/news/image/:id`: pass-through to the Discord bot's HTTP API at `DISCORD_BOT_URL` (unset = 404). Keeps the last list if the bot is down; images up to 8 MB, png/jpeg/webp/gif. |
| `src/routes/launcherCard.ts` | The server card in the launcher's server list: public `/launcher/v1/info` (title, MOTD, logo path, `playersOnline`) and `/launcher/v1/info/logo`; owner-only `/admin/v1/launcher-card*` edits (title up to 48, MOTD up to 300, PNG/JPEG/WebP logo up to 2 MB, audited) and the invite link builder (`dauntless-revamped://join?...` + GitHub Pages join page; fingerprint from the certificate at `PARADOX_CERT_PEM_PATH`, code from `LAUNCHER_INVITE_CODES`). Collection `launcher_card` (one document `card`), cached in memory. |
| `src/routes/launcherLogs.ts` | `PUT /launcher/v1/logs/sessions/:launchSessionId/:fileName`: tester-only upload of launcher/runtime session logs to `LAUNCHER_LOG_STORAGE_DIR` (default `../MysticLauncherLogs`). Fixed file names, 10 MB per file, 200 MB and 200 sessions per account, 120/h per account and 300/h per IP. Exports `LOG_STORAGE_ROOT`. |
| `src/routes/adminLauncherLogs.ts` | Read-only listing (`?since=`) and download of uploaded launcher logs for `scripts/sync-launcher-logs.mjs`. Auth: `x-sync-token` = `LAUNCHER_LOG_SYNC_TOKEN` (timing-safe). |
| `src/routes/crashReports.ts` | `PUT /crash/v1/reports/:id/:fileName` from the runtime's crash reporter (no auth): `report.json` (512 KB), `minidump.dmp` (32 MB), `context.xml` (2 MB) into `CRASH_REPORT_STORAGE_DIR` (default `../MysticCrashReports`), 90/h per IP, 2000 reports max (507 when full). Writes `summary.txt`. With `GITHUB_CRASH_REPO` + `GITHUB_CRASH_TOKEN` opens one GitHub issue per crash signature (`issues.json` index; repeats comment, a closed issue reopens with `regression`; 50 new/h, 200 comments/h). |
| `src/routes/admin.ts` | `/admin/v1/*` staff API. Origin gate (same origin, or `ADMIN_ALLOWED_ORIGINS`; dev default `http://localhost:4173`, `:5174`; none in production), CORS with credentials, `no-store`, CSP `default-src 'none'`. Per-route `RequireStaff` permissions (see [Route index](#route-index)). |
| `src/routes/metrics.ts` | `GET /internal/v1/metrics` (Prometheus text from `RenderMetrics`). Needs `MYSTICPARADOX_METRICS_TOKEN` as bearer or `x-mysticparadox-metrics-token`; with no token set only raw loopback outside production (else 503). |
| `src/routes/*.test.ts` | node:test unit tests for the sibling route module (`metricsRoute.test.ts` for `metrics.ts`). |

### Route index

Auth column:

- `none`: no check.
- `game`: `HasParadoxBackendAuth` (player game JWT, or the gameserver key). A player acts as its own token
  userId unless noted.
- `self`: `game`, and a player may only name its own userId in the path; the gameserver may name anyone.
- `gs`: `game`, and the handler requires the gameserver key.
- `player`: `game`, and the handler refuses gameserver-key requests.
- `launcher`: `HasLauncherAuth`. `tester`: launcher session with the `tester` role.
- `staff:<permission>`: `HasAdminAuth` + `RequireStaff`. `staff`: session only.
- `ticket`: voice ticket in `x-mystic-ticket`. `bearer`: game JWT checked in the handler.
- `publisher`: source IP in `UPDATE_PUBLISHER_ALLOWED_IPS` + `x-update-api-key`. `sync`: `x-sync-token`.
  `metrics`: metrics token.

Paths are as routed, after the `/__origin/<host>` prefix is stripped.

| Method | Path | Auth | File | Notes |
|---|---|---|---|---|
| GET | `/` | none | `src/app.ts` | `ok` |
| GET | `/health/live` | none | `src/app.ts` | outside the rate limiter |
| GET | `/health/ready` | none | `src/app.ts` | 503 until ready and Mongo healthy; `players` count |
| GET | `/internal/v1/metrics` | metrics | `src/routes/metrics.ts` | |
| GET | `/features/platform/win` | none | `src/routes/login.ts` | stub |
| GET | `/account/link/epic/:AccId` | none | `src/routes/login.ts` | stub `isLinked: true` |
| POST | `/login` | game | `src/routes/login.ts` | queue ticket stub |
| GET | `/accountinfo` | game | `src/routes/login.ts` | |
| GET | `/tags` | game | `src/routes/login.ts` | empty |
| PUT | `/gamesession/epic`, `/gamesession/epiceos` | game | `src/routes/login.ts` | echoes the bearer |
| POST | `/accountinfo/public` | game | `src/routes/login.ts` | |
| POST | `/migration/trigger` | game | `src/routes/login.ts` | stub |
| GET | `/migration/status` | game | `src/routes/login.ts` | stub |
| GET | `/isbanned` | none | `src/routes/login.ts` | always false |
| POST | `/account/api/oauth/token` | none | `src/routes/eos.ts` | game login (`AUTH_MODE`) |
| GET | `/account/api/oauth/verify` | bearer | `src/routes/eos.ts` | |
| GET | `/account/api/public/account/:AccId` | none | `src/routes/eos.ts` | |
| GET | `/account/api/public/account/:AccId/externalAuths` | none | `src/routes/eos.ts` | `[]` or 404 |
| GET | `/account/api/public/account/displayName/:displayName` | none | `src/routes/eos.ts` | |
| DELETE | `/account/api/oauth/sessions/kill[/:AuthToken]` | none | `src/routes/eos.ts` | stub |
| GET | `/account/api/public/account` | game | `src/routes/eos.ts` | bulk `?accountId=` |
| GET | `/dauntless-status` | none | `src/routes/system.ts` | MOTD banner |
| POST | `/heartbeat` | none | `src/routes/system.ts` | `20000` |
| POST | `/event` | none | `src/routes/system.ts` | stub |
| GET | `/crash/CrashReporter/Ping` | none | `src/routes/system.ts` | stub |
| POST | `/crash/CrashReporter/CheckReport` | none | `src/routes/system.ts` | stub |
| GET | `/survey/config` | game | `src/routes/system.ts` | empty mailbox triggers |
| POST | `/account/migrate` | game | `src/routes/system.ts` | stub |
| POST | `/profile/update` | game | `src/routes/system.ts` | stub |
| POST | `/trials/leaderboards/all` | game | `src/routes/system.ts` | empty board |
| POST | `/trials/leaderboards/solo/individual` | game | `src/routes/system.ts` | empty |
| POST | `/trials/leaderboards/group/individual` | game | `src/routes/system.ts` | empty |
| GET | `/vivox/login` | game | `src/routes/system.ts` | 404 |
| POST | `/motd/` | game | `src/routes/system.ts` | 204 |
| GET | `/entitlementsv2` | game | `src/routes/system.ts` | real entitlements |
| POST | `/entitlementv2/:userId` | game | `src/routes/system.ts` | stub |
| GET | `/playertreatments[/][:userId]` | game | `src/routes/system.ts` | cohorts |
| GET | `/escalation/:escalationSeason/:userId` | self | `src/routes/system.ts` | |
| POST | `/escalation/:escalationSeason/:userId` | self | `src/routes/system.ts` | player-host never |
| GET | `/eventstats/` | game | `src/routes/system.ts` | stub |
| GET | `/progression/config` | game | `src/routes/system.ts` | player: only its slot current; gs: season43 padded to the Commission length |
| GET | `/config` | game | `src/routes/system.ts` | Gauntlet host only |
| GET | `/progression/level_access/:season` | game | `src/routes/system.ts` | Gauntlet host only; `?account_id=` |
| GET | `/progression/:season/:userId` | game | `src/routes/system.ts` | Gauntlet host only (regex) |
| GET | `/rewards/personal/:season/:userId` | game | `src/routes/system.ts` | Gauntlet host only, stub |
| GET | `/rewards/guild/:season/:userId` | game | `src/routes/system.ts` | Gauntlet host only, stub |
| GET | `/leaderboard/get_leaderboard/*` | game | `src/routes/system.ts` | Gauntlet host only, stub |
| POST | any path | game | `src/routes/system.ts` | Gauntlet host only; a gs level success records a clear |
| GET | `/huntpass/:userId` | game | `src/routes/system.ts` | always `season43` |
| GET | `/cooldown/:userId` | self | `src/routes/system.ts` | |
| PUT | `/cooldown/batch/:userId` | gs | `src/routes/system.ts` | |
| PUT | `/cooldown/:userId/:cooldownId` | gs | `src/routes/system.ts` | gather timers |
| GET | `/bounty/game-data` | game | `src/routes/system.ts` | |
| GET | `/bounty/:userId` | self | `src/routes/system.ts` | |
| POST | `/bounty/:userId` | gs | `src/routes/system.ts` | |
| POST | `/bounty/delete/:userId` | gs | `src/routes/system.ts` | claim/abandon |
| GET | `/all/` | game | `src/routes/system.ts` | empty mailbox |
| GET | `/patchnotes/:language/:gameversion` | none | `src/routes/system.ts` | |
| GET | `/character` | game | `src/routes/character.ts` | |
| PUT | `/character` | game | `src/routes/character.ts` | create |
| POST | `/character` | game | `src/routes/character.ts` | save; 409 HTML on conflict |
| POST | `/inventory/<char>/<changeList>` | game | `src/routes/inventory.ts` | migration stub (regex, also empty char) |
| GET | `/inventory/:userId/:characterId` | game | `src/routes/inventory.ts` | player: token userId |
| GET | `/inventory/:userId/` | game | `src/routes/inventory.ts` | gs: resolves the account's first character |
| POST | `/inventory` | game | `src/routes/inventory.ts` | grants/spends need gs |
| POST | `/inventory/instanceditem` | game | `src/routes/inventory.ts` | one item's data; player-host 403 |
| POST | `/reconcile` | game | `src/routes/store.ts` | |
| GET | `/creator` | game | `src/routes/store.ts` | stub |
| GET | `/balance` | game | `src/routes/store.ts` | |
| GET | `/product/sku/:id` | game | `src/routes/store.ts` | |
| GET | `/product/skus/public` | game | `src/routes/store.ts` | `?requiredTags=` |
| GET | `/token/:currency/:catalogId` | game | `src/routes/store.ts` | purchase token |
| POST | `/notification/:currency` | game | `src/routes/store.ts` | redeem `?token=` |
| GET | `/guild/invite/player` | player | `src/routes/guild.ts` | |
| GET | `/guild` | player | `src/routes/guild.ts` | 204 when none |
| POST | `/guild/validate` | player | `src/routes/guild.ts` | |
| POST | `/guild` | game | `src/routes/guild.ts` | gs (leader in body) or player |
| DELETE | `/guild/player` | player | `src/routes/guild.ts` | leave |
| DELETE | `/guild/player/:accountId` | player | `src/routes/guild.ts` | kick |
| PUT | `/guild/invite/:accountId` | player | `src/routes/guild.ts` | |
| POST | `/guild/invite/accept/:inviteId` | player | `src/routes/guild.ts` | |
| DELETE | `/guild/invite/:inviteId` | player | `src/routes/guild.ts` | decline |
| PUT | `/guild/rank/:accountId/:rank` | player | `src/routes/guild.ts` | |
| DELETE | `/guild/:guildId` | player | `src/routes/guild.ts` | disband |
| GET | `/game_tuning/seasonal_event_schedule` | none | `src/routes/tuning.ts` | |
| GET | `/game_tuning/huntpass_xp_config` | none | `src/routes/tuning.ts` | |
| GET | `/game_tuning/island_content_config` | none | `src/routes/tuning.ts` | |
| GET | `/game_tuning/bounty_game_data` | none | `src/routes/tuning.ts` | |
| GET | `/game_tuning/bounty_game_data_daily` | none | `src/routes/tuning.ts` | |
| GET | `/game_tuning/bounty_game_data_weekly` | none | `src/routes/tuning.ts` | |
| POST | `/candidate/player/register` | game | `src/routes/matchmaking.ts` | |
| POST | `/candidate/player/alive` | game | `src/routes/matchmaking.ts` | |
| GET | `/candidate/regions` | game | `src/routes/matchmaking.ts` | |
| POST | `/key/generate` | game | `src/routes/matchmaking.ts` | |
| POST | `/key/consume` | game | `src/routes/matchmaking.ts` | |
| GET | `/candidate/status` | game | `src/routes/matchmaking.ts` | |
| POST | `/candidate/join` | game | `src/routes/matchmaking.ts` | |
| DELETE | `/candidate` | game | `src/routes/matchmaking.ts` | cancel |
| GET | `/QoS` | none | `src/routes/matchmaking.ts` | pong |
| POST | `/party` | game | `src/routes/party.ts` | |
| GET | `/mystic/party/hunt-offer` | ticket | `src/routes/party.ts` | |
| POST | `/mystic/party/join-hunt` | ticket | `src/routes/party.ts` | 409 `{reason}` when blocked |
| PUT | `/party/invite` | game | `src/routes/party.ts` | |
| GET | `/party/invites` | game | `src/routes/party.ts` | |
| PUT | `/party/invite/accept/:inviterId` | game | `src/routes/party.ts` | |
| DELETE | `/party/member` | game | `src/routes/party.ts` | leave |
| DELETE | `/party/member/:targetId` | game | `src/routes/party.ts` | kick |
| PUT | `/party/member/promote/:targetId` | game | `src/routes/party.ts` | |
| GET | `/encountered-content/:characterId/:contentType` | game | `src/routes/progression.ts` | own character |
| POST | `/encountered-content/query/:characterId`, `/encountered-content/:characterId/query`, `/encountered-content/query` | game | `src/routes/progression.ts` | |
| POST | `/encountered-content/:characterId` | game | `src/routes/progression.ts` | add |
| POST | `/encountered-content[/]` | game | `src/routes/progression.ts` | stub |
| GET | `/progression/objectives/:userId` | self | `src/routes/progression.ts` | |
| GET | `/breadcrumbs/` | game | `src/routes/progression.ts` | empty |
| GET/POST | `/breadcrumbs/:characterId` | game | `src/routes/progression.ts` | own character |
| POST | `/progression/:userId/:progressionId/:amount` | gs | `src/routes/progression.ts` | XP grant |
| POST | `/progression/:userId` | self | `src/routes/progression.ts` | objective report |
| POST | `/progression/:userId/:progressionId/:rank/confirm/:track` | gs | `src/routes/progression.ts` | |
| DELETE | `/progression/:userId/:progressionId` | gs | `src/routes/progression.ts` | reforge reset, `ExperienceTrack_Weapon_*` only |
| POST | `/progression/purchase/:userId/:progressionId/:amount` | gs | `src/routes/progression.ts` | reforge banked XP apply, `ExperienceTrack_Weapon_*`, amount <= 3500 |
| GET | `/progression/:userId` | self | `src/routes/progression.ts` | |
| GET | `/progression/:userId/:progressionId` | self | `src/routes/progression.ts` | |
| GET | `/pjm/:userId` | self | `src/routes/progression.ts` | gs read also grants node rewards |
| POST | `/pjm/:userId` | gs | `src/routes/progression.ts` | |
| GET | `/pjm` | game | `src/routes/progression.ts` | saved map or bootstrap graph |
| GET | `/weapon_tracker/:userId/:itemId` | self | `src/routes/progression.ts` | stub |
| GET/POST | `/progression/tracked_objectives/:phxAccountId` | self | `src/routes/progression.ts` | stub |
| GET | `/loadout/:userId//all` | game | `src/routes/loadout.ts` | empty for `INVALID`, else 400 |
| GET | `/loadout/:userId/:characterId/all` | game | `src/routes/loadout.ts` | |
| POST | `/loadout/:userId/:characterId/unlock/:numSlots` | gs | `src/routes/loadout.ts` | |
| POST | `/loadout/:userId/:characterId/active/:index` | game | `src/routes/loadout.ts` | |
| POST | `/loadout/:userId/:characterId/:index` | game | `src/routes/loadout.ts` | |
| GET | `/friends/api/public/friends/:accountId` | game | `src/routes/friends.ts` | |
| POST | `/friends/api/public/friends/:accountId/:friendId` | game | `src/routes/friends.ts` | invite or accept |
| DELETE | `/friends/api/public/friends/:accountId/:friendId` | game | `src/routes/friends.ts` | |
| GET | `/friends/api/public/blocklist/:accountId` | none | `src/routes/friends.ts` | `[]` |
| GET | `/friends/api/public/list/:namespace/:accountId/recentPlayers` | none | `src/routes/friends.ts` | `[]` |
| GET | `/friends/api/v1/:accountId/settings` | none | `src/routes/friends.ts` | |
| GET | `/slayerlink/status_good`, `/slayerlink/links` | player | `src/routes/slayerLinks.ts` | settles first |
| GET | `/slayerlink/invites` | player | `src/routes/slayerLinks.ts` | |
| PUT | `/slayerlink/invite` | player | `src/routes/slayerLinks.ts` | send |
| POST | `/slayerlink/invite` | player | `src/routes/slayerLinks.ts` | accept/reject/cancel |
| DELETE | `/slayerlink/invites/:accountId` | player | `src/routes/slayerLinks.ts` | |
| DELETE | `/slayerlink/links` | game | `src/routes/slayerLinks.ts` | player, or gs with `links[]` |
| PUT | `/slayerlink/links/rewards` | game | `src/routes/slayerLinks.ts` | gs names `account_id` |
| GET | `/slayerlink/links/rewards/:accountId/:slot` | game | `src/routes/slayerLinks.ts` | always backend-granting |
| POST | `/slayerlink/availability` | player | `src/routes/slayerLinks.ts` | |
| POST | `/mystic/hunt-stats` | gs | `src/routes/huntStats.ts` | 204 |
| POST | `/launcher/v1/auth/register` | none | `src/routes/launcherAuth.ts` | 202 pending / 200 invited |
| POST | `/launcher/v1/auth/login` | none | `src/routes/launcherAuth.ts` | |
| POST | `/launcher/v1/auth/refresh` | none | `src/routes/launcherAuth.ts` | refresh token in body |
| POST | `/launcher/v1/auth/logout`, `/launcher/v1/auth/logout-all` | launcher | `src/routes/launcherAuth.ts` | |
| POST | `/launcher/v1/auth/discord/start` | none | `src/routes/launcherAuth.ts` | |
| GET | `/launcher/v1/auth/discord/callback` | none | `src/routes/launcherAuth.ts` | 302 to deep link |
| POST | `/launcher/v1/auth/discord/complete` | none | `src/routes/launcherAuth.ts` | completion code |
| GET | `/launcher/v1/me` | launcher | `src/routes/launcherAuth.ts` | |
| GET | `/launcher/v1/username` | none | `src/routes/launcherAuth.ts` | `?name=` availability |
| POST | `/launcher/v1/username` | launcher | `src/routes/launcherAuth.ts` | |
| POST | `/launcher/v1/game-sessions` | launcher | `src/routes/launcherAuth.ts` | exchange code + voice ticket |
| GET/POST | `/launcher/v1/characters` | launcher | `src/routes/launcherAuth.ts` | |
| PATCH/DELETE | `/launcher/v1/characters/:slot` | launcher | `src/routes/launcherAuth.ts` | rename / delete |
| PATCH | `/launcher/v1/characters/:slot/name-style` | launcher | `src/routes/launcherAuth.ts` | owners only |
| GET | `/launcher/v1/policy` | launcher | `src/routes/launcherAuth.ts` | |
| GET | `/launcher/v1/status` | none | `src/routes/launcherAuth.ts` | `online`, `supportedBuildChangelist` |
| GET | `/launcher/v1/runtime/[:target/]:channel/:platform` | none (stable) / tester | `src/routes/launcherUpdates.ts` | manifest; 204 when serving is off |
| GET | `/launcher/v1/runtime/[:target/]:channel/:platform/download` | none (stable) / tester | `src/routes/launcherUpdates.ts` | |
| GET | `/launcher/v1/runtime/:target/:channel/:platform/extra/:filename` | none (stable) / tester | `src/routes/launcherUpdates.ts` | |
| GET | `/launcher/v1/guard-manifests/:channel/:platform` | none (stable) / tester | `src/routes/launcherUpdates.ts` | |
| POST | `/launcher/v1/admin/guard-manifests/:channel/:platform` | publisher | `src/routes/launcherUpdates.ts` | signed, sequence must rise |
| POST | `/launcher/v1/admin/updates/runtime/:target/:channel/:platform` | publisher | `src/routes/launcherUpdates.ts` | signed DLL, immutable |
| POST | `/launcher/v1/admin/updates/runtime/:target/:channel/:platform/extra` | publisher | `src/routes/launcherUpdates.ts` | |
| GET/POST | `/launcher/v1/admin/updates/serving` | publisher | `src/routes/launcherUpdates.ts` | `runtimeEnabled` switch |
| GET | `/launcher/v1/updates/:target/:arch/download` | none | `src/routes/launcherUpdates.ts` | launcher installer |
| GET | `/launcher/v1/updates/:target/:arch/:currentVersion` | none | `src/routes/launcherUpdates.ts` | Tauri updater manifest |
| GET/HEAD | `/content/v1/manifest` | none | `src/routes/content.ts` | |
| GET | `/content/v1/files/<path>` | launcher | `src/routes/content.ts` | |
| GET | `/content/v1/news` | none | `src/routes/news.ts` | |
| GET | `/content/v1/news/image/:id` | none | `src/routes/news.ts` | |
| GET | `/launcher/v1/info`, `/launcher/v1/info/logo` | none | `src/routes/launcherCard.ts` | |
| GET/PUT | `/admin/v1/launcher-card` | staff:operations | `src/routes/launcherCard.ts` | |
| PUT/DELETE | `/admin/v1/launcher-card/logo` | staff:operations | `src/routes/launcherCard.ts` | raw image body |
| GET | `/admin/v1/launcher-card/invite` | staff:operations | `src/routes/launcherCard.ts` | `?host=&port=` |
| PUT | `/launcher/v1/logs/sessions/:launchSessionId/:fileName` | tester | `src/routes/launcherLogs.ts` | raw body |
| PUT | `/crash/v1/reports/:id/:fileName` | none | `src/routes/crashReports.ts` | raw body |
| GET | `/admin/v1/launcher-logs` | sync | `src/routes/adminLauncherLogs.ts` | `?since=` |
| GET | `/admin/v1/launcher-logs/:userId/:launchSessionId/:fileName` | sync | `src/routes/adminLauncherLogs.ts` | |
| POST | `/admin/v1/auth/login` | none | `src/routes/admin.ts` | |
| POST | `/admin/v1/auth/logout` | staff | `src/routes/admin.ts` | |
| GET | `/admin/v1/auth/discord/start`, `/admin/v1/auth/discord/callback` | none | `src/routes/admin.ts` | browser redirects |
| GET | `/admin/v1/me` | staff | `src/routes/admin.ts` | |
| GET | `/admin/v1/online-players` | staff:players.read | `src/routes/admin.ts` | |
| GET | `/admin/v1/players` | staff:players.read | `src/routes/admin.ts` | |
| GET | `/admin/v1/players/:userId/detail` | staff:players.read | `src/routes/admin.ts` | |
| PATCH | `/admin/v1/players/:userId/access` | staff (checked in handler) | `src/routes/admin.ts` | `players.ban.timed` or `players.access` |
| PATCH | `/admin/v1/players/:userId/roles` | staff:players.roles | `src/routes/admin.ts` | |
| DELETE | `/admin/v1/players/:userId` | staff:players.delete | `src/routes/admin.ts` | |
| GET | `/admin/v1/audit` | staff:players.read | `src/routes/admin.ts` | |
| GET | `/admin/v1/operations/overview` | staff:operations | `src/routes/admin.ts` | |
| PATCH | `/admin/v1/operations/policy` | staff:operations | `src/routes/admin.ts` | |
| GET | `/admin/v1/servers/overview`, `/admin/v1/servers/history` | staff:servers.read | `src/routes/admin.ts` | |
| POST | `/admin/v1/servers/gameservers/:id/stop` | staff:servers.control | `src/routes/admin.ts` | |
| GET | `/admin/v1/servers/gameservers/:id/log` | staff:servers.control | `src/routes/admin.ts` | |
| POST | `/admin/v1/servers/restart` | staff:servers.control | `src/routes/admin.ts` | `target` stack or director |
| GET | `/admin/v1/servers/logs/:name` | staff:servers.control | `src/routes/admin.ts` | |
| GET | `/admin/*` | none | `src/app.ts` | static `admin-ui/` |
| POST | `/launcher/v1/guard/sessions`, `/launcher/v1/guard/heartbeat` | launcher | `src/routes/launcherGuard.ts` | |
| GET | `/launcher/v1/guard/sessions/:guardSessionId` | launcher | `src/routes/launcherGuard.ts` | |

## src/middleware

| File | What it does |
|---|---|
| `src/middleware/HasParadoxBackendAuth.ts` | Game-route auth. A gameserver key (`IsValidGameserverAPIKey`) sets `AuthData.IsGameserver`; for GET/HEAD the path segment `INVALID` is rewritten to `GAMESERVER_NO_PLAYER_USER_ID` (else `DEV_USER_ID`, else `mystpax`); a forwarded player bearer keeps that player (eligibility checked), otherwise the request is attributed to `GAMESERVER_NO_PLAYER_USER_ID`/`DEV_USER_ID` (no userId when both unset). Wrong key = 401. Then the extension may authenticate its own credential. Otherwise a bearer game JWT, checked with `IsCurrentLauncherAccountEligible` (403 when banned/disabled/pending/rejected). Exports `HasParadoxBackendAuth`, `IsCurrentLauncherAccountEligible`. |
| `src/middleware/HasLauncherAuth.ts` | Launcher-route auth: launcher JWT, account exists, refresh family `sid` still active, `AssertAccountAdmitted`; sets `req.LauncherAuthData`. Errors use the launcher JSON shape. |
| `src/middleware/HasAdminAuth.ts` | `HasAdminAuth` (cookie `ADMIN_COOKIE_NAME` = `mysticparadox_admin`, hashed session lookup, staff rank and eligibility re-read each request, `x-csrf-token` for non-GET; sets `req.AdminAuth`) and `RequireStaff(permission)`. |

## src/security

| File | What it does |
|---|---|
| `src/security/accountEligibility.ts` | `EffectiveApprovalStatus` (missing = approved), `IsBanActive` (expired `bannedUntil` = not banned), `AssertAccountAdmitted` (ban/disabled/pending/rejected), `AssertAccountEligible` (also needs a username), `IsAccountEligible`. |
| `src/security/apiKeyHash.ts` | `AssertApiKeyHashSecret` (`API_KEY_HASH_SECRET`, 32+ chars), `HashApiKey(value, scope)` (HMAC-SHA256, scope `gameserver` or `user`), `FindApiKeyRecord` (constant-time scan). |
| `src/security/launcherTokens.ts` | `SignLauncherAccessToken`/`ValidateLauncherAccessToken` (RS256, audience `mysticparadox-launcher`, 12 min, payload `userId` + `sid`), `GenerateOpaqueToken` (32 random bytes hex), `HashOpaqueToken` (SHA-256). |
| `src/security/passwords.ts` | `HashPassword`/`VerifyPassword` (Argon2id; dummy hash verify for unknown accounts). |
| `src/security/totp.ts` | `VerifyTotp(base32Secret, code)`: RFC 6238, 6 digits, 30 s, one step either side. |
| `src/security/staffRoles.ts` | Ranks moderator 1 / admin 2 / owner 3, `StaffPermission` table, `HasStaffPermission`, `StaffRank`, `CanActOn`, `MODERATOR_MAX_BAN_HOURS` (168), `StaffNameTag`, `NAME_STYLES`, `AllowedNameStyles` (owners only), `GameNameTag`, `StripStaffNameTag`, `IsNameStyle`. |
| `src/security/testerFeatures.ts` | `ASSIGNABLE_ROLES` (`tester`, `moderator`, `admin`), `TESTER_ROLE`, `TESTER_MANAGED_FEATURES` (`diagnostics.verbose` -> `VERBOSE_DIAG.flag`). |
| `src/security/runtimeAuthorization.ts` | Runtime DLL approval against the signed manifest at `<LAUNCHER_UPDATE_ROOT>/runtime/client/<channel>/windows-x86_64/latest.json`: `ParseRuntimeChannel` (`stable`/`beta`/`dev`), `ExpectedRuntimeChannel` (tester = beta), `AssertRuntimeChannelMatchesAccount`, `GetApprovedRuntimeSha256`, `GetApprovedRuntimeAttestation`, `AssertRuntimeArtifactSetApproved` (every reported file must match), `AssertRuntimeHashApproved`, `RuntimeUpdateRoot`, `RuntimeManifestPath`, `NormalizeRuntimeSha256`. Manifest must target `TARGET_CHANGELIST`. Used by `controllers/launcherAuth.ts` and `routes/eos.ts`. |
| `src/security/rateLimit.ts` | `IsRateLimited(key, max, windowMs)` (in-memory sliding window, never pruned) and `RequestRateLimitOptions` for the global `express-rate-limit` (per IP, separate gameserver-key bucket; `MYSTICPARADOX_RATE_LIMIT`, `MYSTICPARADOX_RATE_LIMIT_PER_MINUTE` 600, `MYSTICPARADOX_GAMESERVER_RATE_LIMIT_PER_MINUTE` 6000). |
| `src/security/logRedaction.ts` | `sanitizeUrlForLog`: replaces `token`, `access_token`, `refresh_token`, `code`, `exchange_code`, `authorization`, `api_key`, `apikey`, `signature` query values with `[REDACTED]`. |
| `src/security/launcherErrors.ts` | `LauncherApiError(code, message)`, code -> HTTP status table, `SendLauncherError` (`{ error: { code, message, requestId } }`), `RegisterLauncherErrorStatuses` for extension codes. |
| `src/security/launcherVersion.ts` | `VersionAtLeast(actual, minimum)`: semver compare including prereleases. |
| `src/security/*.test.ts` | node:test unit tests for the sibling module (`guardProtocols.test.ts` covers `controllers/launcherGuard.ts`; `runtimeArtifactSets.test.ts` covers artifact-set approval). |

## src/observability

| File | What it does |
|---|---|
| `src/observability/metrics.ts` | In-process counters/gauges/histograms with a label allow-list (`class, code, le, method, operation, result, role, service, status`). `IncrementMetric`, `SetMetric`, `AdjustMetric`, `ObserveMetric`, `RenderMetrics` (Prometheus text incl. `mysticparadox_info`, `mysticparadox_service_ready`, `mysticparadox_service_readiness_changed_timestamp_seconds`), `RegisterMetricsSection` (extensions). |
| `src/observability/requestContext.ts` | `RequestContextMiddleware` (request id from `x-mysticparadox-request-id`/`x-request-id` when safe, else a UUID; echoed in `x-mysticparadox-request-id`), `GetRequestId`, `GetRequestContext`, `RunWithRequestContext`, `NormalizeRequestId`, `REQUEST_ID_HEADER`. AsyncLocalStorage. |
| `src/observability/serviceReadiness.ts` | `SetServiceReadiness`/`GetServiceReadiness` (ready flag, reason, role, changedAt). Starts `STARTING`. |
| `src/observability/*.test.ts` | node:test unit tests for the sibling module. |

## src/diagnostics

| File | What it does |
|---|---|
| `src/diagnostics/capture.ts` | `[INV-CAP]` structured inventory capture, off unless `MYSTICPARADOX_INV_CAPTURE` (`_RAW` adds full JSON, `_FILTER` regex of catalog ids). `InventoryCaptureEnabled`, `CaptureInventoryTransaction` (request/result/error phases), `CaptureEvent`. Never throws. Used by `routes/inventory.ts`, `routes/loadout.ts`. |
| `src/diagnostics/economyMonitor.ts` | Always-on `[PrestigeMon]`, `[DraftMon]`, `[GrantMon]` lines for gated reward currencies, bounty draft tokens and server grants; `MYSTICPARADOX_ECONOMY_MONITOR=off` silences them. `MonitorGrant`, `MonitorInventoryRequest`/`Outcome`, `MonitorPrestigeFunding`, `MonitorProgressionReport`/`Served`, `MonitorBountySave`/`Load`, `MonitorCooldownSave`/`Load`, `MonitorSourceOf`, `IsDraftToken`. |

## src/services

| File | What it does |
|---|---|
| `src/services/operationsPolicy.ts` | Singleton `operationsPolicy` document (`_id` `global`, seeded by `persistence/mongo/indexes.ts`): `guardEnforcement` (ENFORCE default / OBSERVE), `diagnosticsProfile` (PRODUCTION default / DEVELOPMENT with a 2 h lease), `version`. `GetOperationsPolicy`, `SetOperationsPolicy` (optimistic version), `ReadOperationsPolicyRecord`, `ResolveOperationsPolicy` (malformed = ENFORCE + PRODUCTION; applies the log level outside transactions; `GUARD_ENFORCEMENT_OVERRIDE=OBSERVE` forces observe), `NormalizeOperationsPolicyRecord`, `ResolveDiagnosticsExpiry`, `OperationsPolicyWeakeningCodes`. |
| `src/services/operationsPolicy.test.ts` | node:test unit tests for the sibling module. |

## src/extensions

| File | What it does |
|---|---|
| `src/extensions/p2p.ts` | Hook interface `P2PExtension` for the optional player-hosted hunt module and its dedicated-only defaults (`DEDICATED_ONLY`). `GetP2PExtension()` loads `src/p2p/` once when it exists (must export `CreateP2PExtension`); `MYSTICPARADOX_P2P_MODULE=off` keeps the defaults. Hooks: server (roles, safety issues, DB setup, start/stop), http (early/late routes, error handlers, metric class, log tags, `authenticate`), inventory (`authorizeTransaction`), matchmaking (`routeHunt` and candidate restore), launcher (policy fields, Guard roles), operations (policy fields, overview). The module is not in this repo. |

## src/gameData

| File | What it does |
|---|---|
| `src/gameData/loader.ts` | `gameDataDir`, `gameDataPath`, `loadGameData(file)` (throws with a how-to-generate hint when missing; strips a BOM), `tryLoadGameData`. Directory: `PARADOX_GAME_DATA_DIR` or `game-data/` next to `src/`/`build/`. |

## admin-ui

| File | What it does |
|---|---|
| `admin-ui/index.html` | The staff dashboard shell served at `/admin`: sign-in form (email/username, password, TOTP, "Sign in with Discord" link), nav, confirm dialog, inline styles. Loads `admin.js`. |
| `admin-ui/admin.js` | Dashboard logic, plain JS. `api(method, path, body)` calls `/admin/v1/*` with the CSRF token. Pages by rank: Overview, Servers, Players (detail drawer, ban/approve, roles, delete), Online now, Audit log (rank 1+), Logs (rank 2+), Launcher card (rank 3). Polls while visible. No page for the operations policy (API only). |
