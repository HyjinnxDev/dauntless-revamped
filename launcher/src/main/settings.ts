// Launcher settings in userData/settings.json. No secrets in here: the sign-in lives in the KeyStore.

import { randomUUID } from "node:crypto";
import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { isValidFingerprint, isValidHost, isValidInviteCode, cleanServerName } from "../shared/invite";
import { isValidUsername } from "../shared/username";
import { GAME_LANGUAGES, LANGUAGES, type GameLanguage, type Language } from "../shared/types";

export interface StoredServer {
  host: string;
  port: number;
  name: string;
  fp: string; // pinned certificate fingerprint
  code: string | null; // invite code not used yet
}

export interface StoredSettings {
  version: 1;
  deviceId: string; // sent with sign-ins so the server can tell this PC's sessions apart (not secret)
  server: StoredServer | null;
  savedServers: StoredServer[]; // servers joined before, to switch back without the invite
  installDir: string | null; // null = the default folder
  verifiedDir: string | null; // the folder whose files were last fully checked or downloaded
  windowed: boolean;
  streamerMode: boolean; // hide addresses, fingerprints, paths and player names on screen
  language: Language;
  gameLanguage: GameLanguage;
  usernames: Record<string, string>; // per server id, for display only
}

export function defaultSettings(language: Language): StoredSettings {
  return {
    version: 1,
    deviceId: randomUUID(),
    server: null,
    savedServers: [],
    installDir: null,
    verifiedDir: null,
    windowed: false,
    streamerMode: false,
    language,
    gameLanguage: "auto",
    usernames: {},
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validDir(v: unknown): string | null {
  if (typeof v !== "string" || v.length <= 3 || v.length >= 200 || v.includes("\0")) return null;
  return /^[A-Za-z]:[\\/]/.test(v) && path.win32.isAbsolute(v) ? v : null;
}

export const MAX_SAVED_SERVERS = 20;

function sanitizeServer(sv: unknown): StoredServer | null {
  if (!isObject(sv)) return null;
  const name = typeof sv.name === "string" ? cleanServerName(sv.name) : null;
  const hostOk = typeof sv.host === "string" && isValidHost(sv.host);
  const portOk = Number.isInteger(sv.port) && (sv.port as number) >= 1 && (sv.port as number) <= 65535;
  // A server without a valid fingerprint is dropped: it could never be reached safely.
  if (!hostOk || !portOk || !isValidFingerprint(sv.fp) || !name) return null;
  return {
    host: sv.host as string,
    port: sv.port as number,
    name,
    fp: sv.fp,
    code: typeof sv.code === "string" && isValidInviteCode(sv.code) ? sv.code : null,
  };
}

// The same server (and the same sign-in slot): host and port.
export function sameServer(a: StoredServer, b: StoredServer): boolean {
  return a.host === b.host && a.port === b.port;
}

export function sanitizeSettings(raw: unknown, language: Language): StoredSettings {
  const s = defaultSettings(language);
  if (!isObject(raw)) return s;
  if (typeof raw.deviceId === "string" && /^[0-9a-f-]{36}$/.test(raw.deviceId)) s.deviceId = raw.deviceId;
  s.server = sanitizeServer(raw.server);
  if (Array.isArray(raw.savedServers)) {
    for (const entry of raw.savedServers) {
      const sv = sanitizeServer(entry);
      if (sv && !s.savedServers.some((o) => sameServer(o, sv)) && s.savedServers.length < MAX_SAVED_SERVERS) s.savedServers.push(sv);
    }
  }
  // The current server is always in the list, as it is now (a newer invite or name replaces the old entry).
  if (s.server) {
    const current = s.server;
    const i = s.savedServers.findIndex((o) => sameServer(o, current));
    if (i >= 0) s.savedServers[i] = { ...current };
    else s.savedServers.unshift({ ...current });
    s.savedServers = s.savedServers.slice(0, MAX_SAVED_SERVERS);
  }
  s.installDir = validDir(raw.installDir);
  s.verifiedDir = validDir(raw.verifiedDir);
  s.windowed = raw.windowed === true;
  s.streamerMode = raw.streamerMode === true;
  if (LANGUAGES.includes(raw.language as Language)) s.language = raw.language as Language;
  if (GAME_LANGUAGES.includes(raw.gameLanguage as GameLanguage)) s.gameLanguage = raw.gameLanguage as GameLanguage;
  if (isObject(raw.usernames)) {
    for (const [k, v] of Object.entries(raw.usernames)) if (/^[0-9a-f]{24}$/.test(k) && isValidUsername(v)) s.usernames[k] = v;
  }
  return s;
}

export class SettingsStore {
  private data: StoredSettings;
  private readonly file: string;
  // One write at a time: overlapping writes shared settings.json.tmp, so a rename could fail or leave broken JSON.
  private writing: Promise<unknown> = Promise.resolve();

  constructor(dir: string, language: Language) {
    this.file = path.join(dir, "settings.json");
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      raw = null;
    }
    this.data = sanitizeSettings(raw, language);
  }

  get(): StoredSettings {
    return this.data;
  }

  async update(fn: (s: StoredSettings) => void): Promise<StoredSettings> {
    const copy: StoredSettings = JSON.parse(JSON.stringify(this.data));
    fn(copy);
    this.data = sanitizeSettings(copy, copy.language);
    const text = JSON.stringify(this.data, null, 2);
    const write = this.writing.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, text);
      await fsp.rename(tmp, this.file);
    });
    this.writing = write.catch(() => undefined);
    await write;
    return this.data;
  }
}
