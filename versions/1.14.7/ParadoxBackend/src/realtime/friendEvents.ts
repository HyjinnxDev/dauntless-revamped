/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { GetRepositories } from "../persistence";
import { sessionRegistry } from "./SessionRegistry";
import { escapeXml } from "./xml";

export const XMPP_DOMAIN = "prod.ol.epicgames.com";

// Epic friends-service XMPP push, parsed by the client's FOnlineFriendsMcp::OnXmppMessageReceived.
// Without it the other player only sees an invite/accept/removal on their next friends-list fetch.
export function PushFriendEvent(to: string, type: "Friend" | "FriendRemoval", payload: Record<string, unknown>) {
    const body = escapeXml(JSON.stringify({
        payload,
        type: `com.epicgames.friends.core.apiobjects.${type}`,
        timestamp: new Date().toISOString()
    }));
    for (const conn of sessionRegistry.connectionsFor(to)) {
        conn.send(`<message from="xmpp-admin@${XMPP_DOMAIN}" to="${escapeXml(to)}@${XMPP_DOMAIN}"><body>${body}</body></message>`);
    }
}

// [Revamped 2026-10-17] Friends are shared by every character of an account (src/characterSlots.ts) and
// each friend shows as the character they launched last. On a switch, online friends swap the old id for
// the new one so presence, whispers and party invites reach the character now playing.
// ponytail: untested in game whether the client toasts the removal; drop it if it does.
export async function AnnounceCharacterSwitch(oldId: string, newId: string) {
    for (const edge of await GetRepositories().friendships.listForOwner(newId)) {
        if (edge.status === "BLOCKED") continue;
        PushFriendEvent(edge.otherId, "FriendRemoval", { accountId: oldId, reason: "DELETED" });
        const direction = edge.direction === "INBOUND" ? "OUTBOUND" : edge.direction === "OUTBOUND" ? "INBOUND" : undefined;
        PushFriendEvent(edge.otherId, "Friend", { accountId: newId, status: edge.status, direction: direction ?? "OUTBOUND", created: edge.created, favorite: false });
    }
}
