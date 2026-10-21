/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { logger } from "./logger";
import { GetMongoDb } from "./persistence/mongo/client";
import { Collections } from "./persistence/mongo/collections";
import { ActiveSeasonWindow, HuntPassRotationIndex } from "./huntPassRotation";

// Gauntlet seasons and level access (gauntlet-prod.steelyard.ca), 2026-10-21.
// Contract from the 1.14.7 exe (OnlineSubsystemPhoenix serializers, all wrapped {code, message, payload}):
//   GET  /config                                   -> {gauntlet_id, start_at, end_at, each_level_rewards[], milestone_rewards[]}
//   GET  /progression/level_access/{id}?account_id=A&account_id=B -> a bare int (same int reader as personal_progression)
//   GET  /progression/{id}/{account}               -> {personal_progression, guild_progression}
//   POST GauntletEndedLevelEndpoint (path unseen)  <- {gauntlet_id, players[], level, remaining_sec, data{}}
// Retail rules (fandom wiki "Gauntlet"): clearing a level unlocks the next; a party may only queue a level every member
// has unlocked; 3+ guildmates clearing a level unlock it for the whole guild.
// A season is the hunt pass window (huntPassRotation.ts, 60 days); progress is keyed by that window, so it resets with it.
// ponytail: the client carries Season 01-05 content (wiki); only season 1 is verified in game. GAUNTLET_SEASON pins one.
const GAUNTLET_SEASONS = 5;
const GUILD_UNLOCK_MEMBERS = 3;
// CombineGauntletSeasonAndLevelNumber: season 1 level 1 arrives as 10000001.
const COMBINED_LEVEL_BASE = 10_000_000;

export function GauntletSeason(NowMs = Date.now()) {
    const Index = HuntPassRotationIndex(NowMs);
    const Pinned = Number(process.env.GAUNTLET_SEASON);
    const Number_ = Number.isInteger(Pinned) && Pinned >= 1 ? Pinned : (Index % GAUNTLET_SEASONS) + 1;
    const Window = ActiveSeasonWindow(NowMs);
    return { index: Index, id: `ESC_SEASON_${Number_}`, start_at: Window.start, end_at: Window.end };
}

export function NormalizeGauntletLevel(Level: unknown): number | undefined {
    const N = Number(Level);
    if (!Number.isInteger(N) || N <= 0 || N > 0x7fffffff) return undefined;
    return N >= COMBINED_LEVEL_BASE ? N % COMBINED_LEVEL_BASE || undefined : N;
}

// Highest cleared level a party may build on: every member must have the level unlocked, so the weakest member decides.
// ponytail: replies "highest cleared" (0 = only level 1), which matches level 1 launching while the stub sent nothing.
// If the level select turns out to read it as "highest unlocked", reply PartyLevelAccess(...) + 1.
export const PartyLevelAccess = (MemberAccess: number[]) => (MemberAccess.length ? Math.min(...MemberAccess) : 0);

// Guilds with enough members in one clear to unlock that level guild-wide.
export function GuildsUnlocking(GuildOfPlayer: Map<string, string>, Players: string[]): string[] {
    const Count = new Map<string, number>();
    for (const Player of new Set(Players)) {
        const Guild = GuildOfPlayer.get(Player);
        if (Guild) Count.set(Guild, (Count.get(Guild) ?? 0) + 1);
    }
    return [...Count].filter(([, N]) => N >= GUILD_UNLOCK_MEMBERS).map(([Guild]) => Guild);
}

type ClearDoc = { _id: string, season: number, accountId: string, best: number, updatedAt: Date };
type GuildClearDoc = { _id: string, season: number, guildId: string, best: number, updatedAt: Date };

async function Cols() {
    const Db = await GetMongoDb();
    return {
        Clears: Db.collection<ClearDoc>(Collections.GauntletClears),
        GuildClears: Db.collection<GuildClearDoc>(Collections.GauntletGuildClears),
        Members: Db.collection<{ _id: string, guildId: string }>(Collections.GuildMembers)
    };
}

async function GuildsOf(C: Awaited<ReturnType<typeof Cols>>, Accounts: string[]) {
    const Rows = await C.Members.find({ _id: { $in: Accounts } }, { projection: { guildId: 1 } }).toArray();
    return new Map(Rows.map((Row) => [Row._id, Row.guildId]));
}

// Personal and guild best for each account this season.
export async function GetGauntletProgress(Accounts: string[], NowMs = Date.now()) {
    const Season = GauntletSeason(NowMs).index;
    const C = await Cols();
    const Guilds = await GuildsOf(C, Accounts);
    const Personal = new Map((await C.Clears.find({ _id: { $in: Accounts.map((A) => `${Season}:${A}`) } }).toArray()).map((Row) => [Row.accountId, Row.best]));
    const GuildBest = new Map((await C.GuildClears.find({ _id: { $in: [...new Set(Guilds.values())].map((G) => `${Season}:${G}`) } }).toArray()).map((Row) => [Row.guildId, Row.best]));
    return new Map(Accounts.map((A) => {
        const Guild = Guilds.get(A);
        return [A, { personal: Personal.get(A) ?? 0, guild: Guild ? GuildBest.get(Guild) ?? 0 : 0 }];
    }));
}

export async function GetPartyLevelAccess(Accounts: string[]) {
    const Progress = await GetGauntletProgress(Accounts);
    return PartyLevelAccess([...Progress.values()].map((P) => Math.max(P.personal, P.guild)));
}

// A level success from the game server. Clears only ever raise a best ($max), so repeats are harmless.
export async function RecordGauntletClear(Body: any, NowMs = Date.now()): Promise<string> {
    const Season = GauntletSeason(NowMs);
    const Level = NormalizeGauntletLevel(Body?.level);
    const Players = Array.isArray(Body?.players) ? [...new Set(Body.players.filter((P: unknown) => typeof P === "string" && P.length > 0 && P.length <= 128) as string[])] : [];
    if (Body?.gauntlet_id !== Season.id) return `ignored: season '${Body?.gauntlet_id}' is not current '${Season.id}'`;
    if (Level === undefined || Players.length === 0 || Players.length > 4) return `ignored: level=${Body?.level} players=${Players.length}`;
    const C = await Cols();
    const At = new Date(NowMs);
    for (const Player of Players) {
        await C.Clears.updateOne({ _id: `${Season.index}:${Player}` }, { $max: { best: Level }, $set: { updatedAt: At }, $setOnInsert: { season: Season.index, accountId: Player } }, { upsert: true });
    }
    const Guilds = GuildsUnlocking(await GuildsOf(C, Players), Players);
    for (const Guild of Guilds) {
        await C.GuildClears.updateOne({ _id: `${Season.index}:${Guild}` }, { $max: { best: Level }, $set: { updatedAt: At }, $setOnInsert: { season: Season.index, guildId: Guild } }, { upsert: true });
    }
    logger.info(`[Gauntlet] clear ${Season.id} level=${Level} players=${Players.join(",")}${Guilds.length ? ` guild unlock=${Guilds.join(",")}` : ""}`);
    return "recorded";
}
