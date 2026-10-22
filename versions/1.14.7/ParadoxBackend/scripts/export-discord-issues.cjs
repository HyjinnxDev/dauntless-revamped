#!/usr/bin/env node
/*
 * export-discord-issues.cjs - one-time hand-over of the /issue tickets to the standalone Discord bot. They were
 * kept in MongoDB (discord_issues, discord_issue_config) while the bot ran inside the backend; the bot now keeps
 * them in its own issues.json. Read-only on MongoDB. Refuses to replace an existing file.
 *   node --env-file=.env scripts/export-discord-issues.cjs ../../../discord-bot/data/issues.json
 */
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

async function Main() {
    const Out = process.argv[2];
    if (!Out) throw new Error("usage: export-discord-issues.cjs <path to issues.json>");
    if (fs.existsSync(Out)) throw new Error(`${Out} exists; move it away first`);
    const Client = await MongoClient.connect(process.env.MONGODB_URI);
    try {
        const Db = Client.db(process.env.MONGODB_DB);
        const Issues = await Db.collection("discord_issues").find().sort({ _id: 1 }).toArray();
        const Counter = await Db.collection("discord_issue_config").findOne({ _id: "counter" });
        const Channels = await Db.collection("discord_issue_config").findOne({ _id: "channels" });
        const Iso = (d) => (d instanceof Date ? d.toISOString() : d);
        const Data = {
            lastId: Math.max(Counter?.next ?? 0, ...Issues.map((I) => I._id)),
            channels: Channels?.channels ?? [],
            ...(Channels?.log ? { log: Channels.log } : {}),
            issues: Issues.map(({ _id, createdAt, closedAt, ...Rest }) => ({ id: _id, ...Rest, createdAt: Iso(createdAt), ...(closedAt ? { closedAt: Iso(closedAt) } : {}) })),
        };
        fs.mkdirSync(path.dirname(Out), { recursive: true });
        fs.writeFileSync(Out, JSON.stringify(Data, null, 2));
        console.log(`wrote ${Data.issues.length} tickets (last #${Data.lastId}), ${Data.channels.length} channels to ${Out}`);
    } finally {
        await Client.close();
    }
}

Main().catch((error) => { console.error(error.message ?? error); process.exitCode = 1; });
