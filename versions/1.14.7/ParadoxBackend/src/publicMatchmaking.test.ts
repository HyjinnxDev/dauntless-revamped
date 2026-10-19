import assert from "node:assert/strict";
import test from "node:test";

// Module constants are read at import time.
process.env.MATCHMAKING_MODE = "DEPLOYSERVER";
process.env.DEPLOYSERVER_URL = "director.test";
process.env.PUBLIC_MATCH_WAIT_MS = "50";
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

test("public hunts queue, merge and launch public; private hunts launch at once", async () => {
    const { HandlePlayerMatchmaking, CheckAndUpdateQueueStatus } = await import("./controllers/matchmaking");
    const Launches = () => Calls.filter((C) => C.path.endsWith("/handle-matchmaking-for-player"));

    // Private: launched immediately, marked private.
    assert.equal(await HandlePlayerMatchmaking("SHARED", "", "Hunt_A", "p0", undefined, undefined, undefined, true), true);
    assert.equal(Launches().length, 1);
    assert.equal(Launches()[0].body.IsPrivate, true);

    // Public, nothing joinable: two solos queue together, nothing launches before the wait.
    await HandlePlayerMatchmaking("SHARED", "", "Hunt_A", "p1", undefined, undefined, undefined, false);
    await HandlePlayerMatchmaking("SHARED", "", "Hunt_A", "p2", undefined, undefined, undefined, false);
    assert.equal(Launches().length, 1);
    assert.equal((await CheckAndUpdateQueueStatus("p1"))!.Ready, false);

    await new Promise((r) => setTimeout(r, 60));
    await CheckAndUpdateQueueStatus("p1");
    assert.equal(Launches().length, 2);
    assert.deepEqual(Launches()[1].body.ExpectedPlayers, ["p1", "p2"]);
    assert.equal(Launches()[1].body.IsPrivate, false);
    const P1 = await CheckAndUpdateQueueStatus("p1"), P2 = await CheckAndUpdateQueueStatus("p2");
    assert.equal(P1!.Port, P2!.Port);

    // Public with a joinable running hunt: joins it, no launch.
    Joinable = { host: "h", port: 9999 };
    await HandlePlayerMatchmaking("SHARED", "", "Hunt_A", "p3", undefined, undefined, undefined, false);
    assert.equal(Launches().length, 2);
    assert.equal((await CheckAndUpdateQueueStatus("p3"))!.Port, 9999);
    Joinable = undefined;

    // A party of 2 plus a queued party of 3 don't fit: the waiting queue launches, the new one waits.
    await HandlePlayerMatchmaking("ISLAND", "", "Hunt_B", "a1", "partyA", ["a1", "a2", "a3"], undefined, false);
    await HandlePlayerMatchmaking("ISLAND", "", "Hunt_B", "a2", "partyA", ["a1", "a2", "a3"], undefined, false);   // follower: no new queue
    await HandlePlayerMatchmaking("ISLAND", "", "Hunt_B", "b1", "partyB", ["b1", "b2"], undefined, false);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(Launches().length, 3);
    assert.deepEqual(Launches()[2].body.ExpectedPlayers, ["a1", "a2", "a3"]);
    assert.equal((await CheckAndUpdateQueueStatus("b1"))!.Ready, false);
});
