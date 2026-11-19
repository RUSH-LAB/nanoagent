# Managing nanoagent

What the `/manager` skill's manager (`nanoagent/manager`) needs to know about
this repo, on top of `AGENTS.md` and `helpinghands/AGENTS.md`. `devmode` is
where work lands; `production` is what Railway deploys.

## Pieces

Split a goal along the parts the repo already has:

| Part | Where | Done when |
|---|---|---|
| NanoAgent | `nanoagent/src/nanoagent/`, with tests in `nanoagent/test/` | in `nanoagent/`: `uv run ruff check .`, `uv run pytest -q` |
| NanoAgent clients | `nanoagent/js/client/`, `nanoagent/js/pi-runner/` | `npm ci && npm test` in each; the client's `src/*.generated.ts` unchanged by it |
| Example | `nanoagent/examples/<name>/`, `stepN_` files, config in YAML | its run script `runs/stepN_<name>.sh` succeeds and writes its layout's outputs |
| RUSH | `helpinghands/src/` (site, server, relay in `src/runner/`) | in `helpinghands/`: `npm test`, `npm run build`, `npm run nanoagent:verify` |
| Plugin | `helpinghands/plugins/<name>/` | the RUSH checks, and the plugin's own `uv run pytest` where it has one; its verifier is deterministic code |
| Desktop app | `helpinghands/desktop/` | RUSH Lab Dev built and checked (below) |
| Paper | `docs/paper/<name>/` | `latexmk -pdf paper.tex` with no errors or undefined citations, then `latexmk -c` |

## Review

Reject a piece that adds a fallback, `argparse`, a model as verifier, or a
dependency outside `uv`. Never run `npm run test:postgres` against the local
`mochi` copy or production.

## Done

A change to NanoAgent, the relay or the plugin page kit is done only once the
desktop app is rebuilt with it: run `npm start`, then `npm run desktop:dev`,
both in `helpinghands/`, and check the change in the `RUSH Lab Dev` window. Say
exactly what you saw. Never push to `devmode` or `production` and never run
`npm run db:push` unless the user asks.
