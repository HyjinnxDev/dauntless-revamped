/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

// Same throwaway replica-set mongod as characterDelete.test.ts (CHARACTER_TEST_MONGODB_URI); skipped without it.
const Uri = process.env.CHARACTER_TEST_MONGODB_URI;
// RFC 6238 vector: this secret shows 287082 during time step 1 (30-59.999 s).
const Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("admin TOTP: a code works once, per account and per purpose (FINDINGS M5)", { skip: Uri ? false : "CHARACTER_TEST_MONGODB_URI not set" }, async () => {
    assert.ok(!/:27018\b/.test(Uri!), "refusing the live mongod port");
    process.env.MONGODB_URI = Uri;
    process.env.MONGODB_DB = `mfatest_${Date.now()}`;
    const { GetMongoDb, GetMongoClient } = await import("../persistence/mongo/client");
    const { ConsumeAdminTotp, IsAdminMfaEnrolled, StartAdminMfaEnrolment, ConfirmAdminMfaEnrolment, ResetAdminMfa } = await import("./adminMfa");
    const RealNow = Date.now;
    try {
        Date.now = () => 59_000;
        // Bootstrap through the shared secret: replay refused, another account unaffected, step-up tracked apart.
        assert.equal(await ConsumeAdminTotp("staff-a", "287082", "lastStep", Secret), true);
        assert.equal(await ConsumeAdminTotp("staff-a", "287082", "lastStep", Secret), false, "replay refused");
        assert.equal(await ConsumeAdminTotp("staff-b", "287082", "lastStep", Secret), true);
        assert.equal(await ConsumeAdminTotp("staff-a", "287082", "lastOpsStep", Secret), true);
        assert.equal(await ConsumeAdminTotp("staff-a", "111111", "lastStep", Secret), false);
        assert.equal(await ConsumeAdminTotp("staff-c", "287082", "lastStep"), false, "no secret at all");

        // Enrolment: a pending secret only counts once confirmed, then the shared one no longer works.
        const Started = await StartAdminMfaEnrolment("staff-a", "Alice");
        assert.match(Started.otpauthUri, /^otpauth:\/\/totp\//);
        assert.equal(await IsAdminMfaEnrolled("staff-a"), false);
        assert.equal(await ConfirmAdminMfaEnrolment("staff-a", "000000"), false);
        await (await GetMongoDb()).collection("adminMfa").updateOne({ _id: "staff-a" as any }, { $set: { pendingSecret: Secret } });
        Date.now = () => 89_000; // step 2 window still accepts step 1's code
        assert.equal(await ConfirmAdminMfaEnrolment("staff-a", "287082"), true);
        assert.equal(await IsAdminMfaEnrolled("staff-a"), true);
        assert.equal(await ConsumeAdminTotp("staff-a", "287082", "lastStep", "AAAAAAAAAAAAAAAA"), false, "the confirming code is spent");
        assert.equal(await ResetAdminMfa("staff-a"), true);
        assert.equal(await IsAdminMfaEnrolled("staff-a"), false);
    } finally {
        Date.now = RealNow;
        await (await GetMongoDb()).dropDatabase();
        await (await GetMongoClient()).close();
    }
});
