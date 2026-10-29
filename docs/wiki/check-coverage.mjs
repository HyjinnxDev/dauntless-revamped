// Lists source files that no wiki page mentions. Run from anywhere:
//   node docs/wiki/check-coverage.mjs [path-prefix]
// A file counts as covered when the wiki text contains its "parent/name" (e.g. `routes/huntStats.ts`),
// or just its name when that name is unique among source files.
// ponytail: substring match, so a mention in the wrong page still counts; upgrade to per-page ownership
// if wrong-page mentions start hiding gaps.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wikiDir = dirname(fileURLToPath(import.meta.url));
const repo = join(wikiDir, "..", "..");
const prefix = (process.argv[2] ?? "").replace(/\\/g, "/");

const SOURCE = /\.(ts|tsx|js|mjs|cjs|cpp|h|hpp|cs|py|ps1|bat|rs|go|sh|html|css|sql)$/;
const SKIP = /(^|\/)(node_modules|SDK|game-data|x64|dist|build|out|\.vite|drizzle\/meta)\/|\.d\.ts$|\.test\.|\.spec\.|(^|\/)(test|tests|__tests__)\//;

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: repo, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && SOURCE.test(f) && !SKIP.test(f) && !f.startsWith("docs/wiki/"));

const wiki = readdirSync(wikiDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => readFileSync(join(wikiDir, f), "utf8"))
  .join("\n");

const nameCount = new Map();
for (const f of files) {
  const name = f.split("/").pop();
  nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
}

const missing = files.filter((f) => {
  if (!f.startsWith(prefix)) return false;
  const parts = f.split("/");
  const name = parts.pop();
  const tail = parts.length ? `${parts.pop()}/${name}` : name;
  return !(wiki.includes(tail) || (nameCount.get(name) === 1 && wiki.includes(name)));
});

const inScope = files.filter((f) => f.startsWith(prefix)).length;
console.log(missing.join("\n"));
console.log(`\n${missing.length} of ${inScope} source files not mentioned in docs/wiki${prefix ? ` (prefix ${prefix})` : ""}`);
process.exitCode = missing.length ? 1 : 0;
