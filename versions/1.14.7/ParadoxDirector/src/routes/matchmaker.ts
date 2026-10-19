/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { Router } from "express";
import { logger } from "../logger";
import { HandleMatchmakingRequest } from "../controllers/matchmaker";
import { JoinPublicHunt } from "../controllers/gameservers";
import { GetP2PExtension } from "../extensions/p2p";
import express from "express";

export const matchmakingRouter = Router();

matchmakingRouter.post("/handle-matchmaking-for-player", express.json(), async (req, res) => {
    try {
        const GameMode = req.body.GameMode;
        const GameArgs = req.body.GameArgs;
        const HuntId = req.body.HuntId;
        const ExpectedPlayers = req.body.ExpectedPlayers;
        // Only an explicit false makes a hunt public (joinable mid-hunt); older callers stay private.
        const IsPrivate = req.body.IsPrivate !== false;

        const MatchmakingResult = await HandleMatchmakingRequest(GameMode, GameArgs, HuntId, ExpectedPlayers, IsPrivate);

        res.status(200);
        res.json(MatchmakingResult);
    } catch(Err: any) {
        // Final safety net: never let a spawn/capacity error become an unhandled rejection that could
        // take down the DeployServer process (the metagame treats a non-200 as a matchmaking failure).
        logger.error(`handle-matchmaking-for-player failed: ${Err?.message ?? Err}`);
        res.status(500);
        res.json({ error: "matchmaking_failed" });
    }
});

// [2026-10-19] Public matchmaking: a running public hunt the players can join now (200), or none (204).
matchmakingRouter.post("/join-public-hunt", express.json(), (req, res) => {
    const HuntId = req.body?.HuntId;
    const Players = req.body?.Players;
    if (typeof HuntId !== "string" || !Array.isArray(Players) || Players.length < 1 || Players.length > 4
        || Players.some((P: unknown) => typeof P !== "string" || P.length === 0)) {
        res.status(400).json({ error: "bad_request" });
        return;
    }
    const Joined = JoinPublicHunt(HuntId, Players);
    if (Joined == undefined) { res.status(204).send(); return; }
    res.status(200).json(Joined);
});

// Routes of the optional player-hosted hunt module (src/extensions; none without it).
GetP2PExtension().mountMatchmakerRoutes(matchmakingRouter);
