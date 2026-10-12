import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLaunchArgs, describeLaunch, gameLocale, relayEnv } from "../src/main/launch";
import { relayPortOverride, settingsPatch } from "../src/main/ipc-validate";
import { sanitizeSettings, SettingsStore } from "../src/main/settings";

const CODE = "a".repeat(64);
const USER = "00000000-0000-4000-8000-000000000001";

test("launch arguments match the Mystic Paradox launcher's, with the code hidden from logs", () => {
  const args = buildLaunchArgs({ exchangeCode: CODE, userId: USER, username: "Slayer42", windowed: false, gameLocale: "de-DE" });
  for (const a of ["-DisableEOS", "-EpicPortal", "-NoEAC", "-AUTH_TYPE=exchangecode", "-epicapp=Archon", "-epicenv=Prod", "-epicsandboxid=jackal"]) assert.ok(args.includes(a), a);
  assert.ok(args.includes(`-AUTH_LOGIN=${USER}`));
  assert.ok(args.includes(`-AUTH_PASSWORD=${CODE}`));
  assert.ok(args.includes(`-epicaccountid=${USER}`));
  assert.ok(args.includes("-epicusername=Slayer42"));
  assert.ok(args.includes("-epiclocale=de-DE"));
  assert.ok(!args.includes("-windowed"));
  assert.ok(buildLaunchArgs({ exchangeCode: CODE, userId: USER, username: "Slayer42", windowed: true }).includes("-windowed"));
  assert.ok(!describeLaunch("x.exe", args).includes(CODE));
  // Anything that could break out of one argument is refused.
  assert.throws(() => buildLaunchArgs({ exchangeCode: "short", userId: USER, username: "Slayer42", windowed: false }));
  assert.throws(() => buildLaunchArgs({ exchangeCode: CODE, userId: USER, username: "Bad Name", windowed: false }));
  assert.throws(() => buildLaunchArgs({ exchangeCode: CODE, userId: "a b", username: "Slayer42", windowed: false }));
});

test("the runtime finds the relay through MYSTICPARADOX_API_BASE", () => {
  assert.deepEqual(relayEnv(61000), { MYSTICPARADOX_API_BASE: "http://127.0.0.1:61000" });
  assert.throws(() => relayEnv(0));
  assert.equal(relayPortOverride("62000"), 62000);
  assert.equal(relayPortOverride("80"), undefined);
});

test("game language auto follows the system when the game has text for it", () => {
  assert.equal(gameLocale("auto", "es-419"), "es-ES");
  assert.equal(gameLocale("auto", "fi-FI"), "en-US");
  assert.equal(gameLocale("fr-FR", "en-GB"), "fr-FR");
});

test("settings patches from the page keep only known keys and values", () => {
  assert.deepEqual(settingsPatch({ windowed: true, language: "fi" }), { windowed: true, language: "fi" });
  assert.equal(settingsPatch({ windowed: "yes" }), null);
  assert.equal(settingsPatch({ graphics: 3 }), null, "1.4.4 settings are gone");
  assert.equal(settingsPatch([]), null);
});

test("stored settings drop servers without a pinned certificate and keep a stable device id", async () => {
  const fp = "ab".repeat(32);
  const s = sanitizeSettings({ server: { host: "100.101.102.103", port: 443, name: "Hunts", fp, code: "ABCD-1234" }, savedServers: [{ host: "1.2.3.4", port: 443, name: "No pin" }] }, "en");
  assert.equal(s.server?.fp, fp);
  assert.deepEqual(s.savedServers.map((x) => x.host), ["100.101.102.103"]);
  const dir = mkdtempSync(path.join(tmpdir(), "df-settings-"));
  try {
    const store = new SettingsStore(dir, "en");
    await store.update((x) => (x.windowed = true));
    const id = store.get().deviceId;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(new SettingsStore(dir, "en").get().deviceId, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
