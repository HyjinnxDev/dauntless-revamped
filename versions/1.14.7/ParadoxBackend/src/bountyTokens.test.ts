import assert from "node:assert/strict";
import test from "node:test";
import { BankedBountyTokens, IsGameBountyTokenGrant } from "./controllers/inventory";

test("game server bounty token grants are dropped; other sources are not", () => {
    assert.equal(IsGameBountyTokenGrant("TOKEN_BOUNTY_DRAFT_PREMIUM", "UBountyComponent::OnClaimBountyComplete"), true);
    assert.equal(IsGameBountyTokenGrant("TOKEN_BOUNTY_DRAFT", "UBountyComponent::GrantDailyTokens"), true);
    assert.equal(IsGameBountyTokenGrant("CURRENCY_PRESTIGE", "UBountyComponent::OnClaimBountyComplete"), false);
    assert.equal(IsGameBountyTokenGrant("TOKEN_DAILY_CHALLENGE_DRAFT", "UBountyComponent::GrantDailyTokens"), false);
    assert.equal(IsGameBountyTokenGrant("TOKEN_BOUNTY_DRAFT", "Store"), false);
    assert.equal(IsGameBountyTokenGrant("TOKEN_BOUNTY_DRAFT", undefined), false);
});

// [Revamped 2026-10-29] Banked daily tokens: +10 a day up to 50; the first bank per character tops up to 50.
test("daily bounty tokens bank up to the cap without cutting", () => {
    assert.equal(BankedBountyTokens(3, false), 13);
    assert.equal(BankedBountyTokens(45, false), 50);
    assert.equal(BankedBountyTokens(70, false), 70);
    assert.equal(BankedBountyTokens(2, true), 50);
    assert.equal(BankedBountyTokens(80, true), 80);
});
