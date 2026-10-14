// Calls to the invite's server: the Mystic Paradox backend's launcher API (/launcher/v1/*) and its
// content routes (/content/v1/*). Every request goes over the TLS connection pinned to the invite's
// certificate (http.ts). Passwords, refresh tokens and access tokens go nowhere else.

import { Endpoint, HttpError, HttpResponse, parseJsonBody, request } from "./http";
import { cleanText } from "../shared/status";
import type { ErrorCode, NewsItem } from "../shared/types";
import { CONNECT_TIMEOUT_MS, TARGET_CHANGELIST } from "./constants";
import { UNSAFE_CHARS_MULTILINE } from "../shared/text";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPin(e: unknown): boolean {
  return e instanceof HttpError && e.kind === "pin";
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------- errors

export type ApiFailure = { ok: false; error: ErrorCode; detail?: string };

// The backend answers errors as { error: { code, message } } (security/launcherErrors.ts).
const CODE_MAP: Record<string, ErrorCode> = {
  AUTH_INVALID_CREDENTIALS: "login_failed",
  AUTH_DISPLAY_NAME_TAKEN: "username_taken",
  AUTH_EMAIL_TAKEN: "email_taken",
  AUTH_INVITE_INVALID: "invite_invalid",
  AUTH_VALIDATION_FAILED: "bad_request",
  AUTH_RATE_LIMITED: "rate_limited",
  AUTH_ACCOUNT_BANNED: "account_banned",
  AUTH_ACCOUNT_DISABLED: "account_banned",
  AUTH_APPROVAL_PENDING: "approval_pending",
  AUTH_APPROVAL_REJECTED: "account_banned",
  AUTH_REFRESH_INVALID: "session_expired",
  AUTH_UNAUTHORIZED: "session_expired",
  GAME_BUILD_UNSUPPORTED: "game_files_invalid",
  RUNTIME_BUILD_UNSUPPORTED: "runtime_rejected",
  AUTH_CHANNEL_MISMATCH: "runtime_rejected",
  AUTH_TESTER_REQUIRED: "runtime_rejected",
};

export function apiFailure(res: HttpResponse): ApiFailure {
  const body = parseJsonBody(res);
  const e = isObject(body) && isObject(body.error) ? body.error : null;
  const code = e && typeof e.code === "string" ? CODE_MAP[e.code] : undefined;
  const detail = e ? cleanText(e.message, 200) ?? undefined : undefined;
  if (code) return { ok: false, error: code, detail };
  if (res.status === 429) return { ok: false, error: "rate_limited" };
  return { ok: false, error: "server_error", detail };
}

function networkFailure(e: unknown): ApiFailure {
  return { ok: false, error: isPin(e) ? "cert_mismatch" : "server_unreachable" };
}

// ---------------------------------------------------------------- status

export type StatusResult =
  | { kind: "ok" } // a Mystic Paradox backend for this game build
  | { kind: "bad_answer" }
  | { kind: "cert_mismatch" } // the certificate is not the one from the invite
  | { kind: "unreachable" };

export async function fetchServerStatus(ep: Endpoint, timeoutMs = CONNECT_TIMEOUT_MS): Promise<StatusResult> {
  let res: HttpResponse;
  try {
    res = await request(ep, "/launcher/v1/status", { timeoutMs, maxBytes: 64 * 1024 });
  } catch (e) {
    return isPin(e) ? { kind: "cert_mismatch" } : { kind: "unreachable" };
  }
  const body = parseJsonBody(res);
  if (res.status !== 200 || !isObject(body) || body.supportedBuildChangelist !== TARGET_CHANGELIST) return { kind: "bad_answer" };
  // online:false = the server's database is down: reachable, but nothing will work yet.
  return body.online === true ? { kind: "ok" } : { kind: "unreachable" };
}

// ---------------------------------------------------------------- accounts

export interface Device {
  deviceId: string;
  deviceName: string;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  username: string;
}

export type SessionResult = { ok: true; session: Session } | ApiFailure;

function parseSession(res: HttpResponse): SessionResult {
  const body = parseJsonBody(res);
  if (!isObject(body) || typeof body.accessToken !== "string" || typeof body.refreshToken !== "string" || !isObject(body.account)) {
    return { ok: false, error: "server_error" };
  }
  const { displayName, userId } = body.account;
  if (typeof displayName !== "string" || !/^[A-Za-z0-9]{3,16}$/.test(displayName)) return { ok: false, error: "server_error" };
  if (typeof userId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(userId)) return { ok: false, error: "server_error" };
  if (body.accessToken.length > 4096 || !/^[0-9a-f]{64}$/.test(body.refreshToken)) return { ok: false, error: "server_error" };
  return { ok: true, session: { accessToken: body.accessToken, refreshToken: body.refreshToken, userId, username: displayName } };
}

async function postSession(ep: Endpoint, path: string, body: Record<string, unknown>): Promise<SessionResult> {
  let res: HttpResponse;
  try {
    res = await request(ep, path, { method: "POST", body: JSON.stringify(body), timeoutMs: 20000, maxBytes: 64 * 1024 });
  } catch (e) {
    return networkFailure(e);
  }
  // 202 = registered but waiting for the host's approval (no invite code, or none accepted).
  if (res.status === 202) return { ok: false, error: "approval_pending" };
  return res.status === 200 ? parseSession(res) : apiFailure(res);
}

export function registerAccount(ep: Endpoint, a: { username: string; password: string; inviteCode: string | null } & Device): Promise<SessionResult> {
  return postSession(ep, "/launcher/v1/auth/register", {
    displayName: a.username,
    password: a.password,
    ...(a.inviteCode ? { inviteCode: a.inviteCode } : {}),
    deviceId: a.deviceId,
    deviceName: a.deviceName,
  });
}

// identifier: a username, or the email of an account made with one.
export function login(ep: Endpoint, a: { identifier: string; password: string } & Device): Promise<SessionResult> {
  return postSession(ep, "/launcher/v1/auth/login", { email: a.identifier, password: a.password, deviceId: a.deviceId, deviceName: a.deviceName });
}

// Refresh tokens rotate: the answer carries a new one, and the old one is dead from then on.
export function refreshSession(ep: Endpoint, refreshToken: string, device: Device): Promise<SessionResult> {
  return postSession(ep, "/launcher/v1/auth/refresh", { refreshToken, ...device });
}

export async function logout(ep: Endpoint, accessToken: string): Promise<void> {
  await request(ep, "/launcher/v1/auth/logout", { method: "POST", headers: bearer(accessToken), body: "{}", timeoutMs: 5000, maxBytes: 4096 }).catch(() => undefined);
}

// ---------------------------------------------------------------- game session

export interface RuntimeArtifact {
  name: string;
  sha256: string;
}

// voice: the party voice relay's ticket and UDP port, when the server runs one.
export type ExchangeResult = { ok: true; exchangeCode: string; voice?: { ticket: string; port: number } } | ApiFailure;

// A one-time code (60 s) the game trades for its game token. The server checks the exe hash and the
// exact runtime release this launcher installed.
export async function requestGameSession(
  ep: Endpoint,
  accessToken: string,
  g: { executableSha256: string; runtimeVersion: string; runtimeArtifacts: RuntimeArtifact[] },
): Promise<ExchangeResult> {
  let res: HttpResponse;
  try {
    res = await request(ep, "/launcher/v1/game-sessions", {
      method: "POST",
      headers: bearer(accessToken),
      body: JSON.stringify({
        buildChangelist: TARGET_CHANGELIST,
        executableSha256: g.executableSha256,
        runtimeChannel: "stable",
        runtimeManifestVersion: g.runtimeVersion,
        runtimeArtifacts: g.runtimeArtifacts,
      }),
      timeoutMs: 15000,
      maxBytes: 64 * 1024,
    });
  } catch (e) {
    return networkFailure(e);
  }
  if (res.status !== 200) return apiFailure(res);
  const body = parseJsonBody(res);
  const code = isObject(body) && typeof body.exchangeCode === "string" ? body.exchangeCode : "";
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(code)) return { ok: false, error: "server_error" };
  const ticket = isObject(body) && typeof body.voiceTicket === "string" ? body.voiceTicket : "";
  const port = isObject(body) ? body.voicePort : undefined;
  const voiceOk = /^[A-Za-z0-9_.-]{20,4096}$/.test(ticket) && Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536;
  return voiceOk ? { ok: true, exchangeCode: code, voice: { ticket, port: port as number } } : { ok: true, exchangeCode: code };
}

// ---------------------------------------------------------------- runtime (MysticParadox.dll + winmm.dll)

export interface RuntimeFile {
  name: string;
  sha256: string;
  path: string; // where to download it on this server
}

export interface RuntimeRelease {
  version: string;
  files: RuntimeFile[];
}

const RUNTIME_BASE = "/launcher/v1/runtime/client/stable/windows-x86_64";
const SAFE_NAME = /^[A-Za-z0-9._-]{1,96}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// The published runtime release (ParadoxLauncher/scripts/publish-runtime-update.mjs). Only the core
// pair is installed; the server accepts that set without the optional co-op files.
// ponytail: trusts the release over the pinned connection and checks each file's SHA-256 against it;
// the Ed25519 signature is not checked (it needs the host's public key in the invite). Add it if
// runtime files ever come from somewhere other than the invite's own server.
export function parseRuntimeRelease(raw: unknown): RuntimeRelease | null {
  if (!isObject(raw) || typeof raw.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw.version)) return null;
  if (Number(raw.targetChangelist) !== TARGET_CHANGELIST || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256)) return null;
  const files: RuntimeFile[] = [{ name: "MysticParadox.dll", sha256: raw.sha256, path: `${RUNTIME_BASE}/download` }];
  if (!Array.isArray(raw.extraFiles)) return null;
  const winmm = raw.extraFiles.find((e) => isObject(e) && typeof e.name === "string" && e.name.toLowerCase() === "winmm.dll");
  if (!isObject(winmm) || typeof winmm.sha256 !== "string" || !SHA256.test(winmm.sha256) || !SAFE_NAME.test(winmm.name as string)) return null;
  files.push({ name: "winmm.dll", sha256: winmm.sha256, path: `${RUNTIME_BASE}/extra/winmm.dll` });
  return { version: raw.version, files };
}

export async function fetchRuntimeRelease(ep: Endpoint): Promise<RuntimeRelease | ApiFailure> {
  let res: HttpResponse;
  try {
    res = await request(ep, RUNTIME_BASE, { timeoutMs: 15000, maxBytes: 256 * 1024 });
  } catch (e) {
    return networkFailure(e);
  }
  if (res.status !== 200) return { ok: false, error: "runtime_unavailable" };
  return parseRuntimeRelease(parseJsonBody(res)) ?? { ok: false, error: "runtime_unavailable" };
}

export const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;

export async function downloadRuntimeFile(ep: Endpoint, file: RuntimeFile): Promise<Buffer | ApiFailure> {
  let res: HttpResponse;
  try {
    res = await request(ep, file.path, { timeoutMs: 120000, maxBytes: MAX_RUNTIME_BYTES });
  } catch (e) {
    return networkFailure(e);
  }
  return res.status === 200 ? res.body : { ok: false, error: "runtime_unavailable" };
}

// ---------------------------------------------------------------- content server

// Is game-file download switched on? (HEAD /content/v1/manifest)
export async function probeContent(ep: Endpoint): Promise<boolean> {
  try {
    const res = await request(ep, "/content/v1/manifest", { method: "HEAD", timeoutMs: 8000, maxBytes: 1024 });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function fetchContentManifest(ep: Endpoint): Promise<unknown | null> {
  try {
    const res = await request(ep, "/content/v1/manifest", { timeoutMs: 20000, maxBytes: 8 * 1024 * 1024 });
    return res.status === 200 ? parseJsonBody(res) ?? null : null;
  } catch {
    return null;
  }
}

export function cleanNewsBody(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const text = v
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARS_MULTILINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length === 0) return null;
  return text.length > 4000 ? text.slice(0, 4000) + "…" : text;
}

export function parseNews(raw: unknown): NewsItem[] {
  if (!isObject(raw) || !Array.isArray(raw.items)) return [];
  const items: NewsItem[] = [];
  for (const item of raw.items.slice(0, 30)) {
    if (!isObject(item)) continue;
    const title = cleanText(item.title, 120);
    const body = cleanNewsBody(item.body);
    if (title === null || body === null) continue;
    const t = typeof item.date === "string" ? Date.parse(item.date) : NaN;
    items.push({ date: Number.isFinite(t) ? new Date(t).toISOString() : null, title, body });
  }
  return items;
}

export async function fetchNews(ep: Endpoint, fallback: NewsItem[] = []): Promise<NewsItem[]> {
  try {
    const res = await request(ep, "/content/v1/news", { timeoutMs: 10000, maxBytes: 512 * 1024 });
    return res.status === 200 ? parseNews(parseJsonBody(res)) : fallback;
  } catch {
    return fallback;
  }
}

export interface BrandingIndex {
  backgrounds: { path: string; credit: string | null }[];
  accent: string | null;
}

const BRANDING_PATH = /^\/content\/v1\/branding\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}\.(jpg|jpeg|png|webp)$/i;

export function parseBranding(raw: unknown): BrandingIndex {
  const out: BrandingIndex = { backgrounds: [], accent: null };
  if (!isObject(raw)) return out;
  if (Array.isArray(raw.backgrounds)) {
    for (const b of raw.backgrounds.slice(0, 8)) {
      if (!isObject(b) || typeof b.url !== "string" || !BRANDING_PATH.test(b.url) || b.url.includes("..")) continue;
      out.backgrounds.push({ path: b.url, credit: cleanText(b.credit, 120) });
    }
  }
  if (typeof raw.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.accent)) out.accent = raw.accent.toLowerCase();
  return out;
}

export async function fetchBrandingIndex(ep: Endpoint): Promise<BrandingIndex> {
  try {
    const res = await request(ep, "/content/v1/branding", { timeoutMs: 10000, maxBytes: 64 * 1024 });
    return res.status === 200 ? parseBranding(parseJsonBody(res)) : { backgrounds: [], accent: null };
  } catch {
    return { backgrounds: [], accent: null };
  }
}

export type ImageType = "image/jpeg" | "image/png" | "image/webp";

// Decides the image type from its first bytes; the server's Content-Type is not trusted.
export function sniffImage(data: Buffer): ImageType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export const MAX_ART_BYTES = 15 * 1024 * 1024;

export async function fetchBrandingImage(ep: Endpoint, urlPath: string): Promise<{ type: ImageType; data: Buffer } | null> {
  if (!BRANDING_PATH.test(urlPath) || urlPath.includes("..")) return null;
  try {
    const res = await request(ep, urlPath, { timeoutMs: 30000, maxBytes: MAX_ART_BYTES });
    if (res.status !== 200) return null;
    const type = sniffImage(res.body);
    return type ? { type, data: res.body } : null;
  } catch {
    return null;
  }
}
