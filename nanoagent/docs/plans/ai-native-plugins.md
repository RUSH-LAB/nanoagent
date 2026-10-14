# Plan: AI-native plugins (NanoAgent 0.4.0)

Every plugin is the same page: a chat. A person says what they need; the plugin's agent turns it
into one of the plugin's tasks, with that task's structured input; the task runs the verified
way and returns its typed output, which the page draws. A plugin no longer designs a page.

## 1. Every task has a typed output

- `contract.py`: `TASKS = {Task.X: (InputClass, OutputClass)}`, like `TOOLS`.
- A `runner: tool` task's output class is its tool's output class.
- A `runner: agent` task's agent ends by calling `submit`, a tool NanoAgent adds whose input is
  the task's output class: NanoAgent builds the value into the class, and the last `submit`
  is the task's output. A run with no `submit` fails. No plugin tool is named `submit`.
- A `runner: decide` task (0.5.0) has its model only decide: NanoAgent calls the task's tools and
  builds the output, every value an Enum or bool the model chose, or one of exactly its type
  copied from the task's input or an earlier tool output.
- `verify_task(task, arguments, output, reference, workspace)`: the verifier judges the output.
- Every runner emits `task.result {response}` with the output; the catalog entry's tasks carry
  `output` (the class name) and `outputSchema`.

## 2. The chat works through tasks only

A prompt to an app runs an agent whose tools are the plugin's tasks, one tool per task (named by
its id, with its input schema). Calling one runs the task the verified way (`run_task`:
reference, tool or agent, `verify_task`) in the chat's workspace and returns
`{"output": ..., "verdict": {...}}`. The agent then answers in a sentence or two; the page draws
the output. The plugin's tools are used only inside its tasks, and the chat has no other tools.
The model cost of an agent task's own agent counts in the chat's cost.

## 3. One page, drawn from the output's type

The kit's chat is every plugin's Session page, with the results beside it: a task call shows in
the chat as a chip, and its result card on the right:
the output drawn from its JSON Schema (an object as labelled fields, a list of objects as a
table, a list of strings as a list, text, numbers, yes/no), with the verdict as a badge.

`ui/` holds `renderers.js` and `renderers.css`, and the static files they import.
`renderers.js`'s default export maps output class names to `(value, {task, verdict, send}) =>
Element`, for an output the generic view draws poorly (a board, a paper list); `{}` when
there are none. NanoAgent refuses a plugin whose `ui/` holds `app.js` or `app.css`, and the kit
refuses a renderer named for a class no task outputs.

## 4. Build

1. NanoAgent: the contract, manifest and task runner (output types, `submit`, `verify_task`),
   the chat agent over tasks with the cost carried up, the template, tests.
2. The kit: the standard chat page, the schema view, renderers; the rule for `ui/`.
3. The five plugins, each in its own folder: task outputs, verifiers judging them, renderers.
4. Remove what no page uses any more (the designed-page components, the bridge's `runTask`),
   the docs, CHANGELOG, and NanoAgent 0.4.0.
