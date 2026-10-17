# RUSH Lab, the app (Tauri 2)

A Mac app that lends this computer to its members' AI on the hosted Mochi. It lives in the menu
bar, opens at every login, and runs NanoAgent with each member's own API keys, and a relay that
connects that NanoAgent to Mochi. Every AI run of a member connected here (model calls and plugin
code) runs on this computer, never on Mochi's servers.

## Install, as a member

1. While their computer is not connected, the site holds a signed-in member at **Install RUSH Lab**
   (`src/theme/Root/LabScreen.js`; also Settings → Connection). They download the dmg for their
   Mac: Apple silicon or Intel.
2. They drag RUSH Lab into Applications and open it. It is ad-hoc signed, not notarized, so the
   first time macOS blocks it until they click **Open Anyway** in System Settings → Privacy &
   Security. Opened from the disk image or Downloads instead, it says to move it, and quits.
3. With no member connected yet, the app opens the site. They click **Connect RUSH Lab**, which
   hands the app their connect link. The app asks them to confirm the site and their GitHub
   login, and connects. The site lets them in once it sees the computer.

## Build

```bash
cd helpinghands
npm run desktop  # build the release app (desktop/src-tauri/target/release/bundle/{macos,dmg}/) and open it
```

Needs Node 22, Rust, a C compiler (Xcode's command line tools), and NanoAgent's checkout beside
`helpinghands/`. The app needs nothing installed where it runs. Opening the build takes over this
computer's RUSH Lab, as a member's install does.

`.github/workflows/helpinghands-desktop.yml` builds a dmg for each kind of Mac on its own runner,
since Nuitka compiles NanoAgent for the machine it runs on. On a push to production it uploads each
one to rush-lab.org, retrying for 15 minutes while the site deploys.

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
through its own egress proxy port. It cannot see other processes, or their environments.

## The app

```text
RUSH Lab.app
├── MacOS/mochi-lab-desktop       Tauri shell: src-tauri/src/{main,lab}.rs
├── MacOS/node, MacOS/uv          bundled runtimes (sidecars)
└── Resources/
    ├── runner/                   src/runner/: lab.mjs, the relay and what they load
    ├── nanoagent/                NanoAgent compiled by Nuitka (site/), its uv.lock, the PI runner's bundle, its config
    ├── config.json               config.yaml: the Mochi it serves, its label, the files folders, runtime versions
    └── stamp                     names this build
```

`scripts/stage.mjs` produces the resources and downloads the runtimes (checksums verified)
before every `tauri build`. NanoAgent ships compiled, not as source: Nuitka builds its package
into one module (`--mode=package`, NanoAgent's `compile` extra) for Python 3.12, with the files it
reads beside it. Its open-source dependencies are installed from the bundled uv.lock, and the PI
runner ships as its two bundled files. Its strings can still be read out of the module, so it
holds nothing secret.

At launch the app (`src-tauri/src/main.rs`, `lab.rs`):

1. Shows its menu-bar icon: Open RUSH Lab (the site), Show Logs, Quit RUSH Lab. It has no window
   and no Dock icon.
2. Stops and removes a RUSH Lab the old one-line install had launchd run
   (`~/Library/LaunchAgents/lab.mochi.lab.plist`). Its connections stay, and this app serves them.
3. Installs this build once into `~/Library/Application Support/lab.mochi.lab/app/<stamp>/mochi-lab/`,
   and removes older ones: NanoAgent's `.venv` is made beside it.
4. Sets itself to open at login (`tauri-plugin-autostart`, a launch agent named for the app,
   which passes `--login`).
5. Runs `node lab.mjs` from there, its output in `logs/lab.log`, and starts it again 30 s after
   it exits. Quitting sends it SIGTERM, which stops every connection, and SIGKILL after 60 s.

6. Opens the site in the browser, as it has no window of its own: whenever the member opens it,
   and opened again while it runs; at login, only while no member is connected. A launch for a
   connect link does not.

A failure in steps 2 to 4 says why in a dialog, and the app quits.

## Connecting a member

`src/server/routes/lab.js`:

- `GET /api/lab/connect` (signed in) answers `{link}`: `rushlab://connect?site=<SITE_URL>&token=<t>`.
  The token is the member's for an hour, `<user id, base64url>.<expiry, unix seconds>.<HMAC-SHA256, base64url>`,
  signed with a key derived from `BETTER_AUTH_SECRET` (`src/server/lab-tokens.js`). Mochi keeps
  nothing of it.
- `GET /api/lab/session?token=<t>` answers `{member: {id, login}}`: whose the link is.
- `POST /api/lab/session?token=<t>` answers `{session, member}`: a new session for the token's
  member, the same Better Auth session the device grant gives once a member approves a computer.
  Anyone holding the link for its hour could make one, so it is the member's to keep.

The app registers the `rushlab` scheme (`tauri-plugin-deep-link`), and macOS hands each link to the
running app; a second launch quits (`tauri-plugin-single-instance`). For a link, it asks lab.mjs:

1. `lab.mjs member <site>`, with the token in `LAB_TOKEN`: the site must be `site_url`, or a
   development checkout's on this computer (`http://localhost`, `127.0.0.1` or `[::1]`, any port;
   `connectableSite`), so no web page can connect this computer to a site of its own. Then whose
   the link is (`GET /api/lab/session`).
2. The app asks: "Connect this computer to <host> as @<login>?" A link for someone else's account,
   which a page could open, is refused here.
3. `lab.mjs connect <data> <site>`: a session (`POST /api/lab/session`), kept as that member's
   connection (`addConnection`). Connecting a member again rewrites only their connection.

Any failure says why in a dialog.

## lab.mjs

`src/runner/lab.mjs` serves every connection on this computer's account: one member of one site
each, however many members and sites. The data folder, `~/Library/Application Support/lab.mochi.lab/`
(`label` in `config.yaml`), holds what they share: `app/<stamp>/`, `python/`, the uv cache, and
`logs/lab.log`. Each connection is `connections/<host>-<member id>/`: its `site`, its member
(`member.json`, their id and GitHub login), their sign-in (`runner-credentials.json`, mode 0600),
their keys (`settings.env`), NanoAgent's folders and `logs/` for them, and `installed`, rewritten by
each connect. The member's files are `~/rushlab/<login>/` for rush-lab.org and
`~/rushlab-dev/<login>/` for any other site, such as a checkout's `npm start`.

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

## Downloads

- `PUT /api/lab/bundles/<target>`, with `Authorization: Bearer <LAB_UPLOAD_TOKEN>` and
  `X-Lab-Stamp`, is how a release uploads a dmg, 200 MB at most. It answers
  `{target, stamp, sha256, size}`. Without `LAB_UPLOAD_TOKEN` set, it answers 503.
- `GET /api/lab/bundles/<target>`, signed in, streams it, with `X-Lab-Stamp`, `X-Lab-Sha256` and
  `Content-Length`; 404 while there is none.

The targets are `aarch64-apple-darwin` and `x86_64-apple-darwin`. Each keeps only its newest dmg,
in PostgreSQL (migrations 0034, 0035 and 0038, `src/server/postgres/lab.js`) as rows of 4 MiB, so
neither an upload nor a download holds a whole dmg in memory. An upload replaces the previous one
in a single transaction. Any signed-in member may read them; row-level security lets only the
upload path write them. A download that an upload overtakes is cut off rather than finished with
the new dmg's bytes.

Locally, `npm start` runs no RUSH Lab of its own: a checkout's site connects the app installed on
this computer, as rush-lab.org does. To try a change to the runner or NanoAgent, build the app
(`npm run desktop`).

## Known gaps

- **Updates.** The app does not update itself; a member downloads a new dmg (FUTURE.md).
- **Signing out** of the site does not disconnect the relay. Its session is its own.
- **Windows** (FUTURE.md). There is no plugin sandbox, and NanoAgent runs each plugin's `run.sh`
  with `bash`.
- **One Mochi process.** Mochi keeps the connected computers in memory, as it does every other
  live connection (`src/server/fs/events.js`). Running several Mochi processes would need them
  relayed between processes.
