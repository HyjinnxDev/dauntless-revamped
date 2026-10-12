import { and, eq } from "drizzle-orm";
import { huntcompletions } from "../db/schema";
import { StoreMode } from "../features";
import { Tx } from "./savehistory";

export const PLATINUM_ITEM = "CURRENCY_PLATINUM_UNIV";
export type HuntCompletion = { id: string, hunt: string, players: string[] };

// Only read after game-server authentication. Body/source never supplies this proof.
export function ReadHuntCompletion(Header: unknown): HuntCompletion | undefined {
    if(typeof Header !== "string" || Header.length > 8192) return undefined;
    try{
        const Value = JSON.parse(Header);
        if(typeof Value?.id !== "string" || !/^[a-f0-9-]{36}:\d+$/.test(Value.id)
            || typeof Value.hunt !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(Value.hunt)
            || !Array.isArray(Value.players) || Value.players.length === 0 || Value.players.length > 128
            || !Value.players.every((Id: unknown) => typeof Id === "string" && /^[\x21-\x7e]{1,128}$/.test(Id))){
            return undefined;
        }
        return {id: Value.id, hunt: Value.hunt, players: Value.players};
    }
    catch { return undefined; }
}

export function ReserveHuntPlatinum(tx: Tx, AccountId: string, CharacterId: string, Completion?: HuntCompletion){
    if(StoreMode() !== "earned" || Completion === undefined || !Completion.players.includes(AccountId)
        || /training|ramsgate|city|tutorial/i.test(Completion.hunt)) return 0;
    const Existing = tx.select().from(huntcompletions).where(and(
        eq(huntcompletions.accountId, AccountId), eq(huntcompletions.completionId, Completion.id)
    )).get();
    if(Existing !== undefined) return 0;
    const Amount = /esca/i.test(Completion.hunt) ? 30 : 10;
    tx.insert(huntcompletions).values({accountId: AccountId, completionId: Completion.id,
        characterId: CharacterId, huntId: Completion.hunt, platinum: Amount, completedDate: new Date().toISOString()}).run();
    return Amount;
}
