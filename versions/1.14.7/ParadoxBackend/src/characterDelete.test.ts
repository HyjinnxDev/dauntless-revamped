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

test("deleting character 2 removes only its game save", { skip: Uri ? false : "CHARACTER_TEST_MONGODB_URI not set" }, async () => {
    assert.ok(!/:27018\b/.test(Uri!), "refusing the live mongod port");
    process.env.MONGODB_URI = Uri;
    process.env.MONGODB_DB = `chartest_${Date.now()}`;
    const { GetMongoDb, GetMongoClient } = await import("./persistence/mongo/client");
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
    await (await GetMongoClient()).close();
});
