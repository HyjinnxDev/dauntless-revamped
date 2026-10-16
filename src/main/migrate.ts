// Moving over from the Dauntless Forever 1.14.7 launcher (0.1.x), which had another app identity:
// its own AppData folder, Squirrel install and link scheme. Its data is copied once, on the first
// start of Dauntless Revamped, and its install is removed. The game files stay where they are.

import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OLD_USER_DATA_NAME = "Dauntless Forever 1.14.7 Launcher";
export const OLD_SQUIRREL_NAME = "DauntlessForever1147Launcher";
const OLD_DEFAULT_GAME = ["DauntlessForever1147", "Game"];
// Chromium caches and the lock of a running copy: rebuilt on their own, and the lock cannot be copied.
const SKIP = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "lockfile"]);

// Copies the old userData (settings, saved servers, sign-ins and the "Local State" key that decrypts
// them) into newDir, if newDir does not exist yet. A game in the old default folder is kept there by
// writing that folder into the settings. Must run before the app is ready (before Chromium uses newDir).
export function migrateUserData(appData: string, localAppData: string, newDir: string): "copied" | "none" {
  const oldDir = path.join(appData, OLD_USER_DATA_NAME);
  if (existsSync(newDir) || !existsSync(oldDir)) return "none";
  const tmp = `${newDir}.migrating`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(oldDir, tmp, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
    const oldGame = path.join(localAppData, ...OLD_DEFAULT_GAME);
    const file = path.join(tmp, "settings.json");
    if (existsSync(file) && existsSync(oldGame)) {
      const s = JSON.parse(readFileSync(file, "utf8"));
      if (s && typeof s === "object" && !s.installDir) {
        s.installDir = oldGame;
        writeFileSync(file, JSON.stringify(s, null, 2));
      }
    }
    renameSync(tmp, newDir); // all or nothing: a half copy is never mistaken for a finished one
    return "copied";
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
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
