# Changelog

What each NanoAgent release changes for plugins. A plugin's `nanoagent` range in `nanoagent.yaml`
names the releases it runs on; a new minor version is one a plugin made for the last may break on.

## 0.4.0

Plugins are AI native: every plugin's page is NanoAgent's chat, in which the plugin's agent runs
its tasks and the page shows each task's typed output (docs/plans/ai-native-plugins.md). A plugin
declares `nanoagent: ~=0.4.0` and:

- `contract.py` gives every task an output class: `TASKS = {Task.X: (InputClass, OutputClass)}`.
  A `runner: tool` task's classes are its tool's.
- A `runner: agent` task's agent ends by calling `submit` with the task's output, a tool
  NanoAgent adds; a plugin removes any tool of its own that only handed the agent's answer over,
  and names no tool `submit`.
- `verify_task(task, arguments, output, reference, workspace)` judges the task's output.
- `ui/` holds `renderers.js` (its default export: renderers by output class name, `{}` for none)
  and `renderers.css`, instead of a page: delete `ui/app.js` and `ui/app.css`.
- A task is what a person asks for in a chat: its description and its input fields'
  descriptions are what the chat's model reads to choose it and fill it in.
- `nanoagent plugin run` and `agent` write the task's output to `result.json`.

## 0.3.0

A plugin declares `nanoagent: ~=0.3.0` and its page follows the new `ui/` rules:

- `nanoagent.yaml` names the NanoAgent versions the plugin runs on, `nanoagent`, a PEP 440 range.
- `ui/` holds `app.css` as well as `app.js`.
- `ui/app.js` exports the page's layout as its default export.
- Every script in `ui/` imports only literal `./` or `../` paths that NanoAgent serves: the kit's
  modules (`./kit/components.js`) or the plugin's own files in `ui/`.
- `ui/index.html` and `ui/kit/` are refused. NanoAgent serves its own, so a plugin deletes them.
