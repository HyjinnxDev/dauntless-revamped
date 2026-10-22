/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [forever-launcher] GET /content/v1/news (+ /content/v1/news/image/<message id>): the launcher's news dock.
// The Discord bot (discord-bot/, its own process and token) reads the announcements channel; this only passes
// its answer on, because the launcher talks to nothing but its own server. DISCORD_BOT_URL unset = 404.
// Bot unreachable = the last list it gave (or an empty one), so a bot restart doesn't blank the dock.

import express from "express";
import { logger } from "../logger";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const BotUrl = () => process.env.DISCORD_BOT_URL?.trim().replace(/\/+$/, "") || undefined;

let LastItems: unknown[] = [];

export const newsRouter = express.Router();

newsRouter.get("/content/v1/news", async (_req, res) => {
    const Bot = BotUrl();
    if (!Bot) { res.status(404).send(); return; }
    try {
        const Res = await fetch(`${Bot}/news`, { signal: AbortSignal.timeout(15000) });
        if (!Res.ok) throw new Error(`bot answered ${Res.status}`);
        const Items = ((await Res.json()) as { items?: unknown }).items;
        if (Array.isArray(Items)) LastItems = Items;
    } catch (error) {
        logger.warn(`[News] bot not read: ${error}`);
    }
    res.setHeader("cache-control", "no-store");
    res.json({ items: LastItems });
});

newsRouter.get("/content/v1/news/image/:id", async (req, res) => {
    const Bot = BotUrl();
    if (!Bot || !/^\d{5,25}$/.test(req.params.id)) { res.status(404).send(); return; }
    try {
        const Img = await fetch(`${Bot}/news/image/${req.params.id}`, { signal: AbortSignal.timeout(30000), redirect: "error" });
        const Type = Img.headers.get("content-type") ?? "";
        if (Img.status === 404) { res.status(404).send(); return; }
        if (!Img.ok || !/^image\/(png|jpeg|webp|gif)$/.test(Type)) { res.status(502).send(); return; }
        const Data = Buffer.from(await Img.arrayBuffer());
        if (Data.length > MAX_IMAGE_BYTES) { res.status(502).send(); return; }
        res.setHeader("content-type", Type);
        res.setHeader("cache-control", "no-store");
        res.send(Data);
    } catch (error) {
        logger.warn(`[News] image not read from bot: ${error}`);
        res.status(502).send();
    }
});
