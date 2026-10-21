import assert from "node:assert/strict";
import test from "node:test";
import { GauntletSeason, GuildsUnlocking, NormalizeGauntletLevel, PartyLevelAccess } from "./gauntlet";

test("season follows the hunt pass window and cycles Season 01-05", () => {
    assert.deepEqual(GauntletSeason(Date.parse("2026-10-21T00:00:00Z")), { index: 0, id: "ESC_SEASON_1", start_at: "2026-10-01T00:00:00+00:00", end_at: "2026-11-30T00:00:00+00:00" });
    assert.equal(GauntletSeason(Date.parse("2026-12-01T00:00:00Z")).id, "ESC_SEASON_2");
    assert.equal(GauntletSeason(Date.parse("2027-08-01T00:00:00Z")).id, "ESC_SEASON_1"); // window 5 (from 2027-07-28)
});

test("levels arrive plain or season-combined", () => {
    assert.equal(NormalizeGauntletLevel(10000001), 1);
    assert.equal(NormalizeGauntletLevel(20000017), 17);
    assert.equal(NormalizeGauntletLevel(5), 5);
    assert.equal(NormalizeGauntletLevel(0), undefined);
    assert.equal(NormalizeGauntletLevel("x"), undefined);
    assert.equal(NormalizeGauntletLevel(20000000), undefined);
});

test("party access is the weakest member; 3+ guildmates unlock for the guild", () => {
    assert.equal(PartyLevelAccess([7, 3, 12]), 4);
    assert.equal(PartyLevelAccess([0, 0]), 1);
    const Guilds = new Map([["a", "G"], ["b", "G"], ["c", "G"], ["d", "H"]]);
    assert.deepEqual(GuildsUnlocking(Guilds, ["a", "b", "c", "d"]), ["G"]);
    assert.deepEqual(GuildsUnlocking(Guilds, ["a", "b", "d", "a"]), []);
});
