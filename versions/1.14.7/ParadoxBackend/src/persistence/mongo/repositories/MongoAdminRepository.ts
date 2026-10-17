/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { ClientSession, Db } from "mongodb";
import { AdminAuditRecord, AdminRepository, AdminSessionRecord, PlayerDeletionResult } from "../../contracts/AdminRepository";
import { GetMongoClient, GetMongoDb } from "../client";
import { Collections } from "../collections";

function ToSession(Doc: any): AdminSessionRecord {
    return {
        id: String(Doc._id),
        tokenHash: Doc.tokenHash,
        userId: Doc.userId,
        csrfToken: Doc.csrfToken,
        createdAt: Doc.createdAt,
        expiresAt: Doc.expiresAt,
        ip: Doc.ip,
        userAgent: Doc.userAgent,
        revokedAt: Doc.revokedAt ?? undefined
    };
}

function ToAudit(Doc: any): AdminAuditRecord {
    return {
        id: String(Doc._id),
        actorUserId: Doc.actorUserId,
        targetUserId: Doc.targetUserId ?? undefined,
        action: Doc.action,
        oldState: Doc.oldState,
        newState: Doc.newState,
        reason: Doc.reason ?? undefined,
        ip: Doc.ip,
        requestId: Doc.requestId,
        createdAt: Doc.createdAt
    };
}

export class MongoAdminRepository implements AdminRepository {
    async createSession(session: AdminSessionRecord): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.AdminSessions).insertOne({
            ...session,
            _id: session.id as any,
            ttlAt: new Date(session.expiresAt)
        });
    }

    async findActiveSessionByTokenHash(tokenHash: string): Promise<AdminSessionRecord | undefined> {
        const Db = await GetMongoDb();
        const Doc = await Db.collection(Collections.AdminSessions).findOne({
            tokenHash,
            revokedAt: null,
            expiresAt: { $gt: new Date().toISOString() }
        });
        return Doc == null ? undefined : ToSession(Doc);
    }

    async revokeSession(id: string): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.AdminSessions).updateOne(
            { _id: id as any },
            { $set: { revokedAt: new Date().toISOString() } }
        );
    }

    async appendAudit(record: AdminAuditRecord, session?: ClientSession): Promise<void> {
        const Db = await GetMongoDb();
        await Db.collection(Collections.AdminAudit).insertOne({ ...record, _id: record.id as any }, { session });
    }

    async listAudit(targetUserId: string | undefined, skip: number, limit: number): Promise<{ records: AdminAuditRecord[]; total: number }> {
        const Db = await GetMongoDb();
        const Query = targetUserId ? { targetUserId } : {};
        const Collection = Db.collection(Collections.AdminAudit);
        const [Docs, Total] = await Promise.all([
            Collection.find(Query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
            Collection.countDocuments(Query)
        ]);
        return { records: Docs.map(ToAudit), total: Total };
    }

    async deletePlayerData(userId: string, audit: AdminAuditRecord): Promise<PlayerDeletionResult> {
        const Client = await GetMongoClient();
        const Session = Client.startSession();
        const DeletedCounts: Record<string, number> = {};
        let CharacterCount = 0;

        try {
            await Session.withTransaction(async () => {
                const Db = await GetMongoDb();
                // Every character slot is its own game userId (src/characterSlots.ts); game data goes for all of them.
                const SlotIds = (await Db.collection(Collections.CharacterSlots).find({ ownerUserId: userId }, { session: Session }).toArray())
                    .map((Row) => String(Row._id));
                const Ids = [userId, ...SlotIds.filter((Id) => Id !== userId)];
                const Remove = Remover(Db, Session, DeletedCounts);
                const UserOwned = { $or: [{ userId: { $in: Ids } }, { _id: { $in: Ids as any[] } }] };

                // Authentication and live-session state first. The transaction means
                // none of these removals become visible unless the full cascade commits.
                await Remove(Collections.RefreshSessions, { userId });
                await Remove(Collections.GameExchangeCodes, { userId: { $in: Ids } });
                await Remove(Collections.AdminSessions, { userId });
                await Remove(Collections.AuthIdentities, { userId });
                await Remove(Collections.DiscordOAuthTransactions, { userId });
                await Remove(Collections.UserApiKeys, UserOwned);
                await Remove(Collections.Friendships, { $or: [{ ownerId: userId }, { otherId: userId }] });

                CharacterCount = await RemoveGameData(Remove, Db, Session, Ids);
                await Remove(Collections.CharacterSlots, { ownerUserId: userId });
                if (SlotIds.length > 0) await Remove(Collections.Accounts, { _id: { $in: SlotIds.filter((Id) => Id !== userId) as any[] } });

                const AccountResult = await Db.collection(Collections.Accounts)
                    .deleteOne({ _id: userId as any, displayNameNormalized: { $exists: true } }, { session: Session });
                if (AccountResult.deletedCount !== 1) {
                    throw new Error("Player account disappeared before deletion completed.");
                }
                DeletedCounts[Collections.Accounts] = AccountResult.deletedCount + (DeletedCounts[Collections.Accounts] ?? 0);

                // Retain one minimal operational tombstone. It contains opaque IDs
                // and state only—never the deleted email, username, password hash,
                // identity details, inventory, or progression.
                await Db.collection(Collections.AdminAudit).insertOne(
                    { ...audit, _id: audit.id as any },
                    { session: Session }
                );
            });
        } finally {
            await Session.endSession();
        }

        return { deletedCounts: DeletedCounts, characterCount: CharacterCount };
    }

    // [Revamped 2026-10-17] One character slot (src/characterSlots.ts) of an owner: its whole game save.
    // Slot 1 is the account itself and goes only with deletePlayerData.
    async deleteCharacterSlot(ownerUserId: string, gameUserId: string, audit: AdminAuditRecord): Promise<PlayerDeletionResult> {
        const Client = await GetMongoClient();
        const Session = Client.startSession();
        const DeletedCounts: Record<string, number> = {};
        let CharacterCount = 0;

        try {
            await Session.withTransaction(async () => {
                const Db = await GetMongoDb();
                const Slot = await Db.collection(Collections.CharacterSlots).findOne({ _id: gameUserId as any, ownerUserId }, { session: Session });
                if (Slot == undefined || Slot.slot <= 1 || gameUserId === ownerUserId) {
                    throw new Error("Character slot not found.");
                }
                const Remove = Remover(Db, Session, DeletedCounts);

                CharacterCount = await RemoveGameData(Remove, Db, Session, [gameUserId]);
                // Per-character state deletePlayerData does not cover.
                for (const Name of [Collections.BountyStates, Collections.CooldownStates, Collections.Entitlements]) {
                    await Remove(Name, { _id: gameUserId as any });
                }
                await Remove(Collections.EscalationProgress, { userId: gameUserId });
                await Remove(Collections.ProgressionTransactions, { userId: gameUserId });
                await Remove(Collections.GuildMembers, { _id: gameUserId as any });
                await Remove(Collections.GuildInvites, { $or: [{ inviteeId: gameUserId }, { inviterId: gameUserId }] });
                await Remove(Collections.SlayerLinks, { $or: [{ senderId: gameUserId }, { targetId: gameUserId }] });
                await Remove(Collections.GameExchangeCodes, { userId: gameUserId });
                await Remove(Collections.Accounts, { _id: gameUserId as any, displayNameNormalized: { $exists: false } });
                await Remove(Collections.CharacterSlots, { _id: gameUserId as any });

                await Db.collection(Collections.AdminAudit).insertOne({ ...audit, _id: audit.id as any }, { session: Session });
            });
        } finally {
            await Session.endSession();
        }

        return { deletedCounts: DeletedCounts, characterCount: CharacterCount };
    }
}

type RemoveFn = (collection: string, filter: any) => Promise<void>;

function Remover(Db: Db, Session: ClientSession, DeletedCounts: Record<string, number>): RemoveFn {
    return async (collection, filter) => {
        const Result = await Db.collection(collection).deleteMany(filter, { session: Session });
        DeletedCounts[collection] = (DeletedCounts[collection] ?? 0) + Result.deletedCount;
    };
}

// The game save of these game userIds: characters, inventory, loadouts, progression and wallet.
// Returns how many character records it held.
async function RemoveGameData(Remove: RemoveFn, Db: Db, Session: ClientSession, Ids: string[]): Promise<number> {
    const Characters = await Db.collection(Collections.Characters)
        .find({ userId: { $in: Ids } }, { session: Session })
        .project({ _id: 1, characterId: 1 })
        .toArray();
    const CharacterIds = Characters.map((Character) => String(Character.characterId ?? Character._id));
    const UserOwned = { $or: [{ userId: { $in: Ids } }, { _id: { $in: Ids as any[] } }] };
    const CharacterOwned = {
        $or: [
            { userId: { $in: Ids } },
            { characterId: { $in: CharacterIds } },
            { _id: { $in: CharacterIds } }
        ]
    };

    await Remove(Collections.InventoryTransactions, CharacterOwned);
    await Remove(Collections.Inventories, CharacterOwned);
    await Remove(Collections.Loadouts, CharacterOwned);
    await Remove(Collections.Breadcrumbs, CharacterOwned);
    await Remove(Collections.EncounteredContent, CharacterOwned);
    await Remove(Collections.ProgressionTracks, { userId: { $in: Ids } });
    await Remove(Collections.ProgressionObjectives, { userId: { $in: Ids } });
    await Remove(Collections.ProgressionObjectiveEvents, { userId: { $in: Ids } });
    await Remove(Collections.PlayerJourney, UserOwned);
    await Remove(Collections.Wallets, UserOwned);
    await Remove(Collections.Characters, { userId: { $in: Ids } });
    return CharacterIds.length;
}
