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
├── nanoagent.yaml   # manifest: id, runtime, permissions, tools, tasks
├── README.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── .gitignore
├── .env             # environment variable NAMEs this plugin needs, never values
├── run.sh           # exits 0 when this environment can run the plugin
├── schemas/         # <tool>-input.json / <tool>-output.json, one pair per tool
├── src/plugin/      # the MCP server (__main__.py, its TOOLS table) and one module per tool
├── tests/
└── verifier/        # deterministic verifier package, one module per tool
```

To add a tool: write `src/plugin/<tool>.py`, its two schemas, a
`verifier/<tool>.py` with `verify_input` / `verify_output`, and a test. Then
register it in `src/plugin/__main__.py` (`TOOLS`), `verifier/__init__.py`
(`TOOLS`) and `nanoagent.yaml`.

To add a task, declare it in `nanoagent.yaml` with its `runner` (`tool` or
`agent`), its `input` schema and a `reference` tool, or `null` if it has none.
Then add its outcome check, `verify_task(arguments, reference, workspace)`, to
`TASKS` in `verifier/__init__.py`.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
uv run --project <nanoagent checkout> nanoagent plugin inspect .
```
