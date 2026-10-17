/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import { GetMongoDb } from "./persistence/mongo/client";
import { Collections } from "./persistence/mongo/collections";
import type { FriendEdgeRecord, FriendshipRepository } from "./persistence/contracts/FriendshipRepository";

// [Revamped 2026-10-17] Several characters per launcher account.
//
// Every game system keys its state on the game's userId (inventory, progression, wallet, bounties,
// guild, daily rewards...), and the client puts that id in request paths, so a character IS a game
// userId. Slot 1 is the launcher account's own userId (existing players keep their progress); later
// slots get a fresh UUID. The owner (launcher account) keeps login, roles, bans and the display name:
// MongoLauncherAccountRepository.findByUserId resolves a character id to its owner.
// Only the friends list is shared: edges are stored between owners (CharacterAwareFriendships below).

export interface CharacterSlotRow {
    _id: string;            // the character's game userId
    ownerUserId: string;
    slot: number;           // 1-based
    createdAt: string;
    lastLaunchedAt?: string;
    label?: string;         // launcher-only name; the game always shows the account name
}

export const MAX_LABEL_LENGTH = 24;

/** A trimmed label, or undefined when it is empty, too long or has characters outside the allowed set. */
export function CleanLabel(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined;
    const Label = raw.normalize("NFC").replace(/\s+/g, " ").trim();
    return Label.length >= 1 && Label.length <= MAX_LABEL_LENGTH && /^[\p{L}\p{N} '\-_.!?&()]+$/u.test(Label) ? Label : undefined;
}

/** What the launcher shows and a delete must repeat. Older rows without a label get the English default. */
export function LabelOf(row: Pick<CharacterSlotRow, "slot" | "label">): string {
    return row.label ?? `Character ${row.slot}`;
}

/** The level a track shows for this much XP: the highest rank whose cumulative cost is covered. */
export function RankForXp(cumulativeXpForRank: Map<number, number>, xp: number): number {
    let Rank = 0;
    for (const [Id, Needed] of cumulativeXpForRank) if (xp >= Needed && Id > Rank) Rank = Id;
    return Rank;
}

export function MaxCharacterSlots(): number {
    const Value = Number(process.env.MAX_CHARACTER_SLOTS ?? 2);
    return Number.isInteger(Value) && Value >= 1 ? Value : 2;
}

/** Lowest free slot number, or undefined when the account is at the limit. Slot 1 always exists. */
export function NextSlot(usedSlots: number[], max: number): number | undefined {
    for (let Slot = 2; Slot <= max; Slot++) if (!usedSlots.includes(Slot)) return Slot;
    return undefined;
}

async function Slots() {
    return (await GetMongoDb()).collection<CharacterSlotRow>(Collections.CharacterSlots);
}

/** The launcher account a game userId belongs to (itself for slot 1 and non-character ids). */
export async function OwnerOf(gameUserId: string): Promise<string> {
    const Row = await (await Slots()).findOne({ _id: { $eq: gameUserId } });
    return Row?.ownerUserId ?? gameUserId;
}

/** Every slot of an owner, slot 1 included, ordered by slot. */
export async function ListSlots(ownerUserId: string): Promise<CharacterSlotRow[]> {
    const Rows = await (await Slots()).find({ ownerUserId }).toArray();
    if (!Rows.some((Row) => Row.slot === 1)) Rows.push({ _id: ownerUserId, ownerUserId, slot: 1, createdAt: "" });
    return Rows.sort((A, B) => A.slot - B.slot);
}

/** Inserts the next slot row; undefined when the account is at the limit. The unique
 *  (ownerUserId, slot) index turns a double-click race into a duplicate-key error. */
export async function InsertNextSlot(ownerUserId: string, label?: string): Promise<CharacterSlotRow | undefined> {
    const Used = (await ListSlots(ownerUserId)).map((Row) => Row.slot);
    const Slot = NextSlot(Used, MaxCharacterSlots());
    if (Slot === undefined) return undefined;
    const Row: CharacterSlotRow = { _id: crypto.randomUUID(), ownerUserId, slot: Slot, createdAt: new Date().toISOString(), label: label ?? `Character ${Slot}` };
    await (await Slots()).insertOne(Row);
    return Row;
}

/** Records a launch and returns the character friends saw before (the previously launched one). */
export async function MarkLaunched(ownerUserId: string, row: CharacterSlotRow): Promise<string> {
    const Previous = (await ActiveCharacters([ownerUserId])).get(ownerUserId) ?? ownerUserId;
    await (await Slots()).updateOne(
        { _id: row._id },
        { $set: { ownerUserId, slot: row.slot, lastLaunchedAt: new Date().toISOString() }, $setOnInsert: { createdAt: row.createdAt || new Date().toISOString() } },
        { upsert: true }
    );
    return Previous;
}

/** Slot 1 has no row until it is launched or named, hence the upsert. */
export async function SetLabel(ownerUserId: string, row: CharacterSlotRow, label: string): Promise<void> {
    await (await Slots()).updateOne(
        { _id: row._id },
        { $set: { ownerUserId, slot: row.slot, label }, $setOnInsert: { createdAt: row.createdAt || new Date().toISOString() } },
        { upsert: true }
    );
}

/** owner -> the character they launched last (what friends see). Owners never launched map to themselves. */
export async function ActiveCharacters(ownerUserIds: string[]): Promise<Map<string, string>> {
    const Result = new Map(ownerUserIds.map((Id) => [Id, Id]));
    if (ownerUserIds.length === 0) return Result;
    const Rows = await (await Slots())
        .find({ ownerUserId: { $in: ownerUserIds }, lastLaunchedAt: { $exists: true } })
        .sort({ lastLaunchedAt: 1 })
        .toArray();
    for (const Row of Rows) Result.set(Row.ownerUserId, Row._id); // ascending, so the latest wins
    return Result;
}

interface OwnerResolver {
    ownerOf(id: string): Promise<string>;
    activeOf(owners: string[]): Promise<Map<string, string>>;
}

const MongoOwners: OwnerResolver = { ownerOf: OwnerOf, activeOf: ActiveCharacters };

/**
 * Friendships are stored between owners; callers (friends routes, presence, whispers, Slayer Links)
 * keep speaking game ids. Inputs are mapped to owners, and each friend comes back as the character
 * that friend launched last. The caller's own id is echoed back unchanged.
 */
export class CharacterAwareFriendships implements FriendshipRepository {
    constructor(private readonly inner: FriendshipRepository, private readonly owners: OwnerResolver = MongoOwners) {}

    async listForOwner(ownerId: string): Promise<FriendEdgeRecord[]> {
        const Edges = await this.inner.listForOwner(await this.owners.ownerOf(ownerId));
        const Active = await this.owners.activeOf(Edges.map((Edge) => Edge.otherId));
        return Edges.map((Edge) => ({ ...Edge, ownerId, otherId: Active.get(Edge.otherId) ?? Edge.otherId }));
    }

    async find(ownerId: string, otherId: string): Promise<FriendEdgeRecord | undefined> {
        const Edge = await this.inner.find(await this.owners.ownerOf(ownerId), await this.owners.ownerOf(otherId));
        return Edge && { ...Edge, ownerId, otherId };
    }

    async upsert(edge: FriendEdgeRecord): Promise<void> {
        await this.inner.upsert({ ...edge, ownerId: await this.owners.ownerOf(edge.ownerId), otherId: await this.owners.ownerOf(edge.otherId) });
    }

    async remove(ownerId: string, otherId: string): Promise<void> {
        await this.inner.remove(await this.owners.ownerOf(ownerId), await this.owners.ownerOf(otherId));
    }
}
