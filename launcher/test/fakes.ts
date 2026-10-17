// Local stand-ins for a Mystic Paradox backend (/launcher/v1/*) and its content routes
// (/content/v1/*), used by the unit tests. They listen on 127.0.0.1 only, on the spare test ports.

import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

export const CONTENT_PORT = 62012;

export interface TlsOptions {
  cert: string;
  key: string;
}

export function createServer(handler: http.RequestListener, tls?: TlsOptions): http.Server {
  return tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler);
}
export const TEST_BUILD = "dauntless_rel-1.14.7_Shipping_2024-04-01_14-59-21_647472";

export interface FakeFile {
  path: string;
  data: Buffer;
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function makeFiles(): FakeFile[] {
  const pattern = (n: number, seed: number) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7) & 0xff;
    return b;
  };
  return [
    { path: "Archon/Binaries/Win64/Fake-Game.exe", data: pattern(300_000, 1) },
    { path: "Archon/Content/Paks/pakchunk0-WindowsNoEditor.pak", data: pattern(900_000, 2) },
    { path: "Engine/Config/BaseEngine.ini", data: Buffer.from("[Core.System]\r\nPaths=../../../Engine/Content\r\n") },
    { path: "Version.txt", data: Buffer.from(TEST_BUILD) },
    { path: "Archon/Content/Movies/intro (1).bk2", data: pattern(120_000, 3) },
    { path: "Engine/Binaries/Win64/empty.dat", data: Buffer.alloc(0) },
  ];
}

export function manifestFor(files: FakeFile[]) {
  const list = files
    .map((f) => ({ path: f.path, size: f.data.length, sha256: sha256(f.data) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return { build: TEST_BUILD, totalBytes: list.reduce((s, f) => s + f.size, 0), files: list };
}

export interface RequestLog {
  path: string;
  range: string | undefined;
  hadKey: boolean;
  status: number;
}

export interface ContentOptions {
  // Whether a request's Authorization header may download (default: Bearer <key>).
  key?: string;
  authorized?: (authorization: string | undefined) => boolean;
  files: FakeFile[];
  corruptOnce?: Set<string>; // first GET of these paths sends flipped bytes (correct length and ETag)
  chunkSize?: number; // throttling: bytes per tick
  tickMs?: number;
  manifestOverride?: unknown;
  ignoreRange?: boolean;
  news?: unknown;
  branding?: unknown;
  brandingFiles?: Record<string, Buffer>;
}

export class FakeContentServer {
  readonly requests: RequestLog[] = [];
  active = 0;
  maxActive = 0;
  private server: http.Server | null = null;
  private readonly byPath: Map<string, Buffer>;
  private readonly corrupted = new Set<string>();

  constructor(public opts: ContentOptions) {
    this.byPath = new Map(opts.files.map((f) => [f.path, f.data]));
  }

  get manifest() {
    return manifestFor(this.opts.files);
  }

  start(port = CONTENT_PORT, tls?: TlsOptions): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res), tls);
      this.server.on("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve((this.server!.address() as AddressInfo).port));
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/content/v1/manifest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(this.opts.manifestOverride ?? this.manifest));
      return;
    }
    if (url.pathname === "/content/v1/news") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.opts.news ?? { items: [] }));
      return;
    }
    if (url.pathname === "/content/v1/branding") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.opts.branding ?? { backgrounds: [], accent: null }));
      return;
    }
    if (url.pathname.startsWith("/content/v1/branding/")) {
      const data = this.opts.brandingFiles?.[url.pathname.slice("/content/v1/branding/".length)];
      if (!data) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(data);
      return;
    }
    if (!url.pathname.startsWith("/content/v1/files/")) {
      res.writeHead(404).end();
      return;
    }
    const rel = url.pathname
      .slice("/content/v1/files/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const auth = req.headers.authorization;
    const ok = this.opts.authorized ? this.opts.authorized(auth) : auth === `Bearer ${this.opts.key}`;
    const log: RequestLog = { path: rel, range: req.headers.range, hadKey: ok, status: 0 };
    this.requests.push(log);
    if (!ok) {
      log.status = 401;
      res.writeHead(401).end();
      return;
    }
    const data = this.byPath.get(rel);
    if (!data) {
      log.status = 404;
      res.writeHead(404).end();
      return;
    }
    let body = data;
    if (this.opts.corruptOnce?.has(rel) && !this.corrupted.has(rel)) {
      this.corrupted.add(rel);
      body = Buffer.from(data);
      for (let i = 0; i < body.length; i += 997) body[i] ^= 0xff;
    }
    const etag = `"${sha256(data)}"`;
    let start = 0;
    let status = 200;
    const headers: http.OutgoingHttpHeaders = { etag, "content-type": "application/octet-stream", "accept-ranges": "bytes" };
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (range && !this.opts.ignoreRange) {
      start = Number(range[1]);
      if (start >= data.length) {
        log.status = 416;
        res.writeHead(416, { "content-range": `bytes */${data.length}` }).end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${data.length - 1}/${data.length}`;
    }
    const slice = body.subarray(start);
    headers["content-length"] = String(slice.length);
    log.status = status;
    res.writeHead(status, headers);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    let finished = false;
    const done = () => {
      if (!finished) {
        finished = true;
        this.active--;
      }
    };
    res.on("close", done);
    const chunk = this.opts.chunkSize ?? 0;
    if (!chunk) {
      // A short delay keeps several transfers open at once, so the concurrency limit is observable.
      setTimeout(() => {
        res.end(slice);
        done();
      }, 30);
      return;
    }
    let offset = 0;
    const tick = () => {
      if (res.destroyed) return done();
      if (offset >= slice.length) {
        res.end();
        return done();
      }
      res.write(slice.subarray(offset, offset + chunk));
      offset += chunk;
      setTimeout(tick, this.opts.tickMs ?? 10);
    };
    tick();
  }
}

// ---------------------------------------------------------------- Mystic Paradox backend

export const RUNTIME_DLL = Buffer.from("fake MysticParadox.dll");
export const RUNTIME_WINMM = Buffer.from("fake winmm.dll");

export interface MysticOptions {
  inviteCodes?: Set<string>;
  online?: boolean;
  changelist?: number;
  runtime?: boolean; // publish a runtime release (default true)
}

interface FakeAccount {
  userId: string;
  username: string;
  password: string;
  approved: boolean;
}

export class FakeMystic {
  readonly accounts = new Map<string, FakeAccount>(); // lower-case username -> account
  readonly calls: { method: string; path: string; body: Record<string, unknown> | null; auth: string | undefined }[] = [];
  readonly refreshTokens = new Map<string, { userId: string; family: string; used: boolean }>();
  readonly accessTokens = new Map<string, string>(); // token -> userId
  readonly revokedFamilies = new Set<string>();
  readonly exchangeCodes: string[] = [];
  // userId -> characters (2 at most, like the backend default); slot 1 is implicit until named.
  readonly characterSlots = new Map<string, { slot: number; label: string }[]>();
  private counter = 0;

  constructor(public opts: MysticOptions = {}) {}

  addAccount(username: string, password: string, approved = true): FakeAccount {
    const a = { userId: `00000000-0000-4000-8000-${String(++this.counter).padStart(12, "0")}`, username, password, approved };
    this.accounts.set(username.toLowerCase(), a);
    return a;
  }

  userFor(auth: string | undefined): FakeAccount | undefined {
    const token = auth?.replace(/^Bearer /, "") ?? "";
    const id = this.accessTokens.get(token);
    return [...this.accounts.values()].find((a) => a.userId === id);
  }

  private session(a: FakeAccount, family = randomBytes(8).toString("hex")) {
    const accessToken = `acc-${++this.counter}`;
    const refreshToken = randomBytes(32).toString("hex");
    this.accessTokens.set(accessToken, a.userId);
    this.refreshTokens.set(refreshToken, { userId: a.userId, family, used: false });
    return { accessToken, refreshToken, account: { userId: a.userId, displayName: a.username, email: "", approvalStatus: a.approved ? "approved" : "pending" } };
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private error(res: http.ServerResponse, status: number, code: string, message = code): void {
    this.json(res, status, { error: { code, message, requestId: "test" } });
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        return this.error(res, 400, "AUTH_VALIDATION_FAILED");
      }
      const url = new URL(req.url ?? "/", "http://x");
      this.calls.push({ method: req.method ?? "", path: url.pathname, body, auth: req.headers.authorization });
      this.route(req, res, url.pathname, body ?? {});
    });
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, p: string, body: Record<string, unknown>): void {
    if (p === "/launcher/v1/status") {
      return this.json(res, 200, { online: this.opts.online ?? true, supportedBuildChangelist: this.opts.changelist ?? 647472 });
    }
    if (p === "/launcher/v1/info") {
      return this.json(res, 200, { title: "Friday Night Hunts", motd: "Hunts at 8.\r\nBe nice.", logo: null, playersOnline: 3 });
    }
    if (p === "/launcher/v1/auth/register" && req.method === "POST") {
      const name = String(body.displayName ?? "");
      if (!/^[A-Za-z0-9]{3,16}$/.test(name)) return this.error(res, 400, "AUTH_VALIDATION_FAILED", "Username can only contain letters and numbers.");
      if (typeof body.password !== "string" || body.password.length < 8) return this.error(res, 400, "AUTH_VALIDATION_FAILED", "Password must be at least 8 characters.");
      if (this.accounts.has(name.toLowerCase())) return this.error(res, 409, "AUTH_DISPLAY_NAME_TAKEN");
      const invited = body.inviteCode !== undefined;
      if (invited && !this.opts.inviteCodes?.has(String(body.inviteCode))) return this.error(res, 401, "AUTH_INVITE_INVALID");
      const a = this.addAccount(name, body.password, invited);
      if (!invited) return this.json(res, 202, { approvalRequired: true, account: { userId: a.userId, displayName: a.username } });
      return this.json(res, 200, { approvalRequired: false, ...this.session(a) });
    }
    if (p === "/launcher/v1/auth/login" && req.method === "POST") {
      const id = String(body.email ?? "").toLowerCase();
      const a = this.accounts.get(id);
      if (!a || a.password !== body.password) return this.error(res, 401, "AUTH_INVALID_CREDENTIALS");
      if (!a.approved) return this.error(res, 403, "AUTH_APPROVAL_PENDING");
      return this.json(res, 200, this.session(a));
    }
    if (p === "/launcher/v1/auth/refresh" && req.method === "POST") {
      const r = this.refreshTokens.get(String(body.refreshToken ?? ""));
      if (!r || this.revokedFamilies.has(r.family)) return this.error(res, 401, "AUTH_REFRESH_INVALID");
      // Like the backend: an already-rotated token coming back revokes the whole family.
      if (r.used) {
        this.revokedFamilies.add(r.family);
        return this.error(res, 401, "AUTH_REFRESH_INVALID");
      }
      r.used = true;
      const a = [...this.accounts.values()].find((x) => x.userId === r.userId)!;
      return this.json(res, 200, this.session(a, r.family));
    }
    if (p === "/launcher/v1/auth/logout" && req.method === "POST") return this.json(res, 200, {});
    const characterPath = /^\/launcher\/v1\/characters(?:\/(\d+))?$/.exec(p);
    if (characterPath) {
      const a = this.userFor(req.headers.authorization);
      if (!a) return this.error(res, 401, "AUTH_UNAUTHORIZED");
      const list = this.characterSlots.get(a.userId) ?? [{ slot: 1, label: "Character 1" }];
      this.characterSlots.set(a.userId, list);
      const target = characterPath[1] ? list.find((c) => c.slot === Number(characterPath[1])) : undefined;
      if (characterPath[1] && !target) return this.error(res, 404, "NOT_FOUND");
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (req.method === "POST") {
        if (list.length >= 2) return this.error(res, 409, "CHARACTER_LIMIT_REACHED");
        list.push({ slot: list.length + 1, label: label || `Character ${list.length + 1}` });
      } else if (req.method === "PATCH") {
        if (!label) return this.error(res, 400, "AUTH_VALIDATION_FAILED", "Character names are 1-24 letters.");
        target!.label = label;
      } else if (req.method === "DELETE") {
        if (target!.slot === 1 || String(body.confirmLabel ?? "").toLowerCase() !== target!.label.toLowerCase()) {
          return this.error(res, 400, "AUTH_VALIDATION_FAILED", "Type the character's name exactly to confirm.");
        }
        list.splice(list.indexOf(target!), 1);
      }
      return this.json(res, 200, { max: 2, lastSlot: 1, characters: list.map((c) => ({ ...c, level: c.slot * 3, lastPlayedAt: null, online: false })) });
    }
    if (p === "/launcher/v1/game-sessions" && req.method === "POST") {
      const player = this.userFor(req.headers.authorization);
      if (!player) return this.error(res, 401, "AUTH_UNAUTHORIZED");
      if (body.buildChangelist !== 647472 || typeof body.executableSha256 !== "string") return this.error(res, 400, "AUTH_VALIDATION_FAILED");
      const artifacts = body.runtimeArtifacts as { name: string; sha256: string }[];
      const want = [{ name: "MysticParadox.dll", sha256: sha256(RUNTIME_DLL) }, { name: "winmm.dll", sha256: sha256(RUNTIME_WINMM) }];
      if (body.runtimeManifestVersion !== "1.2.3" || JSON.stringify(artifacts) !== JSON.stringify(want)) return this.error(res, 403, "RUNTIME_BUILD_UNSUPPORTED");
      const code = randomBytes(32).toString("hex");
      this.exchangeCodes.push(code);
      const slot = Number(body.characterSlot ?? 1);
      if (!(this.characterSlots.get(player.userId) ?? [{ slot: 1 }]).some((c) => c.slot === slot)) return this.error(res, 404, "NOT_FOUND");
      // Slot 1 is the account's own id; later characters get their own.
      const gameUserId = slot === 1 ? player.userId : `${player.userId.slice(0, -1)}${slot}`;
      return this.json(res, 200, { exchangeCode: code, expiresInSeconds: 60, gameUserId });
    }
    const base = "/launcher/v1/runtime/client/stable/windows-x86_64";
    if (this.opts.runtime !== false) {
      if (p === base) {
        return this.json(res, 200, {
          version: "1.2.3",
          targetChangelist: 647472,
          sha256: sha256(RUNTIME_DLL),
          signature: "unused",
          url: `https://elsewhere.example${base}/download`,
          extraFiles: [{ name: "winmm.dll", sha256: sha256(RUNTIME_WINMM), signature: "unused", url: "https://elsewhere.example/x" }],
        });
      }
      if (p === `${base}/download`) return void res.writeHead(200).end(RUNTIME_DLL);
      if (p === `${base}/extra/winmm.dll`) return void res.writeHead(200).end(RUNTIME_WINMM);
    }
    res.writeHead(404).end();
  }
}
