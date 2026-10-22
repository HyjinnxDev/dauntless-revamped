import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { newsRouter } from "./news";

const Listen = (S: Server) => new Promise<string>((resolve) => S.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(S.address() as AddressInfo).port}`)));

test("news passes the bot's list and images on, keeps the last list while the bot is down", async (t) => {
    let BotUp = true;
    const Bot = createServer((req, res) => {
        if (!BotUp) { res.writeHead(503).end(); return; }
        if (req.url === "/news") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items: [{ title: "Patch" }] })); return; }
        if (req.url === "/news/image/123456") { res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([1, 2, 3])); return; }
        res.writeHead(404).end();
    });
    const App = createServer(express().use(newsRouter));
    t.after(() => { Bot.close(); App.close(); delete process.env.DISCORD_BOT_URL; });
    const [BotBase, AppBase] = await Promise.all([Listen(Bot), Listen(App)]);

    assert.equal((await fetch(`${AppBase}/content/v1/news`)).status, 404); // DISCORD_BOT_URL unset
    process.env.DISCORD_BOT_URL = `${BotBase}/`;
    assert.deepEqual(await (await fetch(`${AppBase}/content/v1/news`)).json(), { items: [{ title: "Patch" }] });
    const Img = await fetch(`${AppBase}/content/v1/news/image/123456`);
    assert.equal(Img.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await Img.arrayBuffer())], [1, 2, 3]);
    assert.equal((await fetch(`${AppBase}/content/v1/news/image/999999`)).status, 404);
    assert.equal((await fetch(`${AppBase}/content/v1/news/image/abc`)).status, 404);

    BotUp = false;
    assert.deepEqual(await (await fetch(`${AppBase}/content/v1/news`)).json(), { items: [{ title: "Patch" }] });
});
