// The launcher's own intro: Logo.mp4 (the stock Phoenix Labs intro) is replaced by a copy that starts
// with the Mystic/Dauntless clip. It is not in the manifest's hash set, so verification accepts any size.
import { promises as fsp } from "node:fs";
import path from "node:path";

const INTRO_REL = path.join("Archon", "Content", "Movies", "Windows", "Logo.mp4").toLowerCase();

export function isIntroFile(relPath: string): boolean {
  return path.normalize(relPath).toLowerCase() === INTRO_REL;
}

// Copies the bundled intro over the game's Logo.mp4 unless it is already there (same size).
export async function applyIntro(gameDir: string, src: string | undefined): Promise<void> {
  if (!src) return;
  const dest = path.join(gameDir, "Archon", "Content", "Movies", "Windows", "Logo.mp4");
  const want = (await fsp.stat(src)).size;
  const have = await fsp.stat(dest).then((s) => s.size, () => -1);
  if (have !== want) await fsp.copyFile(src, dest);
}
