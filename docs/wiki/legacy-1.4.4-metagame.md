# Legacy 1.4.4: UndauntedMetagame (backend)

> Verified against code 2026-10-24.

## What it is

`versions/1.4.4/UndauntedMetagame/` is the backend for the 1.4.4 client. It is a Node/TypeScript Express 5 app (package `dauntless-revived-metagame`) that fakes Phoenix Labs' online services (Epic login, account, inventory, store, friends, parties, guilds, matchmaking, progression, trials, Escalation) and also hosts the admin/launcher API under `/undaunted/api/*` and an XMPP-over-WebSocket chat server. Storage is a single **SQLite** file (`better-sqlite3` with Drizzle ORM); this is the biggest difference from the 1.14.7 backend, which uses MongoDB (see [backend](backend.md) and [backend-persistence](backend-persistence.md)). Listens on `127.0.0.1:61000` by default. Part of the [legacy 1.4.4 stack](legacy-1.4.4.md).

Dependencies: `better-sqlite3`, `drizzle-orm`, `express`, `express-rate-limit`, `jsonwebtoken`, `ltx` (XML), `ws`, `pino`, `dotenv`. Scripts: `dev` (tsx watch), `build` (tsc, then `postbuild` writes `dist/build-info.json`), `start` (`node --env-file=.env dist/server.js`), `db:generate`, `test`.

## How it works

### Boot (`src/server.ts`)

1. `CheckGatewayConfig()` - if `GATEWAY_SECRET` is set (public mode) the app refuses to start unless `AUTH_MODE=APIKEY`; warns on a short secret, non-loopback `BIND_HOST`, `NODE_ENV` not `production`, or `QOS_TARGET_URL` not `http://127.0.0.1:<port>/QoS`.
2. `CheckProgressionConfig()` - loads the Hunt Pass seasons and mastery tracks (`PROGRESSION_CONFIG_DIR`, `ACTIVE_HUNT_PASS`); a bad config stops startup.
3. `GetDb()` - applies SQL migrations (the journal mode is already set when `db.ts` is imported).
4. `SetDailyTokensOnce()` (one-time job: daily token stacks) and `PruneExpiredStorePurchases()`.
5. `DrainAndRegisterAPIKeys()` / `DrainAndRegisterUserAPIKeys()` - plain keys an operator inserted by hand into `gameserverapikeystoregister` / `userapikeystoregister` (`versions/1.4.4/docs/setup/host.md` shows the SQL) are hashed (SHA-256) into `gameserverapikeys` / `userapikeys` and the plain rows deleted. **Only these queued keys need a restart.** `POST /undaunted/api/Register` writes the hashed account key straight into `userapikeys`, valid at once.
6. `StartChat()` (on by default, `CHAT=0` opts out), then `app.listen(PORT, BIND_HOST)`; logs features and "Clear Skies, Slayer." when ready.

### Request pipeline (`src/app.ts`)

`TrackBackendHealth` -> ban check (`CheckPlayerAccess` from `controllers/moderation.ts`, skipped for `/undaunted/api/ServerStatus` so a banned launcher can show the reason) -> `RefuseProxiedInDevAuthMode` -> `express.json({limit: "50mb"})` + urlencoded -> request log (unless `LOG_REQUESTS=0`; path redacted, `gs=1` for game-server calls) -> `BodyLog` (only `LOG_BODIES=1`) -> routers (`login`, `keyrotation`, `backup`, `eos`, `system`, `escalation`, `friends`, `character`, `inventory`, `store`, `guild`, `tuning`, `trials`, `matchmaking`, `party`, `slayerlinks`, `progression`, `loadout`, then `undauntedapi` at `/undaunted/api`) -> 404 logger `Unstubbed route <METHOD> <path>` -> JSON parse error handler (400 `bad_request` for the launcher/host account routes only).

### Authentication

| Caller | How it proves itself | Middleware |
|---|---|---|
| Game client (player) | account key exchanged at `POST /account/api/oauth/token` for a 24 h RS256 JWT (`AUTH_SIGNING_PRIVKEY_B64` signs, `..._PUBKEY_B64` verifies; issuer/audience `undaunted-metagame`; claims `userId`, `epoch`). `Authorization: Bearer ...` after that | `HasUndauntedMetagameAuth`, `PlayerTokenOnly`, `SoftMetagameAuth` |
| Game server process | header `x-undaunted-gameserver-apikey`; refused unless the caller is on this machine (or in `GAMESERVER_ALLOW_FROM`) and not proxied | `HasUndauntedMetagameAuth`, `GameServerKeyAuth`, `RefuseUnlessGameserver` |
| Launcher / player tools | header `x-undaunted-user-api-key` (the account key) | `HasUndauntedUserApiKey`, `SoftAccountAuth` (public answer if key missing) |
| Admin | same header but the account must be `isAdmin`; never through a proxy | `HasUndauntedAdminApiKey` |
| Discord bot key recovery | header `x-key-recovery-service` = `KEY_RECOVERY_SERVICE_SECRET` (>= 32 chars), loopback only | `KeyRecoveryAuth` in `routes/keyrotation.ts` |

Tokens carry an `epoch` (`authepochs` table); key rotation (`controllers/keyrotation.ts`) bumps it and so invalidates old tokens. `BanFor()` is checked on every token sign and validate. `AUTH_MODE=NONE` (dev only, not with `NODE_ENV=production`) accepts any account id and refuses proxied requests.

### Request origin (`middleware/RequestOrigin.ts`)

In public mode the Metagame trusts `X-Forwarded-For` only if the connection is loopback **and** carries `X-Dauntless-Gateway: <GATEWAY_SECRET>`. Requests with any forwarding header are "proxied" and may never use the admin key or the game-server key. `GAMESERVER_ALLOW_FROM` lists extra hosts allowed to use the game-server key.

### Route areas

| Area | Routes (examples) | Notes |
|---|---|---|
| Login/EOS stubs | `POST /account/api/oauth/token`, `GET /account/api/oauth/verify`, `POST /login`, `GET /accountinfo`, `POST /accountinfo/public`, `GET /tags`, `PUT /gamesession/epic` | imitates Epic and Phoenix login. Verify is polled every 30 s by the client |
| System | `POST /heartbeat`, `POST /event`, `GET /entitlementsv2`, `/cooldown/*`, `/bounty/*`, `/huntpass/:userId`, `GET /progression/config`, `/motd/*`, `GET /dauntless-status` | `/heartbeat` records activity + play address and keeps party membership alive; the gateway watches it for its allowlist |
| Character/inventory/loadout | `/character`, `/inventory/*`, `/loadout/:userId/:characterId/*` | game server writes; saves are versioned (`savehistory.ts`) with rollback via `/undaunted/api/RollbackCharacter` |
| Progression | `/progression/:userId/*`, `/encountered-content/*`, `/breadcrumbs/*` | "real" mode stores everything; `PROGRESSION_MODE=stub` returns upstream's fake max ranks |
| Social | `/friends/api/*`, `/party/*`, `/guild/*`, `/slayerlink/*` | clients poll party every ~10 s |
| Matchmaking | `POST /candidate/join[/:candidateId]`, `GET /candidate/status`, `GET /candidate/regions`, `GET /QoS`, `POST /key/generate` | calls the DeployServer, see below |
| Store | `GET /product/skus/public`, `GET /product/sku/:skuId`, `GET /token/:currency/:skuId`, `POST /notification/:currency`, `GET /balance`, `POST /reconcile`, `GET /store-images/:file` | `STORE` = `earned` (default) / `free` / `off` |
| Trials/Escalation/tuning | `POST /trials/leaderboards*`, `GET/POST /escalation/:season/:userId`, `GET /game_tuning/*` | |
| Admin/launcher API | `/undaunted/api/*` (38 handlers) | only 5 are reachable through the gateway (see [gateway-deploy](legacy-1.4.4-gateway-deploy.md)) |
| Internal | `POST /internal/backup`, `POST /internal/key-recovery/:action` | loopback + game-server key / service secret |

Unknown routes log `Unstubbed route <METHOD> <path>` and return 404 - the quickest way to see what a client needs next.

### Matchmaking and the DeployServer

`controllers/matchmaking.ts` holds candidate queues per hunt (and per region: `RegionQueueKey`). When a hunt should start, `LaunchGameOnDeployserver()` POSTs `{GameMode, GameArgs, HuntId, ExpectedPlayers, Region?}` to `http://$DEPLOYSERVER_URL/api/matchmaker/handle-matchmaking-for-player` (deadline `MATCHMAKING_DEPLOY_TIMEOUT_MS`, default 240000). A 200 returns host+port; `503 capacity_unavailable` (reason `memory|ports|hunts|cpu`) makes the player wait; a timeout is treated as a failed candidate and not retried automatically. `MATCHMAKING_MODE=DISABLED` refuses all matchmaking. Player rosters (who may still join, leases, loading grace) live in `controllers/matchmakingroster.ts`. `GET /undaunted/api/ServerStatus` asks the DeployServer for `GET /gameservers`.

### Chat (`src/realtime/`)

XMPP over WebSocket in the same process on `CHAT_PORT` (default 61099, bound to `CHAT_BIND_HOST` 127.0.0.1). Login is SASL PLAIN with the same JWT. Includes MUC rooms (`City-*`, `Hunt-*`, `General*` open; `Party-<id>` and `Guild-<id>` checked against membership at join, per message and every 60 s), friends presence (`CHAT_PRESENCE`), nickname checks (`CHAT_NICK_CHECK`), per-connection rate buckets, ping handling tuned for slow map loads (about 150 s of silence tolerated), and a 60 s login hold-back after abuse or replacement. Nothing from stanzas is logged unless `CHAT_TRACE=1` (redacted). Details: `versions/1.4.4/docs/findings/chat.md`.

## File reference

All paths under `versions/1.4.4/UndauntedMetagame/`.

### Root, core and scripts

| File | What it does |
|---|---|
| `src/server.ts` | Entry point; boot sequence above |
| `src/app.ts` | Express app and middleware order above; exports `app` |
| `src/db.ts` | Opens SQLite at `DB_FILENAME`; `ApplyJournalMode` (rollback journal unless `DB_WAL=1`, switches a WAL file back); `GetDb()` runs `migrate()` from `./src/drizzle` on first call |
| `src/features.ts` | `DefineSwitch` env switches with defaults and parsing (`ParseOnOff`, `ParseCount`, `ParseChoice`); exports `StoreMode`, `EscalationMode`, `TrialsStore`, `MiddlemanStore`, `SlayerLinks`, `ChatPresence`, etc. and `DescribeFeatures()` (boot log line) |
| `src/logger.ts` | pino `logger`; `LOG_LEVEL`, `pino-pretty` unless `NODE_ENV=production` |
| `UndauntedMetagame/drizzle.config.ts` | drizzle-kit config: schema `src/db/schema.ts`, out `src/drizzle`, sqlite at `DB_FILENAME` |
| `scripts/write-build-info.js` | `postbuild`: writes `dist/build-info.json` (git commit, `-dirty`; `GIT_COMMIT` overrides) for ServerStatus and `/dauntless-status` |
| `scripts/make-hunt-titles.js` | Builds `src/vendor/hunt_titles.json` (friendly hunt names for ServerStatus) from the DeployServer's copies of the game's hunt tables |
| `scripts/revoke-free-store.cjs` | Maintenance CLI: `node scripts/revoke-free-store.cjs <cutoff> [--apply]`; previews, then applies `RevokeStorePurchasesBefore` inside a transaction that aborts if character/escalation tables change, then re-verifies and runs `quick_check` |
| `.env.example`, `STORE_PRICING.md` | Env template; store pricing notes |
| `test/*.ts` | `node --test` suite (84 files: unit + HTTP tests per area, `fakedeploy.ts` stub DeployServer, chat wire/model helpers) |

### `src/vendor/` (bundled data, imported at build time)

| File | What it does |
|---|---|
| `vendor/progression_config.json` | Default `/progression/config` payload (Hunt Pass and mastery tracks) |
| `vendor/hunt_pass_schedule.json` | `{epoch, days, passes}`: rotation of Hunt Pass seasons (`SelectHuntPassSeason`) |
| `vendor/hunt_titles.json` | Generated hunt/behemoth display names |
| `vendor/store_catalog.json` | Store tags and offers (`webstore`, season pass/rank, `loadout_slots`, `fountain_daily_free_bundle`...) |
| `vendor/store_curated_30.json`, `store_item_kinds.json`, `store_platinum_prices.json` | Curated offer list, item kind per catalog id, platinum prices per SKU |
| `vendor/store_ladyluck.json` | Lady Luck Trials store catalogue (from a later live-service capture, adapted to 1.4.4 price fields) |
| `vendor/store_middleman.json`, `store_middleman_cells.json` | Middleman fusion-slot offers and weekly Aetherdust cell families |
| `vendor/trials_pool.json` | Weekly Trials behemoth pool (must match the DeployServer and the DLL's `TrialsRotation.h`) |
| `vendor/escalation/seasons.json` | Escalation season registry (levels, talents, unlocks) exported from the client |
| `store-images/*.png` | Icons served by `GET /store-images/:file` |

### `src/routes/`

| File | What it does |
|---|---|
| `routes/login.ts` | `GET /features/platform/win`, `GET /account/link/epic/:AccId`, `POST /login`, `GET /accountinfo`, `GET /tags`, `PUT /gamesession/epic`, `POST /accountinfo/public` (`ACCOUNTINFO_PUBLIC_LEGACY=1` restores old reply) |
| `routes/eos.ts` | `POST /account/api/oauth/token` (key -> JWT, `LoginRateLimit`), `GET /account/api/oauth/verify` (`TokenVerifyRateLimit`), `GET /account/api/public/account[/:AccId[/externalAuths]]`, `GET .../displayName/:displayName`, `POST /account/mapping` (`ACCOUNT_MAPPING=0` disables), `DELETE /account/api/oauth/sessions/kill[/:AuthToken]` |
| `routes/system.ts` | `GET /dauntless-status` (`STATUS_EXTRA`), `POST /heartbeat`, `POST /event`, `POST /account/migrate`, `POST /profile/update`, `GET /vivox/login`, `POST /motd/`, `GET /motd/trigger`, `GET /entitlementsv2`, `POST /entitlementv2/:userId`, `DELETE /entitlement/:userId/:entitlement`, `GET /playertreatments/:userId`, `GET /eventstats/`, `GET /progression/config`, `GET/POST /huntpass/:userId`, `GET /cooldown/:userId`, `PUT /cooldown/batch/:userId`, `PUT /cooldown/:userId/:cooldownId`, `GET /bounty/game-data`, `GET /bounty/:userId`, `POST /bounty/delete/:userId`, `POST /bounty/:userId`, `GET /all/`; `MISC_ROUTES=0` puts back old 404s |
| `routes/character.ts` | `GET/PUT/POST /character` (list, save with version check, create) |
| `routes/inventory.ts` | `POST /inventory/:characterId/:changeList` (migrate), `GET /inventory/:userId/:characterId`, `POST /inventory` (transaction), `POST /inventory/instanceditem` |
| `routes/loadout.ts` | `POST .../unlock/:numSlots`, `GET .../slotcount`, `POST .../active/:index`, `GET .../all`, `POST .../:index`, all under `/loadout/:userId/:characterId` |
| `routes/progression.ts` | `/encountered-content/*`, `/breadcrumbs/:characterId`, `/progression/objectives/:userId[/:objectiveId]`, `POST /progression/:userId` (grant), `POST .../:progressionId/:rank/confirm/:kind` (`PROGRESSION_CONFIRM=off` disables), `POST .../:progressionId/:amount`, `GET/DELETE /progression/:userId/:progressionId` (delete needs `PROGRESSION_ALLOW_DELETE=1`), `GET /progression/:userId`; stub replies when not real mode |
| `routes/escalation.ts` | `GET/POST /escalation/:escalationSeason/:userId` (real mode, POST game server only) |
| `routes/friends.ts` | Epic-style friends: `GET /friends/api/public/friends/:userId`, `GET/POST/PUT/DELETE .../blocklist/:userId[/:friendId]`, `POST/DELETE .../friends/:userId/:friendId`, `GET .../list/:namespace/:userId/recentPlayers`, `GET /friends/api/v1/:userId/settings` |
| `routes/party.ts` | `POST /party` (poll), `GET /party/invites`, `PUT /party/invite`, `PUT /party/invite/accept/:inviteId`, `DELETE /party/invite`, `DELETE /party/member[/:memberId]`, `PUT /party/member/promote/:memberId`, `DELETE /party/leader/:leaderId`, `POST /party/status` |
| `routes/guild.ts` | The eleven v2 guild routes: `GET /guild`, `GET /guild/invite/player`, `POST /guild/validate`, `POST /guild` (game server only), `DELETE /guild/player[/:accountId]`, `PUT /guild/invite/:accountId`, `POST /guild/invite/accept/:inviteId`, `DELETE /guild/invite/:inviteId`, `PUT /guild/rank/:accountId/:rank`, `DELETE /guild/:guildId`; `GUILDS=0` disables |
| `routes/slayerlinks.ts` | `GET /slayerlink/status_good`, `GET /slayerlink/invites`, `GET /slayerlink/links`, `PUT/POST /slayerlink/invite`, `DELETE /slayerlink/invites/:accountId`, `DELETE /slayerlink/links`, `POST /slayerlink/availability` |
| `routes/matchmaking.ts` | `POST /candidate/join[/:candidateId]`, `GET /candidate/status`, `GET /candidate/regions`, `POST /candidate/player/alive`, `POST /candidate/player/register`, `DELETE /candidate[/leave]` (only `MATCHMAKING_CANCEL=1`), `POST /key/generate`, `GET /QoS`; uses `QOS_TARGET_URL`, `TARGET_CHANGELIST` |
| `routes/store.ts` | `GET /balance`, `POST /reconcile`, `GET /creator`, `GET /store-images/:file`, `GET /product/skus/public`, `GET /product/sku/:skuId`, `GET /token/:currency/:skuId`, `POST /notification/:currency` |
| `routes/trials.ts` | `POST /trials/leaderboards` (aggregate query, or a game-server run submission when the body has `completion_time`), `.../all`, `.../solo`, `.../solo/individual`, `.../group`, `.../group/individual` |
| `routes/tuning.ts` | `GET /game_tuning/seasonal_event_schedule` (current Trials window when `TRIALS_SCHEDULE` is on, else a stub), `GET /game_tuning/huntpass_xp_config` |
| `routes/undauntedapi.ts` | `/undaunted/api/*`: `Register`, `UsernameAvailable`, `RegistrationStatus` (GET public, POST admin), `GetUserInfo`, `ServerStatus` (`SoftAccountAuth`), `PublicOnlineStats`, `HuntRegion` (GET/POST), `PlayingEnded`, `PartyInvite`, `Friends`, `GuildInvite` (user key); admin: `InviteCodes`, `RegisterInviteCode`, `InviteCode/:code` (DELETE), `CreateInvite`, `RenameUser`, `GenerateJWTForUserId`, `GetAllUsers`, `PrivateOnlineStats`, `SaveHistory`, `RollbackCharacter`, `RollbackLoadout`, `Progression`, `SeedProgression`, `GrantEntitlement`, `RevokeEntitlement`, `DisbandGuild`, `Guilds`, `Moderation[/:accountId]`, `DiscordLink[/:discordId]`, `DiscordKeyStats`, `BackendHealth`, `DashboardAccounts` (`DEVELOPER_ACCOUNT_IDS`), `AccountRecovery/:userId` |
| `routes/backup.ts` | `POST /internal/backup {name: YYYY-MM-DD_HHMMSS}`: direct-local caller + game-server key; SQLite online backup (`$client.backup`) to `BACKUP_ROOT/<name>/undaunted.db`, one at a time, 15 min deadline |
| `routes/keyrotation.ts` | `POST /internal/key-recovery/:action` (`link`, `begin`, `confirm`) for the Discord bot; `KeyRecoveryAuth` |

### `src/controllers/`

| File | What it does | Tables / env |
|---|---|---|
| `controllers/auth.ts` | `SignMetagameJWTForUid`, `ValidateMetagameJWTAndGetPayload` (RS256, 24 h, epoch + ban check), `HashUserAPIKey`, `GetUserIDForAPIKey` (constant-time scan of all hashes), `DrainAndRegisterUserAPIKeys` | `userapikeys`, `userapikeystoregister`; `AUTH_SIGNING_*_B64` |
| `controllers/apikeys.ts` | Game-server keys: `DrainAndRegisterAPIKeys`, `IsValidGameserverAPIKey` | `gameserverapikeys`, `gameserverapikeystoregister` |
| `controllers/accounts.ts` | Username rules (3-16 `[A-Za-z0-9_]`, case-insensitive unique), `RegisterAccount`, `RenameAccount`, invite generation (`GenerateInviteCode`, `MAX_INVITE_USES`), error bodies | `users`, `userapikeys`, `invitecodes`, `characters` |
| `controllers/undauntedapi.ts` | Registration mode (`REGISTRATION_MODE`), invite-code CRUD and atomic consume, `GetUserInfoForApiKey`, heartbeat activity/location tracking (90 s online, 10 min grace) | `users`, `userapikeys`, `invitecodes`; `AUTH_MODE` |
| `controllers/login.ts` | Account lookups that never throw: `FindAccount`, `FindAccountByUsername`, `DisplayNameForUserId` (`ACCOUNT_DISPLAY_NAME=0` restores `{}`), `IsAccountIdShape` (`UID-<uuid>`) | `users` |
| `controllers/accountrecovery.ts` | `ACCOUNT_KEY_RECOVERY=1`: `RememberAccountKey` stores the account key AES-256-GCM encrypted (key derived from `AUTH_SIGNING_PRIVKEY_B64`); `RecoverAccountKey` for admin `AccountRecovery` (non-admin accounts only) | `accountkeyrecovery` |
| `controllers/keyrotation.ts` | Discord-driven key rotation: `ProveRecoveryLink` (bot proves a Discord user holds the key), `BeginKeyRecovery` (5 min challenge), `CompleteKeyRecovery` (new `UUK_` key, epoch +1, emits `KeyRevocations`); 5 attempts / 15 min | `recoveryproofs`, `recoverychallenges`, `recoveryevents`, `authepochs`, `discordlinks`, `userapikeys` |
| `controllers/discordlinks.ts` | `LinkDiscordAccount`, `DiscordAccount` (admin-only, additive) | `discordlinks` |
| `controllers/discordstats.ts` | `DiscordKeyStats`: counts linked accounts and summarises the bot's claim file against invite codes | `discordlinks`, `invitecodes`; `DISCORD_KEY_STATE_FILE` |
| `controllers/moderation.ts` | Bans: `BanFor`, `CheckPlayerAccess` (403 `account_banned`), `SetAccountBan` (admins protected; address must be currently observed), `ModerationInfo`; play addresses kept in memory only (90 s) | `account_bans`, `moderation_events`, `users` |
| `controllers/character.ts` | Character CRUD: `CreateCharacterForUid`, `UpdateCharacterForUid` (version check + history in one tx, identical retry acknowledged), `ProcessTriggers` | `characters`; `TARGET_CHANGELIST` |
| `controllers/activecharacter.ts` | `GetActiveCharacter`: the account's last-saved character (for store and balance routes) | `characterhistory`, `characters` |
| `controllers/savehistory.ts` | Versioned saves: `RecordCharacterVersion`, `RecordLoadoutVersion`, retention (keep N + hourly + daily), `GetSaveHistory`, `RollbackCharacter`, `RollbackLoadout` | `characterhistory`, `loadouthistory`, `characters`, `loadouts`; `SAVE_HISTORY_KEEP/HOURLY/DAILY` |
| `controllers/inventory.ts` | `RunInventoryTransaction` / `ApplyInventoryTransactionInTx`: idempotent inventory transactions (dedupe by id + body hash), overspend clamp, append-only item log, daily token top-up (`SetDailyTokensOnce`), hunt platinum and pass-reward checks | `inventories`, `inventorytransactions`, `inventorylog`, `characters`, `onetimejobs`; `BOUNTY_TOKENS_DAILY`, `PATROL_BONUS_DAILY`, `INVENTORY_REFUSE_OVERSPEND`, `INVENTORY_REPORT_REMOVALS` |
| `controllers/loadout.ts` | Loadout blobs and real-mode slots (`UnlockLoadoutSlots`, `SetActiveLoadoutSlot`, six-slot ceiling) | `loadouts`, `loadoutslots` |
| `controllers/progression.ts` | Encountered content and breadcrumbs per character | `encounteredcontent`, `breadcrumbs` |
| `controllers/progressionmode.ts` | `IsRealProgressionAccount` (`PROGRESSION_MODE` real default / stub, `PROGRESSION_REAL_ACCOUNTS`) | - |
| `controllers/progressionconfig.ts` | Loads/serves the progression config (bundled JSON or `PROGRESSION_CONFIG_DIR`), `GetActiveHuntPass` (`ACTIVE_HUNT_PASS`), `CheckProgressionConfig` | - |
| `controllers/progressionrank.ts` | Client-identical rank math: `ComputeEarnedRanks`, `TotalXpToMaxRank`, `PremiumGatingEntitlement` | - |
| `controllers/progressionevents.ts` | Shared real-mode helpers: `RecordProgressionEvent` (audit row), lenient `ReadInteger`/`ReadField`, `CallerOf` | `progression_events`, `users` |
| `controllers/realprogression.ts` | Real-mode tracks and objectives: `GrantProgression` (increments, `PROGRESSION_GRANT_CAP`), `ConfirmRank`, `ResetTrack`, Hunt Pass selection, `SeedProgression` | `progress_tracks`, `objectives`, `huntpassselection`, `progression_events`, `characters` |
| `controllers/entitlements.ts` | Real-mode entitlements: defaults (`ENTITLEMENTS_DEFAULT`), timed (hours), `GrantEntitlementInTx`, `RevokeEntitlementInTx`, `HasActiveEntitlement` | `entitlements` |
| `controllers/cooldowns.ts` | Real-mode cooldowns (opaque id + absolute ISO start) | `cooldowns` |
| `controllers/bounties.ts` | Real-mode bounty board: partial upsert, delete on claim/abandon. Ancestor of the bounty key spelling in 1.14.7 `ParadoxBackend/src/bountyState.ts` | `bounties`, `bountydraft` |
| `controllers/huntpassseason.ts` | `SelectHuntPassSeason` (schedule rotation), `IsHuntPass`, `HuntPassPrice` (500/950), `SeasonRewards` (adds platinum to pass ranks in earned mode) | - |
| `controllers/huntpassrewards.ts` | `AuthorizePassRewards`: in earned mode only currently earned pass cosmetics/platinum may enter inventory | `huntpassplatinum`, `progress_tracks` |
| `controllers/huntplatinum.ts` | `ReadHuntCompletion` (parses the DLL's `x-dauntless-hunt-completion` header), `ReserveHuntPlatinum` (10 per hunt, 30 Escalation, once per completion) | `huntcompletions` |
| `controllers/escalation.ts` | Escalation snapshots (`ESCALATION_MODE=real`): canonicalise, validate against the registry, save; `ESCALATION_STRICT` refuses rule breaks (port of Harmonic's fork) | `escalationprogression`, `escalationtalents`, `escalationunlocks` |
| `controllers/escalationConfig.ts` | Loads and validates `vendor/escalation/seasons.json`; `GetEscalationSeason`, `ExperienceForNextLevel`, `TalentRankCost` | - |
| `controllers/freestore.ts` | Store service: offers per tag, purchase tokens (hash stored, per-window limit), `RedeemStorePurchase` grants via inventory, Middleman weekly offers, `PruneExpiredStorePurchases`; `STORE_CATALOG_PROFILE` | `storepurchases`, `characters`, `inventories` |
| `controllers/store.ts` | Balance sheet: `GetNotesForUser`, `GetHeldCurrencies`, `OverlayHeldCurrencies` (`BALANCE_FROM_INVENTORY`) | `inventories`, `users` |
| `controllers/storerevocation.ts` | `RevokeStorePurchasesBefore(cutoff, apply)`: undo free-store grants (items + `store:` entitlements) before a cutoff; refuses paid purchases | `storepurchases`, `inventories`, `inventorylog`, `entitlements` |
| `controllers/middleman.ts` | Middleman cell-fusion token rules: slot-stable ids (slots 1-3), allowed speed-ups, lenient claim removal, optional `ValidateFusionCompletions` (`MIDDLEMAN_FUSION_GUARDS`) | - |
| `controllers/friends.ts` | Friends and blocks (limits, rate window, listeners for chat presence) | `friendships`, `blocks`, `guildinvites`, `slayerlinkinvites`, `users` |
| `controllers/party.ts` | In-memory parties and invites (size, TTLs, rate limits, leader/kick/promote, candidate link to matchmaking); `PARTY_SOLO_STUB` | - |
| `controllers/guild.ts` | Guilds: v2 envelope replies, validate/create tickets, invites with TTL, ranks, disband, name denylist. **Ported to 1.14.7 as `ParadoxBackend/src/controllers/guild.ts`** | `guilds`, `guildmembers`, `guildinvites`, `users`; `GUILD_MAX_MEMBERS`, `GUILD_INVITE_TTL_DAYS`, `GUILD_RESERVED_NAMES`, `GUILD_NAME_DENYLIST`, `GUILD_CREATE_ACTIVITY_FALLBACK` |
| `controllers/slayerlinks.ts` | Slayer Links: 3 slots, invite expiry, week-long links, availability. **Contract ported to 1.14.7 `ParadoxBackend/src/slayerLinks.ts`** | `slayerlinkinvites`, `slayerlinks`, `users` |
| `controllers/trials.ts` | Weekly Trials pick (seeded per cycle, mirrors DeployServer + DLL), Bronze/Silver/Gold ranks, `SaveTrialRun`, leaderboards, `FinalizeCompletedTrialWeeks` (Top-100 entitlement), leaderboard profiles | `trialruns`, `trialweeks`, `leaderboardprofiles`, `cooldowns`, `inventories`; `TRIAL_ROTATION_START` |
| `controllers/matchmaking.ts` | Queues, party candidates, rejoin parking, capacity waits, `LaunchGameOnDeployserver`, `HandlePlayerMatchmaking` | `DEPLOYSERVER_URL`, `MATCHMAKING_MODE`, `MATCHMAKING_DEPLOY_TIMEOUT_MS` |
| `controllers/matchmakingroster.ts` | `MatchmakingRoster` / `CandidateRoster`: waiting-place leases, loading grace, connected-player absence grace, restore after refusal | - |
| `controllers/huntregion.ts` | Region types `main/aus/ger/us`, `PartyRegion` (`mixed` when members differ), `RegionQueueKey` | - |
| `controllers/regionpreferences.ts` | `GetHuntRegion` / `SaveHuntRegion`; registers itself as the region reader | `huntregions` |
| `controllers/regionprobes.ts` | `RegionProbes()`: TCP probe endpoints for the launcher (`AUS_REGION`, `GERMANY_REGION`, `US_REGION`, `REGION_<R>_PROBE_HOST/PORT`) | - |
| `controllers/serverstatus.ts` | `GetServerStatus`: full (registered) or limited view of players and game servers from DeployServer `GET /gameservers`, titles, server identity | `users`; `SERVER_NAME`, `SERVER_VERSION`, `SOURCE_URL`, `GIT_COMMIT`, `CONTENT_PORT`, `DEPLOYSERVER_URL` |

### `src/middleware/`

| File | What it does |
|---|---|
| `middleware/HasUndauntedMetagameAuth.ts` | Main auth: bearer JWT or game-server key -> `req.AuthData {userId?, IsGameserver}` |
| `middleware/PlayerAuth.ts` | `PlayerTokenOnly` (must name a player via token), `SoftMetagameAuth` (optional token), `SoftPlayerOf` |
| `middleware/GameServerKeyAuth.ts` | Game-server key required (403 otherwise); a bearer is read softly into `ForwardedUserId` for logs only. Used by `POST /guild` |
| `middleware/GameServerOnly.ts` | `RefuseUnlessGameserver` (403 for players on game-server-only writes), `NoteRelayedAccountMismatch` (log only) |
| `middleware/HasUndauntedUserApiKey.ts` | Account key header -> `req.UndauntedUserInfo`; calls `RememberAccountKey` |
| `middleware/HasUndauntedAdminApiKey.ts` | Account key of an admin, never proxied |
| `middleware/SoftAccountAuth.ts` | Marks registered callers (key or token) for ServerStatus; never 401 |
| `middleware/RealProgressionOnly.ts` | Skip route (404) for non-real accounts; `RefuseForeignPlayer`, `SendRealReply` |
| `middleware/RequestOrigin.ts` | Gateway trust, `ClientAddressOf`, `IsProxiedRequest`, `IsDirectLocalRequest`, `RefuseAdminKeyThroughProxy`, `RefuseProxiedInDevAuthMode`, `CheckGatewayConfig`; `GATEWAY_SECRET`, `GAMESERVER_ALLOW_FROM` |
| `middleware/RateLimits.ts` | `express-rate-limit` buckets: `LoginRateLimit`, `TokenVerifyRateLimit`, `PlayerMutationRateLimit`, `AdminMutationRateLimit`, `HealthReadRateLimit` |
| `middleware/BackendHealth.ts` | `TrackBackendHealth` request metrics, `BackendRuntimeHealth` for `/undaunted/api/BackendHealth` (`BACKEND_HEALTH=1`) |
| `middleware/BodyLog.ts` | `LOG_BODIES=1` JSON-lines body capture for listed routes (`BODY_ROUTES`), `Redact` for JWTs/keys, `BODY_LOG_PER_PATH` cap |

### `src/realtime/`

| File | What it does |
|---|---|
| `realtime/chat.ts` | `ChatServer` (WebSocket XMPP listener, SASL PLAIN with the JWT, sessions, pings, rate limits, hold-backs), `ReadChatConfig` (`CHAT`, `CHAT_PORT`, `CHAT_BIND_HOST`, `CHAT_NICK_CHECK`, `CHAT_TRACE`; warns on obsolete `EXPERIMENTAL_CHAT`), `StartChat` |
| `realtime/muc.ts` | `MucService`: rooms, occupants, membership checks, ghost-session replacement, block filtering |
| `realtime/presence.ts` | `FriendPresence`: relays a player's presence to accepted friends, friend-list push from `xmpp-admin@<domain>`, burst limit |
| `realtime/chatnick.ts` | Room nickname rules (`CheckNickname`, `UrlEncodeLikeClient`): `<name>:<own id>:<own resource>` only |
| `realtime/xmpp.ts` | XMPP helpers: `ParseFrame`, `ParseJid`, `EscapeXml`, token buckets, `RedactFrame` |

## DB schema (`db/schema.ts`, 51 tables)

| Table | Purpose |
|---|---|
| `users` | Account: `userId`, `name`, `notes` (Rams), `isAdmin` |
| `userapikeys` / `userapikeystoregister` | Hashed account key per user / plain keys queued for the next boot |
| `gameserverapikeys` / `gameserverapikeystoregister` | Hashed game-server keys / plain keys queued for the next boot |
| `invitecodes` | Invite code, uses remaining, infinite flag |
| `authepochs` | Token epoch per user (bumped on key rotation) |
| `recoveryproofs`, `recoverychallenges`, `recoveryevents` | Discord key-recovery proofs, 5 min challenges, rate-limit/audit log |
| `accountkeyrecovery` | Encrypted account key for admin recovery |
| `discordlinks` | Discord id <-> account |
| `account_bans`, `moderation_events` | Current ban per account (optional address) / append log of ban changes |
| `player_addresses` | Unused since 0024 (addresses now kept in memory) |
| `huntregions` | Preferred hunt region per user (`main/aus/ger/us`) |
| `characters` | Character data blob, name, `updateVersion` |
| `characterhistory`, `loadouthistory` | Saved versions for rollback |
| `inventories` | Stacked and instanced items JSON per character |
| `inventorytransactions` | Stored result per applied transaction (retry dedupe) |
| `inventorylog` | Append-only item change log (triggers block UPDATE/DELETE) |
| `loadouts`, `loadoutslots` | Loadout blobs / unlocked slot counts and active slot |
| `breadcrumbs`, `encounteredcontent` | Per-character UI breadcrumbs / encountered content |
| `progress_tracks`, `objectives` | Real-mode track XP / objective state |
| `progression_events` | Append-only audit of real-mode writes (triggers block UPDATE/DELETE) |
| `huntpassselection`, `huntpassplatinum` | Selected Hunt Pass / platinum already paid from pass ranks |
| `entitlements` | Entitlements with duration and revoke date |
| `cooldowns`, `bounties`, `bountydraft` | Real-mode cooldowns, bounty elements, bounty draft |
| `friendships`, `blocks` | Friend pairs (sorted ids, PENDING/ACCEPTED) / blocks |
| `guilds`, `guildmembers`, `guildinvites` | Guilds, one guild per account with rank, open invites |
| `slayerlinkinvites`, `slayerlinks` | Slayer Link invites / active links |
| `escalationprogression`, `escalationtalents`, `escalationunlocks` | Escalation snapshot, talent ranks, collected rewards |
| `storepurchases` | Store purchase tokens (hash, offer hash, redeemed date) |
| `trialruns`, `trialweeks`, `leaderboardprofiles` | Trials runs, finalized weeks, leaderboard display identity |
| `huntcompletions` | Hunt platinum paid per account and completion id |
| `onetimejobs` | One-time startup data jobs already run |

## Migrations (`src/drizzle/`)

Applied in order by `migrate()` using `meta/_journal.json` (journal lists 0000-0029; `meta/*_snapshot.json` stop at 0016, so `npm run db:generate` diffs against a stale snapshot).

| File | Change |
|---|---|
| `drizzle/0000_natural_korg.sql` | Create `characters`, `inventories`, `users` |
| `drizzle/0001_slow_storm.sql` | Create `loadouts` |
| `drizzle/0002_gorgeous_saracen.sql` | Create `gameserverapikeys`, `gameserverapikeystoregister` |
| `drizzle/0003_slippery_blackheart.sql` | Create `breadcrumbs` |
| `drizzle/0004_silky_lady_mastermind.sql` | Add `loadouts.persistent` |
| `drizzle/0005_mighty_zeigeist.sql` | Create `encounteredcontent` |
| `drizzle/0006_woozy_slipstream.sql` | Create `userapikeys`, `userapikeystoregister` |
| `drizzle/0007_last_maximus.sql` | Create `invitecodes` |
| `drizzle/0008_vengeful_spirit.sql` | Add `users.isAdmin` |
| `drizzle/0009_nice_dazzler.sql` | Rebuild `users` (isAdmin declared boolean default 0) |
| `drizzle/0010_save_history_and_item_log.sql` | Create `characterhistory`, `loadouthistory`, `inventorytransactions`, `inventorylog` + no-update/no-delete triggers |
| `drizzle/0011_real_progression.sql` | Create `progress_tracks`, `objectives`, `progression_events` (+ triggers), `huntpassselection`, `entitlements`, `cooldowns`, `bounties`, `bountydraft`, `loadoutslots` |
| `drizzle/0012_friends_and_blocks.sql` | Create `friendships`, `blocks` |
| `drizzle/0013_guilds.sql` | Create `guilds` (unique name/nameplate keys), `guildmembers`, `guildinvites` |
| `drizzle/0014_escalation.sql` | Create `escalationprogression`, `escalationtalents`, `escalationunlocks` |
| `drizzle/0015_store_purchases.sql` | Create `storepurchases` |
| `drizzle/0016_slayer_links.sql` | Create `slayerlinkinvites` (one pending per pair), `slayerlinks` |
| `drizzle/0017_discord_links.sql` | Create `discordlinks` |
| `drizzle/0018_trials_leaderboards.sql` | Create `trialruns`, `trialweeks` |
| `drizzle/0019_trials_profiles.sql` | Create `leaderboardprofiles` |
| `drizzle/0020_hunt_regions.sql` | Create `huntregions` |
| `drizzle/0021_onetime_jobs.sql` | Create `onetimejobs` |
| `drizzle/0022_germany_region.sql` | Rebuild `huntregions` to allow `ger` |
| `drizzle/0023_moderation.sql` | Create `player_addresses`, `account_bans`, `moderation_events` |
| `drizzle/0024_ephemeral_addresses.sql` | Delete all `player_addresses` rows |
| `drizzle/0025_inventory_expiry_index.sql` | Index `inventorytransactions` by created date |
| `drizzle/0026_account_key_recovery.sql` | Create `accountkeyrecovery` |
| `drizzle/0027_player_key_rotation.sql` | Create `recoveryproofs`, `recoverychallenges`, `authepochs`, `recoveryevents` |
| `drizzle/0028_us_region.sql` | Rebuild `huntregions` to allow `us` |
| `drizzle/0029_hunt_completions.sql` | Create `huntcompletions`, `huntpassplatinum` |

## Connects to

| Peer | How |
|---|---|
| [Gateway](legacy-1.4.4-gateway-deploy.md) | gateway proxies to `127.0.0.1:61000`; chat upgrades to `:61099`; sends `X-Dauntless-Gateway` |
| [DeployServer](legacy-1.4.4-gateway-deploy.md) | outbound HTTP to `DEPLOYSERVER_URL` (loopback); DeployServer reads `GET /undaunted/api/ServerStatus` with `CITY_STATUS_KEY` as the account key header (Ramsgate balancing) |
| [Internal server DLL](legacy-1.4.4-internal-server.md) | game servers and clients call the routes above; the DLL adds `x-undaunted-gameserver-apikey`, `x-dauntless-hunt-completion`, `x-dauntless-game-session-id`, `x-dauntless-connected-player-ids` headers |
| [Launcher](legacy-1.4.4-launcher.md) | `Register`, `GetUserInfo`, `ServerStatus`, `HuntRegion` with the account key header |
| Content server | validates account keys with `GET /undaunted/api/GetUserInfo` (`METAGAME_URL`) |
| Discord bot | admin key over loopback: `InviteCodes`, `RegisterInviteCode`, `DiscordLink`, `GetUserInfo`; key recovery via `/internal/key-recovery/*` |

## Config

Names only; defaults in `.env.example` and `src/features.ts`.

- Core: `PORT` (61000), `BIND_HOST` (127.0.0.1), `AUTH_MODE` (`APIKEY` or dev `NONE`), `AUTH_SIGNING_PRIVKEY_B64`, `AUTH_SIGNING_PUBKEY_B64`, `REGISTRATION_MODE`, `DB_FILENAME`, `DB_WAL`, `NODE_ENV`, `LOG_LEVEL`, `LOG_REQUESTS`, `LOG_BODIES`, `BODY_LOG_FILE`, `BODY_LOG_PER_PATH`, `BACKEND_HEALTH`.
- Matchmaking: `MATCHMAKING_MODE` (`DEPLOYSERVER` or `DISABLED`), `DEPLOYSERVER_URL` (host:port, no scheme), `QOS_TARGET_URL`, `TARGET_CHANGELIST`, `MATCHMAKING_DEPLOY_TIMEOUT_MS`, `MATCHMAKING_CANCEL`, `AUS_REGION`, `GERMANY_REGION`, `US_REGION`, `REGION_<MAIN|AUS|GER|US>_PROBE_HOST/PORT`.
- Public mode: `GATEWAY_SECRET`, `GAMESERVER_ALLOW_FROM`.
- Progression: `PROGRESSION_MODE` (`real` default or `stub`), `PROGRESSION_REAL_ACCOUNTS`, `PROGRESSION_CONFIG_DIR`, `ACTIVE_HUNT_PASS`, `PROGRESSION_GRANT_CAP`, `PROGRESSION_CONFIRM`, `PROGRESSION_ALLOW_DELETE`, `ENTITLEMENTS_DEFAULT`.
- Switches in `features.ts` (default): `STORE` (`earned`; `free`/`off`), `STORE_REPEATABLE_TOKENS` (off), `TRIALS_STORE` (on), `MIDDLEMAN_STORE` (on), `MIDDLEMAN_FUSION_GUARDS` (off), `ESCALATION_MODE` (`stub`; `real`), `ESCALATION_STRICT` (off), `PROGRESSION_REPLAY_WINDOW_S` (5), `PROGRESSION_CONFIRM_ENTITLEMENTS` (off), `BALANCE_FROM_INVENTORY` (on), `TRIALS_LEADERBOARDS` (on), `TRIALS_SCHEDULE` (off), `SLAYER_LINKS` (on), `CHAT_PRESENCE` (on), `VERIFY_STUB_ACCOUNT` (off). On/off values `1/true/on/yes` and `0/false/off/no`; bad values warn once and use the default.
- Chat: `CHAT`, `CHAT_PORT`, `CHAT_BIND_HOST`, `CHAT_NICK_CHECK`, `CHAT_TRACE`.
- Guilds: `GUILDS`, `GUILD_MAX_MEMBERS`, `GUILD_INVITE_TTL_DAYS`, `GUILD_RESERVED_NAMES`, `GUILD_NAME_DENYLIST`, `GUILD_CREATE_ACTIVITY_FALLBACK`.
- Compatibility rollbacks: `MISC_ROUTES`, `ACCOUNT_MAPPING`, `ACCOUNT_DISPLAY_NAME`, `ACCOUNTINFO_PUBLIC_LEGACY`, `PARTY_SOLO_STUB`, `STATUS_EXTRA`.
- Misc: `SAVE_HISTORY_KEEP/HOURLY/DAILY`, `BACKUP_ROOT`, `BOUNTY_TOKENS_DAILY`, `PATROL_BONUS_DAILY`, `INVENTORY_REFUSE_OVERSPEND`, `INVENTORY_REPORT_REMOVALS`, `STORE_CATALOG_PROFILE`, `TRIAL_ROTATION_START`, `ACCOUNT_KEY_RECOVERY`, `KEY_RECOVERY_SERVICE_SECRET`, `DISCORD_KEY_STATE_FILE`, `DEVELOPER_ACCOUNT_IDS`, `SERVER_NAME`, `SERVER_VERSION`, `SOURCE_URL`, `GIT_COMMIT`, `CONTENT_PORT`.

## Ancestry of 1.14.7 features

- Guilds: `controllers/guild.ts` -> `versions/1.14.7/ParadoxBackend/src/controllers/guild.ts`.
- Slayer Links contract: `controllers/slayerlinks.ts` -> `ParadoxBackend/src/slayerLinks.ts`.
- Bounty body key spelling: `controllers/bounties.ts` -> `ParadoxBackend/src/bountyState.ts`.
- Lady Luck catalogue: the 1.4.4 capture seeded the 1.14.7 store registry (`ParadoxBackend/src/controllers/storeRegistry.gamedata.test.ts`).

## Gotchas

- **Restart needed for queued keys.** Keys inserted by hand into `*toregister` only work after the next boot's drain. Registration keys work at once.
- **SQLite, not Mongo.** Do not look for repositories or collections; queries are Drizzle plus raw `db.$client.prepare(...)` SQL.
- **Migrations run from `./src/drizzle`**, relative to the working directory. Start the process from the package root (`npm start` does).
- **Backups.** WAL is off by default so a copy of a stopped file is consistent; the kit stops node with a hard kill. `POST /internal/backup` makes a live copy with SQLite's online backup API instead.
- **Progression modes** change what GET routes return; mixing real and stub breaks ranks. The default is real.
- **`express.json({limit: "50mb"})`** on every route; the gateway's 128 KiB cap applies only in public mode.
- **Name drift:** log lines and package say "Dauntless Revived" ("Clear Skies, Slayer." is the ready line).
- Tests: `npm test` compiles `tsconfig.test.json` to `build/` and runs `node --test`.

## See also

[index](index.md) - [legacy-1.4.4](legacy-1.4.4.md) - [legacy-1.4.4-internal-server](legacy-1.4.4-internal-server.md) - [legacy-1.4.4-gateway-deploy](legacy-1.4.4-gateway-deploy.md) - [legacy-1.4.4-launcher](legacy-1.4.4-launcher.md) - [backend](backend.md) - [backend-realtime](backend-realtime.md) - [backend-persistence](backend-persistence.md)
