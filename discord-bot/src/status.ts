/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [forever-discord] Server status in a Discord channel name, e.g. "🟢 Online · 12 slayers" / "🔴 Offline".
// Runs in the bot, outside the backend, so it can still report the backend being down.
// Polls the backend's /health/ready every minute; offline after 2 failed polls in a row (a quick restart doesn't flap).
// Discord allows 2 channel renames per 10 minutes, so the name changes at most every 5 minutes.
// Env: DISCORD_STATUS_CHANNEL_ID (use a voice channel: text channel names can't hold spaces or capitals),
// BACKEND_HEALTH_URL. The bot needs Manage Channels on that channel.

const POLL_MS = 60 * 1000;
const RENAME_GAP_MS = 5 * 60 * 1000;
const FAILS_FOR_OFFLINE = 2;

export function StatusName(players: number | null): string {
    if (players === null) return "🔴 Offline";
    return `🟢 Online · ${players} ${players === 1 ? "slayer" : "slayers"}`;
}

async function Discord(token: string, path: string, init: RequestInit = {}): Promise<any> {
    const Res = await fetch(`https://discord.com/api/v10${path}`, {
        ...init,
        headers: { authorization: `Bot ${token}`, "content-type": "application/json", "user-agent": "DauntlessRevamped (status, 1.0)" },
        signal: AbortSignal.timeout(10000),
    });
    if (!Res.ok) throw new Error(`Discord answered ${Res.status} ${await Res.text()}`);
    return Res.json();
}

async function Players(url: string): Promise<number | null> {
    try {
        const Res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!Res.ok) return null;
        return Number((await Res.json()).players) || 0;
    } catch {
        return null;
    }
}

export async function RunStatus(token: string, channel: string, url: string): Promise<never> {
    // Name unknown (Discord unreachable at start) = the first poll renames.
    let Current: string = await Discord(token, `/channels/${channel}`).then((C) => C.name, (error) => {
        console.warn(`[Status] channel not read: ${error}`);
        return "";
    });
    let LastRename = 0;
    let Fails = 0;
    let LastPlayers: number | null = 0;
    console.log(`[Status] watching ${url}, channel is "${Current}"`);

    for (;;) {
        const Count = await Players(url);
        Fails = Count === null ? Fails + 1 : 0;
        if (Count !== null) LastPlayers = Count;
        else if (Fails >= FAILS_FOR_OFFLINE) LastPlayers = null;
        const Wanted = StatusName(LastPlayers);
        if (Wanted !== Current && Date.now() - LastRename >= RENAME_GAP_MS) {
            try {
                await Discord(token, `/channels/${channel}`, { method: "PATCH", body: JSON.stringify({ name: Wanted }) });
                console.log(`[Status] "${Current}" -> "${Wanted}"`);
                Current = Wanted;
                LastRename = Date.now();
            } catch (error) {
                console.warn(`[Status] rename failed: ${error}`);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}
