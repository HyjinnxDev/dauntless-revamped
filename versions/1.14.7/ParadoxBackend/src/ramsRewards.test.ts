import assert from "node:assert/strict";
import test from "node:test";
import { ApplyRamsRewards, NoteRemovedBounties, UpgradeCoreCells } from "./ramsRewards";
import { GetStoreSkus, RamsExchangeSku } from "./controllers/store";

const Core = [{ catalogId: "CONTAINER_CORE_REWARD_DAILY_01", quantity: 1 }];
const Of = (Items: any[], Id: string) => Items.filter((Item) => Item.catalogId === Id);
const Rams = (Items: any[]) => Of(Items, "CURRENCY_NOTES").map((Item) => Item.quantity);

test("fountain core keys are game roll +2 (clamped 4-6) as one stack; other grants untouched", () => {
    const Add = [{ catalogId: "TOKEN_DAILY_PATROL_BONUS_PURCHASED", quantity: 1 }, { catalogId: "TOKEN_DAILY_PATROL_BONUS_PURCHASED", quantity: 2 }, { catalogId: "CURRENCY_NOTES", quantity: 100 }];
    assert.deepEqual(Of(ApplyRamsRewards("u", "t", Add, Core, undefined), "TOKEN_DAILY_PATROL_BONUS_PURCHASED"), [{ catalogId: "TOKEN_DAILY_PATROL_BONUS_PURCHASED", quantity: 5 }]);
    const KeysFor = (Game: number) => Of(ApplyRamsRewards("u", "t", [{ catalogId: "TOKEN_DAILY_PATROL_BONUS_PURCHASED", quantity: Game }], Core, undefined), "TOKEN_DAILY_PATROL_BONUS_PURCHASED")[0].quantity;
    assert.deepEqual([KeysFor(1), KeysFor(3), KeysFor(4), KeysFor(9)], [4, 5, 6, 6]);
    assert.deepEqual(Rams(ApplyRamsRewards("u", "t", Add, Core, undefined)), [100]);
    assert.deepEqual(Of(ApplyRamsRewards("u", "t", Add, Core, undefined), "CURRENCY_PLATINUM_UNIV"), [{ catalogId: "CURRENCY_PLATINUM_UNIV", quantity: 20 }]);
    const Keys = [{ catalogId: "TOKEN_DAILY_PATROL_BONUS_PURCHASED", quantity: 3 }];
    assert.equal(ApplyRamsRewards("u", "t", Keys, [], "Store"), Keys);
});

test("kill and patrol chest Rams remap onto 200-750 and 1500-5000, +5% per extra party member", () => {
    const Kill = (Q: number, Party = 1) => Rams(ApplyRamsRewards("u", "t", [{ catalogId: "CURRENCY_NOTES", quantity: Q }], [], "PlayerLoot", Party))[0];
    assert.deepEqual([Kill(80), Kill(145), Kill(260), Kill(560), Kill(2000)], [200, 200, 350, 750, 750]);
    assert.deepEqual([Kill(560, 2), Kill(560, 3), Kill(560, 4), Kill(560, 8), Kill(560, 0)], [790, 825, 865, 865, 750]);
    const Chest = (Q: number, Party = 1) => Rams(ApplyRamsRewards("u", "t", [{ catalogId: "CURRENCY_NOTES", quantity: Q }], [], "patrol_chest", Party))[0];
    assert.deepEqual([Chest(625), Chest(1175), Chest(3750), Chest(9000), Chest(3750, 4)], [1500, 2125, 5000, 5000, 5750]);
    assert.deepEqual(Rams(ApplyRamsRewards("u", "t", [{ catalogId: "CURRENCY_NOTES", quantity: 125 }], [], "Core Opener", 4)), [125]);
});

test("gathering pays a small amount of Rams per node", () => {
    const Gather = (Source: string) => Rams(ApplyRamsRewards("u", "t", [{ catalogId: "MAT_X", quantity: 1 }], [], Source));
    assert.deepEqual([Gather("BUNDLE_GATHER_COMMON_01"), Gather("BUNDLE_GATHER_PYLON_01"), Gather("BUNDLE_GATHER_SPECIAL_01"), Gather("BUNDLE_GATHER_CHEST_01")], [[10], [10], [25], [25]]);
});

test("base bounty claim pays by the tier of the bounty just removed, once", () => {
    const Claim = (User: string, Now: number) => Rams(ApplyRamsRewards(User, "t", [{ catalogId: "CURRENCY_PRESTIGE", quantity: 5 }], [], "UBountyComponent::OnClaimBountyComplete", 1, Math.random, Now));
    NoteRemovedBounties("a", ["Bounty_Bronze_KillShockWeapon"], 0);
    NoteRemovedBounties("b", ["Bounty_Silver_StaggerEnraged"], 0);
    NoteRemovedBounties("c", ["Bounty_Gold_Interrupts"], 0);
    assert.deepEqual([Claim("a", 75), Claim("b", 75), Claim("c", 75)], [[250], [400], [600]]);
    NoteRemovedBounties("e", ["Bounty_Gold_Interrupts"], 0);
    assert.deepEqual(Of(ApplyRamsRewards("e", "t", [], [], "UBountyComponent::OnClaimBountyComplete", 1, Math.random, 75), "CURRENCY_PLATINUM_UNIV"), [{ catalogId: "CURRENCY_PLATINUM_UNIV", quantity: 6 }]);
    assert.deepEqual(Claim("a", 80), []);              // consumed
    NoteRemovedBounties("d", ["Bounty_Gold_Interrupts"], 0);
    assert.deepEqual(Claim("d", 60_000), []);          // abandon long ago, not this claim's
});

test("Middleman lists a once-a-day dust -> Rams exchange keyed on the rotation day", () => {
    const Sku = GetStoreSkus("weekly_cell_offering").find((S) => S.id === "middleman_daily_rams_exchange");
    assert.deepEqual(Sku?.prices, [{ currencyId: "CURRENCY_CELLDUST", price: 150 }]);
    assert.deepEqual(Sku?.items, [{ catalogId: "CURRENCY_NOTES", quantity: 1500, instanced: false }]);
    const Reset = Date.UTC(2026, 9, 19, 18);
    assert.equal(RamsExchangeSku(Reset).ownershipKey, RamsExchangeSku(Reset + 86_399_000).ownershipKey);
    assert.notEqual(RamsExchangeSku(Reset).ownershipKey, RamsExchangeSku(Reset + 86_400_000).ownershipKey);
});

test("cell cores swap one +1 cell for +2/+3 per upgraded core; cell count and other grants unchanged", () => {
    const Add = [{ catalogId: "CELL_A_UC", quantity: 2 }, { catalogId: "CELL_B_UC", quantity: 1 }, { catalogId: "CURRENCY_NOTES", quantity: 50 }];
    const Open = (Core: string, Rolls: number[], Quantity = 1) => {
        let i = 0;
        return UpgradeCoreCells(Add, [{ catalogId: Core, quantity: Quantity }], () => Rolls[i++ % Rolls.length]);
    };
    // Rare: always upgrades; roll 0.5 -> +2, cell pick 0 -> CELL_A
    assert.deepEqual(Open("CONTAINER_CORE_GOLD_CELLCORE", [0.5, 0.5, 0]), [{ catalogId: "CELL_A_UC", quantity: 1 }, { catalogId: "CELL_B_UC", quantity: 1 }, { catalogId: "CURRENCY_NOTES", quantity: 50 }, { catalogId: "CELL_A_R", quantity: 1 }]);
    // Rare 1% epic; pick 0.9 -> CELL_B, whose emptied +1 stack is dropped
    assert.deepEqual(Open("CONTAINER_CORE_GOLD_CELLCORE", [0.5, 0.005, 0.9]), [{ catalogId: "CELL_A_UC", quantity: 2 }, { catalogId: "CURRENCY_NOTES", quantity: 50 }, { catalogId: "CELL_B_E", quantity: 1 }]);
    // Uncommon 10%, Common 1%, never +3
    assert.equal(Open("CONTAINER_CORE_SILVER_CELLCORE", [0.1]), Add);
    assert.deepEqual(Of(Open("CONTAINER_CORE_SILVER_CELLCORE", [0.099, 0, 0]), "CELL_A_R"), [{ catalogId: "CELL_A_R", quantity: 1 }]);
    assert.equal(Open("CONTAINER_CORE_BRONZE_CELLCORE", [0.01]), Add);
    assert.deepEqual(Of(Open("CONTAINER_CORE_BRONZE_CELLCORE", [0.009, 0, 0]), "CELL_A_R"), [{ catalogId: "CELL_A_R", quantity: 1 }]);
    // Two rare cores in one request upgrade two cells; never more upgrades than +1 cells granted
    assert.deepEqual(Of(Open("CONTAINER_CORE_GOLD_CELLCORE", [0.5, 0.5, 0], 2), "CELL_A_R"), [{ catalogId: "CELL_A_R", quantity: 2 }]);
    assert.equal(Open("CONTAINER_CORE_GOLD_CELLCORE", [0.5, 0.5, 0], 9).filter((Item) => /^CELL_/.test(Item.catalogId)).reduce((S, I) => S + I.quantity, 0), 3);
    // Not a cell core: untouched
    assert.equal(UpgradeCoreCells(Add, [{ catalogId: "CONTAINER_CORE_REWARD_DAILY_01", quantity: 1 }]), Add);
});

test("cell core roll is seeded from the game's cells, so the client popup (MpCellCorePopupFix) can replay it", () => {
    // Real gold core open 2026-10-25; the DLL's FNV-1a + mulberry32 must give the same answer.
    const Add = ["CELL_SHIELDS_HIT_ABSORB_UC", "CELL_CRIT_CHANCE_UC", "CELL_LANTERN_TAP_EFFECTIVENESS_UC", "CELL_PART_BREAK_ATKSPD_UP_UC"]
        .map((catalogId) => ({ catalogId, quantity: 1 })).concat({ catalogId: "CURRENCY_CELLDUST", quantity: 6 });
    const Out = ApplyRamsRewards("u", "t", Add, [{ catalogId: "CONTAINER_CORE_GOLD_CELLCORE", quantity: 1 }], "Core Opener");
    assert.deepEqual(Of(Out, "CELL_LANTERN_TAP_EFFECTIVENESS_R"), [{ catalogId: "CELL_LANTERN_TAP_EFFECTIVENESS_R", quantity: 1 }]);
    assert.deepEqual(ApplyRamsRewards("u", "t", Add, [{ catalogId: "CONTAINER_CORE_GOLD_CELLCORE", quantity: 1 }], "Core Opener"), Out);
});
