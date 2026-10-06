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
nanoagent.yaml   # manifest: id, runtime, permissions, tools, tasks
README.md
LICENSE
pyproject.toml
uv.lock
.gitignore
.env             # environment variable NAMEs the plugin needs, never values
run.sh           # exits 0 when this environment can run the plugin
schemas/         # only the JSON Schemas the tools reference
src/             # the plugin's code, organized as it likes
tests/           # at least one test_*.py
verifier/        # deterministic verifier package, .py files only
```

Nothing else may sit at the top level. The only exceptions are what tools create in a
checkout: `.git`, `.venv`, `__pycache__`, `.pytest_cache`, `.ruff_cache`, `.mypy_cache`,
`.DS_Store` (`TOOL_ARTIFACTS`).

The rules a plugin must follow are listed in one place, the docstring of
`nanoagent.plugin.manifest`. These are the layout above, a `.env` holding
names only, an exact `nanoagent.yaml` with no unknown keys, schemas under
`schemas/`, unique tools and tasks, a deterministic verifier, and no extra
files. NanoAgent refuses to load a plugin that breaks any rule, and `PluginError` lists every
violation at once (`nanoagent plugin inspect <path>` prints them). The web
host refuses to start with such a plugin. Every tool call checks the rules
again, so a plugin edited after it loaded is refused too.

Before each launch NanoAgent runs `run.sh` with the plugin's environment: `NANOAGENT_WORKSPACE` plus each `.env`
name taken from NanoAgent's own environment. It refuses to launch unless
`run.sh` exits 0. It then starts the declared MCP runtime with that same
environment, validates every input and output against its schema, and runs the
verifier before and after each tool call.

Every task in `nanoagent.yaml` declares its `runner`, its `input` schema and a
`reference`:

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

Each declared plugin tool is also available as a regular NanoAgent `Tool`
through `nanoagent.plugin.plugin_tools(manifest, workspace, names)`.

The web service publishes the plugin directories listed under `plugins` in its
`WebConfig`. Mochi Lab shows them as apps:

- `GET /v1/plugins` returns each manifest with its README and tool schemas
  inlined.
- `POST /v1/plugins/{id}/tasks/{task}` runs a single-tool task. The body is the
  tool input, and the reply is the verified output.
- `POST /v1/workspaces/{workspace}/plugins/{id}/runs` runs a prompt on an agent
  that has the plugin's tools. The body is a run request and the reply is a run
  stream.

The workspace is a persistent folder named by the caller, under the
`workspaces` root in `WebConfig`. Files the tools save stay there.
`GET /v1/workspaces/{workspace}/files` lists them, and
`GET` or `DELETE /v1/workspaces/{workspace}/files/{path}` reads or removes one.
On Railway, mount a volume at `/data`, or the workspaces are lost on every
deploy.

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
