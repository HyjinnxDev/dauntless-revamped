# ParadoxBackend persistence

> Verified against code 2026-10-24.

## What it is

Everything the backend stores lives in one MongoDB database (default name `mystpax`). The code in `src/persistence/` gives the rest of the backend a "repository" layer (interfaces plus Mongo implementations), a transaction wrapper, and a startup step that creates indexes and records a schema version. SQLite and the old shadow-read layer are gone; Mongo is the only provider. Not every feature goes through repositories: newer features (guilds, Gauntlet, Slayer Links, hunt stats, character slots, launcher card, operations policy, the staff dashboard) open collections directly with `GetMongoDb()`. A few small things are in memory or on disk instead (see [Non-Mongo state](#non-mongo-state)).

Hand-run data scripts, migrations and game-data generators: see [backend scripts](backend-scripts.md).

## File reference

All paths are under `versions/1.14.7/ParadoxBackend/src/persistence/`.

| File | What it does |
|---|---|
| `persistence/index.ts` | Composition root. `GetRepositories()`, `GetUnitOfWork()`, `GetPersistenceLifecycle()` (each a cached singleton); re-exports every contract, the domain types and `InventoryTransactionAlreadyExistsError`. |
| `contracts/UnitOfWork.ts` | `RepositoryProvider` (the 25 named repositories), `UnitOfWork.withTransaction`, `PersistenceLifecycle` (`start`/`isHealthy`/`stop`). |
| `contracts/*Repository.ts` | One interface per repository, plus record types only that repository uses (see [Repositories](#repositories)). |
| `mapping/domainTypes.ts` | Shared record types: `AccountRecord`, `CharacterRecord`, `InventoryRecord`, `InventoryTransactionRecord`, `LoadoutRecord`, `WalletRecord`, `EntitlementRecord`, `PlayerJourneyRecord`, `BreadcrumbsRecord`, `EncounteredContentRecord`, API-key records, `ProgressionTrackRecord`, `ProgressionGrantRecord`, `StoredBounty`/`BountyStateRecord`, `CooldownStateRecord`, `EscalationProgressRecord`, `ProgressionObjectiveRecord`, `ProgressionObjectiveEventRecord`. |
| `mongo/client.ts` | Single pooled `MongoClient` (`GetMongoClient` caches the connect promise so racing callers share one pool; a failed connect clears it), `GetMongoDb()`, `AssertMongoProductionTopology`, `MongoPersistenceLifecycle` (start = connect, `ping`, `hello`, topology check, `EnsureMongoIndexes`; `isHealthy` = ping + hello + topology). |
| `mongo/collections.ts` | The `Collections` name table. Add new collection names here. |
| `mongo/indexes.ts` | `EnsureMongoIndexes()`: schema-version check, `operationsPolicy` seed, every secondary and TTL index, idempotent backfills (incl. `MoveLegacyHuntPassProgress`: old `seasonNN:<pass>` hunt pass rows -> `huntpass:<season>:<pass>`, copy then delete, never overwriting), P2P extension hook, then the schema marker. |
| `mongo/schemaMigrations.ts` | `CURRENT_MONGO_SCHEMA_VERSION`, `MONGO_SCHEMA_MIGRATION_ID`, `EnsureMongoSchemaMigrationIndex`, `RecordMongoSchemaMigration` (compare-and-set upgrade), `AssertMongoSchemaVersionSupported`. |
| `mongo/MongoUnitOfWork.ts` | `withTransaction()`: one session, `readPreference: primary`, majority read/write concern, `maxCommitTimeMS` from `config/mongoRuntime.ts`. |
| `mongo/index.ts` | `CreateMongoRepositoryProvider()` wires the 25 repositories. `friendships` is wrapped in `CharacterAwareFriendships` (`src/characterSlots.ts`) so edges are stored between account owners. |
| `mongo/repositories/Mongo*Repository.ts` | The implementations (see [Repositories](#repositories)). |
| `mongo/client.test.ts`, `mongo/schemaMigrations.test.ts`, `mongo/inventoryTransactionMonitor.test.ts` | Unit tests: production topology check, schema-marker compare-and-set, ledger `complete()` extras cannot overwrite core fields. |

Related files outside this folder: `src/config/mongoRuntime.ts` (pool/timeout env vars with hard bounds), `src/encryptionKeyStore.ts` (in-memory UDP keys), `src/characterSlots.ts` (`OwnerOf`, `CharacterAwareFriendships`).

## How it works

### Startup

1. `MongoPersistenceLifecycle.start()` connects (`MONGODB_URI`, required), runs `ping`, then `hello`.
2. In production (`NODE_ENV=production`) it refuses to start unless the server is a replica set with a writable primary (`MONGODB_PRODUCTION_REPLICA_SET_PRIMARY_REQUIRED`). Transactions need a replica set. Outside production a standalone mongod is accepted, but transactions will then fail. The live host runs `rs0` on port 27018 (see `scripts/init-replset.cjs` in [backend scripts](backend-scripts.md), and [setup](setup.md)).
3. `EnsureMongoIndexes()` runs: create the migration-ledger index, check the stored schema version is supported, seed the `operationsPolicy` singleton with `$setOnInsert` (never overwrites), create indexes, run the idempotent backfills, let the optional P2P extension create its own collections (`GetP2PExtension().server.ensureDatabase`), and only then write the schema-version marker.
4. Because the marker is written last, a crash mid-way is simply retried at next start.

### Schema version

- One marker document in `schemaMigrations`: `_id: "central-guard-schema-v1"`, `version`, `status: "APPLIED"`, `appliedAt`. Unique index on `version`.
- `CURRENT_MONGO_SCHEMA_VERSION = 1`. It is separate from the app version, so a binary can be rolled back while the database keeps its additive schema.
- `AssertMongoSchemaVersionSupported` throws `MONGODB_SCHEMA_VERSION_UNSUPPORTED` if the stored version is higher than the binary knows, not a safe integer, or the marker exists without a version. An old binary therefore will not start on a newer DB.
- `RecordMongoSchemaMigration` upgrades an older marker with a compare-and-set on the observed version. A lost race is accepted only if the winner wrote the same version, else `MONGODB_SCHEMA_MIGRATION_CONFLICT`. A first insert ignores duplicate-key (another process won).
- Adding a migration: put idempotent work in `EnsureMongoIndexes()` before the marker. Bump the version only when an older binary must be locked out.

### Startup backfills (in `EnsureMongoIndexes`)

| Backfill | Effect |
|---|---|
| Legacy wallets | Wallets whose `balances` is a JSON string are converted to a BSON number map via `MongoWalletRepository.migrateLegacyStringBalances` (unparseable = empty wallet). |
| `playerJourney.revision` | Sets `revision: 0` where missing. |
| Launcher account names | Accounts with `displayNameNormalized` but no `name` get `name = displayName`, `notes = 0` (otherwise the game shows the raw userId). |

### Repositories and transactions

- Controllers call `GetRepositories().<name>`; each repository resolves `GetMongoDb()` lazily.
- `GetUnitOfWork().withTransaction(fn)` opens a session and runs `fn(repos, session)` in `withTransaction`. The session is not injected automatically: pass `session` to each repository call that should be atomic. `fn` can be retried by the driver, so it must have no side effects outside the session.
- Optimistic concurrency is used instead of locks:
  - Characters: `updateDataConditional` only writes when the stored `updateVersion` is lower (`$lt`).
  - Inventory, loadouts, player journey: `revision` compare-and-set; rows without `revision` count as 0; each write bumps it by one.
  - Bounty, cooldown and escalation state: `saveIfVersion` replaces only when `updateVersion` equals the expected one; `undefined` means insert-only (duplicate key returns `undefined`).
  - Wallets: atomic `$inc` on `balances.<currency>`; a debit filter (`$gte`) stops a negative balance. Currency ids are checked by `IsValidBalanceCatalogId` before becoming a field name.
  - Progression tracks: `$inc`/`$max` upserts; `spend` filters `progress >= amount`.
  - Parties: `replaceParty` filters on `revision`; a miss throws `PARTY_REVISION_CONFLICT`.
  - Inventory transactions: ledger `_id = sha256(JSON [userId, characterId, transactionId])` makes `POST /inventory` idempotent; a duplicate throws `InventoryTransactionAlreadyExistsError` carrying the stored row.
  - Progression grants: `progressionTransactions` with the grant id as `_id` (exactly-once).

## Repositories

`RepositoryProvider` key, the contract (`contracts/`) and the Mongo implementation (`mongo/repositories/`).
`?s` = method accepts an optional `session`; `s` = session required.

| Key | Contract + implementation | Collection | Methods |
|---|---|---|---|
| `accounts` | `contracts/AccountRepository.ts` + `repositories/MongoAccountRepository.ts` | `accounts` | `findByUserId` (returns `userId`, `name`, `notes` only), `create`. Game-side view of an account. |
| `launcherAccounts` | `contracts/LauncherAccountRepository.ts` + `repositories/MongoLauncherAccountRepository.ts` | `accounts` | `findByUserId(?s)` (only docs with `displayNameNormalized`; a character-slot id falls back to its owner via `OwnerOf`), `findByEmail`, `findByDisplayNameNormalized`, `create(?s)` (also seeds `name`, `notes: 0`), `updateLastLogin`, `setUsername` (also sets `name`, `usernameSet`), `listForAdmin` (filters + escaped regex search, newest first), `setAccessState` (approval/status/ban; clears `bannedUntil` unless banned), `updateRoles(?s)`. Types `AccountApprovalStatus`, `AccountOperationalStatus`. |
| `characters` | `contracts/CharacterRepository.ts` + `repositories/MongoCharacterRepository.ts` | `characters` | `findManyByUserId(?s)`, `findByCharacterIdAndUserId(?s)`, `create(?s)`, `updateDataConditional` (version-guarded). |
| `inventories` | `contracts/InventoryRepository.ts` + `repositories/MongoInventoryRepository.ts` | `inventories` | `findByCharacterId(?s)`, `create(?s)`, `updateBothIfRevisionMatches(?s)` (both JSON blobs, revision CAS, returns the new record). |
| `inventoryTransactions` | `contracts/InventoryTransactionRepository.ts` + `repositories/MongoInventoryTransactionRepository.ts` | `inventoryTransactions` | `tryBegin(s)` (insert pending row; throws `InventoryTransactionAlreadyExistsError` on duplicate), `complete(s)` (status `completed`, `result`, optional extra fields that cannot override core ones), `isCompleted`. Constructor takes a `getDb` for tests. |
| `loadouts` | `contracts/LoadoutRepository.ts` + `repositories/MongoLoadoutRepository.ts` | `loadouts` | `findByCharacterIdAndUserId(?s)`, `create(?s)`, `replaceSlotIfRevisionMatches`, `replaceAllAndEntitlementIfRevisionMatches` (slot count bounded by `loadoutSlots.ts`), `updatePersistentIfRevisionMatches`, `updateActiveIndexIfRevisionMatches` (returns true without a write when unchanged). All revision CAS. |
| `wallets` | `contracts/WalletRepository.ts` + `repositories/MongoWalletRepository.ts` | `wallets` | `findByUserId(?s)`, `create(?s)`, `createIfMissing(?s)` (balances only on insert; `bootstrapVersion` tag applied if given), `incrementBalance(?s)` (atomic, no negatives), `migrateLegacyStringBalances`. Exports `IsValidBalanceCatalogId`. |
| `entitlements` | `contracts/EntitlementRepository.ts` + `repositories/MongoEntitlementRepository.ts` | `entitlements` | `findByUserId(?s)`, `createIfMissing(?s)`, `grantIfMissing(?s)` (`$push` only when the name is absent). Exports `IsValidEntitlementName`. |
| `playerJourney` | `contracts/PlayerJourneyRepository.ts` + `repositories/MongoPlayerJourneyRepository.ts` | `playerJourney` | `findByUserId`, `createIfAbsent` (false on duplicate), `updateIfRevision` (revision CAS + `$inc`). |
| `breadcrumbs` | `contracts/BreadcrumbRepository.ts` + `repositories/MongoBreadcrumbRepository.ts` | `breadcrumbs` | `findByCharacterIdAndUserId`, `create`, `update` (blob + `updateVersion`, unconditional). |
| `encounteredContent` | `contracts/EncounteredContentRepository.ts` + `repositories/MongoEncounteredContentRepository.ts` | `encounteredContent` | `findByCharacterIdAndUserId`, `create`, `updateContent` (unconditional). |
| `apiKeys` | `contracts/ApiKeyRepository.ts` + `repositories/MongoApiKeyRepository.ts` | `gameServerApiKeys`, `userApiKeys` | `findAllGameServerKeyHashes`, `insertGameServerKeyHash`, `replaceGameServerKeyHashes` (upsert the given set, delete the rest; an empty list deletes all), `findAllUserKeyHashes`, `insertUserKeyHash`. `findAll*KeysToRegister` / `clear*KeysToRegister` are no-ops on Mongo. |
| `progressionTracks` | `contracts/ProgressionTrackRepository.ts` + `repositories/MongoProgressionTrackRepository.ts` | `progressionTracks`, `progressionObjectives`, `progressionObjectiveEvents` | `getAllForUser`, `get(?s)`, `increment(?s)` (`$inc` upsert), `setProgressIfGreater` (`$max`), `setConfirmedRank` (`$max` on the free or premium rank), `reset`, `spend(?s)` (no overspend), `appendObjectiveEvent`, `getAllObjectivesForUser`, `setObjectiveIfGreater` (`$max` on `value` and `completedCount`). |
| `progressionGrants` | `contracts/ProgressionGrantRepository.ts` + `repositories/MongoProgressionGrantRepository.ts` | `progressionTransactions` | `findByGrantId(?s)`, `insertApplied(s)`. |
| `escalationProgress` | `contracts/EscalationProgressRepository.ts` + `repositories/MongoEscalationProgressRepository.ts` | `escalationProgress` | `get(userId, seasonId)`, `saveIfVersion`. |
| `bountyStates` | `contracts/BountyStateRepository.ts` + `repositories/MongoBountyStateRepository.ts` | `bountyStates` | `get(?s)`, `saveIfVersion(?s)`. |
| `cooldownStates` | `contracts/CooldownStateRepository.ts` + `repositories/MongoCooldownStateRepository.ts` | `cooldownStates` | `get`, `saveIfVersion`. |
| `authIdentities` | `contracts/AuthIdentityRepository.ts` + `repositories/MongoAuthIdentityRepository.ts` | `authIdentities` | `findByProviderSubject(?s)`, `findByUserId(?s)`, `create(?s)`. Provider is only `"discord"`. |
| `refreshSessions` | `contracts/RefreshSessionRepository.ts` + `repositories/MongoRefreshSessionRepository.ts` | `refreshSessions` | `create` (sets `ttlAt`), `findByTokenHash`, `revokeById`, `revokeFamily`, `revokeAllForUser`, `isFamilyActive` (an unrevoked, unexpired row exists). |
| `gameExchangeCodes` | `contracts/GameExchangeCodeRepository.ts` + `repositories/MongoGameExchangeCodeRepository.ts` | `gameExchangeCodes` | `create` (`_id = codeHash`, `ttlAt`), `consumeByCodeHash` (atomic one-time consume if unexpired), `revokeUnusedForUser` (marks consumed + `revoked: true`). |
| `discordOAuthTransactions` | `contracts/DiscordOAuthTransactionRepository.ts` + `repositories/MongoDiscordOAuthTransactionRepository.ts` | `discordOAuthTransactions` | `create` (`_id = state`, `ttlAt` = expiry + 1 h), `consumeByState` (one-time), `attachCompletionCode`, `consumeByCompletionCodeHash` (one-time). |
| `admin` | `contracts/AdminRepository.ts` + `repositories/MongoAdminRepository.ts` | `adminSessions`, `adminAudit`, plus the delete cascade | `createSession`, `findActiveSessionByTokenHash`, `revokeSession`, `appendAudit(?s)`, `listAudit`, `deletePlayerData` and `deleteCharacterSlot` (each one transaction ending in an audit tombstone; see Gotchas). |
| `friendships` | `contracts/FriendshipRepository.ts` + `repositories/MongoFriendshipRepository.ts` (wrapped by `CharacterAwareFriendships`) | `friendships` | `listForOwner`, `find`, `upsert`, `remove`. Status `ACCEPTED`/`PENDING`/`BLOCKED`, direction `INBOUND`/`OUTBOUND`. |
| `parties` | `contracts/PartyRepository.ts` + `repositories/MongoPartyRepository.ts` | `parties`, `partyMemberships`, `partyInvites`, `partyOutbox` | `findById(?s)`, `findByMember(?s)`, `getOrCreateSolo(s)`, `createInvite(s)`, `listPendingInvites(?s)`, `acceptInvite(s)` (invite must belong to the inviter's current party; size cap; moves the player out of their old party; revokes other invites), `leave(s)`, `kick(s)` (leader only), `promote(s)` (leader only), `setActivity(s)` (revision CAS), `appendEvent(?s)`, `claimNextOutbox`, `markOutboxPublished`, `releaseOutbox`. Every mutation writes an outbox event in the same session. Leaving promotes `remaining[0]`; the last member leaving deletes the party (`DISBAND`). |
| `launcherGuard` | `contracts/LauncherGuardRepository.ts` + `repositories/MongoLauncherGuardRepository.ts` | `launcherGuardSessions` | `create(?s)`, `find(?s)`, `findHealthyForAccount(?s)` (role-aware; `HEALTHY`, unexpired, heartbeat within 45 s; rows without `role` count as `client`), `advance(?s)` (challenge match + strictly increasing sequence), `revokeForAccount(?s)`. |

## Collections

`_id` is automatic and unique. "Indexes" lists secondary indexes from `indexes.ts`. Many game-save documents store nested data as JSON strings (`data`, `instancedItems`, `stackedItems`, `loadouts`, `persistent`, `nodes`, `breadcrumbs`, `encounteredcontent`), not BSON sub-documents. Times are ISO strings unless noted as Date.

### Accounts and auth

| Collection | Stores | `_id` and key fields | Indexes | Owner |
|---|---|---|---|---|
| `accounts` | Legacy game account and launcher account in one doc (launcher fields added on top). Character-slot accounts (slot 2+) have no `displayNameNormalized`. | `_id = userId`; `userId`, `name`, `notes`; launcher: `email`, `displayName`, `displayNameNormalized`, `passwordHash` (argon2id), `status` (active/banned/disabled), `bannedUntil`, `approvalStatus`, `roles[]`, `usernameSet`, `createdAt`, `lastLoginAt`, `lastSeenAt`, `lastSeenIp` | unique partial `email`, unique partial `displayNameNormalized` (partial so docs without them do not collide) | `accounts`, `launcherAccounts`; `lastSeenAt`/`lastSeenIp` written by `realtime/XMPPConnection.ts` |
| `authIdentities` | Linked Discord identity. | `provider`, `providerSubject`, `userId`, `providerUsername`, `providerAvatarUrl`, `linkedAt` | unique `(provider, providerSubject)`, `userId` | `authIdentities` |
| `refreshSessions` | Launcher refresh tokens, hashed, rotated in families. | `_id = id`; `tokenHash`, `familyId`, `userId`, `deviceId`, `deviceName`, `expiresAt`, `revokedAt`, `ttlAt` (Date) | unique `tokenHash`, `familyId`, `userId`, TTL `ttlAt` | `refreshSessions` |
| `gameExchangeCodes` | One-time codes the launcher trades for a game login. | `_id = codeHash`; `userId`, `launcherSessionId`, build/exe/runtime hashes, `runtimeChannel`, `expiresAt`, `consumedAt`, `revoked`, `ttlAt` | `userId`, TTL `ttlAt` | `gameExchangeCodes` |
| `discordOAuthTransactions` | In-flight Discord login (PKCE) and its completion code. | `_id = state`; `codeVerifier`, `expiresAt`, `consumedAt`, `completionCodeHash`, `completionExpiresAt`, `completionConsumedAt`, `userId`, `ttlAt` | `completionCodeHash`, `userId`, TTL `ttlAt` | `discordOAuthTransactions` |
| `gameServerApiKeys` | HMAC hashes of the keys game servers present. | auto `_id`; `keyHash` | `keyHash` (non-unique) | `apiKeys` |
| `userApiKeys` | HMAC hashes of per-user API keys (`AUTH_MODE=APIKEY`). | `_id = userId`; `keyHash` | `keyHash` | `apiKeys` |
| `adminSessions` | Staff dashboard sessions. | `_id = id`; `tokenHash`, `userId`, `csrfToken`, `expiresAt`, `ip`, `userAgent`, `revokedAt`, `ttlAt` | unique `tokenHash`, `userId`, TTL `ttlAt` | `admin` |
| `adminAudit` | Append-only staff action log (also the tombstone after account deletion). | `_id = id`; `actorUserId`, `targetUserId`, `action`, `oldState`, `newState`, `reason`, `ip`, `requestId`, `createdAt` | `(targetUserId, createdAt desc)`, `(actorUserId, createdAt desc)`; no TTL | `admin` |
| `launcherGuardSessions` | Short-lived challenge-bound Guard sessions (client or host role). | `_id = guardSessionId`; `accountId`, `role`, `publicKeyBase64`, `manifestId`, `challenge`, `lastSequence`, `status`, `riskScore`, `expiresAt`, `lastHeartbeatAt`, `lastSignals` | `(accountId, status, expiresAt desc)`, `(accountId, role, status, expiresAt desc)`; no TTL | `launcherGuard`; also `controllers/adminOperations.ts` |
| `operationsPolicy` | Singleton `_id: "global"`. | `guardEnforcement` (seed `ENFORCE`), `diagnosticsProfile` (seed `PRODUCTION`), `version` (optimistic) | none | `src/services/operationsPolicy.ts` (direct); seeded by `indexes.ts` |
| `schemaMigrations` | Applied schema marker. | `_id: central-guard-schema-v1`; `version`, `status`, `appliedAt` (Date) | unique `version` | `mongo/schemaMigrations.ts` |

### Game save data (per character or account)

| Collection | Stores | `_id` and key fields | Indexes | Owner |
|---|---|---|---|---|
| `characters` | Character save blob. | `_id = characterId`; `userId`, `name`, `createdDate`, `lastModifiedDate`, `updateVersion`, `data` (JSON string) | `userId` | `characters` |
| `inventories` | Items per character. | `_id = characterId`; `userId`, `instancedItems`, `stackedItems` (JSON strings), `revision`, `bootstrapVersion` | `userId` | `inventories` |
| `inventoryTransactions` | Idempotency ledger for `POST /inventory`. | `_id` = sha256 of ids; `transactionId`, `userId`, `characterId`, `requestHash`, `status` (pending/completed), `result`, optional extras such as `grantAnnotation`, `createdAt`, `completedAt` | `(userId, characterId)` | `inventoryTransactions` |
| `loadouts` | Loadouts and active slot. | `_id = characterId`; `userId`, `loadouts`, `persistent` (JSON strings), `activeIndex`, `unlockedTotalSlots`, `revision`, `bootstrapVersion` | `userId` | `loadouts` |
| `wallets` | Currency balances. | `_id = userId`; `balances` (map currency id to number), `bootstrapVersion` | none | `wallets` |
| `entitlements` | Account entitlements (from store SKUs). | `_id = userId`; `entitlements[]` of `{name, duration, activatedDate, grantedAt, sourceSkuId}` | none | `entitlements` |
| `playerJourney` | Slayer's Path node state. | `_id = userId`; `nodes` (JSON string), `updateVersion` (client-facing), `revision` (server CAS) | none | `playerJourney` |
| `breadcrumbs` | Per-character UI "new" markers. | `_id = characterId`; `userId`, `breadcrumbs` (JSON string), `updateVersion` | `userId` | `breadcrumbs` |
| `encounteredContent` | Per-character seen-content list. | `_id = characterId`; `userId`, `encounteredcontent` (JSON string) | `userId` | `encounteredContent` |
| `progressionTracks` | Mastery, XP, hunt-pass and Slayer Link track progress. Hunt pass rows use `progressionId = "huntpass:<season>:<passId>"` (2026-10-24; older `seasonNN:<passId>` rows are migrated at startup). | `_id = "<userId>::<progressionId>"`; `progress`, `confirmedFremiumRank`, `confirmedPremiumRank`, `updateVersion` | `userId` | `progressionTracks`; `routes/slayerLinks.ts` resets link tracks directly |
| `progressionObjectives` | Resolved objective state. | `_id = "<userId>::<objectiveId>"`; `value`, `completedCount` | `userId` | `progressionTracks` |
| `progressionObjectiveEvents` | Raw append-only objective reports. | auto `_id`; `userId`, `rawBody`, `receivedAt` | `(userId, receivedAt)` | `progressionTracks` |
| `progressionTransactions` | Exactly-once grant ledger. | `_id = grantId`; `userId`, `progressionId`, `amount`, `requestHash`, `status`, `result` (track snapshot), `createdAt` | `(userId, createdAt desc)` | `progressionGrants` |
| `escalationProgress` | Escalation per season. | `_id = "<userId>::<seasonId>"`; `escalationLevel`, `nextLevelXp`, `talentsProgress`, `unlockProgress`, `updateVersion` | `(userId, seasonId)` | `escalationProgress` |
| `bountyStates` | Bounties and drafts. | `_id = userId`; `bounties[]`, `draftData`, `updateVersion` | none | `bountyStates` |
| `cooldownStates` | Cooldowns. | `_id = userId`; `entries[]`, `updateVersion` | none | `cooldownStates` |
| `characterSlots` | Extra characters per launcher account. | `_id` = the character's game userId; `ownerUserId`, `slot` (1-based), `createdAt`, `lastLaunchedAt`, `label`, `nameStyle` | unique `(ownerUserId, slot)` | `src/characterSlots.ts` (direct) |

### Social and gameplay

| Collection | Stores | `_id` and key fields | Indexes | Owner |
|---|---|---|---|---|
| `friendships` | Directed friend edges between account owners. | `_id = "<ownerId>:<otherId>"`; `status`, `direction`, `created`, `favorite` | `ownerId`, `otherId` | `friendships` |
| `parties` | Party authority. | `_id = partyId`; `revision`, `leaderPlayerId`, `members[]`, `buildId`, `activity` (IDLE/MATCHMAKING/HOST_SELECTING/STARTING_HUNT/IN_HUNT/RECOVERING), `activeHuntSessionId` | `members` | `parties` |
| `partyMemberships` | One row per account, so an account is in at most one party even under races. | `_id = accountId`; `partyId`, `joinedAt` | `partyId` | `parties` |
| `partyInvites` | Invites. | `_id = "<recipientId>\0<senderId>"`; `partyId`, `partyRevision`, `sendingPlayerId`, `recipientPlayerId`, `sendingDisplayName`, `status` (PENDING/ACCEPTED/REVOKED/EXPIRED), `expiresAt`, `consumedAt` | `(recipientPlayerId, status, expiresAt)`; no TTL | `parties` |
| `partyOutbox` | Party events for XMPP push. | `_id` = random UUID; `partyId`, `partyRevision`, `eventType`, `recipientAccountIds[]`, `payload`, `state` (PENDING/PROCESSING/PUBLISHED), `claimOwner`, `claimedAt`, `publishedAt` | `(state, createdAt)`, `(partyId, partyRevision)`, TTL on `ttlAt` (set by `markOutboxPublished` to publish + 24 h; startup backfills `ttlAt` on older PUBLISHED rows) | `parties`; drained by `realtime/PartyOutboxDispatcher.ts` |
| `slayerLinks` | Slayer Link invites and links. | `_id` = link id; `senderId`, `targetId`, `senderSlot`, `targetSlot`, `status`, `expiresAt`, `endsAt`, `prizePools`, `rewardsGranted[]`, `purgeAt` (Date) | `senderId`, `targetId`, TTL `purgeAt` | `routes/slayerLinks.ts`, `controllers/progression.ts` (direct) |
| `guilds` | Guilds. | `_id = guildId`; `name`, `nameKey`, `nameplate`, `nameplateKey`, `leaderId`, `createdAt` | unique `nameKey`, unique partial `nameplateKey` | `controllers/guild.ts` (direct) |
| `guildMembers` | One guild per account. | `_id = accountId`; `guildId`, `rank` (Leader/Officer/Member), `joinedAt` | `guildId` | `controllers/guild.ts`; read by `gauntlet.ts`, `controllers/characters.ts`, `controllers/adminServers.ts` |
| `guildInvites` | Guild invites. | `_id` = UUID; `guildId`, `inviteeId`, `inviterId`, `createdAt`, `expiresAt` (Dates) | `(inviteeId, expiresAt)`, `(guildId, inviteeId)`, TTL `expiresAt` | `controllers/guild.ts` |
| `gauntletClears`, `gauntletGuildClears` | Best cleared Gauntlet level per season window. | `_id = "<season index>:<accountId\|guildId>"`; `best` (`$max`), `season`, `accountId`/`guildId`, `updatedAt` | none | `src/gauntlet.ts` (direct) |
| `huntStats` | Per-player damage per hunt (posted by hunt servers). | `_id = "<hunt>:<userId>"`; `hunt` (`<port>-<unix s>`), `playerHuntId`, `userId`, `damage`, `partDamage`, `woundDamage`, `behemoths[]`, optional `seconds`, `weapon`, `grade`, `stats{}` (`HUNT_STAT_KEYS`), `createdAt`, `updatedAt` | `(userId, updatedAt desc)`, `hunt` | `routes/huntStats.ts` (direct). |

### Outside `Collections`

| Collection | Stores | Notes |
|---|---|---|
| `launcher_card` | Launcher server card (title, MOTD, logo bytes, invite settings). | `COLLECTION` const in `src/routes/launcherCard.ts`, single doc `_id: "card"`. Cached in process after first read. |
| `discord_issues`, `discord_issue_config` | Legacy `/issue` tickets from when the Discord bot ran inside the backend. | Nothing in the backend writes them any more; only `scripts/export-discord-issues.cjs` reads them. |
| P2P extension collections | Optional module. | Created by `GetP2PExtension().server.ensureDatabase`; none in a dedicated-only build. |

Note on TTL: Mongo deletes expired docs on a background schedule (about every 60 s). Code still compares the ISO-string `expiresAt` itself, so an expired row never works even if not yet deleted. `ttlAt` is a BSON Date mirror kept only for the TTL index.

## Non-Mongo state

| What | Where | Lifetime |
|---|---|---|
| UDP encryption keys (`/key/generate`, `/key/consume`) | `src/encryptionKeyStore.ts`, in memory, 30 min TTL | Lost on restart. Looked up by candidate id, then bearer token, then "most recent". |
| Rate-limit windows | `src/security/rateLimit.ts` (`Map`) plus `express-rate-limit` memory store | Lost on restart; not shared between processes. |
| Session registry (online players, XMPP sockets) | `src/realtime/SessionRegistry.ts` | See [backend realtime](backend-realtime.md). |
| Metrics | `src/observability/metrics.ts` maps | See [security and admin](backend-security-admin.md). |
| Host metric history | `adminServers.ts` in-memory 24 h at 15 s, plus `host-metrics.csv` in `ADMIN_LOG_DIR` (no rotation) | |
| Runtime update artifacts and manifests | Files under `LAUNCHER_UPDATE_ROOT` (default `./updates`) | Written by `routes/launcherUpdates.ts`; read by `security/runtimeAuthorization.ts`. |
| Launcher log uploads, crash reports | Files under `LOG_STORAGE_ROOT` / `CRASH_REPORT_STORAGE_DIR` (`issues.json` index for crash issues) | |
| Game data tables (store, progression, catalog) | `game-data/*.json`, loaded by `src/gameData/loader.ts` | Read-only at runtime; regen needs a backend restart. Phoenix Labs data, never commit. Generators: [backend scripts](backend-scripts.md). |

## Connects to

- Every controller and route imports `GetRepositories()` from `src/persistence`. See [backend](backend.md).
- The staff dashboard (`controllers/adminServers.ts`) reads many collections directly ([security and admin](backend-security-admin.md)).
- [Realtime](backend-realtime.md) writes `accounts.lastSeenAt`/`lastSeenIp` on XMPP bind, reads `friendships`, and drains `partyOutbox`.
- The player [launcher](launcher.md) never talks to Mongo; it uses `/launcher/v1/*`.
- Mongo itself: hand-started `mongod` on port 27018 (replica set `rs0`), data in `D:\MysticParadoxData\mongo`. If it is down the launcher shows "can't reach server" and `/health/ready` returns 503 with `persistence: unavailable`.
- Companion site (Slayer's Ledger, separate repo) reads inventory and `huntStats` read-only from the same database.

## Config

| Variable | Default | Meaning |
|---|---|---|
| `MONGODB_URI` | none, required | Connection string. Never logged. Include `replicaSet=rs0`. |
| `MONGODB_DB` | `mystpax` | Database name. |
| `MONGODB_APP_NAME` | `paradox-backend` | Driver app name (1-128 printable chars). |
| `MONGODB_CONNECT_TIMEOUT_MS` | 5000 | 250 to 30000. |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | 5000 | 250 to 30000. |
| `MONGODB_MAX_POOL_SIZE` | 20 | 1 to 500. |
| `MONGODB_MAX_IDLE_TIME_MS` | 60000 | 0 to 300000. |
| `MONGODB_TRANSACTION_MAX_COMMIT_TIME_MS` | 2000 | 250 to 30000. |
| `NODE_ENV` | unset | `production` enforces the replica-set check. |
| `API_KEY_HASH_SECRET` | none, required (32+ chars) | HMAC secret for the two API-key collections. |
| `GAMESERVER_API_KEYS` | none | Comma list of raw game-server keys; if non-empty it is the complete key set at boot (other hashes deleted). |

Out-of-range pool/timeout values throw at startup rather than being clamped.

## Gotchas

- **One Mongo, no staging.** Scripts and the backend use the same `.env` database. Run data scripts as dry-run first ([backend scripts](backend-scripts.md)).
- **Standalone mongod fails transactions.** Admin delete, Discord admin login, ops policy, party changes and inventory transactions use `withTransaction`. Use the `rs0` replica set.
- **Pass `session`.** Calling a repository inside `withTransaction` without the session runs outside the transaction.
- **`accounts` is two things.** Legacy game accounts and character-slot accounts have no `displayNameNormalized`; launcher accounts do. Admin delete only removes the main doc if it has `displayNameNormalized`. `launcherAccounts.findByUserId` on a slot id answers with the owner's account.
- **Plaintext key queues do not exist.** `findAll*KeysToRegister` always returns empty on Mongo. Register keys via `GAMESERVER_API_KEYS`. Keys stored before 2026-10-11 (plain SHA-256) no longer match and must be re-registered.
- **API-key lookup is a full scan.** Each check loads every hash and compares with `timingSafeEqual`; the `keyHash` index is non-unique and unused for the lookup.
- **Account deletion is partial.** `deletePlayerData` clears auth, sessions, keys, friendships and the game save (characters, inventory, loadouts, breadcrumbs, encountered content, progression tracks/objectives/events, player journey, wallet) for the account and all its slots, then the slot accounts. It does not touch `bountyStates`, `cooldownStates`, `entitlements`, `escalationProgress`, `progressionTransactions`, guild rows, slayer links, party rows, `huntStats`, Gauntlet clears or Guard sessions. `deleteCharacterSlot` covers several of those for one slot. See [FINDINGS](../FINDINGS.md).
- **Outbox TTL.** PUBLISHED `partyOutbox` rows expire a day after publish (`ttlAt`, a BSON Date mirror: TTL indexes ignore ISO-string dates). `partyInvites` has no TTL but is keyed by recipient+sender and overwritten, so it stays bounded by pair count.
- **JSON-string blobs.** `characters.data`, `inventories.*Items` and similar are strings. Editing them in Mongo shell needs parse and stringify, and the `revision`/`updateVersion` must be bumped or the game's next write may be rejected.
- **Schema marker is forward-only.** Do not hand-edit `schemaMigrations`; a version higher than the binary knows blocks startup.
- **Encryption keys vanish on restart**, and an unmatched lookup can fall back to the most recent key (possibly another player's).

See also: [index](index.md), [backend](backend.md), [backend scripts](backend-scripts.md), [security and admin](backend-security-admin.md), [realtime](backend-realtime.md), [setup](setup.md).
</content>
</invoke>
