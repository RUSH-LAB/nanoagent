# Changelog

What each Mochi release changes, one sentence each.

## Unreleased

- A plugin session's chat is a folder in your home, `Plugins/<plugin>/chats/<date> <title>/`, beside the plugin's `files/` its runs are given, with every turn in `chat.json` and each turn's provenance graph and ATIF trajectory (what the model saw and did, sent by NanoAgent as a `trajectory` event) beside it; the session follows the folder when you rename or move it, and the chats kept so far are moved there (migrations 0046, 0047).
- The Explorer shows your home first, as home, then the workspace's files, then what others shared from their homes as Shared with me, under their names.
- App records, chat and plugin blobs are kept under folders starting with a dot (`.apps/`, `.chat/`, `.plugins/`), which the Explorer, search and RUSH Lab's folder leave out, and each plugin's files are `Plugins/<plugin>/files/` in your home (migrations 0045, 0047); every member, viewers included, may edit and delete their own files there.
- A member's home is always private to them: another member writing into it first no longer makes it visible to the whole workspace, and homes made that way are private again (migration 0044).
- An outdated plugin, one whose version RUSH's NanoAgent no longer runs, opens on its own Dashboard instead of a notice: its sessions open to read, chat and results, through NanoAgent's view of its package (never installed), and Mochi starts no session or message with it until the member runs a version that runs.
- `npm run desktop:dev` builds, installs and opens RUSH Lab Dev on Windows as on macOS (an NSIS install for the user, the running one and every service it started quit first, whatever shell runs it), and `npm start` restarts the API when src/server changes, so the site is never served by an API older than the checkout.
- `npm run desktop:dev` installs RUSH Lab Dev, an app of its own beside RUSH Lab, built by the same code and steps and differing only in desktop/config.yaml's `dev` block (its name, lab.mochi.lab.dev, rushlab-dev:// links, ~/rushlab-dev/ and the rushlab-dev command), which serves only `npm start`'s site and never updates itself, while RUSH Lab serves only rush-lab.org, removing any connection an earlier build kept to another site.
- RUSH Lab puts the `rushlab` command in ~/.local/bin, rewritten at each start for the build installed, and its log says the line to add when that is not on your PATH; in whatever terminal you use, `rushlab new <id>` makes a plugin project in ./<id> with the publish-plugin skill as its AGENTS.md, CLAUDE.md and GEMINI.md, so any AI CLI on your computer (claude, codex, gemini, ...) designs a NanoAgent plugin with you, with no OpenRouter key, and `rushlab nanoagent ...` and `rushlab uv ...` run the app's own.
- RUSH Lab installs on Windows: the site offers its installer and a PowerShell command, `irm <site>/install.ps1 | iex`, which installs it and opens it, and it updates itself there as on macOS, waiting until nothing is running and its window is closed.
- RUSH Lab on macOS reloads its page with ⌘R (View → Reload).
- In a narrow window the navbar's menu lists the workspace's Plugins and Workspace above your account, spaced alike, and its header is no longer under the local site's banner.
- The navbar no longer shows a search bar, nor does `/` open search, until search has a real engine behind it (FUTURE.md).
- A marketplace plugin keeps its latest version and each version a member stays on, refusing a version not newer (PEP 440) than its latest; each member's install updates itself unless they turn off Auto-update in Settings → Plugins, the plugin's Dashboard shows its version, a link to its source on GitHub, and What's new and Update when a newer one is out, each answer in a session says the version it ran on, and the marketplace tells a plugin's author when GitHub has changes its latest version lacks.
- RUSH Lab ships NanoAgent as its source rather than compiled by Nuitka, since NanoAgent is open source.
- RUSH Lab updates itself to the build its site serves, opening it once nothing is running on the computer and its window is closed.
- Opening a link to a workspace you are not in no longer says the API server cannot be reached.
- A plugin install that RUSH Lab moved into a member's connection is built again where it is now, instead of failing with "Connection closed".
- New accounts start with arxiv-source and weather-alert installed (src/server/preinstalled-plugins.yaml).
- RUSH Lab installs once per computer account and connects each member separately, so several accounts can be connected from one laptop at once.
- The site opens only once RUSH Lab on your computer is connected, Settings → Connection shows whether it is, and `npm start`'s site installs RUSH Lab built from the checkout, beside rush-lab.org's, with keys from its own $10 OpenRouter workspace.
- Plugins are now installed by each user for themselves, and `npm start` runs on a local copy of production's database that `npm run db:pull` refreshes and `npm run db:push -- <slug>` sends one workspace of back.
