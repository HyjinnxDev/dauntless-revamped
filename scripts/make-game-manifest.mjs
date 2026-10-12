// Builds the pinned 1.14.7 game manifest from an install, using the install's own official file
// list (Manifest.bin.json) so that files added later (MysticParadox.dll, winmm.dll, logs, flags)
// never end up in it. Every listed file must be on disk with its official size.
//   node scripts/make-game-manifest.mjs <install dir> <out.json>
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: node scripts/make-game-manifest.mjs <install dir> <out.json>");
  process.exit(2);
}

const build = readFileSync(path.join(dir, "Version.txt"), "utf8").trim();
const official = JSON.parse(readFileSync(path.join(dir, "Manifest.bin.json"), "utf8")).TargetFiles;

const hash = (file) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

const files = [];
let bad = 0;
for (const [i, f] of official.entries()) {
  const rel = f.RelativePath.replaceAll("\\", "/");
  const full = path.join(dir, ...rel.split("/"));
  let size;
  try {
    size = statSync(full).size;
  } catch {
    console.error(`MISSING ${rel}`);
    bad++;
    continue;
  }
  if (size !== f.FileSize) {
    console.error(`SIZE ${rel}: ${size} on disk, ${f.FileSize} official`);
    bad++;
    continue;
  }
  files.push({ path: rel, size, sha256: await hash(full) });
  if ((i + 1) % 50 === 0) console.log(`${i + 1}/${official.length}`);
}

// Reported, not included: what the install has beyond the official list.
const listed = new Set(official.map((f) => f.RelativePath.replaceAll("\\", "/").toLowerCase()));
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const full of walk(dir)) {
  const rel = path.relative(dir, full).replaceAll("\\", "/");
  if (!listed.has(rel.toLowerCase())) console.log(`EXTRA ${rel}`);
}

if (bad > 0) {
  console.error(`${bad} official file(s) missing or changed; no manifest written`);
  process.exit(1);
}
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const totalBytes = files.reduce((s, f) => s + f.size, 0);
writeFileSync(out, JSON.stringify({ build, totalBytes, files }, null, 1) + "\n");
console.log(`${files.length} files, ${totalBytes} bytes, build ${build} -> ${out}`);
