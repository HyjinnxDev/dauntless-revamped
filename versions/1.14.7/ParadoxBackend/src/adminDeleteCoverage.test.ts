/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Collections } from "./persistence/mongo/collections";

// [Revamped 2026-11-03] FINDINGS M8: player deletion left rows behind because new collections were never added to
// MongoAdminRepository. Every collection must either be removed there or be listed here with the reason it stays.
const Kept: Partial<Record<keyof typeof Collections, string>> = {
    SchemaMigrations: "no player data",
    GameServerApiKeys: "no player data",
    AdminAudit: "deliberate tombstone (opaque ids only)",
    OperationsPolicy: "no player data",
    Parties: "removed through MongoPartyRepository.leave",
    PartyMemberships: "removed through MongoPartyRepository.leave",
    PartyOutbox: "events expire after a day (ttlAt)",
    GauntletGuildClears: "guild-level, no player id",
};

test("player deletion covers every collection that holds player data", () => {
    const Source = fs.readFileSync(path.join(__dirname, "persistence/mongo/repositories/MongoAdminRepository.ts"), "utf8");
    const Missing = (Object.keys(Collections) as (keyof typeof Collections)[])
        .filter((Key) => Kept[Key] === undefined && !Source.includes(`Collections.${Key}`));
    assert.deepEqual(Missing, [], "add these to RemoveCharacterState / deletePlayerData, or to Kept with a reason");
});
