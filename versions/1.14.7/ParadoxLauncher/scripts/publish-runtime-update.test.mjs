// node --test scripts/publish-runtime-update.test.mjs
// Runs the real publish script against throwaway Ed25519 keys in a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./publish-runtime-update.mjs", import.meta.url));

test("signs every file with --key, refuses a published version, applies --base-url to extras", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-runtime-"));
  const key = (name) => {
    const pair = generateKeyPairSync("ed25519");
    writeFileSync(join(dir, name), pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    return pair.publicKey;
  };
  const pubA = key("a.pem");
  const pubB = key("b.pem");
  mkdirSync(join(dir, "in"));
  const dll = join(dir, "in", "MysticParadox.dll");
  const winmm = join(dir, "in", "winmm.dll");
  writeFileSync(dll, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100, 7)]));
  writeFileSync(winmm, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(50, 3)]));

  const publish = (version, keyName, baseUrl, extra = []) => execFileSync("node", [script,
    "--dll", dll, "--extra", winmm, "--version", version, "--target", "client", "--output", join(dir, "out"),
    "--base-url", baseUrl, "--key", join(dir, keyName), ...extra], { stdio: "pipe" });
  const latest = () => JSON.parse(readFileSync(join(dir, "out/runtime/client/stable/windows-x86_64/latest.json"), "utf8"));
  const assertSignedBy = (manifest, publicKey) => {
    assert.ok(verify(null, readFileSync(dll), publicKey, Buffer.from(manifest.signature, "base64")));
    assert.ok(verify(null, readFileSync(winmm), publicKey, Buffer.from(manifest.extraFiles[0].signature, "base64")));
  };

  publish("0.0.1", "a.pem", "https://one.test");
  const first = latest();
  assertSignedBy(first, pubA);

  publish("0.0.2", "a.pem", "https://one.test");
  assert.equal(latest().signature, first.signature, "same key and file give the same signature");

  assert.throws(() => publish("0.0.2", "a.pem", "https://one.test"), /already published/);
  publish("0.0.2", "a.pem", "https://one.test", ["--force"]);

  // Key rotation + new base URL with unchanged files: nothing may keep the old key's signature or URL.
  publish("0.0.3", "b.pem", "https://two.test");
  const rotated = latest();
  assertSignedBy(rotated, pubB);
  assert.ok(rotated.extraFiles[0].url.startsWith("https://two.test/"));
});
