import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerAppImage } from "@reforged/maker-appimage";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// Windows uses Squirrel plus a portable ZIP. Linux builds AppImage, deb, rpm and a portable ZIP.
// CI builds both platforms on every push and launcher-release.yml publishes them together.
const skipRpm = process.env.DAUNTLESS_REVIVED_SKIP_RPM === "1";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Dauntless Forever Launcher",
    executableName: "DauntlessForeverLauncher",
    appBundleId: "io.github.hyjinnxdev.dauntlessforever",
    appCopyright: "Dauntless Forever contributors, based on Dauntless Revived and Undaunted. Free software under the GNU AGPL-3.0.",
    // assets/icon.ico (the exe, and below the installer) and assets/icon.png (the window) are copies of
    // the brand icons in ../brand/launcher/, made by npm run icon.
    icon: "assets/icon",
    // The two pinned DLLs the game needs, the window icon, and the license texts of the third-party
    // software the launcher and the DLLs include, plus ../client-mods (UE4SS and the client mods, installed
    // by src/main/client-mods.ts). Nothing else ships outside the asar.
    extraResource: ["assets/dxgi.dll", "assets/UndauntedInternalServer.dll", "assets/icon.png", "THIRD-PARTY-NOTICES.txt", "../client-mods"],
    win32metadata: {
      CompanyName: "Dauntless Forever",
      FileDescription: "Dauntless Forever Launcher",
      ProductName: "Dauntless Forever Launcher",
      InternalName: "DauntlessForeverLauncher",
      OriginalFilename: "DauntlessForeverLauncher.exe",
    },
  },
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [
    new MakerSquirrel({
      name: "DauntlessForeverLauncher",
      authors: "Hyjinnx",
      description: "Dauntless Forever Launcher",
      setupExe: "DauntlessForeverLauncher-Setup.exe",
      setupIcon: "assets/icon.ico",
      iconUrl: "https://raw.githubusercontent.com/HyjinnxDev/dauntless-revived/dauntless-revived/UndauntedLauncher/assets/icon.ico",
      noMsi: true,
    }, ["win32"]),
    new MakerZIP({}, ["win32", "linux"]),
    new MakerDeb(
      {
        options: {
          name: "dauntless-forever-launcher",
          productName: "Dauntless Forever Launcher",
          genericName: "Game Launcher",
          bin: "DauntlessForeverLauncher",
          description: "Launcher for Dauntless Forever and compatible community servers",
          section: "games",
          priority: "optional",
          maintainer: "Hyjinnx",
          homepage: "https://github.com/HyjinnxDev/dauntless-revived",
          icon: "assets/icon.png",
          categories: ["Game"],
          mimeType: ["x-scheme-handler/dauntless-forever"],
          recommends: ["gnome-keyring", "libsecret-1-0", "pkexec"],
          suggests: ["wine64", "steam"],
        },
      },
      ["linux"],
    ),
    ...(skipRpm
      ? []
      : [
          new MakerRpm(
            {
              options: {
                name: "dauntless-forever-launcher",
                productName: "Dauntless Forever Launcher",
                genericName: "Game Launcher",
                bin: "DauntlessForeverLauncher",
                description: "Launcher for Dauntless Forever and compatible community servers",
                license: "AGPL-3.0-only",
                homepage: "https://github.com/HyjinnxDev/dauntless-revived",
                icon: "assets/icon.png",
                categories: ["Game"],
                mimeType: ["x-scheme-handler/dauntless-forever"],
              },
            },
            ["linux"],
          ),
        ]),
    new MakerAppImage({
      options: {
        name: "dauntless-forever-launcher",
        productName: "Dauntless Forever Launcher",
        genericName: "Game Launcher",
        bin: "DauntlessForeverLauncher",
        icon: "assets/icon.png",
        categories: ["Game"],
        mimeType: ["x-scheme-handler/dauntless-forever"],
        keywords: ["Dauntless", "launcher", "gaming", "Proton", "Wine"],
        compressor: "zstd",
      },
    }),
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
