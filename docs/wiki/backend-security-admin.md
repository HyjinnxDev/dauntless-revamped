# ParadoxBackend security, observability, diagnostics and admin

> Verified against code 2026-10-24.

Per-file details: [Backend files](backend-files.md). Per-route auth: [Route index](backend-files.md#route-index).

## What it is

This page covers how the backend decides who is calling and what they may do (`src/security/`, `src/middleware/`), how it reports on itself (`src/observability/`, `src/diagnostics/`), and the staff `/admin` console with its roles and bans (`src/controllers/admin*.ts`, `src/routes/admin*.ts`, `admin-ui/`). There are five kinds of caller: a game client (player JWT), a dedicated game server (API key), the launcher (launcher JWT), a staff member (cookie session), and scripts or tools (shared-secret tokens). Each has its own middleware and token type; they are deliberately not interchangeable.

## Key files

Paths are under `versions/1.14.7/ParadoxBackend/`.

| Path | Purpose |
|---|---|
| `src/middleware/HasParadoxBackendAuth.ts` | Auth for all game routes: game-server API key or player bearer JWT. |
| `src/middleware/HasLauncherAuth.ts` | Auth for `/launcher/v1/*`: launcher-audience JWT plus live session check. |
| `src/middleware/HasAdminAuth.ts` | Auth for `/admin/v1/*`: cookie session, CSRF, staff check. `RequireStaff(permission)`. |
| `src/controllers/auth.ts` | Signs/validates the game JWT and the store purchase token; user API key lookup. |
| `src/controllers/apikeys.ts` | Game-server API key registration and validation. |
| `src/security/apiKeyHash.ts` | HMAC-SHA256 hashing of API keys, constant-time compare. |
| `src/security/launcherTokens.ts` | Launcher access JWT (12 min), opaque token generation and hashing. |
| `src/security/passwords.ts` | Argon2id hash/verify with a dummy hash for timing parity. |
| `src/security/totp.ts` | RFC 6238 TOTP verify (6 digits, 30 s, plus or minus one step). |
| `src/security/accountEligibility.ts` | Ban/disable/approval checks (`IsAccountEligible`). |
| `src/security/staffRoles.ts` | Staff ranks, permission table, name tags, name styles, `CanActOn`. |
| `src/security/testerFeatures.ts` | Assignable roles and the tester feature allow-list. |
| `src/security/runtimeAuthorization.ts` | Checks the client DLL hashes against the signed release manifest. |
| `src/security/rateLimit.ts` | `IsRateLimited` (in-memory) and the global per-IP `express-rate-limit` options. |
| `src/security/logRedaction.ts` | Strips `token`, `code`, `api_key`, etc. from logged URLs. |
| `src/security/launcherErrors.ts`, `launcherVersion.ts` | Error code type plus HTTP mapping; semver compare. |
| `src/controllers/launcherGuard.ts`, `src/routes/launcherGuard.ts` | Launcher Guard: signed integrity heartbeats. |
| `src/controllers/admin.ts` | Staff login/logout, player list, access (ban) changes, roles, delete, audit. |
| `src/controllers/adminDiscordAuth.ts` | Staff sign-in with Discord. |
| `src/controllers/adminOperations.ts` | Operations overview and policy (Guard enforcement, diagnostics profile). |
| `src/controllers/adminServers.ts` | Host metrics, Director proxy, stop servers, restart stack, tail logs, player detail. |
| `src/routes/admin.ts` | Mounts `/admin/v1/*`, origin/CORS gate, per-route permission. |
| `src/routes/launcherCard.ts` | `/admin/v1/launcher-card*` (operations permission) plus public `/launcher/v1/info`. |
| `src/routes/adminLauncherLogs.ts` | Read-only log sync for scripts, guarded by `LAUNCHER_LOG_SYNC_TOKEN`. |
| `src/services/operationsPolicy.ts` | Reads/writes the `operationsPolicy` singleton, applies log level. |
| `src/config/runtimeSafety.ts` | Refuses to start in production with unsafe flags. |
| `src/observability/metrics.ts`, `requestContext.ts`, `serviceReadiness.ts` | Prometheus text metrics, request id, readiness state. |
| `src/routes/metrics.ts` | `GET /internal/v1/metrics`. |
| `src/diagnostics/capture.ts`, `economyMonitor.ts` | Structured inventory/economy log lines. |
| `admin-ui/index.html`, `admin-ui/admin.js` | The static dashboard served at `/admin`. |
| `scripts/bootstrap_admin.ts` | Grants `admin` + `owner` to an account by email. |

## How a request is authenticated

### Global steps for every request (`src/app.ts`)

1. `RequestContextMiddleware` assigns a request id (accepts a safe incoming `x-mysticparadox-request-id`/`x-request-id`, else a UUID), stores it in `AsyncLocalStorage`, echoes it in the response header.
2. The `/__origin/<host>/` prefix the client DLL adds is stripped; the host must be an allow-listed official domain (`steelyard.ca`, `steelyard.online`, `ol.epicgames.com`, `api.epicgames.dev`) or the request gets 400.
3. Body parsers, then a request logger that counts metrics and logs `[REQ]`/`[RES]` with the URL passed through `sanitizeUrlForLog`. Bodies are never logged unless `MYSTICPARADOX_BODY_CAPTURE` is on.
4. `/health/live` and `/health/ready` (no auth, no secrets), then the per-IP rate limiter, then the routers.
5. `trust proxy` is `loopback`, so `req.ip` is the real client only when a same-box proxy sets `X-Forwarded-For`.

### Player login (game client) and the game JWT

1. The player starts the game from the launcher. The launcher signs in (`POST /launcher/v1/auth/login` or Discord) and gets a launcher access token (RS256 JWT, audience `mysticparadox-launcher`, 12 min) plus an opaque refresh token (30 days, stored as a SHA-256 hash, rotated on each refresh; reuse of an old one revokes the whole family).
2. The launcher calls `POST /launcher/v1/game-sessions` (needs launcher auth). The backend checks the account is eligible, the requested runtime channel matches the account's roles (testers get `beta`, others `stable`), the DLL file hashes and version match the signed manifest on disk, the game build equals `TARGET_CHANGELIST`, and the game exe hash is in the approved set. It picks the chosen character slot (its own game userId), refuses if another of the owner's characters is online, stores a one-time code hash (60 s TTL) and returns the code plus a voice ticket.
3. The game calls `POST /account/api/oauth/token` with that code as `exchange_code` (`src/routes/eos.ts`). With `AUTH_MODE=LAUNCHER` the backend consumes the code atomically, re-checks build, account eligibility, channel and runtime hash, and signs the game JWT (`SignMetagameJWTForUid`: RS256, issuer and audience `paradox-backend`, 24 h) for the character's game userId. A call with `grant_type=client_credentials` and no code gets a service token for the placeholder user `__launcher_client_credentials__`. An unknown code is 401, except when `ALLOW_NO_AUTH_DEV_MODE=true` outside production: then the code string itself becomes the user id (dev fallback). The runtime hash is checked against the manifest published now, so publishing a new runtime inside the code's 60 s life fails that one login.
4. Other `AUTH_MODE` values: `APIKEY` (exchange_code is a user API key, looked up by HMAC hash) and `NONE` (dev: any code becomes the user id; only if `NODE_ENV!=production` and `ALLOW_NO_AUTH_DEV_MODE`). Anything else returns 500.
5. Later game calls send `Authorization: Bearer <game JWT>`. `HasParadoxBackendAuth` verifies signature/issuer/audience/expiry, then loads the launcher account and rejects with 403 if it is banned, disabled, pending or rejected (`IsCurrentLauncherAccountEligible`). A ban therefore takes effect on the next request, without waiting for the 24 h token to expire. The payload goes to `req.AuthData`.
6. The same game JWT is the XMPP password (SASL PLAIN): `src/realtime/XMPPAuth.ts` requires the JWT `userId` to equal the SASL username, rejects the client-credentials token and ineligible accounts. See [backend-realtime](backend-realtime.md).
7. Voice uses a separate ticket (`SignVoiceTicket`: same keypair, audience `mysticparadox-voice`, 24 h, for the character's game userId) for the UDP relay. The client runtime also sends it as `x-mystic-ticket` to the join-in-progress routes `/mystic/party/hunt-offer` and `/mystic/party/join-hunt`.
8. Store purchases use a third token: `SignStorePurchaseToken` (10 min, audience `mysticparadox-store-purchase`, carries user, character, SKU, store tag). It cannot be used as a bearer token.

All JWTs use one RS256 keypair (`AUTH_SIGNING_PRIVKEY_B64` / `AUTH_SIGNING_PUBKEY_B64`); the `audience` claim is what keeps them apart.

### Game server auth

- Dedicated game servers send header `x-mysticparadox-gameserver-apikey`. `IsValidGameserverAPIKey` HMACs it (`API_KEY_HASH_SECRET`, domain-separated by scope) and compares against all stored hashes in constant time (it reads every stored hash from Mongo on each request). When `GAMESERVER_API_KEYS` is non-empty it is authoritative at boot: the stored set is replaced, so removing a key from the env revokes it after restart. When it is empty the stored keys are kept and any queued keys-to-register are added.
- A wrong key gets 401. A right key sets `AuthData.IsGameserver = true`. If the server also forwards a player bearer token, that player's identity is kept (and eligibility is checked); if not, the request is attributed to `GAMESERVER_NO_PLAYER_USER_ID` (falls back to `DEV_USER_ID`; no userId when both are unset). A forwarded bearer that is expired or invalid is not caught and the request fails with 500.
- Hub quirk: for GET/HEAD from a game server, the literal path segment `INVALID` (the hub's phantom local player) is rewritten to that configured user id (final fallback `mystpax`). Writes are not rewritten.
- Grant routes treat `IsGameserver` as the authority to grant or spend: `POST /inventory` with any add/remove array, bounty and cooldown writes, XP grants, rank confirms, reforge resets, Player Journey saves, loadout unlocks, hunt stats, Gauntlet clears. For plain players, inventory and loadout routes ignore the path userId and use the token's; escalation, cooldown, bounty and progression reads accept only the caller's own userId; encountered content and breadcrumbs check character ownership. The full list is in the [Route index](backend-files.md#route-index).
- The Director calls the backend with the same key. The backend calls the Director's `/api/admin/*` with header `x-api-key` = the first key in `GAMESERVER_API_KEYS`; its matchmaker and status calls (`/api/matchmaker/*`, `/api/hub-status`, `/api/hunt-status`) carry no key.

### Launcher auth (`HasLauncherAuth`)

Bearer launcher JWT, verified against audience `mysticparadox-launcher`. It then checks in parallel that the account exists and that the refresh-session family named by the token's `sid` is still active, then `AssertAccountAdmitted`. Logout or an admin ban kills access at once, not after 12 min. Errors use the launcher JSON shape `{ error: { code, message, requestId } }` (`launcherErrors.ts`). CORS for `/launcher/*` is an allow-list (`http://localhost:1420`, `https://tauri.localhost`, plus `LAUNCHER_ALLOWED_ORIGINS`).

Rate limits (in memory, `IsRateLimited`): register 5 per hour per IP; login 10 per 5 min per IP and per email; game-session 10 per 5 min per user; character create 5/h, rename 20/h, name style 30/h, delete 5/h per account; tester log upload 120/h per account and 300/h per IP; crash upload 90/h per IP; update downloads 180/min and publishes 30/min per IP; staff login 6 per 15 min per IP. Passwords are Argon2id; a login for an unknown email still runs a verify against a dummy hash.

Registration: a new account is `pending` (no tokens, 202) until staff approve it, unless the request carries a code from `LAUNCHER_INVITE_CODES`, which approves it at once (200 with a session; email optional). A first Discord sign-in creates a `pending` account with `usernameSet: false`; it must pick a username before it is eligible.

### Launcher Guard

`/launcher/v1/guard/sessions` and `/heartbeat` (launcher auth). The launcher starts a session against the published Guard manifest (matched by channel, sequence and expiry, and a minimum launcher version) with an Ed25519 public key; the session lives 5 min and is extended by heartbeats every 15 s. Each heartbeat is signed over the previous challenge and carries process/module integrity signals (debugger present, unexpected modules, protected page mismatches, private/writable executable bytes, module-set digest). The server scores them (`HEALTHY` or `DEGRADED`, risk 0 to 100) and stores them in `launcherGuardSessions`. The backend itself never blocks anything on the result: it records, and reports the operations policy `guardEnforcement` (`ENFORCE` default; `OBSERVE`) to the launcher in `GET /launcher/v1/policy`. Acting on `ENFORCE` is the launcher's job. Env `GUARD_ENFORCEMENT_OVERRIDE=OBSERVE` forces observe.

### Staff admin auth (`HasAdminAuth`)

Sign-in options (`src/routes/admin.ts`):

1. **Email or username + password** (`POST /admin/v1/auth/login`): rate limit 6 per 15 min per IP; account must have a staff role and be eligible. TOTP via `ADMIN_TOTP_SECRET`: one shared secret for all staff. In production the login returns 503 if it is unset; outside production it is skipped when unset.
2. **Discord** (`GET /admin/v1/auth/discord/start` then `/callback`): the Discord id must be in `ADMIN_DISCORD_ALLOWED_IDS`. State is bound to a short-lived HttpOnly cookie. An allow-listed id with no account gets one created with role `admin`; an existing eligible linked account is promoted to `admin`. Redirect URLs must be HTTPS (localhost http allowed outside production).

On success the backend creates an `adminSessions` row (8 h), sets cookie `mysticparadox_admin` (HttpOnly, SameSite=Strict, Path `/admin/v1`, Secure in production or when `ADMIN_COOKIE_SECURE`), and returns a per-session CSRF token. Only the SHA-256 of the cookie token is stored.

Each admin request: read cookie, hash, find an unrevoked unexpired session, reload the account (must still have a staff role and be eligible, else the session is revoked and 403), and for non-GET methods require header `X-CSRF-Token` to match the session. Then `RequireStaff(permission)` checks rank. Cross-origin calls need `Origin` equal to the page's own origin or in `ADMIN_ALLOWED_ORIGINS` (empty list in production). Responses are `no-store` with a strict CSP.

Script and service tokens (no cookie):

| Token | Header | Used by |
|---|---|---|
| `UPDATE_PUBLISHER_API_KEY` | `x-update-api-key` | Publishing runtime DLLs, extra files and Guard manifests, and the serving switch (`/launcher/v1/admin/*`, [paradox-launcher](paradox-launcher.md)). Timing-safe compare; the source IP must also be in `UPDATE_PUBLISHER_ALLOWED_IPS` (empty denies all), and uploads need an Ed25519 signature in `x-update-signature` from the key embedded in `routes/launcherUpdates.ts`. |
| `LAUNCHER_LOG_SYNC_TOKEN` | `x-sync-token` | Read-only log listing/download for `scripts/sync-launcher-logs.mjs`. |
| `MYSTICPARADOX_METRICS_TOKEN` | `Authorization: Bearer` or `x-mysticparadox-metrics-token` | `GET /internal/v1/metrics`. With no token set, only raw loopback and non-production is allowed (else 503). |

Unauthenticated by design: `/`, `/health/*`, `/launcher/v1/info*`, `/launcher/v1/status`, `/launcher/v1/auth/register|login|refresh|discord/*`, `GET /launcher/v1/username`, stable-channel runtime and Guard manifests and downloads, the launcher self-updater (`/launcher/v1/updates/*`), `/content/v1/manifest`, `/content/v1/news*`, `/game_tuning/*`, the EOS token exchange and account lookups, a handful of game stubs (`/dauntless-status`, `/heartbeat`, `/event`, `/crash/CrashReporter/*`, `/patchnotes/*`, `/features/platform/win`, `/account/link/epic/*`, `/isbanned`, `/QoS`, friends blocklist/recent/settings), and `PUT /crash/v1/reports/:id/:file` (IP rate limited, size and count capped).

## Staff roles and moderation

Ranks (`staffRoles.ts`): moderator 1, admin 2, owner 3. `owner` also implies `admin`. Only `scripts/bootstrap_admin.ts` can grant `owner`; the roles API can only toggle `tester`, `moderator`, `admin` (`ASSIGNABLE_ROLES`).

| Permission | Min rank | What it allows |
|---|---|---|
| `players.read` | 1 | Player list, online list, player detail, audit log |
| `players.ban.timed` | 1 | Timed ban up to 7 days (`MODERATOR_MAX_BAN_HOURS`) |
| `players.access` | 2 | Permanent ban, disable, unban, approve or reject sign-ups |
| `players.roles` | 3 | Grant/revoke tester, moderator, admin |
| `players.delete` | 3 | Permanent player delete (type `DELETE <name>`) |
| `operations` | 3 | Operations policy, launcher card |
| `servers.read` | 1 | Host metrics, Director server list |
| `servers.control` | 2 | Stop game servers, restart stack/Director, read logs |

Rules enforced in `controllers/admin.ts`:

- Every access change needs a reason (3+ chars) and is written to `adminAudit` with before/after state, actor, IP and request id.
- You can act only on accounts ranked strictly below you (`CanActOn`). You cannot ban, disable or reject yourself, or delete yourself.
- Ban states: `status: banned` with `bannedUntil` = timed; without it = permanent. `IsBanActive` ignores an expired `bannedUntil`, so nothing has to run to lift a ban.
- When an account becomes ineligible: for every character slot of the owner (`ListSlots(OwnerOf(id))`) all refresh sessions and unused exchange codes are revoked, live XMPP sockets are closed (code 1008), and party voice is blocked (`SetVoiceBlocked`); unbanning unblocks voice on every slot. The game server has no kick: a banned player stays in their current map until they travel, but every metagame API call returns 403. The socket close and the voice block use the launcher account's userId, which is the game userId of character slot 1 only; a player on a second character keeps chat and voice until those sessions end (game API calls still 403).
- Removing `tester` revokes unused exchange codes so a beta DLL cannot start after the role is gone.
- Staff names get a prefix in game (`[Mod]`, `[Admin]`, `[Owner]`); the client DLL styles nameplates from it, so keep both sides in step. Patreon-style name tags (`wanderer` to `emerald`) are currently allowed for owners only.

## Operations policy and Guard step-up

`operationsPolicy` (`_id: "global"`) holds `guardEnforcement` (ENFORCE/OBSERVE) and `diagnosticsProfile` (PRODUCTION/DEVELOPMENT) with an integer `version`. `PATCH /admin/v1/operations/policy` needs the owner tier, the current `expectedVersion`, and a reason of 8+ chars. It runs in a transaction with an audit row. Weakening the policy (ENFORCE to OBSERVE, or PRODUCTION to DEVELOPMENT diagnostics) also needs a fresh `breakGlassTotp` (from `ADMIN_OPERATIONS_TOTP_SECRET`, else `ADMIN_TOTP_SECRET`), rate limited 6 per 15 min per operator. DEVELOPMENT diagnostics expire after 2 hours. A malformed stored policy fails closed (ENFORCE + PRODUCTION). The launcher learns the effective values from `GET /launcher/v1/policy` and verbose diagnostics are only offered to testers and admins.

## Admin console

`/admin` serves `admin-ui/` (plain HTML + JS, CSP `default-src 'self'; style-src 'self' 'unsafe-inline'`) from the backend itself, calling `/admin/v1/*` on the same origin. Its pages: Overview, Servers, Players, Online now, Audit log (any staff), Logs (admin+), Launcher card (owner). It has no page for the operations policy; that is API-only (`/admin/v1/operations/*`). The API itself answers with `Cache-Control: no-store` and CSP `default-src 'none'`.

| Area | Routes (`/admin/v1`) | Notes |
|---|---|---|
| Session | `auth/login`, `auth/logout`, `auth/discord/*`, `me` | |
| Players | `players`, `players/:id/detail`, `players/:id/access` (PATCH), `players/:id/roles` (PATCH), `players/:id` (DELETE), `online-players`, `audit` | Detail joins accounts, characters, wallet, guild, friends, entitlements, tracks; refresh-session list and IP-sharing accounts are owner/admin-only details. Delete runs one transaction (see [persistence](backend-persistence.md)). |
| Operations | `operations/overview`, `operations/policy` | |
| Servers | `servers/overview`, `servers/history`, `servers/gameservers/:id/stop`, `.../log`, `servers/restart`, `servers/logs/:name` | Proxies the [Director](director.md) `/api/admin`; collects host CPU/memory/players/servers every 15 s (24 h in memory, also appended to `host-metrics.csv` in `ADMIN_LOG_DIR` with no rotation); lists node/mongod/game processes through PowerShell; restart spawns `ADMIN_RESTART_SCRIPT` (PowerShell) detached and needs an elevated backend (`net session` check); log names are a fixed list (`backend`, `director`, `director-build`, `restart`) under `ADMIN_LOG_DIR`. Stop and restart need a reason and are audited. |
| Launcher card | `launcher-card`, `launcher-card/logo`, `launcher-card/invite` | Title, MOTD, logo, join links for the launcher Servers tab (stored in collection `launcher_card`; the invite uses the first `LAUNCHER_INVITE_CODES` code and the TLS cert fingerprint). |

## Observability and diagnostics

- **Metrics** (`observability/metrics.ts`): in-process counters, gauges, histograms; label names restricted to `class, code, le, method, operation, result, role, service, status` to stop cardinality blowups. Rendered in Prometheus text at `/internal/v1/metrics`. Built-ins: `mysticparadox_http_requests_total`, `..._responses_total`, `..._inflight`, `..._request_duration_ms`, `mysticparadox_info`, `mysticparadox_service_ready`, `mysticparadox_service_readiness_changed_timestamp_seconds`. Request classes: `admin`, `health`, `launcher`, `game`.
- **Readiness** (`serviceReadiness.ts`): state set by startup; `/health/ready` is 200 only if the role finished starting and Mongo answers. Also reports online player count for the [Discord bot](discord-bot.md) status channel.
- **Log profile**: `config/loggingPolicy.ts` maps PRODUCTION to `LOG_LEVEL` (only real production levels honored) and DEVELOPMENT to `MYSTICPARADOX_DEVELOPMENT_LOG_LEVEL` (default `debug`).
- **`[INV-CAP]`** (`diagnostics/capture.ts`): off by default. `MYSTICPARADOX_INV_CAPTURE` logs a decoded per-array summary of each `POST /inventory`; `_RAW` dumps full JSON (blocked in production); `_FILTER` is a regex of catalog ids. Never throws into a transaction.
- **Economy monitors** (`diagnostics/economyMonitor.ts`): always on, `[PrestigeMon]`, `[DraftMon]`, `[GrantMon]` lines for a small set of ids. `MYSTICPARADOX_ECONOMY_MONITOR=off` silences them.
- **Body dumps**: `MYSTICPARADOX_BODY_CAPTURE` (POST bodies of progression/store/inventory paths) and `MYSTICPARADOX_LOG_ORIGIN_BODIES=1` (response bodies for `/__origin` calls). Debug only; they can contain player data.

## Connects to

- [Persistence](backend-persistence.md): `launcherAccounts`, `refreshSessions`, `gameExchangeCodes`, `adminSessions`, `adminAudit`, `operationsPolicy`, `launcherGuardSessions`.
- [Realtime](backend-realtime.md): XMPP SASL uses the game JWT; `sessionRegistry` is used to close sockets on ban; voice relay uses voice tickets and `SetVoiceBlocked`.
- [Director](director.md): admin console calls `http://$DEPLOYSERVER_URL/api/admin/*` with the game-server key; the Director authenticates to the backend with the same key.
- [Paradox launcher](paradox-launcher.md): publishes signed runtime manifests that `runtimeAuthorization.ts` reads from `LAUNCHER_UPDATE_ROOT`.
- [Player launcher](launcher.md): uses `/launcher/v1/*` auth, policy and Guard.
- [Runtime DLL](runtime.md): the staff name tag format and the `diagnostics.verbose` flag file name are shared contracts.
- [Discord bot](discord-bot.md) and Discord OAuth for admin sign-in.

## Config

| Variable | Default / note |
|---|---|
| `AUTH_MODE` | `LAUNCHER`, `APIKEY` or `NONE` (dev only). |
| `ALLOW_NO_AUTH_DEV_MODE`, `DEV_USER_ID` | Dev fallback login. Blocked in production. |
| `AUTH_SIGNING_PRIVKEY_B64`, `AUTH_SIGNING_PUBKEY_B64` | RS256 keypair for all JWTs. Required. |
| `API_KEY_HASH_SECRET` | 32+ chars. Required. |
| `GAMESERVER_API_KEYS`, `GAMESERVER_NO_PLAYER_USER_ID` | Game-server keys; identity for key-only requests. |
| `TARGET_CHANGELIST` | Supported game build; unset means every game-session fails closed. |
| `LAUNCHER_UPDATE_ROOT` | Default `./updates`; runtime manifests live here. |
| `LAUNCHER_ALLOWED_ORIGINS` | Extra CORS origins for the launcher API. |
| `UPDATE_PUBLISHER_API_KEY`, `UPDATE_PUBLISHER_ALLOWED_IPS`, `LAUNCHER_LOG_SYNC_TOKEN`, `MYSTICPARADOX_METRICS_TOKEN` | Script tokens and the publisher IP allow-list. |
| `LAUNCHER_INVITE_CODES` | Invite codes that approve a registration at once. |
| `APPROVED_EXECUTABLE_SHA256` | Approved game exe hashes; empty rejects every launch. |
| `ADMIN_TOTP_SECRET`, `ADMIN_OPERATIONS_TOTP_SECRET` | Base32 TOTP secrets. |
| `ADMIN_ALLOWED_ORIGINS`, `ADMIN_COOKIE_SECURE`, `ADMIN_FRONTEND_URL` | Dashboard origin and cookie settings. |
| `ADMIN_DISCORD_ALLOWED_IDS`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `ADMIN_DISCORD_REDIRECT_URI` | Discord admin sign-in. |
| `ADMIN_LOG_DIR`, `ADMIN_RESTART_SCRIPT`, `DEPLOYSERVER_URL` | Servers page. |
| `MYSTICPARADOX_RATE_LIMIT` (`off`), `MYSTICPARADOX_RATE_LIMIT_PER_MINUTE` (600), `MYSTICPARADOX_GAMESERVER_RATE_LIMIT_PER_MINUTE` (6000) | Global per-IP budget. |
| `GUARD_ENFORCEMENT_OVERRIDE` | `OBSERVE` forces observe mode. |
| `LOG_LEVEL`, `MYSTICPARADOX_DEVELOPMENT_LOG_LEVEL` | Log levels. |
| `MYSTICPARADOX_INV_CAPTURE`, `_RAW`, `_FILTER`, `MYSTICPARADOX_ECONOMY_MONITOR`, `MYSTICPARADOX_BODY_CAPTURE`, `MYSTICPARADOX_LOG_ORIGIN_BODIES` | Diagnostics switches. |
| `MYSTICPARADOX_SERVICE_ROLE` | Must be explicit in production (`combined` refused). |

`config/runtimeSafety.ts` refuses to boot in production with `AUTH_MODE=NONE`, `ALLOW_NO_AUTH_DEV_MODE=true`, body capture or raw inventory capture on, `REALTIME_XMPP_DEV_CITY_MUC` not `false`, no metrics token on the API role, or a missing `MONGODB_URI`. It also rejects any env key still starting with `MYSTPAX_` (renamed to `MYSTICPARADOX_`).

## Gotchas

- **Admin MFA is optional unless `NODE_ENV=production`.** If the live host does not run with that value and no TOTP secret is set, a staff password alone opens the console (which can restart the stack and delete players). Check the live `.env`.
- **One TOTP secret for all staff**, no replay protection.
- **Rate limits live in memory.** They reset on restart, are per process, and the key map is never pruned.
- **Bans are metagame-only.** The game server keeps a banned player in the current map until they travel. Chat sockets are closed and voice is blocked on every character slot (see Staff roles and moderation).
- **The Guard does not block on the server.** Enforcement of `ENFORCE` is up to the launcher; the backend only scores and stores heartbeats.
- **Game JWTs live 24 h** and cannot be revoked individually; revocation works because eligibility is re-read from the DB per request.
- **Missing `TARGET_CHANGELIST`** makes game launches fail with "build unsupported" (fails closed, by design).
- **Executable and DLL hashes are reported by the launcher.** They are a consistency check, not tamper-proof against a modified launcher.
- **Key-only game-server requests act as a fixed user.** Set `GAMESERVER_NO_PLAYER_USER_ID` deliberately; its default chain ends in the dev account.
- **Restart from the dashboard** only works when the backend runs elevated (started via `restart-server.ps1`); otherwise it returns 409 `ADMIN_RESTART_UNAVAILABLE`. A full stack restart kills the backend that spawned it, hence the detached process.
- **Staff roles are read from the DB on each admin request**, so a role change or ban applies instantly to open dashboard sessions.
- **Do not widen name tags**: the nameplate text clips in game.
- A catch-all in `app.ts` answers any unknown request whose origin host contains `leaderboard` with 200 (Trials submit probe); other unknown routes log `Unstubbed route` and return 404.

See also: [index](index.md), [backend](backend.md), [persistence](backend-persistence.md), [realtime](backend-realtime.md), [director](director.md), [paradox-launcher](paradox-launcher.md), [setup](setup.md).
