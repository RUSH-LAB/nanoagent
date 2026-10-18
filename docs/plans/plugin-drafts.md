# Plan: the RUSH Lab command, and plugin drafts

A member runs any AI CLI on their laptop (`claude`, `codex`, `gemini`, ...) in whatever terminal
app they already use. `rushlab new <id>` starts a plugin project there; the CLI reads the plugin
skill on its own and designs a NanoAgent plugin with them; no NanoAgent harness and no OpenRouter
key are involved in that chat. Then `rushlab preview` installs the folder on the member's own
NanoAgent, and the plugin opens in RUSH Lab's Plugins page as a **draft**, before anything is
published. Publishing stays what it is: a public GitHub repository, imported with
`POST /api/market {url}`.

## 1. The command

- `desktop/config.yaml` names it: `command: rushlab` for RUSH Lab, `command: rushlab-dev` in the
  `dev` block for RUSH Lab Dev, so the two apps never clash. `scripts/stage.mjs` bundles it in
  `config.json` with the rest; `server/lab-app.js` refuses a config with no `command` or one that
  is not `^[a-z][a-z0-9-]*$`, and `releaseApp()`/`servedApp()` return it.
- At each start lab.mjs (`installCommand`, not awaited, so NanoAgent never waits on it) writes
  `~/.local/bin/<command>` (on Windows `%USERPROFILE%\.local\bin\<command>.cmd`), through a
  `.partial` and a rename, mode 0755 (`commandLauncher`): it checks the installed build's
  `bin/node` is there, saying to open the app if not (exit 1), then runs it on that build's
  `runner/lab.mjs rushlab "$@"`, every path quoted (`Application Support` has a space).
- It then reads the member's PATH: on macOS their login shell's (`$SHELL -ilc`, 15 s), as the
  app's own is launchd's and never has `~/.local/bin`; on Windows this process's. When
  `~/.local/bin` is not on it, the log says so and gives the line to add (`pathAdvice`):
  `~/.zshrc` for zsh, `~/.bash_profile` for bash, `fish_add_path` for fish, a PowerShell
  `SetEnvironmentVariable` on Windows. The command is never put anywhere else. When the file
  cannot be written or the PATH cannot be read, the log says that, and the app goes on starting.
- Its subcommands (`rushlabCommand`; anything else prints the usage and exits 2):

| Subcommand | Does |
|---|---|
| `new <id>` | `newPlugin`: checks the id (`^[a-z0-9]+(-[a-z0-9]+)*$`), refuses `./<id>` when it exists, runs the bundled `nanoagent plugin new ./<id>` (template, `uv lock`), then writes `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`, each `runner/plugin-project/project.md` with `{{id}}` and `{{command}}` filled in, then the publish-plugin skill. On failure it removes the partial folder and says why (what `plugin new` printed, or its exit status) |
| `preview [folder] [--to <connection>]`, `preview --stop <id>` | section 2 |
| `nanoagent <args>` | `<root>/nanoagent/.venv/bin/python -I -m nanoagent <args>`, with `<root>/bin` and the bundled git first on its own PATH (so `plugin new` finds the bundled uv, and git on a Mac without Command Line Tools) |
| `uv <args>` | `<root>/bin/uv <args>` |

- `project.md` (`helpinghands/src/runner/plugin-project/`, copied with the runner) says the folder
  is plugin `<id>`, made by `plugin new`, so skip the clone in step 2; to run `<command>
  nanoagent ...` and `<command> uv ...` instead of bare `nanoagent` and `uv`; and that `<command>
  nanoagent plugin inspect .`, `<command> uv run pytest` and `<command> preview .` check it, test
  it and show it in the app. `stageRunner()` copies
  `docs/instructions/skills/publish-plugin/SKILL.md` beside it, as `runner/plugin-project/SKILL.md`.
- Projects live wherever the member makes them. NanoAgent refused any top-level file outside the
  standard layout (manifest rule 7), so `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` joined
  `TOOL_ARTIFACTS` (`nanoagent/src/nanoagent/plugin/manifest.py`): allowed at the top level,
  never packed, never copied by `plugin new`. Mochi's NanoAgent ships it in the same release.
- The skill's checklist (step 8) lists the three files as allowed, and step 9, "See it in RUSH
  Lab", runs `rushlab preview .` in the member's terminal.

## 2. Drafts

### `rushlab preview`

`lab.mjs rushlab <args>` (what the command runs; it never starts the supervisor):

- `rushlab preview [folder] [--to <connection>]` (default `.`):
  1. picks the connection the draft is for (`previewConnection`): the one `--to` names, else the
     only one on this computer; with none, or several and no `--to`, it fails, listing them.
     Only that connection's NanoAgent installs the draft, and only its site hears of it.
  2. packs the folder with NanoAgent: `<root>/nanoagent/.venv/bin/python -I -m nanoagent plugin
     pack <folder> <tmp>`. A plugin breaking a rule fails here with every violation printed, and
     exit 1: the AI CLI reads them and fixes the code. Then `plugin inspect <folder>`
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
  `previewOutcome`, `draftSupervisor`, `rushlabCommand`, `previewConnection`, `rushlab`, and section
  1's `commandLauncher`, `onPath`, `pathAdvice`, `installCommand`, `bundledCommand`, `newPlugin`.

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
- Sessions: `plugin_session.draft` (migration 0044). A draft's sessions are listed, started,
  read, archived and run at `/api/app-drafts/{id}/sessions...`, an installed plugin's at
  `/api/apps/{id}/sessions...`, and neither reaches the other's (`postgres/sessions.js` takes
  `draft` beside the plugin id), so a draft of a plugin the member installed keeps a history of
  its own.
- The Plugins page (`src/pages/apps/index.js`): `useWorkspaceDrafts(workspace)`
  (`src/hooks/useWorkspaceDrafts.js`) reads `app-drafts` fresh, and again whenever the window
  gains focus or becomes visible, so a draft shows up once the member comes back from their
  terminal. The sidebar has **Drafts on this computer** below the plugins; `?draft=<id>` opens
  `DraftDetail`, keyed by id and sha256 so each new preview opens again, which reads
  `app-drafts/<id>` and shows `PluginFrame`. With no computer connected the section is not
  shown; when the drafts cannot be read, it says why. Below the drafts it says how to make one:
  `<command> new my-plugin`, an AI CLI in `my-plugin`, `<command> preview .`, with the command
  from `useLabCommand()` (`src/utils/labApp.js`, `customFields.labCommand`, the served app's
  `command` from `server/lab-app.js`), and the line that puts `~/.local/bin` on PATH on macOS and
  on Windows, the same as lab.mjs logs for zsh and PowerShell. `pluginNavigation(apps, drafts,
  search, base)` gains `draft`, `requestedDraft` and `draftLinks`.
- `PluginFrame/host.js`: for `plugin.source === "draft"`, the sessions are the draft's,
  `prompt` sends `draft: true`, and `plugin.version` fails with "A draft runs from its folder:
  run rushlab preview again".
- The page kit (`nanoagent/src/nanoagent/plugin/page/kit/shell.js`): `versionControl` shows a
  draft as "Draft v<version>", and no Update.
- `src/pages/api-docs/index.js`: the two routes.

## 3. How the parts meet

| Hook | Contract |
|---|---|
| `config.command` | `desktop/config.yaml`; lab.mjs names the launcher and its messages by it, `server/lab-app.js` hands the served app's to the site (`customFields.labCommand`) |
| `runner/plugin-project/` | `project.md` lives in `src/runner/plugin-project/`; `stage.mjs` adds `SKILL.md` beside it; `newPlugin` reads both from the installed build |
| `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` in a plugin | `manifest.py`: never packed, so a draft's sha256 does not change with them |

## 4. Files

The command:

- `helpinghands/desktop/config.yaml`, `scripts/stage.mjs`, `PLAN.md`
- `helpinghands/src/runner/lab.mjs`, `src/runner/plugin-project/project.md`
- `helpinghands/src/server/lab-app.js`, `docusaurus.config.js`, `src/utils/labApp.js`
- `nanoagent/src/nanoagent/plugin/manifest.py`, `nanoagent/README.md`, `nanoagent/test/test_plugin.py`
- `docs/instructions/skills/publish-plugin/SKILL.md`

Drafts:

- `helpinghands/src/runner/lab.mjs`, `relay.mjs`, `protocol.js`
- `helpinghands/src/server/runner.js`, `workspace-apps.js`, `routes/apps.js`, `routes/ai.js`,
  `app-runs.js`, `postgres/sessions.js`, `postgres/migrations/0044_plugin_session_draft.sql` (new)
- `helpinghands/src/hooks/useWorkspaceDrafts.js` (new), `src/pages/apps/index.js`,
  `src/components/PluginSidebar/index.js`, `navigation.js`,
  `src/components/PluginFrame/host.js`, `src/pages/api-docs/index.js`
- `nanoagent/src/nanoagent/plugin/page/kit/shell.js`
- the tests in section 5 under `helpinghands/tests/unit/`

`helpinghands/CHANGELOG.md` and `nanoagent/CHANGELOG.md` each have their entries.

## 5. Tests

The command:

- `tests/unit/runner/lab.test.mjs`: usage, exit 2, named by the command; the arguments of `new`,
  `nanoagent` and `uv`, and those refused; the sh launcher's exact text, quoting a path with a
  space and an apostrophe, run for real (arguments with spaces stay whole; exit 1 once the build's
  node is gone); the Windows `.cmd`'s text and path; `onPath` and `pathAdvice` for zsh, bash,
  fish, another shell and PowerShell; `installCommand` writing 0755, replacing an older one, and
  logging each case (on PATH, not on it, PATH unreadable); `bundledCommand`'s PATH (and Windows'
  `Path`); `newPlugin` refusing a bad id and an existing folder, writing the three files with the
  id and command filled in, removing a partial folder with `plugin new`'s error or exit status,
  and failing on a missing skill before making anything.
- `tests/unit/server/lab-app.test.mjs`: the real config's `rushlab` and `rushlab-dev`; no
  `command`, and one that is not a command name, refused.
- `tests/unit/desktop/config.test.mjs`: the `dev` block overrides `command` with another value.
- `nanoagent/test/test_plugin.py`: a plugin holding `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`
  loads, and its package (`pack`, and `pack_source` from a source archive) holds none of them;
  `plugin new` copies none.
- In the app (`npm start`, then `npm run desktop:dev`): the log says `~/.local/bin/rushlab-dev`
  was written and whether the member's PATH has it; in Terminal, `rushlab-dev new <id>` makes
  `./<id>` with the three files, and `rushlab-dev nanoagent plugin inspect .` passes there.

Drafts:
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

1. The tests pass (`npm test`, `cargo test`, `uv run pytest`, `uv run ruff check .`).
2. The desktop app is rebuilt (`npm run desktop:dev`) and checked end to end: in the member's own
   terminal, `rushlab-dev new <id>`, an AI CLI designs the plugin from
   `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, `rushlab-dev preview .`, the draft runs on the Plugins
   page, then `gh repo create <id> --public --source . --push` and Publish a plugin with its URL.
3. `desktop/PLAN.md`, the CHANGELOGs, and one devmode release with Mochi and NanoAgent together.
