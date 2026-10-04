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
contract. A package requires `nanoagent.yaml`, `README.md`, referenced JSON
schemas and `verifier.py`; its source layout and environment manager are its
own concern. NanoAgent launches its declared MCP runtime, validates schemas,
and runs the standard semantic input/output verifier:

```bash
uv run nanoagent plugin inspect ../plugins/arxiv-source
uv run nanoagent plugin run ../plugins/arxiv-source save-paper-source \
  arxiv_id=1706.03762 destination=downloads/attention
```

Each declared plugin tool is also available as a regular NanoAgent `Tool`
through `nanoagent.plugin.plugin_tools`.

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

`nanoagent.harness` is the stable interface shared by the native agent loop and
out-of-process harnesses. It normalizes requests, progress events,
capabilities, availability and results while keeping model- and
harness-specific code behind adapters.

NanoAgent keeps its detailed native trajectory format and can also export an
`AgentResult` to the portable ATIF format with `nanoagent.trajectory.to_atif`.

### Amazon Bedrock

Install the AWS transport when the native harness should call Bedrock directly:

```bash
uv sync --extra bedrock
```

The native harness uses the Bedrock Converse API:

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

- `core`: the native agent loop and tool primitives
- `harness`: normalized harness contracts, implementations and adapters
- `plugin`: reproducible MCP plugin packages
- `inference`: model clients, routing and serving
- `execution`: batch runs, events, task selection and logging
- `trajectory`: native and ATIF trajectory formats
- `benchmark`: evaluation protocols and scoring
- `cli` and `web`: user-facing interfaces
- `runtime`: configuration and compatibility imports for older module paths

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
