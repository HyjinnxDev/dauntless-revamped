import assert from "node:assert/strict";
import test from "node:test";
import { MoveLegacyHuntPassProgress } from "./indexes";

// An in-memory progressionTracks with just the three calls the migration makes.
function FakeDb(Docs: any[]) {
    const Rows = new Map(Docs.map((Doc) => [Doc._id, Doc]));
    const Collection = {
        find: (Filter: any) => ({ toArray: async () => [...Rows.values()].filter((Doc) => Doc.progressionId === Filter.progressionId) }),
        updateOne: async (Filter: any, Update: any, Options: any) => {
            if (!Rows.has(Filter._id) && Options?.upsert) Rows.set(Filter._id, { _id: Filter._id, ...Update.$setOnInsert });
        },
        deleteOne: async (Filter: any) => { Rows.delete(Filter._id); },
    };
    return { Rows, Db: { collection: () => Collection } as any };
}

const Moves: [string, string][] = [["season43:frostfall", "huntpass:0:frostfall"], ["season44:saint_s_bond", "huntpass:1:saint_s_bond"]];

test("old rotation rows move to their season once, keeping ranks, never overwriting a moved row", async () => {
    const Frost = { _id: "u1::season43:frostfall", userId: "u1", progressionId: "season43:frostfall", progress: 4200, confirmedFremiumRank: 40, confirmedPremiumRank: 12 };
    const Saint = { _id: "u2::season44:saint_s_bond", userId: "u2", progressionId: "season44:saint_s_bond", progress: 700 };
    const Other = { _id: "u2::MasteryTrack_PlayerLevel", userId: "u2", progressionId: "MasteryTrack_PlayerLevel", progress: 5 };
    const Moved = { _id: "u3::huntpass:0:frostfall", userId: "u3", progressionId: "huntpass:0:frostfall", progress: 900 };
    const Stale = { _id: "u3::season43:frostfall", userId: "u3", progressionId: "season43:frostfall", progress: 100 };
    const { Rows, Db } = FakeDb([Frost, Saint, Other, Moved, Stale]);

    await MoveLegacyHuntPassProgress(Db, Moves);
    await MoveLegacyHuntPassProgress(Db, Moves); // a second startup changes nothing

    assert.deepEqual(Rows.get("u1::huntpass:0:frostfall"), { ...Frost, _id: "u1::huntpass:0:frostfall", progressionId: "huntpass:0:frostfall" });
    assert.equal(Rows.has("u1::season43:frostfall"), false);
    assert.equal(Rows.get("u2::huntpass:1:saint_s_bond").progress, 700);     // Saint's Bond waits for season 1
    assert.equal(Rows.has("u2::season44:saint_s_bond"), false);
    assert.equal(Rows.get("u3::huntpass:0:frostfall").progress, 900);        // a crash between copy and delete never loses the newer row
    assert.equal(Rows.has("u3::season43:frostfall"), false);
    assert.deepEqual(Rows.get("u2::MasteryTrack_PlayerLevel"), Other);      // other tracks are left alone
});
