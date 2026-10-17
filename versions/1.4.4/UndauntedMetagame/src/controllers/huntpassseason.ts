import schedule from "../vendor/hunt_pass_schedule.json";
import { StoreMode } from "../features";
import type { ProgressionPath } from "./progressionconfig";

export function SelectHuntPassSeason(Paths: ProgressionPath[], At = Date.now()){
    const Duration = schedule.days * 24 * 60 * 60 * 1000;
    const Epoch = Date.parse(schedule.epoch);
    if(!Number.isFinite(Epoch) || !Number.isSafeInteger(Duration) || Duration <= 0 || schedule.passes.length === 0){
        throw new Error("Invalid Hunt Pass schedule");
    }
    for(const Id of schedule.passes){
        const Path = Paths.find((Path) => Path.progression_id === Id);
        if(!Path?.premium_gating_entitlement || !(Path.premium_rewards?.length)){
            throw new Error(`Scheduled Hunt Pass ${Id} has no premium gate or rewards`);
        }
    }
    const Index = Math.max(0, Math.floor((At - Epoch) / Duration));
    return {id: schedule.passes[Index % schedule.passes.length], start: Epoch + Index * Duration, end: Epoch + (Index + 1) * Duration};
}

export function IsEarnedStore(){ return StoreMode() === "earned"; }

export function IsHuntPass(Path: ProgressionPath | undefined){
    return !!Path?.premium_gating_entitlement && /^season/.test(Path.progression_id);
}

export function HuntPassPrice(Path: ProgressionPath){
    const Max = Math.max(...(Path.requirements ?? []).map((Rank) => Rank.rank_id));
    return Max === 25 ? 500 : 950;
}

export function SeasonRewards(Path: ProgressionPath): ProgressionPath {
    const Max = Math.max(...(Path.requirements ?? []).map((Rank) => Rank.rank_id));
    if(Max !== 50 && Max !== 25) return Path;
    const Rewards = (Rows: unknown[] | undefined, Premium: boolean) => {
        const Copies = structuredClone(Rows ?? []) as any[];
        for(const Row of Copies) Row.stacked_items = (Row.stacked_items ?? []).filter((Item: any) => Item.catalog_id !== "CURRENCY_PLATINUM_UNIV");
        const Ranks = Max === 25 ? [5, 10, 15, 20, 25] : Premium ? [5, 10, 15, 20, 25, 30, 35, 40, 45, 50] : [10, 25, 35, 45];
        for(const Rank of Ranks){
            let Row = Copies.find((Row) => Row.rank_id === Rank);
            if(Row === undefined){ Row = {rank_id: Rank, stacked_items: [], instanced_items: [], entitlements: []}; Copies.push(Row); }
            Row.stacked_items.push({catalog_id: "CURRENCY_PLATINUM_UNIV", quantity: Max === 25 ? Premium ? 80 : 20 : Premium ? 75 : 50, hidden: false, priority: 0});
        }
        return Copies.sort((A, B) => A.rank_id - B.rank_id);
    };
    return {...Path, free_rewards: Rewards(Path.free_rewards, false), premium_rewards: Rewards(Path.premium_rewards, true)};
}
