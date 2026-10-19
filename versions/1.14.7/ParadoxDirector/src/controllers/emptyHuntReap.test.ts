import assert from "node:assert/strict";
import test from "node:test";
import { Gameserver, IsSupersededHunt, JoinablePublicHunt } from "./gameservers";

const Hunt = (over: Partial<Gameserver> = {}): Gameserver => ({
    id: "h", port: 8781, map: "m", behemoth: undefined, matchmakerHuntId: undefined,
    expectedPlayers: [{ playerUid: "a", playerHuntId: "x" }, { playerUid: "b", playerHuntId: "x" }],
    isRamsgate: false, isTrainingDojo: false, processId: 1, startTime: new Date(), state: "ready",
    launchId: "h", logPath: "", huntState: { hpPct: 100, players: 0, subState: 2, at: 0 }, ...over,
});

test("empty hunt is superseded only when all its players re-request and nobody ever arrived", () => {
    assert.equal(IsSupersededHunt(Hunt(), new Set(["a", "b"])), true);
    assert.equal(IsSupersededHunt(Hunt({ huntState: undefined }), new Set(["a", "b", "c"])), true);
    assert.equal(IsSupersededHunt(Hunt(), new Set(["a"])), false);                    // b may still be coming
    assert.equal(IsSupersededHunt(Hunt({ hadPlayers: true }), new Set(["a", "b"])), false);
    assert.equal(IsSupersededHunt(Hunt({ huntState: { hpPct: 100, players: 1, subState: 2, at: 0 } }), new Set(["a", "b"])), false);
    assert.equal(IsSupersededHunt(Hunt({ state: "starting" }), new Set(["a", "b"])), false);
    assert.equal(IsSupersededHunt(Hunt({ isRamsgate: true }), new Set(["a", "b"])), false);
});

test("public matchmaking joins only public, live, roomy hunts of the same hunt id", () => {
    const Now = 1_000_000;
    const State = (players: number, hpPct = 80, subState = 2) => ({ hpPct, players, subState, at: Now - 1000 });
    const Pub = (over: Partial<Gameserver> = {}) => Hunt({ isPrivate: false, sentAt: [], huntState: State(1), ...over });
    const Pick = (Servers: Gameserver[], Count = 1) => JoinablePublicHunt(Servers, "x", Count, Now)?.port;

    assert.equal(Pick([Pub()]), 8781);
    assert.equal(Pick([Hunt({ huntState: State(1) })]), undefined);                    // isPrivate unset
    assert.equal(Pick([Pub({ isPrivate: true })]), undefined);
    assert.equal(Pick([Pub({ huntState: State(3) })], 2), undefined);                    // 3 + 2 > 4
    assert.equal(Pick([Pub({ huntState: State(2), sentAt: [Now - 5000] })], 2), undefined); // recent send counts
    assert.equal(Pick([Pub({ huntState: State(2), sentAt: [Now - 100_000] })], 2), 8781);   // old send expired
    assert.equal(Pick([Pub({ huntState: State(1, 10) })]), undefined);                   // nearly dead
    assert.equal(Pick([Pub({ huntState: State(1, 80, 4) })]), undefined);                // end of hunt
    assert.equal(Pick([Pub({ huntState: { ...State(1), at: Now - 60_000 } })]), undefined); // stale
    assert.equal(Pick([Pub({ expectedPlayers: [{ playerUid: "a", playerHuntId: "other" }] })]), undefined);
    assert.equal(Pick([Pub({ port: 8780 }), Pub({ port: 8782, huntState: State(2) })]), 8782); // fullest first
});
