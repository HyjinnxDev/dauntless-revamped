import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IssueEmbed, IssueStore, type Issue } from "./issues";

test("issue embed shows the ticket id and flips to closed with resolution", () => {
    const Ticket: Issue = { id: 7, title: "Crash", description: "On load", reporterId: "1", channelId: "2", status: "open", createdAt: new Date(0).toISOString() };
    const Open = IssueEmbed(Ticket);
    assert.equal(Open.title, "#7 Crash");
    assert.deepEqual(Open.fields!.map((f) => f.value), ["Open", "<@1>"]);
    const Closed = IssueEmbed({ ...Ticket, status: "closed", closedBy: "3", closeReason: "Fixed in 0.2.36" });
    assert.deepEqual(Closed.fields!.map((f) => f.value), ["Closed", "<@1>", "<@3>", "Fixed in 0.2.36"]);
});

test("ticket file: starts empty, survives overlapping saves, refuses to overwrite a broken file", async () => {
    const Dir = await mkdtemp(path.join(os.tmpdir(), "issues-"));
    const Store = new IssueStore(path.join(Dir, "data", "issues.json"));
    const S = await Store.load();
    assert.deepEqual(S, { lastId: 0, channels: [], issues: [] });
    S.issues.push({ id: ++S.lastId, title: "a", description: "", reporterId: "1", channelId: "2", status: "open", createdAt: "" });
    const First = Store.save();
    S.issues.push({ id: ++S.lastId, title: "b", description: "", reporterId: "1", channelId: "2", status: "open", createdAt: "" });
    await Promise.all([First, Store.save()]);
    const Reloaded = await new IssueStore(Store.file).load();
    assert.equal(Reloaded.lastId, 2);
    assert.deepEqual(Reloaded.issues.map((T) => T.title), ["a", "b"]);

    await writeFile(Store.file, "{ not json");
    await assert.rejects(new IssueStore(Store.file).load());
    assert.equal(await readFile(Store.file, "utf8"), "{ not json");
});
