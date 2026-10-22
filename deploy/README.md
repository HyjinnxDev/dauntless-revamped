# Deploying Dauntless Revamped on another machine

Everything the server needs, split into its parts. `make-bundle.ps1` (run on the live PC) gathers it into one
folder; `install.ps1` (run on the new machine) puts each part in place and starts it. First use: a **test server
on the mini PC**, next to the live one, with a copy of the live database.

Nothing here stops, changes or restarts the live server. The bundle maker only reads from it.

## The parts

| Part | What it is | Runs where | Talks to |
|---|---|---|---|
| **Backend** | `versions/1.14.7/ParadoxBackend`: accounts, store, XMPP chat, voice relay, staff console | game host (later: Linux VPS) | MongoDB, Director, bot |
| **Director** | `versions/1.14.7/ParadoxDirector`: starts Ramsgate, Dojo and hunt servers | Windows game host | Backend |
| **Game servers** | `Dauntless-Win64-Shipping.exe -server` + `MysticParadox.dll`, started by the Director | Windows game host | players (UDP) |
| **MongoDB** | the database (`mysticparadox`, port 27018, replica set `rs0`) | game host (later: Atlas or the VPS) | Backend only |
| **Discord bot** | `discord-bot/`: status channel, `/issue` tickets, launcher news. Own process, token and data | anywhere (home server is fine) | Discord; backend over HTTP |
| **Game files CDN** | Cloudflare R2, `cdn.hyjinnx.com` | already hosted | players |
| **Runtime signing key** | `ParadoxLauncher/.secrets/` | **live PC only**: publish updates from there, never copy it | - |

The bot and the backend share nothing but two URLs: the bot polls `BACKEND_HEALTH_URL` for the status
channel, and the backend reads `DISCORD_BOT_URL/news` for the launcher's news dock. Either can be down
without the other breaking.

## The bundle (what goes where)

```
RevampedBundle\                 made by make-bundle.ps1 on the live PC
  README.md, install.ps1, bundle.json (test LAN IP, public IP, ports, commit)
  repo\            code (git clone of the branch)        -> C:\Revamped\repo
  backend\.env     test settings (see below)              -> repo\versions\1.14.7\ParadoxBackend\.env
  backend\game-data\                                      -> repo\versions\1.14.7\ParadoxBackend\game-data\
  director\.env    test settings                          -> repo\versions\1.14.7\ParadoxDirector\.env
  director\game-data\                                     -> repo\versions\1.14.7\ParadoxDirector\game-data\
  certs\           TLS certificate + key (same as live)  -> C:\Revamped\data\certs\
  updates\         signed runtime/launcher files          -> C:\Revamped\data\updates\
  mongo\db.archive.gz  copy of the live database          -> restored into C:\Revamped\data\mongo\
  game\Dauntless_1.14.7\  game install (~16 GB)           -> C:\Revamped\game\Dauntless_1.14.7\
```

On the test machine, `C:\Revamped\data` plays the part of the live PC's `D:\MysticParadoxData` (logs, mongo,
certs, updates). `install.ps1` sets machine environment variables `REVAMPED_GAME_DIR`, `REVAMPED_DATA_DIR` and
`REVAMPED_MONGOD` so the usual `restart-server.ps1` (and the staff console's restart button) work there unchanged.

**The bundle holds secrets** (both `.env` files, the TLS private key). Keep it on your own drives or a USB stick,
never in OneDrive/Google Drive/Discord. Delete it from the stick once installed.

### What the test settings change

| Setting | Live | Test | Why |
|---|---|---|---|
| Paths (`D:\...`) | live PC | `C:\Revamped\...` | mini PC has only C: |
| `HTTPS_PORT` | 443 | **9443** | one public IP: live keeps 443 on the router |
| Director `PORT_RANGE_BEGIN/END` | 8780-8790 | **9780-9790** | same reason (hunts, Dojo = 9789, Ramsgate = 9790) |
| `VOICE_UDP_PORT` | 8791 | **9791** | same reason |
| Director `MY_IP` | public IP | same public IP | outside testers; LAN players get the mini PC's LAN address automatically (`travelHost.ts`) |
| `REALTIME_XMPP_ALLOWED_HOSTS` | ... | + mini PC LAN IP | chat/party for LAN clients |
| `GITHUB_CRASH_TOKEN` | set | **blank** | test crashes don't file real GitHub issues |
| `DISCORD_BOT_URL` / old bot token | - | **blank** | no bot on the test server: news dock hidden, no duplicate bot |
| `UPDATE_PUBLISHER_ALLOWED_IPS` | ... | **blank** | updates are published to live only |

Database, accounts, staff roles, invite codes and certificate are copies of live, so your normal account logs
in. The test server never writes to the live database.

## Setting up the test server (mini PC)

### On the live PC

1. Install the MongoDB dump tool once: `winget install MongoDB.DatabaseTools`
2. Live mongod must be running (it's read, not changed).
3. Find the mini PC's LAN address (on the mini PC: `ipconfig`, IPv4 Address), e.g. `192.168.1.50`.
   Give it a fixed address in the router (DHCP reservation) so the port forwards keep working.
4. Make the bundle (or add `-Out E:\RevampedBundle` for a USB drive; it needs ~17 GB):
   ```powershell
   powershell -ExecutionPolicy Bypass -File D:\Dev\dauntless-revamped\deploy\make-bundle.ps1 -TestLanIp 192.168.1.50
   ```
5. Copy the `RevampedBundle` folder to the mini PC (USB drive, or a network share).

### On the mini PC

1. Install: Node.js LTS (`winget install OpenJS.NodeJS.LTS`), Git (`winget install Git.Git`),
   MongoDB Community Server, **same major version as live (9.0)**, *without* "Install as a Service"
   (the stack starts mongod itself), and `winget install MongoDB.DatabaseTools`.
   The game brings its own VC++/DirectX DLLs; nothing else is needed.
2. Open an **admin** PowerShell in the bundle folder:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   It copies everything into `C:\Revamped`, installs packages, starts mongod, restores the database, opens the
   firewall for the test ports, prints two invite links (also saved in `C:\Revamped\invites.txt`) and starts
   the backend + Director. Ramsgate takes about a minute (`C:\Revamped\data\logs\director.log`, "ramsgate ready").
3. Check the RAM line it prints. On an 8 GB mini PC set `MAX_CONCURRENT_HUNT_SERVERS="2"` in
   `C:\Revamped\repo\versions\1.14.7\ParadoxDirector\.env`, then `restart-server.ps1 -DirectorOnly`.

### On the router (only for outside testers)

Forward to the **mini PC's LAN address**:

| External port | Protocol | To mini PC port |
|---|---|---|
| 9443 | TCP | 9443 |
| 9780-9791 | UDP | 9780-9791 |

Live forwards (443 TCP, 8780-8791 UDP) stay pointed at the live PC. Both servers share the public IP and
differ only by port, which the invite link carries.

### Joining

- **You (at home):** use the *LAN* invite. Your router doesn't loop public-IP traffic back inside.
- **Outside testers:** the *Public* invite. In the launcher: Servers > Add server > paste it.
  Everyone signs in again on the test server (same email/password as live: the database is a copy).

### Day to day

| Task | Command (mini PC, in `C:\Revamped\repo`) |
|---|---|
| Restart stack | `versions\1.14.7\host\restart-server.ps1` (`-Stop`, `-DirectorOnly`) |
| New code | `git pull`, then restart |
| Fresh copy of live data | make a new bundle on the live PC (`-SkipGame` saves 16 GB), then `install.ps1 -RestoreDb` |
| Logs | `C:\Revamped\data\logs\backend.log`, `director.log` |
| After a reboot | run `restart-server.ps1` (starts mongod too) |

`git pull` on the mini PC needs GitHub access to the private repo (`gh auth login` or a credential prompt).

## The Discord bot

Runs on its own; only one copy may run per bot token (two copies answer every `/issue` twice).
The test server runs **no** bot.

Moving the live bot out of the backend (when this branch goes live):

1. `cd discord-bot`, `copy .env.example .env`, then fill it from the backend's `.env`:
   `DISCORD_BOT_TOKEN` = old `DISCORD_NEWS_BOT_TOKEN`, plus `DISCORD_GUILD_ID`, `DISCORD_NEWS_CHANNEL_ID`,
   `DISCORD_STATUS_CHANNEL_ID`.
2. Bring the existing `/issue` tickets over (reads MongoDB, writes the bot's file):
   `cd versions\1.14.7\ParadoxBackend` then
   `node --env-file=.env scripts/export-discord-issues.cjs ..\..\..\discord-bot\data\issues.json`
3. In the backend `.env`: add `DISCORD_BOT_URL="http://127.0.0.1:3100"` and delete `DISCORD_NEWS_BOT_TOKEN`.
4. `npm ci` then `npm start` in `discord-bot` (keep it running: Task Scheduler "At log on", or pm2/systemd on a server).
5. Restart the backend.

Simplest and safest: run the bot on the same machine as the backend (everything stays on 127.0.0.1).
On another machine than the backend (e.g. your home server) the two need a private link between them (a VPN
such as WireGuard): point `BACKEND_HEALTH_URL`, the backend's `DISCORD_BOT_URL`, `BOT_HTTP_HOST` and the
backend's `HTTP_HOST` at those private addresses. Never expose port 3000 or 3100 to the internet: neither
has a password. Back up `discord-bot/data/issues.json`.

## Security checklist (every server machine)

- Firewall: run `versions\1.14.7\host\host-firewall.ps1` as admin (`-Allowed Any` for a public server). It
  opens only the HTTPS, game and voice ports and switches off Windows' blanket "allow node.exe / game exe on
  every port" rules. When Windows later asks to allow node.exe, click **Cancel**.
- The backend's plain-HTTP port (3000) listens on 127.0.0.1 only (`HTTP_HOST`); the Director (3001), the bot
  (3100) and MongoDB (27018) are local-only too. Never port-forward any of them.
- Staff console: set `ADMIN_TOTP_SECRET` so staff log in with an authenticator code, not just a password.
- Keep `AUTH_MODE="LAUNCHER"` and `ALLOW_NO_AUTH_DEV_MODE` blank.
- Secrets live only in `.env` files, `data\certs` and `ParadoxLauncher\.secrets` (signing key: live PC only).
  They are gitignored; never commit them, never paste them in Discord or an issue.
- Back up MongoDB and `discord-bot/data` off the machine.

## Later: real hosting

The same parts map onto paid hosting without code changes:

- **Windows VPS / dedicated box:** Director + game servers (+ backend and MongoDB, to start with). Install it
  exactly like the mini PC, with `-TargetRoot` if it has another drive.
- **Bot:** home server or a small Linux VPS (it's plain Node).
- **MongoDB:** MongoDB Atlas, or the VPS with nightly `mongodump` to R2.
- Machines that talk to each other (backend, Director, bot) do so over a private network (VPN such as
  WireGuard), never the open internet. Only the HTTPS port, the game UDP range and the voice port face the
  internet.
- Known gap: the staff console's server metrics/restart button use PowerShell, so they work on Windows hosts only.
