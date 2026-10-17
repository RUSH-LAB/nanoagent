# Cloud Probe

RUSH Lab cloud's runner check (`helpinghands/scripts/aws/verify-runner.mjs`): a plugin that
reports, from inside NanoAgent's bubblewrap sandbox, what it can see, reach and use. Its
verifier decides whether the sandbox and the runner's limits held. It is built from
`nanoagent plugin new` and installed only into a runner under test, never published.

## Tools

| Tool | Does | Code |
|---|---|---|
| `probe` | Reports its environment, its network, the files it may write and the processes it sees | `src/plugin/probe.py` |
| `hog` | Tries to hold more memory than the runner allows | `src/plugin/probe.py` |
| `swarm` | Fills the runner's memory with processes each smaller than NanoAgent | `src/plugin/probe.py` |
| `forks` | Tries to start more processes than the runner allows, and may hold them until its run ends | `src/plugin/probe.py` |

### Tasks

| Task | Does | Runner |
|---|---|---|
| `probe` | Checks the sandbox holds | `tool`, with `probe` |
| `hog` | Checks the memory limit holds | `tool`, with `hog` |
| `swarm` | Checks the kernel stops a plugin's processes, not NanoAgent, when memory runs out | `tool`, with `swarm` |
| `forks` | Checks the process limit holds | `tool`, with `forks` |

## Layout

```text
.
├── nanoagent.yaml   # manifest: its tools, its tasks, and the two hosts it declares
├── contract.py      # each tool's and task's typed input and output
├── src/plugin/      # the MCP server and probe.py, what each tool tries
├── tests/           # the verifier's tests
├── ui/              # renderers.js and renderers.css, the template's
├── product/         # product.yaml and icon.svg
└── verifier/        # whether the sandbox and the limits held
```

## Develop and run

```bash
uv sync --extra dev
uv run pytest
```

`npm run cloud:verify` (in `helpinghands/`) builds it from `nanoagent plugin new` with these
files over the template's, and installs it into the runner it starts.
