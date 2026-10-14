# BibTeX Hallucination Check

Checks BibTeX entries, such as a bibliography an LLM wrote, against verified
reference entries. Each entry is `real` when it exactly matches a reference,
`fixable` when it is close to one but differs in some fields, `invented` when
it is close to none, and `unreadable` when it does not parse. It reads only
the BibTeX text it is given and needs no network.

## Tools

| Tool | Does | Code |
|---|---|---|
| `parse_bibtex` | Parses the reference and the raw text into the registered schema; the `check-bibtex` task's pinned reference | `src/plugin/bibtex.py` |
| `read_bibtex` | Reads one BibTeX text's entries in the registered schema | `src/plugin/bibtex.py` |

The registered schema holds an entry's type, title, authors, year, venue (its
`journal` or `booktitle`) and DOI; the citation key is not part of it. Every
text is normalized by dropping braces and collapsing whitespace, nothing else.
Title, author and year are required; a missing venue or DOI is null. An entry
that fails to parse, lacks a required field, sets a field twice or has both a
journal and a booktitle has no record, only its key and the reason. The rules
live in `src/plugin/schema.py`, mirrored in `verifier/schema.py`.

### Check BibTeX

`check-bibtex` takes the reference and the raw BibTeX as text, as a person
pastes them into the chat. Before the agent starts, NanoAgent runs
`parse_bibtex` and pins both texts' records; every reference entry must parse.
The agent reads both with `read_bibtex` and submits a `CheckOutput`: one
verdict per raw entry, in order, with its title, label, closest reference and
the fields that differ from it.

The closest reference shares the most fields with the entry, then the title or
a DOI, then comes first; it is close when it shares the title, a DOI or at
least four of the six fields. `verifier/parse.py` recomputes every verdict from
the pinned records, offline, and every field of each must be right. Every raw
entry needs exactly one verdict, in the raw text's order, and no other key may
have one. The score is the fraction of right verdicts; the check is valid only
when all are right. Sample files are in `tests/fixtures/`.

The chat draws the verdicts with `ui/renderers.js`: a count per label, then a
table of the entries with each one's label, closest reference and what to fix.

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
├── .env             # needed environment variable names (none here)
├── run.sh           # exits 0 when this environment can run the plugin
├── src/plugin/      # the MCP server (__main__.py, its TOOLS table) and the tools
├── tests/           # tests, and sample inputs in fixtures/
├── ui/              # renderers.js and renderers.css: how the chat draws the verdicts
└── verifier/        # deterministic verifier package, one module per tool
```

`contract.py` types every value: the server builds each call's input into its
class and checks its output against its own, and NanoAgent and the verifier
get the same classes. A record's missing venue or DOI is `null`, as is an
entry's record when it has none. `verifier/` imports only the standard library
and `contract`.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
```

From the NanoAgent repository root:

```bash
uv run nanoagent plugin inspect plugins/bibtex-check
bash examples/bibtex_check/runs/step1_check_bibtex.sh  # agent: check tests/fixtures/raw.bib's text
```
