// The only bridge between the page and the main process: a fixed list of typed calls.
// There is no generic send/invoke passthrough, and no token ever crosses this bridge towards the
// page. The password goes the other way once, for register or sign in, and is never stored.

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "./shared/types";
import type {
  ActionResult,
  Branding,
  ExternalTarget,
  InviteCheck,
  NewsItem,
  RegisterOutcome,
  Settings,
  Snapshot,
  TaskProgress,
} from "./shared/types";

const api = {
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke(IPC.getSnapshot),
  checkInvite: (text: string): Promise<InviteCheck> => ipcRenderer.invoke(IPC.checkInvite, String(text)),
  // acceptNewCertificate: the user confirmed a public server's changed certificate.
  submitInvite: (text: string, acceptNewCertificate = false): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC.submitInvite, String(text), acceptNewCertificate === true),
  retryConnect: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.retryConnect),
  forgetServer: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.forgetServer),
  switchServer: (id: string): Promise<ActionResult> => ipcRenderer.invoke(IPC.switchServer, String(id)),
  removeSavedServer: (id: string): Promise<ActionResult> => ipcRenderer.invoke(IPC.removeSavedServer, String(id)),
  register: (username: string, password: string): Promise<RegisterOutcome> => ipcRenderer.invoke(IPC.register, String(username), String(password)),
  signIn: (identifier: string, password: string): Promise<RegisterOutcome> => ipcRenderer.invoke(IPC.signIn, String(identifier), String(password)),
  chooseInstallDir: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.chooseInstallDir),
  useExistingGameFolder: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.useExistingGameFolder),
  useExistingGamePath: (gamePath: string): Promise<ActionResult> => ipcRenderer.invoke(IPC.useExistingGamePath, String(gamePath)),
  startInstall: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.startInstall),
  pauseTask: (): Promise<void> => ipcRenderer.invoke(IPC.pauseTask),
  resumeTask: (): Promise<void> => ipcRenderer.invoke(IPC.resumeTask),
  cancelTask: (): Promise<void> => ipcRenderer.invoke(IPC.cancelTask),
  repair: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.repair),
  play: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.play),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.setSettings, {
      ...(patch.windowed !== undefined ? { windowed: patch.windowed } : {}),
      ...(patch.streamerMode !== undefined ? { streamerMode: patch.streamerMode } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
      ...(patch.gameLanguage !== undefined ? { gameLanguage: patch.gameLanguage } : {}),
    }),
  setStatusPolling: (on: boolean): Promise<void> => ipcRenderer.invoke(IPC.setStatusPolling, on === true),
  refreshStatus: (): Promise<void> => ipcRenderer.invoke(IPC.refreshStatus),
  getNews: (): Promise<NewsItem[]> => ipcRenderer.invoke(IPC.getNews),
  getBranding: (): Promise<Branding> => ipcRenderer.invoke(IPC.getBranding),
  openExternal: (target: ExternalTarget): Promise<ActionResult> => ipcRenderer.invoke(IPC.openExternal, String(target)),
  openGameFolder: (): Promise<void> => ipcRenderer.invoke(IPC.openGameFolder),
  logout: (): Promise<ActionResult> => ipcRenderer.invoke(IPC.logout),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.installUpdate),
  dismissNotice: (): Promise<void> => ipcRenderer.invoke(IPC.dismissNotice),
  dismissError: (): Promise<void> => ipcRenderer.invoke(IPC.dismissError),
  minimize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowMaximize),
  close: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
  takeInviteLink: (): Promise<string | null> => ipcRenderer.invoke(IPC.takeInviteLink),
  onSnapshot: (fn: (s: Snapshot) => void): void => {
    ipcRenderer.on(IPC.snapshot, (_e, s: Snapshot) => fn(s));
  },
  onProgress: (fn: (p: TaskProgress) => void): void => {
    ipcRenderer.on(IPC.progress, (_e, p: TaskProgress) => fn(p));
  },
  onInviteLink: (fn: () => void): void => {
    ipcRenderer.on(IPC.inviteLink, () => fn());
  },
  onWindowState: (fn: (maximized: boolean) => void): void => {
    ipcRenderer.on(IPC.windowState, (_e, maximized: unknown) => fn(maximized === true));
  },
};

export type LauncherApi = typeof api;

contextBridge.exposeInMainWorld("launcher", api);
