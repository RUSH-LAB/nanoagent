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
- CI builds no installer, and it is unsigned: SmartScreen warns on a downloaded one.
- Quitting kills lab.mjs and its services at once (`taskkill /T`), as Windows has no SIGTERM.

## RUSH Lab updates

The app does not update itself: a member downloads a new dmg from the site. `tauri-plugin-updater`
could fetch a `latest.json` and signed update from Mochi, which already serves the dmgs
(`routes/lab.js`), with a member's session.

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

## RUSH Lab cloud, past its first runner

RUSH Lab cloud (docs/infra/aws-deployment.md) runs members' plugins on one runner VM: NanoAgent
in a locked-down container, each plugin under bubblewrap. Its plugin runs end when Mochi restarts,
and it runs everyone's on the lab's key.

To decide:

- A microVM per run (Firecracker, or a managed sandbox such as `nanoagent/docs/plans/plugin-sandbox.md`
  option 2), so a kernel exploit escapes into one run's VM rather than the runner's.
- Limits per run: a cgroup for each plugin's memory and processes, so a plugin cannot hold the
  runner's limits from other members' plugins for the length of its run, as it can today.
- Writing back what an interrupted cloud run left in its folder, as a computer's is, once
  `plugin_run.folder` is recorded (`app-runs.js` passes `setRunFolder` the wrong shape).
- More than one runner: runs, installs and plugin pages addressed by install, so a run and its
  page reach the runner that has its plugin installed.
- Whether a cloud run outlives Mochi restarting, as a computer's held run does: NanoAgent would keep
  a run going without its HTTP stream, and Mochi take it up again by id.
- NanoAgent running a plugin's lock check and its input and output verifiers off its event loop
  (`plugin/runtime.py`, `plugin/verifier.py`), so a slow plugin does not delay other members' runs.
- Members' own keys in the cloud, which Mochi would have to keep, encrypted.
- `/health` saying which sandbox NanoAgent confines plugins with, so Mochi refuses `CLOUD_RUNS`
  beside one that does not, rather than relying on its deployment.
