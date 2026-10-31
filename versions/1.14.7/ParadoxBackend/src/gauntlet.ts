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
import { AddCurrency } from "./controllers/wallet";

// Gauntlet seasons and level access (gauntlet-prod.steelyard.ca), 2026-10-21.
// Contract from the 1.14.7 exe (OnlineSubsystemPhoenix serializers, all wrapped {code, message, payload}):
//   GET  /config                                   -> {gauntlet_id, start_at, end_at, each_level_rewards[], milestone_rewards[]}
//   GET  /progression/level_access/{id}?account_id=A&account_id=B -> a bare int (same int reader as personal_progression)
//   GET  /progression/{id}/{account}               -> {personal_progression, guild_progression}
//   PUT  /process_run (GauntletEndedLevelEndpoint, seen 2026-10-31) <- {gauntlet_id, players[], level, remaining_sec, data{}}
// Retail rules (fandom wiki "Gauntlet"): clearing a level unlocks the next; a party may only queue a level every member
// has unlocked; 3+ guildmates clearing a level unlock it for the whole guild ([Revamped] 2026-10-31: any guildmate counts).
// A season is the hunt pass window (huntPassRotation.ts, two weeks); progress is keyed by that window, so it resets with it.
// ponytail: the client carries Season 01-05 content (wiki); only season 1 is verified in game. GAUNTLET_SEASON pins one.
const GAUNTLET_SEASONS = 5;
const GUILD_UNLOCK_MEMBERS = 1;
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

// Highest level a party may queue: every member must have the level unlocked, so the weakest member decides.
// The client reads this as "highest unlocked" (0 blocked level 1 in game, 2026-10-21), so it is highest cleared + 1.
export const PartyLevelAccess = (MemberCleared: number[]) => (MemberCleared.length ? Math.min(...MemberCleared) : 0) + 1;

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

// Retail (wiki Gauntlet): a Crest for the first clear of level 1 and of every 5th level, spent in the Research Lab.
// ponytail: paid only when the milestone raises the player's season best; a milestone first cleared below an earlier
// best (reached through a guild unlock) pays nothing. Track cleared levels per player if that matters.
export const IsCrestMilestone = (Level: number) => Level === 1 || Level % 5 === 0;
// Guild bonus Crests (wiki: extra Crests for milestone levels cleared as a guild). [Revamped 2026-10-31] Paid straight to every
// current member, +1 per milestone the guild's season best newly passes, instead of the Research Lab Progress-tab claim
// (its payload shape is unknown). ponytail: members who join later get nothing for milestones already passed.
export const MilestonesPassed = (Before: number, After: number) => {
    let N = 0;
    for (let L = Before + 1; L <= After; L++) if (IsCrestMilestone(L)) N++;
    return N;
};

// A level success from the game server. Clears only ever raise a best ($max), so repeats are harmless.
export async function RecordGauntletClear(Body: any, NowMs = Date.now()): Promise<string> {
    const Season = GauntletSeason(NowMs);
    const Level = NormalizeGauntletLevel(Body?.level);
    const Players = Array.isArray(Body?.players) ? [...new Set(Body.players.filter((P: unknown) => typeof P === "string" && P.length > 0 && P.length <= 128) as string[])] : [];
    if (Body?.gauntlet_id !== Season.id) return `ignored: season '${Body?.gauntlet_id}' is not current '${Season.id}'`;
    if (Level === undefined || Players.length === 0 || Players.length > 4) return `ignored: level=${Body?.level} players=${Players.length}`;
    const C = await Cols();
    const At = new Date(NowMs);
    const Crested: string[] = [];
    for (const Player of Players) {
        const Before = await C.Clears.findOneAndUpdate({ _id: `${Season.index}:${Player}` }, { $max: { best: Level }, $set: { updatedAt: At }, $setOnInsert: { season: Season.index, accountId: Player } }, { upsert: true, returnDocument: "before" });
        // The atomic before-image makes a repeat or concurrent clear of the same level pay nothing.
        if (IsCrestMilestone(Level) && Level > (Before?.best ?? 0)) {
            await AddCurrency(Player, "CURRENCY_GAUNTLET_COIN", 1);
            Crested.push(Player);
        }
    }
    const Guilds = GuildsUnlocking(await GuildsOf(C, Players), Players);
    const GuildCrests: string[] = [];
    for (const Guild of Guilds) {
        const Before = await C.GuildClears.findOneAndUpdate({ _id: `${Season.index}:${Guild}` }, { $max: { best: Level }, $set: { updatedAt: At }, $setOnInsert: { season: Season.index, guildId: Guild } }, { upsert: true, returnDocument: "before" });
        const Bonus = MilestonesPassed(Before?.best ?? 0, Level);
        if (Bonus === 0) continue;
        const Members = await C.Members.find({ guildId: Guild }, { projection: { _id: 1 } }).toArray();
        for (const Member of Members) await AddCurrency(Member._id, "CURRENCY_GAUNTLET_COIN", Bonus);
        GuildCrests.push(`${Guild}+${Bonus}x${Members.length}`);
    }
    logger.info(`[Gauntlet] clear ${Season.id} level=${Level} players=${Players.join(",")}${Guilds.length ? ` guild unlock=${Guilds.join(",")}` : ""}${Crested.length ? ` crest=${Crested.join(",")}` : ""}${GuildCrests.length ? ` guild crest=${GuildCrests.join(",")}` : ""}`);
    return "recorded";
}
