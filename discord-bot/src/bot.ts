/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Dauntless Revamped Discord bot: its own process, token and data, apart from the game backend.
// It reaches the backend only over HTTP, both ways:
//   bot -> backend  BACKEND_HEALTH_URL (status channel)
//   backend -> bot  http://BOT_HTTP_HOST:BOT_HTTP_PORT/news (backend DISCORD_BOT_URL; launcher news dock)
// Each feature is off while its channel id is unset; /issue tickets need only the token.

import { createServer } from "node:http";
import path from "node:path";
import { Client } from "discord.js";
import { GatewayIntents, IssueStore, StartIssues } from "./issues";
import { NewsHandler } from "./news";
import { RunStatus } from "./status";

const Env = (name: string) => process.env[name]?.trim() || undefined;

function Main(): void {
    const Token = Env("DISCORD_BOT_TOKEN");
    if (!Token) throw new Error("Set DISCORD_BOT_TOKEN in .env");

    const Bot = new Client({ intents: GatewayIntents });
    StartIssues(Bot, new IssueStore(path.resolve(Env("BOT_DATA_DIR") ?? "data", "issues.json")), Env("DISCORD_GUILD_ID"));
    Bot.login(Token).catch((error) => console.warn(`[Bot] Discord login failed: ${error}`));

    const Status = Env("DISCORD_STATUS_CHANNEL_ID");
    if (Status) RunStatus(Token, Status, Env("BACKEND_HEALTH_URL") ?? "http://127.0.0.1:3000/health/ready").catch((error) => console.error(`[Status] ${error}`));

    const News = Env("DISCORD_NEWS_CHANNEL_ID");
    if (News && /^\d{5,25}$/.test(News)) {
        const Host = Env("BOT_HTTP_HOST") ?? "127.0.0.1";
        const Port = Number(Env("BOT_HTTP_PORT") ?? "3100");
        createServer(NewsHandler(Token, News)).listen(Port, Host, () => console.log(`[News] serving on http://${Host}:${Port}/news`));
    }

    const Stop = () => { void Bot.destroy().finally(() => process.exit(0)); };
    process.on("SIGINT", Stop);
    process.on("SIGTERM", Stop);
}

Main();
