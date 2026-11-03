/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import {
    GameServerApiKeyRecord,
    GameServerApiKeyToRegisterRecord,
    UserApiKeyRecord,
    UserApiKeyToRegisterRecord
} from "../mapping/domainTypes";

// Repository contract for the four API-key tables: gameserverapikeys,
// gameserverapikeystoregister, userapikeys, userapikeystoregister.
//
// Covers every current call site in controllers/apikeys.ts (DrainAndRegisterAPIKeys,
// IsValidGameserverAPIKey) and controllers/auth.ts (DrainAndRegisterUserAPIKeys,
// GetUserIDForAPIKey).
//
// [Revamped 2026-11-03] User keys are looked up by their HMAC hash (indexed) and gameserver hashes are cached
// in memory by controllers/apikeys.ts, instead of a full scan per request (FINDINGS M7). The same credentials
// are accepted: both sides of the comparison are the same keyed HMAC.
export interface ApiKeyRepository {
    findAllGameServerKeyHashes(): Promise<GameServerApiKeyRecord[]>;
    insertGameServerKeyHash(keyHash: string): Promise<void>;
    // Makes `keyHashes` the complete gameserver key set (GAMESERVER_API_KEYS): upserts them, deletes the rest.
    replaceGameServerKeyHashes(keyHashes: string[]): Promise<void>;
    findAllGameServerKeysToRegister(): Promise<GameServerApiKeyToRegisterRecord[]>;
    clearGameServerKeysToRegister(): Promise<void>;

    findUserKeyByHash(keyHash: string): Promise<UserApiKeyRecord | null>;
    insertUserKeyHash(userId: string, keyHash: string): Promise<void>;
    findAllUserKeysToRegister(): Promise<UserApiKeyToRegisterRecord[]>;
    clearUserKeysToRegister(): Promise<void>;
}
