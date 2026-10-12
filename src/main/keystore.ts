// Sign-in sessions, one per server, stored only through Electron safeStorage (DPAPI on Windows).
// What is kept is the backend's refresh token: it never goes to the renderer, rotates on every use
// (hostapi.refreshSession), and dies with "Sign out". The password itself is never stored.
//
// A session is tied to the certificate fingerprint it was made with. An invite for the same
// host:port with another fingerprint (a rebuilt server, or someone in the middle) cannot load it:
// it moves to a new fingerprint only through rebind(), after the user confirmed.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isValidFingerprint } from "../shared/invite";
import { addSecret, removeSecret } from "./log";

export interface Encryptor {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export class KeyStoreError extends Error {
  constructor(public readonly code: "unavailable" | "invalid") {
    super(code);
    this.name = "KeyStoreError";
  }
}

export function serverId(host: string, port: number): string {
  return createHash("sha256").update(`${host}:${port}`).digest("hex").slice(0, 24);
}

export interface KeySlot {
  host: string;
  port: number;
  fp: string; // the certificate fingerprint the session belongs to
}

// The backend's refresh tokens are 64 hex characters (security/launcherTokens.ts).
export function isPlausibleRefreshToken(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}

// What is inside a session file after decryption: "DFS1\n<fingerprint>\n<refresh token>".
const FORMAT = "DFS1";

interface Stored {
  token: string;
  fp: string;
}

export class KeyStore {
  constructor(private readonly dir: string, private readonly crypto: Encryptor) {}

  private file(slot: Pick<KeySlot, "host" | "port">): string {
    return path.join(this.dir, `${serverId(slot.host, slot.port)}.session`);
  }

  private async read(slot: Pick<KeySlot, "host" | "port">): Promise<Stored | null> {
    let data: Buffer;
    try {
      data = await fsp.readFile(this.file(slot));
    } catch {
      return null;
    }
    if (!this.crypto.isAvailable()) throw new KeyStoreError("unavailable");
    let text: string;
    try {
      text = this.crypto.decrypt(data);
    } catch {
      return null; // encrypted by another Windows user or PC
    }
    const parts = text.split("\n");
    if (parts.length !== 3 || parts[0] !== FORMAT || !isValidFingerprint(parts[1]) || !isPlausibleRefreshToken(parts[2])) return null;
    return { fp: parts[1], token: parts[2] };
  }

  async has(slot: KeySlot): Promise<boolean> {
    return (await this.load(slot).catch(() => null)) !== null;
  }

  async save(slot: KeySlot, token: string): Promise<void> {
    if (!isPlausibleRefreshToken(token) || !isValidFingerprint(slot.fp)) throw new KeyStoreError("invalid");
    if (!this.crypto.isAvailable()) throw new KeyStoreError("unavailable");
    addSecret(token);
    await fsp.mkdir(this.dir, { recursive: true });
    const target = this.file(slot);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, this.crypto.encrypt(`${FORMAT}\n${slot.fp}\n${token}`));
    await fsp.rename(tmp, target);
  }

  // The refresh token for this slot, or null. Returned only for the exact certificate it was saved with.
  async load(slot: KeySlot): Promise<string | null> {
    const stored = await this.read(slot);
    if (!stored || stored.fp !== slot.fp) return null;
    addSecret(stored.token);
    return stored.token;
  }

  // Whether a session is stored for this host:port, and which certificate it belongs to. null = none.
  async certificateOf(slot: Pick<KeySlot, "host" | "port">): Promise<{ fp: string } | null> {
    const stored = await this.read(slot).catch(() => null);
    return stored ? { fp: stored.fp } : null;
  }

  // Moves this host:port's session to a new certificate. Only after the user confirmed the change.
  async rebind(slot: Pick<KeySlot, "host" | "port">, fp: string): Promise<boolean> {
    if (!isValidFingerprint(fp)) throw new KeyStoreError("invalid");
    const stored = await this.read(slot);
    if (!stored) return false;
    await this.save({ ...slot, fp }, stored.token);
    return true;
  }

  async remove(slot: Pick<KeySlot, "host" | "port">): Promise<void> {
    const stored = await this.read(slot).catch(() => null);
    if (stored) removeSecret(stored.token);
    await fsp.unlink(this.file(slot)).catch(() => undefined);
  }
}
