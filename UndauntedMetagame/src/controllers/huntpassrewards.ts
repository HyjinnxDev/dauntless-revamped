import { and, eq } from "drizzle-orm";
import { huntpassplatinum, progresstracks } from "../db/schema";
import { HasActiveEntitlement } from "./entitlements";
import { GetActiveHuntPass, GetConfiguredPaths, GetHuntPassScope } from "./progressionconfig";
import { ComputeEarnedRanks } from "./progressionrank";
import { IsEarnedStore, IsHuntPass } from "./huntpassseason";
import { PLATINUM_ITEM } from "./huntplatinum";
import { Tx } from "./savehistory";

const IsCosmetic = (Id: string) => /^(AR_|WP_|EM_|DYE_|QI_FLARE_|BNC_|LT_|TITLE_|EJ_)/.test(Id);
const ItemsOf = (Row: any): any[] => [...(Row.stacked_items ?? []), ...(Row.instanced_items ?? []), ...(Row.ordered_instanced_items ?? [])];

export function IsPassItem(Id: string){
    if(/(?:^|_)HP\d\d[A-Z]?_|^AR_SAINTS19_ROMANTIC_/i.test(Id)) return true;
    return IsCosmetic(Id) && GetConfiguredPaths().filter(IsHuntPass).some((Path) => [Path.free_rewards, Path.premium_rewards]
        .some((Rows) => (Rows ?? []).some((Row) => ItemsOf(Row).some((Item) => Item.catalog_id === Id))));
}

// Backstop native caches across rollover: only currently earned rewards may enter inventory.
// Currency uses total earned allowance; native wire payload does not identify individual tier claims.
export function AuthorizePassRewards(tx: Tx, AccountId: string, Items: any[]){
    if(!IsEarnedStore()) return true;
    const Protected = Items.filter((Item) => IsPassItem(Item.catalogId) || Item.catalogId === PLATINUM_ITEM);
    if(Protected.length === 0) return true;
    if(Protected.some((Item) => Item.catalogId !== PLATINUM_ITEM && Item.quantity !== undefined && Number(Item.quantity) !== 1)) return false;
    const Path = GetConfiguredPaths().find((Path) => Path.progression_id === GetActiveHuntPass())!;
    const Scope = GetHuntPassScope(Path.progression_id);
    const Track = tx.select().from(progresstracks).where(and(eq(progresstracks.accountId, AccountId), eq(progresstracks.progressionId, Scope))).get();
    const Premium = HasActiveEntitlement(tx, AccountId, Path.premium_gating_entitlement!);
    const Ranks = ComputeEarnedRanks(Path, Track?.progress ?? 0, Premium);
    const Eligible = [
        ...(Path.free_rewards ?? []).filter((Row: any) => Row.rank_id <= Ranks.EarnedFreeRank),
        ...(Premium ? Path.premium_rewards ?? [] : []).filter((Row: any) => Row.rank_id <= Ranks.EarnedPremiumRank)
    ].flatMap(ItemsOf);
    if(Protected.some((Item) => Item.catalogId !== PLATINUM_ITEM && !Eligible.some((Reward) => Reward.catalog_id === Item.catalogId))){
        return false;
    }
    const Requested = Protected.filter((Item) => Item.catalogId === PLATINUM_ITEM).reduce((Sum, Item) => Sum + Number(Item.quantity), 0);
    if(Requested === 0) return true;
    const Allowed = Eligible.filter((Item) => Item.catalog_id === PLATINUM_ITEM).reduce((Sum, Item) => Sum + Number(Item.quantity), 0);
    const Previous = tx.select().from(huntpassplatinum).where(and(eq(huntpassplatinum.accountId, AccountId), eq(huntpassplatinum.progressionScope, Scope))).get()?.quantity ?? 0;
    if(!Number.isSafeInteger(Requested) || Requested < 0 || Requested + Previous > Allowed) return false;
    tx.insert(huntpassplatinum).values({accountId: AccountId, progressionScope: Scope, quantity: Previous + Requested})
        .onConflictDoUpdate({target: [huntpassplatinum.accountId, huntpassplatinum.progressionScope], set: {quantity: Previous + Requested}}).run();
    return true;
}
