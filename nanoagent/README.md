# nanoagent

Install:

```bash
uv sync
```

Run:

```bash
uv run nanoagent --help
```

## Plugins

NanoAgent plugins follow the implementation-neutral `nanoagent.plugin/v1`
contract. Every plugin is a folder with this standard layout
(`nanoagent.plugin.manifest.REQUIRED_FILES` / `REQUIRED_FOLDERS`):

```text
nanoagent.yaml   # manifest (a slimconfig ManifestConfig): id, runtime, permissions, tools, tasks
contract.py      # each tool's and task's typed input and output: slimconfig Output classes
README.md
LICENSE
pyproject.toml
uv.lock
.gitignore
.env             # environment variable NAMEs the plugin needs, never values
run.sh           # exits 0 when this environment can run the plugin
src/             # the plugin's code, organized as it likes
tests/           # the plugin's tests, including test_verifier.py
verifier/        # deterministic verifier package, .py files only
ui/              # the front end: a static web page, ui/app.js and ui/app.css
product/         # the product page: product.yaml and icon.svg
```

Nothing else may sit at the top level. The only exceptions are what tools create in a
checkout: `.git`, `.venv`, `__pycache__`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`,
`.DS_Store` (`TOOL_ARTIFACTS`).

The rules a plugin must follow are listed in one place, the docstring of
`nanoagent.plugin.manifest`. These are the layout above, a `.env` holding
names only, a `contract.py` of declarations only, a `nanoagent.yaml` that
fills `ManifestConfig` under slimconfig's rules (tables keyed by the
contract's `Tool` and `Task`), a deterministic verifier, a `ui/` and a
`product/` (below), no extra files, and standard files that are the
template's (`nanoagent/plugin/template/`, what `nanoagent plugin new`
writes): its `LICENSE` naming the plugin, its `.gitignore` entries, its
`run.sh` checks first (a plugin adds its own after them), a `README.md`
opening with `# <name>` with the sections Tools, Layout and Develop and run
and every tool named under Tools, and a `pyproject.toml` naming the project
`nanoagent-<id>`. NanoAgent refuses to load a plugin that breaks any rule, and `PluginError` lists every
violation at once (`nanoagent plugin inspect <path>` prints them). The web
host refuses to start with such a plugin. Every tool call checks the rules
again, so a plugin edited after it loaded is refused too.

Every plugin names the NanoAgent versions it runs on: `nanoagent` in
`nanoagent.yaml` is a PEP 440 range, and NanoAgent refuses a plugin whose
range does not hold its own version (`nanoagent.__version__`).
`nanoagent plugin new` writes `~=<this version>`, such as `~=0.3.0`
(0.3.0 up to, not including, 0.4). NanoAgent raises its minor version
whenever a plugin made for the last one could break: the plugin rules, the
contract, the verifier, the UI kit or the `nanoagent.ui/v1` bridge. Any other
release raises the patch version. Each release is a git tag,
`nanoagent-v<version>`, and [CHANGELOG.md](CHANGELOG.md) says what a plugin
must change for it.

Before each launch NanoAgent runs `run.sh` with the plugin's environment: `NANOAGENT_WORKSPACE` plus each `.env`
name taken from NanoAgent's own environment. It refuses to launch unless
`run.sh` exits 0. It then starts the declared MCP runtime with that same
environment, builds every input and output into its contract class
(`slimconfig.build_output`), and runs the verifier, which gets the same typed
values, before and after each tool call. Every JSON Schema NanoAgent shows (to
MCP, the agent and the web) is `slimconfig.output_schema` of a contract class.
A tool that fails raises; NanoAgent sees an MCP error, never an `ok: false`.

Every task in `nanoagent.yaml` declares its `runner` and a `reference`; its
input and output classes are the contract's `TASKS` entry. A run config's
`arguments` is the path of a JSON file holding that input:

- **`runner`:** `tool` means one tool called directly with the task's input;
  the task's classes are the tool's, and its output is the tool's. `agent`
  means an agent works the task with the task's tools and ends by calling
  `submit`, a tool NanoAgent adds that takes the task's output class: the last
  submission is the task's output, and an agent that never submits fails the
  task. No plugin tool is named `submit`. `decide` means a model only decides:
  NanoAgent calls the task's tools and builds its output, every value an Enum
  or bool the model chose, or one of exactly its type copied from the task's
  input or an earlier tool output (never the reference tool's). A slot with one
  option is copied with no question; NanoAgent refuses a decide task with a
  field it cannot fill that way.
- **`reference`:** either `null` or a tool outside the task's tools that takes
  the task's input. NanoAgent runs it before the task and pins its output as
  the ground truth. This is how a verifier checks against arXiv without
  network access.

The verifier is plain code, never an LLM judge. `verifier/__init__.py` defines
three functions:

- `verify_input(tool, value)` and
  `verify_output(tool, input_value, output_value, workspace)`, run on every
  tool call;
- `verify_task(task, arguments, output, reference, workspace)`, run once on
  the task's output, with the pinned reference.

Each returns `valid`, `score` (0 to 1), `message` and `details`. Other modules
in `verifier/` are imported relatively. NanoAgent enforces determinism
(`nanoagent.plugin.verifier`):

- **Static check when the plugin loads.** Each verifier module may import only pure
  standard-library modules (`re`, `json`, `pathlib`, `math`, `hashlib`, ...).
  No `eval`/`exec`/`open`/`getattr`, no private attributes, no file writes.
- **Sandboxed run.** Each call runs in a fresh `python -I` with networking and
  process launching disabled and new imports blocked.
- **Called twice.** The two verdicts must match, or the run fails.

### The reference plugin and starting a new one

`plugins/arxiv-source` is built in and is the reference every plugin follows.
It searches arXiv, then fetches and saves papers' LaTeX source. It has an MCP
server with a `TOOLS` table, one module per tool in `src/plugin/`, a schema
pair per tool, and one verifier module per tool. Start a new plugin with the
same structure (the folder name is the plugin id):

```bash
uv run nanoagent plugin new plugins/my-plugin
```

This copies the template (`nanoagent/plugin/template/`) with one working
`write_note` tool and writes `uv.lock`. The new plugin already passes every
rule. The plugin's README says how to add a tool. Each plugin under `plugins/`
is its own uv project with its own tests: `cd plugins/<id> && uv run pytest`.

Inspect a plugin, or run one:

```bash
uv run nanoagent plugin inspect plugins/arxiv-source
bash examples/arxiv_source/runs/step1_save_paper_source.sh    # one paper by id
bash examples/arxiv_source/runs/step2_search_papers.sh        # search only
bash examples/arxiv_source/runs/step3_save_search_results.sh  # search, fetch, save
bash examples/arxiv_source/runs/step4_daily_digest.sh         # agent: the daily paper digest
```

Both run commands are slimconfig runs (`config=<run.yaml> home=<run folder>`).
Their config names the plugin, the task, and the task's `key=value` arguments.

- **`nanoagent plugin run`** (`PluginRunConfig`) runs `tool` tasks.
- **`nanoagent plugin agent`** (`PluginAgentConfig`) runs `agent` and `decide`
  tasks. It adds `llm` (Bedrock, or OpenRouter in a
  `PluginOpenRouterAgentConfig`) and `harness` (the loop's limits) to the
  config, and `reference.json` and `messages.json` (ATIF) to the run folder.

Every run folder holds `workspace/`, `result.json` (the task's output) and
`verdict.json` (the `verify_task` verdict), and the run exits 1 unless the verdict is valid. A plugin may write
only to its workspace, which NanoAgent passes as `NANOAGENT_WORKSPACE`.

- **Input files.** A config's `inputs:` lists files the task reads. They are
  copied to `workspace/inputs/<file name>` before the task starts, and into
  the reference tool's scratch workspace too, so arguments name them as
  `inputs/<name>`.
- **One plugin process per run.** An agent run keeps one plugin process
  (`nanoagent.plugin.PluginSession`) for the whole task, so a plugin can hold
  state, such as a browser, between calls. `run.sh` runs once. Every call is
  still checked against the rules, both contract classes and the verifier.
- **Images.** A tool response's `images` field (a list of
  `{"media_type": "image/png", "data": <base64>}`) is shown to the model as
  images, not text. Only the Bedrock backend supports this; the OpenAI-
  compatible backends refuse it.

### Plugin front ends

What people see of a plugin lives in two folders, and nowhere else.

`product/` is the plugin's product page, what a catalog such as Mochi's
marketplace shows before anyone downloads it. It holds exactly two files.
`product.yaml` fills `ProductConfig`: a `tagline`, a `summary`, 2 to 4
`highlights` and 2 to 5 `steps`, written for the people who use the plugin
rather than for developers. `icon.svg` is the app icon, at most 64 KB, and
it may only draw: no scripts, event handlers, embedded content, or links
outside itself. A plugin's catalog entry (`GET /v1/packages`, `GET /v1/installs/<sha256>`) has both as its `product`,
with the icon as a `data:` URL for an `<img>`. Where the plugin may connect
and write comes from its manifest's `permissions`, so the page never restates
them.

Every plugin's page is NanoAgent's: a chat with the plugin's agent. A person
says what they need; the agent, whose only tools are the plugin's tasks (one
per task, named by its id and taking its input), runs the task that does it
the verified way, and answers in a sentence or two. Each task it ran shows in
the chat as a chip, and its result card (the task's output, with its verdict as
a badge) beside the chat, on the right. Mochi shows the
page in a sandboxed iframe, in the kit's frame of two tabs. **Dashboard**,
where the app always opens, lists the member's sessions with the plugin,
newest first, with what each ran and cost, to resume one or start a new one.
**Session** is the chat: the open session or, with none open, a new one, which
is only kept once it first chats. The host keeps each session's conversation,
task results included, so a resumed session shows it again.
NanoAgent serves an installed plugin's page at `GET /v1/installs/<sha256>/ui/<uiVersion>/<path>`, where
`uiVersion` is the catalog's digest of the page and the files are cached forever, under a
Content-Security-Policy with `connect-src 'none'`, so the page can't reach the
network and talks to NanoAgent only through the host's `postMessage` bridge,
protocol `nanoagent.ui/v1`. The bridge's methods are `describe`, `runTask`,
`prompt`, `cancel`, `sessions.list`, `session.get` / `start` / `resume` /
`save`, and `workspace.list` / `read` / `write`
([docs/plans/plugin-ui.md](docs/plans/plugin-ui.md)).

A plugin's `ui/` says how to draw its outputs, and nothing else: an output is
drawn from its JSON Schema (an object as labelled fields, a list of objects as
a table, a list as a list, text, links, numbers, yes or no) unless
`ui/renderers.js` draws its class. NanoAgent serves the page from
`src/nanoagent/plugin/page/` (`index.html` and the shared UI kit `kit/`), so
every plugin gets the kit of the NanoAgent serving it, and refuses a plugin
unless:

- `ui/renderers.js` and `ui/renderers.css` exist, and `ui/` holds no
  `index.html`, `kit/`, `app.js` or `app.css`;
- `renderers.js` has a default export, its renderers by output class name,
  each `(value, {task, verdict, send}) => Element` (`{}` in the template);
- every script imports only by a literal `./` or `../` path, of the kit's
  modules (`./kit/components.js`) or the plugin's own files in `ui/`: no URLs,
  no package names, no computed `import()`;
- no script names `document`, `window`, `parent`, `fetch` or another page,
  host or network global (`UI_GLOBALS`): a renderer draws only its output.

The kit draws each renderer's output in a shadow root of its own, the only
place `renderers.css` applies, so a plugin's styles never reach the page's
layout.

Renderers build from `./kit/components.js` (`h`, `card`, `dataTable`,
`banner`, `statusPill`, `disclosure`, `meter`, `markdown`, `schemaView`, the
workspace's files) and `kit.css`'s look, in light and dark. The full API is in
[docs/plans/plugin-ui.md](docs/plans/plugin-ui.md).

`runTask` uses `POST /v1/workspaces/<ws>/installs/<sha256>/tasks/<task>/runs`,
which runs a task the verified way (reference, tools, agent or decider, then
`verify_task`) in that workspace and streams `task.*` events; since 0.4.0 the
page runs tasks only through the chat and never calls it. Both share their
runner, `nanoagent.plugin.tasks.run_task`, with `nanoagent plugin run` and
`agent`.

Each declared plugin tool is also available as a regular NanoAgent `Tool`
through `nanoagent.plugin.plugin_tools(manifest, workspace, names)`.

The web service runs only plugins it installed, each from a package (below)
and known by the package's sha256 (`nanoagent.plugin.install`). Mochi Lab
installs the plugins each workspace added from its marketplace, and shows them
as apps:

- `PUT /v1/installs/{sha256}` installs the package in the body, whose sha256
  it must be: it is checked against every plugin rule, opened under the
  `installs` folder in `WebConfig`, and its environment built with
  `uv sync --frozen`. The reply is the plugin's catalog entry with its
  `uiVersion`, or 422 with every broken rule. Installing it again returns it.
- `GET /v1/installs/{sha256}` returns that entry, or 404 for a package not
  installed. A finished install is kept on disk, so the caller that installs
  again after a restart gets it without a sync.
- `POST /v1/workspaces/{workspace}/installs/{sha256}/runs` runs a prompt on an
  agent that has the plugin's tools. The body is a run request and the reply is
  a run stream.

Every process a plugin brings (its `run.sh`, MCP server, verifier, and the
`uv sync` that installs it) runs in the sandbox `WebConfig.sandbox` names
(`nanoagent.plugin.sandbox`). `bwrap` gives it new namespaces, an
empty environment, the system and the plugin's own folder read-only, and only
the run's workspace to write. Its only network is an HTTPS proxy
(`nanoagent.plugin.egress`) that reaches the hosts the plugin declares in
`permissions.network.hosts`, and only public addresses; installing also
reaches the package index and GitHub. A sandboxed plugin gets no environment
variables, so one that declares any is refused. The server proves the sandbox
holds before it serves anything, and refuses to start if it does not.
`sandbox: none` runs plugins as plain processes. Railway runs `none` for now,
because its containers refuse bwrap the namespaces it needs, so add only the
plugins you trust; what to build instead is in
[docs/plans/plugin-sandbox.md](docs/plans/plugin-sandbox.md).

The workspace is a scratch folder for one run, named by the caller, under the
`workspaces` root in `WebConfig`. The caller fills it before the run, reads it
back after, and then removes it, through these endpoints under
`/v1/workspaces/{workspace}`:

- `GET files` lists every file and folder.
- `GET` and `PUT` on `files/{path}` read or save one file. `PUT ?create=1`
  refuses to replace an existing file. Saves are capped at `max_file_bytes`.
- `DELETE` on the workspace itself removes it and everything in it.

Paths stay inside the workspace and never cross a symlink. A name already
taken returns 409. NanoAgent keeps nothing between runs, so no volume is needed.

### Plugin packages and the marketplace

A package is a plugin in one file, for Mochi's marketplace (`/marketplace`),
where people download plugins and share their own. `nanoagent plugin pack
<folder> <file.tar.gz>` writes one: the plugin, which must follow every rule,
under a single `<id>/` folder, without what its `.gitignore` ignores, packed
the same way every time (`nanoagent.plugin.package`). To use a downloaded one,
unpack it with `tar xzf` and run it like any plugin folder. The web service
serves packages, and runs one only once it is installed (above):

- `GET /v1/packages` lists the plugin directories under `packages` in its
  `WebConfig` (on Railway, every built-in plugin) with their catalog entries.
- `GET /v1/packages/{id}` downloads one.
- `POST /v1/packages/inspect` checks an uploaded package without running any
  of it. The package must unpack to plain files under one folder named by the
  plugin id, within the limits in `nanoagent.plugin.package`. The plugin is then
  loaded in a separate Python process with an empty environment, so a manifest
  cannot interpolate the host's secrets. The reply is the plugin's catalog
  entry, or 422 with every broken rule.
- `POST /v1/packages/source?path=<folder>` packs a plugin from its source: the
  body is a repository archive (GitHub's `.tar.gz` of one commit, its files
  under one top folder), and `path` the plugin's folder in it. Only that folder
  is unpacked, under the same limits, and it is packed in the same isolated
  process, then checked as above. The reply is `{"package": <catalog entry>,
  "data": <the package, base64>}`, or 422 with every broken rule. Mochi
  publishes plugins to its marketplace this way, from a GitHub URL.

### Plugin environments

Plugins are independent packages. Each plugin owns its `pyproject.toml`,
dependency declarations, source tree and tests; plugins do not depend on a
shared workspace environment.

When a set of plugins is loaded, NanoAgent should resolve them together and
group them into the fewest dependency-compatible runtime environments. All
plugins whose requirements can be resolved together share one cached
environment. A separate environment is created only when dependency conflicts
make sharing impossible.

Runtime environments should be keyed by the selected plugin versions,
dependency requirements, Python version, platform and resolver settings so an
equivalent plugin set can reuse an existing environment. This preserves package
independence and conflict isolation while avoiding one environment per plugin.

## Harnesses and trajectories

`nanoagent.harness` is the stable interface shared by the NanoAgent harness and
out-of-process harnesses. It normalizes requests, progress events,
capabilities, availability and results while keeping model- and
harness-specific code behind adapters.

NanoAgent keeps its detailed native trajectory format and can also export an
`AgentResult` to the portable ATIF format with `nanoagent.trajectory.to_atif`.

### Amazon Bedrock

Bedrock is the default: `mgen` runs Claude Opus 5.5 (`us.anthropic.claude-opus-5-5`) in
`us-west-2` through the Bedrock Converse API, using the standard AWS credential chain. The
NanoAgent harness configures it as:

```yaml
model > nanoagent.runtime.config.ModelConfig:
  model: <bedrock-model-or-inference-profile-id>
  provider: bedrock
  base_url: null
  api_key: null
  aws_region: us-west-2
  aws_profile: null
  temperature: null
  max_tokens: 8192
  request_timeout: 900.0
  max_retries: 4
  extra_body: []
  input_price: 0.0
  output_price: 0.0
```

Third-party harnesses own their model transport, so their profile options configure Bedrock at
the CLI boundary. Model names are harness-specific and should be verified for each profile:

```yaml
# Claude Code
harness:
  type: claude
  options: [provider=bedrock, aws_region=us-west-2, aws_profile=my-profile]

# Codex (Amazon Bedrock's Codex-compatible provider)
harness:
  type: codex
  options: [provider=bedrock, aws_region=us-east-2, aws_profile=my-profile]

# PI
harness:
  type: pi
  options: [provider=amazon-bedrock, aws_region=us-west-2, aws_profile=my-profile]
```

Each `HarnessProfileConfig` is therefore a concrete, operator-approved model–harness pairing.
NanoAgent passes the profile's `model` through to that harness and does not silently substitute
another model when a pairing is unsupported.

The same profile registry is available to interactive and print modes. Add the profile files and
selection to an `InteractiveConfig`, then use that config for either command:

```yaml
profiles:
  - configs/profiles/claude-bedrock.yaml
  - configs/profiles/pi-bedrock.yaml
profile: claude-bedrock
```

```bash
nanoagent chat chat_cfg=my-chat.yaml
mgen --config my-chat.yaml -p "inspect this repository"
```

Native profiles retain NanoAgent's confirm/yolo/human tool modes. External harnesses own their
tool approval and execution behavior; interactive mode keeps their conversation history and sends
each follow-up through the selected harness.

## Source layout

- `core`: the NanoAgent agent loop and tool primitives
- `harness`: normalized harness contracts, implementations and adapters
- `plugin`: reproducible MCP plugin packages
- `inference`: model clients, routing and serving
- `execution`: batch runs, events, task selection and logging
- `trajectory`: native and ATIF trajectory formats
- `benchmark`: evaluation protocols and scoring
- `cli` and `web`: user-facing interfaces
- `runtime`: configuration and compatibility imports for older module paths
- `js`: separately published Node.js client and harness packages

## Railway service

The repository includes a production container and private Railway service
configuration for Mochi Lab.

Required variables:

```dotenv
PORT=8787
OPENROUTER_API_KEY=...
NANOAGENT_API_TOKEN=...
```

Deploy the service without a public domain. Mochi connects over Railway's
private network using the same `NANOAGENT_API_TOKEN`.

Local development does not use this deployment unless `NANOAGENT_URL` is
explicitly set. Mochi's `npm start` uses the adjacent NanoAgent checkout.
