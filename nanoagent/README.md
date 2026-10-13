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
ui/              # the front end: a static web page, ui/index.html
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

Before each launch NanoAgent runs `run.sh` with the plugin's environment: `NANOAGENT_WORKSPACE` plus each `.env`
name taken from NanoAgent's own environment. It refuses to launch unless
`run.sh` exits 0. It then starts the declared MCP runtime with that same
environment, builds every input and output into its contract class
(`slimconfig.build_output`), and runs the verifier, which gets the same typed
values, before and after each tool call. Every JSON Schema NanoAgent shows (to
MCP, the agent and the web) is `slimconfig.output_schema` of a contract class.
A tool that fails raises; NanoAgent sees an MCP error, never an `ok: false`.

Every task in `nanoagent.yaml` declares its `runner` and a `reference`; its
input class is the contract's `TASKS` entry. A run config's `arguments` is the
path of a JSON file holding that input:

- **`runner`:** `tool` means one tool called directly with the task's input.
  `agent` means an agent works the task with the task's tools.
- **`reference`:** either `null` or a tool outside the task's tools that takes
  the task's input. NanoAgent runs it before the task and pins its output as
  the ground truth. This is how a verifier checks against arXiv without
  network access.

The verifier is plain code, never an LLM judge. `verifier/__init__.py` defines
three functions:

- `verify_input(tool, value)` and
  `verify_output(tool, input_value, output_value, workspace)`, run on every
  tool call;
- `verify_task(task, arguments, reference, workspace)`, run once on the
  finished task, with the pinned reference.

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

- **`nanoagent plugin run`** (`PluginRunConfig`) runs `tool` tasks. It adds
  `result.json` to the run folder.
- **`nanoagent plugin agent`** (`PluginAgentConfig`) runs `agent` tasks. It adds
  `llm` (Bedrock) and `harness` (the loop's limits) to the config, and
  `reference.json` and `messages.json` (ATIF) to the run folder.

Every run folder holds `workspace/` and `verdict.json` (the `verify_task`
verdict), and the run exits 1 unless the verdict is valid. A plugin may write
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

Every plugin also ships its own front end in `ui/`, a static web page:
`ui/index.html` and the HTML, JS, CSS, images and fonts it loads, at most
5 MB, with nothing built at load time. Mochi shows it in a sandboxed iframe,
and nothing of its own around it: choosing the app opens this page, so how
the app introduces itself and starts is the page's to design.
NanoAgent serves an installed plugin's at `GET /v1/installs/<sha256>/ui/<uiVersion>/<path>`, where
`uiVersion` is the catalog's digest of `ui/` and the files are cached forever, under a
Content-Security-Policy with `connect-src 'none'`, so the page can't reach the
network and talks to NanoAgent only through the host's `postMessage` bridge,
protocol `nanoagent.ui/v1`. The bridge's methods are `describe`, `runTask`,
`prompt`, `cancel`, and `workspace.list` / `read` / `write`
([docs/plans/plugin-ui.md](docs/plans/plugin-ui.md)).

`runTask` uses `POST /v1/workspaces/<ws>/installs/<sha256>/tasks/<task>/runs`,
which runs a task the verified way (reference, tools or agent, then
`verify_task`) in that workspace and streams `task.*` events. It shares its
runner, `nanoagent.plugin.tasks.run_task`, with `nanoagent plugin run` and
`agent`.

`ui/` is split into a shared UI kit and the plugin's own page.
`ui/index.html` and `ui/kit/` are the kit: the template's bytes in every
plugin (the loader refuses any other), changed only in the template. `ui/app.js` and `ui/app.css` are the plugin's, next to any other
static files it adds. `nanoagent plugin new` starts every plugin with the
kit and a default page, a full-page chat with the plugin's agent, which
never shows its tools. Each plugin then designs its page around what people
come to do: `app.js` passes `mountApp` a layout, `({plugin, workspace}) =>
Element`, built from `ui/kit/components.js`. The kit has an app shell with
the chat in a drawer (`appShell`, `chatDrawer`), inputs (`dateInput`,
`segmented`, `chipToggles`, `chipRow`, `chipsInput`, `numberStepper`, and
`fileDrop`, which writes the user's file to the workspace for the task), a
run with plain-language steps, Stop and its outcome (`taskRun`,
`runButton`), the verdict and errors in plain words (`verdictBanner`,
`errorCard`), results (`card`, `dataTable`, `meter`, `statusPill`,
`disclosure`, `emptyState`), workspace files and a JSON state file
(`jsonStore`), and Mochi's look in light and dark down to narrow widths
(`kit.css`). The full API is in
[docs/plans/plugin-ui.md](docs/plans/plugin-ui.md).

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
  installed. Installs last as long as the process, so a caller installs again
  after a restart.
- `POST /v1/workspaces/{workspace}/installs/{sha256}/runs` runs a prompt on an
  agent that has the plugin's tools. The body is a run request and the reply is
  a run stream.

Every process a plugin brings (its `run.sh`, MCP server, verifier, and the
`uv sync` that installs it) runs in the sandbox `WebConfig.sandbox` names
(`nanoagent.plugin.sandbox`). On Railway that is `bwrap`: new namespaces, an
empty environment, the system and the plugin's own folder read-only, and only
the run's workspace to write. Its only network is an HTTPS proxy
(`nanoagent.plugin.egress`) that reaches the hosts the plugin declares in
`permissions.network.hosts`, and only public addresses; installing also
reaches the package index and GitHub. A sandboxed plugin gets no environment
variables, so one that declares any is refused. The server proves the sandbox
holds before it serves anything, and refuses to start if it does not.
`sandbox: none` runs plugins as plain processes, for a loopback-only host
whose plugins are its operator's own, such as a laptop.

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
