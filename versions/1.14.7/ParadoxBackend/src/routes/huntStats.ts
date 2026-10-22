import { Router } from "express";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";
import { logger } from "../logger";
import { ParseHuntStats } from "../huntStats";

// Hunt servers only (gameserver API key): one behemoth kill's per-player damage. See src/huntStats.ts.
export const huntStatsRouter = Router();

huntStatsRouter.post("/mystic/hunt-stats", HasParadoxBackendAuth, async (req: any, res) => {
    if (req.AuthData?.IsGameserver !== true) return res.status(403).send();
    const Rows = ParseHuntStats(req.body);
    if (!Rows) return res.status(400).send();
    try {
        const Now = new Date();
        await (await GetMongoDb()).collection<any>(Collections.HuntStats).bulkWrite(Rows.map((R) => ({
            updateOne: {
                filter: { _id: `${R.hunt}:${R.userId}` },
                update: { $set: { ...R, updatedAt: Now }, $setOnInsert: { createdAt: Now } },
                upsert: true
            }
        })));
        logger.info(`[HuntStats] ${Rows[0].hunt} ${Rows.map((R) => `${R.userId}=${R.damage}`).join(" ")}`);
        res.status(204).send();
    } catch (Err) {
        logger.error(`[HuntStats] write failed: ${Err}`);
        res.status(500).send();
    }
});
