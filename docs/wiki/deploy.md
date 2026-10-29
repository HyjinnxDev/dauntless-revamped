# Deploy (second-server bundle and install)

> Verified against code 2026-10-24.

## What it is

`deploy/` holds two PowerShell scripts and a README for running a **second copy of the server stack** on another Windows machine, first use being a test server on a mini PC beside the live one. `make-bundle.ps1` runs on the live PC and only reads from it, producing one folder (the bundle). `install.ps1` runs on the new machine as admin, puts each part in place, restores a copy of the live database, opens the firewall, prints invite links and starts the stack. Nothing in it stops or changes the live server.

## File reference

| File | What it does |
|---|---|
| `deploy/README.md` | The full guide (172 lines): parts table, bundle layout, test settings, mini PC steps, router ports, day-to-day, bot move, security checklist, later hosting |
| `deploy/make-bundle.ps1` | Builds the bundle on the live PC. Params `-TestLanIp` (required), `-PublicIp`, `-Out`, `-TargetRoot`, `-Branch`, `-Live`, `-Game`, `-Data`, `-SkipGame`, `-SkipDb`. Helpers `Read-EnvValue`, `Convert-Env`, `Copy-Tree` (robocopy, fails on exit code ≥ 8). |
| `deploy/install.ps1` | Installs the bundle on the test machine as admin. Params `-RestoreDb`, `-NoStart`. Helpers `Copy-Tree`, `Find-Exe`, `Read-EnvValue`. |
| `versions/1.14.7/host/restart-server.ps1`, `host-firewall.ps1` | Called by `install.ps1`; see [host-scripts](host-scripts.md) |
| `versions/1.14.7/ParadoxBackend/scripts/init-replset.cjs` | Called by `install.ps1` (`node scripts/init-replset.cjs 127.0.0.1:27018`) to make mongod a replica set |

## How it works

### The parts being deployed

Backend ([backend](backend.md)), Director ([director](director.md)) and the game servers it spawns, MongoDB (db `mysticparadox`, port 27018, replica set `rs0`), the [Discord bot](discord-bot.md) (independent, not in the test bundle), the R2 game-file CDN (already hosted), and the runtime signing key, which stays on the live PC only (never copy `ParadoxLauncher/.secrets/`, see [paradox-launcher](paradox-launcher.md)).

### `make-bundle.ps1` (live PC)

Steps, in order:
1. **Repo**: `git clone --single-branch` of the branch (default `deploy-split`) from the **local live repo** (`-Live`) into `<Out>\repo`, then `origin` is set to the live repo's own `origin` URL (GitHub) so the test machine can `git pull` later. On re-run it does `git pull --ff-only <Live> <Branch>`.
2. **Backend**: reads the live `ParadoxBackend\.env`, runs `Convert-Env`, writes `<Out>\backend\.env` (UTF-8 without BOM), copies `game-data\`. `Convert-Env` replaces the `-Game`, `-Live` and `-Data` paths with `<TargetRoot>\game\Dauntless_1.14.7`, `<TargetRoot>\repo` and `<TargetRoot>\data` (case-insensitive, both slash styles), then sets or appends the listed keys, and warns about any key still holding a `D:` to `Z:` path.
3. **Director**: same with `ParadoxDirector\.env` and `game-data\`. `-PublicIp` defaults to the live Director's `MY_IP`.
4. **Certs and updates**: copies `<Data>\certs` and `<Data>\updates` (the same certificate, because launchers pin its fingerprint).
5. **Database**: `mongodump --uri <backend MONGODB_URI> --db <MONGODB_DB> --archive=mongo\db.archive.gz --gzip` (read-only; needs MongoDB Database Tools, found on PATH or under `C:\Program Files\MongoDB\Tools`; skipped with `-SkipDb`).
6. **Game install**: robocopy of `-Game` (about 16 GB) to `game\Dauntless_1.14.7`, excluding `MysticParadox.dll.bak*`/`.old*` (skipped with `-SkipGame`).
7. Copies `install.ps1` and the README into the bundle and writes `bundle.json` (`created`, `branch`, `commit`, `targetRoot`, `testLanIp`, `publicIp`, `ports`).

Settings changed for the test box (`Convert-Env` arguments): backend `HTTPS_PORT` 9443, `VOICE_UDP_PORT` 9791, `REALTIME_XMPP_ALLOWED_HOSTS` extended with the LAN and public IPs, `GITHUB_CRASH_TOKEN`, `DISCORD_NEWS_BOT_TOKEN`, `DISCORD_BOT_URL` and `UPDATE_PUBLISHER_ALLOWED_IPS` blanked; Director `MY_IP` (public), `PORT_RANGE_BEGIN/END` 9780-9790. It warns if any other variable still holds a path on a drive the test machine lacks. Everything else (accounts, staff roles, invite codes, JWT/admin secrets, certificate) is a live copy.

### `install.ps1` (test machine, admin)

0. Refuses to run without admin rights. Reads `bundle.json` for the target root and IPs.
1. Checks Node, Git, `mongod` (PATH or `C:\Program Files\MongoDB\Server\*\bin`), `mongorestore` (PATH or `C:\Program Files\MongoDB\Tools\*\bin`) are installed and prints the install commands if not. The README also requires Mongo to be the same major version as live and **not** installed as a Windows service (the stack starts mongod itself); the script does not check either.
2. Copies repo, game (if the bundle has one), certs, updates, then each service's `.env` and `game-data` into `<TargetRoot>\...`. Fails if `game\Dauntless_1.14.7\Archon\Binaries\Win64\Dauntless-Win64-Shipping.exe` is missing.
3. Sets **machine** (and current-session) environment variables `REVAMPED_GAME_DIR`, `REVAMPED_DATA_DIR`, `REVAMPED_MONGOD` so the usual `restart-server.ps1` and the staff console's restart button work unchanged.
4. `npm ci --no-audit --no-fund` in Backend and Director.
5. Starts `mongod` (127.0.0.1:27018, `--replSet rs0`, dbpath `<TargetRoot>\data\mongo`, log `<TargetRoot>\data\mongo.log`) if nothing listens on 27018 (60 s wait), runs `scripts/init-replset.cjs 127.0.0.1:27018`, and restores the dump with `mongorestore --uri mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true --gzip --drop` only when the data folder was empty before this run (or with `-RestoreDb`).
6. Firewall via `host-firewall.ps1 -HttpsPort -GamePorts -VoicePort -Allowed Any`, ports read from the installed `.env` files.
7. Computes the certificate fingerprint with Node (`X509Certificate.fingerprint256`, colons removed, lower case) from `PARADOX_CERT_PEM_PATH` and writes two invite links (LAN and public) to `<TargetRoot>\invites.txt`, each as `dauntless-revamped://join?v=1&host=<ip>&port=<HTTPS_PORT>&fp=<fp>&code=<code>&name=Revamped Test` and as `https://hyjinnxdev.github.io/dauntless-revamped-releases/join/#<same query>`. The invite code is the first of `LAUNCHER_INVITE_CODES`.
8. Prints a RAM hint (about 1 GB per hunt server; 8 GB means `MAX_CONCURRENT_HUNT_SERVERS="2"`) with the current value, and runs `restart-server.ps1` unless `-NoStart`.

### Ports

| Purpose | Live | Test |
|---|---|---|
| Backend HTTPS | 443 | 9443 |
| Game UDP (hunts, Dojo, Ramsgate) | 8780-8790 | 9780-9790 |
| Voice UDP | 8791 | 9791 |
| Local only: backend HTTP 3000, Director 3001, Mongo 27018 | same | same |
| Local only: bot news 3100 | live PC | no bot |

Router forwards for outside testers: TCP 9443 and UDP 9780-9791 to the mini PC's LAN address (give it a DHCP reservation).

### Day to day (from the README)

`restart-server.ps1` (with `-Stop`, `-DirectorOnly`) in `C:\Revamped\repo\versions\1.14.7\host`; `git pull` for new code; fresh live data = new bundle (`-SkipGame`) then `install.ps1 -RestoreDb`. Logs in `C:\Revamped\data\logs\backend.log` and `director.log`. After reboot, run `restart-server.ps1` (it starts mongod).

### Moving the live Discord bot

The README documents this: fill `discord-bot/.env` from the backend `.env` (old `DISCORD_NEWS_BOT_TOKEN` becomes `DISCORD_BOT_TOKEN`), export old tickets with `export-discord-issues.cjs`, set backend `DISCORD_BOT_URL="http://127.0.0.1:3100"` and delete the old token, run the bot, restart the backend. See [discord-bot](discord-bot.md).

### Security checklist (README)

Run `host-firewall.ps1` as admin; plain-HTTP and local ports stay on loopback and are never forwarded; set `ADMIN_TOTP_SECRET` for the staff console; keep `AUTH_MODE="LAUNCHER"` and `ALLOW_NO_AUTH_DEV_MODE` blank; secrets only in `.env`, `data\certs`, `.secrets`; back up Mongo and `discord-bot/data`. Later hosting maps the same parts to a Windows VPS (Director + game servers), a Linux VPS or home server for the bot, Atlas for Mongo, with private networking between machines. Known gap: the staff console's metrics and restart button use PowerShell, so they work on Windows hosts only.

## Connects to

| Target | How |
|---|---|
| Live PC | read-only: `.env` files, `game-data`, `D:\MysticParadoxData\{certs,updates}`, `mongodump` against live mongod on 27018, game install |
| [Backend](backend.md), [Director](director.md) | `.env` files rewritten for the test box; started by `restart-server.ps1` |
| [Host scripts](host-scripts.md) | `restart-server.ps1`, `host-firewall.ps1` |
| [backend-persistence](backend-persistence.md) | database dump and restore; replica set init script |
| [Launcher](launcher.md) | invite links with the cert fingerprint; players add the test server via Servers > Add server |
| [Discord bot](discord-bot.md) | deliberately absent from the test server |
| GitHub | test machine `git pull` uses the live repo's `origin` URL; the README assumes a private repo (`gh auth login` or a credential prompt) |

## Config

Script parameters rather than env: `-TestLanIp`, `-PublicIp`, `-Out` (default `D:\RevampedBundle`), `-TargetRoot` (default `C:\Revamped`), `-Branch` (default `deploy-split`), `-Live` (default `D:\Dev\dauntless-revamped`), `-Game` (default `D:\Dev\dauntless 1.14.7\Dauntless_1.14.7`), `-Data` (default `D:\MysticParadoxData`), `-SkipGame`, `-SkipDb`; `-RestoreDb`, `-NoStart` for install. Env keys it reads or rewrites: `MONGODB_URI`, `MONGODB_DB`, `MY_IP`, `HTTPS_PORT`, `VOICE_UDP_PORT`, `PORT_RANGE_BEGIN`, `PORT_RANGE_END`, `REALTIME_XMPP_ALLOWED_HOSTS`, `GITHUB_CRASH_TOKEN`, `DISCORD_NEWS_BOT_TOKEN`, `DISCORD_BOT_URL`, `UPDATE_PUBLISHER_ALLOWED_IPS`, `LAUNCHER_INVITE_CODES`, `PARADOX_CERT_PEM_PATH`, `MAX_CONCURRENT_HUNT_SERVERS`. Machine env set: `REVAMPED_GAME_DIR`, `REVAMPED_DATA_DIR`, `REVAMPED_MONGOD`.

## Gotchas

- **The bundle holds secrets** (both `.env` files with live secrets, the TLS private key, the DB with all accounts). Keep it on your own drives, never in OneDrive/Drive/Discord, and delete it from the stick after install.
- The test server is a *copy of live identity*: same JWT/admin secrets, same certificate, same invite codes, same accounts. Tokens and logins are interchangeable between the two; only ports and the database file separate them. The test server never writes to the live DB.
- `invites.txt` contains a real invite code in plain text.
- At your own home, use the **LAN** invite; a router usually will not loop the public IP back inside.
- `install.ps1` runs elevated scripts that came out of the bundle's `repo\` folder; treat the bundle media as trusted code.
- `-Branch` defaults to `deploy-split`; if that branch was merged and deleted, pass `-Branch main`.
- `install.ps1` only restores the DB into an empty folder; re-running keeps the old data unless `-RestoreDb` is given (which replaces it).
- Mongo must not be installed as a service and must match the live major version (9.0 at time of writing). `install.ps1` does not check this; a mismatch shows up as a failed `mongorestore` or mongod start.
- The bundle's code is the **local** live branch (committed state, including unpushed commits), not GitHub. Uncommitted changes are not included.
- The test bundle's Director `.env` keeps the live `MAX_CONCURRENT_HUNT_SERVERS`; lower it by hand on a small machine.
- Publishing runtime/launcher updates happens only from the live PC; the test machine has no signing key and `UPDATE_PUBLISHER_ALLOWED_IPS` is blanked.
- Secret-bearing temp locations: `make-bundle.ps1` writes `.env` copies into `<Out>`; no cleanup step exists.

See also: [index](index.md), [setup](setup.md), [host-scripts](host-scripts.md), [backend](backend.md), [director](director.md), [discord-bot](discord-bot.md), [launcher](launcher.md).
