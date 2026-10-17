import { test } from "node:test";
import assert from "node:assert/strict";
import { formatInvite, isTailnetHost, isTailscaleIPv4, isValidFingerprint, isValidHost, parseInvite, type Invite } from "../src/shared/invite";
import { RLO } from "../src/shared/text";

const FP = "3f".repeat(32);
const base = { v: "1", host: "100.101.102.103", port: "443", fp: FP, code: "ABCD-EFGH-JKLM", name: "Friday%20Hunts" };
const build = (over: Record<string, string | null>) =>
  "dauntless-forever-1147://join?" +
  Object.entries({ ...base, ...over })
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

test("parses a valid invite", () => {
  const r = parseInvite(build({}));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.invite, { host: "100.101.102.103", port: 443, code: "ABCD-EFGH-JKLM", name: "Friday Hunts", fp: FP });
});

test("the port defaults to 443; DNS names, whitespace, any order and an upper-case scheme work", () => {
  const r = parseInvite(`  DAUNTLESS-FOREVER-1147://join/?name=Hunts&code=abcd&fp=${FP}&host=Play.Example.ORG&v=1\n`);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.invite.port, 443);
  assert.equal(r.invite.host, "play.example.org");
});

test("round-trips through formatInvite", () => {
  const inv: Invite = { host: "hostpc.tail1234.ts.net", port: 8443, code: "Code-42", name: "Ember & Aether", fp: FP };
  const r = parseInvite(formatInvite(inv));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.invite, inv);
  assert.throws(() => formatInvite({ ...inv, fp: "nope" }));
});

const bad: [string, string][] = [
  ["", "empty"],
  ["hello", "not_invite"],
  ["https://example.com/join?v=1", "not_invite"],
  // 1.4.4 invites are for the other launcher.
  [`dauntless-forever://join?v=2&mode=public&host=1.2.3.4&fp=${FP}&code=abcd&name=x`, "not_invite"],
  [`dauntless-revived://join?v=1&host=100.64.0.1&port=61000&code=abcd&name=x`, "not_invite"],
  [build({ v: "2" }), "version"],
  [build({ v: null }), "version"],
  [build({ host: null }), "host"],
  [build({ fp: null }), "fp"],
  [build({ code: null }), "code"],
  [build({ name: null }), "name"],
  [build({ extra: "1" }), "params"],
  [build({ mode: "public" }), "params"],
  [build({}) + `&fp=${FP}`, "params"],
  [build({}) + "#frag", "params"],
  [build({ name: "%E0%A4%A" }), "params"],
  [build({ host: "256.1.1.1" }), "host"],
  [build({ host: "01.2.3.4" }), "host"],
  [build({ host: "evil.com%2F%40x" }), "host"],
  [build({ host: "host.123" }), "host"],
  [build({ host: "0x7f.1" }), "host"],
  [build({ host: "%5B%3A%3A1%5D" }), "host"],
  [build({ port: "0" }), "port"],
  [build({ port: "65536" }), "port"],
  [build({ port: "0443" }), "port"],
  [build({ fp: FP.toUpperCase() }), "fp"],
  [build({ fp: FP.slice(0, 63) }), "fp"],
  [build({ fp: FP.replace(/(..)/g, "$1:").slice(0, -1) }), "fp"],
  [build({ code: "abc" }), "code"],
  [build({ code: "a+b+c+d" }), "code"],
  [build({ code: "a".repeat(65) }), "code"],
  [build({ name: "%20%20" }), "name"],
  [build({ name: "a%0Ab" }), "name"],
  [build({ name: encodeURIComponent(RLO) + "evil" }), "name"],
  [build({ name: "n".repeat(65) }), "name"],
  ["dauntless-forever-1147://join?" + "x".repeat(3000), "too_long"],
];

for (const [input, error] of bad) {
  test(`rejects (${error}): ${input.slice(0, 100)}`, () => {
    const r = parseInvite(input);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, error);
  });
}

test("rejects non-strings", () => {
  for (const v of [undefined, null, 42, {}, [build({})]]) assert.equal(parseInvite(v).ok, false);
});

test("host, tailnet and fingerprint rules", () => {
  assert.equal(isValidHost("100.64.0.1"), true);
  assert.equal(isValidHost("my-pc.tail-scale.ts.net"), true);
  assert.equal(isValidHost("MyPC"), false); // upper case is lowered by the parser, not here
  assert.equal(isTailscaleIPv4("100.127.255.255"), true);
  assert.equal(isTailscaleIPv4("100.128.0.1"), false);
  assert.equal(isTailnetHost("hostpc.tail1234.ts.net"), true);
  assert.equal(isTailnetHost("ts.net"), false);
  assert.equal(isTailnetHost("203.0.113.9"), false);
  assert.equal(isValidFingerprint(FP), true);
  assert.equal(isValidFingerprint(FP.toUpperCase()), false);
  assert.equal(isValidFingerprint(null), false);
});
