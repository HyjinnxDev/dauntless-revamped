/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

// Needs a throwaway replica-set mongod (transactions), e.g.
//   mongod --port 27099 --replSet rs0 --dbpath <temp dir>   then rs.initiate()
//   CHARACTER_TEST_MONGODB_URI=mongodb://127.0.0.1:27099/?replicaSet=rs0
// Skipped without it. Never point it at the live database: it drops its own test database.
const Uri = process.env.CHARACTER_TEST_MONGODB_URI;

// One shared client for both tests (the client module is a singleton).
test.after(async () => {
    if (Uri) await (await (await import("./persistence/mongo/client")).GetMongoClient()).close();
});

test("deleting character 2 removes only its game save", { skip: Uri ? false : "CHARACTER_TEST_MONGODB_URI not set" }, async () => {
    assert.ok(!/:27018\b/.test(Uri!), "refusing the live mongod port");
    process.env.MONGODB_URI = Uri;
    process.env.MONGODB_DB = `chartest_${Date.now()}`;
    const { GetMongoDb } = await import("./persistence/mongo/client");
    const { Collections } = await import("./persistence/mongo/collections");
    const { MongoAdminRepository } = await import("./persistence/mongo/repositories/MongoAdminRepository");
    const Db = await GetMongoDb();

    const Owner = "owner-0001", Second = "second-0002";
    await Db.collection(Collections.Accounts).insertMany([
        { _id: Owner as any, userId: Owner, name: "Slayer42", displayName: "Slayer42", displayNameNormalized: "slayer42" },
        { _id: Second as any, userId: Second, name: "Slayer42", notes: 0 }
    ]);
    await Db.collection(Collections.CharacterSlots).insertOne({ _id: Second as any, ownerUserId: Owner, slot: 2, createdAt: "t" });
    // The same kinds of rows for both characters.
    for (const Id of [Owner, Second]) {
        await Db.collection(Collections.Characters).insertOne({ _id: `char-${Id}` as any, characterId: `char-${Id}`, userId: Id });
        await Db.collection(Collections.Inventories).insertOne({ _id: `char-${Id}` as any, characterId: `char-${Id}`, userId: Id });
        await Db.collection(Collections.Wallets).insertOne({ _id: Id as any, balances: { CURRENCY_PLATINUM: 100 } });
        await Db.collection(Collections.ProgressionTracks).insertOne({ _id: `${Id}::MasteryTrack_PlayerLevel` as any, userId: Id, progress: 10 });
        await Db.collection(Collections.BountyStates).insertOne({ _id: Id as any });
        await Db.collection(Collections.GuildMembers).insertOne({ _id: Id as any, guildId: "g1", rank: "Member" });
    }
    await Db.collection(Collections.Friendships).insertOne({ _id: `${Owner}:friend` as any, ownerId: Owner, otherId: "friend", status: "ACCEPTED" });

    const Repo = new MongoAdminRepository();
    const Audit = (id: string) => ({ id, actorUserId: Owner, targetUserId: Owner, action: "player.character.delete", ip: "x", requestId: id, createdAt: "t" });
    await assert.rejects(Repo.deleteCharacterSlot(Owner, Owner, Audit("a1")), "slot 1 is not deletable this way");
    await assert.rejects(Repo.deleteCharacterSlot("someone-else", Second, Audit("a2")), "only the owner's slot");

    await Repo.deleteCharacterSlot(Owner, Second, Audit("a3"));

    const Count = (Name: string, Filter: any) => Db.collection(Name).countDocuments(Filter);
    for (const [Name, Filter] of [
        [Collections.Characters, { userId: Second }],
        [Collections.Inventories, { userId: Second }],
        [Collections.Wallets, { _id: Second }],
        [Collections.ProgressionTracks, { userId: Second }],
        [Collections.BountyStates, { _id: Second }],
        [Collections.GuildMembers, { _id: Second }],
        [Collections.Accounts, { _id: Second }],
        [Collections.CharacterSlots, { _id: Second }]
    ] as const) assert.equal(await Count(Name, Filter), 0, `${Name} of character 2 is gone`);
    for (const [Name, Filter] of [
        [Collections.Characters, { userId: Owner }],
        [Collections.Inventories, { userId: Owner }],
        [Collections.Wallets, { _id: Owner }],
        [Collections.ProgressionTracks, { userId: Owner }],
        [Collections.BountyStates, { _id: Owner }],
        [Collections.GuildMembers, { _id: Owner }],
        [Collections.Accounts, { _id: Owner }],
        [Collections.Friendships, { ownerId: Owner }]
    ] as const) assert.equal(await Count(Name, Filter), 1, `${Name} of character 1 is kept`);
    assert.equal(await Count(Collections.AdminAudit, { _id: "a3" }), 1, "the deletion is audited");

    await Db.dropDatabase();
});

// [Revamped 2026-11-03] FINDINGS M8: deleting a whole player clears every slot's rows and hands a led guild on.
test("deleting a player removes every slot's rows and hands their guild on", { skip: Uri ? false : "CHARACTER_TEST_MONGODB_URI not set" }, async () => {
    assert.ok(!/:27018/.test(Uri!), "refusing the live mongod port");
    process.env.MONGODB_URI = Uri;
    process.env.MONGODB_DB = `chartest_${Date.now()}_p`;
    const { GetMongoDb } = await import("./persistence/mongo/client");
    const { Collections } = await import("./persistence/mongo/collections");
    const { MongoAdminRepository } = await import("./persistence/mongo/repositories/MongoAdminRepository");
    const Db = await GetMongoDb();

    const Owner = "owner-0001", Second = "second-0002", Other = "other-0003";
    await Db.collection(Collections.Accounts).insertMany([
        { _id: Owner as any, userId: Owner, displayName: "Slayer42", displayNameNormalized: "slayer42" },
        { _id: Second as any, userId: Second },
        { _id: Other as any, userId: Other, displayName: "Other", displayNameNormalized: "other" }
    ]);
    await Db.collection(Collections.CharacterSlots).insertOne({ _id: Second as any, ownerUserId: Owner, slot: 2, createdAt: "t" });
    await Db.collection(Collections.Guilds).insertOne({ _id: "g1" as any, name: "G", leaderId: Owner });
    await Db.collection(Collections.GuildMembers).insertMany([
        { _id: Owner as any, guildId: "g1", rank: "Leader", joinedAt: new Date(1) },
        { _id: Other as any, guildId: "g1", rank: "Member", joinedAt: new Date(2) }
    ]);
    await Db.collection(Collections.Guilds).insertOne({ _id: "g2" as any, name: "Solo", leaderId: Second });
    await Db.collection(Collections.GuildMembers).insertOne({ _id: Second as any, guildId: "g2", rank: "Leader", joinedAt: new Date(3) });
    await Db.collection(Collections.HuntStats).insertOne({ _id: `h1:${Second}` as any, userId: Second });
    await Db.collection(Collections.GauntletClears).insertOne({ _id: `1:${Owner}` as any, accountId: Owner });
    await Db.collection(Collections.SlayerLinks).insertOne({ senderId: Other, targetId: Second });
    await Db.collection(Collections.Parties).insertOne({ _id: "p1" as any, revision: 1, members: [Owner, Other], leaderPlayerId: Owner });
    await Db.collection(Collections.PartyMemberships).insertMany([
        { _id: Owner as any, partyId: "p1" }, { _id: Other as any, partyId: "p1" }
    ]);

    await new MongoAdminRepository().deletePlayerData(Owner, { id: "d1", actorUserId: "staff", targetUserId: Owner, action: "player.delete", ip: "x", requestId: "d1", createdAt: "t" });

    const Count = (Name: string, Filter: any) => Db.collection(Name).countDocuments(Filter);
    for (const [Name, Filter] of [
        [Collections.Accounts, { _id: { $in: [Owner, Second] } }],
        [Collections.GuildMembers, { _id: { $in: [Owner, Second] } }],
        [Collections.Guilds, { _id: "g2" }],
        [Collections.HuntStats, {}],
        [Collections.GauntletClears, {}],
        [Collections.SlayerLinks, {}],
        [Collections.PartyMemberships, { _id: Owner }]
    ] as const) assert.equal(await Count(Name, Filter), 0, `${Name} rows of the deleted player are gone`);
    assert.equal((await Db.collection(Collections.Guilds).findOne({ _id: "g1" as any }))?.leaderId, Other, "guild handed to the remaining member");
    assert.equal((await Db.collection(Collections.GuildMembers).findOne({ _id: Other as any }))?.rank, "Leader");
    const Party = await Db.collection(Collections.Parties).findOne({ _id: "p1" as any });
    assert.deepEqual(Party?.members, [Other], "the other member keeps the party");
    assert.equal(Party?.leaderPlayerId, Other);

    await Db.dropDatabase();
});
