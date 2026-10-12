// The Mystic Paradox runtime pair (MysticParadox.dll and its winmm.dll loader) next to the game exe.
// Each server publishes its own release (its runtime is built for it); the launcher installs exactly
// that release's files, checked by SHA-256, and reports them when it asks for a game session.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { hashFile } from "./verify";
import { WIN64_RELATIVE_DIR } from "./constants";
import { downloadRuntimeFile, type RuntimeArtifact, type RuntimeRelease } from "./hostapi";
import type { Endpoint } from "./http";

export class RuntimeError extends Error {
  // in_use: a running process has the old file loaded (on the host's PC: its own game servers).
  constructor(public readonly file: string, public readonly code: "download" | "hash" | "disk" | "in_use", message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

export function win64Dir(installDir: string): string {
  return path.join(installDir, ...WIN64_RELATIVE_DIR.split("/"));
}

// Clears the "downloaded from the internet" mark (the Zone.Identifier stream), like Unblock-File.
async function unblock(file: string): Promise<void> {
  await fsp.unlink(`${file}:Zone.Identifier`).catch(() => undefined);
}

// What is installed now, by name and hash (missing files are left out).
export async function installedRuntime(installDir: string, release: RuntimeRelease): Promise<RuntimeArtifact[]> {
  const out: RuntimeArtifact[] = [];
  for (const f of release.files) {
    try {
      out.push({ name: f.name, sha256: await hashFile(path.join(win64Dir(installDir), f.name)) });
    } catch {
      /* missing */
    }
  }
  return out;
}

export function runtimeMatches(installed: RuntimeArtifact[], release: RuntimeRelease): boolean {
  return release.files.every((f) => installed.some((i) => i.name === f.name && i.sha256 === f.sha256));
}

// Downloads every file of the release that is not already installed with the right hash.
export async function installRuntime(ep: Endpoint, installDir: string, release: RuntimeRelease): Promise<void> {
  const dir = win64Dir(installDir);
  await fsp.mkdir(dir, { recursive: true });
  for (const f of release.files) {
    const target = path.join(dir, f.name);
    if ((await hashFile(target).catch(() => "")) === f.sha256) {
      await unblock(target);
      continue;
    }
    const data = await downloadRuntimeFile(ep, f);
    if (!Buffer.isBuffer(data)) throw new RuntimeError(f.name, "download", data.error);
    if (createHash("sha256").update(data).digest("hex") !== f.sha256) throw new RuntimeError(f.name, "hash", "does not match the server's release");
    const tmp = `${target}.new`;
    try {
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, target);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => undefined);
      const code = (e as NodeJS.ErrnoException).code;
      throw new RuntimeError(f.name, code === "EPERM" || code === "EBUSY" ? "in_use" : "disk", (e as Error).message);
    }
    await unblock(target);
    if ((await hashFile(target)) !== f.sha256) throw new RuntimeError(f.name, "hash", "changed after writing (antivirus?)");
  }
}
