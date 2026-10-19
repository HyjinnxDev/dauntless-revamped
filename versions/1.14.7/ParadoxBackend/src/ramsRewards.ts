/**
 * [2026-10-19] Rams (CURRENCY_NOTES) and Patrol Key payouts the backend rewrites on dedicated-server grants.
 * Every rule keys on the game's own `source` string or on what the same transaction removes, so store purchases and
 * other callers are untouched. Retried transactions replay the ledger result, so nothing here can pay twice or reroll.
 *
 *   - fountain core (removes CONTAINER_CORE_REWARD_DAILY_01): 4-6 Patrol Keys, measured game roll 3; +20 Platinum daily gift
 *   - behemoth kill ("PlayerLoot"): game Rams remapped onto 200-750
 *   - patrol chest ("patrol_chest"): game Rams remapped onto 1500-5000
 *   - base bounty claim ("UBountyComponent::OnClaimBountyComplete"): +250/400/600 Rams, +2/4/6 Platinum for Bronze/Silver/Gold
 *   - party bonus on kill and chest Rams: +5% per party member beyond the first (+15% at 4)
 *   - gathering ("BUNDLE_GATHER_*"): +10 Rams per node, +25 for special/chest nodes
 */
import { logger } from "./logger";

export const FOUNTAIN_PATROL_KEYS_MIN = 4;
export const FOUNTAIN_PATROL_KEYS_MAX = 6;
export const BOUNTY_CLAIM_RAMS: Record<string, number> = { Bronze: 250, Silver: 400, Gold: 600 };
// [2026-10-20] Steady platinum: a daily gift on the coin flip plus a grind share capped by 10 bounty tokens/day.
export const DAILY_GIFT_PLATINUM = 20;
export const BOUNTY_CLAIM_PLATINUM: Record<string, number> = { Bronze: 2, Silver: 4, Gold: 6 };
const PLATINUM = "CURRENCY_PLATINUM_UNIV";
const PARTY_BONUS_PERCENT_PER_MEMBER = 5, PARTY_MAX = 4;
const GATHER_RAMS = 10, GATHER_SPECIAL_RAMS = 25;

// The game's kill Rams already rise with hunt threat (measured: Snowflake t4 145, Electroquill t5 160, Shadowcat t8 230,
// Mantis/Lerawr Alpha 260), so the difficulty scaling is kept by remapping that amount linearly.
// ponytail: KILL_GAME_MAX 560 is extrapolated to threat 22 from those samples; read [RamsRewards] PlayerLoot lines after
// heroic/escalation kills and move it to the real top value.
const KILL_GAME_MIN = 145, KILL_GAME_MAX = 560, KILL_MIN = 200, KILL_MAX = 750;
// Measured patrol chest range 625-3750 over 9 opens (multiples of 25).
const CHEST_GAME_MIN = 625, CHEST_GAME_MAX = 3750, CHEST_MIN = 1500, CHEST_MAX = 5000;

export function Remap(Value: number, FromMin: number, FromMax: number, ToMin: number, ToMax: number, Step: number): number {
    const Scaled = ToMin + (Value - FromMin) * (ToMax - ToMin) / (FromMax - FromMin);
    return Math.min(ToMax, Math.max(ToMin, Math.round(Scaled / Step) * Step));
}

// /bounty/delete names the bounty a claim is for ~75 ms before the claim's grant transaction arrives (an abandon sends
// the delete with no grant). Only ids the backend actually removed are noted, so a made-up id cannot pick the tier.
const BOUNTY_CLAIM_WINDOW_MS = 10_000;
const PendingBountyTier = new Map<string, { tier: string; at: number }>();

export function NoteRemovedBounties(UserId: string, RemovedIds: string[], Now = Date.now()): void {
    for (const Id of RemovedIds) {
        const Tier = /^Bounty_(Bronze|Silver|Gold)_/.exec(Id)?.[1];
        if (Tier) PendingBountyTier.set(UserId, { tier: Tier, at: Now });
    }
}

function TakeBountyTier(UserId: string, Now: number): string | undefined {
    const Pending = PendingBountyTier.get(UserId);
    PendingBountyTier.delete(UserId);
    return Pending && Now - Pending.at <= BOUNTY_CLAIM_WINDOW_MS ? Pending.tier : undefined;
}

/** Sources whose Rams get the party bonus; the caller looks up party size only for these. */
export function IsPartyBonusSource(Source: string | undefined): boolean {
    return Source === "PlayerLoot" || Source === "patrol_chest";
}

export function ApplyRamsRewards(UserId: string, TransactionId: string, StackedItemsToAdd: any[], StackedItemsToRemove: any[] | undefined, Source: string | undefined, PartySize = 1, Random = Math.random, Now = Date.now()): any[] {
    const Log = (Message: string) => logger.info(`[RamsRewards] transactionId ${TransactionId} user ${UserId} ${Message}`);
    const IsKey = (Item: any) => Item?.catalogId === "TOKEN_DAILY_PATROL_BONUS_PURCHASED";

    if (StackedItemsToRemove?.some((Item) => Item?.catalogId === "CONTAINER_CORE_REWARD_DAILY_01") && StackedItemsToAdd.some(IsKey)) {
        const Quantity = FOUNTAIN_PATROL_KEYS_MIN + Math.floor(Random() * (FOUNTAIN_PATROL_KEYS_MAX - FOUNTAIN_PATROL_KEYS_MIN + 1));
        Log(`fountain core patrol keys ${StackedItemsToAdd.filter(IsKey).reduce((Sum, Item) => Sum + (Item.quantity ?? 0), 0)} -> ${Quantity}`);
        return [...StackedItemsToAdd.filter((Item) => !IsKey(Item)), { catalogId: "TOKEN_DAILY_PATROL_BONUS_PURCHASED", quantity: Quantity }, { catalogId: PLATINUM, quantity: DAILY_GIFT_PLATINUM }];
    }

    if (Source === "UBountyComponent::OnClaimBountyComplete") {
        const Tier = TakeBountyTier(UserId, Now);
        if (!Tier) return StackedItemsToAdd;
        Log(`bounty claim ${Tier} +${BOUNTY_CLAIM_RAMS[Tier]} Rams +${BOUNTY_CLAIM_PLATINUM[Tier]} Platinum`);
        return [...StackedItemsToAdd, { catalogId: "CURRENCY_NOTES", quantity: BOUNTY_CLAIM_RAMS[Tier] }, { catalogId: PLATINUM, quantity: BOUNTY_CLAIM_PLATINUM[Tier] }];
    }

    if (Source?.startsWith("BUNDLE_GATHER")) {
        const Rams = /SPECIAL|CHEST/.test(Source) ? GATHER_SPECIAL_RAMS : GATHER_RAMS;
        return [...StackedItemsToAdd, { catalogId: "CURRENCY_NOTES", quantity: Rams }];
    }

    const Range = Source === "PlayerLoot" ? [KILL_GAME_MIN, KILL_GAME_MAX, KILL_MIN, KILL_MAX, 5]
        : Source === "patrol_chest" ? [CHEST_GAME_MIN, CHEST_GAME_MAX, CHEST_MIN, CHEST_MAX, 25]
        : undefined;
    if (!Range) return StackedItemsToAdd;
    const BonusPercent = (Math.min(Math.max(PartySize, 1), PARTY_MAX) - 1) * PARTY_BONUS_PERCENT_PER_MEMBER;
    return StackedItemsToAdd.map((Item) => {
        if (Item?.catalogId !== "CURRENCY_NOTES" || !(Number(Item.quantity) > 0)) return Item;
        const Base = Remap(Number(Item.quantity), Range[0], Range[1], Range[2], Range[3], Range[4]);
        const Quantity = Math.round(Base * (100 + BonusPercent) / 500) * 5;
        Log(`${Source} Rams ${Item.quantity} -> ${Quantity} (party ${PartySize}, +${BonusPercent}%)`);
        return { ...Item, quantity: Quantity };
    });
}
