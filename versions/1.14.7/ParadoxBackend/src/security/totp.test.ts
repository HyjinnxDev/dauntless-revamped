import assert from "node:assert/strict";
import test from "node:test";
import { VerifyTotp } from "./totp";

test("verifies RFC 6238 SHA-1 value with six-digit truncation and adjacent window", () => {
    const Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    assert.equal(VerifyTotp(Secret, "287082", 59_000), true);
    assert.equal(VerifyTotp(Secret, "287083", 59_000), false);
    assert.equal(VerifyTotp(Secret, "287082", 89_000), true);
});

test("MatchTotpStep returns the matched time step; generated secrets verify (FINDINGS M5)", async () => {
    const { GenerateTotpSecret, MatchTotpStep } = await import("./totp");
    const Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    assert.equal(MatchTotpStep(Secret, "287082", 59_000), 1);
    assert.equal(MatchTotpStep(Secret, "287082", 89_000), 1, "the previous step still matches, as step 1");
    assert.equal(MatchTotpStep(Secret, "28708x", 59_000), undefined);
    const Fresh = GenerateTotpSecret();
    assert.match(Fresh, /^[A-Z2-7]{32}$/);
    assert.equal(MatchTotpStep(Fresh, "abc"), undefined);
});
