// Which links the launcher may open in the browser. The renderer never passes a URL: it names a
// target (an ExternalTarget), the main process picks the URL and checks it here before
// shell.openExternal.

import type { ExternalTarget } from "../shared/types";
import {
  MYSTIC_PARADOX_URL,
  PROJECT_CONTRIBUTORS_URL,
  PROJECT_LICENSE_URL,
  PROJECT_URL,
  REVIVED_CONTRIBUTORS_URL,
  REVIVED_URL,
  UPSTREAM_CONTRIBUTORS_URL,
  UPSTREAM_URL,
} from "./constants";

// Every target opens one fixed URL ("server_source" is the project's own source).
export type FixedTarget = Exclude<ExternalTarget, "server_source">;

const DISCORD_URL = "https://discord.gg/HpgNEmVbBb";

export const FIXED_LINKS: Readonly<Record<FixedTarget, string>> = Object.freeze({
  project_source: PROJECT_URL,
  project_license: PROJECT_LICENSE_URL,
  project_contributors: PROJECT_CONTRIBUTORS_URL,
  revived_source: REVIVED_URL,
  revived_contributors: REVIVED_CONTRIBUTORS_URL,
  upstream_source: UPSTREAM_URL,
  upstream_contributors: UPSTREAM_CONTRIBUTORS_URL,
  mystic_source: MYSTIC_PARADOX_URL,
  discord: DISCORD_URL,
});

// The URL of a fixed target, or null for anything else (a raw URL, an unknown name, "__proto__").
export function fixedLinkUrl(target: unknown): string | null {
  if (typeof target !== "string" || !Object.prototype.hasOwnProperty.call(FIXED_LINKS, target)) return null;
  return FIXED_LINKS[target as FixedTarget];
}

// On github.com only these exact pages.
const GITHUB_PAGES: ReadonlySet<string> = new Set([
  PROJECT_URL,
  PROJECT_LICENSE_URL,
  PROJECT_CONTRIBUTORS_URL,
  REVIVED_URL,
  REVIVED_CONTRIBUTORS_URL,
  UPSTREAM_URL,
  UPSTREAM_CONTRIBUTORS_URL,
  MYSTIC_PARADOX_URL,
]);

// Plain https without user info or an explicit port.
function parse(url: string): URL | null {
  if (typeof url !== "string" || url.length > 1024) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "") return null;
    return u;
  } catch {
    return null;
  }
}

export function isAllowedStaticUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  switch (u.hostname) {
    case "github.com":
      return GITHUB_PAGES.has(url);
    case "discord.gg":
      return url === DISCORD_URL;
    default:
      return false;
  }
}

export function isAllowedExternalUrl(url: string, _hostSourceUrl: string | null = null): boolean {
  return isAllowedStaticUrl(url);
}
