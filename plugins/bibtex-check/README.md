# BibTeX Hallucination Check

Checks an LLM-generated BibTeX file against verified reference entries: each
raw entry is `real` when it exactly matches a reference entry, and
`hallucinated` otherwise. It reads only local files and needs no network.

## Tools

| Tool | Does | Code |
|---|---|---|
| `parse_bibtex` | Parses the reference and the raw file into the registered schema; the `check-bibtex` task's pinned reference | `src/plugin/bibtex.py` |
| `read_bibtex` | Reads one BibTeX file's entries in the registered schema | `src/plugin/bibtex.py` |
| `submit_verdicts` | Writes one verdict, `real` or `hallucinated`, per raw entry key to `verdicts.json` | `src/plugin/bibtex.py` |

The registered schema holds an entry's type, title, authors, year, venue (its
`journal` or `booktitle`) and DOI; the citation key is not part of it. Every
text is normalized by dropping braces and collapsing whitespace, nothing else.
Title, author and year are required; a missing venue or DOI is null. An entry
that fails to parse, lacks a required field, sets a field twice or has both a
journal and a booktitle has no record, only its key and the reason. The rules
live in `src/plugin/schema.py`, mirrored in `verifier/schema.py`.

### Check BibTeX

`check-bibtex` takes the two files, staged as `inputs/reference.bib` and
`inputs/raw.bib`. Before the agent starts, NanoAgent runs `parse_bibtex` and
pins both files' records as `reference.json`; every reference entry must
parse. The agent reads both files with `read_bibtex` and submits a verdict for
every raw entry with `submit_verdicts`.

`verifier/parse.py` recomputes each exact match from the pinned records, offline:
`real` passes only for a raw record equal to a reference record in every field,
`hallucinated` only for one equal to none, and an entry with no record is no
match. Every raw entry needs exactly one verdict, and no other key may have
one. The score is the fraction of right verdicts; the check is valid only when
all are right. Sample files are in `tests/fixtures/`.

## Layout

```text
.
├── nanoagent.yaml   # manifest: id, runtime, permissions, tools, tasks
├── README.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── .gitignore
├── .env             # needed environment variable names (none here)
├── run.sh           # exits 0 when this environment can run the plugin
├── schemas/         # <tool>-input.json / <tool>-output.json, one pair per tool
├── src/plugin/      # the MCP server (__main__.py, its TOOLS table) and the tools
├── tests/           # tests, and sample inputs in fixtures/
└── verifier/        # deterministic verifier package, one module per tool
```

## Develop and run

```bash
uv sync --extra dev
uv run pytest
```

From the NanoAgent repository root:

```bash
uv run nanoagent plugin inspect plugins/bibtex-check
bash examples/bibtex_check/runs/step1_check_bibtex.sh  # agent: check tests/fixtures/raw.bib
```
