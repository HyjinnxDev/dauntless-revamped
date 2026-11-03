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

import { GetRepositories } from "../persistence";
import { ApiKeyRepository } from "../persistence/contracts/ApiKeyRepository";
import { logger } from "../logger";
import { HashApiKey } from "../security/apiKeyHash";

export function HashGameserverAPIKey(GameserverAPIKeyToHash: string){
    return HashApiKey(GameserverAPIKeyToHash, "gameserver");
}

// GAMESERVER_API_KEYS: comma-separated raw keys the dedicated gameservers send (the Director's METAGAME_API_KEY).
export function ParseConfiguredGameserverAPIKeys(Value: string | undefined): string[] {
    return [...new Set(
        (Value ?? "")
            .split(",")
            .map((Key) => Key.trim())
            .filter((Key) => Key.length > 0)
    )];
}

// The configured list is the complete key set: every other stored hash is deleted (legacy SHA-256 records
// included), so removing a compromised key from the configuration revokes it at the next restart.
export async function SynchronizeConfiguredGameserverAPIKeys(
    Repository: Pick<ApiKeyRepository, "replaceGameServerKeyHashes" | "clearGameServerKeysToRegister">,
    Value: string
): Promise<number> {
    const ConfiguredHashes = ParseConfiguredGameserverAPIKeys(Value).map(HashGameserverAPIKey);
    await Repository.replaceGameServerKeyHashes(ConfiguredHashes);
    await Repository.clearGameServerKeysToRegister();
    return ConfiguredHashes.length;
}

export async function DrainAndRegisterAPIKeys(){
    // A non-empty GAMESERVER_API_KEYS is authoritative. Unset or empty keeps the keys already stored: a deployment
    // that registers keys another way, or shares its database with one, must not lose them to a blank template line.
    const ConfiguredValue = process.env.GAMESERVER_API_KEYS;
    if (ParseConfiguredGameserverAPIKeys(ConfiguredValue).length > 0) {
        const Count = await SynchronizeConfiguredGameserverAPIKeys(GetRepositories().apiKeys, ConfiguredValue ?? "");
        logger.info(`Synchronized ${Count} Gameserver API key hash(es) from GAMESERVER_API_KEYS`);
        await RefreshGameserverKeyHashes();
        return;
    }

    const APIKeysToRegister = await GetRepositories().apiKeys.findAllGameServerKeysToRegister();

    await GetRepositories().apiKeys.clearGameServerKeysToRegister();

    // Count the stored hashes rather than reading the key list's size into the log line.
    let Registered = 0;
    for(const APIKey of APIKeysToRegister){
        await GetRepositories().apiKeys.insertGameServerKeyHash(HashGameserverAPIKey(APIKey.key));
        Registered++;
    }

    logger.info(`Registered ${Registered} new Gameserver API Key(s) on boot!`);
    await RefreshGameserverKeyHashes();
}

// [Revamped 2026-11-03] Valid gameserver key hashes are cached in memory (FINDINGS M7): every forged
// x-mysticparadox-gameserver-apikey header used to cost a full collection read, and the rate limiter could not
// tell a real key from a junk one. The key set only changes at boot (GAMESERVER_API_KEYS); the 60 s refresh
// covers a database shared with another deployment that registers keys itself.
const kGameserverKeyCacheMs = 60_000;
let GameserverKeyHashes: Set<string> | null = null;
let GameserverKeyHashesAt = 0;

async function RefreshGameserverKeyHashes(): Promise<Set<string>> {
    const Records = await GetRepositories().apiKeys.findAllGameServerKeyHashes();
    GameserverKeyHashes = new Set(Records.map((Record) => Record.keyHash).filter((Hash): Hash is string => !!Hash));
    GameserverKeyHashesAt = Date.now();
    return GameserverKeyHashes;
}

// Only HMAC records match (security/apiKeyHash.ts); a pre-HMAC SHA-256 record must be registered again.
// The hash is a keyed HMAC, so a Set lookup leaks nothing a timing-safe compare would protect.
export async function IsValidGameserverAPIKey(GameserverAPIKey: string){
    const Hashes = GameserverKeyHashes !== null && Date.now() - GameserverKeyHashesAt < kGameserverKeyCacheMs
        ? GameserverKeyHashes
        : await RefreshGameserverKeyHashes();
    return Hashes.has(HashGameserverAPIKey(GameserverAPIKey));
}

// Synchronous check against the cache only, for the global rate limiter (security/rateLimit.ts), which runs before
// any route can await. False until the cache is first filled (boot fills it in DrainAndRegisterAPIKeys).
export function IsKnownGameserverAPIKey(GameserverAPIKey: unknown): boolean {
    return typeof GameserverAPIKey === "string"
        && GameserverKeyHashes !== null
        && GameserverKeyHashes.has(HashGameserverAPIKey(GameserverAPIKey));
}

// Test seam: fills the cache without a database.
export function SetGameserverKeyHashesForTest(Hashes: string[]): void {
    GameserverKeyHashes = new Set(Hashes);
    GameserverKeyHashesAt = Date.now();
}
