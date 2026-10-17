import assert from "node:assert/strict";
import test from "node:test";
import { HideSeekCommand, RoundStateText, TakeHideSeek } from "./hideSeek";

test("round state lines for a client", () => {
    const R = { phase: "hiding" as const, endsAt: 42_500, seekers: ["Ann", "Bo"], hiders: ["Cy"], alertId: 3, alert: "10 seconds left to hide!", updatedAt: 0 };
    assert.equal(RoundStateText(R, "Bo", 0),
        "phase=hiding\nleft=43\nrole=seeker\nhiders=1\nseekers=2\nseekernames=Ann\tBo\nalert=3\t10 seconds left to hide!\n");
    assert.match(RoundStateText({ ...R, endsAt: 0 }, "Cy", 5000), /^phase=hiding\nleft=0\nrole=hider\n/);
});

test("!hideseek arms a party once, off and expiry disarm", () => {
    process.env.HIDESEEK_ENABLED = "1";
    assert.equal(HideSeekCommand("Party-p1", "hello"), undefined);
    assert.equal(HideSeekCommand("City-x", "/hideseek"), undefined);
    assert.ok(HideSeekCommand("Party-p1", " !HideSeek "));
    assert.equal(TakeHideSeek("p1"), true);
    assert.equal(TakeHideSeek("p1"), false);   // one round per arming

    HideSeekCommand("Party-p2", "/hideseek");
    HideSeekCommand("Party-p2", "!hideseek off");
    assert.equal(TakeHideSeek("p2"), false);

    HideSeekCommand("Party-p3", "/hideseek", 0);
    assert.equal(TakeHideSeek("p3", 31 * 60 * 1000), false);

    process.env.HIDESEEK_ENABLED = "";
    assert.equal(HideSeekCommand("Party-p4", "/hideseek"), undefined);
});
