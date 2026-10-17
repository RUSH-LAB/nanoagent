# Plan: a terminal in RUSH Lab, and plugin drafts

A member opens **Terminal** in RUSH Lab, starts a plugin project, and runs any AI CLI on their
laptop (`claude`, `codex`, `gemini`, ...) in it. The CLI reads the plugin skill on its own and
designs a NanoAgent plugin with them; no NanoAgent harness and no OpenRouter key are involved in
that chat. Then `rushlab preview` installs the folder on the member's own NanoAgent, and the
plugin opens in RUSH Lab's Plugins page as a **draft**, before anything is published. Publishing
stays what it is: a public GitHub repository, imported with `POST /api/market {url}`.

Two tracks build it at the same time in this worktree. Each owns its files outright (section 4);
they meet only at the hooks in section 3.

## 1. Track A: the terminal

### The window

- A terminal is a Tauri window of its own, labelled `terminal-<n>`, loading a page the app
  bundles (`WebviewUrl::App("terminal/index.html")`), never rush-lab.org. Tauri lets remote
  content reach no app command unless a `remote` capability names it (tauri 2.12
  `webview/mod.rs`), and the app gets an ACL manifest, so only the terminal windows' own bundled
  page can call the terminal's commands.
- It opens from:
  - the menu-bar menu: **New Terminal**, above Show Logs;
  - `rushlab://terminal`: from the site's navbar in the app's window (`on_navigation`), and from
    anywhere else through the deep link (`on_open_url`). It opens a window and runs nothing.
- Each window runs one shell. A window opened from the menu or the link starts in the projects
  folder; a project's window starts in the project. Its toolbar has **New plugin…** (asks for an
  id) and **Open project** (the projects there); each opens the project in a new terminal window,
  titled `<id> — RUSH Lab`, so nothing is ever typed into a shell already running.
- Closing a terminal window ends its shell (SIGHUP to its process group; on Windows the
  ConPTY child is killed). Quitting RUSH Lab ends every shell.
- RUSH Lab stays in the Dock while any terminal window is open (`set_activation_policy`), and
  updates itself only once no terminal window is open (`update.rs`), so an update never kills a
  member's AI session.

### The shell

- `portable-pty` spawns the member's login shell in a PTY, the one their passwd entry names
  (`libc::getpwuid`), as Terminal does; on Windows `powershell.exe -NoLogo` through ConPTY from
  the same crate. A login shell reads the member's profile, so its PATH finds their CLIs
  (Homebrew, nvm, npm's global bin).
- The launchers folder goes first on PATH once the profile has run: macOS's `/etc/zprofile` and
  `/etc/profile` rebuild PATH with `path_helper`, and the member's own files prepend more. zsh
  (`-l`) reads its files from `ZDOTDIR=<data>/terminal/shell/`, whose `.zshenv`, `.zprofile`,
  `.zshrc` and `.zlogin` each read the member's own of that name (from their `ZDOTDIR`, else
  home), and `.zlogin`, the last, prepends the launchers; bash runs `--rcfile
  <data>/terminal/shell/bashrc -i`, which reads what a login bash reads, then prepends them; fish
  runs `-l -C 'set -gx PATH …'`, after its config. Any other login shell is refused, saying so.
  On Windows the launchers folder is prepended before PowerShell starts.
- Its environment is the app's, plus `TERM=xterm-256color`, `COLORTERM=truecolor`,
  `TERM_PROGRAM=RUSH-Lab`, and `LANG=en_US.UTF-8` when unset, as Terminal sets one (an app opened
  from Finder has none). It gets no API key and nothing of a connection.
- PTY bytes go only between Rust and the bundled page: output through a Tauri `Channel`
  as raw bytes (`InvokeResponseBody::Raw`), input and resizes through commands. They never pass
  Mochi or the relay. What is typed goes through a channel to a writer thread of the session's,
  so a shell that reads nothing blocks only that thread, never the main thread or the sessions.
- xterm.js draws it (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`); a link,
  plain text or OSC 8 (`linkHandler`), opens in the browser (the window's `on_new_window`, as the
  main window's does).

### Launchers

Each terminal window opening rewrites `<data>/terminal/bin/` (mode 0755; `.cmd` files on
Windows) for the build installed now (`app/<stamp>/mochi-lab/`):

| Launcher | Runs |
|---|---|
| `nanoagent` | `<root>/nanoagent/.venv/bin/python -I -m nanoagent "$@"`, with `<root>/bin` first on its own PATH (so `nanoagent plugin new` finds the bundled `uv`) |
| `uv` | `<root>/bin/uv "$@"` |
| `rushlab` | `<root>/bin/node <root>/runner/lab.mjs rushlab "$@"` (Track B's subcommand) |

`<root>/bin` itself is not on the shell's PATH: its `node` would shadow the member's. A
launcher whose target is missing (lab.mjs has not made NanoAgent's `.venv` yet) says RUSH Lab is
still setting up and exits 1.

### Plugin projects

- Projects are `~/<projects_folder>/<id>/`, `projects_folder: rushlab-plugins` in
  `desktop/config.yaml`: outside the member's synced files (`~/rushlab/<login>/`), so `.venv`s and
  `.git` never sync to Mochi.
- **New plugin…** checks the id (`^[a-z0-9]+(-[a-z0-9]+)*$`), runs the `nanoagent` launcher's
  `plugin new <projects>/<id>` (template, `uv lock`), and writes the skill into the project as
  `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`, each the whole text, so each CLI reads its own. The
  text is a short preface (`desktop/terminal/project.md`: this folder is plugin `<id>`, made with
  `nanoagent plugin new`, so skip the clone in step 2; `nanoagent plugin inspect .` checks it;
  `rushlab preview .` shows it in RUSH Lab) followed by
  `docs/instructions/skills/publish-plugin/SKILL.md`, both bundled as `resources/terminal/`.
  What `plugin new` prints on failure (no `git config user.name`, no network for `uv lock`) is
  shown in the toolbar, and nothing is left behind.
- NanoAgent today refuses any top-level file outside the standard layout (manifest rule 7), so a
  project holding `AGENTS.md` would neither pack nor import. `AGENTS.md`, `CLAUDE.md` and
  `GEMINI.md` join `TOOL_ARTIFACTS` (`nanoagent/src/nanoagent/plugin/manifest.py`): allowed at
  the top level, never packed, never copied by `plugin new`. Mochi's NanoAgent must have this
  before a member imports a repository that commits them, so it ships in the same release.
- The skill's checklist (step 8) lists the three files as allowed, and gains a step between 8 and
  9: "See it in RUSH Lab: `rushlab preview .`".

### Rust, `desktop/src-tauri/src/terminal.rs`

State `Terminals { next: AtomicU32, windows: Mutex<HashMap<String, PathBuf>>, sessions:
Mutex<HashMap<u32, Session>> }`, `Session { window: String, typed: mpsc::Sender<Vec<u8>>, master,
pid: u32 }` on unix (the shell's process group, SIGHUP'd), `child: ChildKiller` instead on
Windows. A shell starting with no process id is ended and refused. Its session goes in under
the windows' lock, so a window closing while its shell starts ends that shell too.

Commands, each refusing a webview whose label is not `terminal-*`, and a session of another
window:

| Command | Does |
|---|---|
| `terminal_projects() -> Vec<{id, folder}>` | the projects folder's folders holding `nanoagent.yaml` |
| `terminal_new_project(id) -> {id, folder}` | creates it (above), then opens its window |
| `terminal_open_project(id)` | opens a window on an existing project |
| `terminal_start(cols, rows, output: Channel, exited: Channel<Option<u32>>) -> u32` | the window's shell; a reader thread sends output in chunks of up to 64 KiB, then the exit code |
| `terminal_write(id, data: String)` | bytes for the session's writer thread, in order |
| `terminal_resize(id, cols, rows)` | `master.resize` |

`pub fn open_window(app, folder: Option<PathBuf>) -> Result<(), String>`, `pub fn running(app) ->
bool` (any terminal window open), `pub fn close_all(app)`. A folder is used only when it
canonicalizes inside the projects folder; the shell starts in it as given, not canonical (on
Windows that is a verbatim `\\?\` path, which no shell starts in). Before RUSH Lab has installed its build
(`try_state::<Arc<Lab>>()` is none), every command says so.

`main.rs`: `mod terminal`, `.invoke_handler(generate_handler![...])`, the menu item,
`rushlab://terminal` routed before `connect_later` in both `on_navigation` and `on_open_url`,
`terminal::close_all` on `RunEvent::Exit`, the activation-policy rule above, and
`window.__RUSH_LAB_TERMINAL__ = true;` added to `IN_APP`. `lab.rs`: `pub fn root(&self) ->
&Path`, and `projects_folder` in `Config` (`pub fn projects_folder(app)`). `update.rs`:
`window_closed` is also false while `terminal::running`. `build.rs`:
`tauri_build::try_build(Attributes::new().app_manifest(AppManifest::new().commands(&[...])))`.
`capabilities/terminal.json`: `windows: ["terminal-*"]`, `permissions` the six commands'
`allow-*`, no `remote`.

### The page, `desktop/terminal/`

`index.html`, `terminal.js`, `terminal.css`, `project.md`. `scripts/stage.mjs` gains
`stageTerminal()`: esbuild bundles `terminal.js` with `@xterm/*` and `@tauri-apps/api/core`
into `desktop/dist/terminal/`, copies xterm's CSS beside it and `splash/index.html` to
`dist/index.html`; and `stageSkill()`: `project.md` and `SKILL.md` into `resources/terminal/`.
`tauri.conf.json`: `frontendDist: "../dist"`, the `resources/terminal/` resource, and a CSP for
the bundled pages only (`default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ipc:
http://ipc.localhost`). `desktop/package.json` gains the four packages and `esbuild` as
devDependencies; `desktop/.gitignore` gains `dist/`.

### The site

`src/utils/labApp.js`: `labAppHasTerminal = () => window.__RUSH_LAB_TERMINAL__ === true`.
`src/theme/Navbar/Content/index.tsx`: a **Terminal** link, `rushlab://terminal`, only when
`labAppHasTerminal()`, so a build without the terminal never shows it.

## 2. Track B: drafts

### `rushlab preview`

`lab.mjs rushlab <args>` (what the `rushlab` launcher runs; any other args print usage, exit 2;
it never starts the supervisor):

- `rushlab preview [folder] [--to <connection>]` (default `.`):
  1. picks the connection the draft is for (`previewConnection`): the one `--to` names, else the
     only one on this computer; with none, or several and no `--to`, it fails, listing them.
     Only that connection's NanoAgent installs the draft, and only its site hears of it.
  2. packs the folder with NanoAgent: `<root>/nanoagent/.venv/bin/python -I -m nanoagent plugin
     pack <folder> <tmp>`. A plugin breaking a rule fails here with every violation printed, and
     exit 1: the AI in the terminal reads them and fixes the code. Then `plugin inspect <folder>`
     gives its id, name and version.
  3. writes `<data>/drafts/<id>/package.tar.gz`, then `draft.json` `{id, name, version, folder,
     sha256, connection}` (each through a `.partial` and a rename; `draft.json` last).
  4. waits for the supervisor's `<data>/drafts/<id>/status.json` for that sha256, printing its
     state as it changes; exits 0 once it is installed ("Open RUSH Lab → Plugins → Drafts →
     <name>"), 1 when it failed (the install's error: a `uv sync` that failed, a 422's
     violations, its connection not running), or when no status came within 10 s (RUSH Lab is not
     running). It waits at most `DRAFT_INSTALL_MS` (25 min: NanoAgent's two syncs of up to 600 s
     each, and its inspection).
- `rushlab preview --stop <id>`: removes `<data>/drafts/<id>/`, refusing an id that is not a
  plugin id or has no draft.

### The supervisor (`lab.mjs main`)

- `draftSupervisor({data, connections, install, tellRelay, markBusy})`, whose `sync()`
  `watch()` calls every `WATCH_MS`, reads `<data>/drafts/`. A draft whose `folder` no longer
  exists is removed. Each draft whose sha256 its connection has not installed is installed on
  that connection's NanoAgent, one at a time per connection: `PUT /v1/installs/<sha256>` with the
  package, `Content-Type: application/gzip`, timeout `DRAFT_INSTALL_MS` (`nanoagentRequest`
  gains a timeout argument). A refusal is recorded as NanoAgent's status and body. Its state goes
  into `status.json`: `{sha256, state: "installing" | "installed" | "failed", error}`.
- `connection.drafts` (`Map<id, {sha256, name, version}>`) holds what is installed; it starts
  empty with each start of the connection, so a restarted NanoAgent gets each draft again (a
  finished install is kept on disk, so that takes no sync), and an install begun before is
  forgotten. After each change the relay is told `{"drafts": [{id, name, version, sha256}]}` on
  its stdin: never the folder.
- `busy` is also there while a draft installs.
- Exported for tests: `writeDraft`, `readDrafts`, `removeDraft`, `draftsToInstall`,
  `previewOutcome`, `draftSupervisor`, `rushlabCommand`, `previewConnection`, `rushlab`.

### The relay and the protocol

- `relay.mjs`: `supervisorKeys()` becomes `supervisor()`, also hearing `{drafts}` lines;
  `connect()` takes `drafts` and `onDrafts(listener)`, and says `hello` again whenever they
  change, as it does for keys.
- `protocol.js`: `hello` gains `drafts: [{id, name, version, sha256}]`. No route is
  added: Mochi reaches a draft only through the install routes it already has
  (`GET /v1/installs/<sha256>`, its `ui/`, its runs).

### Mochi

- `server/runner.js`: `draftList(value)` keeps at most 20 entries, each with a plugin id, a
  sha256, `name` and `version` of at most 100 and 64 characters; the rest is dropped. Each `hello` replaces `entry.drafts`. `runners.drafts(userId)`: the member's
  computer's drafts, or null when none is connected. Only that member's own requests ask it, so a
  draft is theirs alone.
- `server/workspace-apps.js`: `openDraft(context, id, on, drafts)`: the draft `id` of `drafts`
  (404 "No draft named <id> on your RUSH Lab"), its install on `on` by sha256 (404 there: "RUSH
  Lab has not installed this draft; run rushlab preview again"), as `{...plugin, source:
  "draft"}`.
- `server/routes/apps.js`: `GET /api/app-drafts` → `{drafts}` (503 `RUNNER_OFFLINE` with no
  computer); `GET /api/app-drafts/{id}` → `{app: {...openDraft, computer: <page>}}`. Both
  `content:read`, and reached as `/api/workspaces/{id}/app-drafts...` like `/app-installs`.
- `server/routes/ai.js`: `composeRequest` accepts `draft: true` only with `appId`; the stream
  opens the app with `openDraft` instead of `open` then, in a session with the draft. The run, its
  agent folder (`home/<user>/agent/<id>/`) and its metering are an app run's; its turn's
  `version` is null, as no marketplace version has its sha256.
- Sessions: `plugin_session.draft` (migration 0043). A draft's sessions are listed, started,
  read, archived and run at `/api/app-drafts/{id}/sessions...`, an installed plugin's at
  `/api/apps/{id}/sessions...`, and neither reaches the other's (`postgres/sessions.js` takes
  `draft` beside the plugin id), so a draft of a plugin the member installed keeps a history of
  its own.
- The Plugins page (`src/pages/apps/index.js`): `useWorkspaceDrafts(workspace)`
  (`src/hooks/useWorkspaceDrafts.js`) reads `app-drafts` fresh, and again whenever the window
  gains focus or becomes visible, so a draft shows up once the member comes back from the
  terminal. The sidebar has **Drafts on this computer** below the plugins; `?draft=<id>` opens
  `DraftDetail`, keyed by id and sha256 so each new preview opens again, which reads
  `app-drafts/<id>` and shows `PluginFrame`. With no computer connected the section is not
  shown; when the drafts cannot be read, it says why. In the app with a terminal (`labAppHasTerminal()`), the section links **Open
  Terminal** (`rushlab://terminal`). `pluginNavigation(apps, drafts, search, base)` gains
  `draft`, `requestedDraft` and `draftLinks`.
- `PluginFrame/host.js`: for `plugin.source === "draft"`, the sessions are the draft's,
  `prompt` sends `draft: true`, and `plugin.version` fails with "A draft runs from its folder:
  run rushlab preview again".
- The page kit (`nanoagent/src/nanoagent/plugin/page/kit/shell.js`): `versionControl` shows a
  draft as "Draft v<version>", and no Update.
- `src/pages/api-docs/index.js`: the two routes.

## 3. Hooks between the tracks

| Hook | Owner | Contract |
|---|---|---|
| `rushlab` launcher | A writes it | runs `node <root>/runner/lab.mjs rushlab "$@"` from the shell's cwd; B implements `rushlab` in `lab.mjs` |
| `rushlab://terminal` | A handles it | opens a terminal window; B only links to it |
| `labAppHasTerminal()` | A, `src/utils/labApp.js` | true only in a build that handles `rushlab://terminal`; B imports it |
| The skill's preview step | A edits `SKILL.md` and `project.md` | names `rushlab preview .` and what it prints, as section 2 has it |
| `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` in a plugin | A, `manifest.py` | never packed, so a draft's sha256 does not change with them |

Until both land, A tests `rushlab` by the usage it prints, and B runs `node lab.mjs rushlab
preview <folder>` from an installed build's `runner/`.

## 4. Files

Track A (terminal):

- `helpinghands/desktop/src-tauri/src/terminal.rs` (new), `main.rs`, `lab.rs`, `update.rs`
- `helpinghands/desktop/src-tauri/build.rs`, `Cargo.toml` (`portable-pty`), `Cargo.lock`,
  `tauri.conf.json`, `capabilities/terminal.json` (new)
- `helpinghands/desktop/terminal/` (new), `scripts/stage.mjs`, `config.yaml`, `package.json`,
  `package-lock.json`, `.gitignore`, `PLAN.md` (a Terminal section, and Drafts once B lands)
- `helpinghands/src/theme/Navbar/Content/index.tsx`, `helpinghands/src/utils/labApp.js`
- `nanoagent/src/nanoagent/plugin/manifest.py`, `nanoagent/README.md`, `nanoagent/test/test_plugin.py`
- `docs/instructions/skills/publish-plugin/SKILL.md`

Track B (drafts):

- `helpinghands/src/runner/lab.mjs`, `relay.mjs`, `protocol.js`
- `helpinghands/src/server/runner.js`, `workspace-apps.js`, `routes/apps.js`, `routes/ai.js`,
  `app-runs.js`, `postgres/sessions.js`, `postgres/migrations/0043_plugin_session_draft.sql` (new)
- `helpinghands/src/hooks/useWorkspaceDrafts.js` (new), `src/pages/apps/index.js`,
  `src/components/PluginSidebar/index.js`, `navigation.js`,
  `src/components/PluginFrame/host.js`, `src/pages/api-docs/index.js`
- `nanoagent/src/nanoagent/plugin/page/kit/shell.js`
- the tests in section 5 under `helpinghands/tests/unit/`

`helpinghands/CHANGELOG.md` and `nanoagent/CHANGELOG.md` each gained their entries once the two
were merged.

## 5. Tests

Track A:

- `cargo test` in `desktop/src-tauri`, `terminal.rs`'s own tests: an id is checked; a folder
  outside the projects folder, through `..` or a symlink, is refused; each launcher's text names
  the installed root, quoted (`Application Support` has a space); the three skill files are the
  preface with the id filled in and the whole skill; in a real zsh and bash in a PTY whose
  profile puts another `nanoagent` first, `command -v nanoagent` finds the launcher; a login
  shell but zsh, bash or fish is refused.
- `nanoagent/test/test_plugin.py`: a plugin holding `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`
  loads, and its package (`pack`, and `pack_source` from a source archive) holds none of them;
  `plugin new` copies none.
- In the app (`npm start`, then `npm run desktop:dev`): New Terminal opens a window whose shell
  finds the member's `claude`, `codex` or `gemini`, and `nanoagent`, `uv` and `rushlab`; New
  plugin… makes `~/rushlab-plugins/<id>/` with the three files, and `nanoagent plugin inspect .`
  passes there; the navbar's Terminal opens one; a link printed in the terminal opens in the
  browser; closing the window ends its shell (`ps`); an update waits while a terminal is open.

Track B:

- `tests/unit/runner/lab.test.mjs`: `writeDraft` then `readDrafts`; `draftsToInstall` installs a
  new or changed sha256 and nothing installed already; `previewOutcome` for installing,
  installed, failed, and another sha256's status; a draft whose folder is gone is removed; the
  supervisor installs a draft on its own connection alone, busy while it does, tells the relay
  no folder, records NanoAgent's refusal, retries only once previewed again, skips a package
  changed since its draft.json was read, keeps nothing of an install that ends after its
  connection restarted, and says a draft failed while its connection is not running; `rushlab`'s
  arguments, usage with exit 2, `--stop` refusing an invalid or unknown id, and the connection a
  preview is for.
- `tests/unit/server/plugin-sessions.test.mjs`: a draft's sessions and an installed plugin's of
  the same id are listed, read, archived and run apart.
- `tests/unit/server/runner.test.mjs`: a `hello` with drafts gives `runners.drafts(userId)`,
  malformed entries dropped, the next `hello` replacing them, null once the computer is gone;
  `connect()` says `hello` again when `onDrafts` hears a change.
- `tests/unit/server/workspace-apps.test.mjs`: `openDraft` found, unknown, not installed.
- `tests/unit/server/routes/apps.test.mjs`: `app-drafts` offline (503), listed, opened with the
  computer's page id, unknown (404); a draft's sessions apart from the installed plugin's.
- `tests/unit/server/routes/ai.test.mjs`: `appId` with `draft: true` runs on the draft's sha256,
  in a draft session only; `draft` without `appId`, or not `true`, is refused.
- `tests/unit/src/components/plugin-navigation.test.mjs`: drafts in the navigation, `?draft=`.
- `tests/unit/src/components/plugin-frame.test.mjs`: a draft's sessions are the draft's, its
  prompt carries `draft: true`; `plugin.version` is refused.
- In the app: `rushlab preview .` in a project prints the violations of a broken plugin and exits
  1; of a fixed one, installs it and exits 0; the Plugins page, focused again, lists it under
  Drafts; it opens, its Dashboard says Draft, and a prompt in its Session runs a task with a
  verdict; `rushlab preview --stop <id>` removes it.

## 6. Done

1. Both tracks' tests pass (`npm test`, `cargo test`, `uv run pytest`, `uv run ruff check .`).
2. The desktop app is rebuilt with both (`npm run desktop:dev`) and checked end to end: Terminal,
   New plugin…, an AI CLI designs the plugin from `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`,
   `rushlab preview .`, the draft runs on the Plugins page, then `gh repo create <id> --public
   --source . --push` and Publish a plugin with its URL.
3. `desktop/PLAN.md`, the CHANGELOGs, and one devmode release with Mochi and NanoAgent together.
