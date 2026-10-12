// Starting the game. The arguments match the Mystic Paradox launcher's (ParadoxLauncher
// src-tauri/src/launch/process.rs): the one-time exchange code goes in -AUTH_PASSWORD and is never
// logged (see maskArgs). The runtime finds the server through MYSTICPARADOX_API_BASE, the launcher's
// local relay, instead of its compiled-in host.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { EXE_NAME } from "./constants";
import type { GameLanguage } from "../shared/types";

export interface LaunchSettings {
  exchangeCode: string;
  userId: string;
  username: string;
  windowed: boolean;
  gameLocale?: string; // -epiclocale; English when left out
}

// Fixed values the backend's EOS routes expect (routes/eos.ts).
export const FIXED_ARGS = [
  "-DisableEOS",
  "-EpicPortal",
  "-NoEAC",
  "-AUTH_TYPE=exchangecode",
  "-epicapp=Archon",
  "-epicenv=Prod",
  "-epicsandboxid=jackal",
  "-epicdeploymentid=53565ba467df4edbb6f5a3d939a8b4f2",
];

const GAME_LOCALES = ["en-US", "de-DE", "es-ES", "fr-FR", "it-IT", "ja-JP", "pt-BR", "ru-RU"];

// The -epiclocale for the Game language setting. "auto" takes the operating system's language when
// the game has text for it (es-419 -> es-ES, pt-PT -> pt-BR), and English otherwise.
export function gameLocale(setting: GameLanguage, systemLocale: string): string {
  if (setting !== "auto") return setting;
  const code = systemLocale.toLowerCase().slice(0, 2);
  return GAME_LOCALES.find((l) => l.toLowerCase().startsWith(`${code}-`)) ?? "en-US";
}

export function buildLaunchArgs(s: LaunchSettings): string[] {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(s.exchangeCode)) throw new Error("invalid exchange code");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(s.userId)) throw new Error("invalid account id");
  if (!/^[A-Za-z0-9]{3,16}$/.test(s.username)) throw new Error("invalid username");
  const locale = s.gameLocale && GAME_LOCALES.includes(s.gameLocale) ? s.gameLocale : "en-US";
  const args = [
    ...FIXED_ARGS,
    // UE's social subsystem keys the local account on AUTH_LOGIN; the backend logs in from AUTH_PASSWORD.
    `-AUTH_LOGIN=${s.userId}`,
    `-AUTH_PASSWORD=${s.exchangeCode}`,
    `-epicusername=${s.username}`,
    `-epicuserid=${s.userId}`,
    `-epicaccountid=${s.userId}`,
    `-epiclocale=${locale}`,
  ];
  if (s.windowed) args.push("-windowed", "-ResX=1280", "-ResY=720");
  return args;
}

export function relayEnv(relayPort: number): Record<string, string> {
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) throw new Error("invalid relay port");
  return { MYSTICPARADOX_API_BASE: `http://127.0.0.1:${relayPort}` };
}

export function maskArgs(args: string[]): string[] {
  return args.map((a) => (/^-AUTH_PASSWORD=/i.test(a) ? "-AUTH_PASSWORD=<hidden>" : a));
}

export function describeLaunch(exe: string, args: string[]): string {
  return `${exe} ${maskArgs(args).join(" ")}`;
}

export type SpawnFn = typeof spawn;

// Tracks the one game process this launcher started.
export class GameProcess {
  private child: ChildProcess | null = null;
  private listeners: ((running: boolean, code: number | null) => void)[] = [];

  constructor(private readonly spawnFn: SpawnFn = spawn) {}

  get running(): boolean {
    return this.child !== null;
  }

  onChange(fn: (running: boolean, code: number | null) => void): void {
    this.listeners.push(fn);
  }

  start(win64Dir: string, args: string[], extraEnv: Record<string, string>): Promise<void> {
    if (this.child) return Promise.reject(new Error("already running"));
    const exe = path.join(win64Dir, EXE_NAME);
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(exe, args, {
        cwd: win64Dir,
        stdio: "ignore",
        windowsHide: false,
        detached: false,
        env: { ...process.env, ...extraEnv },
      });
      let started = false;
      child.once("spawn", () => {
        started = true;
        this.child = child;
        this.listeners.forEach((l) => l(true, null));
        resolve();
      });
      child.once("error", (e) => {
        if (!started) reject(e);
      });
      child.once("exit", (code) => {
        if (this.child === child) this.child = null;
        if (started) this.listeners.forEach((l) => l(false, code));
      });
    });
  }
}

// Lists running Dauntless clients. Game servers (the same exe started with -server, as on the
// host's own PC) do not count. Only process ids and a yes/no are read back: other processes'
// command lines contain login codes and never leave PowerShell.
export function findRunningClients(platform: NodeJS.Platform = process.platform): Promise<number[]> {
  if (platform !== "win32") return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("tasklist.exe", ["/FI", `IMAGENAME eq ${EXE_NAME}`, "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err || !stdout.toLowerCase().includes(EXE_NAME.toLowerCase())) return resolve([]);
      const script =
        `Get-CimInstance Win32_Process -Filter "Name='${EXE_NAME}'" | ForEach-Object { ` +
        `if ($_.CommandLine -notmatch '(^|\\s)-server(\\s|$)') { $_.ProcessId } }`;
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: 15000 },
        (err2, out2) => {
          if (err2) return resolve([]);
          resolve(
            out2
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter((l) => /^\d+$/.test(l))
              .map(Number),
          );
        },
      );
    });
  });
}
