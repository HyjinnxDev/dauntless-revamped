// The launcher's state machine. It owns every piece of state; the renderer draws Snapshots and
// sends intents. Nothing in here imports Electron: main.ts passes the platform pieces in, which
// keeps this testable with plain Node.
//
// One kind of server: a Mystic Paradox backend for Dauntless 1.14.7, reached over TLS pinned to the
// invite's certificate fingerprint (over Tailscale or a public address). While the game runs, a local
// relay on 127.0.0.1 carries the game's own HTTP and chat traffic to it (relay.ts); the runtime finds
// the relay through MYSTICPARADOX_API_BASE. The game's UDP traffic goes straight to the server's
// game ports.

import { createHash } from "node:crypto";
import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { gameExitDetail } from "./windows-runtime";

import { parseInvite, isLoopbackHost, isTailnetHost, type Invite } from "../shared/invite";
import { checkUsername, isValidPassword } from "../shared/username";
import type {
  ActionResult,
  Branding,
  ConnectProblem,
  ErrorCode,
  ExternalTarget,
  GameLanguage,
  InviteCheck,
  Language,
  LauncherError,
  NewsItem,
  NoticeCode,
  Phase,
  RegisterOutcome,
  Settings,
  Snapshot,
  TaskProgress,
} from "../shared/types";
import { GAME_LANGUAGES, LANGUAGES } from "../shared/types";
import type { Endpoint } from "./http";
import {
  fetchBrandingImage,
  fetchBrandingIndex,
  fetchContentManifest,
  fetchNews,
  fetchRuntimeRelease,
  fetchServerStatus,
  login,
  logout as apiLogout,
  probeContent,
  refreshSession,
  registerAccount,
  requestGameSession,
  type ApiFailure,
  type RuntimeRelease,
  type Session,
  type SessionResult,
} from "./hostapi";
import { compareManifests, resolveInside, type GameManifest, type ManifestFile } from "./manifest";
import { contentDownloadBase, DownloadError, DownloadJob } from "./downloader";
import { AbortedError, hashFile, removePartFiles, verifyInstall, VerifiedCache } from "./verify";
import { installRuntime, installedRuntime, runtimeMatches, RuntimeError, win64Dir } from "./runtime";
import { locateExistingGame } from "./game-folder";
import { buildLaunchArgs, describeLaunch, GameProcess, gameLocale, relayEnv, type SpawnFn } from "./launch";
import { KeyStore, serverId, type Encryptor, type KeySlot } from "./keystore";
import { SettingsStore, type StoredServer, type StoredSettings } from "./settings";
import { freeBytes } from "./system";
import { fixedLinkUrl, isAllowedExternalUrl } from "./links";
import { describeError, log } from "./log";
import { DEFAULT_RELAY_PORT, Relay, RelayError } from "./relay";
import { DISK_MARGIN_BYTES, EXE_NAME, EXE_RELATIVE_PATH, PINNED_EXE_SHA256, PROJECT_URL, STATUS_POLL_MS } from "./constants";

export interface Platform {
  userDataDir: string;
  defaultInstallDir: string;
  appVersion: string;
  packaged: boolean;
  defaultLanguage: Language;
  // The operating system's locale ("es-ES"), for the game language "auto".
  systemLocale?: string;
  deviceName?: string;
  encryptor: Encryptor;
  manifest: GameManifest | null;
  // Where the local relay listens while the game runs (tests and rehearsals change it).
  relayPort?: number;
  // The file checked by hash before every launch (tests use a fake game).
  exePin?: { relativePath: string; sha256: string };
  chooseFolder(title: string, defaultPath: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  openPath(dir: string): Promise<void>;
  emitSnapshot(s: Snapshot): void;
  emitProgress(p: TaskProgress): void;
  findTailscale(): string | null;
  findRunningClients(): Promise<number[]>;
  spawn?: SpawnFn;
  installUpdate?(): void;
}

interface InstallInfo {
  present: number;
  missing: ManifestFile[];
  partFiles: number;
  runtimeOk: boolean;
}

// The signed-in account on the current server, in memory only. The refresh token is in the KeyStore.
interface Account {
  userId: string;
  username: string;
  accessToken: string;
  expiresAt: number;
}

// The backend's access tokens last 12 minutes; renew a little before that.
const ACCESS_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

const err = (code: ErrorCode, detail?: string): { ok: false; error: LauncherError } => ({ ok: false, error: detail ? { code, detail } : { code } });
const OK: ActionResult = { ok: true };

export function endpointFor(sv: StoredServer): Endpoint {
  return { host: sv.host, port: sv.port, pin: sv.fp };
}

export class Controller {
  private readonly settings: SettingsStore;
  private readonly keys: KeyStore;
  private readonly game: GameProcess;
  private readonly verified: VerifiedCache;

  private reachable: boolean | null = null;
  private checking = false;
  private connectProblem: ConnectProblem = null;
  private tailscaleInstalled = false;
  private lastCheckedAt: string | null = null;
  private failedPolls = 0;
  private contentProbe: boolean | null = null;
  private account: Account | null = null;
  // One refresh at a time: refresh tokens rotate, and the server revokes the whole sign-in when an
  // already-used one comes back (two parallel refreshes would do exactly that).
  private refreshing: Promise<Account | null> | null = null;
  // Bumped when the server or the sign-in changes, so answers already on their way are dropped.
  private generation = 0;
  private busy = false;
  private install: InstallInfo = { present: 0, missing: [], partFiles: 0, runtimeOk: false };
  private runtimeRelease: RuntimeRelease | null = null;
  private freeSpace: number | null = null;
  private task: TaskProgress | null = null;
  private taskAbort: AbortController | null = null;
  private job: DownloadJob | null = null;
  private lastError: LauncherError | null = null;
  private notice: NoticeCode | null = null;
  private updateReady = false;
  private polling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private news: NewsItem[] | null = null;
  private newsCheckedAt = -Infinity;
  private newsLoading = false;
  private branding: Branding | null = null;
  private art = new Map<string, { file: string; type: string }>();
  private relay: Relay | null = null;
  private phase: Phase = "loading";

  constructor(private readonly p: Platform) {
    this.settings = new SettingsStore(p.userDataDir, p.defaultLanguage);
    this.keys = new KeyStore(path.join(p.userDataDir, "sessions"), p.encryptor);
    this.game = new GameProcess(p.spawn);
    this.verified = new VerifiedCache(path.join(p.userDataDir, "verified-files.json"));
    this.game.onChange((running, code) => {
      log.info(running ? "game started" : `game exited (code ${code ?? "none"})`);
      if (!running) {
        if (code !== null && code !== 0) this.lastError = { code: "launch_failed", detail: gameExitDetail(code) };
        void this.stopRelay().then(() => this.publish());
        return;
      }
      this.publish();
    });
  }

  // ------------------------------------------------------------------ basics

  private get s(): StoredSettings {
    return this.settings.get();
  }

  get installDir(): string {
    return this.s.installDir ?? this.p.defaultInstallDir;
  }

  // True while the game runs through the local relay: closing the launcher would cut the game off.
  get relayActive(): boolean {
    return this.relay !== null && this.relay.running;
  }

  get gameRunning(): boolean {
    return this.game.running;
  }

  private endpoint(): Endpoint | null {
    const sv = this.s.server;
    return sv ? endpointFor(sv) : null;
  }

  private contentEndpoint(): Endpoint | null {
    return this.contentProbe === true ? this.endpoint() : null;
  }

  private slot(): KeySlot | null {
    const sv = this.s.server;
    return sv ? { host: sv.host, port: sv.port, fp: sv.fp } : null;
  }

  private sid(): string | null {
    const sv = this.s.server;
    return sv ? serverId(sv.host, sv.port) : null;
  }

  private device(): { deviceId: string; deviceName: string } {
    return { deviceId: this.s.deviceId, deviceName: this.p.deviceName ?? "Dauntless Forever launcher" };
  }

  async init(): Promise<void> {
    await this.inspectInstall();
    this.publish();
    if (this.s.server) void this.connect();
  }

  private computePhase(): Phase {
    if (!this.s.server) return "join";
    if (this.task) return "installing";
    if (this.game.running) return "running";
    if (this.reachable !== true) return "connect";
    if (!this.account) return "register";
    if (!this.p.manifest) return "install";
    if (this.install.present === 0 && this.install.partFiles === 0) return "install";
    if (this.install.missing.length > 0 || !this.install.runtimeOk || this.s.verifiedDir !== this.installDir) return "update";
    return "ready";
  }

  snapshot(): Snapshot {
    this.phase = this.computePhase();
    const sv = this.s.server;
    const sid = this.sid();
    const manifest = this.p.manifest;
    const missingBytes = this.install.missing.reduce((a, f) => a + f.size, 0);
    return {
      phase: this.phase,
      busy: this.busy,
      savedServers: this.s.savedServers.map((o) => {
        const id = serverId(o.host, o.port);
        return { id, host: o.host, port: o.port, name: o.name, current: sid === id, username: this.s.usernames[id] ?? null };
      }),
      server: sv
        ? {
            host: sv.host,
            port: sv.port,
            name: sv.name,
            hasPendingInvite: sv.code !== null,
            tailnet: isTailnetHost(sv.host),
            loopback: isLoopbackHost(sv.host),
            fingerprint: sv.fp,
          }
        : null,
      connect: { checking: this.checking, problem: this.connectProblem, tailscaleInstalled: this.tailscaleInstalled, lastCheckedAt: this.lastCheckedAt },
      account: {
        username: this.account?.username ?? (sid ? this.s.usernames[sid] ?? null : null),
        signedIn: this.account !== null,
      },
      install: {
        dir: this.installDir,
        defaultDir: this.p.defaultInstallDir,
        installed: this.phase === "ready" || this.phase === "running",
        missingFiles: this.install.missing.length,
        verified: this.s.verifiedDir === this.installDir,
        runtimeOk: this.install.runtimeOk,
        freeBytes: this.freeSpace,
        requiredBytes: missingBytes + DISK_MARGIN_BYTES,
        totalBytes: manifest?.totalBytes ?? 0,
        contentAvailable: this.contentEndpoint() !== null,
      },
      task: this.task,
      game: { running: this.game.running, relayPort: this.relay?.port ?? null },
      settings: this.settingsView(),
      app: { version: this.p.appVersion, packaged: this.p.packaged, updateReady: this.updateReady },
      // Mystic Paradox has no public player list: a reachable server is shown as "online".
      status: null,
      statusUnsupported: this.reachable === true,
      lastError: this.lastError,
      notice: this.notice,
    };
  }

  private settingsView(): Settings {
    return { windowed: this.s.windowed, language: this.s.language, gameLanguage: this.s.gameLanguage, streamerMode: this.s.streamerMode };
  }

  private publish(): void {
    this.p.emitSnapshot(this.snapshot());
  }

  private fail(code: ErrorCode, detail?: string): { ok: false; error: LauncherError } {
    const e = err(code, detail);
    this.lastError = e.error;
    this.publish();
    return e;
  }

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.lastError = null;
    this.publish();
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  setUpdateReady(): void {
    this.updateReady = true;
    this.publish();
  }

  installUpdate(): void {
    if (this.updateReady && !this.task && !this.game.running) this.p.installUpdate?.();
  }

  setNotice(code: NoticeCode | null): void {
    this.notice = code;
    this.publish();
  }

  dismissNotice(): void {
    this.setNotice(null);
  }

  dismissError(): void {
    this.lastError = null;
    this.publish();
  }

  // ------------------------------------------------------------------ join / connect

  // Is there a sign-in for this host:port that belongs to another certificate? The page asks before
  // it offers to join, so that it can warn instead of offering a one-click join.
  async checkInvite(text: unknown): Promise<InviteCheck> {
    const parsed = parseInvite(text);
    if (!parsed.ok) return err("invite_invalid_format", parsed.error);
    const change = await this.certificateChange(parsed.invite);
    return { ok: true, certificateChanged: change !== null, previousFingerprint: change?.fp ?? null };
  }

  private async certificateChange(inv: Pick<Invite, "host" | "port" | "fp">): Promise<{ fp: string } | null> {
    const bound = await this.keys.certificateOf(inv);
    return bound && bound.fp !== inv.fp ? bound : null;
  }

  // Joins the server from an invite. When the invite carries another certificate than the one this
  // PC's sign-in for that host:port belongs to, nothing is changed or sent (error cert_changed,
  // detail = the saved fingerprint) until the user confirms the new certificate.
  async submitInvite(text: unknown, opts: { acceptNewCertificate?: boolean } = {}): Promise<ActionResult> {
    if (this.busy || this.task) return err("busy");
    if (this.game.running) return this.fail("already_running");
    const parsed = parseInvite(text);
    if (!parsed.ok) return this.fail("invite_invalid_format", parsed.error);
    return this.join(parsed.invite, opts);
  }

  // Back to a server joined before, with what its invite said then: no invite to paste again.
  async switchServer(id: string): Promise<ActionResult> {
    if (this.busy || this.task) return err("busy");
    if (this.game.running) return this.fail("already_running");
    const saved = this.s.savedServers.find((sv) => serverId(sv.host, sv.port) === id);
    if (!saved) return this.fail("invite_invalid_format");
    return this.join({ ...saved });
  }

  async removeSavedServer(id: string): Promise<ActionResult> {
    if (id === this.sid()) return err("busy"); // the current server stays in the list
    await this.settings.update((s) => {
      s.savedServers = s.savedServers.filter((sv) => serverId(sv.host, sv.port) !== id);
    });
    this.publish();
    return OK;
  }

  private async join(inv: Omit<Invite, "code"> & { code: string | null }, opts: { acceptNewCertificate?: boolean } = {}): Promise<ActionResult> {
    const change = await this.certificateChange(inv);
    if (change) {
      if (opts.acceptNewCertificate !== true) {
        log.warn(`invite for ${inv.host}:${inv.port} has a new certificate; the stored sign-in stays with the old one until the user confirms`);
        return err("cert_changed", change.fp);
      }
      await this.keys.rebind(inv, inv.fp);
      log.warn(`the user accepted a new certificate for ${inv.host}:${inv.port} (was ${change.fp}, now ${inv.fp})`);
    }
    const current = this.s.server;
    const same = current !== null && current.host === inv.host && current.port === inv.port && current.fp === inv.fp;
    const signedInThere = await this.keys.has(inv);
    await this.settings.update((s) => {
      // A friend who already has an account on this server does not need the code again.
      s.server = { host: inv.host, port: inv.port, name: inv.name, fp: inv.fp, code: signedInThere ? null : inv.code };
    });
    if (!same) this.resetServerState();
    log.info(`joined server ${inv.host}:${inv.port}`);
    this.lastError = null;
    await this.connect();
    return OK;
  }

  private resetServerState(): void {
    this.reachable = null;
    this.contentProbe = null;
    this.connectProblem = null;
    this.news = null;
    this.branding = null;
    this.account = null;
    this.refreshing = null;
    this.runtimeRelease = null;
    this.failedPolls = 0;
    this.generation++;
  }

  async forgetServer(): Promise<ActionResult> {
    if (this.task || this.game.running) return err("busy");
    await this.settings.update((s) => {
      s.server = null;
    });
    this.resetServerState();
    this.publish();
    return OK;
  }

  async connect(): Promise<ActionResult> {
    const sv = this.s.server;
    const ep = this.endpoint();
    if (!sv || !ep) return err("server_unreachable");
    if (this.checking) return OK;
    this.checking = true;
    this.publish();
    try {
      this.tailscaleInstalled = isTailnetHost(sv.host) ? this.p.findTailscale() !== null : false;
      const res = await fetchServerStatus(ep);
      this.lastCheckedAt = new Date().toISOString();
      if (res.kind === "ok") {
        this.reachable = true;
        this.connectProblem = null;
        this.failedPolls = 0;
        this.contentProbe = await probeContent(ep);
        if (!this.account) await this.resumeSession();
        await this.inspectInstall();
        void this.loadExtras();
      } else {
        this.reachable = false;
        if (res.kind === "bad_answer") this.connectProblem = "bad_answer";
        else if (res.kind === "cert_mismatch") this.connectProblem = "cert_mismatch";
        else if (isTailnetHost(sv.host) && !this.tailscaleInstalled) this.connectProblem = "tailscale_missing";
        else this.connectProblem = "unreachable";
        if (this.connectProblem === "cert_mismatch") log.error(`server ${ep.host}:${ep.port} presented a certificate that does not match the invite`);
        else log.warn(`server ${ep.host}:${ep.port} not reachable (${this.connectProblem})`);
      }
      return OK;
    } finally {
      this.checking = false;
      this.publish();
    }
  }

  // ------------------------------------------------------------------ status polling, news, art

  setStatusPolling(on: boolean): void {
    this.polling = on === true;
    if (this.polling && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.pollStatus(), STATUS_POLL_MS);
      void this.pollStatus();
    } else if (!this.polling && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollStatus(): Promise<void> {
    const ep = this.endpoint();
    if (!ep || this.checking) return;
    if (this.reachable !== true) {
      // Keep retrying quietly in the background while the guide is shown.
      if (this.connectProblem !== "cert_mismatch") await this.connect();
      return;
    }
    const gen = this.generation;
    const res = await fetchServerStatus(ep);
    if (gen !== this.generation) return;
    if (res.kind === "ok") {
      this.failedPolls = 0;
      if (this.branding === null) void this.loadExtras();
      else void this.refreshNews();
    } else if (res.kind === "cert_mismatch") {
      this.reachable = false;
      this.connectProblem = "cert_mismatch";
      log.error("the server's certificate changed and no longer matches the invite");
    } else {
      this.failedPolls++;
      // While the game runs, a busy moment on the server must not flip the launcher back to the
      // connect guide.
      if (this.failedPolls >= 2 && !this.game.running) {
        this.reachable = false;
        this.connectProblem = "unreachable";
      }
    }
    this.publish();
  }

  async refreshStatus(): Promise<void> {
    await this.pollStatus();
  }

  private async refreshNews(): Promise<void> {
    const ep = this.contentEndpoint();
    if (!ep || this.newsLoading || (this.news !== null && Date.now() - this.newsCheckedAt < 60000)) return;
    this.newsLoading = true;
    const gen = this.generation;
    this.newsCheckedAt = Date.now();
    try {
      const items = await fetchNews(ep, this.news ?? []);
      if (gen === this.generation) {
        this.news = items;
        this.publish();
      }
    } finally {
      this.newsLoading = false;
    }
  }

  private async loadExtras(): Promise<void> {
    const ep = this.contentEndpoint();
    if (!ep) return;
    await this.refreshNews();
    if (this.branding === null) {
      const index = await fetchBrandingIndex(ep);
      const backgrounds: Branding["backgrounds"] = [];
      const cacheDir = path.join(this.p.userDataDir, "art-cache");
      await fsp.mkdir(cacheDir, { recursive: true });
      for (const b of index.backgrounds) {
        const img = await fetchBrandingImage(ep, b.path);
        if (!img) continue;
        const id = createHash("sha256").update(img.data).digest("hex");
        const file = path.join(cacheDir, id);
        await fsp.writeFile(file, img.data);
        this.art.set(id, { file, type: img.type });
        backgrounds.push({ url: `dr-art://bg/${id}`, credit: b.credit });
      }
      this.branding = { backgrounds, accent: index.accent };
    }
    this.publish();
  }

  getNews(): NewsItem[] {
    return this.news ?? [];
  }

  getBranding(): Branding {
    return this.branding ?? { backgrounds: [], accent: null };
  }

  // Used by the dr-art:// protocol handler: only ids this session downloaded are served.
  resolveArt(id: string): { file: string; type: string } | null {
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    return this.art.get(id) ?? null;
  }

  // ------------------------------------------------------------------ account

  // Keeps a new or refreshed session: the rotated refresh token goes to the KeyStore, the access
  // token stays in memory.
  private async adopt(session: Session): Promise<Account> {
    const slot = this.slot();
    const sid = this.sid();
    if (!slot || !sid) throw new Error("no server");
    await this.keys.save(slot, session.refreshToken);
    this.account = { userId: session.userId, username: session.username, accessToken: session.accessToken, expiresAt: Date.now() + ACCESS_TOKEN_LIFETIME_MS };
    if (this.s.usernames[sid] !== session.username || this.s.server?.code) {
      await this.settings.update((s) => {
        s.usernames[sid] = session.username;
        if (s.server) s.server.code = null;
      });
    }
    return this.account;
  }

  // Trades the stored refresh token for a new session. Only one at a time (see `refreshing`).
  private refresh(): Promise<Account | null> {
    if (this.refreshing) return this.refreshing;
    const gen = this.generation;
    const run = async (): Promise<Account | null> => {
      const ep = this.endpoint();
      const slot = this.slot();
      if (!ep || !slot) return null;
      const token = await this.keys.load(slot).catch(() => null);
      if (!token) return null;
      const res = await refreshSession(ep, token, this.device());
      if (gen !== this.generation) return null;
      if (res.ok) return this.adopt(res.session);
      if (res.error === "session_expired" || res.error === "account_banned") {
        await this.keys.remove(slot);
        this.account = null;
        this.lastError = res.error === "account_banned" ? { code: "account_banned", detail: res.detail } : { code: "session_expired" };
        log.warn(`the server no longer accepts the stored sign-in (${res.error})`);
      } else {
        // Unreachable, rate limited, server error: the sign-in is kept for the next try.
        this.lastError = { code: res.error };
      }
      return null;
    };
    this.refreshing = run().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  // A current access token, refreshing when needed. null = not signed in (any more).
  async accessToken(): Promise<string | null> {
    if (this.account && Date.now() < this.account.expiresAt) return this.account.accessToken;
    const account = await this.refresh();
    return account?.accessToken ?? null;
  }

  private async resumeSession(): Promise<void> {
    if (await this.refresh()) log.info(`signed in as ${this.account?.username}`);
  }

  private async sessionOutcome(res: SessionResult, what: string): Promise<RegisterOutcome> {
    if (!res.ok) {
      log.warn(`${what} refused: ${res.error}`);
      this.lastError = res.detail ? { code: res.error, detail: res.detail } : { code: res.error };
      return { ok: false, error: this.lastError };
    }
    try {
      await this.adopt(res.session);
    } catch (e) {
      log.error(`could not store the sign-in: ${describeError(e)}`);
      this.account = null;
      this.lastError = { code: "key_storage_unavailable" };
      return err("key_storage_unavailable");
    }
    log.info(`${what}: ${res.session.username}`);
    await this.inspectInstall();
    return { ok: true, username: res.session.username };
  }

  async register(username: unknown, password: unknown): Promise<RegisterOutcome> {
    if (this.busy || this.task) return err("busy");
    const check = checkUsername(username);
    if (check !== "ok") return this.fail("username_invalid", check);
    if (!isValidPassword(password)) return this.fail("password_invalid");
    const ep = this.endpoint();
    const sv = this.s.server;
    if (!ep || !sv) return err("server_unreachable");
    return this.withBusy(async () => {
      const res = await registerAccount(ep, { username: username as string, password: password as string, inviteCode: sv.code, ...this.device() });
      return this.sessionOutcome(res, "registered");
    });
  }

  // identifier: the username (or the email of an account made with one).
  async signIn(identifier: unknown, password: unknown): Promise<RegisterOutcome> {
    if (this.busy || this.task) return err("busy");
    if (typeof identifier !== "string" || identifier.trim().length === 0 || identifier.length > 254) return this.fail("login_failed");
    if (typeof password !== "string" || password.length === 0 || password.length > 256) return this.fail("login_failed");
    const ep = this.endpoint();
    if (!ep) return err("server_unreachable");
    return this.withBusy(async () => {
      const res = await login(ep, { identifier: identifier.trim(), password, ...this.device() });
      return this.sessionOutcome(res, "signed in");
    });
  }

  async logout(): Promise<ActionResult> {
    if (this.task || this.game.running) return err("busy");
    const slot = this.slot();
    const ep = this.endpoint();
    if (!slot || !ep) return OK;
    const token = this.account?.accessToken;
    this.generation++;
    this.account = null;
    this.refreshing = null;
    await this.keys.remove(slot);
    if (token) await apiLogout(ep, token);
    log.info("signed out");
    this.publish();
    return OK;
  }

  // ------------------------------------------------------------------ install folder

  async inspectInstall(): Promise<void> {
    const manifest = this.p.manifest;
    const dir = this.installDir;
    this.freeSpace = await freeBytes(dir);
    if (!manifest) {
      this.install = { present: 0, missing: [], partFiles: 0, runtimeOk: false };
      return;
    }
    let present = 0;
    let partFiles = 0;
    const missing: ManifestFile[] = [];
    for (const f of manifest.files) {
      const full = resolveInside(dir, f.path);
      try {
        const st = await fsp.stat(full);
        if (st.isFile() && st.size === f.size) {
          present++;
          continue;
        }
      } catch {
        /* missing */
      }
      missing.push(f);
      if (existsSync(full + ".part")) partFiles++;
    }
    this.install = { present, missing, partFiles, runtimeOk: present > 0 && (await this.runtimeOk(dir)) };
  }

  // The runtime counts as fine when it matches the server's current release (or, before the release
  // is known, when both files are there at all).
  private async runtimeOk(dir: string): Promise<boolean> {
    const ep = this.endpoint();
    if (ep && this.reachable === true && !this.runtimeRelease) {
      const release = await fetchRuntimeRelease(ep);
      if ("files" in release) this.runtimeRelease = release;
    }
    if (this.runtimeRelease) return runtimeMatches(await installedRuntime(dir, this.runtimeRelease), this.runtimeRelease);
    return ["MysticParadox.dll", "winmm.dll"].every((n) => existsSync(path.join(win64Dir(dir), n)));
  }

  async chooseInstallDir(): Promise<ActionResult> {
    if (this.task || this.busy || this.game.running) return err("busy");
    const picked = await this.p.chooseFolder("install", this.installDir);
    if (!picked) return err("cancelled");
    // A folder that already holds the game is used as that game: no second copy is downloaded next to it.
    const existing = await locateExistingGame(picked, "win32");
    if (this.task || this.busy || this.game.running) return err("busy");
    // A game found there whose root is too long is refused, not given a second copy in a subfolder
    // (which would be longer still).
    if (!existing.ok && existing.reason === "too_long") return this.fail("folder_invalid");
    let dir = existing.ok ? existing.root : path.win32.resolve(picked);
    if (!/^[A-Za-z]:[\\/]/.test(dir) || dir.length > 150) return this.fail("folder_invalid");
    // Otherwise an empty folder is used as is, and anything else gets a subfolder.
    if (!existing.ok) {
      const entries = await fsp.readdir(dir).catch(() => [] as string[]);
      if (entries.length > 0 && !entries.some((e) => e.toLowerCase() === "archon")) dir = path.win32.join(dir, "Dauntless");
    }
    await this.settings.update((s) => {
      s.installDir = dir === this.p.defaultInstallDir ? null : dir;
    });
    await this.inspectInstall();
    this.publish();
    return OK;
  }

  async useExistingGameFolder(): Promise<ActionResult> {
    if (this.task || this.busy || this.game.running) return err("busy");
    const picked = await this.p.chooseFolder("existing", this.installDir);
    if (!picked) return err("cancelled");
    return this.useExistingGamePath(picked);
  }

  // "I already have the game files", from a pasted path or a picked folder. The game is used where it
  // is: Repair checks every file against the manifest, fetches only what is missing or different, and
  // installs the server's runtime.
  async useExistingGamePath(input: string): Promise<ActionResult> {
    if (this.task || this.busy || this.game.running) return err("busy");
    const found = await locateExistingGame(input, "win32");
    if (this.task || this.busy || this.game.running) return err("busy");
    if (!found.ok) return this.fail(found.reason === "not_found" ? "game_folder_not_found" : "folder_invalid");
    await this.settings.update((s) => {
      s.installDir = found.root;
      s.verifiedDir = null;
    });
    await this.inspectInstall();
    return this.repair();
  }

  async openGameFolder(): Promise<void> {
    const dir = this.installDir;
    if (existsSync(dir)) await this.p.openPath(dir);
  }

  // ------------------------------------------------------------------ install / repair

  startInstall(): Promise<ActionResult> {
    return this.runTask("install");
  }

  repair(): Promise<ActionResult> {
    return this.runTask("repair");
  }

  pauseTask(): void {
    if (this.job && this.task?.kind === "download") this.job.pause();
  }

  resumeTask(): void {
    if (this.job && this.task?.kind === "download") this.job.resume();
  }

  cancelTask(): void {
    this.job?.cancel();
    this.taskAbort?.abort();
  }

  private setTask(t: TaskProgress | null): void {
    this.task = t;
    if (t) this.p.emitProgress(t);
  }

  // The server's current runtime release, installed next to the game exe.
  private async ensureRuntime(dir: string): Promise<RuntimeRelease | ApiFailure> {
    const ep = this.endpoint();
    if (!ep) return { ok: false, error: "server_unreachable" };
    const release = await fetchRuntimeRelease(ep);
    if (!("files" in release)) return release;
    this.runtimeRelease = release;
    try {
      await installRuntime(ep, dir, release);
    } catch (e) {
      log.error(`runtime install failed: ${describeError(e)}`);
      const map = { download: "runtime_unavailable", in_use: "runtime_in_use", hash: "runtime_failed", disk: "runtime_failed" } as const;
      return { ok: false, error: e instanceof RuntimeError ? map[e.code] : "runtime_failed", detail: e instanceof RuntimeError ? e.file : undefined };
    }
    log.info(`runtime ${release.version} installed`);
    return release;
  }

  private async runTask(mode: "install" | "repair"): Promise<ActionResult> {
    if (this.task || this.busy) return err("busy");
    if (this.game.running) return this.fail("already_running");
    const manifest = this.p.manifest;
    if (!manifest) return this.fail("manifest_unavailable");
    if (!this.s.server) return this.fail("server_unreachable");
    const dir = this.installDir;
    this.lastError = null;
    this.notice = null;
    const abort = new AbortController();
    this.taskAbort = abort;
    const blank = (kind: TaskProgress["kind"], total: number, files: number): TaskProgress => ({
      kind,
      paused: false,
      totalBytes: total,
      doneBytes: 0,
      filesTotal: files,
      filesDone: 0,
      bytesPerSecond: 0,
      etaSeconds: null,
      currentFile: null,
    });
    try {
      await fsp.mkdir(dir, { recursive: true });

      // 1. Which files are needed? Files this launcher already verified in this folder are
      //    trusted by size; anything else (Repair, a folder picked by hand) is hashed.
      const fullHash = mode === "repair" || this.s.verifiedDir !== dir;
      this.setTask(blank("verify", fullHash ? manifest.totalBytes : manifest.files.length, manifest.files.length));
      this.publish();
      const report = await verifyInstall(dir, manifest.files, {
        fullHash,
        signal: abort.signal,
        trusted: mode === "install" ? (f, size, mtime) => this.verified.isTrusted(dir, f, size, mtime) : undefined,
        onProgress: (p) => {
          this.setTask({ ...blank("verify", p.totalBytes, p.filesTotal), doneBytes: p.doneBytes, filesDone: p.filesDone, currentFile: p.currentFile });
        },
      });
      const needed = report.bad.map((b) => b.file);
      for (const b of report.bad) this.verified.forget(dir, b.file);
      if (report.bad.length > 0) log.info(`${report.bad.length} file(s) to fetch (${mode})`);

      // 2. Download what is missing or damaged.
      if (needed.length > 0) {
        const ep = this.endpoint();
        if (ep && this.contentProbe !== true) this.contentProbe = await probeContent(ep);
        const cep = this.contentEndpoint();
        if (!cep) return this.fail("no_content_server");
        if ((await this.accessToken()) === null) return this.fail("session_expired");

        const serverManifest = await fetchContentManifest(cep);
        if (serverManifest === null) return this.fail("manifest_unavailable");
        const cmp = compareManifests(manifest, serverManifest);
        if (!cmp.equal) {
          log.error(`content server manifest refused: ${cmp.difference}`);
          return this.fail("manifest_mismatch", cmp.difference);
        }

        const free = await freeBytes(dir);
        let onDisk = 0;
        for (const f of needed) {
          onDisk += Math.min(f.size, (await fsp.stat(resolveInside(dir, f.path) + ".part").catch(() => ({ size: 0 }))).size);
        }
        const required = needed.reduce((a, f) => a + f.size, 0) - onDisk + DISK_MARGIN_BYTES;
        if (free !== null && free < required) return this.fail("disk_space", String(required));

        const job = new DownloadJob({
          endpoint: cep,
          downloadBaseUrl: contentDownloadBase(serverManifest),
          auth: () => this.accessToken(),
          installDir: dir,
          files: needed,
          onProgress: (p) => this.setTask({ kind: "download", ...p }),
          onRetry: (f, n, reason) => log.warn(`retry ${n} for ${f.path}: ${reason}`),
          onFileVerified: (f) => {
            void this.verified.record(dir, f).then(() => this.verified.save()).catch(() => undefined);
          },
        });
        this.job = job;
        this.setTask(blank("download", needed.reduce((a, f) => a + f.size, 0), needed.length));
        this.publish();
        await job.run();
        this.job = null;
        log.info(`downloaded and verified ${needed.length} file(s)`);
      }

      // 3. The server's runtime.
      this.setTask(blank("runtime", 2, 2));
      this.publish();
      const runtime = await this.ensureRuntime(dir);
      if (!("files" in runtime)) return this.fail(runtime.error, runtime.detail);
      await removePartFiles(dir, manifest.files);
      await this.settings.update((s) => {
        s.verifiedDir = dir;
      });
      log.info(`${mode} finished in ${dir}`);
      this.notice = mode === "install" ? "install_done" : "repair_done";
      return OK;
    } catch (e) {
      if (e instanceof AbortedError || (e instanceof DownloadError && e.code === "cancelled")) {
        log.info(`${mode} cancelled`);
        return err("cancelled");
      }
      if (e instanceof DownloadError) {
        log.error(`download stopped: ${e.code} ${e.filePath ?? ""} ${e.message}`);
        const map: Record<string, ErrorCode> = {
          session_expired: "session_expired",
          file_missing_on_server: "file_missing_on_server",
          file_different_on_server: "file_different_on_server",
          disk_space: "disk_space",
          disk_error: "folder_invalid",
          download_failed: "download_failed",
          cert_mismatch: "cert_mismatch",
        };
        if (e.code === "cert_mismatch") {
          this.reachable = false;
          this.connectProblem = "cert_mismatch";
        }
        return this.fail(map[e.code] ?? "download_failed", e.filePath);
      }
      const code = (e as NodeJS.ErrnoException)?.code;
      log.error(`${mode} failed: ${describeError(e)}`);
      if (code === "ENOSPC") return this.fail("disk_space");
      if (code === "EPERM" || code === "EACCES") return this.fail("folder_invalid");
      return this.fail("unknown");
    } finally {
      await this.verified.save().catch(() => undefined);
      this.job = null;
      this.taskAbort = null;
      this.task = null;
      await this.inspectInstall().catch(() => undefined);
      this.publish();
    }
  }

  // ------------------------------------------------------------------ play

  async play(): Promise<ActionResult> {
    if (this.busy || this.task) return err("busy");
    if (this.game.running) return this.fail("already_running");
    const sv = this.s.server;
    const ep = this.endpoint();
    if (!sv || !ep) return this.fail("server_unreachable");
    return this.withBusy(async () => {
      if ((await this.p.findRunningClients()).length > 0) return this.fail("already_running");
      const dir = this.installDir;
      await this.inspectInstall();
      if (this.install.missing.length > 0) return this.fail("game_files_invalid", String(this.install.missing.length));
      // The exe by hash on every launch; the server checks the same hash before it hands out a login.
      const exePin = this.p.exePin ?? { relativePath: EXE_RELATIVE_PATH, sha256: PINNED_EXE_SHA256 };
      const exeHash = await hashFile(resolveInside(dir, exePin.relativePath)).catch(() => "");
      if (exeHash !== exePin.sha256) return this.fail("game_files_invalid", exePin.relativePath);

      // The server's current runtime release (it may have been updated since the last launch).
      const release = await this.ensureRuntime(dir);
      if (!("files" in release)) return this.fail(release.error, release.detail);
      this.install.runtimeOk = true;

      const token = await this.accessToken();
      if (!token || !this.account) return this.fail(this.lastError?.code ?? "session_expired", this.lastError?.detail);
      const { userId, username } = this.account;
      const ticket = await requestGameSession(ep, token, {
        executableSha256: exeHash,
        runtimeVersion: release.version,
        runtimeArtifacts: release.files.map((f) => ({ name: f.name, sha256: f.sha256 })),
      });
      if (!ticket.ok) return this.fail(ticket.error, ticket.detail);

      // The relay first: the game talks to it from its first request.
      const started = await this.startRelay(sv);
      if (!started.ok) return started;
      const relayPort = this.relay?.port ?? DEFAULT_RELAY_PORT;
      let launched = false;
      try {
        const args = buildLaunchArgs({
          exchangeCode: ticket.exchangeCode,
          userId,
          username,
          windowed: this.s.windowed,
          gameLocale: gameLocale(this.s.gameLanguage, this.p.systemLocale ?? "en-US"),
        });
        log.info(`starting ${describeLaunch(EXE_NAME, args)} (relay 127.0.0.1:${relayPort} -> ${sv.host}:${sv.port})`);
        try {
          await this.game.start(win64Dir(dir), args, relayEnv(relayPort));
        } catch (e) {
          log.error(`launch failed: ${describeError(e)}`);
          return this.fail("launch_failed");
        }
        launched = true;
        return OK;
      } finally {
        if (!launched) await this.stopRelay();
      }
    });
  }

  private async startRelay(sv: StoredServer): Promise<ActionResult> {
    await this.stopRelay();
    const port = this.p.relayPort ?? DEFAULT_RELAY_PORT;
    const relay = new Relay({
      target: { host: sv.host, port: sv.port, fingerprint: sv.fp },
      port,
      onPinError: () => {
        this.lastError = { code: "cert_mismatch" };
        this.publish();
      },
      onLog: (level, message) => log[level](`relay: ${message}`),
    });
    try {
      await relay.start();
    } catch (e) {
      log.error(`relay could not start: ${describeError(e)}`);
      return this.fail(e instanceof RelayError && e.code === "port_busy" ? "relay_port_busy" : "relay_failed", String(port));
    }
    this.relay = relay;
    return OK;
  }

  private async stopRelay(): Promise<void> {
    const relay = this.relay;
    this.relay = null;
    if (relay) {
      await relay.stop().catch(() => undefined);
      log.info(`relay stopped (${relay.requests} requests, ${relay.upgrades} upgrades, ${relay.failures} failures)`);
    }
  }

  // ------------------------------------------------------------------ settings / links

  async setSettings(patch: unknown): Promise<Settings> {
    if (typeof patch === "object" && patch !== null) {
      const p = patch as Record<string, unknown>;
      await this.settings.update((s) => {
        if (typeof p.windowed === "boolean") s.windowed = p.windowed;
        if (typeof p.streamerMode === "boolean") s.streamerMode = p.streamerMode;
        if (LANGUAGES.includes(p.language as Language)) s.language = p.language as Language;
        if (GAME_LANGUAGES.includes(p.gameLanguage as GameLanguage)) s.gameLanguage = p.gameLanguage as GameLanguage;
      });
    }
    this.publish();
    return this.settingsView();
  }

  async openExternal(target: ExternalTarget): Promise<ActionResult> {
    // Every target opens its one fixed URL; an unknown name gets null.
    const url = target === "server_source" ? PROJECT_URL : fixedLinkUrl(target);
    if (!url || !isAllowedExternalUrl(url, null)) return err("unknown");
    await this.p.openExternal(url);
    return OK;
  }

  async shutdown(): Promise<void> {
    this.setStatusPolling(false);
    this.job?.cancel();
    this.taskAbort?.abort();
    await this.stopRelay();
  }
}
