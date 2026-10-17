/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { MongoServerError } from "mongodb";
import { GetRepositories } from "../persistence";
import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";
import { LauncherApiError } from "../security/launcherErrors";
import { IsRateLimited } from "../security/rateLimit";
import { AssertAccountEligible } from "../security/accountEligibility";
import { sessionRegistry } from "../realtime/SessionRegistry";
import { AnnounceCharacterSwitch } from "../realtime/friendEvents";
import { logger } from "../logger";
import { GetTrackCurve } from "./progression";
import { ActiveCharacters, CharacterSlotRow, CleanLabel, InsertNextSlot, LabelOf, ListSlots, MaxCharacterSlots, RankForXp, SetLabel } from "../characterSlots";

// [Revamped 2026-10-17] The launcher's character list (src/characterSlots.ts): create, rename, delete.
// Each character is its own game save; slot 1 is the account's own and can't be deleted.

export interface CharacterView {
    slot: number;
    label: string;
    level: number;
    lastPlayedAt: string | null;
    online: boolean;
}

const PLAYER_LEVEL_TRACK = "MasteryTrack_PlayerLevel";

async function EligibleAccount(userId: string) {
    const Account = await GetRepositories().launcherAccounts.findByUserId(userId);
    if (Account == undefined) {
        throw new LauncherApiError("AUTH_UNAUTHORIZED", "Sign in required.");
    }
    AssertAccountEligible(Account);
    return Account;
}

async function SlotOf(userId: string, slot: unknown): Promise<CharacterSlotRow> {
    const Row = (await ListSlots(userId)).find((R) => R.slot === Number(slot));
    if (Row == undefined) {
        throw new LauncherApiError("NOT_FOUND", "That character doesn't exist.");
    }
    return Row;
}

async function PlayerLevel(gameUserId: string): Promise<number> {
    const Curve = GetTrackCurve(PLAYER_LEVEL_TRACK);
    const Xp = (await GetRepositories().progressionTracks.get(gameUserId, PLAYER_LEVEL_TRACK))?.progress ?? 0;
    return Curve ? Math.max(1, RankForXp(Curve.cumulativeXpForRank, Xp)) : 1;
}

export async function ListCharacters(userId: string): Promise<{ max: number; lastSlot: number; characters: CharacterView[] }> {
    const Rows = await ListSlots(userId);
    const Active = (await ActiveCharacters([userId])).get(userId);
    return {
        max: MaxCharacterSlots(),
        lastSlot: Rows.find((Row) => Row._id === Active)?.slot ?? 1,
        characters: await Promise.all(Rows.map(async (Row) => ({
            slot: Row.slot,
            label: LabelOf(Row),
            level: await PlayerLevel(Row._id),
            lastPlayedAt: Row.lastLaunchedAt ?? null,
            online: sessionRegistry.isOnline(Row._id)
        })))
    };
}

export async function CreateCharacter(userId: string, rawLabel: unknown): Promise<Awaited<ReturnType<typeof ListCharacters>>> {
    const Account = await EligibleAccount(userId);
    const Label = rawLabel === undefined || rawLabel === null || rawLabel === "" ? undefined : CleanLabel(rawLabel);
    if (rawLabel !== undefined && rawLabel !== null && rawLabel !== "" && Label === undefined) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Character names are 1-24 letters, numbers, spaces or simple punctuation.");
    }
    if (IsRateLimited(`character-create:${userId}`, 5, 60 * 60 * 1000)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many attempts. Try again later.");
    }

    let Row;
    try {
        Row = await InsertNextSlot(userId, Label);
    } catch (error) {
        // Two creates at once: the unique (ownerUserId, slot) index lets only one through.
        if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
    }
    if (Row == undefined) {
        throw new LauncherApiError("CHARACTER_LIMIT_REACHED", "You already have the most characters this server allows.");
    }

    // The game's /login needs an account row for the new game id. The in-game name still comes from
    // the owner (GetUsernameForUserId resolves through launcherAccounts).
    await GetRepositories().accounts.create({ userId: Row._id, name: Account.displayName, notes: 0 });
    logger.info(`Character slot ${Row.slot} created for ${userId} (game id ${Row._id})`);
    return ListCharacters(userId);
}

export async function RenameCharacter(userId: string, slot: unknown, rawLabel: unknown): Promise<Awaited<ReturnType<typeof ListCharacters>>> {
    await EligibleAccount(userId);
    const Label = CleanLabel(rawLabel);
    if (Label === undefined) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Character names are 1-24 letters, numbers, spaces or simple punctuation.");
    }
    if (IsRateLimited(`character-rename:${userId}`, 20, 60 * 60 * 1000)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many attempts. Try again later.");
    }
    await SetLabel(userId, await SlotOf(userId, slot), Label);
    return ListCharacters(userId);
}

// Permanent: the character's whole game save goes (MongoAdminRepository.deleteCharacterSlot).
export async function DeleteCharacter(userId: string, slot: unknown, confirmLabel: unknown, ip: string): Promise<Awaited<ReturnType<typeof ListCharacters>>> {
    await EligibleAccount(userId);
    if (IsRateLimited(`character-delete:${userId}`, 5, 60 * 60 * 1000)) {
        throw new LauncherApiError("AUTH_RATE_LIMITED", "Too many attempts. Try again later.");
    }
    const Row = await SlotOf(userId, slot);
    if (Row.slot === 1) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Your first character can't be deleted.");
    }
    const Same = (A: unknown, B: string) => typeof A === "string" && A.trim().toLowerCase() === B.trim().toLowerCase();
    if (!Same(confirmLabel, LabelOf(Row))) {
        throw new LauncherApiError("AUTH_VALIDATION_FAILED", "Type the character's name exactly to confirm.");
    }
    if (sessionRegistry.isOnline(Row._id)) {
        throw new LauncherApiError("CHARACTER_IN_USE", "That character is still in the game. Close it first.");
    }
    // Deleting a guild leader would leave the guild without one.
    const Member = await (await GetMongoDb()).collection(Collections.GuildMembers).findOne({ _id: Row._id as any });
    if (Member?.rank === "Leader") {
        throw new LauncherApiError("CHARACTER_GUILD_LEADER", "That character leads a guild. Hand it over or disband it in game first.");
    }

    const Before = (await ActiveCharacters([userId])).get(userId) ?? userId;
    const Now = new Date().toISOString();
    const Result = await GetRepositories().admin.deleteCharacterSlot(userId, Row._id, {
        id: crypto.randomUUID(),
        actorUserId: userId,
        targetUserId: userId,
        action: "player.character.delete",
        oldState: { slot: Row.slot, gameUserId: Row._id },
        newState: { deleted: true },
        ip,
        requestId: crypto.randomUUID(),
        createdAt: Now
    });
    logger.warn(`Character slot ${Row.slot} (game id ${Row._id}) of ${userId} deleted: ${JSON.stringify(Result.deletedCounts)}`);

    // Friends who saw the deleted character move to whichever one is now the latest.
    const After = (await ActiveCharacters([userId])).get(userId) ?? userId;
    if (Before === Row._id && After !== Row._id) await AnnounceCharacterSwitch(Row._id, After).catch((e) => logger.warn(`character switch announce failed for ${userId}: ${e}`));
    return ListCharacters(userId);
}
