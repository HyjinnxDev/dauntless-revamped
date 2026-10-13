// The whole flow through the Controller, against a fake Mystic Paradox backend on pinned TLS:
// invite -> status -> register with the invite code -> install (game files + the server's runtime)
// -> Play (game session, relay, launch args and environment) -> game exit stops the relay.
// Ports: 62440 fake backend (TLS), 62441 relay, 62443 a backend with another certificate.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Controller, type Platform } from "../src/main/controller";
import { validateManifest, type GameManifest } from "../src/main/manifest";
import { formatInvite } from "../src/shared/invite";
import { setSink } from "../src/main/log";
import type { SpawnFn } from "../src/main/launch";
import type { Snapshot } from "../src/shared/types";
import { FakeContentServer, FakeMystic, makeFiles, manifestFor, RUNTIME_DLL, RUNTIME_WINMM, sha256, TEST_BUILD } from "./fakes";
import { makeTestCert, type TestCert } from "./certs";

const BACKEND_PORT = 62440;
const RELAY_PORT = 62441;
const OTHER_PORT = 62443;
const EXE = "Archon/Binaries/Win64/Fake-Game.exe";

let cert: TestCert;
let other: TestCert;
let backend: https.Server;
let otherBackend: https.Server;
let mystic: FakeMystic;
let content: FakeContentServer;
let backendRequests: { url: string; host: string | undefined }[] = [];
const files = makeFiles();
const manifest: GameManifest = (() => {
  const r = validateManifest(manifestFor(files), TEST_BUILD, false);
  if (!r.ok) throw new Error(r.reason);
  return r.manifest;
})();
const logLines: string[] = [];
const temps: string[] = [];

function temp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

before(async () => {
  cert = makeTestCert();
  other = makeTestCert();
  mystic = new FakeMystic({ inviteCodes: new Set(["ABCD-EFGH-JKLM"]) });
  content = new FakeContentServer({ files, authorized: (auth) => mystic.userFor(auth) !== undefined });
  backend = https.createServer({ cert: cert.certPem, key: cert.keyPem }, (req, res) => {
    backendRequests.push({ url: `${req.method} ${req.url}`, host: req.headers.host });
    if ((req.url ?? "").startsWith("/content/")) content.handle(req, res);
    else mystic.handle(req, res);
  });
  otherBackend = https.createServer({ cert: other.certPem, key: other.keyPem }, (req, res) => mystic.handle(req, res));
  await new Promise<void>((resolve) => backend.listen(BACKEND_PORT, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => otherBackend.listen(OTHER_PORT, "127.0.0.1", resolve));
  setSink((l) => logLines.push(l));
});

after(async () => {
  for (const s of [backend, otherBackend]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  cert.cleanup();
  other.cleanup();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  c: Controller;
  last: () => Snapshot;
  spawns: { exe: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }[];
  child: () => EventEmitter | null;
  installDir: string;
  userData: string;
}

// userDataDir: reuse another harness's settings and sign-in (the launcher opened again).
function harness(userDataDir?: string, relayPort: number | undefined = RELAY_PORT): Harness {
  let snap: Snapshot | null = null;
  const spawns: Harness["spawns"] = [];
  let child: EventEmitter | null = null;
  const fakeSpawn = ((exe: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
    spawns.push({ exe, args, cwd: opts.cwd, env: opts.env });
    child = new EventEmitter();
    const c = child;
    setImmediate(() => c.emit("spawn"));
    return child;
  }) as unknown as SpawnFn;
  const userData = userDataDir ?? temp("df-ctl-user-");
  const installDir = temp("df-ctl-game-");
  const p: Platform = {
    userDataDir: userData,
    defaultInstallDir: installDir,
    appVersion: "0.0.0-test",
    packaged: false,
    defaultLanguage: "en",
    encryptor: {
      isAvailable: () => true,
      encrypt: (plain) => Buffer.from("enc:" + Buffer.from(plain).toString("base64")),
      decrypt: (data) => Buffer.from(data.toString().slice(4), "base64").toString(),
    },
    manifest,
    relayPort,
    gameConfigDir: temp("df-ctl-config-"),
    exePin: { relativePath: EXE, sha256: sha256(files.find((f) => f.path === EXE)!.data) },
    chooseFolder: async () => null,
    openExternal: async () => undefined,
    openPath: async () => undefined,
    emitSnapshot: (s) => {
      snap = s;
    },
    emitProgress: () => undefined,
    findTailscale: () => null,
    findRunningClients: async () => [],
    spawn: fakeSpawn,
  };
  const c = new Controller(p);
  return { c, last: () => snap ?? c.snapshot(), spawns, child: () => child, installDir, userData };
}

const invite = (port = BACKEND_PORT, fp = cert.fingerprint, code = "ABCD-EFGH-JKLM") =>
  formatInvite({ host: "127.0.0.1", port, fp, code, name: "Friday Hunts" });

function relayGet(pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: RELAY_PORT, path: pathname }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    }).on("error", reject);
  });
}

let firstUserData = "";

// init() starts the first connect without waiting for it (the window shows at once).
async function opened(h: Harness): Promise<void> {
  await h.c.init();
  for (let i = 0; i < 200 && (h.last().connect.checking || h.last().connect.lastCheckedAt === null); i++) await new Promise((r) => setTimeout(r, 10));
}

test("a friend joins, registers with the invite code, installs and plays through the relay", async () => {
  const h = harness();
  firstUserData = h.userData;
  await h.c.init();
  assert.equal(h.last().phase, "join");

  assert.deepEqual(await h.c.submitInvite(invite()), { ok: true });
  assert.equal(h.last().phase, "register");
  assert.equal(h.last().server?.hasPendingInvite, true);
  assert.equal(h.last().statusUnsupported, true, "Mystic lists nobody: shown as online without a list");

  const reg = await h.c.register("Slayer42", "hunter2hunter2");
  assert.deepEqual(reg, { ok: true, username: "Slayer42" });
  const regCall = mystic.calls.find((c) => c.path === "/launcher/v1/auth/register")!;
  assert.equal(regCall.body?.inviteCode, "ABCD-EFGH-JKLM");
  assert.equal(h.last().account.signedIn, true);
  assert.equal(h.last().server?.hasPendingInvite, false, "the code is used up");
  assert.equal(h.last().phase, "install");
  // The password is never stored; the session file holds only the encrypted refresh token.
  const sessions = path.join(h.userData, "sessions");
  const stored = readFileSync(path.join(sessions, readdirSync(sessions)[0])).toString();
  assert.ok(!stored.includes("hunter2"));

  assert.deepEqual(await h.c.startInstall(), { ok: true });
  for (const f of files) assert.ok(existsSync(path.join(h.installDir, ...f.path.split("/"))), f.path);
  const win64 = path.join(h.installDir, "Archon", "Binaries", "Win64");
  assert.deepEqual(readFileSync(path.join(win64, "MysticParadox.dll")), RUNTIME_DLL);
  assert.deepEqual(readFileSync(path.join(win64, "winmm.dll")), RUNTIME_WINMM);
  assert.ok(content.requests.every((r) => r.hadKey), "every file request carried a valid bearer token");
  assert.equal(h.last().phase, "ready");

  assert.deepEqual(await h.c.play(), { ok: true });
  const s = h.spawns[0];
  assert.equal(path.basename(s.exe), "Dauntless-Win64-Shipping.exe");
  assert.equal(s.env?.MYSTICPARADOX_API_BASE, `http://127.0.0.1:${RELAY_PORT}`);
  const code = mystic.exchangeCodes.at(-1)!;
  assert.ok(s.args.includes(`-AUTH_PASSWORD=${code}`));
  assert.ok(s.args.includes("-epicusername=Slayer42"));
  assert.ok(s.args.includes("-AUTH_TYPE=exchangecode"));
  const session = mystic.calls.find((c) => c.path === "/launcher/v1/game-sessions")!;
  assert.equal(session.body?.executableSha256, sha256(files.find((f) => f.path === EXE)!.data));
  // The exchange code never reaches the log.
  assert.ok(!logLines.some((l) => l.includes(code)));
  assert.ok(logLines.some((l) => l.includes("-AUTH_PASSWORD=<hidden>")));

  // The relay carries the game's requests to the backend, with the invite's host as Host.
  backendRequests = [];
  assert.equal(await relayGet("/launcher/v1/status"), 200);
  assert.equal(backendRequests[0].url, "GET /launcher/v1/status");
  assert.equal(backendRequests[0].host, `127.0.0.1:${BACKEND_PORT}`);
  assert.equal(h.c.relayActive, true);
  assert.equal(h.last().phase, "running");

  h.child()!.emit("exit", 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.c.relayActive, false);
  assert.equal(h.last().phase, "ready");
});

test("the launcher opened again signs in with the rotated refresh token, once", async () => {
  const before = mystic.calls.filter((c) => c.path === "/launcher/v1/auth/refresh").length;
  const h = harness(firstUserData);
  await opened(h);
  assert.equal(h.last().account.signedIn, true);
  assert.equal(h.last().account.username, "Slayer42");
  // Many callers at once still make exactly one refresh: a second one would replay a rotated token
  // and the server would sign the account out everywhere.
  const tokens = await Promise.all([h.c.accessToken(), h.c.accessToken(), h.c.accessToken()]);
  assert.equal(new Set(tokens).size, 1);
  const refreshes = mystic.calls.filter((c) => c.path === "/launcher/v1/auth/refresh").length - before;
  assert.equal(refreshes, 1);
  assert.equal(mystic.revokedFamilies.size, 0);
});

test("without a fixed relay port the relay takes any free one and the game is told which", async () => {
  const h = harness(firstUserData, undefined);
  await opened(h);
  const win64 = path.join(h.installDir, "Archon", "Binaries", "Win64");
  assert.deepEqual(await h.c.startInstall(), { ok: true });
  assert.ok(existsSync(path.join(win64, "MysticParadox.dll")));
  assert.deepEqual(await h.c.play(), { ok: true });
  const base = h.spawns[0].env?.MYSTICPARADOX_API_BASE ?? "";
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d+)$/.exec(base)?.[1]);
  assert.ok(port > 0 && port !== 61000, base);
  h.child()!.emit("exit", 0);
  await new Promise((r) => setTimeout(r, 50));
});

test("signing out removes the stored sign-in; signing in by username brings it back", async () => {
  const h = harness(firstUserData);
  await opened(h);
  assert.deepEqual(await h.c.logout(), { ok: true });
  assert.equal(h.last().phase, "register");
  assert.equal((await h.c.signIn("slayer42", "wrong-password")).ok, false);
  assert.equal(h.last().lastError?.code, "login_failed");
  assert.deepEqual(await h.c.signIn("slayer42", "hunter2hunter2"), { ok: true, username: "Slayer42" });
  assert.equal(h.last().account.signedIn, true);
});

test("without a valid invite code the account waits for the host's approval", async () => {
  const h = harness();
  await h.c.init();
  await h.c.submitInvite(invite(BACKEND_PORT, cert.fingerprint, "WRONG-CODE"));
  const r = await h.c.register("Borealis", "password123");
  assert.equal(r.ok, false);
  assert.equal(h.last().lastError?.code, "invite_invalid");
  assert.equal(h.last().account.signedIn, false);
});

test("a server with another certificate gets nothing", async () => {
  const before = mystic.calls.length;
  const h = harness();
  await h.c.init();
  await h.c.submitInvite(invite(OTHER_PORT, cert.fingerprint));
  assert.equal(h.last().phase, "connect");
  assert.equal(h.last().connect.problem, "cert_mismatch");
  assert.equal(mystic.calls.length, before, "no request reached the server");
});
