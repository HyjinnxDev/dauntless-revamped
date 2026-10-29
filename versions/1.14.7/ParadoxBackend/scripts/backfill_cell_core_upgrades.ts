/*
 * One-off backfill for cell cores opened before the +2/+3 rule in ramsRewards.ts (2026-10-23).
 *
 * Replays every past core open in the inventory ledger through RollCellCoreUpgrade. Each upgrade takes one +1 cell that
 * open granted (any owned +1 cell if that one has since been spent) and gives its +2/+3 version instead. All swaps for a
 * character commit as one inventory transaction with a fixed id, so a re-run replays the ledger and cannot pay twice.
 *
 *   tsx --env-file=.env scripts/backfill_cell_core_upgrades.ts --user-id=<id> [--user-id=...] [--apply]
 */

import { GetInventoryForUserIdAndCharacterId, RunInventoryTransaction } from "../src/controllers/inventory";
import { CELL_CORE_UPGRADE, RollCellCoreUpgrade } from "../src/ramsRewards";
import { GetPersistenceLifecycle } from "../src/persistence";
import { MongoClient } from "mongodb";

const Apply = process.argv.includes("--apply");
const UserIds = process.argv.filter((Arg) => Arg.startsWith("--user-id=")).map((Arg) => Arg.slice("--user-id=".length));
if (UserIds.length === 0) throw new Error("usage: --user-id=<id> [--user-id=...] [--apply]");
const IsPlusOne = (Id: string) => /^CELL_.+_UC$/.test(Id);

async function Main(): Promise<void> {
    const Lifecycle = GetPersistenceLifecycle();
    const Client = await MongoClient.connect(process.env.MONGODB_URI!);
    try {
        const Db = Client.db(process.env.MONGODB_DB);
        for (const UserId of UserIds) {
            const Opens = (await Db.collection("inventoryTransactions").find({ userId: UserId, status: "completed" }).sort({ createdAt: 1 }).toArray())
                .map((Row: any) => ({ characterId: Row.characterId as string, items: (Row.result?.updatedStackedItems ?? []) as any[] }))
                .filter((Row) => Row.items.some((Item) => IsPlusOne(Item.catalogId)) && Row.items.some((Item) => Item.catalogId === "CURRENCY_CELLDUST"))
                .map((Row) => ({ ...Row, core: Row.items.find((Item) => CELL_CORE_UPGRADE[Item.catalogId])?.catalogId as string | undefined }))
                .filter((Row) => Row.core);
            for (const CharacterId of [...new Set(Opens.map((Row) => Row.characterId))]) {
                const Inventory = await GetInventoryForUserIdAndCharacterId(UserId, CharacterId);
                if (!Inventory) throw new Error(`no inventory ${UserId}/${CharacterId}`);
                const Owned: Record<string, number> = {};
                for (const Item of Inventory.stackedItems) if (IsPlusOne(Item.catalogId)) Owned[Item.catalogId] = Item.quantity;
                const Remove: Record<string, number> = {}, Add: Record<string, number> = {};
                const Count: Record<string, number> = {};
                for (const Open of Opens.filter((Row) => Row.characterId === CharacterId)) {
                    Count[Open.core!] = (Count[Open.core!] ?? 0) + 1;
                    const Tier = RollCellCoreUpgrade(Open.core!);
                    if (!Tier) continue;
                    const Pick = (Ids: string[]) => Ids[Math.floor(Math.random() * Ids.length)];
                    const FromOpen = Open.items.map((Item) => Item.catalogId).filter((Id) => IsPlusOne(Id) && Owned[Id] > 0);
                    const Cell = FromOpen.length ? Pick(FromOpen) : Pick(Object.keys(Owned).filter((Id) => Owned[Id] > 0));
                    if (!Cell) continue;
                    Owned[Cell]--;
                    Remove[Cell] = (Remove[Cell] ?? 0) + 1;
                    Add[Cell.slice(0, -2) + Tier] = (Add[Cell.slice(0, -2) + Tier] ?? 0) + 1;
                }
                const ToItems = (Map: Record<string, number>) => Object.entries(Map).map(([catalogId, quantity]) => ({ catalogId, quantity }));
                console.log(`${UserId}/${CharacterId} opens ${JSON.stringify(Count)}`);
                console.log(`  remove +1: ${JSON.stringify(Remove)}`);
                console.log(`  add: ${JSON.stringify(Add)}`);
                if (!Apply || Object.keys(Add).length === 0) continue;
                const Result = await RunInventoryTransaction(UserId, CharacterId, `backfill-cellcore-20261023-${CharacterId}`,
                    [], ToItems(Add), [], ToItems(Remove), [], { ownershipAlreadyValidated: true, diagnosticLabel: "cell core backfill" });
                if (!Result) throw new Error(`transaction refused for ${CharacterId}`);
                console.log("  applied");
            }
        }
    } finally {
        await Client.close();
        await Lifecycle.stop();
    }
}

Main().catch((Err) => {
    console.error(Err);
    process.exitCode = 1;
});
