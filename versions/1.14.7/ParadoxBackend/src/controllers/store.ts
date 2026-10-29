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

import crypto from "node:crypto";
import { ClientSession } from "mongodb";
import { GetRepositories, RepositoryProvider } from "../persistence";
import { GetBalance, InsufficientBalanceError } from "./wallet";
import { RunInventoryTransaction, InventoryTransactionConflictError, InventoryTransactionMismatchError } from "./inventory";
import { GrantEntitlementsInTransaction } from "./entitlements";
import { GetServedSlotForUser, GetTrackCurve, ProgressionStorageId, ResolveProgressionTrackId } from "./progression";
import { ResolveProgressionGrant } from "../skuProgression";
import { logger } from "../logger";
import { HuntPassPassSkuTag, HuntPassSkus, SEASON_PASS_SLOT } from "../huntPassRotation";
import { loadGameData } from "../gameData/loader";

// [2026-07-24] Lady Luck's Store (the Trials/Arena reward shop). Confirmed real endpoint contract:
// GET /product/skus/public?requiredTags=ladyluckstore returns exactly this shape
// (DauntlessEndpointDocumentation/Store/Product/Skus/SearchPublic.md + ladyluckstore.json), captured
// from Dauntless 2.1.1 - NOT our 1.12.0 target. The base data is that capture filtered to catalog ids
// independently verified in the real 1.12 catalog (Items_Analysis/catalog_1_12.jsonl). The current
// 49-offer set also includes the verified 1.12 Discipline PlayerRole and 11 additional Trials cosmetics
// (two mantles and nine titles) that existed in 1.12 but were absent from the later capture. The five
// stat-specific gold-cell-core SKUs remain excluded because their catalog ids do not exist in 1.12.
// See Progress/29_LADY_LUCKS_STORE.md for the full provenance and validation.
//
// `instanced` preserves the captured/request construction hint so deterministic Lady Luck purchase
// transaction bodies remain replay-compatible with idempotency rows written by older builds. It is NOT
// the final persistence authority. RunInventoryTransaction applies the generated 1.12 catalog storage
// policy after hashing the original request: cosmetic/transmog WP_/AR_/LT_ unlocks with
// isStackable:true are persisted as stacked ownership, while functional gear such as LT_TRIALS_00 and
// PART_CB_PASSIVE_TRIALS_02 remains instanced. See inventoryStoragePolicy.ts.
export type StoreSkuItem = { catalogId: string; quantity: number; instanced: boolean };
export type StoreSkuEntitlement = { name: string; duration: number };
export type StoreSkuProgression = { progressionId: string; xp: number | null; ranks: number | null };
export type StoreSku = {
    id: string;
    displayName: string;
    displayDescription: string;
    displayPriority: number;
    prices: { currencyId: string; price: number }[];
    maxAllowed: number | null;
    /** Identity a one-time purchase is recorded under when the SKU id alone is not unique over time (hunt pass Elite: the id is a client row, the pass behind it rotates). */
    ownershipKey?: string;
    /** ISO window for a time-limited offer (client fields availableFrom/availableTo); omitted = always available. */
    availableFrom?: string;
    availableTo?: string;
    images?: Record<string, string>;
    tags: string[];
    items: StoreSkuItem[];
    // [2026-07-30] The two non-inventory payload kinds a Dauntless SKU can carry, both optional and
    // both absent from the Lady Luck / Reward Cache data (those are purely item grants). See
    // Progress/33_PLATINUM_STORE.md for the FOnlineStorePhoenixOffer field mapping. `loadoutSlots`
    // is the third and is deliberately NOT modelled yet - loadout slot totals are derived
    // authoritatively from Slayer's Path state (Progress/08_LOADOUT.md), so an additive purchased
    // count needs a decision about that authority first, and no SKU here sells one.
    entitlements?: StoreSkuEntitlement[];
    skuProgression?: StoreSkuProgression | null;
    // [2026-07-24] Verbatim from the real 2.1.1 capture (ladyluckstore.json), keyed by SKU id - NOT
    // derived from our own `instanced` grant-classification above. The two do not line up: e.g. the
    // real client lists DYE_* catalogIds here (dyes are wallet-stacked, `instanced:false` for grant
    // purposes) but omits PART_CB_PASSIVE_TRIALS_02 and the functional LT_TRIALS_00 lantern (both
    // `instanced:true` for grant purposes). This field appears to drive which items the client
    // resolves a real preview icon/thumbnail for (cosmetic transmog skins, dyes, emojis, banners) as
    // opposed to plain functional/consumable items - populating it from our own `instanced` flag
    // instead (as an earlier version of this route did) is why dye tiles rendered with no icon.
    duplicateInstancedItems: string[];
};

const LADYLUCK_SKUS = loadGameData<StoreSku[]>("ladyluck_store.json");
const REWARD_CACHE_SKUS = loadGameData<StoreSku[]>("reward_cache_store.json");
const PLATINUM_SKUS = loadGameData<StoreSku[]>("platinum_store.json");

// [2026-07-30] The platinum data set spans FOUR store sections the client requests separately
// (`webstore`, `dyes`, `hp_level_skip_rank`, `huntpass_store` - all four confirmed in live capture
// traffic), so it is registered per tag and filtered by tag membership, which is also what the real
// service's `requiredTags` contract means. Lady Luck and the Reward Cache keep their existing
// whole-array registration: every SKU in those files already carries its own store tag, so the two
// forms agree, and not touching them keeps this change behaviour-neutral for both.
function PlatinumSection(sectionTag: string): StoreSku[] {
    return PLATINUM_SKUS.filter((Sku) => Sku.tags.includes(sectionTag));
}

// [1.14.7 2026-10-08] The Middleman's cell-fusion slots. Slot 1 is free; slots 2 and 3 are unlocked by the
// entitlements exchange_slot_2 / exchange_slot_3 (a live account carries exchange_slot_2 in
// Auth/GetEntitlements.md), sold under the store tags the Middleman requests (exchange_vendor_slot_2/3). The SKU
// ids are the client's own StoreItemsTable rows (single_exchange_slot_2/3, art Store_Art_512x512_cell_slot_middleman).
// No live SKU capture exists: 500 Platinum each per the wiki (The Middleman: "two more are purchasable from the
// Store for 500 Platinum"; 1,000 was the earlier launch price), permanent (duration 0).
function ExchangeSlotSku(Slot: 2 | 3): StoreSku {
    return {
        id: `single_exchange_slot_${Slot}`,
        displayName: `Cell Fusion Slot ${Slot}`,
        displayDescription: `Unlocks cell fusion slot ${Slot} at the Middleman permanently.`,
        displayPriority: Slot,
        prices: [{ currencyId: "id_currency_platinum", price: 500 }],
        maxAllowed: 1,
        tags: [`exchange_vendor_slot_${Slot}`],
        items: [],
        entitlements: [{ name: `exchange_slot_${Slot}`, duration: 0 }],
        duplicateInstancedItems: [],
    };
}
// [1.14.7 2026-10-15] Ramsgate fountain coin toss: UArchonActivitiesProgressionComponent::ClaimDailyBonus queries
// `fountain_daily_free_bundle` (runtime [CoinToss] probe), buys the offer, and cointoss_stringer_bpw plays the flip
// when CONTAINER_CORE_REWARD_DAILY_01 is granted. No live SKU capture: id is ours, price free (0 Platinum, never
// debited). One claim per UTC day (same day boundary as the bounty token refill): the ownership key carries the day,
// so a repeat toss the same day replays the first purchase instead of granting again. The listing hides the offer
// once today's claim is in the ledger (FountainClaimedToday), so the coin is only tossable once per day.
function FountainDailySku(): StoreSku {
    return {
        id: "fountain_daily_free_bundle_01",
        displayName: "Daily Fountain Bonus",
        displayDescription: "Toss a coin in the Ramsgate fountain once a day.",
        displayPriority: 0,
        prices: [{ currencyId: "id_currency_platinum", price: 0 }],
        maxAllowed: 1,
        ownershipKey: `fountain_daily_free_bundle_01:${new Date().toISOString().slice(0, 10)}`,
        availableTo: `${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`, // next UTC day: client countdown
        tags: ["fountain_daily_free_bundle"],
        items: [{ catalogId: "CONTAINER_CORE_REWARD_DAILY_01", quantity: 1, instanced: false }],
        duplicateInstancedItems: [],
    };
}
// [1.14.7 2026-10-16] The Middleman's cell offers (store tag `weekly_cell_offering`, read by
// UExchangeVendorCellOffers: one tile per SKU from its cell item, PlatPrice, DustPrice and availableTo, which the
// client counts down). [2026-10-17] Rotates DAILY at 18:00 UTC (was weekly) and sells one +1, one +2 and one +3 cell,
// each from a different family, for Platinum OR Aetherdust; the player picks the currency and PurchaseStoreSku charges
// only that one. Families from game-data/middleman_cells.json (scripts/generate_middleman_cells.cjs; every family
// there also has _R (+2) and _E (+3) catalog cells). Tier prices set by the server owner; +2/+3 cost more than fusing
// +1s yourself, the premium buys skipping the fusion.
// ponytail: the wiki says each cell has a purchase limit "depending on the cell" but not what it is, so no limit.
// [2026-10-20] Aetherdust prices use currencyId "CURRENCY_CELLDUST": the client's cell tile builder (exe 0x1ebf620)
// matches price ids literally, "id_currency_platinum" -> PlatPrice and "CURRENCY_CELLDUST" -> DustPrice; with
// "id_currency_celldust" every dust price showed -1.
const MIDDLEMAN_DAY_MS = 24 * 60 * 60 * 1000;
const MIDDLEMAN_ROTATION_EPOCH = Date.UTC(1970, 0, 1, 18);
const MIDDLEMAN_TIERS = [
    { suffix: "UC", level: 1, platinum: 50, dust: 40 },
    { suffix: "R", level: 2, platinum: 150, dust: 100 },
    { suffix: "E", level: 3, platinum: 300, dust: 250 },
];
type MiddlemanFamily = { id: string; name: string };
let MiddlemanFamilies: MiddlemanFamily[] | undefined;
export function WeeklyCellSkus(NowMs = Date.now()): StoreSku[] {
    MiddlemanFamilies ??= loadGameData<{ families: MiddlemanFamily[] }>("middleman_cells.json").families;
    const Day = Math.floor((NowMs - MIDDLEMAN_ROTATION_EPOCH) / MIDDLEMAN_DAY_MS);
    const Start = MIDDLEMAN_ROTATION_EPOCH + Day * MIDDLEMAN_DAY_MS;
    // Fresh shuffle per day, seeded by the day so every read and every server agrees on today's three.
    const Families = MiddlemanFamilies
        .map((Family) => ({ Family, Score: crypto.createHash("sha256").update(`middleman-daily-v1:${Day}:${Family.id}`).digest("hex") }))
        .sort((A, B) => A.Score.localeCompare(B.Score))
        .map(({ Family }) => Family);
    return MIDDLEMAN_TIERS.slice(0, Families.length).map((Tier, Index) => {
        const Family = Families[Index];
        const CatalogId = `CELL_${Family.id}_${Tier.suffix}`;
        return {
            id: `middleman_daily_${CatalogId.toLowerCase()}`,
            displayName: Family.name.replace(/^\+1 /, `+${Tier.level} `),
            displayDescription: "Purchase one cell with Platinum or Aetherdust.",
            displayPriority: Index,
            prices: [{ currencyId: "id_currency_platinum", price: Tier.platinum }, { currencyId: "CURRENCY_CELLDUST", price: Tier.dust }],
            maxAllowed: null,
            availableFrom: new Date(Start).toISOString(),
            availableTo: new Date(Start + MIDDLEMAN_DAY_MS).toISOString(),
            tags: ["weekly_cell_offering"],
            items: [{ catalogId: CatalogId, quantity: 1, instanced: false }],
            duplicateInstancedItems: [],
        };
    });
}
// [2026-10-19] Aetherdust -> Rams exchange, a fourth Middleman tile on the same daily rotation. Once per rotation day:
// the ownership key carries the day, so a second buy replays the first instead of charging again.
// ponytail: the tile UI was built for cells; if the client will not render a CURRENCY_NOTES tile, move this SKU to
// another store tag the client already lists.
const RAMS_EXCHANGE_DUST = 150, RAMS_EXCHANGE_RAMS = 1500;
export function RamsExchangeSku(NowMs = Date.now()): StoreSku {
    const Day = Math.floor((NowMs - MIDDLEMAN_ROTATION_EPOCH) / MIDDLEMAN_DAY_MS);
    const Start = MIDDLEMAN_ROTATION_EPOCH + Day * MIDDLEMAN_DAY_MS;
    return {
        id: "middleman_daily_rams_exchange",
        displayName: `${RAMS_EXCHANGE_RAMS} Rams`,
        displayDescription: `Trade ${RAMS_EXCHANGE_DUST} Aetherdust for ${RAMS_EXCHANGE_RAMS} Rams. Once a day.`,
        displayPriority: MIDDLEMAN_TIERS.length,
        prices: [{ currencyId: "CURRENCY_CELLDUST", price: RAMS_EXCHANGE_DUST }],
        maxAllowed: 1,
        ownershipKey: `middleman_daily_rams_exchange:${Day}`,
        availableFrom: new Date(Start).toISOString(),
        availableTo: new Date(Start + MIDDLEMAN_DAY_MS).toISOString(),
        tags: ["weekly_cell_offering"],
        items: [{ catalogId: "CURRENCY_NOTES", quantity: RAMS_EXCHANGE_RAMS, instanced: false }],
        duplicateInstancedItems: [],
    };
}
// [1.14.7 2026-10-25] Dr. Priyani's Research Lab = the Gauntlet store (tag `gauntlet_store`, tabs from the client's
// gauntlet_store_view_model: gauntlet_store_tab_{progress,trackers,cells,misc,lastchance}). SKU ids are the client's
// StoreItemsTable rows; items and the 1 Crest price per the fandom wiki (Gauntlet#Research_Lab). Server choice: every
// season's cells are on sale from the start, so the Last Chance (_lc, Crumbling Crest) rows are not served.
// ponytail: the two consumable bundles (sku_gauntlet_s1_consumables_a/b) are left out, their contents are unknown.
const GAUNTLET_TRACKERS: [string, string, string][] = [
    ["sku_part_wt_gatherables", "PART_WT_GATHERABLES", "Gatherables"],
    ["sku_part_wt_dodges", "PART_WT_DODGES", "Dodges"],
    ["sku_part_wt_damage", "PART_WT_DAMAGE", "Damage Dealt"],
    ["sku_wt_revives", "PART_WT_REVIVES", "Players Revived"],
    ["sku_part_wt_wounds", "PART_WT_WOUNDS", "Wounds"],
    ["sku_part_wt_interrupts", "PART_WT_INTERRUPTS", "Interrupts"],
    ["sku_part_wt_kills", "PART_WT_KILLS", "Behemoth Slain"],
    ["sku_part_wt_staggers", "PART_WT_STAGGERS", "Staggers"],
    ["sku_part_wt_fauna", "PART_WT_FAUNA", "Fauna Slain"],
    ["sku_part_wt_downed", "PART_WT_DOWNED", "Time Downed"],
    ["sku_part_wt_parts", "PART_WT_PARTS", "Parts Broken"],
    ["sku_part_wt_gauntlet_levels_unique", "PART_WT_GAUNTLET_LEVELS_UNIQUE", "Unique Gauntlet Level Completed"],
    ["sku_part_wt_events", "PART_WT_EVENTS", "Island Events Completed"],
    ["sku_part_wt_bighit", "PART_WT_BIGHIT", "Biggest Hit"],
    ["sku_part_wt_hesca_count", "PART_WT_HESCA_COUNT", "Heroic Escalations Completed"],
    ["sku_part_wt_chests", "PART_WT_CHESTS", "Patrol Chests Opened"],
    ["sku_part_wt_longest_glide", "PART_WT_LONGEST_GLIDE", "Longest Glide"],
    ["sku_part_wt_shortest_hesca", "PART_WT_SHORTEST_HESCA", "Fastest Heroic Escalation Completion"],
    ["sku_part_wt_shortest_trial", "PART_WT_SHORTEST_TRIAL", "Fastest Dauntless Trial Completion"],
    // The client rows' art is wrong for these two (pets shows the hesca icon), so the tracker icon is sent explicitly.
    ["sku_part_wt_pets", "PART_WT_DOGS_PET", "Dogs Pet"],
    ["sku_part_wt_pets_duplicated", "PART_WT_RAMS_HEADBUTTED", "Rams Headbutted"],
];
const GAUNTLET_TRACKER_ICONS: Record<string, string> = {
    PART_WT_DOGS_PET: "Engine.Texture2D'/Game/UI/Textures/Icons/trackers/ico_part_wt_dog.ico_part_wt_dog'",
    PART_WT_RAMS_HEADBUTTED: "Engine.Texture2D'/Game/UI/Textures/Icons/trackers/ico_part_wt_rams3.ico_part_wt_rams3'",
};
// Seasons 1-5 in order; each cell's season matched by its cell type (client row icon) against the wiki's season tables.
const GAUNTLET_CELLS: [string, string, string][] = [
    ["sku_gauntlet_cell_dodge_stagger_uc", "CELL_DODGE_STAGGER_UC", "Stop"],
    ["sku_gauntlet_min_stam_uc", "CELL_MIN_STAM_UC", "Drop"],
    ["sku_gauntlet_stagger_free_dodge_uc", "CELL_STAGGER_FREE_DODGE_UC", "Roll"],
    ["sku_gauntlet_dmgup_atkspddown_uc", "CELL_DMGUP_ATKSPDDOWN_UC", "Reduce"],
    ["sku_gauntlet_part_break_stkspd_up_uc", "CELL_PART_BREAK_ATKSPD_UP_UC", "Reuse"],   // row says stkspd, the cell is ATKSPD
    ["sku_gauntlet_same_part_dmg_up_uc", "CELL_SAME_PART_DMG_UP_UC", "Recycle"],
    ["sku_gauntlet_shield_detonation_uc", "CELL_SHIELD_DETONATION_UC", "Earth"],
    ["sku_gauntlet_ms_down_shield_up_uc", "CELL_MS_DOWN_SHIELD_UP_UC", "Water"],
    ["sku_gauntlet_atkspd_mvspd_selfharm_uc", "CELL_ATKSPD_MVSPD_SELFHARM_UC", "Fire"],
    ["sku_gauntlet_dodge_dr_uc", "CELL_DODGE_DR_UC", "Conservation"],
    ["sku_gauntlet_crit_damage_from_ms_uc", "CELL_CRIT_DAMAGE_FROM_MS_UC", "Impulse"],
    ["sku_gauntlet_crit_chance_while_sprint_uc", "CELL_CRIT_CHANCE_WHILE_SPRINT_UC", "Inertia"],
    ["sku_gauntlet_cell_near_fauna_ms_uc", "CELL_NEAR_FAUNA_MS_AS_UC", "Pack Walker"],
    ["sku_gauntlet_cell_kill_fauna_dmg_uc", "CELL_KILL_FAUNA_DMG_UC", "Pack Hunter"],
    ["sku_gauntlet_cell_break_summon_uc", "CELL_BREAK_SUMMON_FAUNA_UC", "Pack Caller"],
];
function GauntletStoreSkus(): StoreSku[] {
    const Sku = (Id: string, CatalogId: string, Name: string, Tab: string, Priority: number, Tracker: boolean): StoreSku => ({
        id: Id,
        displayName: Name,
        displayDescription: "",
        displayPriority: Priority,
        prices: [{ currencyId: "id_currency_gauntlet_coin", price: 1 }],
        maxAllowed: Tracker ? 1 : null,   // a tracker is a one-time weapon part; cells are repeatable
        ...(GAUNTLET_TRACKER_ICONS[CatalogId] ? { images: { standard: GAUNTLET_TRACKER_ICONS[CatalogId] } } : {}),
        tags: ["gauntlet_store", Tab],
        items: [{ catalogId: CatalogId, quantity: 1, instanced: Tracker }],
        duplicateInstancedItems: [],
    });
    return [
        ...GAUNTLET_TRACKERS.map(([Id, CatalogId, Name], I) => Sku(Id, CatalogId, `"${Name}" Tracker`, "gauntlet_store_tab_trackers", I, true)),
        ...GAUNTLET_CELLS.map(([Id, CatalogId, Name], I) => Sku(Id, CatalogId, `+1 ${Name} Cell`, "gauntlet_store_tab_cells", I, false)),
    ];
}

// [Revamped 2026-10-26] House-priced repeatable currency bundles: Aethersparks in the Reward Cache, Bounty Tokens in
// the Platinum store (Supplies tab, next to Patrol Keys). Ids are ours, art is the catalog icon.
function BundleSku(Id: string, Name: string, Description: string, CatalogId: string, Quantity: number, CurrencyId: string, Price: number, Icon: string, Tags: string[]): StoreSku {
    return {
        id: Id,
        displayName: `${Quantity} ${Name}`,
        displayDescription: Description,
        displayPriority: 1000 + Quantity,
        prices: [{ currencyId: CurrencyId, price: Price }],
        maxAllowed: null,
        images: { standard: `Engine.Texture2D'${Icon}'` },
        tags: Tags,
        items: [{ catalogId: CatalogId, quantity: Quantity, instanced: false }],
        duplicateInstancedItems: [],
    };
}
const AETHERSPARK_SKUS = ([[100, 2000], [500, 8000]] as const).map(([Quantity, Price]) => BundleSku(
    `rewardcache_aethersparks_${Quantity}`, "Aethersparks", "A bundle of Aethersparks.", "CURRENCY_PJM_PRESTIGE_EMPTY", Quantity,
    "id_currency_seasonal_coin", Price, "/Game/UI/Textures/SlayerPath/ui_icon_aether_shards.ui_icon_aether_shards",
    ["season_store", "season_store_general", "reward_cache_house"]));
const BOUNTY_TOKEN_SKUS = ([[5, 100], [14, 250], [32, 500]] as const).map(([Quantity, Price]) => BundleSku(
    `bundle_bountytokens_${Quantity}`, "Bounty Tokens", "Can be consumed to draft a new bounty.", "TOKEN_BOUNTY_DRAFT", Quantity,
    "id_currency_platinum", Price, "/Game/UI/Textures/HuntpassRewards/ui_hp_bounty_tokens.ui_hp_bounty_tokens",
    ["webstore", "supplies_supplies", "platinum_store_house"]));
// [Revamped 2026-10-27] Combat Merits sold in both stores: Platinum (webstore) and Cache Coins (Reward Cache).
const CombatMeritSkus = (IdPrefix: string, CurrencyId: string, Bundles: readonly (readonly [number, number])[], Tags: string[]) => Bundles.map(([Quantity, Price]) => BundleSku(
    `${IdPrefix}_combatmerits_${Quantity}`, "Combat Merits", "Spend on Combat nodes of the Slayer's Path.", "CURRENCY_PJM_WEAPON", Quantity,
    CurrencyId, Price, "/Game/UI/Textures/StoreImagesSquare/ui_combat_merits_currency_icon_store.ui_combat_merits_currency_icon_store", Tags));
const COMBAT_MERIT_PLATINUM_SKUS = CombatMeritSkus("bundle", "id_currency_platinum", [[250, 100], [1000, 350]], ["webstore", "supplies_supplies", "platinum_store_house"]);
const COMBAT_MERIT_CACHE_SKUS = CombatMeritSkus("rewardcache", "id_currency_seasonal_coin", [[250, 1500], [1000, 5000]], ["season_store", "season_store_general", "reward_cache_house"]);
// [Revamped 2026-10-29] Aetherdust sold in both stores, priced off the Middleman's +1 cell (50 Platinum or 40 dust).
const AetherdustSkus = (IdPrefix: string, CurrencyId: string, Bundles: readonly (readonly [number, number])[], Tags: string[]) => Bundles.map(([Quantity, Price]) => BundleSku(
    `${IdPrefix}_aetherdust_${Quantity}`, "Aetherdust", "Spend at the Middleman on cells and fusion.", "CURRENCY_CELLDUST", Quantity,
    CurrencyId, Price, "/Game/UI/Textures/Icons/Currencies/ui_icon_currency_aetherdust.ui_icon_currency_aetherdust", Tags));
const AETHERDUST_PLATINUM_SKUS = AetherdustSkus("bundle", "id_currency_platinum", [[100, 125], [500, 550]], ["webstore", "supplies_supplies", "platinum_store_house"]);
const AETHERDUST_CACHE_SKUS = AetherdustSkus("rewardcache", "id_currency_seasonal_coin", [[100, 1800], [500, 8000]], ["season_store", "season_store_general", "reward_cache_house"]);

// The client only shows season43's Elite; which pass it unlocks depends on the player (GetStoreSkus' servedSlot).
const HUNT_PASS_SKU_TAG = HuntPassPassSkuTag(SEASON_PASS_SLOT);
const HUNT_PASS_SKUS = { [HUNT_PASS_SKU_TAG]: HuntPassSkus(SEASON_PASS_SLOT) };
const EXCHANGE_SLOT_SKUS = { slot2: [ExchangeSlotSku(2)], slot3: [ExchangeSlotSku(3)] };

const STORE_SKUS: Record<string, StoreSku[]> = {
    ...HUNT_PASS_SKUS,
    exchange_vendor_slot_2: EXCHANGE_SLOT_SKUS.slot2,
    exchange_vendor_slot_3: EXCHANGE_SLOT_SKUS.slot3,
    ladyluckstore: LADYLUCK_SKUS,
    season_store: [...REWARD_CACHE_SKUS, ...AETHERSPARK_SKUS, ...COMBAT_MERIT_CACHE_SKUS, ...AETHERDUST_CACHE_SKUS],
    webstore: [...PlatinumSection("webstore"), ...BOUNTY_TOKEN_SKUS, ...COMBAT_MERIT_PLATINUM_SKUS, ...AETHERDUST_PLATINUM_SKUS],
    dyes: PlatinumSection("dyes"),
    hp_level_skip_rank: PlatinumSection("hp_level_skip_rank"),
    huntpass_store: PlatinumSection("huntpass_store"),
    gauntlet_store: GauntletStoreSkus(),
    get fountain_daily_free_bundle() { return [FountainDailySku()]; },   // rebuilt per read: the ownership key carries today's date
    get weekly_cell_offering() { return [...WeeklyCellSkus(), RamsExchangeSku()]; },   // rebuilt per read: rotates daily
};

// Store-service currency ids (id_currency_x) -> our wallet's catalog currency ids (CURRENCY_X).
// Verified: both CURRENCY_MARKS_GILDED/CURRENCY_MARKS_STEEL exist in our 1.12 catalog with real
// resolved display names ("Gilded Marks"/"Steel Marks"), and routes/store.ts's GET /balance already
// projects both naming forms for any wallet-persisted currency.
const CURRENCY_ID_MAP: Record<string, string> = {
    id_currency_marks_gilded: "CURRENCY_MARKS_GILDED",
    id_currency_marks_steel: "CURRENCY_MARKS_STEEL",
    id_currency_s19_coin: "CURRENCY_S19_COIN",
    // [1.14.7 2026-10-08] The Reward Cache is priced in the 1.14.7 seasonal coin (the HUD's blue-star "Cache Coins").
    id_currency_seasonal_coin: "CURRENCY_SEASONAL_COIN",
    id_currency_rewardcache: "CURRENCY_REWARDCACHE",
    id_currency_notes: "CURRENCY_NOTES",
    // [1.14.7 2026-10-25] Research Lab (gauntlet_store) price: Gauntlet Crests.
    id_currency_gauntlet_coin: "CURRENCY_GAUNTLET_COIN",
    // [2026-07-30] Platinum resolves to the AGGREGATE id; ApplyCurrencyDeltas splits the debit across
    // the real per-storefront buckets (platinumWallet.ts). Without this entry the fallback below
    // produced "ID_CURRENCY_PLATINUM", which fails the CURRENCY_ prefix test in ApplyCurrencyDeltas and
    // is then treated as a stacked ITEM removal - so a platinum SKU would have failed with a confusing
    // InsufficientStackedItemError (unmapped -> 500) instead of charging anything. It failed closed,
    // but it would have failed. See Progress/33_PLATINUM_STORE.md.
    id_currency_platinum: "CURRENCY_PLATINUM",
};

export function GetLadyLuckSkus(): StoreSku[] {
    return LADYLUCK_SKUS;
}

// servedSlot: the player's internal hunt pass slot, so the hunt pass Elite SKU is the one of the pass they are on.
export function GetStoreSkus(storeTag: string, servedSlot?: string): StoreSku[] {
    if (storeTag === HUNT_PASS_SKU_TAG && servedSlot) return HuntPassSkus(servedSlot);
    return STORE_SKUS[storeTag] ?? [];
}

export const IsHuntPassSkuTag = (storeTag: string) => storeTag === HUNT_PASS_SKU_TAG;

// [2026-07-24] GET /token/platinum/{id} ("Generate purchase token for any catalogId from shop") is
// captured taking a single path segment with no other context about which id-space it lives in. Our
// own SKU listing only ever hands the client a SKU `id` (e.g. "ladyluck_headbling_normal"), never a
// bare inventory catalogId, so that's the primary match; falling back to a per-item catalogId match
// covers a client that instead echoes back one of the `items[].catalogId` values from that listing.
export function FindLadyLuckSkuByIdOrCatalogId(idOrCatalogId: string): StoreSku | undefined {
    return (
        LADYLUCK_SKUS.find((s) => s.id === idOrCatalogId) ??
        LADYLUCK_SKUS.find((s) => s.items.some((i) => i.catalogId === idOrCatalogId))
    );
}

export type LocatedStoreSku = { storeTag: string; sku: StoreSku };

export function FindStoreSkuByIdOrCatalogId(idOrCatalogId: string): LocatedStoreSku | undefined {
    const Entries = Object.entries(STORE_SKUS);

    for (const [StoreTag, Skus] of Entries) {
        const Exact = Skus.find((Sku) => Sku.id === idOrCatalogId);
        if (Exact) return { storeTag: StoreTag, sku: Exact };
    }

    const CatalogMatches = Entries.flatMap(([StoreTag, Skus]) =>
        Skus
            .filter((Sku) => Sku.items.some((Item) => Item.catalogId === idOrCatalogId))
            .map((Sku) => ({ storeTag: StoreTag, sku: Sku }))
    );

    // One SKU registered under several section tags (a dye is in both `webstore` and `dyes`) is NOT
    // an ambiguous match - it is the same offer reachable from two sections. Collapse by SKU id
    // first, so only a genuine collision between different offers is refused.
    const DistinctSkuIds = new Set(CatalogMatches.map((Match) => Match.sku.id));

    // A bare catalogId has no store context in the token URL. Refuse a genuinely ambiguous match
    // rather than minting a token for whichever store happens to be first in the registry.
    return DistinctSkuIds.size === 1 ? CatalogMatches[0] : undefined;
}

// [2026-07-30] The deterministic transactionId for a one-time SKU must not depend on WHICH SECTION
// the player bought it from. The platinum data set is registered under four section tags, so a dye
// resolvable as both `webstore` and `dyes` would otherwise hash to two different transaction ids -
// and a one-time SKU whose ownership check IS its idempotency row could then be bought twice. Map
// every section of one store to a single stable scope. Lady Luck's and the Reward Cache's existing
// scope strings are preserved exactly so deployed idempotency rows keep matching.
const PLATINUM_SECTION_TAGS = ["webstore", "dyes", "hp_level_skip_rank", "huntpass_store"];

function TransactionScopeFor(storeTag: string): { transaction: string; instance: string } {
    if (storeTag === "ladyluckstore") {
        return { transaction: "ladyluck-purchase", instance: "ladyluck-purchase-instance" };
    }
    if (PLATINUM_SECTION_TAGS.includes(storeTag)) {
        return { transaction: "store-purchase:platinum", instance: "store-purchase-instance:platinum" };
    }
    return { transaction: `store-purchase:${storeTag}`, instance: `store-purchase-instance:${storeTag}` };
}

function OneTimeTransactionId(storeTag: string, userId: string, sku: StoreSku): string {
    const Scope = TransactionScopeFor(storeTag).transaction;
    return crypto.createHash("sha256").update(`${Scope}:${userId}:${sku.ownershipKey ?? sku.id}`).digest("hex").slice(0, 32).toUpperCase();
}

// A one-time SKU (its ownershipKey may carry the day) already bought by this character: the same ledger row
// PurchaseStoreSku replays instead of charging again.
export async function OneTimeSkuOwned(storeTag: string, userId: string, characterId: string, sku: StoreSku): Promise<boolean> {
    return GetRepositories().inventoryTransactions.isCompleted(OneTimeTransactionId(storeTag, userId, sku), userId, characterId);
}
export const FountainClaimedToday = (userId: string, characterId: string) =>
    OneTimeSkuOwned("fountain_daily_free_bundle", userId, characterId, FountainDailySku());

// Applies a SKU's `skuProgression` payload. Rank-skip SKUs name `selected_huntpass` and a rank
// count, which src/skuProgression.ts converts to an XP delta against the same rank curve
// controllers/progression.ts validates rank-confirm requests with. A no-op plan (unknown track,
// already at max rank, nothing to grant) is logged rather than silently ignored, because for a
// PAID SKU "granted nothing" is a fact worth having in the log next to the debit.
class NothingToGrantError extends Error {
    constructor(skuId: string) {
        super(`sku ${skuId} would grant nothing`);
    }
}

async function GrantSkuProgressionInTransaction(repos: RepositoryProvider, userId: string, sku: StoreSku, session: ClientSession): Promise<void> {
    if (sku.skuProgression == undefined) return;

    const RawTrackId = sku.skuProgression.progressionId;
    // "selected_huntpass" means the slot this player is on; hunt pass progress is stored per pass (ProgressionStorageId).
    const ServedSlot = await GetServedSlotForUser(userId, repos);
    const Resolve = (Id: string) => ResolveProgressionTrackId(Id, ServedSlot);
    const TrackId = typeof RawTrackId === "string" ? Resolve(RawTrackId) : undefined;
    const Existing = TrackId ? await repos.progressionTracks.get(userId, ProgressionStorageId(TrackId), session) : undefined;

    const Plan = ResolveProgressionGrant(
        sku.skuProgression,
        Existing?.progress ?? 0,
        Resolve,
        GetTrackCurve
    );

    if (Plan.kind === "none") {
        logger.warn(`[StoreProgression] ${userId} sku=${sku.id} granted no progression (${Plan.reason}, requested track=${RawTrackId} xp=${sku.skuProgression.xp} ranks=${sku.skuProgression.ranks})`);
        // [Revamped 2026-10-28] A SKU that is only progression (rank skips) must not charge for nothing, e.g. at
        // max rank: throwing rolls the debit back. SKUs with items or entitlements still go through.
        if ((sku.items?.length ?? 0) === 0 && (sku.entitlements?.length ?? 0) === 0) throw new NothingToGrantError(sku.id);
        return;
    }

    const After = await repos.progressionTracks.increment(userId, ProgressionStorageId(Plan.progressionId), Plan.xp, session);
    if (Plan.kind === "ranks") {
        logger.info(`[StoreProgression] ${userId} sku=${sku.id} track=${Plan.progressionId} rank ${Plan.fromRank}->${Plan.toRank} (+${Plan.xp} xp, total ${After.progress})`);
    } else {
        logger.info(`[StoreProgression] ${userId} sku=${sku.id} track=${Plan.progressionId} +${Plan.xp} xp (total ${After.progress})`);
    }
}

export type PurchaseResult =
    | { ok: true; result: any }
    | { ok: false; reason: "unknown_sku" | "unknown_currency" | "insufficient_balance" | "conflict" | "already_purchased_different_request" | "transaction_failed" | "nothing_to_grant" };

// The client's currency path segment (/token/{currency}/{sku}): a price's currencyId without `id_currency_` and underscores.
export const CurrencySlug = (CurrencyId: string) => CurrencyId.replace(/^id_currency_/, "").replace(/_/g, "");
// The Middleman sends the price's raw currencyId instead of the slug (/token/id_currency_platinum/...), so accept both.
export const PricesForCurrency = (Sku: StoreSku, Currency?: string) => Sku.prices.length > 1
    ? Sku.prices.filter((p) => p.currencyId === Currency || CurrencySlug(p.currencyId) === Currency)
    : Sku.prices;

// [2026-07-24] Confirmed real purchase flow (see routes/store.ts's /token/platinum and
// /notification/platinum handlers): the client never calls a skuId-in-path/characterId-in-body
// purchase route directly (that was an earlier, wrong guess - removed). It mints a short-lived
// purchase token via GET /token/platinum/{id}, then redeems it via POST /notification/platinum?token=.
// This function is the actual purchase execution, called from the redeem step once the token's
// (userId, characterId, skuId) claims are decoded - built on the same atomic machinery as before
// (RunInventoryTransaction's idempotency ledger + the wallet's overspend guard).
export async function PurchaseStoreSku(userId: string, characterId: string, storeTag: string, skuId: string, characterBindingValidated = false, currency?: string): Promise<PurchaseResult> {
    const ServedSlot = IsHuntPassSkuTag(storeTag) ? await GetServedSlotForUser(userId) : undefined;
    const Sku = GetStoreSkus(storeTag, ServedSlot).find((s) => s.id === skuId);
    if (!Sku) {
        return { ok: false, reason: "unknown_sku" };
    }
    // A SKU priced in several currencies (Middleman cells: Platinum or Aetherdust) is paid in the one the player chose.
    const Prices = PricesForCurrency(Sku, currency);
    if (Prices.length === 0) {
        return { ok: false, reason: "unknown_currency" };
    }

    // One-time SKUs (maxAllowed===1, the overwhelming majority - cosmetics/weapons/champion gear) get
    // a DETERMINISTIC transactionId keyed on (userId, skuId). This reuses RunInventoryTransaction's
    // existing idempotency ledger as the ownership check itself: a genuine repeat purchase attempt
    // hits the same transactionId and replays the stored result (same body -> same hash) rather than
    // re-charging or re-granting - no separate "already owns this" query needed. Repeatable SKUs
    // (maxAllowed===null - Cell Cores, Tonic Packs) get a fresh id per call so each purchase applies
    // as its own transaction.
    const IsOneTime = Sku.maxAllowed === 1;
    // Preserve Lady Luck's deployed transaction/instance identities exactly. Other stores include the
    // store scope so an identical SKU id in two stores cannot share an idempotency key, while every
    // section of the SAME store shares one scope - see TransactionScopeFor.
    const { transaction: TransactionScope, instance: InstanceScope } = TransactionScopeFor(storeTag);
    const TransactionId = IsOneTime
        ? OneTimeTransactionId(storeTag, userId, Sku)
        : crypto.randomBytes(16).toString("hex").toUpperCase();

    const StackedItemsToRemove = Prices.filter((p) => p.price > 0).map((p) => ({
        catalogId: CURRENCY_ID_MAP[p.currencyId] ?? p.currencyId.toUpperCase(),
        quantity: p.price,
    }));

    const InstancedItemsToAdd: any[] = [];
    const StackedItemsToAdd: any[] = [];
    for (const item of Sku.items) {
        if (item.instanced) {
            // Deterministic per (userId, skuId, catalogId, index) - a replayed purchase transaction
            // must construct the IDENTICAL instanced-item list, or RunInventoryTransaction's
            // requestHash binding would reject it as a mismatched replay instead of returning the
            // original result.
            for (let i = 0; i < item.quantity; i++) {
                const InstanceId = crypto
                    .createHash("sha256")
                    .update(`${InstanceScope}:${userId}:${skuId}:${item.catalogId}:${i}`)
                    .digest("hex")
                    .slice(0, 26)
                    .toUpperCase();
                InstancedItemsToAdd.push({ catalogId: item.catalogId, instanceId: InstanceId, itemData: null, updateVersion: 0 });
            }
        } else {
            StackedItemsToAdd.push({ catalogId: item.catalogId, quantity: item.quantity });
        }
    }

    // [2026-07-30] Entitlement and progression payloads are applied inside the SAME Mongo
    // transaction as the currency debit, via RunInventoryTransaction's onGrant hook - so an
    // entitlement that fails to persist rolls the charge back with it, and a purchase can never
    // debit platinum while granting nothing (the exact failure mode a store built only on `items`
    // would have had for every rank skip and Elite track SKU).
    const HasNonInventoryGrants = (Sku.entitlements?.length ?? 0) > 0 || Sku.skuProgression != undefined;
    const OnGrant = HasNonInventoryGrants
        ? async (Repos: RepositoryProvider, Session: ClientSession) => {
            await GrantEntitlementsInTransaction(Repos, userId, Sku.entitlements ?? [], Sku.id, Session);
            await GrantSkuProgressionInTransaction(Repos, userId, Sku, Session);
        }
        : undefined;

    try {
        const Result = await RunInventoryTransaction(
            userId,
            characterId,
            TransactionId,
            InstancedItemsToAdd,
            StackedItemsToAdd,
            [],
            StackedItemsToRemove,
            [],
            {
                ownershipAlreadyValidated: characterBindingValidated,
                diagnosticLabel: `store:${storeTag}:${skuId}`,
                onGrant: OnGrant,
            }
        );
        if (!Result) {
            return { ok: false, reason: "transaction_failed" };
        }
        logger.info(`[Store:${storeTag}] ${userId} purchased ${skuId} (transactionId=${TransactionId})`);
        return { ok: true, result: Result };
    } catch (Err) {
        if (Err instanceof InsufficientBalanceError) {
            return { ok: false, reason: "insufficient_balance" };
        }
        if (Err instanceof InventoryTransactionConflictError) {
            return { ok: false, reason: "conflict" };
        }
        if (Err instanceof InventoryTransactionMismatchError) {
            return { ok: false, reason: "already_purchased_different_request" };
        }
        if (Err instanceof NothingToGrantError) {
            return { ok: false, reason: "nothing_to_grant" };
        }
        throw Err;
    }
}

// Compatibility wrapper for existing imports/tests and any in-flight work based on the Lady Luck
// controller name. The generic implementation preserves Lady Luck's old transaction identities.
export async function PurchaseLadyLuckSku(userId: string, characterId: string, skuId: string): Promise<PurchaseResult> {
    return PurchaseStoreSku(userId, characterId, "ladyluckstore", skuId);
}

export async function GetNotesForUser(userId: string){
    if(userId === undefined || userId === "" || userId === "INVALID"){
        return 0;
    }

    // Ensure the account (users) row exists for the record.
    let UserFromDb = await GetRepositories().accounts.findByUserId(userId);

    if(UserFromDb === undefined){
        await GetRepositories().accounts.create({
            userId,
            name: userId,
            notes: 0
        });
    }

    // Rams (CURRENCY_NOTES) now lives in the wallet (single source of truth for all currency).
    return await GetBalance(userId, "CURRENCY_NOTES");
}
