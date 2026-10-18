# Changelog

What each Mochi release changes, one sentence each.

## Unreleased

- `npm run desktop:dev` installs RUSH Lab Dev, an app of its own beside RUSH Lab, built by the same code and steps and differing only in desktop/config.yaml's `dev` block (its name, lab.mochi.lab.dev, rushlab-dev:// links, ~/rushlab-dev/ and ~/rushlab-dev-plugins/), which serves only `npm start`'s site and never updates itself, while RUSH Lab serves only rush-lab.org, removing any connection an earlier build kept to another site.
- RUSH Lab has a terminal (menu bar → New Terminal, or Terminal in the navbar), a window of the app's own running your login shell, where New plugin… starts a plugin project in ~/rushlab-plugins/ with the publish-plugin skill as its AGENTS.md, CLAUDE.md and GEMINI.md, so any AI CLI on your computer (claude, codex, gemini, ...) designs a NanoAgent plugin with you, with no OpenRouter key.
- `rushlab preview .` in the terminal installs the plugin in that folder on your RUSH Lab as a draft, for the one account connected there or the one `--to` names, which Plugins lists under Drafts on this computer and opens as it would once published, with sessions of its own (migration 0044), and `rushlab preview --stop <id>` removes it.
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
