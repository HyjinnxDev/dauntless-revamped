/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CharacterAwareFriendships, CleanLabel, LabelOf, NextSlot, RankForXp } from "./characterSlots";
import type { FriendEdgeRecord, FriendshipRepository } from "./persistence/contracts/FriendshipRepository";

test("NextSlot fills the lowest gap and stops at the limit", () => {
    assert.equal(NextSlot([1], 2), 2);
    assert.equal(NextSlot([1, 2], 2), undefined);
    assert.equal(NextSlot([1, 3], 3), 2);
    assert.equal(NextSlot([1], 1), undefined);
});

function Edges(): FriendshipRepository & { rows: Map<string, FriendEdgeRecord> } {
    const rows = new Map<string, FriendEdgeRecord>();
    return {
        rows,
        async listForOwner(ownerId) { return [...rows.values()].filter((E) => E.ownerId === ownerId); },
        async find(ownerId, otherId) { return rows.get(`${ownerId}:${otherId}`); },
        async upsert(edge) { rows.set(`${edge.ownerId}:${edge.otherId}`, edge); },
        async remove(ownerId, otherId) { rows.delete(`${ownerId}:${otherId}`); }
    };
}

test("friendships are stored between owners and shown as each friend's last character", async () => {
    // alice has a second character alice-2; bob last played bob-2.
    const OwnerByCharacter: Record<string, string> = { "alice-2": "alice", "bob-2": "bob" };
    const Active: Record<string, string> = { bob: "bob-2" };
    const Inner = Edges();
    const Friends = new CharacterAwareFriendships(Inner, {
        ownerOf: async (Id) => OwnerByCharacter[Id] ?? Id,
        activeOf: async (Owners) => new Map(Owners.map((O) => [O, Active[O] ?? O]))
    });

    // alice-2 befriends bob (as bob-2): the stored edge is owner to owner.
    await Friends.upsert({ ownerId: "alice-2", otherId: "bob-2", status: "ACCEPTED", created: "t" });
    assert.deepEqual([...Inner.rows.keys()], ["alice:bob"]);

    // Both of alice's characters see bob as the character he plays.
    for (const Me of ["alice", "alice-2"]) {
        const [Edge] = await Friends.listForOwner(Me);
        assert.equal(Edge.ownerId, Me);
        assert.equal(Edge.otherId, "bob-2");
    }

    // Lookups by any character id hit the same edge and echo the ids asked for.
    const Found = await Friends.find("alice", "bob-2");
    assert.equal(Found?.status, "ACCEPTED");
    assert.equal(Found?.otherId, "bob-2");

    await Friends.remove("alice-2", "bob");
    assert.equal(Inner.rows.size, 0);
});

test("labels: trimmed, 1-24 allowed characters; old rows fall back to Character N", () => {
    assert.equal(CleanLabel("  Hammer   build "), "Hammer build");
    assert.equal(CleanLabel("Väinö's 2nd (pike)"), "Väinö's 2nd (pike)");
    assert.equal(CleanLabel(""), undefined);
    assert.equal(CleanLabel("x".repeat(25)), undefined);
    assert.equal(CleanLabel("<script>"), undefined);
    assert.equal(CleanLabel(42), undefined);
    assert.equal(LabelOf({ slot: 2 }), "Character 2");
    assert.equal(LabelOf({ slot: 2, label: "Pike" }), "Pike");
});

test("RankForXp: the highest rank whose cumulative cost is covered", () => {
    const Curve = new Map([[0, 0], [1, 0], [2, 1], [3, 3], [4, 6]]);
    assert.equal(RankForXp(Curve, 0), 1);
    assert.equal(RankForXp(Curve, 2), 2);
    assert.equal(RankForXp(Curve, 3), 3);
    assert.equal(RankForXp(Curve, 99), 4);
});
