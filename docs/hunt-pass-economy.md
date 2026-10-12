# Earned platinum and Hunt Pass economy

`STORE=earned` is default. Existing hosts with `STORE=free` or `STORE=off` must set `STORE=earned` to enable this economy. `free` preserves explicitly selected legacy behavior for testing; `off` disables normal storefront and hunt earnings. Gameplay vendors retain their existing switches/currencies.

- Each successful regular hunt earns **10 platinum** per participating account.
- Each successfully completed Escalation run earns **30 platinum**, replacing regular payout.
- Distinct completed hunts always pay; no daily, weekly, seasonal, or pass-level cap.
- Elite costs **950 platinum**. Basic refunds 200, Elite refunds 750 on completion.
- XP amounts, incremental 100-XP rank requirements, and game-server tier reward writer remain unchanged.
- Ordinary store prices are explicit SKU entries in `UndauntedMetagame/src/vendor/store_platinum_prices.json`: small cosmetics/armour pieces 250, individual weapon transmogs/emotes 500, armour bundles 1,000. Tutorial/fountain grants remain free. Premium bounty-token bundle is 100 when its existing opt-in switch is enabled.
- Pass cosmetics and bundles containing them are excluded from ordinary catalog listing and direct purchase in earned mode. Known Hunt Pass item IDs, Saint's Bond romantic armour IDs, and cosmetic IDs in configured pass definitions are protected. Additional imported definitions extend that protection.
- No platinum packs, real-money checkout, or tier skips added. Existing currency-grant offers are rejected by store item allowlist.

## Hunt completion path

Rebuild and deploy native game-server DLL together with metagame. Dedicated-server `ProcessEventHook` captures successful `ArchonGameMode_Island.OnEndOfHuntStarted` / `MasteryComponent.OnHuntFinished` events and freezes connected player IDs. It clears completion header on next island gameplay transition. Failed completion does not publish proof. Escalation classification uses native matchmaker hunt ID, not player input.

Existing native HTTP request hook sends bounded `x-dauntless-hunt-completion` proof alongside server key and session header. Metagame only reads it after local game-server authentication, requires matching session ID and participant account, and applies payout to next inventory transaction for that player. Player headers and body `source` cannot authorize payout. Training, city, Ramsgate, and tutorial hunt IDs are excluded.

Migration `0029_hunt_completions` adds permanent `(accountId, completionId)` receipts. Receipt, loot, platinum stack, response, and inventory log commit together. Replayed requests, changed inventory transaction IDs, concurrent requests, and another character cannot pay same account twice for same completion. Inventory failure rolls receipt back. Each eligible party participant receives own full amount. Platinum is held in existing character inventory as `CURRENCY_PLATINUM_UNIV`; balance/reconcile expose native aliases. No second wallet introduced.

Completion capture uses connected player roster at terminal success, matching game's shared hunt reward model. It does not invent damage/AFK thresholds. Successful hunt integration must be smoke-tested with actual 1.4.4 client; automated tests simulate the native proof, and native policy check covers failed runs and immutable completion roster. Award appears in inventory response/balance; no new hunt reward-screen tile was implemented.

## Seasons and ownership

Schedule: `UndauntedMetagame/src/vendor/hunt_pass_schedule.json`. Epoch **12 October 2026 UTC**, **42 days** per occurrence, ordered `passes` list. Restart metagame after editing schedule or definitions. Every scheduled ID must have loaded premium gate and nonempty reward rows; missing definitions fail startup. Existing path loader still accepts additional definitions through `PROGRESSION_CONFIG_DIR`.

Bundled schedule contains **Rogue Elements (`season09b`) only**, the sole complete bundled Hunt Pass. It repeats until additional mapped definitions are added. This does not ship all 64 wiki passes. Later client assets, catalog mappings, evergreen cosmetic selection, quest-event access, and old-season claim grace remain future work; researched inventory is [wiki audit](hunt-pass-wiki-audit.md).

Native progression IDs remain stable. Backend stores XP/confirmed ranks and paid entitlement under separate occurrence scopes. At boundary, next occurrence starts with empty pass progress and unpaid Elite; completed cosmetics, platinum, old progression rows, and mastery remain intact. Old raw pass records remain preserved when entering first earned season, but do not automatically grant new-season progress/ownership. Basic is seeded; old default Elite rows are reversibly revoked when entitlement list is accessed. Old zero-price store grants cannot authorize new scoped Elite. Existing cosmetic inventory is preserved.

Store offer dates/hash bind purchase token to current occurrence. Old token cannot redeem against next occurrence. Two tokens issued before first purchase cannot charge for Elite twice. Purchasing Elite leaves earned XP and confirmed Basic ranks intact; native claim flow handles unclaimed premium tiers. `ConfirmRank` never grants inventory or platinum.

Native pass cosmetic grants are checked against authoritative earned tiers and current paid ownership. Already owned pass cosmetics do not stack or create additional instances on reissue. Durable pass-platinum allowance records cap tier refunds at amount earned in current occurrence, independently of unlimited hunt income. This also prevents changed inventory request IDs from paying tier refund again. Native payload does not identify individual claim tier, so allowance is tracked as total platinum earned/paid, with existing confirmed rank behavior retained.

50-tier refund overlay removes old platinum entries only, then grants Basic 50 at tiers 10/25/35/45 and Elite 75 every five tiers. Other rewards retain original IDs, quantities, tiers, and tracks. Mini overlay supports 25 tiers: 20 Basic + 80 Elite every five tiers, 500 total and 500 price. Other formats preserve configured rows; full modern cosmetic/Commission/event behavior is not enabled by bundled schedule.

## Rollout checks

1. Back up stopped server database. Deploy matching metagame build and rebuilt native DLL; set `STORE=earned`; restart services. SQLite migration runs automatically on first DB access.
2. Fresh account: confirm Basic only, successful hunt gives 10, failed/training hunt gives zero, full Escalation gives 30 once. Confirm party member payouts and balance/reconcile values.
3. Buy ordinary cosmetic with hunt earnings; buy Elite at 950; check premium catch-up and same-token replay. Reconnect and verify persistent balance/progress.
4. Test dates with isolated server/save before scheduling another pass. Never edit tier definitions during live occurrence, as native game servers cache config. Do not change live schedule mid-occurrence; finish current six-week window before deployment of amended list.

Automated coverage: `UndauntedMetagame/test/huntpass-economy.test.ts`, existing store/progression/inventory regression suites, `UndauntedInternalServer/tests/hunt-completion.cpp`. Native check uses assert-only C++ executable; no added framework.
