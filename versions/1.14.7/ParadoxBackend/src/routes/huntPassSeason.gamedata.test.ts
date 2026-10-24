import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { ActiveSeasonWindow, HuntPassEntitlement } from "../huntPassRotation";

// controllers/auth.ts reads the signing keys at import, so they are set before system.ts/store.ts load.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.AUTH_SIGNING_PRIVKEY_B64 ??= Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_SIGNING_PUBKEY_B64 ??= Buffer.from(publicKey.export({ type: "spki", format: "pem" })).toString("base64");
const { WidenHuntPassWindows } = require("./system") as typeof import("./system");
const { GetStoreSkus } = require("../controllers/store") as typeof import("../controllers/store");

// [Revamped 2026-10-24] One pass per two-week season. The client's Challenges weeks follow season43's window, so
// season43 must be current for every player, carrying the pass they are on (Cuddly saw "~27000 days" on the
// Challenges board once they finished the first pass and their season43 got the 2099 placeholder window).
const Current = (Path: any) => Date.parse(Path.start_date) <= Date.now() && Date.now() < Date.parse(Path.end_date);
const Paths = (ServedSlot?: string) => WidenHuntPassWindows({ payload: { paths: [] } }, ServedSlot).payload.paths as any[];

test("a player's season43 carries the pass they are on, in the current season window; no other slot is current", () => {
    for (const Served of ["season43", "season50"]) {
        const All = Paths(Served);
        const Season43 = All.find((Path) => Path.progression_id === "season43");
        const Window = ActiveSeasonWindow(Date.now());
        assert.deepEqual({ start: Season43.start_date, end: Season43.end_date }, Window, Served);
        assert.equal(Season43.premium_gating_entitlement, HuntPassEntitlement(Served), Served);
        assert.deepEqual(All.filter(Current).map((Path) => Path.progression_id), ["season43"], Served);
    }
});

test("the game server's config has the season pass and the Commission pass current", () => {
    assert.deepEqual(Paths().filter(Current).map((Path) => Path.progression_id), ["season43", "season50"]);
});

test("the season43 Elite SKU unlocks the pass the player is on", () => {
    const [Commission] = GetStoreSkus("season43_pass", "season50");
    assert.equal(Commission.id, "season43_premium");
    assert.deepEqual(Commission.entitlements?.map((E) => E.name), [HuntPassEntitlement("season50")]);
    assert.deepEqual(GetStoreSkus("season43_pass")[0].entitlements?.map((E) => E.name), [HuntPassEntitlement("season43")]);
    assert.deepEqual(GetStoreSkus("season44_pass"), []);
});
