import { test } from "node:test";
import assert from "node:assert/strict";
import { gameExitDetail } from "../src/main/windows-runtime";

test("signed and unsigned missing-DLL exits give the same actionable message", () => {
  assert.equal(gameExitDetail(-1073741515), gameExitDetail(3221225781));
  assert.match(gameExitDetail(3221225781), /0xC0000135.*Repair/);
  assert.match(gameExitDetail(1), /0x00000001/);
});
