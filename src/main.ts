// Dauntless Revamped Launcher - Electron main process.
//
// Security model: the renderer is sandboxed, has no Node access and no network access at all
// (every request is made here, in the main process, and only to the host from the invite). It can
// only call the small typed API in preload.ts, and every argument is checked again here.

import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, safeStorage, screen, session, shell, Tray, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { existsSync, promises as fsp } from "node:fs";
import { pathToFileURL } from "node:url";
import started from "electron-squirrel-startup";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import { Controller, type Platform } from "./main/controller";
import { GAME_MANIFEST, GAME_MANIFEST_FINGERPRINT, GAME_MANIFEST_PROBLEM } from "./main/game-manifest";
import { findRunningClients } from "./main/launch";
import { findTailscale } from "./main/system";
import { describeError, log, logToFile } from "./main/log";
import { boundedString, externalTarget, isTrustedPageUrl, relayPortOverride, settingsPatch } from "./main/ipc-validate";
import { INVITE_SCHEME, LEGACY_INVITE_SCHEME, parseInvite } from "./shared/invite";
import { IPC, type Language, type Snapshot, type TaskProgress } from "./shared/types";
import { systemLanguage, translate } from "./shared/i18n";
import { APP_ID, SQUIRREL_NAME, UPDATE_FEED_URL } from "./main/constants";
import { migrateUserData, uninstallOldLauncher } from "./main/migrate";

// Squirrel install / update / uninstall events: create or remove shortcuts, then quit.
if (started) app.quit();

// Every renderer runs in the Chromium sandbox, whatever a window's own options say.
app.enableSandbox();
if (process.argv.includes("--safe-mode")) app.disableHardwareAcceleration();
nativeTheme.themeSource = "dark";
app.setAppUserModelId(app.isPackaged ? `com.squirrel.${SQUIRREL_NAME}.${SQUIRREL_NAME}` : APP_ID);
const localAppData = process.env.LOCALAPPDATA ?? path.join(app.getPath("home"), "AppData", "Local");
// Pinned, not productName, so a later rename cannot lose the sign-in and settings again.
const userDataDir = path.join(app.getPath("appData"), "Dauntless Revamped Launcher");
let migrateError: unknown = null;
let migrated = false;
try {
  migrated = !started && migrateUserData(app.getPath("appData"), localAppData, userDataDir) === "copied";
} catch (error) {
  migrateError = error; // logged once logging is up; the launcher still starts, just signed out
}
app.setPath("userData", userDataDir);

// Art from the host's art pack is served to the renderer through this app-internal scheme.
protocol.registerSchemesAsPrivileged([{ scheme: "dr-art", privileges: { standard: true, secure: true } }]);

const DEV_SERVER_URL: string | undefined = MAIN_WINDOW_VITE_DEV_SERVER_URL;
const RENDERER_INDEX = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
const RENDERER_INDEX_URL = pathToFileURL(RENDERER_INDEX).toString();

// The same policy as the page's own meta tag, sent as a header where one can be sent (dev server).
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' dr-art: data:; font-src 'self'; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

let mainWindow: BrowserWindow | null = null;
let controller: Controller | null = null;
let pendingInviteLink: string | null = null;
let quitting = false;
let tray: Tray | null = null;
let trayHintShown = false;

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "assets");
}

// ------------------------------------------------------------------ invite links

function inviteFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && [INVITE_SCHEME, LEGACY_INVITE_SCHEME].some((s) => arg.toLowerCase().startsWith(`${s}:`))) {
      return parseInvite(arg).ok ? arg.trim() : null;
    }
  }
  return null;
}

function deliverInviteLink(link: string | null): void {
  if (!link) return;
  pendingInviteLink = link;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.inviteLink);
}

function registerProtocolClient(): void {
  if (!app.isPackaged) return; // a dev build must not take over the scheme
  // Squirrel keeps a stub exe one folder up that always starts the newest version.
  const stub = path.resolve(path.dirname(process.execPath), "..", path.basename(process.execPath));
  const target = existsSync(stub) ? stub : process.execPath;
  for (const scheme of [INVITE_SCHEME, LEGACY_INVITE_SCHEME]) {
    if (!app.setAsDefaultProtocolClient(scheme, target, [])) log.warn(`could not register the ${scheme}: link handler`);
  }
}

// ------------------------------------------------------------------ window

function createWindow(): void {
  const iconPath = path.join(resourcesDir(), "icon.png");
  // Never larger than the primary screen's usable area (the part the taskbar does not cover):
  // 1366x768 laptops, or 1920x1080 at 150 % scaling, have less than 760 px of height, and the big
  // button at the bottom must stay on screen.
  const work = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1280, work.width),
    height: Math.min(760, work.height),
    minWidth: Math.min(1024, work.width),
    minHeight: Math.min(640, work.height),
    frame: false,
    show: false,
    // The page's ink (styles.css), so nothing flashes before it paints.
    backgroundColor: "#01090D",
    title: "Dauntless Revamped Launcher",
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      safeDialogs: true,
      disableBlinkFeatures: "Auxclick",
    },
  });
  mainWindow.removeMenu();
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  const window = mainWindow;
  const showTimer = setTimeout(() => { if (!window.isDestroyed()) window.show(); }, 10000);
  window.once("closed", () => clearTimeout(showTimer));
  window.webContents.on("render-process-gone", (_event, details) => {
    log.error(`launcher renderer stopped: ${details.reason}`);
    if (!process.argv.includes("--safe-mode") && !controller?.relayActive) {
      app.relaunch({ args: [...process.argv.slice(1), "--safe-mode"] });
      app.exit(0);
    } else {
      dialog.showErrorBox("Dauntless Revamped could not open", "The launcher renderer stopped. Reinstall the latest launcher and send the launcher logs to your host.");
    }
  });
  mainWindow.on("maximize", () => mainWindow?.webContents.send(IPC.windowState, true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send(IPC.windowState, false));

  // The launcher carries the game's connection to the server. Closing it would cut the game off,
  // so while the game runs the window only hides to the tray (quitting from there asks first).
  mainWindow.on("close", (event) => {
    if (quitting || !controller?.relayActive || !mainWindow) return;
    event.preventDefault();
    hideToTray(controller.snapshot().settings.language);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const loaded = DEV_SERVER_URL ? mainWindow.loadURL(DEV_SERVER_URL) : mainWindow.loadFile(RENDERER_INDEX);
  void loaded.catch((error) => {
    log.error(`launcher page failed: ${describeError(error)}`);
    dialog.showErrorBox("Dauntless Revamped could not open", "The launcher page could not load. Reinstall the latest launcher. Your sign-in and game files are kept.");
  });
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitFromTray(lang: Language): void {
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    title: translate(lang, "app_title"),
    message: translate(lang, "close_title"),
    detail: translate(lang, "close_text"),
    buttons: [translate(lang, "close_keep"), translate(lang, "close_anyway")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice === 1) {
    quitting = true;
    app.quit();
  }
}

function hideToTray(lang: Language): void {
  syncTray(true, lang);
  mainWindow?.hide();
  if (tray && !trayHintShown) {
    trayHintShown = true;
    tray.displayBalloon({ iconType: "info", title: translate(lang, "close_title"), content: translate(lang, "tray_hidden") });
  }
}

// While the game runs the launcher lives in the tray: it hides when the game starts and comes back
// when the game closes.
function syncTray(running: boolean, lang: Language): void {
  if (!running) {
    if (!tray) return;
    tray.destroy();
    tray = null;
    showWindow();
    return;
  }
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(resourcesDir(), "icon.png")).resize({ width: 16, height: 16 }));
  tray.setToolTip(translate(lang, "tray_running"));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: translate(lang, "tray_running"), enabled: false },
      { label: translate(lang, "tray_show"), click: showWindow },
      { type: "separator" },
      { label: translate(lang, "tray_quit"), click: () => quitFromTray(lang) },
    ]),
  );
  tray.on("click", showWindow);
  hideToTray(lang);
}

function hardenSessions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  // The renderer may load its own files and the dr-art images, nothing from the network.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed =
      url.startsWith("file:") ||
      url.startsWith("dr-art:") ||
      url.startsWith("devtools:") ||
      url.startsWith("data:") ||
      (DEV_SERVER_URL !== undefined && isTrustedPageUrl(url, DEV_SERVER_URL, RENDERER_INDEX_URL)) ||
      (DEV_SERVER_URL !== undefined && url.startsWith(DEV_SERVER_URL.replace(/^http/, "ws")));
    callback({ cancel: !allowed });
  });
  if (DEV_SERVER_URL) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP.replace("connect-src 'self'", "connect-src 'self' ws:")] } });
    });
  }

  protocol.handle("dr-art", async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.replace(/^\//, "");
      const art = url.hostname === "bg" && controller ? controller.resolveArt(id) : null;
      if (!art) return new Response(null, { status: 404 });
      const data = await fsp.readFile(art.file);
      return new Response(data, { status: 200, headers: { "content-type": art.type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isTrustedPageUrl(url, DEV_SERVER_URL, RENDERER_INDEX_URL)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isTrustedPageUrl(url, DEV_SERVER_URL, RENDERER_INDEX_URL)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

// ------------------------------------------------------------------ IPC

function trusted(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame === mainWindow.webContents.mainFrame &&
    isTrustedPageUrl(frame.url, DEV_SERVER_URL, RENDERER_INDEX_URL)
  );
}

function handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) {
      log.warn(`refused IPC ${channel} from an untrusted frame`);
      throw new Error("refused");
    }
    try {
      return await fn(event, ...args);
    } catch (e) {
      log.error(`IPC ${channel} failed: ${describeError(e)}`);
      return { ok: false, error: { code: "unknown" } };
    }
  });
}

function registerIpc(c: Controller): void {
  handle(IPC.getSnapshot, () => c.snapshot());
  handle(IPC.checkInvite, (_e, text) => {
    const s = boundedString(text, 2048);
    return s === null ? { ok: false, error: { code: "invite_invalid_format" } } : c.checkInvite(s);
  });
  handle(IPC.submitInvite, (_e, text, acceptNewCertificate) => {
    const s = boundedString(text, 2048);
    return s === null ? { ok: false, error: { code: "invite_invalid_format" } } : c.submitInvite(s, { acceptNewCertificate: acceptNewCertificate === true });
  });
  handle(IPC.retryConnect, () => c.connect());
  handle(IPC.forgetServer, () => c.forgetServer());
  handle(IPC.switchServer, (_e, id) => (typeof id === "string" && /^[0-9a-f]{24}$/.test(id) ? c.switchServer(id) : { ok: false, error: { code: "invite_invalid_format" } }));
  handle(IPC.removeSavedServer, (_e, id) => (typeof id === "string" && /^[0-9a-f]{24}$/.test(id) ? c.removeSavedServer(id) : { ok: false, error: { code: "invite_invalid_format" } }));
  handle(IPC.addServer, (_e, text) => c.addServer(text));
  handle(IPC.register, (_e, username, password) => {
    const u = boundedString(username, 32);
    const p = boundedString(password, 256);
    return u === null || p === null ? { ok: false, error: { code: "username_invalid" } } : c.register(u, p);
  });
  handle(IPC.signIn, (_e, identifier, password) => {
    const u = boundedString(identifier, 254);
    const p = boundedString(password, 256);
    return u === null || p === null ? { ok: false, error: { code: "login_failed" } } : c.signIn(u, p);
  });
  handle(IPC.chooseInstallDir, () => c.chooseInstallDir());
  handle(IPC.useExistingGameFolder, () => c.useExistingGameFolder());
  handle(IPC.useExistingGamePath, (_e, value) => {
    const s = boundedString(value, 260);
    return s === null ? { ok: false, error: { code: "folder_invalid" } } : c.useExistingGamePath(s);
  });
  handle(IPC.startInstall, () => c.startInstall());
  handle(IPC.pauseTask, () => c.pauseTask());
  handle(IPC.resumeTask, () => c.resumeTask());
  handle(IPC.cancelTask, () => c.cancelTask());
  handle(IPC.repair, () => c.repair());
  handle(IPC.play, () => c.play());
  handle(IPC.setSettings, (_e, patch) => {
    const p = settingsPatch(patch);
    return p === null ? c.setSettings({}) : c.setSettings(p);
  });
  handle(IPC.setStatusPolling, (_e, on) => {
    if (typeof on === "boolean") c.setStatusPolling(on);
  });
  handle(IPC.refreshStatus, () => c.refreshStatus());
  handle(IPC.getNews, () => c.getNews());
  handle(IPC.getBranding, () => c.getBranding());
  handle(IPC.openExternal, (_e, target) => {
    const t = externalTarget(target);
    return t === null ? { ok: false, error: { code: "unknown" } } : c.openExternal(t);
  });
  handle(IPC.openGameFolder, () => c.openGameFolder());
  handle(IPC.logout, () => c.logout());
  handle(IPC.installUpdate, () => c.installUpdate());
  handle(IPC.dismissNotice, () => c.dismissNotice());
  handle(IPC.dismissError, () => c.dismissError());
  handle(IPC.closeStrayGames, () => c.closeStrayGames());
  handle(IPC.windowMinimize, () => mainWindow?.minimize());
  handle(IPC.windowMaximize, () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  handle(IPC.windowClose, () => mainWindow?.close());
  handle(IPC.takeInviteLink, () => {
    const link = pendingInviteLink;
    pendingInviteLink = null;
    return link;
  });
}

// ------------------------------------------------------------------ platform for the controller

function makePlatform(): Platform {
  const send = (channel: string, payload: Snapshot | TaskProgress) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const relayPort = relayPortOverride(process.env.DAUNTLESS_REVAMPED_RELAY_PORT);
  if (relayPort !== undefined) log.warn(`relay port overridden to ${relayPort}`);
  return {
    userDataDir: app.getPath("userData"),
    introFile: path.join(resourcesDir(), "intro-Logo.mp4"),
    defaultInstallDir: path.join(localAppData, "DauntlessRevamped", "Game"),
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    defaultLanguage: systemLanguage(app.getLocale()),
    systemLocale: app.getLocale(),
    relayPort,
    encryptor: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (data) => safeStorage.decryptString(data),
    },
    manifest: GAME_MANIFEST,
    chooseFolder: async (purpose, defaultPath) => {
      if (!mainWindow) return null;
      const lang = controller?.snapshot().settings.language ?? "en";
      const r = await dialog.showOpenDialog(mainWindow, {
        title: translate(lang, purpose === "existing" ? "dialog_existing_folder" : "dialog_install_folder"),
        defaultPath: existsSync(defaultPath) ? defaultPath : undefined,
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
      });
      return r.canceled || r.filePaths.length !== 1 ? null : r.filePaths[0];
    },
    openExternal: (url) => shell.openExternal(url),
    openPath: async (dir) => {
      await shell.openPath(dir);
    },
    emitSnapshot: (s) => {
      syncTray(s.game.running, s.settings.language);
      send(IPC.snapshot, s);
    },
    emitProgress: (p) => send(IPC.progress, p),
    findTailscale: () => findTailscale(process.env, existsSync, process.platform),
    findRunningClients: () => findRunningClients(process.platform),
    installUpdate: () => {
      if (app.isPackaged) {
        quitting = true;
        autoUpdater.quitAndInstall();
      }
    },
  };
}

// ------------------------------------------------------------------ startup

if (!started) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    pendingInviteLink = inviteFromArgv(process.argv);

    app.on("second-instance", (_event, argv) => {
      showWindow();
      deliverInviteLink(inviteFromArgv(argv));
    });

    app.whenReady().then(async () => {
      Menu.setApplicationMenu(null);
      logToFile(path.join(app.getPath("userData"), "logs"));
      log.info(`Dauntless Revamped Launcher ${app.getVersion()} starting`);
      if (migrated) log.info("carried the Dauntless Forever launcher's settings and sign-ins over");
      if (migrateError) log.error(`could not carry the Dauntless Forever launcher's data over: ${describeError(migrateError)}`);
      if (GAME_MANIFEST) log.info(`game manifest ${GAME_MANIFEST.files.length} files, fingerprint ${GAME_MANIFEST_FINGERPRINT}`);
      else log.error(`compiled-in game manifest is not usable: ${GAME_MANIFEST_PROBLEM}`);

      registerProtocolClient();
      // The old launcher's links now open this one; its install (shortcuts, program folder) goes away.
      if (app.isPackaged) {
        uninstallOldLauncher(localAppData).then(
          (removed) => removed && log.info("removed the old Dauntless Forever launcher install"),
          (error) => log.warn(`could not remove the old Dauntless Forever launcher install: ${describeError(error)}`),
        );
      }
      hardenSessions();
      controller = new Controller(makePlatform());
      registerIpc(controller);
      createWindow();
      await controller.init();

      // Only a Squirrel install has Update.exe one folder up; the portable zip would fail every check.
      const squirrel = existsSync(path.resolve(path.dirname(process.execPath), "..", "Update.exe"));
      if (!squirrel && app.isPackaged) log.info("not a Squirrel install: self-update is off");
      if (app.isPackaged && process.platform === "win32" && UPDATE_FEED_URL && squirrel) {
        updateElectronApp({
          updateSource: { type: UpdateSourceType.StaticStorage, baseUrl: UPDATE_FEED_URL },
          updateInterval: "5 minutes", // the library minimum: a release reaches open launchers quickly
          notifyUser: true,
          onNotifyUser: () => controller?.setUpdateReady(),
          logger: { log: (m) => log.info(`update: ${m}`), info: (m) => log.info(`update: ${m}`), warn: (m) => log.warn(`update: ${m}`), error: (m) => log.error(`update: ${m}`) },
        });
        // The library's timer cannot go below 5 minutes: also check every minute and when the window gets
        // focus, but never while a check or download is running or once the update is ready.
        let checking = true;
        let ready = false;
        const free = () => void (checking = false);
        autoUpdater.on("update-not-available", free);
        autoUpdater.on("error", free);
        autoUpdater.on("update-downloaded", () => void (ready = true));
        const recheck = () => {
          if (checking || ready) return;
          checking = true;
          try {
            autoUpdater.checkForUpdates();
          } catch {
            checking = false;
          }
        };
        setInterval(recheck, 60_000).unref();
        app.on("browser-window-focus", recheck);
      }
    }).catch((error) => {
      log.error(`launcher startup failed: ${describeError(error)}`);
      dialog.showErrorBox("Dauntless Revamped could not open", `Startup failed. Send the launcher logs to your host.\n${describeError(error)}`);
      app.exit(1);
    });

    app.on("before-quit", () => {
      quitting = true;
    });

    app.on("window-all-closed", () => {
      const c = controller;
      controller = null;
      void (c ? c.shutdown() : Promise.resolve()).finally(() => app.quit());
    });
  }
}
