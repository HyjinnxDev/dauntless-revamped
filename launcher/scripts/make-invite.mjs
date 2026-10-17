// Prints an invite link for the launcher (format: src/shared/invite.ts).
//   node scripts/make-invite.mjs --host 100.108.36.34 --cert D:\MysticParadoxData\certs\fullchain.pem --code ABCD-1234 --name "Friday Hunts" [--port 443]
// The fingerprint is the SHA-256 of the backend's own certificate (the first one in the PEM file).
// The code must be one of the backend's LAUNCHER_INVITE_CODES.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  console.error(`missing --${name}`);
  process.exit(2);
};

const host = arg("host").toLowerCase();
const port = Number(arg("port", "443"));
const code = arg("code");
const name = arg("name");
const pem = readFileSync(arg("cert"), "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
if (!pem) {
  console.error("no certificate in that file");
  process.exit(2);
}
const fp = new X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();

if (!/^[A-Za-z0-9-]{4,64}$/.test(code)) throw new Error("invite codes are 4-64 letters, digits or -");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad port");
const q = ["v=1", `host=${encodeURIComponent(host)}`, `port=${port}`, `fp=${fp}`, `code=${encodeURIComponent(code)}`, `name=${encodeURIComponent(name)}`];
console.log(`dauntless-revamped://join?${q.join("&")}`);
