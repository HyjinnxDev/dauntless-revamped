import { RemoveTestDb } from "./setup";
import "./authenv";
import { after, before, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { GetDb } from "../src/db";
import { entitlements, inventory, huntcompletions } from "../src/db/schema";
import { Call, StartApp, StopApp } from "./appclient";
import { MakePlayer, StackQuantity, Count } from "./helpers";
import { CreateCharacterForUid } from "../src/controllers/character";
import { GrantEntitlementInTx, ListEntitlements } from "../src/controllers/entitlements";
import { CreateStorePurchase, RedeemStorePurchase, ListStoreOffers, GetStoreOffer } from "../src/controllers/freestore";
import { GetConfiguredPath, GetHuntPassScope } from "../src/controllers/progressionconfig";
import { ConfirmRank, GetTrackRecord, GrantProgressionInTrack, SetSelectedHuntPass } from "../src/controllers/realprogression";
import { ReadHuntCompletion, PLATINUM_ITEM } from "../src/controllers/huntplatinum";
import { SelectHuntPassSeason } from "../src/controllers/huntpassseason";

const Session = "00000000-0000-0000-0000-000000000001";
const Pass = "season09b_premium";
let CompletionCounter = 0;
before(async () => { await StartApp(); });
beforeEach(() => { process.env.STORE = "earned"; delete process.env.ENTITLEMENTS_DEFAULT; });
after(async () => { await StopApp(); RemoveTestDb(() => GetDb().$client.close()); });

function Credit(CharacterId: string, Quantity: number){
    GetDb().insert(inventory).values({characterId: CharacterId, stackedItems: JSON.stringify([{catalogId: PLATINUM_ITEM, quantity: Quantity}]), instancedItems: "[]"})
        .onConflictDoUpdate({target: inventory.characterId, set: {stackedItems: JSON.stringify([{catalogId: PLATINUM_ITEM, quantity: Quantity}])}}).run();
}

const Proof = (Players: string[], Hunt = "Pursuit_Shrike", Id = `${Session}:${++CompletionCounter}`) => ({id: Id, hunt: Hunt, players: Players});
async function Complete(A: {UserId: string, CharacterId: string}, Completion = Proof([A.UserId]), TransactionId = `hunt-${A.UserId}-${Completion.id}`, AsGameserver = true){
    return Call("POST", "/inventory", {gs: AsGameserver, as: AsGameserver ? undefined : A.UserId,
        headers: {"x-dauntless-game-session-id": Session, "x-dauntless-hunt-completion": JSON.stringify(Completion)},
        body: {accountId: A.UserId, characterId: A.CharacterId, transactionId: TransactionId, addStackedItems: [{catalogId: "CURRENCY_NOTES", quantity: 1}]}});
}

it("unlimited distinct successful hunts pay 10 and return actual platinum balance", async () => {
    const A = await MakePlayer();
    for(let Index = 0; Index < 100; Index++){
        const Reply = await Complete(A);
        assert.equal(Reply.status, 200);
        assert.equal(Reply.json.updatedStackedItems.find((Item: any) => Item.catalogId === PLATINUM_ITEM).quantity, (Index + 1) * 10);
    }
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 1000);
    assert.equal(Count("huntcompletions", "accountId = ?", A.UserId), 100);
    const Balance = await Call("GET", "/balance", {as: A.UserId});
    assert.equal(Balance.status, 200);
    assert.equal(Balance.json.id_currency_platinum, 1000);
    assert.equal(Balance.json.CURRENCY_PLATINUM, 1000);
    RedeemStorePurchase(A.UserId, "platinum", CreateStorePurchase(A.UserId, "platinum", Pass).purchaseToken);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 50, "Elite funded entirely by hunt earnings");
});

it("retries with same or different inventory IDs, including another character, pay once", async () => {
    const A = await MakePlayer(), Completion = Proof([A.UserId]);
    const Replies = await Promise.all([Complete(A, Completion), Complete(A, Completion), Complete(A, Completion, "different-tx")]);
    assert.ok(Replies.every((Reply) => Reply.status === 200));
    const Other = await CreateCharacterForUid(A.UserId, "Other");
    assert.equal((await Complete({UserId: A.UserId, CharacterId: Other.id}, Completion, "other-character")).status, 200);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 10);
    assert.equal(StackQuantity(Other.id, PLATINUM_ITEM), 0);
    assert.equal(Count("huntcompletions", "accountId = ?", A.UserId), 1);
});

it("Escalation pays 30 once for run and each participating account gets own payout", async () => {
    const A = await MakePlayer(), B = await MakePlayer();
    const Completion = Proof([A.UserId, B.UserId], "Esca_MatchmakerHunt_Shock_Hard");
    assert.equal((await Complete(A, Completion)).status, 200);
    assert.equal((await Complete(B, Completion)).status, 200);
    await Complete(A, Completion, "another-stage");
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 30);
    assert.equal(StackQuantity(B.CharacterId, PLATINUM_ITEM), 30);
});

it("player headers, unknown participants, training and malformed proof cannot award", async () => {
    const A = await MakePlayer();
    assert.equal((await Complete(A, Proof([A.UserId]), "client-forgery", false)).status, 403);
    await Complete(A, Proof(["unrelated-player"]));
    await Complete(A, Proof([A.UserId], "Training_Grounds"));
    await Complete(A, {...Proof([A.UserId]), id: "invalid"});
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 0);
    assert.equal(ReadHuntCompletion('{"id":null}'), undefined);
    assert.equal(ReadHuntCompletion("not JSON"), undefined);
});

it("inventory failure rolls completion receipt and platinum back", async () => {
    const A = await MakePlayer(), B = await MakePlayer(), Completion = Proof([A.UserId]);
    assert.equal((await Complete({UserId: A.UserId, CharacterId: B.CharacterId}, Completion)).status, 403);
    assert.equal(Count("huntcompletions", "accountId = ?", A.UserId), 0);
    assert.equal((await Complete(A, Completion)).status, 200);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 10);
});

it("failed inventory write after receipt reservation rolls back and can be retried", async () => {
    const A = await MakePlayer(), Completion = Proof([A.UserId]);
    Credit(A.CharacterId, 0);
    GetDb().update(inventory).set({stackedItems: "{"}).where(eq(inventory.characterId, A.CharacterId)).run();
    assert.equal((await Complete(A, Completion)).status, 500);
    assert.equal(Count("huntcompletions", "accountId = ?", A.UserId), 0);
    GetDb().update(inventory).set({stackedItems: "[]"}).where(eq(inventory.characterId, A.CharacterId)).run();
    assert.equal((await Complete(A, Completion)).status, 200);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 10);
});

it("Basic starts free, old seeded Elite is revoked, and pass requires 950", async () => {
    const A = await MakePlayer();
    GetDb().insert(entitlements).values({accountId: A.UserId, name: Pass, source: "default", duration: 0,
        activatedDate: new Date().toISOString(), grantedDate: new Date().toISOString()}).run();
    assert.deepEqual(ListEntitlements(A.UserId).map((Row) => Row.name), ["season_free_any"]);
    assert.ok(GetDb().select().from(entitlements).where(eq(entitlements.accountId, A.UserId)).all().find((Row) => Row.name === Pass)?.revokedDate);
    assert.equal(GetStoreOffer(A.UserId, Pass).platinumPrice, 950);
    assert.throws(() => CreateStorePurchase(A.UserId, "platinum", Pass), {Status: 409});
    Credit(A.CharacterId, 1000);
    const First = CreateStorePurchase(A.UserId, "id_currency_platinum", Pass).purchaseToken;
    const Second = CreateStorePurchase(A.UserId, "platinum", Pass).purchaseToken;
    RedeemStorePurchase(A.UserId, "platinum", First);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 50);
    assert.ok(ListEntitlements(A.UserId).some((Row) => Row.name === "season_premium_any"));
    RedeemStorePurchase(A.UserId, "platinum", First);
    assert.throws(() => RedeemStorePurchase(A.UserId, "platinum", Second), {Status: 409});
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 50);
});

it("pass purchase preserves earned XP, allows Elite catch-up, and confirm never pays inventory", async () => {
    const A = await MakePlayer();
    GrantProgressionInTrack(A.UserId, "season09b", "5000", "gameserver");
    assert.equal(ConfirmRank(A.UserId, "season09b", "50", "premium", "gameserver").Status, 403);
    Credit(A.CharacterId, 950);
    RedeemStorePurchase(A.UserId, "platinum", CreateStorePurchase(A.UserId, "platinum", Pass).purchaseToken);
    assert.equal(GetTrackRecord(A.UserId, "season09b")?.progress, 5000);
    assert.equal(GetTrackRecord(A.UserId, "season09b")?.confirmed_premium_rank, 0);
    assert.equal(ConfirmRank(A.UserId, "season09b", "50", "premium", "gameserver").Status, 200);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 0);
    await Complete(A);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 10);
});

it("ordinary shop has reviewed prices and pass items/bundles cannot be listed or bought", async () => {
    const A = await MakePlayer();
    const Offers = ListStoreOffers(A.UserId, "webstore");
    assert.ok(Offers.length > 0);
    assert.ok(!Offers.some((Offer) => Offer.items?.some((Item) => /_HP\d\d/i.test(Item.catalogId))));
    assert.throws(() => GetStoreOffer(A.UserId, "bundle_armour_monk"), {Status: 404});
    const Buyable = Offers.find((Offer) => Offer.platinumPrice === 500 && Offer.items?.length)!;
    assert.ok(Buyable);
    for(let Index = 0; Index < 50; Index++) assert.equal((await Complete(A)).status, 200);
    RedeemStorePurchase(A.UserId, "platinum", CreateStorePurchase(A.UserId, "platinum", Buyable.id).purchaseToken);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 0);
    assert.equal(GetStoreOffer(A.UserId, Buyable.id).remaining, 0);
});

it("rotation uses new progress and ownership scopes; old purchase tokens expire at boundary", async () => {
    const A = await MakePlayer();
    Credit(A.CharacterId, 2000);
    const Token = CreateStorePurchase(A.UserId, "platinum", Pass).purchaseToken;
    GrantProgressionInTrack(A.UserId, "season09b", "100", "gameserver");
    const OldScope = GetHuntPassScope("season09b");
    GetDb().transaction((tx) => GrantEntitlementInTx(tx, A.UserId, Pass, 0, "store:test"));
    const RealNow = Date.now;
    const Next = Date.parse(String(GetConfiguredPath("season09b")!.end_date)) + 1;
    try{
        Date.now = () => Next;
        assert.notEqual(GetHuntPassScope("season09b"), OldScope);
        assert.equal(GetTrackRecord(A.UserId, "season09b")?.progress, 0);
        assert.ok(!ListEntitlements(A.UserId).some((Row) => Row.name === Pass));
        assert.throws(() => RedeemStorePurchase(A.UserId, "platinum", Token), {Status: 409});
        assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 2000);
    }
    finally { Date.now = RealNow; }
    assert.equal(GetTrackRecord(A.UserId, "season09b")?.progress, 100);
    assert.equal(SetSelectedHuntPass(A.UserId, {progression_id: "masterytrack_slayer"}, "gameserver").Status, 400);
});

it("normalized pass refunds total 200 Basic plus 750 Elite without changing rank XP", () => {
    const Path = GetConfiguredPath("season09b")!;
    const Sum = (Rows: unknown[]) => (Rows as any[]).flatMap((Row) => Row.stacked_items ?? []).filter((Item) => Item.catalog_id === PLATINUM_ITEM).reduce((Total, Item) => Total + Item.quantity, 0);
    assert.equal(Sum(Path.free_rewards!), 200);
    assert.equal(Sum(Path.premium_rewards!), 750);
    assert.equal(Path.requirements!.reduce((Total, Rank) => Total + Rank.xp_required, 0), 5000);
    assert.equal(SelectHuntPassSeason([Path], Date.parse("2026-10-12T00:00:00Z")).id, "season09b");
    assert.equal(Count("huntcompletions"), GetDb().select().from(huntcompletions).all().length);
});

it("native paid cosmetics require earned tier and current Elite ownership", async () => {
    const A = await MakePlayer();
    const Item = "AR_HP09B_COMMANDO_HELM_00";
    const Claim = (Quantity = 1) => Call("POST", "/inventory", {gs: true, body: {accountId: A.UserId, characterId: A.CharacterId,
        transactionId: `cosmetic-${++CompletionCounter}`, addStackedItems: [{catalogId: Item, quantity: Quantity}]}});
    assert.equal((await Claim()).status, 403);
    GrantProgressionInTrack(A.UserId, "season09b", "100", "gameserver");
    assert.equal((await Claim()).status, 403);
    Credit(A.CharacterId, 950);
    RedeemStorePurchase(A.UserId, "platinum", CreateStorePurchase(A.UserId, "platinum", Pass).purchaseToken);
    assert.equal((await Claim(2)).status, 200, "Basic/Elite aggregate can include same unlock twice");
    assert.equal(StackQuantity(A.CharacterId, Item), 1);
    assert.equal((await Claim()).status, 200);
    assert.equal(StackQuantity(A.CharacterId, Item), 1, "owned pass cosmetic does not stack on reissue");
});

it("pass platinum cannot exceed earned allowance even with changed request IDs", async () => {
    const A = await MakePlayer();
    const Claim = () => Call("POST", "/inventory", {gs: true, body: {accountId: A.UserId, characterId: A.CharacterId,
        transactionId: `refund-${++CompletionCounter}`, addStackedItems: [{catalogId: PLATINUM_ITEM, quantity: 50}]}});
    assert.equal((await Claim()).status, 403);
    GrantProgressionInTrack(A.UserId, "season09b", "1000", "gameserver");
    assert.equal((await Claim()).status, 200);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 50);
    assert.equal((await Claim()).status, 403);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 50);
    await Complete(A);
    assert.equal(StackQuantity(A.CharacterId, PLATINUM_ITEM), 60, "hunt income is independent of tier allowance");
});
