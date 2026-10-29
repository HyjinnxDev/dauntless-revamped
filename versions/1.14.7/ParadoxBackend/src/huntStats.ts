// Per-player hunt damage from the hunt servers (runtime dllmain.cpp MpHuntStatsTick posts on each behemoth kill to
// routes/huntStats.ts), read by the Slayer's Ledger (D:\Dev\dauntless-companion). One row per hunt + player,
// _id "<hunt>:<userId>"; a later post for the same hunt overwrites the totals (an escalation posts once per kill).
// Optional extras (newer DLLs): hunt `seconds` (target seen -> kill), per player `weapon` (EWeaponType), `grade` and
// `stats` (the game's own combat telemetry, UArchonTelemetryComponent_Combat, plus our down counter).

export interface HuntStatsRow {
    hunt: string;          // "<server port>-<unix seconds>", unique per hunt server process
    playerHuntId: string;  // the hunt the party launched, "" when the server had no roster
    userId: string;        // game userId (a character slot's id)
    damage: number;
    partDamage: number;
    woundDamage: number;
    behemoths: string[];   // behemoth object names, e.g. "lerawr_beta_bp_C_2147478098"
    seconds?: number;
    weapon?: number;
    grade?: string;
    stats?: Record<string, number>;
}

// Keys a hunt server may send in `stats`; anything else is rejected.
export const HUNT_STAT_KEYS = [
    "timeSeconds", "outOfCombatSeconds", "firstHitSeconds", "distance", "weaponPower", "armourResistance",
    "blunt", "cutting", "pierce", "exposed", "staggerDamage", "physical",
    "flame", "frost", "shock", "terra", "radiant", "umbral", "rawElemental", "elemental", "total",
    "interrupts", "partsBroken", "partsExposed", "staggers",
    "damageTaken", "downs", "hitsTaken", "timesStaggered",
    "dodges", "perfectDodges", "healing", "lanternHolds", "lanternTaps", "abilities", "staminaOut",
] as const;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9;

function ParseStats(stats: unknown): Record<string, number> | null | undefined {
    if (stats === undefined) return undefined;
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) return null;
    const Out: Record<string, number> = {};
    for (const [K, V] of Object.entries(stats)) {
        if (!(HUNT_STAT_KEYS as readonly string[]).includes(K) || !amount(V)) return null;
        Out[K] = V;
    }
    return Out;
}

export function ParseHuntStats(body: any): HuntStatsRow[] | undefined {
    if (!ID.test(body?.hunt ?? "") || typeof body.playerHuntId !== "string"
        || (body.playerHuntId !== "" && !ID.test(body.playerHuntId))) return undefined;
    if (body.seconds !== undefined && !amount(body.seconds)) return undefined;
    if (!Array.isArray(body.players) || body.players.length === 0 || body.players.length > 8) return undefined;
    const Rows: HuntStatsRow[] = [];
    for (const P of body.players) {
        if (!ID.test(P?.userId ?? "") || !amount(P.damage) || !amount(P.partDamage) || !amount(P.woundDamage)) return undefined;
        if (!Array.isArray(P.behemoths) || P.behemoths.length > 16
            || !P.behemoths.every((B: unknown) => typeof B === "string" && ID.test(B))) return undefined;
        if (P.weapon !== undefined && !(Number.isInteger(P.weapon) && P.weapon >= 0 && P.weapon <= 10)) return undefined;
        if (P.grade !== undefined && !(typeof P.grade === "string" && /^[A-Za-z0-9+-]{0,8}$/.test(P.grade))) return undefined;
        const Stats = ParseStats(P.stats);
        if (Stats === null) return undefined;
        Rows.push({ hunt: body.hunt, playerHuntId: body.playerHuntId, userId: P.userId, damage: P.damage,
            partDamage: P.partDamage, woundDamage: P.woundDamage, behemoths: P.behemoths,
            ...(body.seconds !== undefined && { seconds: body.seconds }),
            ...(P.weapon !== undefined && { weapon: P.weapon }),
            ...(P.grade && { grade: P.grade }),
            ...(Stats && { stats: Stats }) });
    }
    return Rows;
}
