/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GameserverChildEnvironment } from "./gameservers";

test("game servers get the API key in their environment and no other Director secret (FINDINGS M15)", () => {
    const Env = GameserverChildEnvironment(
        { PATH: "C:\Windows", SystemRoot: "C:\Windows", METAGAME_API_KEY: "k", MONGODB_URI: "mongodb://u:p@h", ADMIN_TOKEN: "t", MYSTICPARADOX_API_BASE: "https://x" },
        "the-key", { MYSTICPARADOX_GAMESERVER_LAUNCH_ID: "id1" });
    assert.equal(Env.MYSTICPARADOX_GAMESERVER_API_KEY, "the-key");
    assert.equal(Env.MYSTICPARADOX_GAMESERVER_LAUNCH_ID, "id1");
    assert.equal(Env.PATH, "C:\Windows");
    assert.equal(Env.MYSTICPARADOX_API_BASE, "https://x");
    for (const Secret of ["METAGAME_API_KEY", "MONGODB_URI", "ADMIN_TOKEN"]) assert.equal(Env[Secret], undefined, Secret);
});
