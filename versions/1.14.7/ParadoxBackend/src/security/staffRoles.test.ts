import assert from "node:assert/strict";
import test from "node:test";
import { AllowedNameStyles, CanActOn, HasStaffPermission, NameTagOf, StaffRank, StripStaffNameTag } from "./staffRoles";

test("staff tiers gate permissions", () => {
    assert.equal(StaffRank(["player"]), 0);
    assert.equal(StaffRank(["player", "tester"]), 0);
    assert.equal(HasStaffPermission(["moderator"], "players.ban.timed"), true);
    assert.equal(HasStaffPermission(["moderator"], "players.access"), false);
    assert.equal(HasStaffPermission(["admin"], "players.access"), true);
    assert.equal(HasStaffPermission(["admin"], "players.roles"), false);
    assert.equal(HasStaffPermission(["admin", "owner"], "players.delete"), true);
});

test("staff only act on lower ranks, never themselves or peers", () => {
    assert.equal(CanActOn(["moderator"], ["player"]), true);
    assert.equal(CanActOn(["moderator"], ["moderator"]), false);
    assert.equal(CanActOn(["moderator"], ["admin"]), false);
    assert.equal(CanActOn(["admin"], ["moderator"]), true);
    assert.equal(CanActOn(["admin", "owner"], ["admin", "owner"]), false);
});

test("name tags: tier and worn style, old tagged names still strip", () => {
    assert.deepEqual(NameTagOf(["player", "admin", "owner"], "legend"), { tier: "owner", style: "legend" });
    assert.deepEqual(NameTagOf(["admin"], "legend"), { tier: "admin" });   // not allowed yet: style dropped
    assert.deepEqual(NameTagOf(["moderator"], undefined), { tier: "moderator" });
    assert.deepEqual(NameTagOf(["owner"], "bogus"), { tier: "owner" });
    assert.deepEqual(NameTagOf(["player", "tester"], undefined), {});
    assert.equal(StripStaffNameTag("[Mod] Someone"), "Someone");
    assert.equal(StripStaffNameTag("Hyjinnx"), "Hyjinnx");
    assert.equal(StripStaffNameTag("[Owner] [Emerald] Hyjinnx"), "Hyjinnx");
    assert.deepEqual(AllowedNameStyles(["player"]), []);
});

test("moderators can watch servers but only admins control them", () => {
    assert.equal(HasStaffPermission(["moderator"], "servers.read"), true);
    assert.equal(HasStaffPermission(["moderator"], "servers.control"), false);
    assert.equal(HasStaffPermission(["admin"], "servers.control"), true);
    assert.equal(HasStaffPermission(["player"], "servers.read"), false);
});
