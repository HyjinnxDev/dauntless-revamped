# Dauntless Revamped

Private monorepo (`HyjinnxDev/dauntless-revamped`): the Revamped launcher plus the server/runtime for each supported Dauntless version. This is the only working copy; old clones are renamed `*.old` and stale.

## Layout

| Path | What |
|---|---|
| `launcher/` | Dauntless Revamped launcher (Electron Forge, TS) - players' entry point |
| `launcher-bridge/` | Forever -> Revamped hand-over launcher (0.1.x), legacy |
| `versions/1.14.7/` | Live game: `ParadoxBackend` (metagame/XMPP/store, Mongo), `ParadoxDirector` (spawns game servers), `ParadoxRuntime` (MysticParadox.dll, C++), `ParadoxLauncher` (runtime update publishing + signing key) |
| `versions/1.14.7/host/` | `restart-server.ps1` (`-Stop`, `-DirectorOnly`), `host-firewall.ps1`, `server-sizing-log.ps1` |
| `versions/1.4.4/` | Older Dauntless Revived stack (InternalServer DLL, Metagame, Gateway, old launcher) |

Outside the repo (never commit, never move):
- Game install used by servers: `D:\Dev\dauntless 1.14.7\Dauntless_1.14.7`; test client: `D:\Dev\dauntless 1.14.7\Client`.
- Runtime data: `D:\MysticParadoxData` (`logs\`, `mongo\`, `certs\`, `updates\`). Mongo = hand-started `mongod` on 27018 (no Windows services on this machine).

## Gitignored but required (exist only on this machine - back them up)

`versions/1.14.7/ParadoxBackend/.env`, `ParadoxDirector/.env`, `ParadoxLauncher/.secrets/` (runtime update signing key), `ParadoxRuntime/SDK/` + generated headers (Dumper-7), `*/game-data/*.json` (exported game data; Phoenix Labs data, never commit), `node_modules/`.

## Common commands (PowerShell)

```powershell
# server stack (asks for UAC once; logs in D:\MysticParadoxData\logs)
versions\1.14.7\host\restart-server.ps1            # restart backend + Director (+ mongod if down)
versions\1.14.7\host\restart-server.ps1 -Stop      # stop backend, Director, game servers
# runtime DLL
versions\1.14.7\ParadoxRuntime\_build.bat          # -> x64\Release\MysticParadox.dll
# publish runtime to clients (from versions\1.14.7\ParadoxLauncher; bump version; live without restart)
node scripts/publish-runtime-update.mjs --dll ../ParadoxRuntime/x64/Release/MysticParadox.dll --extra <prev version dir>/winmm.dll --target client --version <bump> --changelist 647472 --channel stable --output 'D:\MysticParadoxData\updates' --base-url https://paradox.test --key .secrets/selfhost-runtime-update.private.pem
# tests (all green 2026-10-17)
cd versions\1.14.7\ParadoxBackend; npm test        # 293 tests
cd versions\1.14.7\ParadoxDirector; npm test
cd launcher; npm run typecheck; npm test
```

Backend/Director code changes need a restart to go live; game-data regen needs a backend restart. Client DLL changes only reach players through a signed publish (hand-copied DLLs are rejected by hash).

## Rules

- Push only to `origin` (HyjinnxDev/dauntless-revamped). Never push, PR or open issues against pranav158/Mystic-Paradox or mixutin/dauntless-revived. Pull their fixes with `git subtree pull --prefix=versions/1.14.7 https://github.com/pranav158/Mystic-Paradox main` (or `versions/1.4.4` + mixutin).
- `main` = what is deployed. Work on a branch, merge when tested.
- Ask before restarting the live server or publishing a runtime/launcher update: players are affected.
- Keep each version folder's LICENSE / NOTICE / ADDITIONAL_TERMS (AGPL-3.0). New source files keep the existing header style.
- Tests ending `.gamedata.test.ts` check our local game data; when data is regenerated on purpose, update their expected counts with a dated `[Revamped]` comment.
