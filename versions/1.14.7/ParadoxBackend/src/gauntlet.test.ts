import assert from "node:assert/strict";
import test from "node:test";
import { GauntletSeason, GuildsUnlocking, IsCrestMilestone, NormalizeGauntletLevel, PartyLevelAccess } from "./gauntlet";

test("season follows the hunt pass window and cycles Season 01-05", () => {
    // [Revamped 2026-10-24] two-week seasons from Thursday 2026-10-22 17:00 UTC
    assert.deepEqual(GauntletSeason(Date.parse("2026-10-24T00:00:00Z")), { index: 0, id: "ESC_SEASON_1", start_at: "2026-10-22T17:00:00+00:00", end_at: "2026-11-05T17:00:00+00:00" });
    assert.equal(GauntletSeason(Date.parse("2026-11-06T00:00:00Z")).id, "ESC_SEASON_2");
    assert.equal(GauntletSeason(Date.parse("2027-01-01T00:00:00Z")).id, "ESC_SEASON_1"); // window 5 (from 2026-12-31)
});

test("levels arrive plain or season-combined", () => {
    assert.equal(NormalizeGauntletLevel(10000001), 1);
    assert.equal(NormalizeGauntletLevel(20000017), 17);
    assert.equal(NormalizeGauntletLevel(5), 5);
    assert.equal(NormalizeGauntletLevel(0), undefined);
    assert.equal(NormalizeGauntletLevel("x"), undefined);
    assert.equal(NormalizeGauntletLevel(20000000), undefined);
});

test("party access is the weakest member; 2+ guildmates unlock for the guild", () => {
    assert.equal(PartyLevelAccess([7, 3, 12]), 4);
    assert.equal(PartyLevelAccess([0, 0]), 1);
    const Guilds = new Map([["a", "G"], ["b", "G"], ["c", "G"], ["d", "H"]]);
    assert.deepEqual(GuildsUnlocking(Guilds, ["a", "b", "d"]), ["G"]);
    assert.deepEqual(GuildsUnlocking(Guilds, ["a", "d", "a"]), []);
});

test("Crests pay on level 1 and every 5th level", () => {
    assert.deepEqual([1, 2, 4, 5, 6, 10, 15, 16].filter(IsCrestMilestone), [1, 5, 10, 15]);
});
