# RUSH Lab, the app (Tauri 2)

A Mac app that shows the hosted Mochi in a window of its own and lends this computer to its
members' AI. It runs NanoAgent with each member's own API keys, and a relay that connects that
NanoAgent to Mochi. Every AI run of a member connected here (model calls and plugin code) runs on
this computer, never on Mochi's servers. It opens at every login, in the menu bar; closing its
window leaves it running there, so runs still reach this computer.

## Install, as a member

1. The site's **Install RUSH Lab** screen (`src/theme/Root/LabScreen.js`; also Settings →
   Connection) offers the dmg for their Mac: Apple silicon or Intel.
2. They drag RUSH Lab into Applications and open it. It is ad-hoc signed, not notarized, so the
   first time macOS blocks it until they click **Open Anyway** in System Settings → Privacy &
   Security. Opened from the disk image or Downloads instead, it says to move it, and quits.
3. Its window shows the site. **Continue with GitHub** signs in in macOS's sign-in sheet over the
   window (below), and the window is signed in. On Windows the window signs in as the site does:
   WebView2 gives GitHub's passkeys through Windows Hello.
4. Signed in, the window connects this computer by itself, and lets them in once it is.

## Build

```bash
cd helpinghands
npm run desktop  # build the release app (desktop/src-tauri/target/release/bundle/{macos,dmg}/) and open it
```

Needs Node 22, Rust, a C compiler (Xcode's command line tools), and NanoAgent's checkout beside
`helpinghands/`. The app needs nothing installed where it runs. Opening the build takes over this
computer's RUSH Lab, as a member's install does.

`npm run desktop:dev` (`scripts/dev/desktop-dev.mjs`) builds RUSH Lab Dev instead, by the same code
and the same steps, installs it beside RUSH Lab (in /Applications on macOS, an NSIS install for the user on Windows) and opens it; `npm run
desktop:dev:build` only builds it. The two differ only in `config.yaml`: its top level is RUSH
Lab's, and its `dev` block (`scripts/stage.mjs --dev`) gives RUSH Lab Dev its own name,
identifier and data folder (`lab.mochi.lab.dev`), link scheme and command (`rushlab-dev`), files
folder, and this checkout's `npm start`, `http://localhost:3000`, as its one site. Both can run
at once. RUSH Lab Dev never updates itself: a local site's database is a copy of production's,
release archives too.

`.github/workflows/helpinghands-desktop.yml` builds a release (`npm run build:release`,
`scripts/release.mjs`) for each kind of Mac on its own runner, since each bundles that Mac's
runtimes. A release's version is its build's time, `0.<yyyymmdd>.<hhmmss>` in UTC; it
has its dmg, and its update, `RUSH Lab.app.tar.gz` signed for that version with the app's update key (the secret
`TAURI_SIGNING_PRIVATE_KEY`, which has no password; its public key is
`plugins.updater.pubkey` in `tauri.conf.json`). On a push to production it uploads both to
rush-lab.org, retrying for 15 minutes while the site deploys. Only a release updates itself.

## How a run reaches this computer

```text
browser ──► Mochi (hosted) ◄──WebSocket /api/runner── relay ──► NanoAgent 127.0.0.1:<port> ──► the model's provider
```

Mochi cannot reach a laptop, so the relay (`src/runner/relay.mjs`) dials Mochi. It signs in with
the member's session. Mochi's side is `src/server/runner.js`:
- The upgrade is refused if it carries an `Origin` header, or if it is authenticated only by a
  cookie. Otherwise a web page could register itself as a member's computer.
- Each member has one computer; a new one replaces the old.
- Every NanoAgent call for the member goes down that socket (`aiFor`): runs, plugin installs and
  plugin pages. While no computer is connected, they fail with "RUSH Lab is not connected".
  They do not fall back to Mochi's servers.
- A plugin page's frame carries no session, so its address names the computer by its
  connection's random `page` id.

The frames are in `src/runner/protocol.js`. The relay passes on only what these need: runs,
installs and their pages, and run folders' files. Only the marketplace's packages stay on Mochi's
NanoAgent.

Each NanoAgent's token is random for each start, and only its relay and lab.mjs hold it. Plugins
run in macOS's `seatbelt` sandbox (`nanoagent.plugin.sandbox`), via `sandbox-exec`. Each plugin can
read the system and its own folder, can write only its run's folder, and can reach the network only
through its own egress proxy port. It cannot see other processes, or their environments. On
Windows they run in an AppContainer (`nanoagent/docs/plans/windows-sandbox.md`).

## The app

```text
RUSH Lab.app
├── MacOS/mochi-lab-desktop       Tauri shell: src-tauri/src/{main,lab}.rs
├── MacOS/node, MacOS/uv          bundled runtimes (sidecars)
└── Resources/
    ├── runner/                   src/runner/: lab.mjs, the relay and what they load; plugin-project/: project.md and the publish-plugin skill
    ├── nanoagent/                NanoAgent's source (site/), its uv.lock, the PI runner's bundle, its config
    ├── config.json               config.yaml (RUSH Lab Dev's: its `dev` block over it): the app's name, label, scheme, the Mochi it serves, its folders, runtime versions
    └── stamp                     names this build
```

`scripts/stage.mjs` produces the resources and downloads the runtimes (checksums verified)
before every `tauri build`. NanoAgent ships as its source, as it is
open source; its dependencies are installed from the bundled uv.lock on Python 3.12, and the PI
runner ships as its two bundled files.

At launch the app (`src-tauri/src/main.rs`, `lab.rs`):

1. Opens its window on `site_url`, titled with its `product_name`. Hidden when the login item opened it (`--login`). And its
   menu-bar icon: Open RUSH Lab (the window), Show Logs, Quit RUSH Lab, each naming the app. The Dock icon, or opening
   the app again, shows the window too; closing it hides it, and the Dock icon with it. The
   window's pages see `window.__RUSH_LAB_APP__`. Links that ask for a new window open in the
   browser.
2. Stops and removes a RUSH Lab the old one-line install had launchd run
   (`~/Library/LaunchAgents/lab.mochi.lab.plist`). Its connections stay, and this app serves them.
3. Installs this build once into `~/Library/Application Support/<label>/app/<stamp>/mochi-lab/`,
   and removes older ones: NanoAgent's `.venv` is made beside it.
4. Sets itself to open at login (`tauri-plugin-autostart`, a launch agent named for the app,
   which passes `--login`).
5. Runs `node lab.mjs` from there, its output in `logs/lab.log`, and starts it again 30 s after
   it exits. Quitting sends it SIGTERM, which stops every connection, and SIGKILL after 60 s.
6. A release keeps itself the build its window's site serves (`src-tauri/src/update.rs`): at launch
   and every hour it asks `GET /api/lab/updates/<target>`, and a newer version is downloaded,
   checked against the update key and the version it was signed for, and installed over the app. It opens that build,
   its window hidden, once nothing runs here and its window is closed: lab.mjs keeps the data
   folder's `busy` while any relay has a request of Mochi's going, a held run until Mochi
   releases it. Its log is `logs/lab.log`.

A failure in steps 2 to 4 says why in a dialog, and the app quits.

## Signing in the window

GitHub's sign-in asks for passkeys, which a WebKit window gives only to an app signed by an Apple
developer, so the window signs in in macOS's own sign-in sheet over it (ASWebAuthenticationSession,
`src-tauri/src/sign_in.rs`), where passkeys work and Safari's sign-ins carry over
(`src/server/routes/lab.js`):

1. In the window, **Continue with GitHub** (`AuthScreen.js`) goes to `<scheme>://sign-in`, which the
   app follows instead of the page. It opens `GET /api/lab/sign-in?state=<random>` in the sheet.
2. Signed in there, Mochi redirects to `<scheme>://sign-in?site=&state=&token=<t>`; signed out, to
   the sign-in page first, which comes back. The sheet hands that address to this app alone, never
   to a browser or another copy of the app, and closes.
3. The app takes it only with the state it asked for. It opens
   `GET /api/lab/window-sign-in?token=<t>` in the window, which sets the session cookie of a new
   session for the token's member, and opens the site.

## Connecting a member

In the window, `LabScreen.js` hands the app the member's connect link by itself, and the app
connects them at once: the link came from the site the window shows, where they are signed in. A
link from anywhere else, such as Connect on the site in a browser, connects them only once they
confirm it. `src/server/routes/lab.js`:

- `GET /api/lab/connect` (signed in) answers `{link}`: `<scheme>://connect?site=<SITE_URL>&token=<t>`.
  The token is the member's for an hour, `<user id, base64url>.<expiry, unix seconds>.<HMAC-SHA256, base64url>`,
  signed with a key derived from `BETTER_AUTH_SECRET` (`src/server/lab-tokens.js`). Mochi keeps
  nothing of it.
- `GET /api/lab/session?token=<t>` answers `{member: {id, login}}`: whose the link is.
- `POST /api/lab/session?token=<t>` answers `{session, member}`: a new session for the token's
  member, the same Better Auth session the device grant gives once a member approves a computer.
  Anyone holding the link for its hour could make one, so it is the member's to keep.

The app registers its `scheme` (`tauri-plugin-deep-link`): `rushlab` for RUSH Lab, `rushlab-dev`
for RUSH Lab Dev, whose links its local site makes (`src/server/lab-app.js`, `MOCHI_LOCAL_SITE`).
macOS hands each link to the running app; a second launch quits
(`tauri-plugin-single-instance`). For a link, it asks lab.mjs:

1. `lab.mjs member <site>`, with the token in `LAB_TOKEN`: the site must be `site_url`
   (`connectableSite`), so no web page can connect this computer to a site of its own. Then whose
   the link is (`GET /api/lab/session`).
2. For a link from outside the window, the app asks: "Connect this computer to <host> as
   @<login>?" A link for someone else's account, which a page could open, is refused here.
3. `lab.mjs connect <data> <site>`: a session (`POST /api/lab/session`), kept as that member's
   connection (`addConnection`). Connecting a member again rewrites only their connection.

Any failure says why in a dialog.

## lab.mjs

`src/runner/lab.mjs` serves every connection on this computer's account: one member of its one
site each, however many members. A connection to any other site, which an earlier build kept, is
removed at startup (`removeOtherSites`), its member's files left as they are. The data folder, `~/Library/Application Support/<label>/`
(`label` in `config.yaml`), holds what they share: `app/<stamp>/`, `python/`, the uv cache, and
`logs/lab.log`. Each connection is `connections/<host>-<member id>/`: its `site`, its member
(`member.json`, their id and GitHub login), their sign-in (`runner-credentials.json`, mode 0600),
their keys (`settings.env`), NanoAgent's folders and `logs/` for them, and `installed`, rewritten by
each connect. The member's files are `~/<files_folder>/<login>/`: `~/rushlab/<login>/` in RUSH Lab,
`~/rushlab-dev/<login>/` in RUSH Lab Dev.

It starts with `uv sync`, once. Then, for each connection, it starts NanoAgent on a free port with
the sandbox, a fresh token, that member's keys and `run_models=true` (each run may name its own
model and settings), waits until NanoAgent's default profile is available, then starts a relay for
it. Each service gets only the system variables it needs, with the bundled `node` and `uv` first
on PATH. It looks at `connections/` every 2 s: a new connection starts, a removed one stops, and
one connected again restarts, while the others keep running. Its log is `logs/lab.log`, each
connection's lines marked `[<id>]`.

When a relay's session lapses, it asks for the device page (`/device?client=desktop`), which
lab.mjs opens in the browser and logs; once connected after that, it opens the site, at
Settings → AI while there is no key. Keys come only from Mochi, through the relay: from Settings →
AI, a key travels down the relay's socket (`{type: 'keys'}`), and the relay hands it to lab.mjs on
its stdout and hears the answer on its stdin. lab.mjs keeps it in the connection's `settings.env`
(mode 0600), hands it to the running NanoAgent (`PUT /v1/keys`), and tells the relay which keys are
set. Mochi keeps nothing, and sees only which keys are set.

When either service of a connection exits, it stops the other, the relay first, and starts the
connection again after 30 s. A relay replaced by another computer signing in as the same member
exits cleanly, and its connection stays stopped until it is connected again, so two computers do
not take the runs back and forth. SIGTERM stops every connection and exits 0; lab.mjs exits 1 only
when `uv sync` fails.

To remove one member's connection from this computer, remove its folder, which lab.mjs then stops.
To uninstall RUSH Lab, quit it, remove it from Applications and from System Settings → General →
Login Items, and remove the data folder.

## The command

A member designs a plugin with any AI CLI on their computer (`claude`, `codex`, `gemini`, ...) in
whatever terminal app they use, with no NanoAgent harness or OpenRouter key in that chat, through
the one command the app puts on their PATH: `command` in `config.yaml`, `rushlab` for RUSH Lab and
`rushlab-dev` for RUSH Lab Dev, so the two never clash (`src/runner/lab.mjs`):

- lab.mjs writes `~/.local/bin/<command>` (on Windows `%USERPROFILE%\.local\bin\<command>.cmd`)
  each time it starts, so it runs the installed build's bundled node on its lab.mjs. When
  `~/.local/bin` is not on the member's PATH, lab.mjs logs the line to add; the command is never
  put anywhere else.
- `<command> new <id>` (`^[a-z0-9]+(-[a-z0-9]+)*$`) runs `nanoagent plugin new ./<id>` and writes
  the skill into the project as `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`
  (`src/runner/plugin-project/project.md`, then `docs/instructions/skills/publish-plugin/SKILL.md`,
  which `scripts/stage.mjs` puts beside it), which NanoAgent allows and never packs. It refuses a
  folder that exists, and when it fails it says why and leaves nothing behind. A project is
  wherever the member makes it.
- `<command> nanoagent ...` and `<command> uv ...` run the app's own NanoAgent (the bundled uv
  first on its PATH) and uv, so nothing else goes on the member's PATH.
- With no subcommand, or another, it prints its usage and exits 2.
- Publishing is a public GitHub repository, imported with Marketplace → Publish a plugin.

## Downloads

- `PUT /api/lab/bundles/<target>`, with `Authorization: Bearer <LAB_UPLOAD_TOKEN>` and
  `X-Lab-Stamp`, is how a release uploads a dmg, 200 MB at most. It answers
  `{target, stamp, sha256, size}`. Without `LAB_UPLOAD_TOKEN` set, it answers 503.
- `GET /api/lab/bundles/<target>`, signed in, streams it, with `X-Lab-Stamp`, `X-Lab-Sha256` and
  `Content-Length`; 404 while there is none.
- `PUT /api/lab/updates/<target>`, as a dmg is uploaded, with `X-Lab-Signature` (its `.sig`), is how
  a release uploads its update.
- `GET /api/lab/updates/<target>`, for anyone, is what the app's updater asks: `{version, url,
  signature}`, the version the signature names, or 204 while there is none.
  `GET /api/lab/updates/<target>/app.tar.gz` streams the update.

The targets are `aarch64-apple-darwin` and `x86_64-apple-darwin`. Each keeps only its newest dmg
and update, in PostgreSQL (migrations 0034, 0035, 0038 and 0040, `src/server/postgres/lab.js`) as rows of 4 MiB, so
neither an upload nor a download holds a whole dmg in memory. An upload replaces the previous one
in a single transaction. Any signed-in member may read them; row-level security lets only the
upload path write them. A download that an upload overtakes is cut off rather than finished with
the new dmg's bytes.

Locally, `npm start` runs no RUSH Lab of its own: a checkout's site is RUSH Lab Dev's, which it
connects as rush-lab.org connects RUSH Lab. To try a change to the runner or NanoAgent, build it
(`npm run desktop:dev`).

## Known gaps

- **Signing out** of the site does not disconnect the relay. Its session is its own.
- **Windows** (FUTURE.md). An installer builds, but CI does not build or ship one.
- **One Mochi process.** Mochi keeps the connected computers in memory, as it does every other
  live connection (`src/server/fs/events.js`). Running several Mochi processes would need them
  relayed between processes.
