# Discord bot

> Verified against code 2026-10-24.

## What it is

`discord-bot/` is a small standalone Node + TypeScript program (discord.js 14.27.0) with its own process, token and data file. It does three jobs: it renames a Discord channel to show server status, it runs `/issue` ticket slash commands, and it serves the latest posts of an announcements channel over a local HTTP port so the backend can show them as launcher news. It was split out of the backend (merged to main 2026-10-22); the backend and the bot share nothing but two URLs.

## File reference

| File | What it does |
|---|---|
| `discord-bot/src/bot.ts` | Entry point (`Main`): reads env, creates the discord.js `Client` (intent `Guilds` only), calls `StartIssues`, logs in, starts `RunStatus` and the news HTTP server when configured, handles SIGINT/SIGTERM. |
| `discord-bot/src/status.ts` | `RunStatus(token, channel, url)` (endless poll loop), `StatusName(players)`, private `Discord` (REST helper) and `Players` (health poll). |
| `discord-bot/src/issues.ts` | `/issue`, `/close`, `/issue-channel` commands (`Commands`), `Handle`, `StartIssues`, `IssueEmbed`, the JSON ticket store `IssueStore` (`load`, `save`), types `Issue`, `IssueData`, `GatewayIntents`. |
| `discord-bot/src/news.ts` | `NewsHandler(token, channel)` HTTP handler for `GET /news` and `GET /news/image/<id>`; `DiscordNews`, `PostImage`, `PlainText`; 60 s cache (`FreshNews`, `FetchNews`). |
| `discord-bot/src/status.test.ts`, `issues.test.ts`, `news.test.ts` | `node --test` tests: status name; embed open/closed, store empty/overlapping saves/broken file; news title/markup/system messages, image host filter. |
| `discord-bot/start-bot.ps1` | Kills any running copy, `npm ci` if `node_modules` is missing, `npm run build`, starts `node --env-file=.env dist/bot.js` hidden with output to `discord-bot\bot.log`. `-Stop` only stops. Throws if `.env` is missing. |
| `discord-bot/.env.example` | Documented env template (the real `.env` is gitignored). |
| `discord-bot/package.json`, `package-lock.json` | `revamped-discord-bot` 1.0.0. Scripts `build` (`tsc`), `start` (build + `node --env-file=.env dist/bot.js`), `test` (`node --import tsx --test src/*.test.ts`). |
| `discord-bot/tsconfig.json` | ES2022, CommonJS, `src` to `dist`, tests excluded. |
| `discord-bot/.gitignore` | `node_modules/`, `dist/`, `data/`, `*.log`. |
| `discord-bot/data/issues.json` | Ticket database (runtime data; gitignored; folder from `BOT_DATA_DIR`). |
| `discord-bot/dist/` | `tsc` output, what actually runs (`dist/bot.js`). |

## How it works

### Startup (`bot.ts`)

1. `DISCORD_BOT_TOKEN` is required, otherwise it throws.
2. Creates a `Client` with only the `Guilds` intent and calls `StartIssues` (commands are registered on `ClientReady`). Login failures are logged (`[Bot] Discord login failed`), not fatal.
3. If `DISCORD_STATUS_CHANNEL_ID` is set, starts `RunStatus` (an endless loop).
4. If `DISCORD_NEWS_CHANNEL_ID` is set and looks like a snowflake (`^\d{5,25}$`), starts an HTTP server on `BOT_HTTP_HOST:BOT_HTTP_PORT` (`[News] serving on ...`).
5. SIGINT/SIGTERM destroy the client and exit.

Each feature is independent: a missing channel id only turns that feature off. `/issue` needs only the token.

### Status channel (`status.ts`)

- At start it reads the channel's current name (`GET /channels/<id>`); if that fails the first poll renames.
- Every 60 s it GETs `BACKEND_HEALTH_URL` (default `http://127.0.0.1:3000/health/ready`, the backend's plain-HTTP port; 5 s timeout) and reads `players` from the JSON (`Number(json.players) || 0`). A non-2xx or a network error is a failed poll.
- Two failed polls in a row mean offline (a quick restart does not flap). One failed poll keeps the last count.
- Wanted name is `🟢 Online · N slayers` (`slayer` for 1) or `🔴 Offline`. It renames via `PATCH /channels/<id>` on the Discord REST API v10 with the bot token (10 s timeout), at most once every 5 minutes (Discord allows 2 renames per 10 minutes). Use a **voice channel**, because text channel names cannot contain spaces or capitals.
- It runs outside the backend on purpose so it can still report the backend being down.

### Issue tickets (`issues.ts`)

All commands are guild-only (`InteractionContextType.Guild`).

| Command | Options | Who | Does |
|---|---|---|---|
| `/issue` | `title` (max 200), `description` (max 3500) | anyone, only in channels allowed by `/issue-channel add` | Creates ticket `#<lastId+1>`, saves, posts an embed (in the log channel if set, else as the reply where it was used). With a log channel the reporter gets a private "Logged as issue #id" reply. If posting to the log channel fails the ticket is removed again (its number stays used) and the reporter gets the error reply. |
| `/close` | `id` (integer ≥ 1), `reason` (max 500, optional) | default permission Manage Messages | Marks it closed (`closedBy`, `closeReason`, `closedAt`), edits the original post's embed (says so if that edit fails). |
| `/issue-channel add` / `remove` | `channel` (text channel) | default permission Manage Server | Allows or disallows `/issue` there. |
| `/issue-channel log` | `channel` | Manage Server | Where new tickets are posted. Existing tickets stay put. |
| `/issue-channel list` | - | Manage Server | Shows allowed channels and the log channel. |

Default permissions can be changed by server admins in Server Settings > Integrations. If `DISCORD_GUILD_ID` is set the commands register to that guild instantly, otherwise globally (up to an hour). Commands are registered with `commands.create` (upsert by name), so other commands are not touched. A handler error replies "Something went wrong. Please try again." privately.

Embed: title `#<id> <title>`, fields Status, Reported by, Closed by, Resolution; colour orange (open) or grey (closed).

Storage: `IssueStore` keeps the whole file in memory and rewrites it on every change (write `issues.json.tmp`, then rename; writes are serialised through a promise chain; the folder is created if needed). A missing file starts empty; an unreadable or corrupt file throws so it is never overwritten. Shape: `{ lastId, channels[], log?, issues[] }`, each issue `{id, title, description, reporterId, channelId, messageId?, status, createdAt, closedBy?, closeReason?, closedAt?}`. Tickets from when the bot lived in the backend are imported with `versions/1.14.7/ParadoxBackend/scripts/export-discord-issues.cjs`.

### Launcher news (`news.ts`)

HTTP endpoints on `BOT_HTTP_HOST:BOT_HTTP_PORT` (no authentication):

| Method + path | Response |
|---|---|
| `GET /news` | 200 `{ items: [{ date, title, body, image? }] }`, `cache-control: no-store` |
| `GET /news/image/<5-25 digit message id>` | The post's first image bytes with its content type; 404 if the id is not in the current list; 502 if the fetch fails, is not png/jpeg/webp/gif, or is over 8 MB |
| other GET path | 404 |
| any non-GET | 405 |

- The list is built from the last 50 messages of the channel (`GET /channels/<id>/messages?limit=50`, 10 s timeout), max 20 items. Only normal posts (type 0) and replies (19) count. Text is the message content, or the first embed's title + description. `PlainText` strips mentions, custom emoji (to `:name:`), timestamps (to `YYYY-MM-DD`), `@everyone`/`@here`, `-#` and `#` heading marks and markdown marks.
- The first line is the title (max 120 chars) when there is more text; a one-line post becomes title `Announcement` with that line as the body. Posts with neither text nor image are skipped.
- A post's first image (image attachment, then embed image/thumbnail) must be on `cdn.discordapp.com` or `media.discordapp.net`. Items reference it as `/content/v1/news/image/<message id>`, which is the **backend's** path; the backend proxies to `GET /news/image/<id>` on the bot, which fetches the signed CDN URL on demand (20 s timeout, redirects refused).
- The message list is cached for 60 s, one Discord call at a time. On a Discord error it keeps serving the last good list (or an empty one) and retries after the next 60 s.

## Connects to

| Target | How |
|---|---|
| Discord | REST `https://discord.com/api/v10` and the gateway (discord.js) with `DISCORD_BOT_TOKEN` |
| [Backend](backend.md) health | bot to backend: `BACKEND_HEALTH_URL` (`/health/ready`, plain HTTP, loopback); the backend adds `players` to that response for this bot |
| [Backend](backend.md) news | backend to bot: backend env `DISCORD_BOT_URL` (for example `http://127.0.0.1:3100`; unset = news 404) and `routes/news.ts` call `/news` and `/news/image/<id>`; the backend exposes them to players as `/content/v1/news` and `/content/v1/news/image/:id` |
| [Launcher](launcher.md) | players only see the backend's `/content/v1/news`; the launcher never talks to the bot |
| [Deploy](deploy.md) | the test-server bundle runs no bot; moving the live bot is described there |

## Config

From `.env` (loaded with `node --env-file=.env`):

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | required | Bot token. Portal intent: Message Content (news). Permissions: View Channel, Read Message History, Send Messages, Embed Links, Manage Channels (rename). |
| `DISCORD_GUILD_ID` | blank (global commands) | Register slash commands in one server. |
| `DISCORD_STATUS_CHANNEL_ID` | blank = off | Voice channel to rename. |
| `BACKEND_HEALTH_URL` | `http://127.0.0.1:3000/health/ready` | Health endpoint polled. |
| `DISCORD_NEWS_CHANNEL_ID` | blank = news off | Announcements channel (must be 5-25 digits). |
| `BOT_HTTP_HOST` | `127.0.0.1` | Bind address of the news server. |
| `BOT_HTTP_PORT` | `3100` | Port of the news server. |
| `BOT_DATA_DIR` | `data` | Folder of `issues.json`, resolved against the working directory. |

Scripts: `npm run build` (tsc), `npm start` (build + run), `npm test`. `start-bot.ps1` is the normal way on the live PC.

## Gotchas

- **One copy per token.** Two running bots answer every `/issue` twice (and race on `issues.json`). `start-bot.ps1` kills existing copies first by matching `dist/bot.js` + `--env-file` in a `node.exe` command line.
- The bot code is run from `dist/`, so `npm run build` is needed after edits (`start-bot.ps1` and `npm start` do it).
- The news HTTP port has **no password**. Keep `BOT_HTTP_HOST` on loopback or a private VPN address and never forward port 3100.
- **Port 3100 clashes with the test stack.** `host/test-stack.ps1` puts the test backend's HTTP `PORT` on 3100 and force-stops any `node.exe` listening there, which includes this bot. Change `BOT_HTTP_PORT` (and the backend's `DISCORD_BOT_URL`) on a PC that runs both.
- The news feature needs the Message Content intent enabled in the Discord developer portal even though the code only declares the `Guilds` gateway intent, because it reads message text through REST.
- Status uses `Number(json.players) || 0`, so a 200 response with a bad body shows "0 slayers", not offline.
- `/issue` has no cooldown or per-user limit, and the whole ticket file is rewritten per ticket. Back up `discord-bot/data/issues.json`; it is not in git.
- A failed log-channel post consumes the ticket number (`lastId` is not rolled back).
- `BOT_DATA_DIR` is relative to the working directory. `start-bot.ps1` runs in `discord-bot\`; starting `node dist/bot.js` elsewhere uses another `data` folder.
- Source headers still say "Dauntless Forever" and log tags `[forever-discord]`; that is cosmetic.
- The status channel name changes at most every 5 minutes, so it can lag a restart.

See also: [index](index.md), [setup](setup.md), [backend](backend.md), [backend-security-admin](backend-security-admin.md), [launcher](launcher.md), [deploy](deploy.md).
