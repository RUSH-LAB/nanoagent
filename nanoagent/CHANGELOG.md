# Changelog

What each NanoAgent release changes for plugins. A plugin's `nanoagent` range in `nanoagent.yaml`
names the releases it runs on; a new minor version is one a plugin made for the last may break on.

## 0.6.0

A plugin no longer ships a `run.sh`: before a plugin starts, NanoAgent itself checks that uv is
installed, that every variable `.env` names is set and that `uv.lock` matches `pyproject.toml`.
A plugin declares `nanoagent: ~=0.6.0` and deletes its `run.sh`, which NanoAgent now refuses as
an unexpected file. Publish it again for Mochi's marketplace to offer it: a version published for
0.5.0 is listed under maintenance.

## 0.5.0

A task may declare `runner: decide`: a model only decides, and NanoAgent calls the task's tools
and builds its output. A plugin declares `nanoagent: ~=0.5.0`, and follows the stricter rules
listed under "Every plugin" below.

NanoAgent ships no plugin. arxiv-source, bibtex-check, meal-suggestion and nasdaq-drawdown moved
out to their own repositories (`github.com/zeyuyang8/mochi-<id>`), and Mochi's marketplace
publishes them from there; the Railway service offers no package (`packages: []`).

- A decide task fills every tool argument and every output field by choice or by copy: an Enum
  or bool field is chosen, and any other field is copied from a value of exactly its type in the
  task's input or an earlier output of one of the task's tools, never the reference tool's. A
  list of choices is a choice of several; a list of objects with no ready-made one is built item
  by item. NanoAgent refuses a decide task with a field it cannot fill that way, so a value a
  decide task needs that is computed, such as a total, is one a tool returns.
- Each request asks the model a batch of questions, the answer held to their options by a JSON
  Schema (Bedrock's forced tool choice, an OpenAI-compatible provider's `response_format`). A
  slot with only one option is copied with no question.
- Every batch is a `task.decision {questions, answers, probabilities, forced}` event.
- A decide run keeps to `max_steps` requests, `cost_limit` and `token_limit`, and refuses
  `thinking_level`, before its first request.
- `nanoagent plugin agent` runs decide tasks too; its `messages.json` holds the decider's
  requests, each answered by one `answer` call.
- `nanoagent plugin agent` runs a model on OpenRouter too: its config is a
  `PluginOpenRouterAgentConfig`, whose `llm` is a `nanoagent.llm.openrouter.OpenRouterConfig`.

Every plugin:

- `runtime.command` is `[uv, run, --frozen, python, -m, plugin]`; `nanoagent` is one minor
  version, `~=X.Y.0`; `version` is a PEP 440 version, the same as `pyproject.toml`'s.
- Tools are named in snake_case and tasks in kebab-case; every input class's name ends in
  `Input` and every output class's in `Output`.
- `pyproject.toml` keeps the template's `requires-python`, dependencies and `slimconfig` source,
  and bounds every other dependency both ways (`>=X,<Y`).
- `.env` lines are a `NAME` alone, with no `=`; `ui/` holds no `.html`.
- `README.md`'s `## Tools` names every task as well as every tool, and a `ready` plugin's
  `product.yaml` holds none of the template's placeholder text.
- `renderers.js`'s default export is an object literal keyed only by task output classes,
  checked when the plugin loads. Its scripts name no page, host or network global
  (`UI_GLOBALS`) and reach for none of `UI_PROPERTIES` (`.ownerDocument`, `.parentNode`,
  `.host`, ...): the kit draws each renderer's output in a closed shadow root of its own, the
  only place `renderers.css` applies.
- The Session page has two columns: the chat, with a chip for each task call, and the picked
  task's result beside it.
- The Dashboard archives a session: it moves to an Archived view, where it can be opened or
  restored, and comes back when it is chatted in again (the bridge's `session.archive`).
- A run outlives its page, a Mochi restart, and Mochi Lab's connection dropping for less than ten
  minutes: a session left, reloaded or closed mid-answer goes on answering, its Dashboard row
  says "Answering…", and opened again it shows the message being answered to its end (the
  bridge's `follow`, and `running` on a resumed session). A message that is not answered (it
  failed, was stopped, or Mochi Lab quit or was away longer) stays in the session with why
  (a turn's `error`).
- The kit keeps only what renderers use: `card`, `banner`, `meter`, `pretty`, `formatSize` and
  `kit/workspace.js` (`listFiles`, `readFile`, `readText`, `readJSON`) are gone, and so are the
  bridge's `runTask`, `session.save` and `workspace.*` and the task-run endpoint
  (`POST /v1/workspaces/<ws>/installs/<sha256>/tasks/<task>/runs`): tasks run through the chat.
- `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`, a coding agent's instructions, may sit anywhere in a
  plugin and are never packed (`TOOL_ARTIFACTS`), so a plugin made with `rushlab new` packs and
  imports with them.
- The Dashboard of a draft, a plugin RUSH Lab installed from its folder (`rushlab preview`), says
  "Draft v<version>", and has no Update.

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
