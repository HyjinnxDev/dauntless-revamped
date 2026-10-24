import assert from "node:assert/strict";
import test from "node:test";
import { BountyGrantWindows } from "./tuning";

const YearMs = 365 * 24 * 60 * 60 * 1000;

test("bounty grant windows always cover now and end at least a year out", () => {
    for (const Iso of ["2026-10-24T00:00:00Z", "2027-12-31T23:59:59Z", "2028-01-01T00:00:00Z", "2040-06-15T12:00:00Z"]) {
        const Now = new Date(Iso);
        for (const Window of BountyGrantWindows(Now)) {
            assert.ok(Date.parse(Window.on_claim_grant_item_start_date) <= Now.getTime(), `start covers ${Iso}`);
            assert.ok(Date.parse(Window.on_claim_grant_item_end_date) - Now.getTime() >= YearMs, `end a year past ${Iso}`);
        }
    }
});
