// Types shared by the main process, the preload bridge and the renderer.
// The main process owns all state; the renderer only draws a Snapshot and sends intents.

import type { ServerStatus } from "./status";

export type Language = "en" | "fi" | "es";
export const LANGUAGES: readonly Language[] = ["en", "fi", "es"];

// The game's own text language, sent to it as -epiclocale; "auto" follows the operating system.
export type GameLanguage = "auto" | "en-US" | "de-DE" | "es-ES" | "fr-FR" | "it-IT" | "ja-JP" | "pt-BR" | "ru-RU";
export const GAME_LANGUAGES: readonly GameLanguage[] = ["auto", "en-US", "de-DE", "es-ES", "fr-FR", "it-IT", "ja-JP", "pt-BR", "ru-RU"];

export type Phase =
  | "loading"
  | "join" // no server yet: paste an invite
  | "connect" // server known, not reachable (or still checking)
  | "register" // server reachable, not signed in: create an account or sign in
  | "install" // signed in, game not installed
  | "installing" // download / verify / repair running (or paused)
  | "update" // game present but files are missing, damaged, or the runtime needs refreshing
  | "ready" // PLAY
  | "running"; // the game is running

export type ConnectProblem =
  | "tailscale_missing" // the invite points into a tailnet and Tailscale is not installed
  | "unreachable" // no answer within 5 s
  | "bad_answer" // something answered but it is not a Dauntless 1.14.7 server
  | "cert_mismatch" // the certificate is not the one from the invite
  | null;

export type ErrorCode =
  | "account_banned"
  | "server_list_full"
  | "approval_pending" // registered without a valid invite: the host has to approve the account
  | "invite_invalid_format"
  | "invite_invalid"
  | "username_invalid"
  | "username_taken"
  | "email_taken"
  | "password_invalid"
  | "login_failed"
  | "session_expired" // the server no longer accepts the stored sign-in: sign in again
  | "bad_request"
  | "server_unreachable"
  | "server_error"
  | "key_storage_unavailable"
  | "no_content_server"
  | "manifest_mismatch"
  | "manifest_unavailable"
  | "disk_space"
  | "folder_invalid"
  | "game_folder_not_found" // "I already have the game files": no 1.14.7 game in the layouts looked at
  | "folder_not_empty"
  | "download_failed"
  | "file_missing_on_server"
  | "file_different_on_server"
  | "verify_failed"
  | "runtime_unavailable" // the server has no runtime release published
  | "runtime_failed" // the runtime files could not be installed
  | "runtime_in_use" // the old runtime is loaded by a running process (the host's own game servers)
  | "runtime_rejected" // the server refused this runtime release (it changed: Repair)
  | "game_files_invalid"
  | "already_running"
  | "launch_failed"
  | "busy"
  | "cancelled"
  | "cert_mismatch"
  | "cert_changed" // an invite whose certificate differs from the one this PC's sign-in belongs to
  | "rate_limited"
  | "relay_port_busy"
  | "relay_failed"
  | "unknown";

// Short messages that are not errors.
export type NoticeCode = "keep_open" | "repair_done" | "install_done";

export interface LauncherError {
  code: ErrorCode;
  // Extra detail for the message, e.g. a file path or the server's own message. Never a secret.
  detail?: string;
}

export type ActionResult = { ok: true } | { ok: false; error: LauncherError };

// Asked before joining from an invite. certificateChanged: this PC has a sign-in for the invite's
// host:port that belongs to another certificate (previousFingerprint).
export type InviteCheck =
  | { ok: true; certificateChanged: boolean; previousFingerprint: string | null }
  | { ok: false; error: LauncherError };

export type TaskKind = "download" | "verify" | "repair" | "runtime";

export interface TaskProgress {
  kind: TaskKind;
  paused: boolean;
  totalBytes: number;
  doneBytes: number;
  filesTotal: number;
  filesDone: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  currentFile: string | null;
}

export interface ServerInfo {
  host: string;
  port: number;
  name: string;
  hasPendingInvite: boolean; // an invite code is stored and not used yet
  tailnet: boolean; // the host is a Tailscale address or name
  loopback: boolean;
  fingerprint: string; // the pinned certificate fingerprint (not secret)
}

// A server joined before, for switching back to it without the invite.
export interface SavedServerInfo {
  id: string; // the session slot id (not secret)
  host: string;
  port: number;
  name: string; // the owner's title when the server has one, else the invite's name
  current: boolean;
  username: string | null;
  motd: string | null;
  logo: string | null; // dr-art:// URL
  online: boolean | null; // null = not checked yet
  players: number | null;
  pingMs: number | null;
}

export interface Settings {
  windowed: boolean;
  language: Language;
  gameLanguage: GameLanguage;
  streamerMode?: boolean; // hide addresses, fingerprints, paths and player names on screen
}

export interface Snapshot {
  phase: Phase;
  busy: boolean;
  server: ServerInfo | null;
  savedServers: SavedServerInfo[];
  connect: {
    checking: boolean;
    problem: ConnectProblem;
    tailscaleInstalled: boolean;
    lastCheckedAt: string | null;
  };
  account: {
    username: string | null;
    signedIn: boolean;
  };
  install: {
    dir: string;
    defaultDir: string;
    installed: boolean; // every file present with the right size, and the runtime in place
    missingFiles: number;
    verified: boolean; // this folder's files were fully checked or downloaded by the launcher
    runtimeOk: boolean;
    freeBytes: number | null;
    requiredBytes: number;
    totalBytes: number;
    contentAvailable: boolean;
  };
  task: TaskProgress | null;
  game: { running: boolean; relayPort: number | null };
  settings: Settings;
  app: { version: string; packaged: boolean; updateReady: boolean; runtimeVersion?: string | null };
  status: ServerStatus | null;
  statusUnsupported: boolean; // the server answers but lists nobody (Mystic Paradox has no player list)
  lastError: LauncherError | null;
  notice: NoticeCode | null;
}

export interface NewsItem {
  date: string | null;
  title: string;
  body: string;
  image?: string; // host path from the server; a dr-art:// URL once handed to the renderer
}

export interface Branding {
  backgrounds: { url: string; credit: string | null }[]; // app-internal dr-art:// URLs
  accent: string | null;
}

// The links the page can ask the main process to open. The page names one of these; it never passes
// a URL. The main process maps each to its URL (src/main/links.ts).
export type ExternalTarget =
  | "tailscale_download"
  | "server_source"
  | "project_source"
  | "project_license"
  | "project_contributors"
  | "revived_source"
  | "revived_contributors"
  | "upstream_source"
  | "upstream_contributors"
  | "mystic_source"
  | "discord";

export type RegisterOutcome =
  | { ok: true; username: string }
  | { ok: false; error: LauncherError };

// Channel names (renderer -> main are invoke channels, main -> renderer are events).
export const IPC = {
  getSnapshot: "dr:get-snapshot",
  checkInvite: "dr:check-invite",
  submitInvite: "dr:submit-invite",
  retryConnect: "dr:retry-connect",
  forgetServer: "dr:forget-server",
  switchServer: "dr:switch-server",
  removeSavedServer: "dr:remove-saved-server",
  addServer: "dr:add-server",
  register: "dr:register",
  signIn: "dr:sign-in",
  chooseInstallDir: "dr:choose-install-dir",
  useExistingGameFolder: "dr:use-existing-game-folder",
  useExistingGamePath: "dr:use-existing-game-path",
  startInstall: "dr:start-install",
  pauseTask: "dr:pause-task",
  resumeTask: "dr:resume-task",
  cancelTask: "dr:cancel-task",
  repair: "dr:repair",
  play: "dr:play",
  setSettings: "dr:set-settings",
  setStatusPolling: "dr:set-status-polling",
  refreshStatus: "dr:refresh-status",
  getNews: "dr:get-news",
  getBranding: "dr:get-branding",
  openExternal: "dr:open-external",
  openGameFolder: "dr:open-game-folder",
  logout: "dr:logout",
  installUpdate: "dr:install-update",
  windowMinimize: "dr:window-minimize",
  windowMaximize: "dr:window-maximize",
  windowClose: "dr:window-close",
  takeInviteLink: "dr:take-invite-link",
  dismissNotice: "dr:dismiss-notice",
  dismissError: "dr:dismiss-error",
  closeStrayGames: "dr:close-stray-games",
  // events
  inviteLink: "dr:invite-link",
  snapshot: "dr:snapshot",
  progress: "dr:progress",
  windowState: "dr:window-state",
} as const;
