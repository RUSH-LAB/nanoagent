# RUSH Lab on macOS, Windows and Linux

What we found running RUSH Lab (the Tauri desktop app in `desktop/`) on Windows 11 against the devmode code, and what differs between the three systems. Windows was run end to end. macOS is described from the code and from the Mac app we already had; it was not run in this pass. Linux was not run and is not built.

## Status

| | macOS | Windows | Linux |
|---|---|---|---|
| Desktop app | Built and used | Built by CI (NSIS installer, `.github/workflows/helpinghands-desktop.yml`) and run | No build |
| Install command | `curl -fsSL <site>/install.sh \| sh` | `irm <site>/install.ps1 \| iex`, run twice by CI on each build | None |
| Web view | WKWebView | WebView2 | Not applicable yet |
| Fresh install, sign-in, connect | Used | Passed: install in 6 s, sign in, connect | Not tested |
| Plugin run (NanoAgent) | Used | Passes after the path fixes below | Not tested |
| Page dialogs | Fixed in shared site code, not run | Fixed and checked in the app | Not tested |
| Self-update | Not re-tested | Built (the installer is the update), not yet run | Not tested |
| Sandbox file-write tasks | Not re-tested | Not tested | Not tested |

## What broke on Windows, and the fix

### 1. Windows opens at most 260 characters of a path

`LongPathsEnabled` is 0 on a default Windows install, so Python `open()` fails on any path longer than 260 characters. Two things produced such paths:

- **Installed plugins.** NanoAgent installs each plugin under `installs/<sha256>/<plugin>/.venv`. uv's editable install writes an `__editable__*.pth` file inside that tree, and with the full 64-character hash the path went over the limit. The plugin then died with `McpError: Connection closed` or `No module named plugin`.
  - Fix: `nanoagent/src/nanoagent/plugin/install.py` keeps a 128-bit prefix of the hash (`FOLDER_HEX = 32`) instead of all of it.
- **The relay's installs folder.** On Windows the folder sat inside the connection's folder under `%LOCALAPPDATA%\lab.mochi.lab\connections\<id>`, which is already long.
  - Fix: `installsFolder()` in `src/runner/lab.mjs` puts a Windows connection's plugins in `<data>\installs\<12 hex of a hash of the connection id>`. macOS and Linux keep `<connection>/nanoagent-installs`.

Tests: `tests/unit/runner/lab.test.mjs` covers `installsFolder`; `nanoagent/test/test_web_plugins.py` uses `FOLDER_HEX`.

Deleting a tree that deep fails in Explorer and in most shells. Use `node -e "fs.rmSync(path,{recursive:true,force:true})"`.

Left open: nothing removes `<data>\installs\<hash>` when a connection is removed, so those folders are orphaned.

### 2. Page dialogs were refused, and every confirm said yes

Tauri's dialog plugin replaces `window.alert` and `window.confirm` in the web view. The app grants the site no permission for them, so a call failed with `Command plugin:dialog|message not allowed by ACL`. Its `confirm` also returns a Promise, and `if (!confirm(...)) return` treats a Promise as true. So "Leave workspace", "Empty trash" and deleting a document would have gone ahead without asking. This comes from reading the plugin's code; it was not run. Because the site code is shared, it applied to the Mac app too.

- Fix: the site draws its own alert, confirm and prompt as a modal `<dialog>` (`src/platform/dialogs.js`, `dialogs.module.css`). Every call goes through `clientPlatform.dialogs` (`src/platform/client.js`) and is awaited. A platform with no dialog of its own rejects with `This platform has no <method> dialog`.
- Guard: `tests/unit/src/dialogs.test.mjs` fails if any file in `src` or `plugins` calls the browser's own `alert`, `confirm` or `prompt`.
- Checked in the Windows app: Trash → Empty opens the dialog; Cancel and Escape close it and leave the trash alone. The prompt path was checked in headless Edge only.
- No app rebuild was needed: the site is served remotely, and `main.rs` uses Rust-side dialogs, which need no permission.

## Differences to keep in mind

- **Web view.** macOS uses WKWebView, Windows uses WebView2 (Chromium). WKWebView has no `window.prompt`, which is one more reason the site must not use the browser's dialogs. WebView2 reloads on Ctrl+R by itself; macOS needed View → Reload (⌘R) added to its menu (commit `bf5b6ca0`).
- **Installer.** macOS installs into /Applications (`npm run desktop:dev`). Windows builds an NSIS installer, which installs for the user into `%LOCALAPPDATA%\RUSH Lab`; `install.ps1` runs it with `/S /R` (silent, then open RUSH Lab). Launching the raw exe fails: it exits with "could not be installed… Access is denied" when the bundled binaries are missing or an old runner still holds the folder. Install through NSIS and kill any orphaned runner first.
- **Self-update.** On macOS the update is installed over the running app, which opens it when it next quits. On Windows the updater runs the installer, which quits the app at once, so `src-tauri/src/update.rs` downloads the update first and installs it only once nothing runs and the window is closed. The installer then opens RUSH Lab with `--login`, hidden as at login.
- **Sandbox.** The Windows runner sandboxes plugins in an AppContainer; macOS uses its own sandbox. File-write behaviour under the AppContainer has not been tested.
- **Data folder.** Windows keeps connections under `%LOCALAPPDATA%\lab.mochi.lab\connections\<id>`.
- **Shell.** Developers on Windows use Git Bash or PowerShell. `npm test` with a quoted glob finds 0 tests there; run `node --test tests/**/*.test.mjs` from bash with globstar on.

## Local-development gotchas found on Windows

- A stale, git-ignored `nanoagent/uv.lock` (from an older dependency set) made `uv sync --locked` fail on startup. Fix: `uv lock`.
- `npm start` can fail once with "Connection terminated due to connection timeout" while the local PostgreSQL cluster starts. A restart worked.
- The test suite has 21 failures on Windows that also occur on a clean checkout (path and symlink assumptions). None were added by these changes.

## Linux

Not built, not run. Before claiming support, check: the Tauri build (WebKitGTK web view, so no `prompt` of its own, as on macOS), the runner sandbox, and the data folder location.

## Open items

- Run the checklist in `tasks/windows-verify.md` (repo root) on a Windows PC.

- Clean up `<data>\installs\<hash>` when a connection is removed.
- Run a self-update on Windows, and test sandbox file-write tasks there.
- `weather-alert` is no longer preinstalled; its upstream `run.sh` problem is still with its author.
- `arxiv-source` was republished at 0.5.1 in the local database only. Production needs NanoAgent deployed before it can be published there.
- Run the dialog check on the Mac app.
