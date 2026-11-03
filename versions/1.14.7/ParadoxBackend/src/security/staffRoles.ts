// Staff tiers for the /admin dashboard. "owner" is granted only by scripts/bootstrap_admin.ts
// (never through the API); owners also hold "admin" so older roles.includes("admin") checks
// (Discord admin sign-in, launcher policy) keep working.
const RANK: Record<string, number> = { moderator: 1, admin: 2, owner: 3 };

export type StaffPermission =
    | "players.read"        // player list, online list, audit log
    | "players.ban.timed"   // timed ban up to MODERATOR_MAX_BAN_HOURS
    | "players.access"      // permanent ban, disable, unban, approve/reject sign-ups
    | "players.roles"       // grant/revoke moderator, admin, tester
    | "players.delete"
    | "operations"
    | "servers.read"        // host/process metrics, game server list
    | "servers.control"     // stop game servers, restart Director/stack, read logs;

const MIN_RANK: Record<StaffPermission, number> = {
    "players.read": 1,
    "players.ban.timed": 1,
    "players.access": 2,
    "players.roles": 3,
    "players.delete": 3,
    "operations": 3,
    "servers.read": 1,
    "servers.control": 2
};

export const MODERATOR_MAX_BAN_HOURS = 7 * 24;

export function StaffRank(roles: readonly string[]): number {
    return Math.max(0, ...roles.map((Role) => RANK[Role] ?? 0));
}

export function HasStaffPermission(roles: readonly string[], permission: StaffPermission): boolean {
    return StaffRank(roles) >= MIN_RANK[permission];
}

// [Revamped 2026-10-19] Patreon name styles, picked per character in the launcher.
// [Revamped 2026-11-03] Game names carry no tags any more: the game caps a name at 20 characters,
// so "[Owner] [Legend] Hyjinnx" came out as "Hyj". The client DLL (StaffNameplates) reads staff
// tier and style from GET /mystic/name-tags instead and shows the tag on the plate's title line.
export const NAME_STYLES = ["wanderer", "scout", "slayer", "legend", "emerald"] as const;
export type NameStyle = typeof NAME_STYLES[number];

export const IsNameStyle = (value: unknown): value is NameStyle => NAME_STYLES.includes(value as NameStyle);

/** Styles this account may wear. ponytail: owners only while it's tested; map Patreon tiers here once linked. */
export function AllowedNameStyles(roles: readonly string[]): NameStyle[] {
    return roles.includes("owner") ? [...NAME_STYLES] : [];
}

export interface NameTag { tier?: "moderator" | "admin" | "owner"; style?: NameStyle }

/** Staff tier and worn style for the DLL's nameplates; style only while the account may still wear it. */
export function NameTagOf(roles: readonly string[], style: unknown): NameTag {
    const Tier = ([undefined, "moderator", "admin", "owner"] as const)[StaffRank(roles)];
    const Style = IsNameStyle(style) && AllowedNameStyles(roles).includes(style) ? style : undefined;
    return { ...(Tier ? { tier: Tier } : {}), ...(Style ? { style: Style } : {}) };
}

/** Strips old staff and style tags so a tagged name a client still caches finds the account. */
export const StripStaffNameTag = (name: string): string =>
    name.replace(/^(\[(Owner|Admin|Mod|Wanderer|Scout|Slayer|Legend|Emerald)\]\s*)+/i, "");

/** Staff may only act on accounts ranked strictly below them (a moderator can't ban an admin). */
export function CanActOn(actorRoles: readonly string[], targetRoles: readonly string[]): boolean {
    return StaffRank(actorRoles) > StaffRank(targetRoles);
}
