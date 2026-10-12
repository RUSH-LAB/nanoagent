# Mochi Lab desktop app (Tauri 2)

A native app that runs the whole Mochi stack on this machine, the Mochi server (site and API
on one origin) and NanoAgent, in a Tauri window. Same code and data path as production; nothing
in the product is rewritten.

## Use

```bash
cd helpinghands
npm run desktop  # build the release app (src-tauri/target/release/bundle/{macos,dmg}/) and open it
```

Live development uses `npm start` in the browser. The desktop app is always the release build.

Needs Node 22, Rust, and Mochi's own `npm install` (the site build and the server's traced
dependencies come from it). The app needs nothing installed where it runs.

On first launch the app asks for its settings: Mochi's `.env` (PostgreSQL, GitHub sign-in, mail,
`BETTER_AUTH_SECRET`, `OPENROUTER_API_KEY`). They are saved, mode 0600, at
`~/Library/Application Support/lab.mochi.desktop/settings.env`.

## Architecture

```text
Mochi Lab.app
├── MacOS/mochi-lab-desktop       Tauri shell: src-tauri/src/{main,supervisor}.rs
├── MacOS/node, MacOS/uv          bundled runtimes (sidecars)
└── Resources/
    ├── mochi/                    server, plugins, site built for http://localhost:47310,
    │                             and only the node_modules files the server loads (27 MB)
    ├── nanoagent/                sources, uv.lock, plugins, the PI runner (trimmed the same way)
    ├── config.yaml               ports and runtime versions (desktop/config.yaml)
    └── stamp                     names this staging
```

`scripts/stage.mjs` produces the resources and downloads the runtimes (checksums verified)
before every `tauri build`.

At launch the supervisor:

1. Shows setup if there is no `settings.env`.
2. Refuses if port 47310 or 47311 is in use.
3. Installs this staging once into `Application Support/lab.mochi.desktop/app/<stamp>/`, because
   both services write beside their code (Mochi's `var/`, NanoAgent's `.venv` and plugin
   environments). It moves `var/` over from the previous installation and removes that one.
4. Runs `uv sync --locked --extra web --managed-python --python 3.12` (the first launch
   downloads Python).
5. Starts NanoAgent on 127.0.0.1:47311 and waits until its default profile is available.
6. Starts the Mochi server with `NODE_ENV=production MOCHI_DESKTOP=1` and waits for `/api/health`.
7. Opens the window on `http://localhost:47310`, with `window.__MOCHI_RUNTIME_CONFIG__` set so the
   client calls its own origin.

Each service gets the settings plus a few system variables, and PATH puts the bundled `node`
and `uv` first. Logs go to `Application Support/lab.mochi.desktop/logs/`. A failure at any step,
or a service exiting later, stops the rest and shows the reason and log tail on the splash,
with Retry and Replace settings. Quitting sends SIGTERM to Mochi, then NanoAgent, and SIGKILL
after 10 s. Links that open a new window open in the system browser.

### Server: desktop mode

`MOCHI_DESKTOP=1` (in `src/server/auth.js` and `src/server/index.js`) replaces the production
HTTPS `SITE_URL` requirement with exactly `http://localhost:<EDITOR_PORT>`, and binds the server to
127.0.0.1. Every other production check stays.

### Sign-in

GitHub is the only sign-in. The app's callback is
`http://localhost:47310/api/auth/callback/github`. GitHub accepts it with the local OAuth app
registered for `localhost:3000`, because GitHub treats loopback callback ports as
interchangeable. Verified by signing in.

## Status

| Phase | State |
|---|---|
| 1. Shell and supervisor | Done |
| 2. Server desktop mode | Done, with tests in `tests/unit/server/auth.test.mjs` |
| 3. Self-contained bundle | Done. `.app` 182 MB, `.dmg` 63 MB. Verified on macOS arm64: setup screen, first launch in 14 s, GitHub sign-in, workspace and plugin apps |
| 4. Settings | First-run settings screen and `settings.env` (0600). Not done: Keychain storage |
| 5. Distribution | `.github/workflows/helpinghands-desktop.yml` builds, signs, and notarizes. Needs the Apple secrets listed in it; never run yet. Not done: auto-update |
| 6. Windows / Linux | Staging, the supervisor, and the CI matrix handle both. Never built or run on either |

## Known gaps

- **Auto-update.** `tauri-plugin-updater` fetches a public `latest.json`, and this repository is
  private. It needs a public release location first.
- **Signing.** There is no Developer ID certificate on the development machine, so local builds are
  unsigned. They run on the machine that built them; on other Macs, Gatekeeper blocks them until
  they are signed and notarized in CI.
- **Windows.** NanoAgent runs each plugin's `run.sh` with `bash`, which Windows does not have. On
  Windows, quitting kills the services rather than stopping them cleanly.
- **Offline.** It needs Neon over the network. Fully offline would mean PGlite in desktop mode,
  which is a separate project.
- **Who can use it.** The user supplies the stack's credentials, so this is for you and trusted
  developers. For outside users, never ship them; point a window at the hosted site instead.
