import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// Windows only: Squirrel plus a portable ZIP. Every name differs from the 1.4.4 Dauntless Forever
// launcher's, so both can be installed on one PC with their own settings, sign-ins and link scheme.
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Dauntless Forever 1.14.7 Launcher",
    executableName: "DauntlessForever1147Launcher",
    appBundleId: "io.github.hyjinnxdev.dauntlessforever1147",
    appCopyright: "Dauntless Forever contributors, based on Dauntless Revived and Undaunted. Free software under the GNU AGPL-3.0.",
    // assets/icon.ico (the exe, and below the installer) and assets/icon.png (the window) are copies of
    // the brand icons in brand/launcher/, made by npm run icon.
    icon: "assets/icon",
    // The window icon and the third-party license texts. The game's runtime comes from each server.
    extraResource: ["assets/icon.png", "THIRD-PARTY-NOTICES.txt"],
    win32metadata: {
      CompanyName: "Dauntless Forever",
      FileDescription: "Dauntless Forever 1.14.7 Launcher",
      ProductName: "Dauntless Forever 1.14.7 Launcher",
      InternalName: "DauntlessForever1147Launcher",
      OriginalFilename: "DauntlessForever1147Launcher.exe",
    },
  },
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [
    new MakerSquirrel({
      name: "DauntlessForever1147Launcher",
      authors: "Hyjinnx",
      description: "Dauntless Forever 1.14.7 Launcher",
      setupExe: "DauntlessForever1147Launcher-Setup.exe",
      setupIcon: "assets/icon.ico",
      noMsi: true,
    }, ["win32"]),
    new MakerZIP({}, ["win32"]),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    // Switched off at package time: running the exe as plain Node, NODE_OPTIONS, the inspector
    // flags, and loading app code from anywhere but the (integrity-checked) asar.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
