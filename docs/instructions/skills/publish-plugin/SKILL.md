---
name: publish-plugin
description: Build a NanoAgent plugin from the reference plugin, zeyuyang8/arxiv-source, and publish it on RUSH Lab. Use when someone wants to make, finish, check, or publish ("submit") a NanoAgent plugin, or when RUSH Lab refuses a plugin they submitted.
---

# Build and publish a NanoAgent plugin

A NanoAgent plugin packages one checkable job: typed tools served over MCP,
tasks built from those tools, a deterministic verifier, and a product page.
RUSH Lab lists published plugins. Each member's Mochi Lab desktop app runs
them on that member's own computer.

The reference plugin is https://github.com/zeyuyang8/arxiv-source, a full
plugin with network access, five tasks and one verifier module per tool.
Start from it. When unsure how a piece should look, read the matching file
in it. Do not guess.

## Ground rules

- **The verifier is deterministic code and decides every case.** Never use a
  model to check a result. If code cannot decide whether a result is
  correct, the task does not belong in the plugin. Change the task.
- **Rules go in code, judgment goes to the model.** If a value follows from
  rules, a tool computes it. The model only chooses: which tool comes next,
  an Enum or bool member, or an existing value of exactly the right type.
- **No fallbacks.** A tool that cannot do its job raises an error. It never
  returns a made-up or partial value.
- **Ask before anything public.** Get the person's go-ahead before you
  create a GitHub repository, make one public, or push. The person submits
  on RUSH Lab themselves, in their browser.

## 1. Agree on the task

Before writing code, settle these with the person:

- What the plugin does, in one sentence.
- Its tools, each with a typed input and a typed output.
- Its tasks, and each task's `runner`:
  - `tool`: calls one tool, with no model.
  - `agent`: an LLM loop over the task's tools that ends by calling
    `submit` with the task's output.
  - `decide`: the model only chooses. NanoAgent then calls the tools and
    builds every value.
- How code decides that each output is correct, case by case. Write out the
  checks for correct, wrong, missing, malformed and boundary outputs.
- Whether the task has a `reference`: a tool outside the task's tools that
  NanoAgent runs first, out of the model's sight. Its output becomes the
  ground truth for `verify_task`.
- The network hosts the plugin must reach, if any.

If any check needs a judgment that code cannot make, redesign the task now.

## 2. Start from the reference plugin

Prerequisites are Git, Python 3.12 or later, and `uv`. Replace `<id>` with
the plugin's id. It must be kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`) and not
already taken on the RUSH Lab marketplace, so pick a distinctive one.

```bash
git clone https://github.com/zeyuyang8/arxiv-source.git <id>
cd <id>
rm -rf .git && git init
uv sync --extra dev
uv run pytest
```

Its tests pass before you change anything. Then replace its tools, tasks,
verifier, tests and product page with the person's own, keeping the package
structure.

Rename the plugin in all of these places together:

- `nanoagent.yaml`: `id` and `name`.
- `README.md`: the title, `# <name>`.
- `pyproject.toml`: the project name, `nanoagent-<id>`.
- `LICENSE`: keep the MIT text, and replace the year and copyright holder
  with the person's.

Set `status: in-development` until the plugin is finished.

## 3. Declare the types: `contract.py`

The contract holds declarations only:

- `Tool` and `Task` Enums. Tool names are snake_case. Task ids are
  kebab-case.
- slimconfig `Output` dataclasses. Input class names end in `Input` and
  output class names end in `Output`. Describe every field with
  `Annotated[T, "description"]`.
- The tables `TOOLS = {Tool.X: (XInput, XOutput)}` and
  `TASKS = {Task.Y: (YInput, YOutput)}`.

Use Enums and `bool`s for anything that is a choice. Do not put
`from __future__ import annotations`, functions, logic, or imports outside
the reference plugin's in this file.

## 4. Write the tools: `src/plugin/`

Put one module per tool. Each tool is `(input, workspace: Path) -> output`,
takes and returns its contract classes, raises on failure, and writes only
inside `workspace`. Register each tool in `IMPLEMENTATIONS` in
`src/plugin/__main__.py`.

Add a new dependency to `pyproject.toml` with both an upper and a lower
bound, such as `"httpx>=0.27,<1"`. Keep the template's `requires-python`,
its dependencies and its `slimconfig` source unchanged.

## 5. Write the manifest: `nanoagent.yaml`

- `version` is PEP 440 and matches `pyproject.toml`'s `version`.
- `nanoagent: ~=0.5.0` is the one NanoAgent minor version the plugin runs on.
- `runtime.command` is exactly `[uv, run, --frozen, python, -m, plugin]`.
- `permissions.network.hosts` lists bare hostnames only (no scheme, port or
  path), and only the ones the plugin needs. `filesystem.write` is
  `[workspace]`.
- `tools` has one entry per `Tool`, each with a `description`.
- `tasks` has one entry per `Task`, each with `description`, `runner`,
  `tools`, `reference` (a tool name, or `null`) and `instructions`.
  - A `tool` task names exactly one tool, and its classes are that tool's.
  - No tool is named `submit`.
  - A `decide` task must be able to fill every field by a choice or a copy.
    It may never copy from the reference tool's output.

Follow slimconfig's rules: the file keeps its class headers (such as
`_ > nanoagent.plugin.manifest.ManifestConfig:`), sets every field, and adds
no other field.

## 6. Write the verifier and its tests

`verifier/__init__.py` defines these three functions:

- `verify_input(tool, value)`, run on every tool call.
- `verify_output(tool, input_value, output_value, workspace)`, run on every
  tool call.
- `verify_task(task, arguments, output, reference, workspace)`, run once on
  the task's output.

Each function returns `{valid, score (0 to 1), message, details}`. Use
`result()` from the reference plugin's `verifier/checks.py`. Each check tests what a
value means, never its shape, because the shape is already checked. Put one
module per tool, and import sibling modules relatively
(`from .checks import result`).

The verifier is sandboxed and is run twice, and the two verdicts must match.
It may:

- import only pure standard-library modules (such as `re`, `json`, `math`,
  `hashlib`, `pathlib`, `dataclasses`, `enum`, `collections`, `itertools`,
  `statistics`, `decimal` and `fractions`), plus `contract` and its own
  package;
- not use the clock, randomness, environment variables, the network,
  subprocesses, `open`, `eval`, `exec`, `getattr`, private attributes, or
  file writes. To read a workspace file, use `Path(...).read_text()`;
- hold only `.py` files in `verifier/`.

`tests/test_verifier.py` must exist. Test correct, wrong, missing, malformed
and boundary results, not only the correct one. Build values the way the
sandbox does, with `build_output(plain_output(...), Class)`.

## 7. Finish the front end

- `ui/renderers.js` and `ui/renderers.css`. Outputs are drawn from their
  JSON Schema unless the default export of `renderers.js` draws them. That
  export is an object literal keyed only by task output class names. To use
  the schema drawing, make `renderers.js` hold only `export default {};` and empty `renderers.css`. In a renderer:
  - Import only by literal relative paths, to the kit or to your own
    `ui/` files.
  - Never name `document`, `window`, `fetch`, `globalThis` or other page,
    host or network globals.
  - Never reach `.parentNode`, `.ownerDocument`, `.constructor` or other
    properties that lead out of the shadow root.
  - Do not add `index.html`, `kit/`, `app.js` or `app.css`.
  - Keep `ui/` to static files, 5 MB at most in total.
- `product/product.yaml` has a tagline, a summary, 2 to 4 highlights and
  2 to 5 steps, none of them blank. Write them in the person's own words: a
  `ready` plugin may not keep the template's placeholder text.
- `product/icon.svg` is at most 64 KB and only draws. It has no `script`,
  `foreignObject`, `image`, `use`, `a`, event handlers or external links.
- `README.md` keeps the title `# <name>` and the sections `## Tools`,
  `## Layout` and `## Develop and run`, in that order. Name every tool and
  every task under `## Tools`.
- `.env` lists the environment variable names the plugin needs, one per
  line, and never their values.
- `.gitignore` keeps every entry the reference plugin has.

When everything above is done, set `status: ready`.

## 8. Check it locally

Run these from the plugin folder. All of them must pass.

```bash
uv lock                 # after any pyproject.toml change; commit uv.lock
uv sync --extra dev
uv run pytest
uv run ruff check .
uv lock --check  # uv.lock matches pyproject.toml
```

Then walk this list by hand:

- [ ] The top level holds only `nanoagent.yaml`, `contract.py`, `README.md`,
      `LICENSE`, `pyproject.toml`, `uv.lock`, `.gitignore`, `.env`,
      `src/`, `tests/`, `verifier/`, `ui/` and `product/`. No reports, run
      outputs or notes.
- [ ] The `id`, README title, `nanoagent-<id>` project name and LICENSE
      holder are all renamed. `version` matches in both files.
- [ ] Every `Tool` and `Task` appears in `nanoagent.yaml`, the README, the
      `IMPLEMENTATIONS` table and the verifier's tables.
- [ ] No model is used anywhere in `verifier/`.

## 9. Publish

1. With the person's go-ahead, create a **public** GitHub repository and
   push to it, for example with
   `gh repo create <id> --public --source . --push`.
2. The person signs in at https://rush-lab.org and opens their workspace, for
   COMP 480/580 https://rush-lab.org/w/comp-480-580.
3. They open Mochi Lab on their computer and approve its request to connect.
   If Mochi Lab has no OpenRouter key, RUSH Lab gives it one with $10 of
   credit. They can save their own key and choose the model under
   **Settings → AI**.
4. In the workspace's **Marketplace**, they select **Submit your artifact**.
   On a workspace without submissions, the button is **+ Publish a plugin**.
   They paste the repository URL, read the terms, tick the statement, and
   submit. For a plugin in a subfolder, the URL is
   `https://github.com/<owner>/<repo>/tree/<branch>/<folder>`.
5. RUSH Lab checks every rule without running the plugin and lists every rule
   the plugin breaks. Fix each rule in the code, push, and submit again.
   Submitting again also publishes each later version. Bump `version` in both
   files and run `uv lock` each time: each version published is kept, and one
   published already is refused. A member's install updates itself to each new
   version unless they turn off **Auto-update** under **Settings → Plugins**;
   **Update**, there or on the plugin's Dashboard, then takes the newest.
6. Once a workspace owner adds the plugin, the person opens it, asks the chat
   for a task, and checks the verdict on the result card. Passing the
   publication checks only shows the format is right. The verifier's tests
   and the verdicts of real runs show that the task works.

A person who does not want their work open-sourced does not submit it on RUSH
Lab, and emails it to the course staff instead.

## Common refusals

| Message | Fix |
|---|---|
| `Someone else already publishes a plugin named <id>` | Choose a new id, then rename it everywhere from step 2. |
| `<id> is one of NanoAgent's own plugins` | Choose a new id. |
| `Your uploads may hold N MB in all` | Remove one of your other published plugins, or shrink this one. |
| `uv.lock is out of date with pyproject.toml` | Run `uv lock` and commit the result. |
| A broken README, LICENSE, or `.gitignore` rule | Restore the reference plugin's version of that part, then add yours after it. |
| A `decide` field that cannot be filled | Make the field an Enum or bool, or make sure an earlier tool output or the task input holds a value of exactly its type. |
| A verifier import or call that is not allowed | Replace it with a pure standard-library equivalent, or move the work into a tool. |
| A `ready` product page that still has placeholder text | Rewrite the tagline, summary, highlights and steps for this plugin. |
