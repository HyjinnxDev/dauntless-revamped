/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Revamped)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [hide-and-seek 2026-10-17] Private hide-and-seek rounds for a party. HIDESEEK_ENABLED=1 turns it on.
//   "!hideseek" in party chat arms the party (the game client strips a leading "/", so "/hideseek" arrives as plain
//   text; a "/" that does arrive is accepted too): its next hunt launch (controllers/matchmaking.ts) asks the Director
//   for GameMode HIDESEEK, a random Hunting Grounds island running the round (ParadoxRuntime MpHideSeekTick).
//   "!hideseek off" disarms. The island's server posts what happens and the round's state to POST /hideseek/v1/event
//   (gameserver API key): text is shown in that party's chat, the state is read by the players' clients.

import { Request, Response, Router } from "express";
import { IsValidGameserverAPIKey } from "./controllers/apikeys";
import { logger } from "./logger";
import { roomService } from "./realtime/RoomService";

const ARM_TTL_MS = 30 * 60 * 1000;
const Armed = new Map<string, number>();     // partyId -> armed until (epoch ms)
const Servers = new Map<number, string>();   // island port -> partyId

export const HideSeekEnabled = () => process.env.HIDESEEK_ENABLED?.trim() === "1";

/** A party chat line that is a !hideseek command -> the reply to show the party; undefined = not a command. */
export function HideSeekCommand(roomLocal: string, body: string, now = Date.now()): string | undefined {
    const Text = body.trim().toLowerCase().replace(/^\//, "!");
    if (!HideSeekEnabled() || !roomLocal.startsWith("Party-") || (Text !== "!hideseek" && Text !== "!hideseek off")) return undefined;
    const PartyId = roomLocal.slice("Party-".length);
    if (Text === "!hideseek off") {
        Armed.delete(PartyId);
        return "Hide and seek cancelled.";
    }
    Armed.set(PartyId, now + ARM_TTL_MS);
    return "Hide and seek is ready! The party leader picks any hunt or island to start a round on a random Hunting Grounds island. !hideseek off cancels.";
}

/** True once per arming: the caller is launching this party's island. */
export function TakeHideSeek(partyId: string, now = Date.now()): boolean {
    const Until = Armed.get(partyId);
    Armed.delete(partyId);
    return Until !== undefined && Until > now && HideSeekEnabled();
}

export function TrackHideSeekServer(port: number, partyId: string): void {
    Servers.set(port, partyId);
    Rounds.delete(port);
    logger.info(`[HideSeek] party ${partyId} round on port ${port}`);
}

// The island's round as its server last reported it; the players' clients read it (GET /hideseek/v1/state) for the
// on-screen timer, counters, seeker outlines and the automatic return.
const PHASES = ["waiting", "hiding", "seeking", "over"] as const;
export interface Round {
    phase: typeof PHASES[number];
    endsAt: number;                 // epoch ms the phase's timer runs out (over: the return to Ramsgate)
    seekers: string[];              // player names
    hiders: string[];
    alertId: number;
    alert: string;
    updatedAt: number;
}
const Rounds = new Map<number, Round>();   // island port -> round
const STALE_MS = 30000;                    // the server reports every 2 s; silence = it is gone

function Names(Value: unknown): string[] | undefined {
    if (!Array.isArray(Value) || Value.length > 8) return undefined;
    return Value.every((N) => typeof N === "string" && N.length > 0 && N.length <= 64 && !/[\t\r\n]/.test(N)) ? Value : undefined;
}

/** Plain "key=value" lines for the runtime (no JSON parser there); names are tab separated. */
export function RoundStateText(R: Round, Name: string, Now: number): string {
    return [
        `phase=${R.phase}`,
        `left=${Math.max(0, Math.ceil((R.endsAt - Now) / 1000))}`,
        `role=${R.seekers.includes(Name) ? "seeker" : "hider"}`,
        `hiders=${R.hiders.length}`,
        `seekers=${R.seekers.length}`,
        `seekernames=${R.seekers.join("\t")}`,
        `alert=${R.alertId}\t${R.alert}`,
    ].join("\n") + "\n";
}

export const hideSeekRouter = Router();

// From the island's server: {port, text?, end?, state?: {phase, left, seekers, hiders}}. text goes to party chat and
// becomes the on-screen alert.
hideSeekRouter.post("/hideseek/v1/event", async (req: Request, res: Response) => {
    const Key = req.headers["x-mysticparadox-gameserver-apikey"];
    if (typeof Key !== "string" || !(await IsValidGameserverAPIKey(Key))) {
        res.status(401).send();
        return;
    }
    const Port = Number(req.body?.port);
    const Text = req.body?.text;
    const State = req.body?.state;
    const Seekers = Names(State?.seekers), Hiders = Names(State?.hiders), Left = Number(State?.left);
    if (!Number.isInteger(Port) || (Text !== undefined && (typeof Text !== "string" || Text.length === 0 || Text.length > 300))
        || (State !== undefined && (!PHASES.includes(State.phase) || !Number.isInteger(Left) || Left < 0 || Left > 3600 || !Seekers || !Hiders))) {
        res.status(400).send();
        return;
    }
    const PartyId = Servers.get(Port);
    if (PartyId === undefined) {
        res.status(404).send();
        return;
    }
    const Now = Date.now();
    const Prev = Rounds.get(Port);
    const R: Round = Prev ?? { phase: "waiting", endsAt: Now, seekers: [], hiders: [], alertId: 0, alert: "", updatedAt: Now };
    if (State !== undefined) Object.assign(R, { phase: State.phase, endsAt: Now + Left * 1000, seekers: Seekers, hiders: Hiders });
    if (typeof Text === "string") {
        roomService.systemMessage(`Party-${PartyId}`, Text);
        R.alertId += 1;
        R.alert = Text.replace(/[\t\r\n]/g, " ");
    }
    R.updatedAt = Now;
    Rounds.set(Port, R);
    if (req.body?.end === true) Servers.delete(Port);   // the round stays readable until it goes stale
    res.status(204).send();
});

// From a player's client: its round by player name (names are unique launcher display names), 404 = none.
// ponytail: unauthenticated and by name; a round only exposes names and timers already visible in game.
hideSeekRouter.get("/hideseek/v1/state", (req: Request, res: Response) => {
    const Name = typeof req.query.name === "string" ? req.query.name : "";
    const Now = Date.now();
    for (const [Port, R] of Rounds) {
        if (Now - R.updatedAt > STALE_MS) { Rounds.delete(Port); continue; }
        if (Name.length > 0 && (R.seekers.includes(Name) || R.hiders.includes(Name))) {
            res.type("text/plain").send(RoundStateText(R, Name, Now));
            return;
        }
    }
    res.status(404).send();
});
