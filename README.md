# Dauntless Revamped

Private monorepo: launcher + server/runtime for each supported Dauntless version.

| Path | What | Imported from |
|---|---|---|
| `launcher/` | Dauntless Revamped launcher (Electron) | local `dauntless 1.14.7/launcher` (main) |
| `launcher-bridge/` | Forever → Revamped hand-over launcher | local launcher repo (`forever-bridge`) |
| `versions/1.14.7/` | Backend, Director, Runtime DLL (Mystic Paradox base) | HyjinnxDev/Mystic-Paradox `selfhost-1147-hunt-fixes` |
| `versions/1.4.4/` | Internal server, Metagame, Gateway, old launcher (dauntless-revived base) | HyjinnxDev/dauntless-revived `feature/forever-launcher` |

Each imported folder keeps its own LICENSE (AGPL-3.0) and NOTICE files.
Upstream fixes: `git subtree pull --prefix=versions/1.14.7 https://github.com/pranav158/Mystic-Paradox main`.
