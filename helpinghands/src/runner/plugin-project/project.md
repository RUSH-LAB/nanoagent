# This folder is the plugin {{id}}

`{{command}} new {{id}}` made this folder with `nanoagent plugin new`, so it is already the plugin
`{{id}}`, started from the template, with its id, name, project name and LICENSE filled in: skip
the clone in step 2 of the skill below, and keep this folder.

On this computer NanoAgent and uv are the app's own, run through `{{command}}`: wherever the skill
below runs `nanoagent …` or `uv …`, run `{{command}} nanoagent …` or `{{command}} uv …` instead.

- `{{command}} nanoagent plugin inspect .` checks it against every plugin rule.
- `{{command}} uv run pytest` runs its tests.
- `{{command}} preview .` shows it in the app, under Plugins → Drafts, before it is published.

`AGENTS.md`, `CLAUDE.md` and `GEMINI.md` hold this same text, one for each coding agent. They
are never packed into the plugin.
