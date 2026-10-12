// Every call to the server goes over TLS pinned to the invite's fingerprint: status, accounts, the
// runtime release, the content probe and the downloads.
// Ports: 62420 fake backend (TLS), 62421 fake content server (TLS).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { CertificatePinError, pinnedConnect } from "../src/main/pinned";
import { request, HttpError, type Endpoint } from "../src/main/http";
import { fetchRuntimeRelease, fetchServerStatus, login, parseRuntimeRelease, probeContent, refreshSession, registerAccount } from "../src/main/hostapi";
import { DownloadError, DownloadJob } from "../src/main/downloader";
import { validateManifest, type GameManifest } from "../src/main/manifest";
import { createServer, FakeContentServer, FakeMystic, makeFiles, manifestFor, TEST_BUILD } from "./fakes";
import { makeTestCert, type TestCert } from "./certs";

const META_PORT = 62420;
const CONTENT_TLS_PORT = 62421;
const TOKEN = "acc-test";
const DEVICE = { deviceId: "11111111-1111-4111-8111-111111111111", deviceName: "test" };

let cert: TestCert;
let other: TestCert;
let mystic: FakeMystic;
let backend: http.Server;
let content: FakeContentServer;
const files = makeFiles();
const manifest: GameManifest = (() => {
  const r = validateManifest(manifestFor(files), TEST_BUILD, false);
  if (!r.ok) throw new Error(r.reason);
  return r.manifest;
})();

const metaEp = (): Endpoint => ({ host: "127.0.0.1", port: META_PORT, pin: cert.fingerprint });
const contentEp = (pin?: string): Endpoint => ({ host: "127.0.0.1", port: CONTENT_TLS_PORT, pin: pin ?? cert.fingerprint });

before(async () => {
  cert = makeTestCert();
  other = makeTestCert();
  mystic = new FakeMystic({ inviteCodes: new Set(["GOOD-CODE"]) });
  mystic.addAccount("Aurora", "aurora-password");
  backend = createServer((req, res) => mystic.handle(req, res), { cert: cert.certPem, key: cert.keyPem });
  await new Promise<void>((resolve) => backend.listen(META_PORT, "127.0.0.1", resolve));
  content = new FakeContentServer({ key: TOKEN, files });
  await content.start(CONTENT_TLS_PORT, { cert: cert.certPem, key: cert.keyPem });
});

after(async () => {
  backend.closeAllConnections();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  await content.stop();
  cert.cleanup();
  other.cleanup();
});

test("pinnedConnect accepts the pinned certificate and refuses any other", async () => {
  const sock = await pinnedConnect({ host: "127.0.0.1", port: META_PORT, fingerprint: cert.fingerprint });
  assert.equal(sock.encrypted, true);
  sock.destroy();
  await assert.rejects(
    pinnedConnect({ host: "127.0.0.1", port: META_PORT, fingerprint: other.fingerprint }),
    (e: unknown) => e instanceof CertificatePinError && e.actual === cert.fingerprint,
  );
});

test("requests over the pin; a mismatch is an HttpError of kind pin; no pin is no request", async () => {
  const res = await request(metaEp(), "/launcher/v1/status", { timeoutMs: 5000, maxBytes: 65536 });
  assert.equal(res.status, 200);
  await assert.rejects(
    request({ ...metaEp(), pin: other.fingerprint }, "/launcher/v1/status", { timeoutMs: 5000, maxBytes: 65536 }),
    (e: unknown) => e instanceof HttpError && e.kind === "pin",
  );
  await assert.rejects(request({ ...metaEp(), pin: "" }, "/launcher/v1/status", { timeoutMs: 3000, maxBytes: 65536 }), (e: unknown) => e instanceof HttpError && e.kind === "bad_url");
});

test("status: ok for this game build, cert_mismatch with another fingerprint, bad_answer for another build", async () => {
  assert.deepEqual(await fetchServerStatus(metaEp()), { kind: "ok" });
  assert.deepEqual(await fetchServerStatus({ ...metaEp(), pin: other.fingerprint }), { kind: "cert_mismatch" });
  assert.deepEqual(await fetchServerStatus({ host: "127.0.0.1", port: 62429, pin: cert.fingerprint }, 2000), { kind: "unreachable" });
  mystic.opts.changelist = 392819;
  try {
    assert.deepEqual(await fetchServerStatus(metaEp()), { kind: "bad_answer" });
  } finally {
    mystic.opts.changelist = undefined;
  }
});

test("register, login and refresh over the pin; nothing is sent to a mismatching server", async () => {
  const before = mystic.calls.length;
  const refused = await registerAccount({ ...metaEp(), pin: other.fingerprint }, { username: "Borealis", password: "password123", inviteCode: "GOOD-CODE", ...DEVICE });
  assert.deepEqual(refused, { ok: false, error: "cert_mismatch" });
  assert.equal(mystic.calls.length, before, "the mismatching server never saw the password");

  const r = await registerAccount(metaEp(), { username: "Borealis", password: "password123", inviteCode: "GOOD-CODE", ...DEVICE });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.session.username, "Borealis");
  assert.deepEqual(await registerAccount(metaEp(), { username: "borealis", password: "password123", inviteCode: "GOOD-CODE", ...DEVICE }), { ok: false, error: "username_taken", detail: "AUTH_DISPLAY_NAME_TAKEN" });
  assert.deepEqual(await registerAccount(metaEp(), { username: "Nocode", password: "password123", inviteCode: null, ...DEVICE }), { ok: false, error: "approval_pending" });

  const l = await login(metaEp(), { identifier: "aurora", password: "aurora-password", ...DEVICE });
  assert.ok(l.ok && l.session.username === "Aurora");
  assert.deepEqual(await login(metaEp(), { identifier: "aurora", password: "nope", ...DEVICE }), { ok: false, error: "login_failed", detail: "AUTH_INVALID_CREDENTIALS" });

  // A refresh token works once; the same one again is refused (and the server revokes the family).
  if (!l.ok) return;
  const r1 = await refreshSession(metaEp(), l.session.refreshToken, DEVICE);
  assert.ok(r1.ok && r1.session.refreshToken !== l.session.refreshToken);
  assert.equal((await refreshSession(metaEp(), l.session.refreshToken, DEVICE)).ok, false);
});

test("the runtime release: only the core pair, downloaded from this server whatever URL the manifest names", async () => {
  const release = await fetchRuntimeRelease(metaEp());
  assert.ok("files" in release);
  if (!("files" in release)) return;
  assert.equal(release.version, "1.2.3");
  assert.deepEqual(release.files.map((f) => [f.name, f.path]), [
    ["MysticParadox.dll", "/launcher/v1/runtime/client/stable/windows-x86_64/download"],
    ["winmm.dll", "/launcher/v1/runtime/client/stable/windows-x86_64/extra/winmm.dll"],
  ]);
  const good = { version: "1.0.0", targetChangelist: 647472, sha256: "a".repeat(64), extraFiles: [{ name: "winmm.dll", sha256: "b".repeat(64) }] };
  assert.ok(parseRuntimeRelease(good));
  assert.equal(parseRuntimeRelease({ ...good, targetChangelist: 392819 }), null, "a runtime for another game build");
  assert.equal(parseRuntimeRelease({ ...good, extraFiles: [] }), null, "no loader");
  assert.equal(parseRuntimeRelease({ ...good, sha256: "zz" }), null);
});

test("content probe over the pin", async () => {
  assert.equal(await probeContent(contentEp()), true);
  assert.equal(await probeContent(contentEp(other.fingerprint)), false);
});

test("downloads over the pin: full install, resume with Range, then verify", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "df-dl-tls-"));
  try {
    content.requests.length = 0;
    const big = "Archon/Content/Paks/pakchunk0-WindowsNoEditor.pak";
    const data = files.find((f) => f.path === big)!.data;
    const target = path.join(dir, ...big.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target + ".part", data.subarray(0, 123_456));
    await new DownloadJob({ endpoint: contentEp(), auth: async () => TOKEN, installDir: dir, files: manifest.files, backoffMs: () => 20 }).run();
    for (const f of files) {
      const p = path.join(dir, ...f.path.split("/"));
      assert.ok(readFileSync(p).equals(f.data), f.path);
      assert.ok(!existsSync(p + ".part"));
    }
    const resumed = content.requests.find((r) => r.path === big);
    assert.equal(resumed?.range, "bytes=123456-");
    assert.equal(resumed?.status, 206);
    assert.ok(content.requests.every((r) => r.hadKey));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloads stop with session_expired when the sign-in is gone or refused", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "df-dl-tls-"));
  try {
    await assert.rejects(
      new DownloadJob({ endpoint: contentEp(), auth: async () => null, installDir: dir, files: manifest.files, backoffMs: () => 10 }).run(),
      (e: unknown) => e instanceof DownloadError && e.code === "session_expired",
    );
    await assert.rejects(
      new DownloadJob({ endpoint: contentEp(), auth: async () => "acc-wrong", installDir: dir, files: manifest.files, backoffMs: () => 10 }).run(),
      (e: unknown) => e instanceof DownloadError && e.code === "session_expired",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("downloads refuse a server whose certificate does not match, before any request", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "df-dl-tls-"));
  try {
    content.requests.length = 0;
    await assert.rejects(
      new DownloadJob({ endpoint: contentEp(other.fingerprint), auth: async () => TOKEN, installDir: dir, files: manifest.files, backoffMs: () => 10 }).run(),
      (e: unknown) => e instanceof DownloadError && e.code === "cert_mismatch",
    );
    // Only requests with this job's valid token count: the previous test's refused requests may still land.
    assert.equal(content.requests.filter((r) => r.hadKey).length, 0, "the token never reached the server");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
