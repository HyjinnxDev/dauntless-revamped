# Host scripts (`versions/1.14.7/host`)

> Verified against code 2026-10-24.

## What it is

Five PowerShell scripts for the machine that runs the live 1.14.7 server stack. They start and stop the stack, open the firewall, record resource use, summarise a hunt's combat log, and run a second throw-away "test stack" next to the live one. The scripts are Windows only. Defaults assume the original dev PC (`D:\Dev\...`, `D:\MysticParadoxData`). Only `restart-server.ps1` reads machine environment variables to override them (see Config).

Run them as `powershell -ExecutionPolicy Bypass -File <script> [switches]`. `restart-server.ps1` elevates itself; `host-firewall.ps1` must be run as administrator; the sizing logger's header says to run it elevated like the restart script.

## File reference

| File | What it does |
|---|---|
| `host/restart-server.ps1` | Stops and starts the backend and Director (plus mongod if down). Switches `-DirectorOnly`, `-Stop`. Self-elevates through UAC. |
| `host/host-firewall.ps1` | Creates three inbound allow rules (backend TCP, game UDP, voice UDP) and disables the blanket "allow this app" rules for `node.exe` and the game exe. Params `-HttpsPort`, `-GamePorts`, `-VoicePort`, `-Allowed`. |
| `host/server-sizing-log.ps1` | Samples CPU, RAM, network, players and hunts into a CSV. `-Summary` prints a hardware suggestion. Params `-Interval`, `-Summary`, `-Test`, `-csv`. |
| `host/test-stack.ps1` | A second backend + Director on other ports and a separate Mongo database, for feature branches. Run from a git worktree. Switches `-Setup`, `-Stop`, `-Remove`, `-Client <name>`. |
| `host/hunt-combat-report.ps1` | Summarises one hunt's combat log written by `MysticParadox.dll` (attack montages, predicted hits, rejected hits, damage). Params `-File`, `-List`, `-Window`, `-Dir`. |

## How it works

### `restart-server.ps1`

| Switch | Effect |
|---|---|
| none | Stop backend, Director and game servers; start mongod (if down), backend, Director |
| `-DirectorOnly` | Stop only the Director (port 3001 owner) and the game servers; build and start the Director |
| `-Stop` | Stop backend, Director and game servers; start nothing (mongod keeps running) |

1. If not elevated, re-launches itself with `Start-Process powershell.exe -Verb RunAs -NoExit` (same switches) and returns. Reason: a Director started from an elevated window and its game servers can only be seen or stopped from an elevated one.
2. Resolves machine paths: `REVAMPED_GAME_DIR`, `REVAMPED_DATA_DIR`, `REVAMPED_MONGOD`. Unset means the dev PC defaults. The repo is the script's parent folder (`versions\1.14.7`). Creates `<data>\logs`.
3. **Stop.** Collects the owners of the listening TCP ports (`443, 3000, 3001`, or just `3001` with `-DirectorOnly`) plus the parent process of every `Dauntless-Win64-Shipping.exe` that runs from the game dir with a `-server` argument. Of those it force-kills only `node.exe` processes, then the game servers themselves, then waits 3 s. A second Director would be caught through its children. The 1.4.4 stack and game clients are left alone because the server match requires the live game path and `-server`.
4. With `-Stop` it ends here.
5. Unless `-DirectorOnly`: start `mongod` if nothing listens on **27018** (`--port 27018 --bind_ip 127.0.0.1 --replSet rs0 --dbpath <data>\mongo --logpath <data>\mongo.log --logappend`, hidden window). Wait up to 60 s. Then start the backend with `cmd /c npm start` in `ParadoxBackend` (its `prestart` rebuilds when stale), output to `<data>\logs\backend.log` (deleted first, so the readiness poll can't match the previous run), and wait up to 3 min for `paradox=ready`. `EADDRINUSE` or `FATAL` in the log throws.
6. Build the Director (`npm run build` into `<data>\logs\director-build.log`), then start `node --env-file=.env dist/server.js` hidden, output to `<data>\logs\director.log` (overwritten). It does not wait. Ramsgate and the Dojo take about a minute. Watch for `ramsgate ready` in the log.

The staff `/admin` console's "Restart Director" button and restart log use the same script and the `director`, `director-build`, `restart` log names (backend `ADMIN_RESTART_SCRIPT`, `ADMIN_LOG_DIR`). See [backend-security-admin](backend-security-admin.md).

### `host-firewall.ps1`

| Parameter | Default | Matches |
|---|---|---|
| `-HttpsPort` | `443` | backend `HTTPS_PORT` |
| `-GamePorts` | `8780-8790` | Director `PORT_RANGE_BEGIN` to `PORT_RANGE_END` |
| `-VoicePort` | `8791` | backend `VOICE_UDP_PORT` |
| `-Allowed` | `192.168.1.0/24` | Remote addresses allowed. A public server passes `-Allowed Any` (and forwards the ports on the router). |

It deletes any rule named `Dauntless 1.14.7 *`, then creates three inbound allow rules on every profile: `Dauntless 1.14.7 backend (TCP <port>)`, `... game servers (UDP <range>)`, `... voice relay (UDP <port>)`. Then it **disables** every enabled inbound allow rule whose program is `node.exe` or `Dauntless-Win64-Shipping.exe` (found through `Get-NetFirewallApplicationFilter`). Those are the rules Windows creates from the "allow this app" prompt, which open every port. If Windows asks again later, click Cancel. Finally it lists the new rules. Undo with `Get-NetFirewallRule -DisplayName 'Dauntless 1.14.7 *' | Remove-NetFirewallRule`, and re-enable the disabled rules with `Get-NetFirewallRule -DisplayName 'Node.js*','Dauntless*' | Enable-NetFirewallRule`.

### `server-sizing-log.ps1`

| Parameter | Default | Effect |
|---|---|---|
| `-Interval` | 10 | Seconds between samples |
| `-csv` | `D:\MysticParadoxData\logs\sizing.csv` | Output file (header written if new; appended across sessions) |
| `-Test` | off | Sample the test-stack ports (4443, 3100, 3101, UDP 8800-8810, hubs from 8809) |
| `-Summary` | off | Read the CSV and print a report instead of sampling |

Sampling mode (until Ctrl+C) groups processes into `mongo` (any `mongod.exe`), `backend` (owns 443 or 3000), `director` (owns 3001), `hub` (owns a UDP port at or above 8789 within the range) and `hunt` (owns another UDP port in 8780 to 8790). Columns: `time, players, hunts, cpu_<group>..., ram_<group>..., net_in_kbs, net_out_kbs`. CPU is cores busy from CIM `KernelModeTime + UserModeTime` deltas. RAM is `PrivatePageCount` (committed private bytes) in MB. Network is all-adapter KB/s. `players` is established remote (non-loopback) connections on 443. It uses CIM, not `Get-Process`, so a non-elevated logger can still read an elevated stack's CPU. The first pass only seeds CPU times and writes no row. Numbers use the invariant culture.

`-Summary` prints sample range, peak players and hunts, CPU and RAM peak/average, RAM by group, network peaks, per-hunt RAM and CPU peaks, and a "suggested minimum": `ceil(peak cores × 1.3)` vCPU (at least 2) and `ceil((peak RAM × 1.3 + 2048 MB) / 1024)` GB.

### `test-stack.ps1`

Purpose: run a feature branch beside live without sharing anything live writes. It refuses to run from the live checkout (`D:\Dev\dauntless-revamped\versions\1.14.7`). Use a git worktree.

| Switch | Effect |
|---|---|
| `-Setup` | One-time, then starts the stack. Hard-link copies of the game server (`D:\Dev\dauntless 1.14.7\Dauntless_1.14.7`) and client (`...\Client`) under `D:\MysticParadoxTest\game` and `\client`; only `Archon\Binaries\Win64` is a real copy (skipping `*.dll.bak/old/pre`), so test DLLs never touch the live install. Robocopies the gitignored `game-data` folders and the runtime SDK headers from the live checkout. Writes test `.env` files. Runs `npm ci` in backend and Director. Copies the live Mongo database `mysticparadox` into `mysticparadox_test` with `$out`, including indexes, unless it already has collections. |
| none | Stop, then restart the test backend and Director (and mongod if down). |
| `-Stop` | Stop only the test-port owners (`node.exe`) and game servers launched from the test game copy. |
| `-Remove` | Stop, drop the test database, delete `D:\MysticParadoxTest`, print the `git worktree remove` command. |
| `-Client <name>` | Start a windowed (1280x720) test client logged in as dev user `<name>` (3 to 16 letters/digits, created on first login). Upserts launcher-account fields for it in the test DB so chat works, sets `MYSTICPARADOX_API_BASE`, and rewrites the `[OnlineSubsystemMcp.XMPP]` section of `%LOCALAPPDATA%\Archon\Saved\Config\WindowsClient\Engine.ini` to `wss://paradox.test:4443`. A normal launcher start puts it back. Stops nothing. |

Test ports: HTTP 3100, HTTPS 4443, QoS 8100, Director 3101, voice 8792, game UDP 8800 to 8810. Live stays on 443/3000/3001/80 and UDP 8780 to 8791.

Backend `.env` overrides (live file copied, keys replaced or appended): `PORT`, `HTTPS_PORT`, `QOS_PORT`, `VOICE_UDP_PORT`, `DEPLOYSERVER_URL`, `MONGODB_DB`, `MONGODB_APP_NAME=paradox-backend-test`, `LAUNCHER_UPDATE_ROOT`, `UPDATE_PUBLIC_BASE_URL`, `CRASH_REPORT_STORAGE_DIR`, `LAUNCHER_LOG_STORAGE_DIR`, `ADMIN_LOG_DIR`; blanked: `ADMIN_RESTART_SCRIPT`, `ADMIN_DISCORD_REDIRECT_URI`, `GITHUB_CRASH_TOKEN`, `GITHUB_CRASH_REPO`, `DISCORD_NEWS_BOT_TOKEN`, `DISCORD_NEWS_CHANNEL_ID`, `DISCORD_STATUS_CHANNEL_ID`, `DISCORD_GUILD_ID`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`. Director overrides: `PORT`, `PORT_RANGE_BEGIN/END`, `GAMESERVER_BINARY_PATH` (test copy), `GAMESERVER_LOG_DIR=<root>\logs\gameservers`, `SERVER_RUNTIME_AUTO_UPDATE=false`, `MAX_CONCURRENT_HUNT_SERVERS=2`, `GAMESERVER_CHARACTER_LOG=VeryVerbose`, `MYSTICPARADOX_API_BASE=https://paradox.test:4443` (inherited by test game servers). Files are written without a BOM. Clients reach the stack at `https://paradox.test:4443`, so `paradox.test` must resolve to the host (hosts file).

Start sequence: delete the old `backend.log`, start mongod if 27018 is free (hard-coded live paths, then 5 s wait), `npm start` in the worktree backend (wait up to 3 min for `paradox=ready`), `npm run build` and `node --env-file=.env dist/server.js` for the Director. Logs: `D:\MysticParadoxTest\logs\backend.log`, `director-build.log`, `director.log`, `gameservers\`.

### `hunt-combat-report.ps1`

Reads `hunt_<start>_port<N>.log` files in `-Dir` (default `D:\Dev\dauntless 1.14.7\Dauntless_1.14.7\Archon\Binaries\Win64\HuntCombat`, where the server DLL's `MpHuntCombatLog` writes them). `-List` shows the 20 newest. `-File <path>` picks one. Default is the newest. `-Window` (4 s) is how long after a behemoth attack montage a player damage line still counts as caused by it. Output: the file's `#` header lines, predicted hits per attack key (`try`, `ok`, `REJECT`), rejected hit lines, montages with `fired` / `ledToDmg` / `noDmg` counts (everyone dodged, or the hit never registered), damage by `target <- giver`, and other `fn=` DamageComponent lines.

## Runbook

Procedures used on the live PC that no script wraps yet.

**Backup before a risky deploy** (used 2026-10-24, kept in `D:\MysticParadoxData\backups\2026-10-24-pre-seasons\`):
1. The Mongo copy must be taken with the 27018 `mongod` stopped (`restart-server.ps1 -Stop` leaves mongod running, so stop it too). Then `robocopy D:\MysticParadoxData\mongo <backup>\mongo /E`. Compare file count and size.
2. `git bundle create <backup>\dauntless-revamped-all-branches.bundle --all`, then `git bundle verify`.
3. Uncommitted work: `git diff --binary > wip-tracked.patch`, copy every `git ls-files --others --exclude-standard` file, and note `git rev-parse HEAD`.
4. Restore: stop the stack and the 27018 mongod, copy `mongo\` back, `git reset --hard <noted HEAD>`, `git apply wip-tracked.patch`, copy the untracked files back, then `restart-server.ps1`.

**Restart the backend only** (Director, hubs and running hunts stay up; players drop for about 15 s): `restart-server.ps1` has no switch for this. Run, elevated (the backend was started elevated, so a normal shell cannot stop it), steps 1 and 3 of the script: stop the owner of TCP 443/3000, then `Start-Process cmd.exe -ArgumentList '/c', 'npm start > "D:\MysticParadoxData\logs\backend.log" 2>&1' -WorkingDirectory <repo>\versions\1.14.7\ParadoxBackend -WindowStyle Hidden` and wait for `paradox=ready` in the log. Do not launch it with `Start-Process -Wait`: that waits for the backend itself and never returns. A backend-only restart reaches players at their next login; the hubs keep the `/progression/config` they fetched at boot.

**After a reboot** start both `restart-server.ps1` and `discord-bot\start-bot.ps1`. The bot is a separate process; without it the backend logs `[News] bot not read: TypeError: fetch failed`.

**Every second Thursday 17:00 UTC** (hunt pass season change, next 2026-11-05) restart the full stack so Ramsgate and the Dojo pick up the new season ([Backend](backend.md) Gotchas).

## Logs written

| Script | Path |
|---|---|
| `restart-server.ps1` | `<data>\logs\backend.log`, `director-build.log`, `director.log` (each overwritten per run); `<data>\mongo.log` (appended) |
| Director itself | `versions\1.14.7\debug\deployserver\deployserver.log`, `versions\1.14.7\debug\gameservers\port<N>_<label>.log` (see [Director](director.md)) |
| `server-sizing-log.ps1` | `-csv` (default `D:\MysticParadoxData\logs\sizing.csv`) |
| `test-stack.ps1` | `D:\MysticParadoxTest\logs\*` |

## Connects to

| Peer | How |
|---|---|
| [Director](director.md) | Builds and starts it; kills game servers it spawned; samples its ports; firewall opens its UDP range. |
| [Backend](backend.md) | `npm start` in `ParadoxBackend`; log marker `paradox=ready`; HTTPS 443 and HTTP 3000; voice UDP 8791. |
| MongoDB | Hand-started `mongod` on 27018 with replica set `rs0`. No Windows service by design. |
| [Runtime](runtime.md) | `hunt-combat-report.ps1` reads logs written by `MysticParadox.dll`; the test copy keeps test DLLs separate. |
| Backend admin console | The `director`, `director-build`, `backend`, `restart` logs under `<data>\logs` are read by `controllers/adminServers.ts`. |
| [Deploy](deploy.md) | `install.ps1` calls `host-firewall.ps1` and `restart-server.ps1` on the second machine. |

## Config

Script parameters are above. Environment variables:

| Variable | Used by | Default |
|---|---|---|
| `REVAMPED_GAME_DIR` | `restart-server.ps1` | `D:\Dev\dauntless 1.14.7\Dauntless_1.14.7\` |
| `REVAMPED_DATA_DIR` | `restart-server.ps1` | `D:\MysticParadoxData` (logs in `logs\`, Mongo in `mongo\`) |
| `REVAMPED_MONGOD` | `restart-server.ps1` | `C:\Program Files\MongoDB\Server\9.0\bin\mongod.exe` |

`test-stack.ps1` and `server-sizing-log.ps1` hard-code their paths and ports at the top of the file. `hunt-combat-report.ps1` has a hard-coded default `-Dir`. Edit these when you move machines. For a second host see `deploy/README.md` ([Deploy](deploy.md)).

## Gotchas

- **UAC.** `restart-server.ps1` opens a new elevated window (`-NoExit`) and returns immediately. Output appears there, not in your terminal.
- **Readiness poll checks `Test-Path` before `Select-String`.** Under `ErrorActionPreference=Stop`, `Select-String` throws on a missing file even with `-ErrorAction SilentlyContinue`. Without the check the script stops right after starting the backend (the log was just deleted) and the Director never starts (happened 2026-10-29). If Ramsgate is down after a restart, read the elevated window, then run `-DirectorOnly`.
- **`-DirectorOnly` kills every game server**, so hunts drop. The backend stays up.
- **Port numbers are hard-coded** in `restart-server.ps1` (443, 3000, 3001, 27018) and in `server-sizing-log.ps1` (hubs counted as UDP 8789 and up). A custom Director `PORT` or game range is not understood by them.
- **It kills by port owner.** Any `node.exe` listening on 443, 3000 or 3001 is force-stopped. Do not run an unrelated Node service there.
- **Test backend HTTP 3100 = the Discord bot's default `BOT_HTTP_PORT`.** With the bot running on the same PC, the test backend fails with `EADDRINUSE`, and `test-stack.ps1` would force-stop the bot as the owner of 3100. Move one of them.
- **The sizing logger is wrong with a local client.** The client's CPU and RAM are not server cost. Play from another PC. In `-Test` mode the `mongo` column includes live (mongod is shared).
- **`test-stack.ps1` copies the live `.env` files** and then overrides ports and blanks the Discord, GitHub and admin-login keys. The other secrets (JWT key, gameserver API key) are copied as they are. Treat the worktree `.env` files as secrets.
- **Test DB copy is a snapshot** of live data at `-Setup` time. It is kept on later runs, so a refresh means `-Remove` and `-Setup`.
- **The test stack shares the live mongod** (different database) and starts it with the live paths if it is down.
- **Firewall script scope.** Default `-Allowed 192.168.1.0/24` only works if your LAN is that subnet. For outside players use `-Allowed Any` and port-forward.
- **Disabling the app rules is global.** It affects every `node.exe` on the machine, not just this stack.
- **Game data and SDK headers** are gitignored. A new worktree has none until `-Setup` copies them from the live checkout.

## See also

[Index](index.md), [Setup](setup.md), [Director](director.md), [Backend](backend.md), [Deploy](deploy.md), [Tools](tools.md)
