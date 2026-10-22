import assert from "node:assert/strict";
import test from "node:test";
import { ParseHuntStats } from "./huntStats";

const player = { userId: "abc123", damage: 52000, partDamage: 900, woundDamage: 40, behemoths: ["lerawr_beta_bp_C_2147478098"] };

test("hunt stats body parses into one row per player", () => {
    const Rows = ParseHuntStats({ hunt: "8790-1792600000", playerHuntId: "CR19_PlayerHunt_Lerawr", players: [player] });
    assert.deepEqual(Rows, [{ hunt: "8790-1792600000", playerHuntId: "CR19_PlayerHunt_Lerawr", ...player }]);
    assert.equal(ParseHuntStats({ hunt: "8790-1", playerHuntId: "", players: [player] })?.length, 1);
});

test("hunt stats body rejects bad ids, amounts and shapes", () => {
    const body = (p: object, extra: object = {}) => ({ hunt: "8790-1", playerHuntId: "", players: [{ ...player, ...p }], ...extra });
    assert.equal(ParseHuntStats(body({ userId: "a\"b" })), undefined);
    assert.equal(ParseHuntStats(body({ damage: -1 })), undefined);
    assert.equal(ParseHuntStats(body({ damage: Number.NaN })), undefined);
    assert.equal(ParseHuntStats(body({ partDamage: "5" })), undefined);
    assert.equal(ParseHuntStats(body({ behemoths: ["<script>"] })), undefined);
    assert.equal(ParseHuntStats(body({}, { hunt: "" })), undefined);
    assert.equal(ParseHuntStats(body({}, { players: [] })), undefined);
    assert.equal(ParseHuntStats(undefined), undefined);
});
