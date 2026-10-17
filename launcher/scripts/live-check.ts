// Checks a live server end to end with the launcher's own code, without starting the game:
//   npx tsx scripts/live-check.ts "<invite link>" <username> <password>
// Registers the account with the invite's code when it does not exist yet (otherwise signs in), checks
// the runtime release and one game file, asks for a game session, and trades the exchange code for a
// game token through the relay the way the game does at login.
import { createHash } from "node:crypto";
import http from "node:http";
import { parseInvite } from "../src/shared/invite";
import {
  downloadRuntimeFile, fetchContentManifest, fetchRuntimeRelease, fetchServerStatus, login, registerAccount, requestGameSession,
} from "../src/main/hostapi";
import { request } from "../src/main/http";
import { compareManifests, validateManifest } from "../src/main/manifest";
import { Relay } from "../src/main/relay";
import { PINNED_EXE_SHA256 } from "../src/main/constants";
import manifestJson from "../data/dauntless-1.14.7.json";

const [link, username, password] = process.argv.slice(2);
const step = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) process.exit(1);
};

async function main() {
  const inv = parseInvite(link);
  step("invite parses", inv.ok);
  if (!inv.ok) return;
  const ep = { host: inv.invite.host, port: inv.invite.port, pin: inv.invite.fp };
  const device = { deviceId: "00000000-0000-4000-8000-00000000c0de", deviceName: "live-check" };

  const status = await fetchServerStatus(ep, 10000);
  step("status over pinned TLS", status.kind === "ok", status.kind);

  let s = await login(ep, { identifier: username, password, ...device });
  if (!s.ok && s.error === "login_failed") s = await registerAccount(ep, { username, password, inviteCode: inv.invite.code, ...device });
  step("signed in", s.ok, s.ok ? s.session.username : `${s.error} ${s.detail ?? ""}`);
  if (!s.ok) return;
  const token = s.session.accessToken;

  const release = await fetchRuntimeRelease(ep);
  step("runtime release", "files" in release, "files" in release ? release.version : release.error);
  if (!("files" in release)) return;
  for (const f of release.files) {
    const data = await downloadRuntimeFile(ep, f);
    step(`runtime ${f.name}`, Buffer.isBuffer(data) && createHash("sha256").update(data).digest("hex") === f.sha256);
  }

  const local = validateManifest(manifestJson);
  step("compiled-in manifest", local.ok);
  if (!local.ok) return;
  const remote = await fetchContentManifest(ep);
  const cmp = compareManifests(local.manifest, remote);
  step("server manifest matches", cmp.equal, cmp.equal ? "" : cmp.difference);
  const small = local.manifest.files.find((f) => f.path === "Version.txt")!;
  const res = await request(ep, "/content/v1/files/Version.txt", { headers: { authorization: `Bearer ${token}` }, timeoutMs: 15000, maxBytes: 1 << 20 });
  step("game file download", res.status === 200 && createHash("sha256").update(res.body).digest("hex") === small.sha256, `HTTP ${res.status}`);

  const ticket = await requestGameSession(ep, token, {
    executableSha256: PINNED_EXE_SHA256,
    runtimeVersion: release.version,
    runtimeArtifacts: release.files.map((f) => ({ name: f.name, sha256: f.sha256 })),
  });
  step("game session", ticket.ok, ticket.ok ? "exchange code issued" : `${ticket.error} ${ticket.detail ?? ""}`);
  if (!ticket.ok) return;

  const relay = new Relay({ target: { host: ep.host, port: ep.port, fingerprint: ep.pin }, port: 61047, onPinError: () => undefined, onLog: () => undefined });
  await relay.start();
  try {
    const body = `grant_type=exchange_code&exchange_code=${ticket.exchangeCode}`;
    const game = await new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: 61047, method: "POST", path: "/account/api/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } }, (r) => {
        let raw = "";
        r.on("data", (c) => (raw += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }));
      });
      req.on("error", reject);
      req.end(body);
    });
    step("game login through the relay", game.status === 200 && typeof game.json.access_token === "string" && game.json.account_id === s.session.userId, `HTTP ${game.status}`);
  } finally {
    await relay.stop();
  }
  console.log("ALL PASS");
}

main().catch((e) => {
  console.log(`FAIL ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
