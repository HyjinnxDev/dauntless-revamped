# ParadoxBackend realtime (XMPP, chat, presence, party events, voice)

> Verified against code 2026-10-24.

## What it is

The 1.14.7 game client expects an Epic-style XMPP service for friend presence, whispers, party/island chat and friend/party push notifications. Epic's service is gone, so the backend runs its own small XMPP server: an RFC 7395 "XMPP over WebSocket" endpoint attached to the backend's existing HTTPS listener. It lives in `versions/1.14.7/ParadoxBackend/src/realtime/`. State is in memory (one backend process); durable truth (friendships, parties, guilds) stays in Mongo and is only read, except for party presence events and the stale-member removal described below.

Party voice is a separate, non-XMPP piece: a UDP relay in `src/voiceRelay.ts` (next to `realtime/`, not inside it). It is documented here because it is the other half of "realtime" for the client.

Part of the [backend](backend.md). Persistence side: [backend persistence](backend-persistence.md).

## File reference

All paths are under `versions/1.14.7/ParadoxBackend/src/`.

| File | What it does |
|---|---|
| `realtime/index.ts` | `initRealtime(httpsServer)` (reads `REALTIME_XMPP_*` env into a `RealtimeConfig`, creates and attaches one `RealtimeGateway`; safe when disabled), `shutdownRealtime()`, `getRealtimeGateway()`. |
| `realtime/types.ts` | `REALTIME_WS_PATHS`, `XmppState` enum, `RealtimeLimits` + `DEFAULT_LIMITS`, `RealtimeConfig`, `Jid`, `ConnectionInfo`. |
| `realtime/RealtimeGateway.ts` | `RealtimeGateway`: HTTP `upgrade` handler on the HTTPS server (`ws` in `noServer` mode, `maxPayload` = 64 KiB, echoes subprotocol `xmpp`). Runs the upgrade checks, owns the live connection map and per-IP counts, `listConnections()`, graceful `shutdown()` (close 1001, 250 ms, terminate). |
| `realtime/XMPPConnection.ts` | One WebSocket. Frame size cap (close 1009), binary frames ignored, optional capture log, frames processed one at a time on a promise chain. Executes each `SessionAction`: send frames, bind registry, write `lastSeenAt`/`lastSeenIp`, auth throttle, presence, MUC, direct chat, close. 15 s handshake and 5 min idle timers. `teardown()` leaves rooms, unbinds, schedules offline. |
| `realtime/XMPPSession.ts` | Pure per-connection protocol logic over `ltx.parse`: stream open/reopen, SASL, bind, ping, generic IQ, presence, message. Returns a `SessionAction` (frames + intents) for the connection to execute. |
| `realtime/XMPPAuth.ts` | `authenticateSasl(mechanism, b64)`: PLAIN parse, JWT verify (`ValidateMetagameJWTAndGetPayload`), userId checks, launcher-account eligibility. Never logs credentials. |
| `realtime/saslPlain.ts` | `parseSaslPlain`: dependency-free RFC 4616 parser (mechanism `PLAIN`, 8 KiB base64 / 6 KiB decoded caps, exactly three NUL fields). |
| `realtime/authThrottle.ts` | Per-IP SASL failure throttle: block after 5 failures, 5 s doubling to 10 min, counter decays after 5 min idle, success clears it. `isAuthThrottled`, `recordAuthFailure`, `recordAuthSuccess`. |
| `realtime/SessionRegistry.ts` | `SessionRegistry` (`accountId -> resource -> connection`), singleton `sessionRegistry`: `bind` (returns a displaced connection), `unbind` (only if still the same conn), `isOnline`, `connectionsFor`, `connectionFor`, `onlineAccountCount`, `onlineAccountIds`. `RegisteredConnection` interface. |
| `realtime/PresenceService.ts` | `PresenceService` class + module functions `onResourceAvailable` / `onResourceUnavailable`. Friend online/offline fan-out with the reconnect grace, party ONLINE/OFFLINE outbox events, stale party member removal. |
| `realtime/RoomService.ts` | Minimal MUC (XEP-0045): `parseRoomJid`, `RoomService` (`joinRoom`, `groupMessage`, `leaveRoom`, `onConnectionClosed`, `evictPartyMember`), singleton `roomService`. |
| `realtime/DirectChatService.ts` | `DirectChatService.routeDirectMessage`: friend-only one-to-one chat, rate limits, error stanzas. Singleton `directChatService`. |
| `realtime/friendEvents.ts` | `PushFriendEvent` (Epic friends-service JSON as an XMPP message) and `AnnounceCharacterSwitch`. |
| `realtime/PartyOutboxDispatcher.ts` | `PartyOutboxDispatcher` + singleton `partyOutboxDispatcher`: polls the Mongo party outbox and pushes events as XMPP headline messages. |
| `realtime/jid.ts` | `parseJid` (split on first `/`, lowercases local and domain, keeps resource verbatim), `bareJid`, `fullJid`, `sameBareJid`. |
| `realtime/xml.ts` | `escapeXml`, `redacted` (`<redacted:len>` marker), `sanitizeName` (strip control chars, cap length). |
| `realtime/XMPPProtocol.ts` | `summarizeFrame`: sanitized structural one-line summary of a frame for `[XMPP-CAP]` logs (names and capped attribute values; all text redacted). |
| `realtime/ltx.d.ts` | Ambient TypeScript declarations for the `ltx` XML library (`parse`, `escapeXML`, `Parser`, `Element`). |
| `realtime/stateMachine.ts` | `ALLOWED_TRANSITIONS`, `canTransition`, `canAcceptStanza`. Not on the live path; only its test uses it. |
| `realtime/services.ts` | Interface-only sketches (`AuthService`, `PresenceService`, `RosterService`, `ChatService`, `PartyAuthAdapter`, `RoomService`). Not implemented or imported. |
| `realtime/RealtimeEventBus.ts` | Typed `EventEmitter` wrapper + singleton `realtimeEventBus`. No publishers or subscribers anywhere. |
| `realtime/*.test.ts` | Unit tests for JID, XML, SASL/auth, presence, rooms, direct chat, registry, state machine (`npm run test:realtime`). |
| `voiceRelay.ts` | UDP voice relay: ticket sign/verify, `ParsePositionReport`, `VoiceRelayState` (peers, party cache, positions, routing), `StartVoiceRelay`, `SetVoiceBlocked`, `DefaultRelayDeps`. |
| `server.ts` | Starts everything: `partyOutboxDispatcher.start()`, `initRealtime()` before the HTTPS `listen()`, `StartVoiceRelay(VoicePort(), DefaultRelayDeps)`; shutdown calls `shutdownRealtime()` and `partyOutboxDispatcher.stop()`. |

## How it works

### Transport and ports

- No separate XMPP port. WebSocket upgrades arrive on the backend's **HTTPS listener** (`HTTPS_PORT`, default `3443` in code; production uses `443`). Normal REST routes are untouched.
- The client builds its WS URL as `ServerAddr + ":" + ServerPort`, so it requests the root path (seen as `//`). Accepted paths are an explicit allowlist: `//`, `/`, `/__ws/xmpp` (override with `REALTIME_XMPP_WS_PATHS`). Anything else gets `404`.
- Subprotocol `xmpp` is echoed if offered; not required.
- When `REALTIME_XMPP_ENABLED` is not the literal `true`, every upgrade is rejected with `503` and no XMPP state exists.
- Logical domains: presence, rooms, chat and pushes use hard-coded `prod.ol.epicgames.com`; MUC domain is `muc.prod.ol.epicgames.com`. `XMPPSession` echoes whatever `to` the client sent in `<open>` as the stream domain and in the bound JID. The client believes it is talking to Epic.
- Voice uses **UDP** on `VOICE_UDP_PORT` (default `8791`).

### Upgrade checks (RealtimeGateway)

In order: enabled/accepting (`503`), path allowlist (`404`), `Host` allowlist (`REALTIME_XMPP_ALLOWED_HOSTS`, empty = any; `403`), global cap 1000 (`503`), per-IP cap 8 (`429`), auth throttle (`429`). Frames are capped at 64 KiB (also enforced by `ws` `maxPayload`).

### Session lifecycle

1. **Connect.** `XMPPConnection` starts a 15 s handshake timer (must authenticate or it closes with 1008) and a 5 min idle timer (reset by any inbound frame or pong).
2. **Open.** Client sends `<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to=...>`. Server replies with `<open>` plus stream features advertising SASL `PLAIN` only.
3. **SASL PLAIN.** Authcid = the player's userId (the game userId, which is a character-slot id for slots 2+), password = the RS256 game JWT. `XMPPAuth.authenticateSasl` checks:
   - mechanism is `PLAIN`; blob size bounded; exactly three NUL-separated fields;
   - JWT verifies through `ValidateMetagameJWTAndGetPayload` (`controllers/auth`), has a string `userId`, and is not the launcher client-credentials service token (`__launcher_client_credentials__`);
   - `userId === authcid` (identity comes from the token, never the JID);
   - `launcherAccounts.findByUserId` finds the account (a slot id resolves to its owner) and `IsAccountEligible` passes (`security/accountEligibility`, so banned accounts cannot connect).
   Failure replies `<failure><not-authorized/>`; 3 failures close the socket (1008); failures also feed `authThrottle`.
4. **Reopen + bind.** After `<success/>` the client sends `<open>` again; server offers `bind`. The client's `<iq><bind><resource>` is accepted (empty or over 128 chars means a random server-assigned resource). Bound JID is `<accountId>@<domain>/<resource>`. The observed client resource looks like `V2:Jackal:WIN::<id>`.
5. **Registry.** `sessionRegistry.bind(account, resource, conn)`. If the same (account, resource) is already live on another socket, the old one is closed (`1001 replaced by a newer resource`). Also sets `lastSeenAt` / `lastSeenIp` on the `accounts` document for the staff dashboard (fire and forget).
6. **Session ready.** Other `iq get/set` get an empty result (this keeps the client advancing).
7. **Steady state.** Presence, MUC and chat stanzas (below).
8. **Teardown** (close, error, timeout, shutdown): timers cleared, MUC rooms left, registry unbound, `onResourceUnavailable` scheduled.

### Stanzas handled (XMPPSession)

| Inbound | Condition | Reply / effect |
|---|---|---|
| `<open>` (framing ns) | before auth | `<open>` + features with SASL `PLAIN` |
| `<open>` | after auth | `<open>` + features with `bind` |
| `<auth>` (SASL ns) | | `<success/>`, or `<failure><not-authorized/>` (3rd failure closes) |
| anything else | before auth | close 1008, no reply |
| `<iq>` with `<bind>` | | `<iq type="result"><bind><jid>` |
| `<iq>` with `<ping>` | | `<iq type="result"><ping xmlns="urn:xmpp:ping"/></iq>` (the Unreal client only counts this form; an empty result caused a ~150 s reconnect and presence flap) |
| other `<iq type="get\|set">` | | empty `<iq type="result">` |
| `<presence>` without `to` | | self presence: available unless `type="unavailable"` (PresenceService) |
| `<presence to=room>` | `type="unavailable"` | MUC leave |
| `<presence to=room>` | otherwise | MUC join |
| `<message type="groupchat" to=room>` | | MUC fan-out |
| `<message type="chat\|normal\|(none)" to=jid>` | | DirectChatService |
| anything else | | ignored |

### Presence (PresenceService)

- Only the first available presence per connection triggers fan-out (`presenceAvailable` in `XMPPConnection`); rich-status refreshes and travel are ignored.
- On the account's fresh online transition: send `<presence>` to every online **ACCEPTED** friend (friend list from `friendships.listForOwner`, which `CharacterAwareFriendships` resolves across character slots). The new resource gets a snapshot of which friends are online. Additional resources and reconnects within grace get the snapshot only. Non-friends get nothing.
- Going offline: only when the account's last resource is gone (an unavailable self presence while the socket is still bound does nothing), and only after a **grace period of 45 s** (`REALTIME_XMPP_RECONNECT_GRACE_MS`, read in `PresenceService`). Hunt/city travel drops and re-opens the socket, so a short grace caused false online/offline toasts. Reconnect within grace cancels the pending offline.
- Side effect: `recordPartyPresence` appends a `PARTY_PRESENCE_CHANGED` outbox event for the player's party (`payload: {accountId, state, observedAt}`), and on OFFLINE (after grace) removes the player from the party in a Mongo transaction (`parties.leave`; leader auto-promoted).

### Rooms / MUC (RoomService)

Joining = directed presence to `Room@muc.prod.ol.epicgames.com/<nick>`; leaving = directed `unavailable`. Authorization is by the **authenticated account**, never the nick:

| Room local part | Rule |
|---|---|
| `Party-<partyId>` | `GetPartyForPlayer(account).partyId` must equal `<partyId>` (party id already carries the `_<base64(buildId)>` suffix) |
| `Guild-<guildId>` | `IsGuildMember(account, guildId)` |
| `City-<uuid>` | Allowed for any authenticated user unless `REALTIME_XMPP_DEV_CITY_MUC=false` (no account-to-instance mapping exists) |
| `Hunt-<uuid>` | Same, controlled by `REALTIME_XMPP_DEV_HUNT_MUC` |
| anything else | Denied (error presence `not-allowed`) |

On join the joiner receives existing occupants' presence, existing occupants receive the newcomer, and the joiner gets self-presence with status 110 last. `groupchat` messages (max 4 KiB, non-empty, sender must be an occupant) fan out to all occupants including the sender. Rooms live in memory and vanish when empty. `evictPartyMember` removes a player from a `Party-` room when the outbox reports `LEAVE`/`DISBAND`/`KICK`/`MOVE`.

### Direct chat (DirectChatService)

`<message type="chat|normal">` to `<accountId>@prod.ol.epicgames.com[/resource]`. Checks in order: target JID well-formed on the right domain (`jid-malformed`), body non-empty and at most 4 KiB (`not-acceptable`), rate limits 12 msgs / 10 s per connection and 60 / 60 s per account (`resource-constraint`, before any DB lookup), not to self (`not-allowed`), both directed friendship edges `ACCEPTED` (`forbidden`; lookup error = `internal-server-error`). Delivered to the named resource or all resources of the recipient; offline = `service-unavailable`; no offline storage.

### Push messages

- **Friends** (`PushFriendEvent`): called from `routes/friends.ts` on invite/accept/remove. Sends a `<message from="xmpp-admin@prod.ol.epicgames.com">` whose body is JSON `{payload, type: "com.epicgames.friends.core.apiobjects.Friend|FriendRemoval", timestamp}`; the client's `FOnlineFriendsMcp::OnXmppMessageReceived` parses it. Without it, the other player only sees changes on their next friends fetch. `AnnounceCharacterSwitch(oldId, newId)` (called from `controllers/characters.ts` and `controllers/launcherAuth.ts`) sends every non-blocked friend a `FriendRemoval` for the old character id and a `Friend` for the new one, because friends are shared across an account's characters.
- **Party events** (`PartyOutboxDispatcher`): party mutations write outbox rows in Mongo (transactionally with the party change). The dispatcher polls every 250 ms and claims up to 64 events per drain (`claimNextOutbox`, oldest first; a `PROCESSING` claim older than 30 s can be re-claimed). For each event it evicts leavers from the `Party-` room, sends `<message type="headline" from="party-events@prod.ol.epicgames.com" id=eventId>` to each recipient's live resources, then `markOutboxPublished`. A publish error calls `releaseOutbox` and stops the drain. The body JSON is `{eventId, eventType, schemaVersion: 1, occurredAt, partyId, partyRevision, payload}`.

| Outbox `eventType` | Pushed `eventType` | Written by |
|---|---|---|
| `PARTY_CREATED` | `party.created` | `getOrCreateSolo` |
| `PARTY_INVITE_CREATED` | `party.invited` | `createInvite` (recipient only) |
| `PARTY_MEMBERSHIP_CHANGED` | `party.membership_changed` | accept (`JOIN`), leave/kick/move/disband |
| `PARTY_LEADER_CHANGED` | `party.leader_changed` | `promote` |
| `PARTY_ACTIVITY_CHANGED` | `party.activity_changed` | `setActivity` |
| `PARTY_PRESENCE_CHANGED` | `party.presence_changed` | `PresenceService` |
| `PARTY_HUNT_STATUS_CHANGED` | `party.hunt_status_changed` | nothing (type and mapping exist, no writer) |

  Mongo errors in a drain are caught and logged at most every 30 s (an unhandled rejection used to kill the process on Node 24).

### Voice relay (UDP)

Wire format is documented at the top of `voiceRelay.ts` (integers and floats big-endian, positions in UE units):

| Packet | Direction | Layout |
|---|---|---|
| `H` | client -> relay | `'H'` + ticket (utf8). Hello/keepalive every 5 s; answered `A` when the ticket is valid and the user is not voice-blocked. |
| `A` | relay -> client | `'A'` |
| `V` | client -> relay | `'V'` + seq u16 + Opus (one 20 ms frame) |
| `W` | relay -> client | `'W'` + sender key u32 (first 4 bytes of sha256(userId)) + seq u16 + flags u8 [+ x,y,z f32] + Opus. Flags bit0 = position follows (speaker's server-reported location, same room), bit1 = party member. |
| `P` | hub server -> relay | `'P'` + ts u64 (ms) + game port u16 + n u8 + n x {len u8, accountId, x, y, z f32} + HMAC-SHA256 (32 bytes) over everything before it, keyed with a `GAMESERVER_API_KEYS` key. |

1. Launcher login (`controllers/launcherAuth.ts`) returns `voiceTicket` (RS256 JWT, issuer `paradox-backend`, audience `mysticparadox-voice`, 24 h) and `voicePort`. The launcher passes `MYSTICPARADOX_VOICE_ADDR` (host:port) and `MYSTICPARADOX_VOICE_TICKET` to the game (`launcher/src/main/launch.ts`).
2. Client runtime (`ParadoxRuntime/Voice.cpp`): mic (WASAPI, 48 kHz mono) -> Opus 20 ms frames -> UDP.
3. Relay tracks peers by `ip:port` (15 s TTL; a new hello from another address replaces the old peer), limits 60 packets/s per peer and 1200-byte packets.
4. Routing: **party members** (from `GetPartyForPlayer`, cached 2 s) hear each other anywhere. **Everyone else** only if both are on the same game-server "room" (reporting address + game port) and within `HEAR_RADIUS` 4000 UE units (40 m).
5. Positions never come from the client. Hub game servers send signed `P` reports (strictly increasing `ts` per room, max 10 s clock skew, ~200 ms cadence; positions older than 1.5 s are dropped). `Voice.cpp` `MpVoiceServerStart` does this on the server side, sending to `MYSTICPARADOX_VOICE_RELAY` (default `127.0.0.1:8791`). A bad report is logged once per source address.
6. The relay is plain UDP, no encryption (the source comments say the path is expected to be Tailscale). A bind failure only loses voice (`server.ts` catches it).

The ticket is also used as a lightweight identity for `routes/party.ts` endpoints under `/mystic/party/*` (header `x-mystic-ticket`, e.g. the late-join hunt offer).

## Connects to

| Peer | How |
|---|---|
| Game client (UE 1.14.7) | XMPP WebSocket. The runtime DLL does NOT redirect XMPP (`InstallXmppConfigRedirectHook` in `ParadoxRuntime/dllmain.cpp` exists but is never called). Instead the Revamped launcher (`launcher/src/main/launch.ts` `pointXmppAtRelay`/`withXmppSection`) writes `[OnlineSubsystemMcp.XMPP]` `ServerAddr="ws://127.0.0.1"`, `ServerPort=<relay port>`, `bUseSSL=false` into the player's `Engine.ini`; the launcher's local relay forwards to the backend. The client authenticates with the same JWT it uses for REST. See [runtime](runtime.md), [launcher](launcher.md). |
| Runtime DLL voice | UDP to `MYSTICPARADOX_VOICE_ADDR` (client), signed position reports to `MYSTICPARADOX_VOICE_RELAY` (game server/hub). See [runtime](runtime.md). |
| Launcher | Gets the voice ticket + port at login; sets the env vars for the game. See [launcher](launcher.md). |
| Director / game servers | Hubs send `P` position reports; Director spawns them. See [director](director.md). |
| REST controllers | `routes/friends.ts` -> `PushFriendEvent`; `routes/party.ts` + `controllers/party` -> outbox rows, `GetPartyForPlayer`; `controllers/characters.ts`, `controllers/launcherAuth.ts` -> `AnnounceCharacterSwitch`; `controllers/admin.ts` -> `SetVoiceBlocked` and closes a suspended player's sockets via `sessionRegistry`. See [backend](backend.md), [security and admin](backend-security-admin.md). |
| `sessionRegistry` readers | `app.ts` (player count), `controllers/adminServers.ts` (online list), `controllers/characters.ts` (refuses to delete a slot that is online; reports `online` per slot), `controllers/launcherAuth.ts` (refuses to launch a slot while another slot of the account is online). |
| Mongo | `friendships`, `parties` (+ `partyOutbox`, `partyMemberships`), `accounts` (launcher account lookup, `lastSeenAt`/`lastSeenIp`), guild membership. See [backend persistence](backend-persistence.md). |
| Auth | `controllers/auth` JWT validator, `security/accountEligibility`. |

## Config

| Name | Default | Effect |
|---|---|---|
| `REALTIME_XMPP_ENABLED` | off | Must be literal `true`, else all WS upgrades are rejected |
| `REALTIME_XMPP_CAPTURE` | on when enabled | Sanitized per-frame structural logs (`[XMPP-CAP]`); never logs credentials or bodies. Set `false` to silence |
| `REALTIME_XMPP_WS_PATHS` | `//,/,/__ws/xmpp` | Comma list of accepted upgrade paths |
| `REALTIME_XMPP_ALLOWED_HOSTS` | empty (any) | Host header allowlist (port stripped, lowercased) |
| `REALTIME_XMPP_RECONNECT_GRACE_MS` | `45000` | Delay before broadcasting offline |
| `REALTIME_XMPP_DEV_CITY_MUC` | on unless `false` | Any authed user may join `City-*`. With `NODE_ENV=production`, `config/runtimeSafety.ts` refuses to start unless this is `false` |
| `REALTIME_XMPP_DEV_HUNT_MUC` | on unless `false` | Same for `Hunt-*` (not checked by the production guard) |
| `HTTPS_PORT` | `3443` | Port the WS endpoint shares with HTTPS |
| `VOICE_UDP_PORT` | `8791` | Voice relay UDP port |
| `AUTH_SIGNING_PRIVKEY_B64` / `AUTH_SIGNING_PUBKEY_B64` | required | Sign/verify voice tickets (same keys as game JWTs) |
| `GAMESERVER_API_KEYS` | required for proximity | Keys that may sign position reports |

Hard-coded limits (`realtime/types.ts` `DEFAULT_LIMITS`): 64 KiB message, 1000 total / 8 per-IP connections, 15 s handshake, 5 min idle. `maxXmlDepth` (32) and `maxAttrsPerElement` (64) only bound the capture summary; the live parser (`ltx.parse` in `XMPPSession`) has no depth limit beyond the 64 KiB frame cap. `maxTextLen` and `reconnectGraceMs` (5 s) are unused. `.env.example` documents the `REALTIME_XMPP_*` block.

## Gotchas

- **Every address players connect by must be in `REALTIME_XMPP_ALLOWED_HOSTS`** (LAN, public, Tailscale, ...). A client whose `Host` is missing gets `403 (Forbidden Host)`, is never in `sessionRegistry`, and counts as offline: ISLAND party launches drop it (`party contains N offline member(s)`). It still reaches the hunt, but with no player hunt id on the roster, so story-mission quest objectives never count for it.
- **Nothing works until `REALTIME_XMPP_ENABLED=true`** and the backend is restarted. A disabled gateway logs one `[XMPP] realtime disabled` line and rejects upgrades with 503. Backend code changes need a restart; all realtime state (sessions, rooms, throttles, voice peers, voice bans) is lost on restart and clients must reconnect.
- **Single process only.** `SessionRegistry`, rooms and rate windows are in memory; running two API instances would split presence. Cross-process fan-out was never built.
- **Several files are not on the live path.** `stateMachine.ts` is only used by its test (the real flow is inline in `XMPPSession`); `services.ts` holds unimplemented interface sketches; `RealtimeEventBus.ts` has no publishers or subscribers (friends/party use `PushFriendEvent` and the Mongo outbox instead). Comments still say "capture-first foundation"; the code is production auth + presence + chat.
- **Insecure dev flags.** City/Hunt rooms are open to any authenticated user when their flags are on. The room nick is client-chosen and echoed as the sender name, so display names in rooms are not trustworthy.
- **Group chat has no rate limit** (direct chat does).
- **Direct-chat rate windows are never pruned.** `connectionRates` is keyed by connection id and `accountRates` by account; entries stay in memory for the process lifetime.
- **A second `<bind>` on a socket unbinds the previous resource first** (`XMPPConnection.handleFrame`, 2026-10-28); it used to leave a ghost that kept `isOnline()` true.
- **A MUC join whose socket closed while `authorizeJoin` was awaiting is dropped** (`RoomService.closedConns`), so no ghost occupant stays in the room.
- **Whispers to a full JID whose resource is gone** go to the friend's live resources (RFC 6121 8.5.3.2.1); `service-unavailable` only when the friend has no resource at all. Friends keep a stale full JID after every reconnect.
- **Party invites belong to the issuing party.** `GetInvitesForPlayer` hides invites whose sender has since left that party, and `acceptInvite` revokes such an invite (it used to stay listed while every Accept did nothing).
- **Late OFFLINE vs reconnect:** `recordPartyPresence` re-checks `sessionRegistry.isOnline` before the party `leave`, so a player who reconnected during the offline write keeps their party.
- **Offline grace is deliberately long (45 s).** Do not shorten it; hunt/city travel reconnects would show friend online/offline toast spam. Party members are also removed from their party when grace expires.
- **Pings must carry the ping child** in the result, or the client reconnects every ~150 s.
- **Per-IP limits use the socket address.** Behind a proxy or tunnel every player looks like one IP and the 8-connection cap would hit everyone (unverified whether the live setup is proxied).
- **Voice depends on three things agreeing:** launcher env vars on the client, the backend UDP port being reachable (open it in the firewall), and a hub reporting positions with a key in `GAMESERVER_API_KEYS`. No fresh report means no proximity voice; party voice still works.
- **Voice bans are in memory**; a restart clears them until re-applied, while the 24 h ticket stays valid.
- Outbox push only reaches players connected at that moment; offline players catch up through normal REST polling. Published outbox rows expire after a day (`ttlAt` TTL).
- **Display-name lookup** (`GET /account/api/public/account/displayName/:name`, `routes/eos.ts`) answers with the account's last-launched character id (`ActiveCharacters`), matching friend lists; with the owner id, invites and friend pushes to a slot 2+ player never reached their session.

## See also

[index](index.md), [backend](backend.md), [backend persistence](backend-persistence.md), [security and admin](backend-security-admin.md), [runtime](runtime.md), [launcher](launcher.md), [director](director.md)
</content>
</invoke>
