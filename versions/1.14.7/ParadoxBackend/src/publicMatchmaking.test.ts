import assert from "node:assert/strict";
import test from "node:test";

// Module constants are read at import time.
process.env.MATCHMAKING_MODE = "DEPLOYSERVER";
process.env.DEPLOYSERVER_URL = "director.test";
process.env.HUNT_GO_NOW_MIN_DELAY_MS = "0";
process.env.HUNT_GO_NOW_MAX_DELAY_MS = "0";

type Call = { path: string, body: any };
const Calls: Call[] = [];
let Joinable: { host: string, port: number } | undefined;
globalThis.fetch = (async (Url: string, Init: any) => {
    const Body = JSON.parse(Init?.body ?? "{}");
    const Path = new URL(Url).pathname;
    Calls.push({ path: Path, body: Body });
    if (Path.endsWith("/join-public-hunt")) return Joinable ? new Response(JSON.stringify(Joinable), { status: 200 }) : new Response(null, { status: 204 });
    return new Response(JSON.stringify({ host: "h", port: 8780 + Calls.length }), { status: 200 });
}) as typeof fetch;

test("public hunts join a running one or launch at once; private hunts launch private", async () => {
    const { HandlePlayerMatchmaking, CheckAndUpdateQueueStatus, CancelPlayerMatchmaking, GetPartyInstance } = await import("./controllers/matchmaking");
    const Launches = () => Calls.filter((C) => C.path.endsWith("/handle-matchmaking-for-player"));

    // Private: launched immediately, marked private.
    assert.equal(await HandlePlayerMatchmaking("SHARED", "", "Hunt_A", "p0", undefined, undefined, undefined, true), true);
    assert.equal(Launches().length, 1);
    assert.equal(Launches()[0].body.IsPrivate, true);

    // Public solo, nothing joinable: launches a public server now, no waiting.
    await HandlePlayerMatchmaking("SHARED", "", "Hunt_A", "p1", undefined, undefined, undefined, false);
    assert.equal(Launches().length, 2);
    assert.equal(Launches()[1].body.IsPrivate, false);
    assert.ok((await CheckAndUpdateQueueStatus("p1"))!.Port > 0);

    // Public with a joinable running hunt: joins it, no launch.
    Joinable = { host: "h", port: 9999 };
    await HandlePlayerMatchmaking("SHARED", "", "Hunt_A", "p2", undefined, undefined, undefined, false);
    assert.equal(Launches().length, 2);
    assert.equal((await CheckAndUpdateQueueStatus("p2"))!.Port, 9999);
    Joinable = undefined;

    // Public duo: one launch for the whole party, the follower reuses it.
    await HandlePlayerMatchmaking("ISLAND", "", "Hunt_B", "a1", "partyA", ["a1", "a2"], undefined, false);
    await HandlePlayerMatchmaking("ISLAND", "", "Hunt_B", "a2", "partyA", ["a1", "a2"], undefined, false);
    assert.equal(Launches().length, 3);
    assert.deepEqual(Launches()[2].body.ExpectedPlayers, ["a1", "a2"]);
    const A1 = await CheckAndUpdateQueueStatus("a1"), A2 = await CheckAndUpdateQueueStatus("a2");
    assert.equal(A1!.Port, A2!.Port);

    // A member who did not lead cancels before travel: the party instance is called off, so nobody goes alone.
    await HandlePlayerMatchmaking("ISLAND", "", "Hunt_C", "b1", "partyB", ["b1", "b2"], undefined, false);
    CancelPlayerMatchmaking("b2", "partyB");
    assert.equal(await GetPartyInstance("partyB"), undefined);
    assert.equal(await CheckAndUpdateQueueStatus("b1"), undefined);
});
