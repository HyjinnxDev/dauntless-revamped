# Findings

Code audit of `D:\Dev\dauntless-revamped`, 2026-10-23. Read-only: no code was changed. Each finding was
checked against the code at the line given. Uncommitted work on `main` at the time (hunt stats, cell-core
upgrades, QuestDiff) was included as it stood.

Severity: **critical** = exploitable now with serious impact · **high** = real security/data risk or
player-facing breakage · **medium** = real bug or risk with limits · **low** = minor bug, perf, dead code or
maintenance hazard.

Overall: the upstream Mystic Paradox core (inventory transactions, wallet, store, per-route ownership
checks, the launcher's Electron hardening, the 1.4.4 gateway) is carefully hardened. Most risk sits in
**deployment config** and in **newer Revamped features** that were built for a Tailscale-only server and
are now on the public internet.

No critical findings.

**Resolved since (2026-10-24, live on `main`):** L4 fixed; L8 mostly fixed; H4 re-rated (the 500 is deliberate, see its status). Also fixed then, found while writing the wiki: a ban now closes chat/voice and revokes sessions on every character slot (`controllers/admin.ts`); published `partyOutbox` rows expire after a day (`ttlAt` TTL); bounty grant windows roll instead of ending 2027-12-31 (`routes/tuning.ts`); a blank `MAX_CONCURRENT_HUNT_SERVERS` means 3, not 0; `reset_mastery.cjs --apply` needs `--confirm=RESET_ALL_MASTERY`; hunt pass progress and Elite purchases no longer change keys when passes move (two-week seasons, one pass per season, `huntPassRotation.ts`); Challenges no longer show "~27000 days" to unlock.

**Fixed on branch `fix/cleanup-sweep` (2026-10-28, not merged or deployed yet):** L1, L2, L13, L16. Plus about 40 bugs not listed here, found in a second sweep (launcher sign-in/download races, backend crash paths, store/party/chat fixes); see that branch's commits.

---

## High

### H1. Live backend runs without `NODE_ENV=production`, so every production safety check is off
- **Where:** `versions/1.14.7/ParadoxBackend/src/config/runtimeSafety.ts:28`, `src/controllers/admin.ts:69-77`, `src/server.ts:86,100,150`, live `ParadoxBackend/.env` (no `NODE_ENV`), `package.json` `start` script (`node --env-file=.env build/server.js`)
- **What:** `AssertRuntimeSafety` returns at line 28 unless `NODE_ENV === "production"`. The live `.env` does not set it and nothing else does. So on the public server:
  - admin sign-in needs only a password (`ADMIN_TOTP_SECRET` is unset, and MFA is only enforced in production);
  - `REALTIME_XMPP_DEV_CITY_MUC=true`, `MYSTICPARADOX_BODY_CAPTURE`, `MYSTICPARADOX_INV_CAPTURE_RAW`, `AUTH_MODE=NONE`, `ALLOW_NO_AUTH_DEV_MODE` would all be accepted silently;
  - the HTTPS listener can fail to bind and the process stays up half-working (`server.ts:86`);
  - `MYSTICPARADOX_SERVICE_ROLE` is blank (combined), and no metrics token is required.
- **Why it matters:** the repo is public and the server is open to outside players. A staff password is now the only gate to the `/admin` console, which can delete players, change roles, ban, and restart the stack.
- **Fix:** add `NODE_ENV=production` to the live backend `.env`. Then fix what the startup check reports: set `ADMIN_TOTP_SECRET` (or better, per-staff TOTP, see M6), set `MYSTICPARADOX_SERVICE_ROLE=api` and `MYSTICPARADOX_METRICS_TOKEN`. City chat needs `REALTIME_XMPP_DEV_CITY_MUC=true`, which the check forbids, so give the city room a proper non-dev flag (or add a reviewed exception) instead of leaving production mode off.

### H2. Unauthenticated crash-report upload can fill the disk and post attacker text to GitHub
- **Where:** `versions/1.14.7/ParadoxBackend/src/routes/crashReports.ts:138-175` (route), `:24-29` (limits), `:100-112` (issue text), `:57-58` (issue caps)
- **What:** `PUT /crash/v1/reports/:id/:fileName` needs no auth. The only limits are 90 uploads per IP per hour and a global cap of 2000 report folders, each holding up to 32 MB of minidump plus 2.5 MB of other files. Report folders are never cleaned up. Every new crash "signature" opens a GitHub issue (up to 50 per hour, plus 200 comments) whose title and first line come straight from the uploaded JSON (`exception.name`, `where`, `role`, `runtime`), outside the code fence.
- **Why it matters:**
  - Anyone can push about 70 GB onto the host disk. Once 2000 folders exist, real crash reports are refused (507) forever.
  - Anyone can open 50 GitHub issues an hour with their own text, including `@mentions` that notify people.
  - Minidumps of client processes can hold session tokens. They are kept forever.
- **Fix:** require the launcher bearer or game exchange identity (the client already has one), or at least a per-install signed token. Escape `@` in issue text, or put every attacker-controlled field inside the fence. Add age-based cleanup (for example, delete folders older than 30 days) instead of a hard folder cap.

### H3. Voice relay is plaintext UDP on the public internet; its 24 h ticket also authorises party hunt-joins
- **Where:** `versions/1.14.7/ParadoxBackend/src/voiceRelay.ts:28` (the `ponytail:` note relies on Tailscale), `:39` (`TICKET_TTL = "24h"`), `:51-63`; `ParadoxRuntime/Voice.cpp:206-209` (`SendHello` sends the ticket in clear); `src/routes/party.ts:73-76,86-117`
- **What:** the design assumed Tailscale encrypts the path. Launcher 0.2.8 dropped Tailscale and the server now takes public players. Voice frames and the `'H'` hello packet carrying the RS256 voice ticket travel unencrypted. After a hello, the relay identifies a peer only by source `address:port`. The same ticket is accepted as the identity for `GET /mystic/party/hunt-offer` and `POST /mystic/party/join-hunt`.
- **Why it matters:** anyone on the path (shared Wi-Fi, an ISP, a hostile hop) can listen to party voice, and can replay a captured ticket for up to 24 hours to impersonate that player on the relay and on the two party endpoints.
- **Fix:** short-lived tickets (minutes, refreshed through the launcher session), and a per-session key for frame authentication (for example HMAC over each packet with a key handed out over HTTPS). Ideally encrypt frames (DTLS, or libsodium secretbox with that key). Give the party endpoints their own audience instead of reusing the voice ticket.

### H4. Hunt-server cap returns 500, not the documented Ramsgate fallback
- **Where:** `versions/1.14.7/ParadoxDirector/src/controllers/gameservers.ts:259-266` (comment: "the matchmaker route catches it and falls back to Ramsgate"), `:475-481` (throw), `src/routes/matchmaker.ts:34-40` (generic catch → 500)
- **What:** nothing catches `NoHuntCapacityError`. When `MAX_CONCURRENT_HUNT_SERVERS` is reached, the route returns `500 matchmaking_failed` and the backend treats it as a matchmaking failure.
- **Why it matters:** at peak load every new hunt fails, with a generic error and no queue or fallback. The comment says the opposite, so anyone debugging it will be misled.
- **Fix:** catch `NoHuntCapacityError` in `HandleMatchmakingRequest` or the route and return a distinct status (for example `503 { error: "hunt_capacity" }`). Have `controllers/matchmaking.ts` retry or show a "servers full" message. Or implement the Ramsgate fallback the comment describes. Update the comment either way.
- **Status (2026-10-24):** partly addressed. The route does catch it (`routes/matchmaker.ts` -> 500 `matchmaking_failed`), and refusing a Ramsgate fallback is deliberate (`controllers/matchmaker.ts`: it would make the UI claim a hunt was found). The misleading comments in `gameservers.ts` and `.env.example` are fixed. Still open: a distinct "servers full" status/message.

---

## Medium

### M1. Launcher runs native code from any server without checking the runtime signature
- **Where:** `launcher/src/main/hostapi.ts:320-334` (`ponytail:` note), `launcher-bridge` has the same code
- **What:** `MysticParadox.dll` and `winmm.dll` are downloaded from the invite's server and checked only against the SHA-256 that the same server publishes. The Ed25519 signature in the manifest is not verified.
- **Why it matters:** the launcher supports adding any community server through a `dauntless-revamped://` invite link. A hostile or compromised host gets arbitrary native code running in the player's game process. Players will not expect "join a server" to mean that.
- **Fix:** carry the host's runtime-signing public key in the invite (and pin it next to the certificate fingerprint), and verify the manifest signature before installing. At minimum, warn clearly when adding a server that it will run code on the player's PC.

### M2. Test bundle and test stack carry live secrets and the full live database
- **Where:** `deploy/make-bundle.ps1:57-58,74-85` (backend `.env` copied with only Discord/GitHub/publisher keys blanked), `:96-99` (TLS certs), `:102-110` (`mongodump` of the live DB); `versions/1.14.7/host/test-stack.ps1:80-90,142` (`Write-TestEnv` from the live `.env`); `deploy/install.ps1:103` (invite codes written to `C:\Revamped\invites.txt`)
- **What:** the test server gets the live JWT signing keys, `GAMESERVER_API_KEYS`, `API_KEY_HASH_SECRET`, admin settings, the TLS private key and a copy of every account (emails, password hashes, inventories). It sits on another machine and a USB stick, and is opened to outside testers.
- **Why it matters:** tokens minted by the test server are valid on live and the reverse, and the game-server key works on both. Compromising the less-watched test box, or losing the USB stick, means compromising live.
- **Fix:** generate fresh signing keys, gameserver key and hash secret for the test environment (`configure-selfhost.ps1` already does this). Use a separate certificate. Copy the database only with personal fields scrubbed, or seed test accounts instead.

### M3. Group chat: nick impersonation and no flood limit
- **Where:** `versions/1.14.7/ParadoxBackend/src/realtime/RoomService.ts:125` (nick taken from the client's join JID), `:147-175` (`groupMessage`, no rate limit)
- **What:** the MUC nick is whatever the client puts after the `/` in the room JID; the backend never ties it to the player's display name. `groupMessage` has no per-connection or per-account limit (`DirectChatService` does).
- **Why it matters:** with city chat now on, any player can post in Ramsgate under another player's name, or flood every room up to the frame limit.
- **Fix:** set the nick server-side from the account's display name (ignore the requested nick, or reject a mismatch). Reuse `DirectChatService`'s `consumeRate` windows in `groupMessage`.

### M4. Hunt-room dev flag defaults on and is not covered by the production check
- **Where:** `versions/1.14.7/ParadoxBackend/src/realtime/RoomService.ts:49-53`, `src/config/runtimeSafety.ts:35`
- **What:** `REALTIME_XMPP_DEV_HUNT_MUC` defaults to on ("DEV-ONLY, INSECURE"): any signed-in user may join any `Hunt-*` room. `AssertRuntimeSafety` only checks the City flag.
- **Why it matters:** players can read and post in other parties' hunt chat if they learn the room id. Even after H1 is fixed, this stays open silently.
- **Fix:** map hunt rooms to the players the Director reports for that hunt (the backend already tracks hunt membership for late joins), then default the flag off and add it to the production check.

### M5. Admin MFA is one shared secret with no replay protection
- **Where:** `versions/1.14.7/ParadoxBackend/src/controllers/admin.ts:69-77`, `src/security/totp.ts`
- **What:** one `ADMIN_TOTP_SECRET` for every staff member; a used code is not remembered, so it can be replayed within its window. Combined with H1 it is currently off entirely.
- **Why it matters:** anyone given the secret for one staff account can pass MFA for all of them. Removing one moderator means rotating it for everyone.
- **Fix:** store a TOTP secret per staff account (enrol in the console), and record the last used time step per account to block replays. The Discord admin sign-in path also exists; consider making it the only path for owners.

### M6. Backend runs elevated on the host PC
- **Where:** `versions/1.14.7/host/restart-server.ps1:9-16` (self-elevates), `src/controllers/adminServers.ts:128-131,227` (dashboard restart requires an elevated backend)
- **What:** the stack is started from an elevated PowerShell, so the backend and Director run as administrator on a personal machine.
- **Why it matters:** any remote-code bug in the backend, its dependencies or a game-server exploit runs with admin rights on the owner's PC.
- **Fix:** run the backend and Director as a normal user. Do the one admin-only step (stopping processes started elevated) by not starting them elevated in the first place, or through a narrowly scoped scheduled task. Restart from the dashboard then works without elevation.

### M7. Fake gameserver header buys a 10x rate-limit budget and a DB scan per request
- **Where:** `versions/1.14.7/ParadoxBackend/src/security/rateLimit.ts:38-40,60-66`, `src/persistence/mongo/repositories/MongoApiKeyRepository.ts:42,79`
- **What:** the global limiter picks the 6000/min "gameserver" bucket just because the `x-mysticparadox-gameserver-apikey` header is present, before the key is checked. Every check of that key (and every user API-key lookup) loads the whole key collection with `find({})`.
- **Why it matters:** any client gets 10x the normal request budget on routes that don't use `HasParadoxBackendAuth` (crash uploads, launcher endpoints, `/content`), and each forged request on an authenticated route costs a full collection read.
- **Fix:** only use the gameserver bucket for requests from known game-server addresses (the Director's `MY_IP`, loopback), or validate the key before choosing the bucket and cache valid hashes in memory for a minute. Look keys up by hash (`findOne({ keyHash })`) instead of scanning.

### M8. Player deletion leaves orphan rows
- **Where:** `versions/1.14.7/ParadoxBackend/src/persistence/mongo/repositories/MongoAdminRepository.ts:87-135`
- **What:** `deletePlayerData` removes accounts, sessions, characters, friendships and API keys, but not guild membership/invites, slayer links, bounty and cooldown state, entitlements, escalation progress, party membership, hunt stats or Gauntlet clears. `deleteCharacterSlot` (~143-150) cleans several of these, so the two paths have drifted.
- **Why it matters:** a deleted guild member stays listed in the guild; a deleted guild leader can leave a guild nobody can manage. Personal data is left behind after a deletion request.
- **Fix:** keep one list of user-owned collections and use it in both delete paths. Add a test that every collection with a `userId`/`accountId` field is covered.

### M9. UDP encryption key lookup can hand one player's key to another
- **Where:** `versions/1.14.7/ParadoxBackend/src/encryptionKeyStore.ts:62-76`
- **What:** when a lookup matches neither a candidate id nor a token, it returns the most recently issued key.
- **Why it matters:** with several players connecting at once, a game server can be given the wrong player's key, so that player fails to connect (and the key goes to the wrong session).
- **Fix:** return "not found" instead of falling back, and fix whichever request shape needed the fallback by sending the candidate id or token.

### M10. RuntimeLoader can load an unverified legacy DLL
- **Where:** `versions/1.14.7/tools/RuntimeLoader/src/lib.rs:13-14,44-59`
- **What:** `winmm.dll` loads whichever of `MysticParadox.dll` or `MystPaxInternalServer.dll` has the newer modified time. Launchers only hash `MysticParadox.dll` and `winmm.dll`.
- **Why it matters:** a stale or planted `MystPaxInternalServer.dll` with a newer timestamp is loaded instead of the verified runtime.
- **Fix:** drop the legacy name (the rename was 8 Oct), or load it only when `MysticParadox.dll` is absent.

### M11. `MpLog` opens and flushes a file on every call, from every thread
- **Where:** `versions/1.14.7/ParadoxRuntime/dllmain.cpp:211-233` (738 call sites in `dllmain.cpp`)
- **What:** each log line builds a path, opens an `std::ofstream`, writes, flushes and closes. There is no lock across threads (game thread, hooks, watchdog, HTTP threads) and no size cap or rotation.
- **Why it matters:** blocking disk I/O on the game thread causes hitches on clients and servers; lines from different threads can interleave; long-running hubs grow logs without bound.
- **Fix:** one open handle behind a mutex (or a lock-free queue drained by a background thread), with a size cap and one rotated file.

### M12. Server runtime initialisation runs inside `DllMain`
- **Where:** `versions/1.14.7/ParadoxRuntime/dllmain.cpp:24682-24685` (`DLL_PROCESS_ATTACH` → `Init()`), `:24572-24600` (`std::stoi(Args[2])`)
- **What:** `Init()` parses arguments and installs hooks while holding the loader lock. `std::stoi` on a bad port argument throws an uncaught C++ exception there.
- **Why it matters:** a bad launch argument kills the server with no log line. Work under the loader lock (file I/O, MinHook, thread creation) is a known source of deadlocks that show up rarely and are hard to diagnose.
- **Fix:** in `DllMain`, only start a thread that runs `Init()`. Parse the port with `wcstol` and an explicit range check, and log and exit cleanly on failure.

### M13. `dllmain.cpp` is a single 24,700-line file holding almost every feature
- **Where:** `versions/1.14.7/ParadoxRuntime/dllmain.cpp`
- **What:** hooks for nearly every feature, around 90 `*.flag` file toggles, many one-off probe hooks, and hard-coded addresses for build 647472, all in one translation unit. Newer features (Voice, CineCam, WindowLock, HuntStats, JoinPrompt) already live in their own files.
- **Why it matters:** slow builds, merge conflicts with every upstream subtree pull, and finished probes that never get removed. Hard to review.
- **Fix:** continue the existing pattern: move one feature at a time into its own `.cpp` with a small header, starting with the probes, which can then simply be deleted.

### M14. `launcher/` and `launcher-bridge/` are near-duplicate trees
- **Where:** `launcher/src`, `launcher-bridge/src` (about 22 of 45 source files differ, mostly branding; `pinned.ts`, `relay.ts`, `downloader.ts`, `verify.ts` are byte-identical)
- **What:** two copies of the same security-sensitive launcher code.
- **Why it matters:** every security fix (M1, for example) must be made twice, and the copies are already drifting.
- **Fix:** retire `launcher-bridge` once old Forever installs have migrated (check the launcher logs for 0.1.x versions). Until then, freeze it and only change the hand-over path.

### M15. Gameserver API key is on the game-server command line
- **Where:** `versions/1.14.7/ParadoxDirector/src/controllers/gameservers.ts:525-527`; `ParadoxRuntime/dllmain.cpp:24577-24580`; same in `versions/1.4.4/UndauntedDeployServer/src/controllers/gameservers.ts:283-296` (which also passes its whole environment to the child)
- **What:** the key that lets a caller grant items and currency to any account is argv[1] of every game-server process.
- **Why it matters:** any local process or user can read it from the process list (WMI, Task Manager). It authorises the backend's gameserver API and the Director admin API.
- **Fix:** pass it through an environment variable on the child (the Director already sets a custom `env`) or a pipe, and have the DLL read it from there. In 1.4.4, pass only the variables the game needs.

---

## Low

### L1. Rate-limit map is never pruned
- **Where:** `versions/1.14.7/ParadoxBackend/src/security/rateLimit.ts:14-26`
- **What / why:** `IsRateLimited` keeps a `Map` keyed by IP, email and route that only filters the touched key. Keys from one-off IPs stay forever, so memory grows slowly under scanning traffic. The comment at the top already says it isn't ready for a public launch.
- **Fix:** sweep keys whose newest timestamp is older than the window, every few minutes.

### L2. XMPP auth throttle map only shrinks on success
- **Where:** `versions/1.14.7/ParadoxBackend/src/realtime/authThrottle.ts:25`
- **What / why:** IPs that only ever fail auth are never removed. Same slow leak as L1.
- **Fix:** the same periodic sweep.

### L3. Voice bans don't survive a restart
- **Where:** `versions/1.14.7/ParadoxBackend/src/voiceRelay.ts:240` (`VoiceBlockedUntil`)
- **What / why:** voice mutes from `/admin` live only in memory. A backend restart un-mutes everyone, and an already-connected peer keeps talking until its next hello.
- **Fix:** store mutes with the other access controls on the account (bans already persist) and drop matching peers immediately.

### L4. Gameserver request with bearer and a bad token returns 500
- **Where:** `versions/1.14.7/ParadoxBackend/src/middleware/HasParadoxBackendAuth.ts:67-74`
- **What / why:** in the gameserver branch, `ValidateMetagameJWTAndGetPayload` is called outside the `try`. An expired player token throws, and Express 5 turns it into a 500 instead of a 401, which makes logs misleading.
- **Fix:** wrap it in the same `try/catch` as the player branch.
- **Status:** fixed 2026-10-24 (`394a493`): 401.

### L5. Phantom-player fallback hard-codes an account name
- **Where:** `versions/1.14.7/ParadoxBackend/src/middleware/HasParadoxBackendAuth.ts:58,89-93`; `src/routes/inventory.ts:153-159`
- **What / why:** gameserver GETs with the `INVALID` sentinel are rewritten to `GAMESERVER_NO_PLAYER_USER_ID ?? DEV_USER_ID ?? "mystpax"`. Bearer-less gameserver writes are attributed to the configured account if one is set. Neither is set live, so GETs read whatever account is literally called `mystpax`. A leftover from single-account development.
- **Fix:** return empty data for `INVALID` (as several routes already do with `NO_PLAYER_SENTINEL`) and drop the fallback account.

### L6. Hub readiness reports ready even when both hubs failed
- **Where:** `versions/1.14.7/ParadoxDirector/src/server.ts:37`
- **What / why:** `Startup()` never throws, so `SetPersistentHubsReady(true)` runs and `/health/ready` returns 200 even if Ramsgate and the Dojo never came up.
- **Fix:** set ready only after both hubs print their ready line.

### L7. Director rosters only grow
- **Where:** `versions/1.14.7/ParadoxDirector/src/controllers/gameservers.ts:729-759,1146-1155`
- **What / why:** a hunt's expected-player list is never decremented when a player leaves, so reuse and public join can refuse valid joins for up to 90 s (noted in a `ponytail:` comment).
- **Fix:** decrement on the leave/state reports the server already sends.

### L8. Hard-coded upstream key and domain in the Director's runtime updater and publish script
- **Where:** `versions/1.14.7/ParadoxDirector/src/runtimeUpdater.ts:13-18`; `ParadoxLauncher/scripts/publish-runtime-update.mjs:51-67`
- **What / why:** the server-runtime public key and default manifest URL are the upstream project's, with no env override (the launcher has `MYSTICPARADOX_RUNTIME_PUBLIC_KEY_B64`). An operator signing with their own key gets every update rejected. The publish script also overwrites an existing version folder and defaults `--base-url` to the upstream domain.
- **Fix:** read the key and URL from env with the current values as defaults. Refuse to publish over an existing version.
- **Status:** mostly fixed 2026-10-24 (`394a493`). Director and backend upload routes embed the self-host public key (Guard manifests keep the upstream one); the Director has no default manifest URL (`SERVER_RUNTIME_MANIFEST_URL` required when auto-update is on); the publish script refuses an existing version unless `--force` and always re-signs every file. Still open: no env override for the key, and `--base-url`/`--key` defaults are still upstream's.

### L9. Release script calls a file that doesn't exist
- **Where:** `versions/1.14.7/ParadoxLauncher/scripts/build-launcher-release.ps1:33`
- **What / why:** it runs `versions/1.14.7/scripts/extract-nsis-launcher-payload.mjs`, which is not in the tree. The release fails after the build step.
- **Fix:** restore the script from upstream or remove the step.

### L10. Unverified installer download in the bridge launcher
- **Where:** `launcher-bridge/src/main.ts:89,104-108`
- **What / why:** the hand-over downloads `releases/latest/download/DauntlessRevampedLauncher-Setup.exe` and runs it with no hash or signature check. The only trust is the GitHub account and TLS.
- **Fix:** ship the expected SHA-256 in the bridge build, or verify an Authenticode signature, before spawning.

### L11. Leftover probes and dead toggles
- **Where:**
  - `versions/1.14.7/ParadoxBackend/src/app.ts:256-262`: `TrialsSubmitProbe` answers 200 to any unknown `leaderboard` route and logs 8 KB of each body.
  - `ParadoxRuntime/dllmain.cpp:18718`: `if (MpExeRelativeFlagPresent(L"DISABLE_EAC_LOAD.flag") || true)`, so the flag does nothing.
  - `ParadoxBackend/src/controllers/character.ts:562-572`: `[QuestDiff]` parses the whole character blob twice on every save (uncommitted diagnostic).
- **Why it matters:** log noise, extra work on hot paths, and switches that look like they work but don't.
- **Fix:** remove each once its question is answered. The `|| true` should become an unconditional block with a comment.

### L12. Dead realtime modules
- **Where:** `versions/1.14.7/ParadoxBackend/src/realtime/stateMachine.ts`, `realtime/services.ts`, `realtime/RealtimeEventBus.ts`
- **What / why:** only referenced by tests. `services.ts` declares `RoomService`/`PresenceService` interfaces whose names clash with the real classes. Misleading for anyone reading the realtime code.
- **Fix:** delete them with their tests (or wire `stateMachine` into `XMPPSession`, which currently skips it).

### L13. Second XMPP `<bind>` leaves a ghost session
- **Where:** `versions/1.14.7/ParadoxBackend/src/realtime/XMPPConnection.ts:148-153`
- **What / why:** a second bind on the same socket registers a new resource without unbinding the old one. The old entry keeps `isOnline()` true and receives pushes until restart.
- **Fix:** refuse a second bind, or unbind the previous resource first.

### L14. Party outbox polls Mongo 4 times a second forever
- **Where:** `versions/1.14.7/ParadoxBackend/src/realtime/PartyOutboxDispatcher.ts:51`
- **What / why:** a 250 ms `claimNextOutbox` poll runs even when idle. Events for offline recipients are marked published and dropped (clients fall back to polling `/party`).
- **Fix:** back off when the queue is empty (or use a change stream, which the replica set already supports).

### L15. Docs that disagree with the code
- **Where:**
  - `versions/1.14.7/docs/SELF_HOSTING.md`: describes MongoDB on 27017 and the Tauri launcher as the player launcher; the live setup is a replica set on 27018 with the Electron `launcher/`.
  - `launcher/src/main/game-manifest.ts:2`: says 1.4.4; the build aliases the 1.14.7 manifest.
  - 1.4.4: `docs/reference/ports.md:56` (says chat needs `CHAT=1`, but chat is on by default); `UndauntedGateway/README.md` (lists 4 public routes, `src/policy.ts:21` allows 5, `ALLOWLIST_ADDITIONAL_URLS` undocumented); `UndauntedLauncher/README.md` (`dauntless-revived://`; the code registers `dauntless-forever://`).
- **Fix:** update the text. The wiki in `docs/wiki/` notes the live values.

### L16. Discord bot: no `/issue` limits, shared state file
- **Where:** `discord-bot/src/issues.ts:46,110`; `discord-bot/src/status.ts:33`
- **What / why:** no per-user cooldown or open-ticket cap on `/issue`, and the whole `issues.json` is rewritten each time. Two bot instances would overwrite each other. A malformed `/health/ready` body shows "0 slayers online" instead of offline.
- **Fix:** a per-user cooldown and max open tickets; treat a non-numeric `players` as offline.

### L17. Self-reported launcher attestation
- **Where:** `versions/1.14.7/ParadoxBackend/src/controllers/launcherAuth.ts:410-418`
- **What / why:** `executableSha256` and runtime artifact hashes that gate exchange-code issue are reported by the launcher itself. A modified launcher can send the approved values. That is fine as a compatibility check, but it should not be relied on as anti-cheat.
- **Fix:** none needed. Document it as advisory (the wiki does).

### L18. 1.4.4 legacy stack items
- **Where / what:**
  - `versions/1.4.4/UndauntedMetagame/src/routes/eos.ts:69-71`: no response is sent when no login method is configured, so the request hangs.
  - `UndauntedMetagame/src/controllers/auth.ts:31`, `controllers/apikeys.ts:25`: full-table key scans per login and per game-server request (same pattern as M7).
  - `UndauntedMetagame/src/drizzle/meta`: snapshots stop at 0016 while migrations go to 0029, so `db:generate` would emit duplicate DDL.
  - `UndauntedMetagame/src/db.ts:35`: migrations folder is relative to the working directory.
  - `UndauntedMetagame/src/app.ts:36`: 50 MB JSON body limit on every route (the gateway caps at 128 KiB, but private/loopback mode has no cap).
  - `UndauntedMetagame/src/controllers/accountrecovery.ts:9`: with `ACCOUNT_KEY_RECOVERY=1`, account keys are stored reversibly under a key derived from the JWT signing key.
  - `UndauntedInternalServer/dllmain.cpp:1281`: a blocking `MessageBoxA` on bad server arguments can hang a headless server.
- **Fix:** small, local fixes as listed. Only worth doing if 1.4.4 is still deployed anywhere.

### L19. Process notes
- Uncommitted feature work sits on `main` (hunt stats, cell-core upgrades, QuestDiff, runtime changes), against the repo rule "work on a branch". Easy to deploy or lose by accident.
- About 20 `.bak`/timestamped JSON backups sit in `ParadoxBackend/game-data/` (gitignored). Move them out of the source tree.

---

## Checked and found sound

So reviewers don't redo it:
- Inventory/wallet: player bearers cannot grant or spend (`routes/inventory.ts:258-268`); quantities validated as non-negative integers (`validation.ts:58-59`); currency changes are guarded `$inc` with no negative balances (`controllers/wallet.ts:71-118`); transaction ids are idempotency keys inside a Mongo transaction.
- Per-player routes use the token's own user id unless the caller is a game server (inventory, loadout, progression, slayer links, escalation).
- Admin console: hashed opaque session cookie, CSRF token on writes, origin allow-list, staff permission per route; server-control commands use fixed arguments and an allow-listed log list.
- Director binds to 127.0.0.1; server runtime auto-update verifies an Ed25519 signature.
- Launcher (Electron): context isolation, sandbox, fuses; IPC checks sender and arguments; `openExternal` uses fixed URLs; game files are verified against a compiled-in SHA-256 manifest; no archive extraction.
- 1.4.4 gateway allowlist helper (runs as SYSTEM) validates every IP as canonical before building its firewall script.
