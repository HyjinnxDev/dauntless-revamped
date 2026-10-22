// Checks on the friend's PC: free disk space.

import { promises as fsp } from "node:fs";
import path from "node:path";

// Free space on the drive that holds `dir` (or its nearest existing parent).
export async function freeBytes(dir: string): Promise<number | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const st = await fsp.statfs(current);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}
