# Future

## Book and Blog as optional workspace features

Book and Blog are hidden for now: the navbar shows no Book or Blog item
(`src/theme/Navbar/Content/index.tsx`), and the command palette lists no
navigation entry inside a book or blog collection (`src/components/commands.js`).
Nothing else changed. A workspace's collections stay in its `workspace_settings`,
its pages still open by URL, and quick notes still save to its blog.

To decide:

- Where an owner turns Book and Blog on for a workspace, e.g. a Features section
  in workspace Settings.
- How it is stored. The existing per-workspace switch is
  `site.plugins.<name>.enabled` (`src/server/workspace-site.js`), which the
  server and client already check for plugins.
- What "off" means: only hidden from the navbar, or also its pages return 404,
  the book switcher (`src/theme/DocSidebar/Desktop/index.tsx`) is gone, and
  quick notes, feeds and search skip it.

Bringing back the navbar items: they are removed in the commit that added this
file, and `git show` on it restores the code.

## A search engine

The navbar's search pill is hidden for now, and so is the dialog it and the `/` key opened
(`components/SearchTrigger`, `components/SearchDialog`). Their code stays, as does the search
page (`/content-search`, also in the command palette). Today search is three requests
(`hooks/useContentSearch.js`): `/api/content/search` matches a document's path or title,
`/api/search` runs BM25 over the workspace's markdown, and `/api/references` the bibliography's
papers. We will need a real search engine before bringing it back.

To decide:

- What it searches: documents only, or also plugin sessions, apps, the marketplace and the
  files apps saved.
- Where the index lives and how it stays current as content changes, per workspace.
- Bringing back the pill: it is removed in the commit that added this section, and `git show` on
  it restores the code.

## A plugin run that resumes after Mochi Lab quits

A plugin run survives Mochi restarting and Mochi Lab's connection dropping for less than ten
minutes (`HOLD_MS`, `src/runner/protocol.js`): the relay holds the run, and Mochi takes it up
again (`src/server/app-runs.js`). When Mochi Lab itself quits, or the computer shuts down, the
run is gone with NanoAgent's process. The session records the message as interrupted, and the
member sends it again.

Resuming it would mean NanoAgent saving a run's state to disk after each step (each model call
and each tool call) and, when Mochi Lab starts again, going on from the last step it finished.
The relay would then list that run in its hello as it lists a held one now.

To decide:

- Whether runs get long enough to need it. Today's plugin tasks take seconds to a couple of
  minutes, so quitting mid-run is rare.
- The step that was in progress when Mochi Lab quit runs again, so every plugin tool has to be
  safe to run twice. That would be a new rule for every plugin.
- A model call that runs again is charged again.
- Where the saved state lives, when it is removed, and how long a run may wait for Mochi Lab to
  start again before it is recorded as interrupted.

## RUSH Lab for Windows

RUSH Lab, the app (`desktop/`), ships for macOS only, Apple silicon and Intel:
`.github/workflows/helpinghands-desktop.yml` builds those two dmgs. Linux is not planned.
`npm run build:windows` (in `desktop/`, on Windows) builds a per-user NSIS installer: plugins run
in an AppContainer (`nanoagent/docs/plans/windows-sandbox.md`), lab.mjs and lab.rs run there, and
the app's data folder is `%LOCALAPPDATA%\lab.mochi.lab`.

To decide:

- The window signs in through the member's browser, which needs rushlab:// to reach the running
  app on Windows too, and a random state without `/dev/urandom` (`main.rs`).
- CI builds no installer, and it is unsigned: SmartScreen warns on a downloaded one. Nor does it
  update itself: the site serves updates for the Macs only (`routes/lab.js`).
- Quitting kills lab.mjs and its services at once (`taskkill /T`), as Windows has no SIGTERM.

## Chat in RUSH Lab

The chat window docked to the bottom of every page (`src/components/CommandBar`) is hidden for
now, to keep the site simple while members publish and run plugins. Only its mount is off:
`SHOW_CHAT` in `src/theme/Root.js` is `false`, and `--site-cli-height` in `src/css/custom.css`
is `0px` so pages reserve no strip for it. Its code, the chat routes (`src/server/routes/chat.js`)
and their tables are unchanged. Plugins still run from their own pages (`src/components/PluginFrame`).

We may support chat again later. Bringing it back means setting `SHOW_CHAT` to `true` and
`--site-cli-height` back to `var(--site-cli-row)`.

To decide:

- What chat is for in RUSH Lab: talking to an agent about a workspace, running plugins from a
  conversation, or messaging other members in channels.
- Whether it is on for every workspace or one an owner turns on, as with Book and Blog above.
