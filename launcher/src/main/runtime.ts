// The Mystic Paradox runtime pair (MysticParadox.dll and its winmm.dll loader) next to the game exe.
// Each server publishes its own release (its runtime is built for it); the launcher installs exactly
// that release's files, checked by SHA-256 and by an Ed25519 signature from a trusted key, and reports
// them when it asks for a game session.

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { hashFile } from "./verify";
import { WIN64_RELATIVE_DIR } from "./constants";
import { downloadRuntimeFile, type RuntimeArtifact, type RuntimeRelease } from "./hostapi";
import type { Endpoint } from "./http";

export class RuntimeError extends Error {
  // in_use: a running process has the old file loaded (on the host's PC: its own game servers).
  // signature: no trusted key signed this file.
  constructor(public readonly file: string, public readonly code: "download" | "hash" | "disk" | "in_use" | "signature", message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

// [Revamped 2026-11-03] FINDINGS M1: the runtime is native code in the game process, so a server's files must be
// signed. Trusted keys: the server's invite pk, the Revamped key below, and a key the player pinned on first use.
// The Revamped self-host key (ParadoxLauncher/.secrets/selfhost-runtime-update.private.pem), raw base64.
export const REVAMPED_RUNTIME_KEY = "GiARrtultkODd4LxMx2YxOOa3C83PO0lUW4TKU4e184=";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function runtimeKey(rawBase64: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawBase64, "base64")]), format: "der", type: "spki" });
}

export function signedByAny(data: Buffer, signatureBase64: string, keys: KeyObject[]): boolean {
  const signature = Buffer.from(signatureBase64, "base64");
  return signature.length === 64 && keys.some((key) => verify(null, data, key, signature));
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

// Downloads every file of the release that is not already installed with the right hash. Every file, installed or
// downloaded, must carry a signature from one of `keys`; nothing is written otherwise.
export async function installRuntime(ep: Endpoint, installDir: string, release: RuntimeRelease, keys: KeyObject[]): Promise<void> {
  const dir = win64Dir(installDir);
  await fsp.mkdir(dir, { recursive: true });
  for (const f of release.files) {
    const target = path.join(dir, f.name);
    if ((await hashFile(target).catch(() => "")) === f.sha256) {
      if (!signedByAny(await fsp.readFile(target), f.signature, keys)) throw new RuntimeError(f.name, "signature", "not signed by a trusted key");
      await unblock(target);
      continue;
    }
    const data = await downloadRuntimeFile(ep, f);
    if (!Buffer.isBuffer(data)) throw new RuntimeError(f.name, "download", data.error);
    if (createHash("sha256").update(data).digest("hex") !== f.sha256) throw new RuntimeError(f.name, "hash", "does not match the server's release");
    if (!signedByAny(data, f.signature, keys)) throw new RuntimeError(f.name, "signature", "not signed by a trusted key");
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
