/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// [Revamped 2026-11-03] Per-staff authenticator secrets (FINDINGS M5). One row per staff account in adminMfa:
//   { _id: userId, secret?, pendingSecret?, lastStep?, lastOpsStep?, enrolledAt? }
// lastStep / lastOpsStep record the newest 30 s time step accepted for sign-in / operations step-up, so a code
// can't be replayed inside its window. The shared ADMIN_TOTP_SECRET only signs in accounts that haven't enrolled
// yet (bootstrap); once every staff member has enrolled it can be removed from .env.
// ponytail: secrets are stored as plain base32 like the .env secret they replace; encrypt at rest if the database
// ever leaves this machine.

import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";
import { GenerateTotpSecret, MatchTotpStep } from "./totp";

type StepField = "lastStep" | "lastOpsStep";
type MfaDoc = { _id: string, secret?: string, pendingSecret?: string, lastStep?: number, lastOpsStep?: number, enrolledAt?: string };

async function Col() {
    return (await GetMongoDb()).collection<MfaDoc>(Collections.AdminMfa);
}

export async function IsAdminMfaEnrolled(userId: string): Promise<boolean> {
    return typeof (await (await Col()).findOne({ _id: userId }))?.secret === "string";
}

// Marks `step` used for `field`; false when it (or a newer one) was already used. Upserts so the shared bootstrap
// secret gets replay protection per account too.
async function ClaimStep(userId: string, field: StepField, step: number): Promise<boolean> {
    try {
        const Result = await (await Col()).updateOne(
            { _id: userId, $or: [{ [field]: { $exists: false } }, { [field]: { $lt: step } }] },
            { $set: { [field]: step } },
            { upsert: true });
        return Result.modifiedCount + Result.upsertedCount === 1;
    } catch (error) {
        // The upsert hits the existing _id when the filter didn't match: the step was already used.
        if ((error as { code?: number }).code === 11000) return false;
        throw error;
    }
}

/** Checks a code against the account's own secret (or `fallbackSecret` when it has none) and burns its step. */
export async function ConsumeAdminTotp(userId: string, code: unknown, field: StepField, fallbackSecret?: string): Promise<boolean> {
    const Doc = await (await Col()).findOne({ _id: userId });
    const Secret = Doc?.secret ?? fallbackSecret;
    if (!Secret) return false;
    const Step = MatchTotpStep(Secret, code);
    return Step !== undefined && ClaimStep(userId, field, Step);
}

/** Starts (or restarts) enrolment: a new pending secret, shown to the staff member once. */
export async function StartAdminMfaEnrolment(userId: string, label: string): Promise<{ secret: string, otpauthUri: string }> {
    const Secret = GenerateTotpSecret();
    await (await Col()).updateOne({ _id: userId }, { $set: { pendingSecret: Secret } }, { upsert: true });
    const Name = encodeURIComponent(`Dauntless Revamped:${label}`);
    return { secret: Secret, otpauthUri: `otpauth://totp/${Name}?secret=${Secret}&issuer=${encodeURIComponent("Dauntless Revamped")}` };
}

/** Confirms the pending secret with a code from the new authenticator; it then replaces any old secret. */
export async function ConfirmAdminMfaEnrolment(userId: string, code: unknown): Promise<boolean> {
    const Doc = await (await Col()).findOne({ _id: userId });
    if (!Doc?.pendingSecret) return false;
    const Step = MatchTotpStep(Doc.pendingSecret, code);
    if (Step === undefined) return false;
    const Result = await (await Col()).updateOne({ _id: userId, pendingSecret: Doc.pendingSecret }, {
        $set: { secret: Doc.pendingSecret, lastStep: Step, lastOpsStep: Step, enrolledAt: new Date().toISOString() },
        $unset: { pendingSecret: "" }
    });
    return Result.modifiedCount === 1;
}

/** Owner action: forget a staff member's authenticator (lost phone, staff removed). */
export async function ResetAdminMfa(userId: string): Promise<boolean> {
    return (await (await Col()).deleteOne({ _id: userId })).deletedCount === 1;
}
