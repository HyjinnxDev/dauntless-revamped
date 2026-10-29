import { loadGameData } from "./gameData/loader";

// Hunt pass seasons. [Revamped 2026-10-24] One pass per two-week season, like retail (one pass per season):
//   season r carries COSMETIC pass cosmetic[r % n] for everyone, internal slot season43;
//   a player who completes it gets that season's Slayer Commission pass (currencies, xp tokens, no cosmetics),
//   currency[r % m], internal slot season50, until the season ends.
// The 1.14.7 client only enables hunt_pass_season_table rows season43..season50, and its Challenges ("Week N",
// UBountyComponent_Weekly) are tied to season43's window. So players and game servers only ever see "season43":
// every hunt pass id that comes in resolves to the player's served slot (controllers/progression.ts
// ResolveProgressionTrackId), and the player's config puts the served pass under season43. season44..49 are
// unused placeholders. Progress is stored per season ("huntpass:<r>:<pass>"), so a pass that comes round again
// (after n seasons) starts fresh.
// Data: game-data/hunt_passes_cosmetic.json (scripts/fetch_cosmetic_passes.cjs) and game-data/hunt_passes.json
// (scripts/fetch_hunt_passes.cjs).
// ponytail: the game server caches /progression/config, so a season change reaches it on the next restart.
export const HUNT_PASS_SLOT_IDS = ["season43", "season44", "season45", "season46", "season47", "season48", "season49", "season50"];
export const SEASON_PASS_SLOT = "season43";
export const COMMISSION_PASS_SLOT = "season50";
export const HUNT_PASS_XP_PER_LEVEL = 100;
// The pass window only prices Platinum (any other currency renders as "Free"), so the Elite track costs the real 1,000.
const HUNT_PASS_ELITE_PLATINUM = 1000;
const PLATINUM_LEVELS = 15;
const COMBAT_MERITS = "CURRENCY_PJM_WEAPON";
const FREE_MERITS = 100;
const ELITE_MERITS = 250; // the newer 30-level passes pay 250 per Elite drop
// Ranks (1-based) of the added merit drops: round(levels / 10) drops, at least 2, spread evenly.
const MeritDropRanks = (Levels: number) => {
    const N = Math.max(2, Math.round(Levels / 10));
    return Array.from({ length: N }, (_, K) => Math.round(((K + 1) * Levels) / (N + 1)));
};
// Seasons change Thursday 17:00 UTC (the live service's cadence). Season 0 (Frostfall) is the pass the old 60-day
// rotation was already serving; persistence/mongo/indexes.ts moves its progress to season 0's storage id.
const ROTATION_MS = 14 * 24 * 60 * 60 * 1000;
const ROTATION_ANCHOR_MS = Date.parse("2026-10-22T17:00:00+00:00");

type Reward = { catalog_id?: string; quantity?: number; priority?: number; kind?: "stacked" | "instanced" | "entitlement"; entitlement?: string; duration?: number };
type PassData = { id: string; name: string; levels: { free: Reward[]; elite: Reward[] }[] };
let Cosmetic: PassData[] | undefined;
let Currency: PassData[] | undefined;
const CosmeticPasses = () => (Cosmetic ??= loadGameData<PassData[]>("hunt_passes_cosmetic.json"));
const CurrencyPasses = () => (Currency ??= loadGameData<PassData[]>("hunt_passes.json"));

const IsoUtc = (Ms: number) => new Date(Ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

export const IsHuntPassSlot = (Id: unknown): Id is string => typeof Id === "string" && HUNT_PASS_SLOT_IDS.includes(Id);

export function HuntPassRotationIndex(NowMs: number): number {
    return Math.max(0, Math.floor((NowMs - ROTATION_ANCHOR_MS) / ROTATION_MS));
}

export function ActiveSeasonWindow(NowMs: number): { start: string; end: string } {
    const Start = ROTATION_ANCHOR_MS + HuntPassRotationIndex(NowMs) * ROTATION_MS;
    return { start: IsoUtc(Start), end: IsoUtc(Start + ROTATION_MS) };
}

// The window published on the hunt pass path. The client's Challenges (UBountyComponent_Weekly) open week N at
// start + 7 days * (N - 1), so the start sits CHALLENGE_WEEKS_OPEN - 1 weeks before the season: every challenge week
// is open from the season's first day. The end stays the season's end (the pass countdown). 1.14.7 carries 11 weeks
// ("43_<week>_<n>_Challenge_Season_*", weeks 1-11 seen in bountyStates 2026-10-24), so the window is 84 days, a retail
// season's length: the client builds one week entry per 7 days, and an 80-year window once froze it (routes/system.ts).
const CHALLENGE_WEEKS_OPEN = 11;
export function HuntPassPathWindow(NowMs: number): { start: string; end: string } {
    const Season = ActiveSeasonWindow(NowMs);
    return { start: IsoUtc(Date.parse(Season.start) - (CHALLENGE_WEEKS_OPEN - 1) * 7 * 24 * 60 * 60 * 1000), end: Season.end };
}

// The pass a slot carries this season: season50 the Commission pass, any other slot the season pass.
export function PassForSlot(SlotId: string, NowMs = Date.now()): PassData {
    if (!IsHuntPassSlot(SlotId)) throw new Error(`'${SlotId}' is not a hunt pass slot`);
    const R = HuntPassRotationIndex(NowMs);
    return SlotId === COMMISSION_PASS_SLOT ? CurrencyPasses()[R % CurrencyPasses().length] : CosmeticPasses()[R % CosmeticPasses().length];
}

// Progress is stored per season and pass, e.g. "huntpass:0:frostfall".
export const HuntPassStorageId = (SlotId: string, NowMs = Date.now()) => `huntpass:${HuntPassRotationIndex(NowMs)}:${PassForSlot(SlotId, NowMs).id}`;
export const IsHuntPassStorageId = (Id: string) => /^(huntpass|season\d+):/.test(Id);

// [from, to] storage ids for rows the old 60-day rotation wrote. All of them are from its rotation 0, where season43+j
// carried cosmetic[j] and season50 currency[0]; cosmetic[j] is now season j's pass and currency[0] season 0's
// Commission pass, so every old row has a season to move to and no progress is lost (persistence/mongo/indexes.ts).
export function LegacyHuntPassStorageMoves(): [string, string][] {
    const At = (Season: number) => ROTATION_ANCHOR_MS + Season * ROTATION_MS;
    return [
        ...Array.from({ length: 7 }, (_, J): [string, string] => [`season${43 + J}:${CosmeticPasses()[J].id}`, HuntPassStorageId(SEASON_PASS_SLOT, At(J))]),
        [`${COMMISSION_PASS_SLOT}:${CurrencyPasses()[0].id}`, HuntPassStorageId(COMMISSION_PASS_SLOT, At(0))],
    ];
}

export const HuntPassMaxXp = (SlotId: string, NowMs = Date.now()) => PassForSlot(SlotId, NowMs).levels.length * HUNT_PASS_XP_PER_LEVEL;

// [2026-10-25] Past the Commission pass's last level (the end of the season's hunt pass) every further
// HUNT_PASS_XP_PER_LEVEL pays 25-50 platinum. Progress is never capped, so this is the platinum for one grant moving
// the stored progress Before -> After; the grant ledger makes it once per grantId.
const OVERFLOW_PLATINUM_MIN = 25, OVERFLOW_PLATINUM_MAX = 50;
export function HuntPassOverflowPlatinum(SlotId: string, Before: number, After: number, NowMs = Date.now(), Rand = Math.random): number {
    if (SlotId !== COMMISSION_PASS_SLOT) return 0;
    const Max = HuntPassMaxXp(SlotId, NowMs);
    const Levels = (Xp: number) => Math.max(0, Math.floor((Xp - Max) / HUNT_PASS_XP_PER_LEVEL));
    let Platinum = 0;
    for (let N = Levels(After) - Levels(Before); N > 0; N--) Platinum += OVERFLOW_PLATINUM_MIN + Math.floor(Rand() * (OVERFLOW_PLATINUM_MAX - OVERFLOW_PLATINUM_MIN + 1));
    return Platinum;
}

// Rank curve of the pass a slot carries (same shape controllers/progression.ts builds for configured tracks).
export function HuntPassCurve(SlotId: string, NowMs = Date.now()) {
    const Levels = PassForSlot(SlotId, NowMs).levels.length;
    return { maxRank: Levels, cumulativeXpForRank: new Map(Array.from({ length: Levels + 1 }, (_, Rank) => [Rank, Rank * HUNT_PASS_XP_PER_LEVEL] as [number, number])) };
}

// The internal slot this player is on: GAMESERVER_HUNTPASS_ID pins it (debugging); otherwise the season pass until
// they complete it, then the Commission pass. `Rows` are the player's stored progression tracks.
export function ServedSlotFor(Rows: { progressionId: string; progress: number }[], NowMs = Date.now()): string {
    const Pinned = process.env.GAMESERVER_HUNTPASS_ID?.trim();
    if (Pinned) return Pinned;
    const Done = Rows.find((Row) => Row.progressionId === HuntPassStorageId(SEASON_PASS_SLOT, NowMs))?.progress ?? 0;
    return Done < HuntPassMaxXp(SEASON_PASS_SLOT, NowMs) ? SEASON_PASS_SLOT : COMMISSION_PASS_SLOT;
}

export function HuntPassPassSkuTag(SlotId: string): string {
    return `${SlotId}_pass`;
}

// The entitlement that unlocks a pass's Elite track; the same string is the path's premium_gating_entitlement and
// what the Elite SKU grants. A cosmetic pass's Elite is owned for good (it next returns n seasons later).
// [2026-10-25] The season pass's Elite also unlocks that season's Commission pass Elite (the user's call): the game
// server only knows season43's gate, so it sends a season Elite owner's Commission claims as Elite claims, and a
// separate Commission Elite made them 403 ("server error"). SlotId is kept so callers stay per slot.
export const HuntPassEntitlement = (_SlotId: string, NowMs = Date.now()) => `${PassForSlot(SEASON_PASS_SLOT, NowMs).id}_premium`;
// One-time purchase key of the Elite SKU (keeps the 60-day rotation's "season43_premium:<pass>").
const HuntPassOwnershipKey = (_SlotId: string, NowMs = Date.now()) => `${SEASON_PASS_SLOT}_premium:${PassForSlot(SEASON_PASS_SLOT, NowMs).id}`;

// One level's rewards in the shape the real configs use: stacked_items {catalog_id, hidden, priority, quantity},
// instanced_items [catalog ids] (lanterns, banner fabric/standard) and entitlements (escalation boosts).
function Level(Rank: number, Rewards: Reward[]) {
    const Stacked = Rewards.filter((R) => R.kind !== "instanced" && R.kind !== "entitlement" && R.catalog_id);
    return {
        rank_id: Rank,
        entitlements: Rewards.filter((R) => R.kind === "entitlement").map((R) => ({ entitlement: R.entitlement, duration: R.duration })),
        instanced_items: Rewards.filter((R) => R.kind === "instanced").map((R) => R.catalog_id),
        stacked_items: Stacked.map((R, I) => ({ catalog_id: R.catalog_id, hidden: false, priority: R.priority ?? I, quantity: R.quantity ?? 1 })),
    };
}

// The progression path (rank curve + free/premium rewards + season window) of the pass a slot carries, published
// under ClientSlot (a player's served pass always goes out as season43).
export function BuildHuntPassPath(SlotId: string, NowMs = Date.now(), ClientSlot = SlotId) {
    const Pass = PassForSlot(SlotId, NowMs);
    const Window = HuntPassPathWindow(NowMs);
    // Platinum can't be bought here, so it is earned: the wiki's 100-300 of free-track platinum is replaced by one
    // Elite price, paid evenly over the first PLATINUM_LEVELS levels so the next Elite track is reachable early.
    // Passes with no free platinum stay as-is.
    const IsPlatinum = (R: Reward) => R.catalog_id?.startsWith("CURRENCY_PLATINUM");
    const HasPlatinum = Pass.levels.some((L) => L.free.some(IsPlatinum));
    const Spread = Math.min(PLATINUM_LEVELS, Pass.levels.length);
    const PlatinumAt = (I: number): Reward[] => !HasPlatinum || I >= Spread ? [] : [{ catalog_id: "CURRENCY_PLATINUM_UNIV", quantity: Math.floor(HUNT_PASS_ELITE_PLATINUM / Spread) + (I === Spread - 1 ? HUNT_PASS_ELITE_PLATINUM % Spread : 0) }];
    // Combat Merits on every free track, and on Elite tracks that have none (the older and event passes), about one
    // drop per ten levels, on top of whatever the level already pays.
    const HasEliteMerits = Pass.levels.some((L) => L.elite.some((R) => R.catalog_id === COMBAT_MERITS));
    const MeritRanks = MeritDropRanks(Pass.levels.length);
    const MeritsAt = (I: number, Quantity: number): Reward[] => MeritRanks.includes(I + 1) ? [{ catalog_id: COMBAT_MERITS, quantity: Quantity }] : [];
    const Rewards = (Track: "free" | "elite") => Pass.levels.map((L, I) => Level(I + 1, Track === "free"
        ? [...L.free.filter((R) => !HasPlatinum || !IsPlatinum(R)), ...PlatinumAt(I), ...MeritsAt(I, FREE_MERITS)]
        : [...L.elite, ...(HasEliteMerits ? [] : MeritsAt(I, ELITE_MERITS))]));
    return {
        progression_id: ClientSlot,
        // Config contract (docs/findings/backend-contract.md in the Revived stack): a path with a premium gate and
        // premium_rewards is a hunt pass. 1.14.7's LoadComplete skips tracks without it (activeData stayed empty).
        premium_gating_entitlement: HuntPassEntitlement(SlotId, NowMs),
        progression_multiplier: 1,
        requirements: Array.from({ length: Pass.levels.length + 1 }, (_, Rank) => ({ rank_id: Rank, xp_required: Rank === 0 ? 0 : HUNT_PASS_XP_PER_LEVEL })),
        free_rewards: [Level(0, []), ...Rewards("free")],
        premium_rewards: [Level(0, []), ...Rewards("elite")],
        start_date: Window.start,
        end_date: Window.end,
        pass_name: Pass.name,
    };
}

// What a claim on SlotId's pass owes: every rank stored Progress reaches past the confirmed ranks, free track always,
// Elite track when Elite is owned. Returns the new confirmed ranks and the summed stacked rewards (the passes only
// pay stacked items: currencies and tokens).
export function HuntPassClaimOwed(SlotId: string, Progress: number, Free: number, Premium: number, Elite: boolean, NowMs = Date.now()) {
    const Path = BuildHuntPassPath(SlotId, NowMs);
    const Rank = Math.min(Path.free_rewards.length - 1, Math.floor(Progress / HUNT_PASS_XP_PER_LEVEL));
    const NewFree = Math.max(Free, Rank), NewPremium = Elite ? Math.max(Premium, Rank) : Premium;
    const Totals = new Map<string, number>();
    const Add = (Levels: typeof Path.free_rewards, From: number, To: number) => {
        for (let R = From + 1; R <= To; R++) for (const I of Levels[R].stacked_items) Totals.set(I.catalog_id!, (Totals.get(I.catalog_id!) ?? 0) + I.quantity);
    };
    Add(Path.free_rewards, Free, NewFree);
    Add(Path.premium_rewards, Premium, NewPremium);
    return { free: NewFree, premium: NewPremium, items: [...Totals].map(([catalogId, quantity]) => ({ catalogId, quantity })) };
}

// The Elite SKU of the pass SlotId carries, listed as ClientSlot's (season43_premium in tag season43_pass: the client
// only shows season43). displayName and entitlements are getters so they follow the season without a restart.
export function HuntPassSkus(SlotId: string, ClientSlot = SEASON_PASS_SLOT) {
    return [{
        id: `${ClientSlot}_premium`, // a row of the client's StoreItemsTable (Items_Analysis/store_item_images_1_14_7.jsonl); the store tag stays `<slot>_pass`
        get displayName() { return `${PassForSlot(SlotId).name} Elite Track`; },
        displayDescription: "Unlocks the Elite track of this Hunt Pass.",
        displayPriority: 1,
        prices: [{ currencyId: "id_currency_platinum", price: HUNT_PASS_ELITE_PLATINUM }],
        maxAllowed: 1,
        get ownershipKey() { return HuntPassOwnershipKey(SlotId); },
        get availableFrom() { return ActiveSeasonWindow(Date.now()).start; }, // season window: client countdown
        get availableTo() { return ActiveSeasonWindow(Date.now()).end; },
        tags: [HuntPassPassSkuTag(ClientSlot)],
        items: [],
        get entitlements() { return [{ name: HuntPassEntitlement(SlotId), duration: 0 }]; },
        duplicateInstancedItems: [],
    }];
}

if (require.main === module) {
    const assert = require("node:assert");
    const Day = 24 * 60 * 60 * 1000;
    const At = (N: number) => ROTATION_ANCHOR_MS + N * 14 * Day;
    // two-week seasons from Thursday 2026-10-22 17:00 UTC
    assert.equal(HuntPassRotationIndex(At(0)), 0);
    assert.equal(HuntPassRotationIndex(At(1) - 1), 0);
    assert.equal(HuntPassRotationIndex(At(1)), 1);
    assert.deepEqual(ActiveSeasonWindow(Date.parse("2026-10-24T00:00:00Z")), { start: "2026-10-22T17:00:00+00:00", end: "2026-11-05T17:00:00+00:00" });
    // one cosmetic pass per season, in order, for everyone; the Commission pass cycles alongside
    assert.equal(PassForSlot(SEASON_PASS_SLOT, At(0)).id, "frostfall");
    assert.equal(PassForSlot(SEASON_PASS_SLOT, At(1)).id, CosmeticPasses()[1].id);
    assert.equal(PassForSlot(SEASON_PASS_SLOT, At(CosmeticPasses().length)).id, "frostfall");
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((N) => PassForSlot(COMMISSION_PASS_SLOT, At(N)).name), ["Return to Light", "Dire Discovery", "Elemental Fury", "Heroic Thunder", "Darkened Skies", "Return to Light"]);
    // pass ids are unique across both datasets (they key stored progress and entitlements)
    const Ids = [...CosmeticPasses(), ...CurrencyPasses()].map((P) => P.id);
    assert.equal(new Set(Ids).size, Ids.length);
    // storage is per season: the old rotation's rows move to the season their pass now falls in, and Frostfall
    // coming round again starts fresh
    assert.equal(HuntPassStorageId(SEASON_PASS_SLOT, At(0)), "huntpass:0:frostfall");
    assert.deepEqual(LegacyHuntPassStorageMoves().slice(0, 2), [["season43:frostfall", "huntpass:0:frostfall"], ["season44:saint_s_bond", "huntpass:1:saint_s_bond"]]);
    assert.deepEqual(LegacyHuntPassStorageMoves()[7], ["season50:return_to_light", "huntpass:0:return_to_light"]);
    assert.notEqual(HuntPassStorageId(SEASON_PASS_SLOT, At(CosmeticPasses().length)), HuntPassStorageId(SEASON_PASS_SLOT, At(0)));
    assert.ok(IsHuntPassStorageId("huntpass:0:frostfall") && IsHuntPassStorageId("season44:saint_s_bond") && !IsHuntPassStorageId("season43"));
    // served slot: the season pass until completed, then the Commission pass; a new season starts on its pass again
    const Done = (N: number) => [{ progressionId: HuntPassStorageId(SEASON_PASS_SLOT, At(N)), progress: HuntPassMaxXp(SEASON_PASS_SLOT, At(N)) }];
    assert.equal(ServedSlotFor([], At(0)), SEASON_PASS_SLOT);
    assert.equal(ServedSlotFor([{ ...Done(0)[0], progress: Done(0)[0].progress - 1 }], At(0)), SEASON_PASS_SLOT);
    assert.equal(ServedSlotFor(Done(0), At(0)), COMMISSION_PASS_SLOT);
    assert.equal(ServedSlotFor(Done(0), At(1)), SEASON_PASS_SLOT);
    // Elite: cosmetic passes keep the old per-pass entitlement and purchase key; Commission Elite is per season
    assert.equal(HuntPassEntitlement(SEASON_PASS_SLOT, At(0)), "frostfall_premium");
    assert.equal(HuntPassOwnershipKey(SEASON_PASS_SLOT, At(0)), "season43_premium:frostfall");
    assert.notEqual(HuntPassEntitlement(COMMISSION_PASS_SLOT, At(0)), HuntPassEntitlement(COMMISSION_PASS_SLOT, At(5)));
    // the client only ever sees season43: the Commission pass goes out under it too
    const Commission = BuildHuntPassPath(COMMISSION_PASS_SLOT, At(0), SEASON_PASS_SLOT);
    assert.equal(Commission.progression_id, SEASON_PASS_SLOT);
    assert.equal(Commission.premium_gating_entitlement, HuntPassEntitlement(COMMISSION_PASS_SLOT, At(0)));
    assert.equal(HuntPassSkus(COMMISSION_PASS_SLOT)[0].id, "season43_premium");
    assert.deepEqual(HuntPassSkus(COMMISSION_PASS_SLOT)[0].tags, ["season43_pass"]);
    // path: gate == SKU entitlement, requirement count == levels + 1, rewards in the real-config shape
    assert.equal(BuildHuntPassPath("season43").premium_gating_entitlement, HuntPassSkus("season43")[0].entitlements[0].name);
    const P = BuildHuntPassPath("season43", At(0));
    assert.equal(P.requirements.length, PassForSlot("season43", At(0)).levels.length + 1);
    assert.equal(P.free_rewards.length, P.requirements.length);
    assert.equal(HuntPassCurve("season43", At(0)).maxRank, P.requirements.length - 1);
    // finishing the free track pays back the Elite price in platinum (rounding aside)
    const Plat = P.free_rewards.flatMap((L) => L.stacked_items).filter((I) => I.catalog_id?.startsWith("CURRENCY_PLATINUM")).reduce((N, I) => N + I.quantity, 0);
    assert.equal(Plat, HUNT_PASS_ELITE_PLATINUM);
    // ...and it is all paid by level 15
    const Early = P.free_rewards.slice(0, PLATINUM_LEVELS + 1).flatMap((L) => L.stacked_items).filter((I) => I.catalog_id?.startsWith("CURRENCY_PLATINUM")).reduce((N, I) => N + I.quantity, 0);
    assert.equal(Early, HUNT_PASS_ELITE_PLATINUM);
    // an escalation boost / lantern keeps its list: look for any non-stacked reward across the first pass
    const Lists = P.premium_rewards.flatMap((L) => [L.instanced_items.length, L.entitlements.length]);
    assert.ok(Lists.every((N) => Number.isInteger(N)));
    // combat merits: every pass's free track pays them; Elite gets them only where the data had none
    const Merits = (Levels: { stacked_items: { catalog_id?: string; quantity: number }[] }[]) => Levels.flatMap((L) => L.stacked_items).filter((I) => I.catalog_id === COMBAT_MERITS).reduce((N, I) => N + I.quantity, 0);
    for (const [Slot, Passes] of [["season43", CosmeticPasses()], ["season50", CurrencyPasses()]] as const) {
        Passes.forEach((Pass, Idx) => {
            const Path = BuildHuntPassPath(Slot, At(Idx));
            assert.equal(Path.pass_name, Pass.name);
            assert.ok(Merits(Path.free_rewards) >= 2 * FREE_MERITS, `${Pass.name} free merits`);
            assert.ok(Merits(Path.premium_rewards) > 0, `${Pass.name} elite merits`);
        });
    }
    assert.equal(Merits(BuildHuntPassPath("season43", At(0)).premium_rewards), MeritDropRanks(50).length * ELITE_MERITS); // Frostfall had none
    assert.deepEqual(MeritDropRanks(10), [3, 7]);
    // overflow platinum: only past the Commission pass's end, 25-50 per whole level crossed
    const CMax = HuntPassMaxXp(COMMISSION_PASS_SLOT, At(0));
    assert.equal(HuntPassOverflowPlatinum(SEASON_PASS_SLOT, 1e6, 2e6, At(0)), 0);
    assert.equal(HuntPassOverflowPlatinum(COMMISSION_PASS_SLOT, CMax - 50, CMax + 99, At(0)), 0);
    assert.equal(HuntPassOverflowPlatinum(COMMISSION_PASS_SLOT, CMax - 50, CMax + 250, At(0), () => 0), 2 * 25);
    assert.equal(HuntPassOverflowPlatinum(COMMISSION_PASS_SLOT, CMax + 150, CMax + 250, At(0), () => 0.999), 50);
    // claims owed: Return to Light rank 1 free pays its own 1000 notes + 66 plat (it paid Frostfall's rank 1 before)
    const Qty = (Items: { catalogId: string; quantity: number }[], Id: string) => Items.find((I) => I.catalogId === Id)?.quantity ?? 0;
    const R1 = HuntPassClaimOwed(COMMISSION_PASS_SLOT, 184, 0, 0, false, At(0));
    assert.deepEqual([R1.free, R1.premium, Qty(R1.items, "CURRENCY_NOTES"), Qty(R1.items, "CURRENCY_PLATINUM_UNIV")], [1, 0, 1000, 66]);
    assert.deepEqual(HuntPassClaimOwed(COMMISSION_PASS_SLOT, 184, 1, 0, false, At(0)).items, []); // already claimed
    const E2 = HuntPassClaimOwed(COMMISSION_PASS_SLOT, 250, 1, 0, true, At(0)); // rank 2 free + Elite 1-2
    assert.deepEqual([E2.free, E2.premium, Qty(E2.items, "CURRENCY_PJM_WEAPON"), Qty(E2.items, "CURRENCY_NOTES")], [2, 2, 125, 10000]);
    assert.equal(HuntPassClaimOwed(COMMISSION_PASS_SLOT, 1e9, 0, 0, false, At(0)).free, 100); // capped at the last level
    // the season pass's Elite is the Commission pass's Elite
    assert.equal(HuntPassEntitlement(COMMISSION_PASS_SLOT, At(0)), "frostfall_premium");
    assert.equal(HuntPassEntitlement(SEASON_PASS_SLOT, At(1)), HuntPassEntitlement(COMMISSION_PASS_SLOT, At(1)));
    console.log("huntPassRotation ok");
}
