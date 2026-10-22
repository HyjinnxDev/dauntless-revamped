// Per-player hunt damage from the hunt servers (runtime dllmain.cpp MpHuntStatsTick posts on each behemoth kill to
// routes/huntStats.ts), read by the Slayer's Ledger (D:\Dev\dauntless-companion). One row per hunt + player,
// _id "<hunt>:<userId>"; a later post for the same hunt overwrites the totals (an escalation posts once per kill).

export interface HuntStatsRow {
    hunt: string;          // "<server port>-<unix seconds>", unique per hunt server process
    playerHuntId: string;  // the hunt the party launched, "" when the server had no roster
    userId: string;        // game userId (a character slot's id)
    damage: number;
    partDamage: number;
    woundDamage: number;
    behemoths: string[];   // behemoth object names, e.g. "lerawr_beta_bp_C_2147478098"
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9;

export function ParseHuntStats(body: any): HuntStatsRow[] | undefined {
    if (!ID.test(body?.hunt ?? "") || typeof body.playerHuntId !== "string"
        || (body.playerHuntId !== "" && !ID.test(body.playerHuntId))) return undefined;
    if (!Array.isArray(body.players) || body.players.length === 0 || body.players.length > 8) return undefined;
    const Rows: HuntStatsRow[] = [];
    for (const P of body.players) {
        if (!ID.test(P?.userId ?? "") || !amount(P.damage) || !amount(P.partDamage) || !amount(P.woundDamage)) return undefined;
        if (!Array.isArray(P.behemoths) || P.behemoths.length > 16
            || !P.behemoths.every((B: unknown) => typeof B === "string" && ID.test(B))) return undefined;
        Rows.push({ hunt: body.hunt, playerHuntId: body.playerHuntId, userId: P.userId, damage: P.damage,
            partDamage: P.partDamage, woundDamage: P.woundDamage, behemoths: P.behemoths });
    }
    return Rows;
}
