// Fixed values: pinned hashes, file locations and the few public URLs the launcher may open.

export const APP_ID = "io.github.hyjinnxdev.dauntlessforever1147";
export const SQUIRREL_NAME = "DauntlessForever1147Launcher";
export const PROJECT_URL = "https://github.com/HyjinnxDev/dauntless-revamped";
export const PROJECT_LICENSE_URL = "https://github.com/HyjinnxDev/dauntless-revamped/blob/main/versions/1.14.7/LICENSE";
export const PROJECT_CONTRIBUTORS_URL = "https://github.com/HyjinnxDev/dauntless-revamped/graphs/contributors";
// Dauntless Revived, the project the Dauntless Forever launcher is a modified version of (AGPL-3.0).
export const REVIVED_URL = "https://github.com/mixutin/dauntless-revived";
export const REVIVED_CONTRIBUTORS_URL = "https://github.com/mixutin/dauntless-revived/graphs/contributors";
// Undaunted, the project Dauntless Revived is in turn a modified version of.
export const UPSTREAM_URL = "https://github.com/SyST3MDeV/Undaunted";
export const UPSTREAM_CONTRIBUTORS_URL = "https://github.com/SyST3MDeV/Undaunted/graphs/contributors";
// Mystic Paradox, the 1.14.7 server and runtime this launcher plays on.
export const MYSTIC_PARADOX_URL = "https://github.com/pranav158/Mystic-Paradox";
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";
export const VC_REDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
// Self-update feed: the latest release of the releases repo (RELEASES and the full .nupkg, published by
// `npm run release`). Squirrel checks it hourly; installs from the portable zip do not update.
export const UPDATE_FEED_URL = "https://github.com/HyjinnxDev/dauntless-forever-1147-releases/releases/latest/download";

// Dauntless 1.14.7 (rel-1.14.7-Archon, CL 647472). Paths are relative to the folder that contains Archon/.
export const TARGET_CHANGELIST = 647472;
export const WIN64_RELATIVE_DIR = "Archon/Binaries/Win64";
export const EXE_NAME = "Dauntless-Win64-Shipping.exe";
export const EXE_RELATIVE_PATH = `${WIN64_RELATIVE_DIR}/${EXE_NAME}`;
export const PINNED_EXE_SHA256 = "f3f95fbf22709ef077a11632ed95d675b7209b7e0172d9ecb9ba7d02a1fbb66b";
export const PINNED_EXE_SIZE = 121407264;

// The Mystic Paradox runtime pair, downloaded from the server (never in the game manifest).
export const RUNTIME_FILE_NAMES = ["MysticParadox.dll", "winmm.dll"];
export const RUNTIME_RELATIVE_PATHS = RUNTIME_FILE_NAMES.map((n) => `${WIN64_RELATIVE_DIR}/${n}`);

export const CONNECT_TIMEOUT_MS = 5000;
export const STATUS_POLL_MS = 15000;
export const DISK_MARGIN_BYTES = 1024 * 1024 * 1024; // 1 GiB on top of what is still to download
export const DOWNLOAD_CONCURRENCY = 4;
