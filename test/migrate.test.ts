import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateUserData, OLD_USER_DATA_NAME } from "../src/main/migrate";

test("the Dauntless Forever launcher's data is copied once, without caches, and its default game folder is kept", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dr-migrate-"));
  const appData = path.join(root, "Roaming");
  const local = path.join(root, "Local");
  const oldDir = path.join(appData, OLD_USER_DATA_NAME);
  const newDir = path.join(appData, "Dauntless Revamped Launcher");
  mkdirSync(path.join(oldDir, "sessions"), { recursive: true });
  mkdirSync(path.join(oldDir, "Cache"));
  mkdirSync(path.join(local, "DauntlessForever1147", "Game"), { recursive: true });
  writeFileSync(path.join(oldDir, "settings.json"), JSON.stringify({ version: 1, installDir: null, language: "fi" }));
  writeFileSync(path.join(oldDir, "Local State"), "key");
  writeFileSync(path.join(oldDir, "sessions", "a.bin"), "secret");

  assert.equal(migrateUserData(appData, local, newDir), "copied");
  const s = JSON.parse(readFileSync(path.join(newDir, "settings.json"), "utf8"));
  assert.equal(s.installDir, path.join(local, "DauntlessForever1147", "Game"));
  assert.equal(s.language, "fi");
  assert.equal(readFileSync(path.join(newDir, "Local State"), "utf8"), "key");
  assert.equal(readFileSync(path.join(newDir, "sessions", "a.bin"), "utf8"), "secret");
  assert.equal(existsSync(path.join(newDir, "Cache")), false);
  assert.equal(existsSync(`${newDir}.migrating`), false);

  // Second start: the new folder exists, nothing is copied over it.
  writeFileSync(path.join(newDir, "settings.json"), "{}");
  assert.equal(migrateUserData(appData, local, newDir), "none");
  assert.equal(readFileSync(path.join(newDir, "settings.json"), "utf8"), "{}");
});

test("a chosen game folder is left as it is, and nothing happens without an old launcher", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dr-migrate-"));
  const oldDir = path.join(root, OLD_USER_DATA_NAME);
  mkdirSync(oldDir);
  mkdirSync(path.join(root, "DauntlessForever1147", "Game"), { recursive: true });
  writeFileSync(path.join(oldDir, "settings.json"), JSON.stringify({ installDir: "D:\Games\Dauntless" }));
  assert.equal(migrateUserData(root, root, path.join(root, "new")), "copied");
  assert.equal(JSON.parse(readFileSync(path.join(root, "new", "settings.json"), "utf8")).installDir, "D:\Games\Dauntless");
  assert.equal(migrateUserData(path.join(root, "nothing"), root, path.join(root, "new2")), "none");
});
