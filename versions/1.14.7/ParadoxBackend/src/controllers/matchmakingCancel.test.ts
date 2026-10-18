/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CancelPlayerMatchmaking, GetPartyInstance, GetPlayerCandidate, GrantLateJoin, WasCancelledSince } from "./matchmaking";

// [Revamped 2026-10-18] Start a hunt, cancel, invite a friend: the friend must not be late-joined into the
// cancelled hunt, and the party instance must not pull the canceller back in.
test("cancel forgets the hunt and the party instance it shares", async () => {
    const Hunt = { Ready: true, HuntId: "ShatteredIsles_IslandJ", CandidateId: "c", GameSessionId: "s1", Host: "h", Port: 8781, ReadyAt: 0 };
    const Offer = { MemberId: "leader", Result: Hunt, State: null };
    GrantLateJoin("leader", "party", Offer);    // seeds leader + party instance with a future Go Now release
    GrantLateJoin("member", "party", Offer);

    const Before = Date.now();
    assert.equal(CancelPlayerMatchmaking("leader", "party")?.HuntId, "ShatteredIsles_IslandJ");
    assert.equal(await GetPartyInstance("party"), undefined);
    assert.equal((await GetPlayerCandidate("member"))?.HuntId, undefined);
    assert.ok(WasCancelledSince("leader", Before));
    assert.ok(!WasCancelledSince("member", Before));
    assert.equal(CancelPlayerMatchmaking("nobody"), undefined);
});
