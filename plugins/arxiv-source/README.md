# arXiv Search and Source Downloader

NanoAgent's built-in reference plugin: the `nanoagent.plugin/v1` contract,
and the structure `nanoagent plugin new` gives every new plugin. The
plugin is a standard MCP server over stdio; NanoAgent owns its launch command,
environment, schema validation and lifecycle.

## Tools

| Tool | Does | Code |
|---|---|---|
| `search_papers` | Searches arXiv (`export.arxiv.org/api/query`) and returns each match's id, title, authors, abstract and date, best match first | `src/plugin/search.py` |
| `download_source` | Downloads one paper's source archive (`/e-print/<id>`) and unpacks it safely into a new workspace folder | `src/plugin/download.py` |
| `save_search_results` | Searches, then downloads and unpacks every result into `<destination>/<arxiv id>/`, waiting 3 s between arXiv requests | `src/plugin/save.py` |
| `list_daily_papers` | For each person, the papers first submitted on a date (`au:"<name>" AND submittedDate:[…]`); the daily digest's pinned reference | `src/plugin/daily.py` |
| `save_raw_paper` | Saves one paper's source under `docs/raw/{first_author_name}-{paper_short_name}-{arxiv_id}-{date}` | `src/plugin/daily.py` |
| `write_digest` | Writes the digest as `docs/digest-{date}.json` and `.md` | `src/plugin/daily.py` |

Queries use arXiv's search syntax, e.g. `ti:"attention is all you need"` or
`au:vaswani AND cat:cs.CL`. Tasks: `search-papers`, `save-paper-source` and
`save-search-results` each run one tool. `find-and-save-paper` gives an agent
both `search_papers` and `download_source`, so it can pick the right result
itself.

### Daily digest

`daily-digest` takes a list of people and a date. Before the agent starts,
NanoAgent runs `list_daily_papers` and pins the result, the ground truth, as
`reference.json`. The agent then gets `search_papers`, `save_raw_paper` and
`write_digest`. It finds each person's papers first submitted (v1) on that UTC
date, saves each one's source, and writes one entry per paper: the id
(`YYMM.NNNNN`), the title and authors exactly as arXiv lists them, a two-line
summary in its own words, and `https://arxiv.org/abs/<id>`.

`verifier/daily.py` checks the digest against the pinned listing, offline. It
approves only when every listed paper is an exact entry and has its source in
`docs/raw/{first_author_name}-{paper_short_name}-{arxiv_id}-{date}`. An entry
for a paper not in the listing fails, and so does a paper that was published
but not saved. The folder name uses the first author's last name and the
title's first four words, each lowercased ASCII joined by `-`; the rule lives
in `src/plugin/naming.py`, mirrored in `verifier/naming.py`. The summary's
quality is not checked, only that it has two lines.

## Layout

It has the standard plugin layout, which NanoAgent requires:

```text
.
├── nanoagent.yaml   # manifest
├── README.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── .gitignore
├── .env             # needed environment variable names (none here)
├── run.sh           # checks this environment can run the plugin
├── schemas/         # <tool>-input.json / <tool>-output.json
├── src/plugin/      # the MCP server and its tools
├── tests/
└── verifier/        # deterministic verifier package, one module per tool
```

`verifier/` is deterministic: it imports only `re` and `pathlib`, and checks
inputs (arXiv ids, queries, result counts, destinations) and outputs. For
outputs it checks that the papers are well formed and unique and within
`max_results`, that every folder is the requested one inside the workspace,
and that its files are exactly the declared ones.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
```

NanoAgent passes the folder the plugin may write to as `NANOAGENT_WORKSPACE`;
`destination` is a new folder inside it. It is built into NanoAgent; run it
from the NanoAgent repository root:

```bash
uv run nanoagent plugin inspect plugins/arxiv-source
bash examples/arxiv_source/runs/step1_save_paper_source.sh    # one paper by id
bash examples/arxiv_source/runs/step2_search_papers.sh        # search only
bash examples/arxiv_source/runs/step3_save_search_results.sh  # search, fetch, save
bash examples/arxiv_source/runs/step4_daily_digest.sh         # agent: the daily paper digest
```
