// The session store: a server's sign-in belongs to one certificate fingerprint.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KeyStore, KeyStoreError, type Encryptor, type KeySlot } from "../src/main/keystore";

const enc: Encryptor = {
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from("enc:" + Buffer.from(plain).toString("base64")),
  decrypt: (data) => {
    const s = data.toString();
    if (!s.startsWith("enc:")) throw new Error("not ours");
    return Buffer.from(s.slice(4), "base64").toString();
  },
};
const dirs: string[] = [];
function store(): { ks: KeyStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "df-sessions-"));
  dirs.push(dir);
  return { ks: new KeyStore(dir, enc), dir };
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const TOKEN = "cd".repeat(32);
const FP_A = "a1".repeat(32);
const FP_B = "b2".repeat(32);
const slot = (fp: string): KeySlot => ({ host: "100.101.102.103", port: 443, fp });

test("a session loads only for the certificate it was saved with", async () => {
  const { ks, dir } = store();
  await ks.save(slot(FP_A), TOKEN);
  assert.equal(await ks.load(slot(FP_A)), TOKEN);
  assert.equal(await ks.load(slot(FP_B)), null, "another certificate never gets the token");
  assert.equal(await ks.has(slot(FP_B)), false);
  assert.deepEqual(await ks.certificateOf(slot(FP_B)), { fp: FP_A });
  // Only the encrypted form is on disk.
  const raw = readFileSync(path.join(dir, readdirSync(dir)[0])).toString();
  assert.ok(!raw.includes(TOKEN));
});

test("rebind moves the session to a new certificate", async () => {
  const { ks } = store();
  await ks.save(slot(FP_A), TOKEN);
  assert.equal(await ks.rebind(slot(FP_A), FP_B), true);
  assert.equal(await ks.load(slot(FP_B)), TOKEN);
  assert.equal(await ks.load(slot(FP_A)), null);
  assert.equal(await store().ks.rebind(slot(FP_A), FP_B), false, "nothing to move");
  await assert.rejects(ks.rebind(slot(FP_B), "not-a-fingerprint"), KeyStoreError);
});

test("only a real refresh token and fingerprint are saved", async () => {
  const { ks } = store();
  await assert.rejects(ks.save(slot("ABC"), TOKEN), KeyStoreError);
  await assert.rejects(ks.save(slot(FP_A), "not-a-token"), KeyStoreError);
});

test("remove deletes the session whatever certificate it belongs to", async () => {
  const { ks } = store();
  await ks.save(slot(FP_A), TOKEN);
  await ks.remove(slot(FP_B));
  assert.equal(await ks.certificateOf(slot(FP_A)), null);
});
