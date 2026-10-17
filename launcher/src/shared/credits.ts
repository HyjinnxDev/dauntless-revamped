// Everyone the launcher's Credits page thanks, in English, Finnish and Spanish. This is the only place the
// list lives: adding a contributor is one line in PROJECT_PEOPLE, MYSTIC_PEOPLE, REVIVED_PEOPLE or UPSTREAM_PEOPLE.
// Only the repositories this project is built from are credited here. Keep the Mystic Paradox, Dauntless Revived and Undaunted entries: this project is a modified version of both (AGPL-3.0).
//
// Plain data, no links: the page opens the contributor pages by link name ("project_contributors",
// "revived_contributors", "upstream_contributors"), and the main process maps those names to fixed
// URLs (src/main/links.ts). People appear here only by their GitHub handle.

import type { Language } from "./types";

export type Localized = Readonly<Record<Language, string>>;

export type CreditRole = "maintainer" | "creator" | "contributor";

export interface CreditPerson {
  name: string; // as shown
  github: string; // GitHub handle
  role: CreditRole;
}

export interface CreditSoftware {
  name: string;
  author: string | Localized;
  license: string | null; // SPDX identifier; null when the project publishes no license file
}

// Dauntless Revamped (everyone: the "project_contributors" link).
export const PROJECT_PEOPLE: readonly CreditPerson[] = [
  { name: "Hyjinnx", github: "HyjinnxDev", role: "maintainer" },
];

// Mystic Paradox, the 1.14.7 server, backend and runtime this launcher plays on (everyone: the "mystic_source" link).
export const MYSTIC_PEOPLE: readonly CreditPerson[] = [
  { name: "Pranav Karande (MysticFox)", github: "pranav158", role: "creator" },
];

// Dauntless Revived, the fork of Undaunted this project is built on (everyone: the "revived_contributors" link).
export const REVIVED_PEOPLE: readonly CreditPerson[] = [
  { name: "mixutin", github: "mixutin", role: "maintainer" },
  { name: "ridjan-xhika", github: "ridjan-xhika", role: "contributor" },
  { name: "Vvoidddd", github: "Vvoidddd", role: "contributor" },
  { name: "ZFXSTATIC", github: "ZFXSTATIC", role: "contributor" },
  { name: "anxo0", github: "anxo0", role: "contributor" },
];

// Undaunted, the project this launcher and the whole fork are a modified version of (everyone: the
// "upstream_contributors" link).
export const UPSTREAM_PEOPLE: readonly CreditPerson[] = [
  { name: "gwog (Gregory Morford)", github: "SyST3MDeV", role: "creator" },
  { name: "EisigesEis", github: "EisigesEis", role: "contributor" },
];

// Open-source software in the launcher and in the server DLL it ships. The full license texts are in
// THIRD-PARTY-NOTICES.txt, which ships with the launcher.
export const SOFTWARE: readonly CreditSoftware[] = [
  { name: "MinHook", author: "Tsuda Kageyu", license: "BSD-2-Clause" },
  { name: "Hacker Disassembler Engine 64", author: "Vyacheslav Patkov", license: "BSD-2-Clause" },
  { name: "Dumper-7", author: { en: "Encryqed and contributors", fi: "Encryqed ja muut tekijät", es: "Encryqed y colaboradores" }, license: null },
  { name: "Electron", author: { en: "Electron contributors", fi: "Electronin tekijät", es: "Colaboradores de Electron" }, license: "MIT" },
  { name: "update-electron-app", author: "GitHub Inc.", license: "MIT" },
  { name: "electron-squirrel-startup", author: "Lucas Hrabovsky", license: "Apache-2.0" },
  { name: "github-url-to-object", author: "zeke", license: "MIT" },
  { name: "is-url", author: "Segment", license: "MIT" },
  { name: "ms", author: { en: "Vercel (formerly ZEIT)", fi: "Vercel (ennen ZEIT)", es: "Vercel (antes ZEIT)" }, license: "MIT" },
  { name: "debug", author: "TJ Holowaychuk", license: "MIT" },
  { name: "GitHub Octicons", author: "GitHub Inc.", license: "MIT" },
];

export function localized(v: string | Localized, lang: Language): string {
  return typeof v === "string" ? v : v[lang] ?? v.en;
}
