// Moving over from the Dauntless Forever 1.14.7 launcher (0.1.x), which had another app identity:
// its own AppData folder, Squirrel install and link scheme. Its data is copied once, on the first
// start of Dauntless Revamped, and its install is removed. The game files stay where they are.

import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OLD_USER_DATA_NAME = "Dauntless Forever 1.14.7 Launcher";
export const OLD_SQUIRREL_NAME = "DauntlessForever1147Launcher";
const OLD_DEFAULT_GAME = ["DauntlessForever1147", "Game"];
// Chromium caches and the lock of a running copy: rebuilt on their own, and the lock cannot be copied.
const SKIP = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "lockfile"]);

// Copies the old userData (settings, saved servers, sign-ins and the "Local State" key that decrypts
// them) into newDir while newDir has no settings.json yet: newDir itself may already exist, because
// Squirrel's install run starts the app once and Electron creates it. A game in the old default folder
// is kept there by writing that folder into the settings. Must run before the app is ready (before
// Chromium reads newDir). settings.json is written last, so an interrupted copy is retried next start.
export function migrateUserData(appData: string, localAppData: string, newDir: string): "copied" | "none" {
  const oldDir = path.join(appData, OLD_USER_DATA_NAME);
  const oldSettings = path.join(oldDir, "settings.json");
  const newSettings = path.join(newDir, "settings.json");
  if (existsSync(newSettings) || !existsSync(oldSettings)) return "none";
  cpSync(oldDir, newDir, { recursive: true, force: true, filter: (src) => src !== oldSettings && !SKIP.has(path.basename(src)) });
  const s = JSON.parse(readFileSync(oldSettings, "utf8"));
  const oldGame = path.join(localAppData, ...OLD_DEFAULT_GAME);
  if (s && typeof s === "object" && !s.installDir && existsSync(oldGame)) s.installDir = oldGame;
  const tmp = `${newSettings}.migrating`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, newSettings);
  return "copied";
}

// Uninstalls the old Squirrel install (shortcuts and program folder; its AppData is left alone).
// Resolves true once Update.exe has finished, false when there is nothing to remove.
export function uninstallOldLauncher(localAppData: string): Promise<boolean> {
  const updateExe = path.join(localAppData, OLD_SQUIRREL_NAME, "Update.exe");
  if (!existsSync(updateExe)) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const child = spawn(updateExe, ["--uninstall", "-s"], { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve(true));
  });
}
