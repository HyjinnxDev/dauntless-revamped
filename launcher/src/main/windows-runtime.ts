// The game's Win64 folder ships its own Visual C++ and DirectX DLLs (they are in the game manifest),
// so the only thing left to explain is how the game ended.
export function gameExitDetail(code: number): string {
  const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8,'0')}`;
  if ((code >>> 0) === 0xC0000135 || (code >>> 0) === 0xC000007B) return `${hex}: Windows could not load a game file. Use Repair game files, then retry.`;
  return `${hex}: The game closed unexpectedly. Use Repair game files; if it repeats, send the launcher logs to your host.`;
}