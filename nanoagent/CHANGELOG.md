# Changelog

What each NanoAgent release changes for plugins. Since 0.7.0 a plugin declares the plugin format it
follows, its `spec`, and runs on every release that runs that spec (`nanoagent.plugin.manifest.SPECS`).

## 0.7.0

A plugin declares the spec it follows, not the NanoAgent it was made for: `spec:
nanoagent.plugin/v0001` in `nanoagent.yaml` replaces `nanoagent: ~=0.6.0`, and its files name the
spec's classes, `nanoagent.plugin.v0001.*` for `nanoagent.plugin.manifest.*`. Each spec is a
folder of its own, `nanoagent/plugin/v0001/`, holding its rules (the contract's, the verifier's
and a decide task's among them), its classes and the page its plugins are shown in (`page/`,
`index.html` and the UI kit), and importing nothing of NanoAgent's but
`nanoagent.plugin.manifest`. A released spec's folder never changes but to close a security hole:
a change a plugin could break on is the next folder, `v0002`, and NanoAgent keeps running the
last for at least three minor releases. `nanoagent plugin migrate <folder>` moves a plugin made
for 0.6 or earlier onto `nanoagent.plugin/v0001` (and deletes a 0.5 plugin's `run.sh`). Publish it again for RUSH's
marketplace to offer it: a version published before 0.7.0 is listed under maintenance.

- `nanoagent.plugin/v0001` is 0.6.0's plugin rules less the template's. Every v0001 plugin still has a
  `LICENSE`, but the rules that follow what `nanoagent plugin new` writes (what `LICENSE`,
  `README.md`, `pyproject.toml` and `.gitignore` hold, nothing else at the top level, `tests/`, a
  ready plugin's product page not the template's placeholder) are checked only by `nanoagent
  plugin new`, `inspect` and `pack` (`nanoagent.plugin.authoring.check_plugin`), never when a
  plugin is installed, its package inspected (`POST /v1/packages/inspect`) or its tools called.
- A catalog entry's `spec` is the plugin's own.
- `load_listing` and `PluginListing` are gone.
- `PUT /v1/views/<sha256>` opens a package for its page alone, loading and running none of it, so
  a package NanoAgent refuses still shows its page at `/v1/installs/<sha256>/ui/...`: its spec's
  page, or the newest spec's when NanoAgent does not run its spec. The page kit
  reads a plugin the host says is `status: refused` as closed: its Dashboard lists and opens its
  sessions, which show their chat and results, and starts none, and no message can be sent.
- A plugin chat's run records its provenance graph (`nanoagent.plugin.provenance`): every model
  request of the chat's loop (what it thought and wrote, streamed, and its tokens, cost and
  timing), each task it called with the task's own run inside it (its reference tool, model
  requests, tool calls, decisions and verifier), and the values between them, joined only by what
  the run recorded: used, generated, continued (a request carried on the one before it), and for
  a decide task, each field copied or chosen. `run_task` sends its graph as `task.graph` patches
  as it is made, and the web run (`GraphRunner`) folds them into the turn's graph, which streams
  as `graph` patches and ends with the whole graph, kept with the session's turn. The page kit
  draws it live in a Graph tab beside the chat, the task results in a Result tab, and each node
  in full when picked: a tool call with the arguments and output only it has, a task as a box
  folded to its totals (model requests, tool calls, tokens, cost, time) once it is done, and the
  turn's totals over the graph. Tool and task calls record how long they took, and a decision
  the model requests that made it (`Answers.model_calls`). Each node's `type`
  (`nanoagent.plugin.provenance.NodeType`) is the message of the loop it is (system prompt, user
  message, agent reply with its thinking and text, tool call, tool result, agent message) or a
  task's own (task input, reference, decision, task output, verifier, verdict), and the page tags
  each node with it; the chat's and each agent task's system prompt are the first nodes their
  first reply used. A decide `Question` names the field it fills, `path`.
- Every type of node is a part of the run registered in `nanoagent.plugin.provenance.PARTS`, a
  `Part` each: its name, whether it is a call (an action) or a value, and for a value the types of
  call that make it, which the graph enforces on each `generated` edge. Every node carries its
  part's name, `typeLabel`. What a reply thought and wrote are parts of their own, `thinking` and
  `text` values it generated, streamed as `append` patches to their `value`; the last reply's text
  is the agent's response (`agent_message`, named Response), and an agent reply no longer holds
  `reasoning` and `text`.
- The chat shows each turn as its agent loop, a row per part named by its part: `User message ›`,
  `Thinking ›`, `Text ›`, `Tool call ›`, `Tool result ›`, `Response ›`, and inside a task's run,
  indented under its call, `Task input ›`, `Reference output ›`, `Decision ›`, `Task output ›` and
  `Verdict ›` (kit/loop.js). A row holds its part on one line and opens to all of it; the user's
  message, a reply's text and the response show whole, as Markdown. The rows come from the turn's
  graph as it streams in; a task's run is open while it runs or when it failed, folded once it
  passed, and its result row has Open result, which draws the result beside the chat. The session's
  system prompt shows in its first turn. Under the turn, its line says what it ran on, cost and
  took, as a kept turn's does too (the host keeps each turn's `metrics`), and Graph draws its
  graph. In the graph, a task is shown by its name, a reply's card holds its thinking and text, a
  finished one from the start, and tokens read `13.9k tokens in, 1.3k out`.
- The page opens on the session its host names (`describe`'s `session`), and tells the host the
  session it shows, or null on the Dashboard (`session.shown {id}`). RUSH keeps it in the
  Plugins page's address (`?session=`), so reloading the window opens the session again.

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
