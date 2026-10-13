# {{name}}

A `nanoagent.plugin/v1` plugin, created by `nanoagent plugin new` with the
structure of NanoAgent's reference plugin, `plugins/arxiv-source`.

## Tools

| Tool | Does | Code |
|---|---|---|
| `write_note` | Writes a text note into a new file in the workspace | `src/plugin/note.py` |

## Layout

```text
.
├── nanoagent.yaml   # manifest (a slimconfig ManifestConfig): id, runtime, permissions, tools, tasks
├── contract.py      # each tool's and task's typed input and output: slimconfig Output classes
├── README.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── .gitignore
├── .env             # environment variable NAMEs this plugin needs, never values
├── run.sh           # exits 0 when this environment can run the plugin
├── src/plugin/      # the MCP server (__main__.py, its IMPLEMENTATIONS) and one module per tool
├── tests/
├── ui/              # the front end: a static web page, ui/index.html
└── verifier/        # deterministic verifier package, one module per tool
```

`contract.py` is the one place a value's shape is declared. Its `Output`
classes are the JSON Schemas the server offers and the agent sees, and every
input and output is built into its class on the way in and out: the server,
NanoAgent and the verifier all get typed values, never loose dicts. A tool
that fails raises; NanoAgent sees an MCP error.

To add a tool: add a `Tool` member, its input and output classes and its
`TOOLS` entry to `contract.py`; write `src/plugin/<tool>.py`, taking its input
and the workspace and returning its output; write a `verifier/<tool>.py` with
`verify_input` / `verify_output`, and tests for both. Then register it in
`src/plugin/__main__.py` (`IMPLEMENTATIONS`), `verifier/__init__.py` (`TOOLS`),
`nanoagent.yaml` (`tools`) and this README's Tools table.

`LICENSE` stays the template's, `.gitignore`
keeps its entries, `run.sh` keeps its checks first (add the plugin's own after
them), and this README keeps its title and sections: NanoAgent refuses a plugin
that changes them (rule 10 of `nanoagent.plugin.manifest`). Renaming the
plugin means renaming it in `nanoagent.yaml`, this title and `LICENSE` together.

To add a task, add a `Task` member and its `TASKS` input class to
`contract.py`, and declare it in `nanoagent.yaml` with its `runner` (`tool` or
`agent`) and a `reference` tool, or `null` if it has none. Then add its outcome
check, `verify_task(arguments, reference, workspace)`, to `TASKS` in
`verifier/__init__.py`.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
uv run --project <nanoagent checkout> nanoagent plugin inspect .
```
