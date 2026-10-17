// Invite strings for Dauntless 1.14.7 servers (Mystic Paradox backend):
//
//   dauntless-revamped://join?v=1&host=<IPv4 or DNS name>&port=<backend HTTPS port, default 443>
//     &fp=<SHA-256 of the backend's TLS certificate (DER), 64 lower-case hex>&code=<invite code>
//     &name=<url-encoded server name>
//
// The host may be a Tailscale address or a public one: every connection is TLS pinned to fp either
// way, so a self-signed certificate is fine and nothing is ever sent to a server with another one.
// The same string arrives pasted or through the dauntless-revamped: protocol handler. It is parsed
// strictly, because the host, port and fingerprint decide where the account password is sent later.

import { UNSAFE_CHAR } from "./text";

// Its own scheme, so it never takes over the links of a Dauntless Forever 1.4.4 launcher on the same PC.
export const INVITE_SCHEME = "dauntless-revamped";
// The scheme of this launcher's Dauntless Forever releases: links already shared with it keep working.
export const LEGACY_INVITE_SCHEME = "dauntless-forever-1147";
export const DEFAULT_PORT = 443;

export interface Invite {
  host: string;
  port: number;
  code: string;
  name: string;
  fp: string; // the pinned certificate fingerprint
}

export type InviteError = "empty" | "too_long" | "not_invite" | "version" | "params" | "host" | "port" | "fp" | "code" | "name";

export type InviteResult = { ok: true; invite: Invite } | { ok: false; error: InviteError };

const MAX_INVITE_LENGTH = 2048;

const ALLOWED = new Set(["v", "host", "port", "fp", "code", "name"]);
const REQUIRED: InviteError[] = ["host", "fp", "code", "name"];

export function isValidIPv4(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

// IPv4, or a DNS name made of [a-z0-9.-]. Names that a resolver could read as a number
// ("1.2.3", "0x7f.1", "host.123") are refused.
export function isValidHost(host: string): boolean {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) return false;
  if (/^[0-9.]+$/.test(host)) return isValidIPv4(host);
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  const labels = host.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  if (/^0x/i.test(labels[labels.length - 1])) return false;
  return true;
}

export function isValidPort(text: string): boolean {
  if (!/^[1-9][0-9]{0,4}$/.test(text)) return false;
  const n = Number(text);
  return n >= 1 && n <= 65535;
}

export function isValidInviteCode(code: string): boolean {
  return /^[A-Za-z0-9-]{4,64}$/.test(code);
}

// SHA-256 of the certificate's DER bytes, as 64 lower-case hex characters.
export function isValidFingerprint(fp: unknown): fp is string {
  return typeof fp === "string" && /^[0-9a-f]{64}$/.test(fp);
}

// Server names are shown to the friend, always as text (never as HTML).
export function cleanServerName(raw: string): string | null {
  // Control characters, and bidirectional overrides that could disguise the name.
  if (UNSAFE_CHAR.test(raw)) return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 1 || Array.from(name).length > 64) return null;
  return name;
}

export function parseInvite(input: unknown): InviteResult {
  if (typeof input !== "string") return { ok: false, error: "empty" };
  const text = input.trim();
  if (text.length === 0) return { ok: false, error: "empty" };
  if (text.length > MAX_INVITE_LENGTH) return { ok: false, error: "too_long" };

  const prefix = /^(?:dauntless-revamped|dauntless-forever-1147):\/\/join\/?\?/i.exec(text);
  if (!prefix) return { ok: false, error: "not_invite" };
  const query = text.slice(prefix[0].length);
  if (query.includes("#")) return { ok: false, error: "params" };

  // Parse by hand so that duplicates and unknown keys can be refused.
  const values = new Map<string, string>();
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return { ok: false, error: "params" };
    const key = pair.slice(0, eq);
    if (!ALLOWED.has(key) || values.has(key)) return { ok: false, error: "params" };
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    } catch {
      return { ok: false, error: "params" };
    }
    values.set(key, value);
  }

  if (values.get("v") !== "1") return { ok: false, error: "version" };
  for (const key of REQUIRED) if (!values.has(key)) return { ok: false, error: key };

  const host = (values.get("host") as string).toLowerCase();
  if (!isValidHost(host)) return { ok: false, error: "host" };

  let port = DEFAULT_PORT;
  if (values.has("port")) {
    const portText = values.get("port") as string;
    if (!isValidPort(portText)) return { ok: false, error: "port" };
    port = Number(portText);
  }

  const fp = values.get("fp") as string;
  if (!isValidFingerprint(fp)) return { ok: false, error: "fp" };

  const code = values.get("code") as string;
  if (!isValidInviteCode(code)) return { ok: false, error: "code" };

  const name = cleanServerName(values.get("name") as string);
  if (name === null) return { ok: false, error: "name" };

  return { ok: true, invite: { host, port, code, name, fp } };
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || /^127\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host);
}

// Tailscale hands out addresses from 100.64.0.0/10.
export function isTailscaleIPv4(host: string): boolean {
  if (!isValidIPv4(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

// A MagicDNS name: <machine>.<tailnet>.ts.net.
export function isTailnetHost(host: string): boolean {
  return isTailscaleIPv4(host) || (isValidHost(host) && host.endsWith(".ts.net") && host.split(".").length >= 3);
}

// Builds an invite string (used by tests and by scripts/make-invite.mjs).
export function formatInvite(invite: Invite): string {
  if (!isValidFingerprint(invite.fp)) throw new Error("invites need a certificate fingerprint");
  const parts = ["v=1", `host=${encodeURIComponent(invite.host)}`, `port=${invite.port}`, `fp=${invite.fp}`];
  parts.push(`code=${encodeURIComponent(invite.code)}`, `name=${encodeURIComponent(invite.name)}`);
  return `${INVITE_SCHEME}://join?${parts.join("&")}`;
}
