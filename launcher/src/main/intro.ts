// The launcher's own intro: Logo.mp4 (the stock Phoenix Labs intro) is replaced by a copy that starts
// with the Mystic/Dauntless clip. It is not in the manifest's hash set, so verification accepts any size.
// The login screen's looping background (LoginLoop.mp4, played by MysticParadox.dll) ships beside it.
import { promises as fsp } from "node:fs";
import path from "node:path";

const MOVIES = path.join("Archon", "Content", "Movies", "Windows");
const INTRO_REL = path.join(MOVIES, "Logo.mp4").toLowerCase();

export function isIntroFile(relPath: string): boolean {
  return path.normalize(relPath).toLowerCase() === INTRO_REL;
}

// Copies the bundled intro over the game's Logo.mp4, and login-loop.mp4 (next to the intro) to LoginLoop.mp4,
// unless each is already there (same size).
export async function applyIntro(gameDir: string, src: string | undefined): Promise<void> {
  if (!src) return;
  const loop = path.join(path.dirname(src), "login-loop.mp4");
  for (const [from, name] of [[src, "Logo.mp4"], [loop, "LoginLoop.mp4"]]) {
    const dest = path.join(gameDir, MOVIES, name);
    const want = (await fsp.stat(from)).size;
    const have = await fsp.stat(dest).then((s) => s.size, () => -1);
    if (have !== want) await fsp.copyFile(from, dest);
  }
}
