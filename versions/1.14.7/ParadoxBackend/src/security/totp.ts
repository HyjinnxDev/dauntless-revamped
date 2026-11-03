/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "crypto";

function DecodeBase32(input: string): Buffer {
    const Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const Clean = input.toUpperCase().replace(/[\s=-]/g, "");
    let Bits = "";
    for (const Character of Clean) {
        const Index = Alphabet.indexOf(Character);
        if (Index < 0) throw new Error("Invalid base32 secret");
        Bits += Index.toString(2).padStart(5, "0");
    }
    const Bytes: number[] = [];
    for (let Offset = 0; Offset + 8 <= Bits.length; Offset += 8) {
        Bytes.push(Number.parseInt(Bits.slice(Offset, Offset + 8), 2));
    }
    return Buffer.from(Bytes);
}

function CodeAt(secret: Buffer, counter: number): string {
    const BufferCounter = Buffer.alloc(8);
    BufferCounter.writeBigUInt64BE(BigInt(counter));
    const Digest = crypto.createHmac("sha1", secret).update(BufferCounter).digest();
    const Offset = Digest[Digest.length - 1] & 0x0f;
    const NumberCode = (Digest.readUInt32BE(Offset) & 0x7fffffff) % 1_000_000;
    return NumberCode.toString().padStart(6, "0");
}

/** The 30 s time step the code matches (current one, or one either side), or undefined. */
export function MatchTotpStep(base32Secret: string, candidate: unknown, nowMs = Date.now()): number | undefined {
    if (typeof candidate !== "string" || !/^\d{6}$/.test(candidate)) return undefined;
    let Secret: Buffer;
    try {
        Secret = DecodeBase32(base32Secret);
    } catch {
        return undefined;
    }
    const Counter = Math.floor(nowMs / 30_000);
    const Actual = Buffer.from(candidate);
    let Matched: number | undefined;
    for (const Window of [-1, 0, 1]) {
        const Expected = Buffer.from(CodeAt(Secret, Counter + Window));
        if (Expected.length === Actual.length && crypto.timingSafeEqual(Expected, Actual)) Matched ??= Counter + Window;
    }
    return Matched;
}

export function VerifyTotp(base32Secret: string, candidate: unknown, nowMs = Date.now()): boolean {
    return MatchTotpStep(base32Secret, candidate, nowMs) !== undefined;
}

/** A new random 160-bit secret, base32 (RFC 4648, no padding) as authenticator apps expect. */
export function GenerateTotpSecret(): string {
    const Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const Bits = [...crypto.randomBytes(20)].map((Byte) => Byte.toString(2).padStart(8, "0")).join("");
    let Out = "";
    for (let Offset = 0; Offset < Bits.length; Offset += 5) Out += Alphabet[Number.parseInt(Bits.slice(Offset, Offset + 5).padEnd(5, "0"), 2)];
    return Out;
}
