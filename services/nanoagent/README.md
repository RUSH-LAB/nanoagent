# nanoagent

A minimal, clean-room agent loop with structured tool calling — plus the batch runner, REPL and
coding-CLI built on top of it.

The whole loop is one function. A model is anything with an `async query(messages, tools)`; a tool
is a class with a `NAME`, a JSON Schema and a `run`. Everything else in the package is a *seam*
onto that loop, off unless a config names it — so the path a batch of 512 concurrent rollouts
takes is the same code an interactive chat takes.

```python
import asyncio
from nanoagent import Agent, get_tools
from nanoagent.runtime.model import Model
from nanoagent.runtime.config import ModelConfig

tools = get_tools(["tools/bash.yaml"])                 # shipped with the package
agent = Agent(model=Model.from_config(cfg), tools=tools, system_prompt="...")
result = asyncio.run(agent.run("count the python files under src/"))
print(result.answer)
```

## Install

```bash
pip install git+https://github.com/zeyuyang8/nanoagent

# ...plus `[serve]` if you also want to bring the SGLang server up yourself
pip install "nanoagent[serve] @ git+https://github.com/zeyuyang8/nanoagent"
```

## The command-line entry points

Everything is described by a YAML file rather than by flags, because a run has to be reproducible
from something you can commit. The one exception is `mgen`, and it is a thin layer *over* a config
(see below).

```bash
# one task, streamed live, trajectory always saved
nanoagent run harness_cfg=myharness.yaml task="list the python files" output=run.traj.json

# a batch over a tasks JSONL — concurrent, resumable, one bad task never sinks the rest
nanoagent run harness_cfg=myharness.yaml batch_cfg=mybatch.yaml \
    tasks=mytasks.jsonl output=expdir/batch

# an interactive session over the same loop (confirm / yolo / shell modes, branching transcript)
nanoagent chat chat_cfg=mychat.yaml

# a TUI for reading back what any of the above wrote
nanoagent browse path=expdir/chat/
```

## Web applications

Keep NanoAgent as the Python runtime and install the typed Node client in the application server;
do not port the agent loop into each web stack:

```bash
git clone https://github.com/zeyuyang8/nanoagent.git
cd nanoagent
pip install ".[web]"
export OPENROUTER_API_KEY=...
nanoagent web web_cfg=configs/web_openrouter.yaml

# In Mochi, link the local client during development:
npm install /path/to/nanoagent/packages/client

# After publishing it:
npm install @nanoagent/client
```

In a deployment, copy `configs/web_openrouter.yaml` and `configs/models/openrouter.yaml` into the
service configuration and pin the Python package version independently of those operator-owned
files.

```ts
import {NanoAgentClient} from "@nanoagent/client";

const agent = new NanoAgentClient({
  baseUrl: process.env.NANOAGENT_URL!,
  token: process.env.NANOAGENT_API_TOKEN,
});

for await (const event of agent.stream(
  {input: "Summarize the current document", messages, instructions},
  {signal},
)) {
  if (event.type === "delta" && event.kind === "content") sendToBrowser(event.text);
}
```

The server provides `GET /v1/profiles` for discovery, `POST /v1/runs` as an SSE stream,
`DELETE /v1/runs/:id` for explicit cancellation, and `GET /health`. Disconnecting the stream also cancels its run. Every event is a
typed discriminated union: `start`, `delta`, `tool`, `step`, `done`, or `error`.

The YAML owns the backend, credentials, tools and budgets. A request can carry prior messages and
additional application instructions and select one server-approved `profile`, but cannot submit
arbitrary model configuration, commands, credentials, or tools. Bind to
loopback for a same-container application; a non-loopback bind requires `api_token`. The included
`configs/web_openrouter.yaml` deliberately starts with no tools, no checkout context, one model
turn and hidden reasoning.

`@nanoagent/client` is a server-side package. A browser should call its own application backend,
which applies user identity, tenancy and product policy before forwarding a run to NanoAgent.

### Selecting a harness and model profile

Each profile is a server-owned harness/model pairing. The client discovers safe public metadata
with `client.profiles()` and sends only its ID, for example
`client.run({input: "...", profile: "pi-deepseek"})`. The default profile keeps NanoAgent's own
loop, while optional profiles expose Hermes Agent and PI through the same event protocol:

```yaml
default_profile: native-deepseek
profiles:
  native-deepseek:
    label: DeepSeek V4 Flash · NanoAgent
    model: deepseek/deepseek-v4-flash-0731
    harness: {type: native, command: null, cwd: null, options: {}}
    model_overrides: {}
  hermes-deepseek:
    label: DeepSeek V4 Flash · Hermes Agent
    model: deepseek/deepseek-v4-flash-0731
    harness: {type: hermes, command: null, cwd: null, options: {provider: openrouter}}
    model_overrides: {}
  pi-deepseek:
    label: DeepSeek V4 Flash · PI
    model: deepseek/deepseek-v4-flash-0731
    harness:
      type: pi
      command: [node, packages/pi-runner/dist/index.js]
      cwd: null
      options: {provider: openrouter, api_key_env: OPENROUTER_API_KEY}
    model_overrides: {}
```

Install Hermes Agent as an optional, isolated one-shot runner:

```bash
pip install "nanoagent[web,hermes]"
```

PI runs in Node, so install its companion package beside the server. The checkout config above
calls its built entry point directly and does not require a global npm link:

```bash
cd packages/pi-runner && npm install
cd ../..
nanoagent web web_cfg=configs/web_openrouter.yaml
```

Mochi can keep one server-side NanoAgent client and store a profile ID per workspace agent;
changing harnesses does not change its HTTP/SSE API. The profile endpoint reports availability
and capabilities. Hermes and PI preserve user/assistant history in their one-shot prompt. Hermes
supports final answers, tools and usage, while PI supports streaming and reasoning; PI tool
bridging stays disabled until its workspace and permission semantics can be enforced consistently.

Third-party adapters use `nanoagent.runner.v1`: one JSON request line on stdin and normalized
`delta`, `tool`, `step`, then `done` or `error` JSON lines on stdout. Diagnostic logs belong on
stderr. NanoAgent starts adapters without a shell, enforces its own timeout/output limits, and
terminates the child when the caller cancels or disconnects.

Any leaf of a config can be overridden inline on any command:

```bash
nanoagent run harness_cfg=myharness.yaml agent.max_steps=30 model.temperature=0.7
```

### `mgen` — the same agent as a coding CLI

`mgen` speaks Claude Code's flag grammar, so a script written against `claude` runs against
whatever you can reach by changing a config rather than the script:

```bash
mgen -p "summarise what changed in the last commit"
mgen --model my-model --allowedTools bash,read
mgen -p "..." --output-format json | jq -r .result
mgen -c                      # carry on from the last session
mgen --dump-config           # what those flags resolved to, as a YAML that reproduces them
```

The flags only override leaves that already exist in the schema, and `--dump-config` prints the
result — so nothing a flag can express is unsayable in a config. With no `--config` and no
`$MGEN_CONFIG`, it loads the `configs/mgen.yaml` shipped inside the package, which points at a
local SGLang endpoint and turns on read / write / edit / bash / python.

## Where the model comes from

The agent loop imports no provider SDK. `nanoagent.runtime.model.Model` is a thin adapter over
`nanoagent.inference`, which resolves `model.backend` against its own built-in transports and then
against the plugin directories in `$NANOAGENT_PLUGINS`:

```yaml
model:
  model: default
  backend: sglang                            # or the name of a plugin file
  base_url: http://127.0.0.1:30000/v1
```

So a private gateway is a `.py` file in a `$NANOAGENT_PLUGINS` directory — one that defines a
`BACKEND` class with a `from_config` classmethod. Nothing in the package needs a line changed, and
there is deliberately no allowlist of backend names.

A *public* provider needs even less, because `backend: sglang` is not really sglang-specific — it
is the async OpenAI SDK pointed at a `base_url`, and most hosted APIs speak that. OpenRouter is a
config edit and nothing else:

```bash
export OPENROUTER_API_KEY=sk-or-...
mgen --config configs/openrouter.yaml -p "what does src/nanoagent/runtime/build.py do?"
```

Verified end to end against `deepseek/deepseek-v4-flash-0731` — completions, tool calls, streaming,
usage and cost, and a full agent rollout that made two tool calls and answered from what it read.
Two things worth knowing before picking a model there. The `:free` tier shares an upstream pool and
answers `429` under any real load, so it suits a smoke test and not a batch. And cheapest per token
is not cheapest per task: on the same question a model at *half* the sticker price cost 2.1× as
much, because it reasoned and read a second file — it was also the one that got the answer right.

## Tokens

Text is what a provider returns; token ids are what a trainer needs. Name a tokenizer and every
reply carries both:

```yaml
model:
  backend: sglang_native                     # SGLang's /generate — ids in, ids out
  base_url: http://127.0.0.1:30000/v1
  tokenizer: google/gemma-3-27b-it           # the client owns the chat template
```

```python
response.tokens.completion_ids   # [11, 12, ...]
response.tokens.logprobs         # per token
response.tokens.fidelity         # Fidelity.NATIVE
```

**No chat API reports token ids** — not OpenRouter's, not SGLang's own `/v1`. Only `/generate`
does, by taking `input_ids` and answering with the ids it sampled. So the split is `/generate` vs
`/v1`, not local vs hosted, and `Tokens.fidelity` names which side a record came from:

| | `backend: sglang_native` | `backend: sglang` (incl. OpenRouter) |
| --- | --- | --- |
| prompt | ids we rendered, sent verbatim | text; ids re-rendered locally |
| completion | the ids the sampler emitted | text, re-encoded locally |
| logprobs | per token | none |
| `fidelity` | `NATIVE` — trainable | `RECONSTRUCTED` — informational |

`RECONSTRUCTED` is a real answer, not a placeholder: it is right often enough to be useful for a
length or an alignment, and wrong often enough that a per-token loss must not touch it (a routing
provider may not have used this vocabulary at all; `encode(decode(ids))` is not the identity; and a
tool call comes back as a parsed field with its delimiters gone, so those generated tokens are
simply missing). One shape, and a label that says which it is, beats a guarantee that quietly isn't.

The trade on the native path is that the client owns the chat template — which is what removes
train/serve skew, and what moves tool-call parsing and streaming client-side. Neither is
implemented there yet, so `sglang_native` generates and scores batches (`nanoagent.inference.infer`)
and `sglang` drives the agent loop. Needs `pip install "nanoagent[tokens]"`.

## Serving

`nanoagent.inference` also brings the server up, so the same YAML describes both sides of the
connection. One `SGLangServeConfig` covers every topology and `mode` picks which:

```bash
pip install "nanoagent[serve] @ git+https://github.com/zeyuyang8/nanoagent"

python -m nanoagent.inference.serve --config configs/gemma_4_31b_serve.yaml    # single node
python -m nanoagent.inference.serve --config configs/gemma_4_31b_router.yaml   # router + N engines
```

SGLang itself is not a dependency: the engine is exec'd as the `sglang serve` CLI, so the serving
environment owns that pin (it decides the CUDA/torch stack) and this package never constrains it.
The repo-root `configs/` tree contains worked examples — unlike `src/nanoagent/configs/`,
which ships inside the wheel as `mgen`'s defaults.

For batch inference without an agent, `nanoagent.inference.infer` runs a list of requests
concurrently and returns the responses in input order.

## Tools

A tool is a `Tool` subclass; a tool *manifest* is a YAML naming the module that defines it. Every
other key in the manifest is passed to the constructor, so a tool's configuration is explicit in
the file rather than read out of the environment:

```yaml
# mytools/search.yaml
code: mytools/search.py     # a .py path (CWD-relative), or an importable module name
base_url: http://127.0.0.1:8000
```

Every concrete `Tool` subclass *defined* in that module becomes a tool. Adding one is a new file
and a new YAML — no change to nanoagent. The shipped manifests (`tools/files.yaml`,
`tools/bash.yaml`, `tools/python.yaml`) use the module-name form, since an installed package has
no repo-relative path to point at.

`tools.write` lets the agent write a manifest and its module and use the result on the next turn.
That works for the same reason: `get_tools` needs nothing but the two files.

## Configs are explicit

Every schema field is required. A config sets each one — `null` or `[]` to turn something off —
so nothing is inherited silently and no hidden default decides a run. Reuse comes from
`defaults: [<path>]` composition, not from omission.

## Layout

There are two core responsibilities: **reaching a model**, and **doing something with one**.
The runtime composes them; CLI and web are adapters over that runtime, not alternate loops.

```text
src/nanoagent/
├── core/          provider-independent agent loop and tool contracts
├── inference/     model transports, batch inference, and SGLang serving
├── runtime/       configuration, assembly, events, trajectories, batch runs
├── tools/         built-in tool implementations
├── cli/           terminal commands and REPL
├── adapters/      subprocess adapters for optional third-party harnesses
└── web/           internal HTTP/SSE adapter over the runtime
```

| package | what it is |
| --- | --- |
| `nanoagent.core` | The stdlib-only loop, tool contract, hooks, and workspace context. |
| `nanoagent.inference` | Model transports, plugin resolution, batch inference, tokenization, and SGLang serving. |
| `nanoagent.runtime` | Typed configuration, one agent factory, lifecycle events, trajectories, and batch execution. |
| `nanoagent.tools` | Opt-in `bash`, `code`, file, write, and skill implementations. |
| `nanoagent.cli` | `run`, `mgen`, chat, browser, and terminal rendering. |
| `nanoagent.adapters` | Small protocol translators for isolated third-party harnesses. |
| `nanoagent.web` | Server-owned configuration, bounded run lifecycle, cancellation, and the internal SSE API. |

Dependencies point inward: CLI and web use runtime; runtime assembles core, inference, and tools;
core and inference do not import the outer layers. The only adapter from the agent loop to a model
transport is `nanoagent.runtime.model`.

## Seams

Each is off unless a config names it, so the rollout path executes the same code it always did.

- **hooks** — `session_start` / `before_llm` / `before_tool` / `after_tool` from a plain `.py`.
  This is how a prompt rule ("call search at most once") becomes something enforced rather than
  requested. State is per-*run*, not per-agent, so a shared `Agent` across concurrent rollouts
  gets one budget each.
- **skills** — `SKILL.md` files indexed by name and description, body loaded on demand.
- **events** — the run mirrored to NDJSON, for watching a rollout from outside the process.
- **workspace** — a per-rollout root that `Read` / `Write` / `Edit` resolve inside.

## Trajectories

Every run saves one. A trajectory is the full message list plus per-step timings, token usage,
cost and a `stop_reason`, written atomically (temp file + rename) so a reader never sees a partial
file. That is the artifact a scorer or an RL trainer consumes, and `nanoagent browse` reads back.

## Development

```bash
uv venv && uv sync --extra dev --extra web
uv run pytest -q
uv run ruff check .
```

## License

MIT. See [LICENSE](LICENSE).
