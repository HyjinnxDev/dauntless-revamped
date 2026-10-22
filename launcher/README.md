# Dauntless Revamped Launcher

*[Suomeksi](README.fi.md)*

The Windows app players install to play on a Dauntless 1.14.7 server running Mystic Paradox. It joins a
server from an invite, creates the account (or signs in), downloads and checks the pinned Dauntless
1.14.7 client and the server's runtime, and starts the game through a local relay. English, Finnish
and Spanish.

**No game files are in this app or in this repository.** They come from the host's server (or a
download location the host's server names), and every file is checked against the list of files, sizes
and SHA-256 hashes compiled into the launcher (`data/dauntless-1.14.7.json`). A file that does not
match is refused.

**Community:** [Join the Dauntless Revamped Discord](https://discord.gg/HpgNEmVbBb) for help, players
and project updates. The launcher links to it too.

## For players

1. Install `DauntlessRevampedLauncher-Setup.exe` from the
   [latest release](https://github.com/HyjinnxDev/dauntless-revamped-releases/releases/latest) and check
   it against `SHA256SUMS.txt` from the same release. The installer is not code-signed, so SmartScreen
   may ask you to confirm (More info, then Run anyway). Installed launchers update themselves.
2. Open the invite link your host sent you, or paste it on the Play page and press **JOIN**.
3. Create an account (username and password), or sign in if you already have one on that server.
4. Press **INSTALL**. You can pause, close the launcher and continue later. If you already have
   Dauntless 1.14.7, choose **I already have the game files** and point the launcher at that folder:
   it checks every file and downloads only what is missing or different. Copy the folder first if
   another setup still uses it.
5. Press **PLAY**.

At the top of the window the GitHub button opens this project's source, and **Credits** lists the
people who made the launcher and the server, the open-source software they use, and the license.

## Servers and invites

```text
dauntless-revamped://join?v=1&host=<IPv4 or DNS name>&port=<HTTPS port, default 443>&fp=<SHA-256 of the server's certificate>&code=<invite code>&name=<server name>
```

A server is reached at its public (or LAN) address. The invite carries `fp`, the SHA-256 of the
server's TLS certificate, and every connection (status, account, downloads and the game's own HTTP and
chat traffic) is checked against it before anything is sent. A server with another certificate gets
nothing, and the launcher says "this is not your friend's server". A self-signed certificate is fine.

A sign-in is tied to that fingerprint. An invite for the same address with a different certificate
never gets it: the launcher shows both fingerprints and asks first, and moves the sign-in only if you
confirm (do that only when your host tells you they set the server up again).

The game speaks plain HTTP to its backend, so while it runs the launcher runs a **local relay** on
`127.0.0.1:61000` that carries those requests over pinned TLS to the server. Keep the launcher open
while you play. The relay listens on 127.0.0.1 only and refuses requests that come from a web page.
The game's UDP traffic goes straight to the server's game ports.

Hosts make invites with
`node scripts/make-invite.mjs --host <address> --cert <fullchain.pem> --code <invite code> --name "<server name>"`.
Links in the older `dauntless-forever-1147://` scheme still work.

## Security

- The page is sandboxed with context isolation and no Node access. It cannot reach the network at
  all; the main process makes every request, only to the invite's host. The page talks to the main
  process through a small typed API (`src/preload.ts`), and every argument is checked again.
- Strict Content-Security-Policy. Images come only from the app itself or from the host's art pack,
  fetched by the main process over the pinned connection and served through an internal scheme.
- Navigation and new windows are blocked. Links open in the browser only from a fixed allow-list:
  the page names a link (such as `project_source`), never a URL, and the main process opens that
  link's fixed URL (`src/main/links.ts`).
- The password is never stored. The server's refresh token is kept through Electron `safeStorage`
  (DPAPI), one per server, and never reaches the page.
- The server's runtime (`MysticParadox.dll` and `winmm.dll`) is installed exactly as the server's
  release lists it, checked by SHA-256.
- Electron fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no inspector flags, app code only
  from the integrity-checked asar.

## Development

Requirements: Windows and Node.js 20.19 or newer.

```text
npm ci
npm run typecheck
npm test            # unit tests (node:test) with local test servers on 127.0.0.1
npm start           # run the launcher from source
npm run make        # Squirrel installer + portable zip in out/
```

`npm test -- relay` runs only the test files whose name contains "relay". The tests cover invite
parsing, the relay, downloads (resume, verify, repair) over pinned TLS, the launch settings, the links
the launcher may open, the Credits page's data, the whole flow through the controller, and the look:
the brand colours and images. They make throwaway self-signed certificates in a temp folder.

`DAUNTLESS_REVAMPED_RELAY_PORT` moves the relay off 61000 on a PC where 61000 is taken.

`npx tsx scripts/live-check.ts "<invite>" <username> <password>` checks a live server end to end
without starting the game. `scripts/make-game-manifest.mjs` rebuilds the pinned game manifest from an
install.

The colours are the `--dr-*` tokens in `src/renderer/styles.css` (from `brand/palette.json`). The
window and installer icons and the title bar emblem are copies of files in `brand/`, made by
`npm run icon`. `npm test` fails when a copy is out of date, when the stylesheet has a colour that is
not a token, or when a colour pair it uses fails WCAG AA.

## Releases and updates

Raise `version` in `package.json`, then `npm run release`: it builds the installer and zip, collects
them with `SHA256SUMS.txt` (`scripts/collect-release.ps1`) and publishes them as a release of
[HyjinnxDev/dauntless-revamped-releases](https://github.com/HyjinnxDev/dauntless-revamped-releases).
Installed launchers read that repository's latest release as their Squirrel update feed. Installs from
the portable zip do not update themselves.

On its first start the launcher carries the settings and sign-ins of the older Dauntless Forever
1.14.7 launcher over and removes that install (`src/main/migrate.ts`).

## License

AGPL-3.0-only. A modified version of the [Dauntless Revived](https://github.com/mixutin/dauntless-revived)
launcher, which is in turn a modified version of the [Undaunted](https://github.com/SyST3MDeV/Undaunted)
launcher by gwog (Gregory Morford) and contributors. It plays on
[Mystic Paradox](https://github.com/pranav158/Mystic-Paradox). An unofficial fan project, not
affiliated with or endorsed by Phoenix Labs or Epic Games.

The license texts of the third-party software in the launcher ship with it in
`THIRD-PARTY-NOTICES.txt`. The Credits page reads its list from `src/shared/credits.ts`.
