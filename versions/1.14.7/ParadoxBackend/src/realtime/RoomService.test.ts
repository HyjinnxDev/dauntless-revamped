/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { BuildNick, parseRoomJid, RoomService, type RoomLookups } from "./RoomService";
import type { RegisteredConnection } from "./SessionRegistry";

class FakeConnection implements RegisteredConnection {
    readonly sent: string[] = [];
    constructor(
        readonly connId: string,
        readonly accountId: string,
        readonly resource: string,
    ) {}
    send(frame: string): void { this.sent.push(frame); }
    close(): void { /* no-op */ }
}

// Real names by account; "hunter" was routed to the hunt session below.
const HUNT_SESSION = "97071270-01e8-4c24-8872-0eea5c0f37eb";
const Lookups: RoomLookups = {
    displayName: async (accountId) => ({ alice: "Alice", bob: "Bob", hunter: "Hunter" } as Record<string, string>)[accountId] ?? accountId,
    inGameSession: (accountId, session) => accountId === "hunter" && session === HUNT_SESSION,
    partyMembers: async (accountId) => accountId === "bob" ? ["bob", "hunter"] : [],
};

const CITY = "City-c069ba56-fe67-40b7-8e19-cb4a4813dc22";
const CITY_BARE = `${CITY}@muc.prod.ol.epicgames.com`;

test("room parser: accepts only the owned MUC domain and a nonempty nick", () => {
    assert.deepEqual(parseRoomJid(`${CITY_BARE}/MysticFox:alice:r1`), {
        roomBare: CITY_BARE,
        roomLocal: CITY,
        nick: "MysticFox:alice:r1",
    });
    assert.equal(parseRoomJid(`${CITY}@evil.example/MysticFox:alice:r1`), undefined);
    assert.deepEqual(parseRoomJid(CITY_BARE), { roomBare: CITY_BARE, roomLocal: CITY, nick: "" });
});

test("dev City MUC: join returns status 110 and groupchat fans out to occupants", async () => {
    const service = new RoomService(true, false, Lookups);
    const alice = new FakeConnection("ca", "alice", "ra");
    const bob = new FakeConnection("cb", "bob", "rb");

    const aliceJoin = await service.joinRoom(alice, `${CITY_BARE}/Alice:alice:ra`);
    assert.equal(aliceJoin.length, 1);
    assert.match(aliceJoin[0], /status code="110"/);

    const bobJoin = await service.joinRoom(bob, `${CITY_BARE}/Bob:bob:rb`);
    assert.equal(bobJoin.length, 2); // Alice's occupant presence, then Bob self-presence.
    assert.match(bobJoin[1], /status code="110"/);
    assert.equal(alice.sent.length, 1); // newcomer presence

    service.groupMessage(alice, CITY_BARE, "g1", "hello <city>");
    assert.equal(alice.sent.length, 2);
    assert.equal(bob.sent.length, 1);
    assert.match(bob.sent[0], /type="groupchat"/);
    assert.match(bob.sent[0], /hello &lt;city&gt;/);
});

test("City MUC can be disabled outside development", async () => {
    const service = new RoomService(false, false, Lookups);
    const alice = new FakeConnection("ca", "alice", "ra");
    const reply = await service.joinRoom(alice, `${CITY_BARE}/Alice:alice:ra`);
    assert.equal(reply.length, 1);
    assert.match(reply[0], /type="error"/);
    assert.match(reply[0], /<not-allowed /);
});

// [Revamped 2026-11-03] FINDINGS M3 / M4.
test("nick: the display name comes from the account and the userId must be the joiner's", async () => {
    assert.equal(BuildNick("Mallory:alice:r1", "alice", "Alice", "r1"), "Alice:alice:r1");
    assert.equal(BuildNick("Alice:bob:r1", "alice", "Alice", "r1"), undefined);
    assert.equal(BuildNick("whatever", "alice", "Al:ice", "r9"), "Alice:alice:r9");

    const service = new RoomService(true, false, Lookups);
    const alice = new FakeConnection("cn1", "alice", "ra");
    const join = await service.joinRoom(alice, `${CITY_BARE}/Bob:alice:ra`);
    assert.match(join[0], /\/Alice:alice:ra"/, "the claimed name is replaced");
    const forged = await service.joinRoom(new FakeConnection("cn2", "bob", "rb"), `${CITY_BARE}/Alice:alice:rb`);
    assert.match(forged[0], /type="error"/, "a nick naming another account is refused");
});

test("groupchat is rate limited per connection", async () => {
    const service = new RoomService(true, false, Lookups);
    const alice = new FakeConnection("flood-a", "alice", "ra");
    const bob = new FakeConnection("flood-b", "bob", "rb");
    await service.joinRoom(alice, `${CITY_BARE}/Alice:alice:ra`);
    await service.joinRoom(bob, `${CITY_BARE}/Bob:bob:rb`);
    const before = bob.sent.length;
    for (let i = 0; i < 30; i++) service.groupMessage(alice, CITY_BARE, `f${i}`, "spam");
    assert.equal(bob.sent.length - before, 12, "only the per-connection budget is delivered");
});

test("Hunt rooms admit only players matchmaking sent to that session", async () => {
    const service = new RoomService(true, false, Lookups);
    const HUNT_BARE = `Hunt-${HUNT_SESSION}@muc.prod.ol.epicgames.com`;
    const ok = await service.joinRoom(new FakeConnection("h1", "hunter", "rh"), `${HUNT_BARE}/Hunter:hunter:rh`);
    assert.match(ok[ok.length - 1], /status code="110"/);
    const outsider = await service.joinRoom(new FakeConnection("h2", "alice", "ra"), `${HUNT_BARE}/Alice:alice:ra`);
    assert.match(outsider[0], /type="error"/);
    const partyMate = await service.joinRoom(new FakeConnection("h4", "bob", "rb"), `${HUNT_BARE}/Bob:bob:rb`);
    assert.match(partyMate[partyMate.length - 1], /status code="110"/, "a party member of an occupant gets in");
    const open = await new RoomService(true, true, Lookups).joinRoom(new FakeConnection("h3", "alice", "ra"), `${HUNT_BARE}/Alice:alice:ra`);
    assert.match(open[open.length - 1], /status code="110"/, "the dev flag still opens them");
});
