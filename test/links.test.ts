// Links the launcher opens in the browser. The page only names a link; the main process opens exactly
// that link's fixed URL. Raw URLs, unknown names, look-alike hosts and other repositories never get
// through, neither at the IPC check nor at the URL allow-list.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Controller, type Platform } from "../src/main/controller";
import { externalTarget } from "../src/main/ipc-validate";
import { FIXED_LINKS, fixedLinkUrl, isAllowedExternalUrl, isAllowedStaticUrl, type FixedTarget } from "../src/main/links";
import { setSink } from "../src/main/log";
import type { ExternalTarget } from "../src/shared/types";

// Every fixed link and the one URL it opens, written out here on purpose (not taken from constants.ts).
const EXPECTED: Record<FixedTarget, string> = {
  tailscale_download: "https://tailscale.com/download",
  project_source: "https://github.com/HyjinnxDev/dauntless-revived",
  project_license: "https://github.com/HyjinnxDev/dauntless-revived/blob/dauntless-revived/LICENSE.txt",
  project_contributors: "https://github.com/HyjinnxDev/dauntless-revived/graphs/contributors",
  revived_source: "https://github.com/mixutin/dauntless-revived",
  revived_contributors: "https://github.com/mixutin/dauntless-revived/graphs/contributors",
  upstream_source: "https://github.com/SyST3MDeV/Undaunted",
  upstream_contributors: "https://github.com/SyST3MDeV/Undaunted/graphs/contributors",
  mystic_source: "https://github.com/pranav158/Mystic-Paradox",
  discord: "https://discord.gg/dauntlessrevived",
};

// A Record, so the compiler fails this file when a link name is added without a test here.
const ALL_TARGETS: Record<ExternalTarget, true> = {
  tailscale_download: true,
  server_source: true,
  project_source: true,
  project_license: true,
  project_contributors: true,
  revived_source: true,
  revived_contributors: true,
  upstream_source: true,
  upstream_contributors: true,
  mystic_source: true,
  discord: true,
};
// Raw URLs and tricks: none of these may ever be opened.
const BAD_URLS = [
  "https://github.com.evil.example/mixutin/dauntless-revived",
  "https://github.com@evil.example/mixutin/dauntless-revived",
  "https://evil.example@github.com/mixutin/dauntless-revived",
  "https://github.com:x@github.com/mixutin/dauntless-revived",
  "https://evil.example/https://github.com/mixutin/dauntless-revived",
  "http://github.com/mixutin/dauntless-revived",
  "http://github.com/SyST3MDeV/Undaunted/graphs/contributors",
  "javascript:alert(1)",
  "JavaScript:alert(1)//https://github.com/mixutin/dauntless-revived",
  "data:text/html,<script>alert(1)</script>",
  "file:///C:/Windows/System32/calc.exe",
  "dauntless-revived://join?v=1",
  "https://github.com/mixutin/other-repo",
  "https://github.com/evil/dauntless-revived",
  "https://github.com/mixutin/dauntless-revived-evil",
  "https://github.com/SyST3MDeV/Undaunted-evil",
  "https://github.com/SyST3MDeV/Other",
  "https://github.com/mixutin/dauntless-revived/issues",
  "https://github.com/mixutin/dauntless-revived/releases/download/launcher-updates/evil.exe",
  "https://github.com/mixutin/dauntless-revived/../../evil/repo",
  "https://github.com/mixutin/dauntless-revived/%2e%2e/%2e%2e/evil/repo",
  "https://github.com/mixutin/dauntless-revived/graphs/contributors/%2e%2e/%2e%2e/%2e%2e/evil",
  "https://github.com/mixutin%2Fdauntless-revived",
  "https://github.com/%6Dixutin/dauntless-revived",
  "https://GITHUB.COM/mixutin/dauntless-revived",
  "HTTPS://github.com/mixutin/dauntless-revived",
  "https://github.com/MIXUTIN/DAUNTLESS-REVIVED",
  "https://github.com/syst3mdev/undaunted",
  "https://github.com:443/mixutin/dauntless-revived",
  "https://github.com:8443/mixutin/dauntless-revived",
  "https://github.com./mixutin/dauntless-revived",
  "https://github.com%2eevil.example/mixutin/dauntless-revived",
  "https://xn--gthub-n4a.com/mixutin/dauntless-revived",
  "https://gіthub.com/mixutin/dauntless-revived",
  "https://github.com/mixutin/dauntless-revived/",
  "https://github.com/mixutin/dauntless-revived?x=1",
  "https://github.com/mixutin/dauntless-revived#readme",
  " https://github.com/mixutin/dauntless-revived",
  "https://github.com/mixutin/dauntless-revived ",
  "https://github.com/mixutin/dauntless-revived\n",
  "https://tailscale.com.evil.example/download/windows",
  "https://login.tailscale.com@evil.example/",
  "https://aka.ms/evil",
  "https://www.eugamehost.com.evil.example/",
  "https://www.eugamehost.com/clients/cart.php?a=add&pid=999",
  "https://eugamehost.com/",
  "https://discord.gg.evil.example/ZJRprHzsgu",
  "https://discord.gg/dauntlessrevived/extra",
  "https://discord.com/invite/ZJRprHzsgu",
  "https://evil.example/",
  "",
];

const temps: string[] = [];
setSink(() => undefined);

after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function controller(): { c: Controller; opened: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), "df-links-"));
  temps.push(dir);
  const opened: string[] = [];
  const p: Platform = {
    userDataDir: dir,
    defaultInstallDir: path.join(dir, "game"),
    appVersion: "0.0.0-test",
    packaged: false,
    defaultLanguage: "en",
    encryptor: { isAvailable: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" },
    manifest: null,
    chooseFolder: async () => null,
    openExternal: async (url) => {
      opened.push(url);
    },
    openPath: async () => undefined,
    emitSnapshot: () => undefined,
    emitProgress: () => undefined,
    findTailscale: () => null,
    findRunningClients: async () => [],
  };
  return { c: new Controller(p), opened };
}

test("every fixed link name maps to exactly its URL", () => {
  assert.deepEqual({ ...FIXED_LINKS }, EXPECTED);
  for (const [name, url] of Object.entries(EXPECTED)) {
    assert.equal(fixedLinkUrl(name), url, name);
    assert.ok(isAllowedStaticUrl(url), `${name} must pass the allow-list`);
  }
  assert.ok(Object.isFrozen(FIXED_LINKS));
});

test("each link name opens exactly its URL, once; the server's source is the project's", async () => {
  for (const [name, url] of Object.entries(EXPECTED)) {
    const { c, opened } = controller();
    assert.deepEqual(await c.openExternal(name as ExternalTarget), { ok: true }, name);
    assert.deepEqual(opened, [url], name);
  }
  const { c, opened } = controller();
  assert.deepEqual(await c.openExternal("server_source"), { ok: true });
  assert.deepEqual(opened, [EXPECTED.project_source]);
});

test("unknown names and raw URLs sent as a link name open nothing", async () => {
  const names = [...BAD_URLS, ...Object.values(EXPECTED), "tailscale_share", "vc_redist", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "PROJECT_SOURCE", "project-source", "project_source ", "repo", "github"];
  for (const name of names) {
    const { c, opened } = controller();
    const r = await c.openExternal(name as ExternalTarget);
    assert.equal(r.ok, false, JSON.stringify(name));
    assert.deepEqual(opened, [], JSON.stringify(name));
    assert.equal(fixedLinkUrl(name), null, JSON.stringify(name));
  }
});

test("look-alike hosts, other repositories, ports and other schemes are refused by the allow-list", () => {
  for (const url of [...BAD_URLS, "https://github.com:3000/mixutin/dauntless-revived", "https://aka.ms/vs/17/release/vc_redist.x64.exe"]) {
    assert.equal(isAllowedStaticUrl(url), false, JSON.stringify(url));
    assert.equal(isAllowedExternalUrl(url, url), false, JSON.stringify(url));
  }
});
test("the IPC check lets through exactly the link names, nothing else", () => {
  for (const name of Object.keys(ALL_TARGETS)) assert.equal(externalTarget(name), name);
  const bad: unknown[] = [
    ...BAD_URLS,
    ...Object.values(EXPECTED),
    "PROJECT_SOURCE",
    "Project_Source",
    " project_source",
    "project_source ",
    "project_source\0",
    "project_source\n",
    "project-source",
    "project_source?",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "repo",
    "contributors",
    null,
    undefined,
    0,
    1,
    true,
    NaN,
    {},
    [],
    ["project_source"],
    { target: "project_source" },
    { toString: () => "project_source" },
    new String("project_source"),
    Symbol("project_source"),
    () => "project_source",
  ];
  for (const v of bad) assert.equal(externalTarget(v), null, String(typeof v === "symbol" ? v.toString() : JSON.stringify(v)));
});
