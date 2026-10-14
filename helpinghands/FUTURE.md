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

## Mochi Lab for Windows and Linux

Mochi Lab ships for macOS on Apple silicon only: `.github/workflows/helpinghands-desktop.yml`
builds just that bundle. The app's own code still knows the other two targets
(`desktop/scripts/stage.mjs` stages Node for `x86_64-pc-windows-msvc` and
`x86_64-unknown-linux-gnu`), so building them again means adding their matrix entries back
(`windows-latest`, and `ubuntu-22.04` with WebKitGTK installed) along with their bundle paths
(`msi`, `nsis`, `appimage`, `deb`).

To decide:

- Windows has no plugin sandbox yet, so the app refuses to start there, and NanoAgent runs each
  plugin's `run.sh` with `bash` (`desktop/PLAN.md`). Shipping it needs a sandbox, and a way to
  run plugins without bash.
- Linux sandboxes plugins with `bwrap`, so it is closer, but nobody has tested a bundle on a
  member's machine.
- Neither bundle is signed.
- The one-line install (`src/runner/install.sh`, `desktop/PLAN.md`) is for macOS only. Windows
  needs a plugin sandbox before it can be supported there too: lab.mjs, like the app, refuses to
  run plugins unconfined.

## Releasing Mochi Lab

Mochi Lab is not released yet. `.github/workflows/helpinghands-desktop.yml` builds it on every
push to production, or by hand, and keeps the dmg only as a workflow artifact of the private
repository, which members cannot download. NanoAgent ships in it compiled, not as source
(`desktop/PLAN.md`), so the bundle can be published.

To decide:

- Where members download it: GitHub Releases in a public repository that holds only the
  bundles, or a link Mochi serves to signed-in members.
- Auto-update: `tauri-plugin-updater` needs a public `latest.json` beside the bundles.
- Signing: the app is ad-hoc signed, so a downloaded copy opens only after right-click → Open.
- First check before release: open the app against the production Mochi it serves, sign in,
  see the relay connect, and run a plugin. Only its parts were tested before, not the app.
