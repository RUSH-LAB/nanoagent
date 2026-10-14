# Mochi Lab desktop app (Tauri 2)

A native app that lends this computer to its member's AI on the hosted Mochi. Its window shows the
hosted site. Behind the window it runs NanoAgent with the member's own OpenRouter key, and a relay
that connects that NanoAgent to Mochi. When the member picks Settings → AI → **My computer** on
Mochi, their assistant and app runs (model calls and plugin code) run here instead of on
Mochi's servers. They are not charged to the workspace's AI budget.

## Use

```bash
cd helpinghands
npm run desktop  # build the release app (src-tauri/target/release/bundle/{macos,dmg}/) and open it
```

Needs Node 22, Rust, a C compiler (Xcode's command line tools), and NanoAgent's checkout beside `helpinghands/`. The app needs nothing
installed where it runs.

On first launch the window shows Mochi's device page (`/device?client=desktop`). The member
signs in with GitHub there and approves this computer. That one sign-in gives the window its session cookie and the relay its token. The
token is kept at `runner-credentials.json` (0600) beside the settings. With no API key yet,
the window then opens Settings → AI on the site.

API keys are set in the site's Settings → AI → API keys, or on the app's own API Keys page
(`splash/keys.html`, Mochi Lab → API Keys…, ⌘,). Either lists one row per provider: OpenRouter,
Anthropic, OpenAI, Google Gemini, DeepSeek, and others. From the site, a key travels down the
relay's socket (`{type: 'keys'}`, runner/protocol.js) to the relay, which hands it to the
supervisor on its stdout and hears the answer on its stdin; Mochi passes it on and keeps nothing. The supervisor saves each
key, mode 0600, at `~/Library/Application Support/lab.mochi.desktop/settings.env`; it is never
shown again, and the site sees only which keys are set. Saving hands the keys to the running
NanoAgent (`PUT /v1/keys`, which only the supervisor's token reaches) and nothing restarts: the
next run, and the next model list, use them. NanoAgent gets these keys and nothing else of the settings, and
the hosted site can never reach the app's own key commands. Settings → AI lists every model the
keys reach.

## How a run reaches this computer

```text
browser ──► Mochi (hosted) ──WebSocket /api/runner──► relay ──► NanoAgent 127.0.0.1:47311 ──► OpenRouter
```

Mochi cannot reach a laptop, so the relay (`src/runner/relay.mjs`) dials Mochi. It signs in with
a bearer token from the device grant, client `mochi-desktop`. Mochi's side is
`src/server/runner.js`:
- The upgrade is refused if it carries an `Origin` header, or if it is authenticated only by a
  cookie. Otherwise a web page could register itself as a member's computer.
- Each member has one computer; a new one replaces the old.
- Every NanoAgent call for the member goes down that socket (`aiFor`): runs, plugin installs and
  plugin pages. While no computer is connected, they fail with "Mochi Lab on your computer is not
  connected". They do not fall back to Mochi's servers.
- A plugin page's frame carries no session, so its address names the computer by its
  connection's random `page` id.

The frames are in `src/runner/protocol.js`. The relay passes on only what these need: runs,
installs and their pages, and run folders' files. Only the marketplace's packages stay on Mochi's
NanoAgent.

NanoAgent's token is random for each launch, and only the relay holds it. Plugins run in this
platform's sandbox (`nanoagent.plugin.sandbox`):
- macOS: `seatbelt`, via `sandbox-exec`. Each plugin can read the system and its own folder, can
  write only its run's folder, and can reach the network only through its own egress proxy port.
  It cannot see other processes, or their environments.
- Linux: `bwrap`.
- Windows: no sandbox exists yet, so the app refuses to start there.

## Architecture

```text
Mochi Lab.app
├── MacOS/mochi-lab-desktop       Tauri shell: src-tauri/src/{main,supervisor}.rs
├── MacOS/node, MacOS/uv          bundled runtimes (sidecars)
└── Resources/
    ├── runner/                   the relay and its protocol (src/runner/)
    ├── nanoagent/                NanoAgent compiled by Nuitka (site/), its uv.lock, the PI runner's bundle, its config
    ├── config.yaml               the Mochi it serves, NanoAgent's port, runtime versions
    └── stamp                     names this staging
```

`scripts/stage.mjs` produces the resources and downloads the runtimes (checksums verified)
before every `tauri build`.
NanoAgent ships compiled, not as source: Nuitka builds its package into one module
(`--mode=package`, NanoAgent's `compile` extra) for Python 3.12, with the files it reads beside it.
Its open-source dependencies are installed from the bundled uv.lock, and the PI runner ships as its
two bundled files. Its strings can still be read out of the module, so it holds nothing secret.

At launch the supervisor:

1. Installs this staging once into `Application Support/lab.mochi.desktop/app/<stamp>/`, and
   removes older installations.
2. Refuses to start if port 47311 is in use, or if this platform has no sandbox; runs `uv sync --frozen --no-install-project --extra web --managed-python --python 3.12`, NanoAgent's
   dependencies, and adds the compiled module to that environment (`nanoagent.pth`). The first launch
   downloads Python.
3. Starts NanoAgent on 127.0.0.1:47311 with the sandbox, a fresh token, the keys (none yet, on a first launch), and
   `run_models=true`, so each run may name its own model and settings (Settings → AI). It then
   waits until NanoAgent's default profile is available.
4. Starts the relay. When the relay needs signing in, the window shows its device page. The
   supervisor waits until the relay is connected.
5. Navigates the window to `site_url`, or its Settings → AI with no key yet.

Each service gets only the system variables it needs. NanoAgent also gets the settings. PATH puts
the bundled `node` and `uv` first. Logs go to `Application Support/lab.mochi.desktop/logs/`.

A failure at any step, or a service exiting later, stops the rest. The splash then shows the
reason and the log tail, with Retry and API keys. A second Mochi Lab signing in as the
same member is one such exit. Quitting sends SIGTERM to the relay, then NanoAgent, and SIGKILL
after 10 s. Links that open a new window open in the system browser.

## Without the window (one-line install)

A member who uses Mochi in the browser can run Mochi Lab with no window at all. While their computer
is not connected, Settings → AI shows **Run AI on your Mac**: one command to paste in Terminal, which
installs Mochi Lab to run in the background and then opens a sign-in page. The server's half is
`src/server/routes/lab.js`:

- `GET /api/lab/install` (signed in) answers `{command}`:
  `curl -fsSL '<SITE_URL>/api/lab/install.sh?token=<t>' | sh`. The token is the member's for an hour,
  `<user id, base64url>.<expiry, unix seconds>.<HMAC-SHA256, base64url>`, signed with a key derived
  from `BETTER_AUTH_SECRET` (`src/server/lab-tokens.js`). Mochi keeps nothing of it.
- `GET /api/lab/install.sh?token=<t>` answers `src/runner/install.sh`, read at each request, with
  `__MOCHI_SITE__` and `__MOCHI_TOKEN__` replaced by the site and the token. A bad or expired token
  answers 401 with a script that says so and exits 1.
- `GET /api/lab/bundles/<target>?token=<t>`, or with a session, streams the target's bundle, a gzip
  tarball, with `X-Lab-Stamp`, `X-Lab-Sha256` and `Content-Length`; 404 while there is none.
- `PUT /api/lab/bundles/<target>`, with `Authorization: Bearer <LAB_UPLOAD_TOKEN>` and
  `X-Lab-Stamp`, is how a release uploads one: the raw tarball, 200 MB at most. It answers
  `{target, stamp, sha256, size}`. Without `LAB_UPLOAD_TOKEN` set, it answers 503.

The targets are `aarch64-apple-darwin` and `x86_64-apple-darwin`. Each keeps only its newest bundle,
in PostgreSQL (migration 0034, `src/server/postgres/lab.js`) as rows of 4 MiB, so neither an upload
nor a download holds a whole bundle in memory. An upload replaces the previous one in a single
transaction. Any signed-in member may read the bundles; row-level security lets only the upload path
write them. A download that an upload overtakes is cut off rather than finished with the new
bundle's bytes.

### This computer's half

`npm run bundle:lab` here (`scripts/bundle-lab.mjs`, with `TAURI_ENV_TARGET_TRIPLE` set) stages as
the app's build does (`scripts/stage.mjs`) and writes `dist/mochi-lab-<target>.tar.gz`. It builds
only on a Mac of the target's architecture, because Nuitka compiles NanoAgent for the machine it
runs on. CI builds both targets on their own runners on every push to production
(`.github/workflows/helpinghands-desktop.yml`, job `lab`) and uploads each with the `PUT` above,
retrying for 15 minutes while the site deploys. The tarball's one folder:

```text
mochi-lab/
├── stamp           names this bundle (stage.mjs's)
├── config.json     config.yaml, as JSON
├── bin/node, bin/uv
├── runner/         src/runner/: lab.mjs, the relay and what it loads
└── nanoagent/      NanoAgent compiled, its uv.lock, the PI runner's bundle, its config
```

`src/runner/install.sh` checks the download against `X-Lab-Sha256`, unpacks it into
`~/Library/Application Support/lab.mochi.lab/app/<stamp>/`, points `app/current` at it, and removes
older versions. It then writes `~/Library/LaunchAgents/lab.mochi.lab.plist`, which runs
`app/current/mochi-lab/bin/node app/current/mochi-lab/runner/lab.mjs` at every login, and loads it
with `launchctl bootstrap gui/<uid>`. Running the command again installs the newest bundle.

`src/runner/lab.mjs` does what the app's supervisor does, without the window. It refuses any
platform but macOS, and starts with `uv sync`, then NanoAgent with the seatbelt sandbox, a fresh
token and the keys, then the relay. Each service gets the same environment as under the app, and its
data folder is `lab.mochi.lab`: `settings.env`, `runner-credentials.json`, `logs/` and NanoAgent's
folders. Its own log is `logs/lab.log`. When the relay needs signing in, it opens the device page in
the browser and logs its address. Once connected after that, it opens the site, at Settings → AI
while there is no key. Keys come only from Settings → AI, through the relay; there is no keys page.
When either service exits, it stops the other, the relay first, and exits 1, and launchd starts it
again after 30 s. A relay replaced by another computer signing in as the same member exits cleanly,
and so does lab.mjs: launchd restarts only a failure (`KeepAlive.SuccessfulExit`), so two computers
do not take the runs back and forth. SIGTERM, from `launchctl bootout`, stops both and exits 0.

To uninstall: `launchctl bootout gui/$(id -u)/lab.mochi.lab`, then
`rm -rf ~/Library/LaunchAgents/lab.mochi.lab.plist ~/Library/Application\ Support/lab.mochi.lab`.

## Known gaps

- **Signing out** of the site in the window does not disconnect the relay. Its session is its
  own.
- **Auto-update.** `tauri-plugin-updater` fetches a public `latest.json`, and this repository is
  private. It needs a public release location first.
- **Signing.** The macOS app is ad-hoc signed, not notarized (no Apple Developer ID). Built on the
  Mac it runs on, it opens as is; downloaded, it opens after right-click → Open.
- **Windows.** There is no plugin sandbox, and NanoAgent runs each plugin's `run.sh` with `bash`.
- **One Mochi process.** Mochi keeps the connected computers in memory, as it does every other
  live connection (`src/server/fs/events.js`). Running several Mochi processes would need them
  relayed between processes.
