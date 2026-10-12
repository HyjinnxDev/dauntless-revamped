# Hunt Pass restoration plan

Status: initial economy implemented; remaining catalog expansion and client validation below are planned. Research: 12 October 2026. See [implemented behavior and rollout](hunt-pass-economy.md).

Restore gameplay-earned platinum, platinum purchases of Elite, and seasonal Hunt Pass rotation. Reuse existing XP, inventory, purchase, and entitlement systems. Preserve each pass's cosmetic tiers; adjust platinum rewards explicitly for the new economy.

## Recommended rules

| Rule | Proposed value |
| --- | --- |
| Main season | 6 weeks, UTC boundaries |
| Main Elite price | 950 platinum |
| Regular hunt earn | 10 platinum for each qualifying successful hunt |
| Escalation earn | 30 platinum for a qualifying completed run, replacing regular hunt payout |
| Earn limit | None per day, week, or season; each distinct qualifying completion pays |
| Main pass platinum rewards | 200 Basic + 750 Elite; completing both returns 950 |
| Real-money purchases | Unavailable; no platinum packs, checkout, or platform purchase grants |
| XP | Existing hunt/bounty/quest XP and rank calculation |
| Tier skips | Keep unavailable initially; `season09b_rank` already empty |
| Cosmetics | Permanent once earned; available only through their configured pass tracks |

These are proposed balance numbers, not historical prices. Platinum is repeatable gameplay income for both passes and the ordinary store. First Elite purchase costs 95 regular hunts or 32 completed Escalations, before Basic-track platinum; mixed play combines both earnings. Ten regular hunts earn 100 platinum, fifty earn 500, and one hundred earn 1,000. At an assumed 5–10 minutes per regular hunt including turnaround, 950 takes roughly 8–16 hours; measure actual play times before finalizing rates. A player completing the paid main pass recovers its cost; continued hunting funds store cosmetics and cosmetic/event passes. Platinum carries between seasons. Earnings continue after pass completion and while no pass is selected. No daily/weekly cap, diminishing returns, streak, or calendar wait. Remove earlier daily/weekly bonus proposal; one completion payout is simpler and supports long play sessions.

Qualifying hunt: successful non-training hunt, with player participation confirmed by authoritative game server. Count one completed hunt, not every part break, Escalation stage, inventory write, or bounty deletion. Failed/abandoned hunts do not qualify. Every participant who meets existing authoritative participation rules gets their own payout; do not split it across party. Completed Escalation pays 30 once for entire run, not 10 per stage plus another 30 at end. Verify run completion and authoritative mode identifier before enabling differentiated payout. Keep existing Hunt Pass XP independent of platinum. Show earn reason and amount through existing reward notification flow where supported.

## Ordinary store spending

Current `store_catalog.json` contains 202 offers, all with `platinumPrice: 0`; these are not historical price references. Assign explicit nonzero prices to ordinary cosmetic offers before turning earned platinum into store currency. Working price bands below are proposed starting values, subject to item review and measured hunt times:

| Purchase | Proposed starting price | Regular hunts at 10 platinum |
| --- | ---: | ---: |
| Small cosmetic: flare, banner piece, or dye | 250 | 25 |
| Individual weapon transmog or emote | 500 | 50 |
| Ordinary full armour cosmetic bundle | 1,000 | 100 |
| Main Elite pass | 950 | 95 |

Use explicit catalog prices and existing purchase/debit flow, not automatic pricing by ID prefix. Pass-exclusive items remain excluded from ordinary store regardless of price. Tutorial rewards stay free; gameplay vendors retain their existing Aetherdust/mark prices. For bundles also sold as individual pieces, review pricing and existing ownership behavior so player is not charged full bundle price for mostly owned items. Preserve existing purchase protections and no real-money platinum offers. Flat payout is first implementation; add further difficulty or duration scaling only if measured completion times reveal a material imbalance. Adjust earn rate or prices rather than introducing an earning cap.

## What already exists

| Existing implementation | Reuse / required change |
| --- | --- |
| `controllers/progressionconfig.ts` | Loads bundled paths or flat JSON files from `PROGRESSION_CONFIG_DIR`; validates requirements; `ACTIVE_HUNT_PASS` defaults to `season09b`. Extend with schedule selection, not another config loader. |
| `vendor/progression_config.json` | Ten paths, only one Hunt Pass: `season09b` / Rogue Elements. Rank 0 costs 0; ranks 1–50 cost 100 XP each. Existing platinum: Basic 200, Elite 400. End date currently 2085. |
| `controllers/progressionrank.ts` | `ComputeEarnedRanks`, `TotalXpToMaxRank`, premium gating; already matches client 1.4.4. Keep math unchanged. `xp_required` is incremental, not cumulative. |
| `controllers/realprogression.ts` | Stores account progression, earned/confirmed ranks, objectives, selected pass. Reuse grant and confirm routes. Add pass availability checks to selection and grants; selection currently accepts any configured progression path. |
| `controllers/bounties.ts` | Real bounty board persistence. Claim and abandonment share deletion path: do not pay platinum merely because a bounty was deleted. Keep bounty XP flow. |
| `routes/tuning.ts` | Hunt XP tuning route labeled stub, but returns multiplier 1, difficulty bias 1, max award 200. A label alone does not prove broken XP. Verify hunt/bounty/quest XP in game before changing anything. |
| `controllers/entitlements.ts` | Every account currently receives `season09b_premium,season_premium_any,season_free_any`. Remove default Elite grants; derive current Elite visibility from actual purchase ownership. |
| `controllers/freestore.ts` | Two-step purchase tokens, balance checks, transaction-bound debit/grants, account and character binding, replay protection already implemented. Positive numeric prices already work; no new checkout service needed. Current generic storefront requires `STORE=free` even though pricing engine supports debit. Add narrow pass-store availability independent of generic free storefront. |
| `vendor/store_catalog.json` | `season09b_pass` sells `season09b_premium` for 0; rank offers empty. Replace zero-price pass offer with scheduled 950-price offer. |
| `controllers/store.ts`, `routes/store.ts` | Actual balance comes from active character inventory when `BALANCE_FROM_INVENTORY=1` (default). Reuse `CURRENCY_PLATINUM_UNIV`. Keep existing character-bound balances for first release; completion deduplication and pass ownership remain account-wide. |
| `controllers/inventory.ts` | `ApplyInventoryTransactionInTx` and inventory transaction history. Reuse for earnings/debits; bind delivery to verified character. General overspend refusal currently opt-in, so paid pass path must always reject insufficient funds itself. |

Critical existing contract: **game server grants rank inventory rewards through `/inventory`; `ConfirmRank` does not grant items or currencies.** Existing in-game verification found each rank paid once. Optional `PROGRESSION_CONFIRM_ENTITLEMENTS` only handles permanent entitlements. Adding another payout in `ConfirmRank` would duplicate rewards. See [backend contract](findings/backend-contract.md#progression-on-our-server).

CodeGraph was queried first. Returned generated SDK widgets, not metagame flows; backend findings above came from non-indexed TypeScript/config and existing contract docs.

## Earning and purchasing implementation

1. Capture a real successful hunt event and identify stable hunt/run ID, account membership, participation, authoritative mode, and completion time. Hook existing authoritative completion handler if available. Otherwise add one authenticated game-server completion message; calculate reward amounts in metagame. Client never supplies an amount or reward eligibility. Inventory/progression requests alone are not proof of hunt success.
2. Add small account earn ledger with unique `(accountId, huntId)` completion receipt recording owned character, authoritative mode, awarded amount, and time. Escalation stages resolve to same run ID and only final successful completion is eligible. Use durable IDs, not a short replay timeout or identical-body hash. No calendar counters or periodic resets needed.
3. In one DB transaction, validate event, record receipt, award 10 regular or 30 completed-Escalation platinum through `ApplyInventoryTransactionInTx`, and record earn reason. Deterministic transaction ID, e.g. `platinum:hunt:<account>:<huntId>`. Failure rolls everything back. Retry, restart, and concurrent requests pay once for same completion; another distinct completion pays again without an earning limit. Payout rule must not depend on Elite ownership, pass XP, rank, or season expiry.
4. Purchase uses existing create/redeem flow. Resolve active scheduled offer server-side; check price, season availability, ownership, account, and bound character at issuance and redemption. Debit exactly 950, record pass occurrence ownership, grant appropriate season entitlement, redeem token atomically. Recheck ownership at redemption so two tokens cannot charge twice.
5. Derive `season_premium_any` for currently eligible purchased pass; never use it as authority for every pass. Preserve `season_free_any` for Basic. Old/current pass entitlements must not authorize another season.
6. Buying Elite after leveling retains XP and Basic claims. Existing claim flow then grants all earned, unclaimed Elite tiers once. Do not reset XP or advance confirmed premium ranks during purchase.

Account-wide completion receipt prevents same hunt paying again through another character. Delivery stays on event's owned character; purchase stays on token's character even if active character changes. Distinct legitimate hunts always earn; no character-based daily award exists to multiply. Account-wide progression must prevent claiming same pass tier on multiple characters. Do not introduce a second platinum wallet for this release.

## XP and rewards

Keep existing XP earning amounts, multiplier, cap, and rank computation until actual in-game checks establish a missing hook. Connect active pass selection to existing grants. No new XP curve, weekly XP cap, Elite XP bonus, or parallel credit to every pass.

| Pass format | Tiers | XP / tier | Total XP | Proposed price | Platinum payout |
| --- | ---: | ---: | ---: | ---: | --- |
| Classic main | 50 | 100 | 5,000 | 950 | Basic 200 + Elite 750 |
| Farslayer's Fall mini | 25 | 100 | 2,500 | 500 | Basic 100 + Elite 400 |
| Cosmetic | 30 | 100 | 3,000 | 950 | None; preserves single paid track |
| Slayer Commission | 100 | 100 | 10,000 | 950 | Basic 200 + Elite 750 |
| Paid event, 10 tiers | 10 | 100 unless source differs | 1,000 normally | 300 | None |
| Paid event, 15 tiers | 15 | 100 unless source differs | 1,500 normally | 500 | None |
| Paid event, 30 tiers | 30 | 100 unless source differs | 3,000 normally | 950 | None |
| Quest-unlocked event | Source-specific | Source-specific | Source-specific | 0; prerequisite quest | None |

Historical Unseen Neophyte exception: 15 tiers, 300 XP/tier = 4,500 XP; free behind Dark Harvest quest. Desperado's Duty and The Chronoslayer also require quests, not a platinum purchase. Do not turn those into paid passes. Quest assets and unlock conditions need client compatibility verification.

For 50-tier main passes, normalize platinum to Basic 50 at tiers **10, 25, 35, 45**, and Elite 75 at tiers **5, 10, 15, 20, 25, 30, 35, 40, 45, 50**. For mini, Basic 20 and Elite 80 at tiers **5, 10, 15, 20, 25**. Remove original platinum rows before adding replacement grants; preserve other items on those rows. For Commission, preserve historical 200/750 placement, subject to mapping. Cosmetic/event passes get no platinum overlay. These changes are intentional economy overrides, not faithful historical platinum values.

All other mapped rewards retain source track, tier, item identity, quantity, and grouping. Multiple armour pieces at one tier remain one grouped tier reward. Do not move Basic cosmetics behind Elite. No further tier platinum after max rank; unlimited hunt-completion platinum continues. Keep existing prestige math and supported prestige currency, but remove pass cosmetics from Vault/Reward Cache access. No additional prestige-to-platinum conversion needed because hunts already pay independently of XP.

Build checked-in definitions in existing path format: `progression_id`, `premium_gating_entitlement`, dates, incremental requirements, `free_rewards`, `premium_rewards`, optional prestige. Cosmetic/event definitions have a gated single track. Every reward needs verified catalog ID, stackability/instance form, entitlement duration where relevant, and client asset. Wiki display name is never a catalog ID. Resolve ambiguous dye/title/flare/sigil names by item type and source; aliases can share one real ID.

Unknown/missing reward IDs block that pass from schedule. Produce mapping report; never silently substitute Rams or invent IDs. Old resource names and quest rewards need explicit compatibility decisions. Original historical tables are research input; normalized checked-in definitions are runtime authority. No live wiki scraping in game.

Rogue Elements is first candidate: bundled `season09b` already provides actual reward IDs. Examples from [its reward list](https://dauntless.fandom.com/wiki/Hunt_Pass_Season:_Rogue_Elements): Basic tier 1 Thumbs Up / Rogue Operator; Elite tier 1 Seismic armour, tier 4 Peacemonger sword, tier 5 Arrival Impossible, tier 21 Fire In the Hole!, tier 45 Arrival Improbable, tier 50 Cyclops Rock / Hard Stop / Break Point / Grand Stand armour. Compare all 50 bundled rows with wiki before finalizing; source and bundled data may reflect different revisions.

## Seasons and item locking

Use explicit UTC schedule entries with unique occurrence ID, immutable pass definition/version, native client presentation ID, start/end, price, and any prerequisite. First occurrence: existing Rogue Elements, six weeks from chosen launch date. Then only passes whose complete rewards and UI were verified. Use themed windows later: Haunted Shadows around Dark Harvest, Frostfall around year-end, Saint's Bond around February, Overgrowth in another rotation window. No launch date assumed here.

One selected pass receives XP. Main Basic is available to everyone; premium claims require purchase. Owned cosmetic passes remain selectable/completable after sale window closes, matching their historical never-expire behavior. Classic/Commission earning ends at season boundary. Event windows and prerequisite quests are separate schedule entries. Initial release needs one main slot; add cosmetic/event slots after their selection/UI works on this client.

Use a unique internal progression scope per seasonal occurrence. Do not overwrite `season09b` XP or reuse confirmed ranks for a rerun. Reuse path loader and progression functions behind occurrence resolution. Verify whether 1.4.4 accepts unique wire progression IDs; if not, map original native ID to current internal occurrence at backend boundary and return expected native IDs. Purchased evergreen cosmetics use persistent scope, not a new progress reset on every reissue.

Schedule controls listing, SKU lookup, token redemption, selection, XP grants, and premium claims. `ACTIVE_HUNT_PASS` alone is not rotation: existing saved selection otherwise remains on old track. At rollover, select new main for expired classic selection; keep valid owned cosmetic selection. Reject XP for expired/locked tracks. Retain prior configs/state for inspection and a seven-day earned-reward claim grace period, without further XP. Verify old-pass claim UI; if unavailable, implement settlement through a single validated claim mechanism before enabling automatic rollover.

Pass-owned cosmetic IDs form union across all definitions, including reissues. Reject any generic store offer or bundle granting one, at both list and redemption. Apply same policy to Reward Cache/Vault, starter grants, blanket entitlements, and ordinary quest reward overrides. Explicit configured pass/quest-unlocked event claims remain valid. Removing only visible offers leaves direct SKU/token bypasses.

Same cosmetic can belong to original pass and its historical reissue. Claiming either valid track unlocks it permanently; it need not be locked to exactly one pass forever. Repeated cosmetic claim does not create extra instances, platinum compensation, or resale value. Preserve already-earned inventory; lock future acquisition. Existing free unlocks cannot be made historically exclusive without a separate agreed migration policy.

Migration: back up saves; revoke only automatically seeded Elite entitlements (`source=default`) and retire old zero-price pass SKU. Audit old free-store Elite grants separately so they cannot authorize new occurrences. Preserve legitimate recorded ownership and earned rewards. Changing `ENTITLEMENTS_DEFAULT` alone is insufficient because seeded rows already exist. Keep mastery tracks out of pass schedule restrictions. Do not rewrite existing XP/confirmed ranks to apply a new economy retroactively.

## Client compatibility gate

Current client is **1.4.4**, while wiki includes 2021–2024 content. Backend JSON cannot supply missing models, animations, icons, catalog entries, quests, or modern pass UI. Only Rogue Elements has bundled reward data. Other passes are researched, not yet verified as playable.

Inventory mapping and in-game preview must verify every scheduled pass. Early rewards may exist in catalog even when original season config is missing. Cosmetic reissues of early items may be possible with verified old assets; this does not establish support for modern selection screens or new rewards. Unsupported passes require asset/client work or stay unscheduled with explicit reason. Do not promise all 64 can rotate on current build unchanged.

## Implementation sequence and release checks

1. **Prove existing XP and claims.** Fresh Basic account: hunt, bounty, quest, reconnect. Confirm exact XP delta, 99→100 boundary, multiple-rank award, and partial progress. Claim supported stacked item, instanced item, permanent entitlement, and currency exactly once. Capture relevant requests. Verify insufficient premium claims refused. No XP changes unless evidence requires hookup.
2. **Enable earned platinum + paid main pass.** Completion ledger and authoritative completion hook; paid SKU using existing purchase transaction; remove default Elite; derive current premium flags; isolate pass store. Verify repeated distinct hunts continue paying, including after pass completion, and measure time to first purchase.
3. **Price ordinary store, lock rewards, and validate first definition.** Assign reviewed prices to ordinary cosmetics using existing catalog; audit complete Rogue Elements mapping, apply platinum overlay, block free-shop/cache/bundle bypasses. Validate earned-before-purchase catch-up without duplicate Basic rewards. Publish no undefined reward IDs. Verify hunt-earned platinum can buy an ordinary store item as well as Elite.
4. **Enable rotation.** Occurrence scoping, rollover selection, dates/claims, stale token rejection, immutable definitions. Verify restart across boundary, repeat same historical pass later, old owned cosmetics, and no mastered-track regressions.
5. **Expand catalog by verified batches.** Early classic passes first; cosmetic reissues and event quest passes next where supported; later client-dependent content only after asset work. Full researched inventory: [hunt-pass-wiki-audit.md](hunt-pass-wiki-audit.md).

Reuse current `node:test` setup and existing progression/store/inventory tests. Add focused coverage for new ledger, occurrence gates, and purchase integration; no new test framework. Required scenarios: duplicate and concurrent hunt events; distinct repeated hunts exceeding former 275/week ceiling; earnings after pass completion and across season/date boundaries; multiple characters; wrong user; failed/abandoned/training hunt; complete Escalation once versus its intermediate stages; per-participant payout; insufficient balance; double purchase tokens; rollback after entitlement failure; season boundary between token issuance/redemption; client-supplied currency grants; stale former-pass claim; direct free-SKU/bundle bypass; upgrade after tier 50; duplicate inventory claim; ordinary cosmetic purchase funded entirely by hunts; no XP credited twice.

Existing inventory transaction replay protection is necessary but is not proof that a reward is earned. Validate pass reward grants against authoritative earned rank, occurrence, track ownership, and claim state. Preserve current game-server payout ordering; do not add a second writer on confirm. If capture exposes missing durable claim identity, add minimal shared claim validation/idempotency before paying new platinum rows.

Plan-only verification: all four wiki lists and every linked pass page opened in browser; 64 pages, 2,665 numeric tier rows. Tier counts and historical platinum totals recorded in audit. No asset completeness or gameplay test claimed. Existing user changes left untouched.

Runnable balance check (Node, no dependencies):

```js
const assert = require('node:assert/strict');
const hunt = 10, escalation = 30, price = 950;
assert.equal(Math.ceil(price / hunt), 95);
assert.equal(Math.ceil(price / escalation), 32);
assert.equal(10 * hunt, 100);
assert.equal(50 * hunt, 500);
assert.equal(100 * hunt, 1000);
assert.ok(100 * hunt > 275); // Distinct completions are not capped.
assert.equal(50 * hunt + 15 * escalation, price);
assert.equal(Math.ceil(250 / hunt), 25);
assert.equal(Math.ceil(500 / hunt), 50);
assert.equal(Math.ceil(1000 / hunt), 100);
assert.equal(4 * 50 + 10 * 75, price);
assert.equal(5 * 20 + 5 * 80, 500);
assert.equal(50 * 100, 5000);
console.log('Hunt Pass balance checks passed');
```
