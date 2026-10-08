# Plan: plugins for the daily tasks (docs/paper/tasks.md)

Task 2 (Daily Paper Digest) is done: `plugins/arxiv-source`, task `daily-digest`. This plan covers
tasks 1, 3, 4 and 5. Every plugin follows the `nanoagent.plugin/v1` rules
(`nanoagent.plugin.manifest`) and starts from `nanoagent plugin new`. Every task's ground truth is
pinned by a reference tool before the agent starts. `verify_task` checks the outcome against it
offline, deterministically, with the standard library only.

## Shared NanoAgent changes (first)

1. **File inputs.** `PluginRunConfig` / `PluginAgentConfig` get `inputs: list[str]`. NanoAgent copies
   each file into the run folder's `inputs/` before the task, and arguments refer to them as
   `inputs/<name>`, so the run folder holds everything it was judged on.
2. **Image tool results** (chess). A tool result can carry a PNG, sent to Bedrock Converse as an
   `image` content block.
3. **One plugin process per task run** (chess). The MCP session lives for the whole task, so a
   plugin can keep a browser and a game between calls; `run.sh` runs once per task.

## Task 1: `bibtex-check`

- Inputs: `reference.bib`, `raw.bib` (via `inputs:`).
- Reference tool `parse_bibtex(reference, raw)`: parses both with `bibtexparser` into the registered
  schema and pins the records; an entry that fails to parse is recorded as unparseable.
- Registered schema: entry type, title, authors, year, venue, DOI. The citation key is ignored.
  Normalization: collapse whitespace and drop braces, nothing else.
- Agent tools: `read_bibtex(path)`, `submit_verdicts(verdicts)` (writes `verdicts.json`: one `real`
  / `hallucinated` per raw entry key).
- `verify_task`: recompute each exact match from the pinned records. `real` passes only on an exact
  match, `hallucinated` only on no match, and an unparseable entry is no match. Score: fraction of
  correct verdicts; valid only at 100%.

## Task 3: `nasdaq-drawdown`

- Arguments: `as_of` (YYYY-MM-DD).
- Sources: Nasdaq's constituent list (`api.nasdaq.com`), Stooq daily CSVs (`stooq.com`, no key).
- Past week: close-to-close over the 5 trading sessions ending `as_of`, on adjusted closes.
- Reference tool `pin_week(as_of)`: the constituents, and each one's close on `as_of` and 5
  sessions earlier.
- Agent tools: `list_constituents(as_of)`, `get_close(ticker, date)`, `submit_tickers(tickers)`.
- `verify_task`: recompute every change from the pinned closes. The agent's list must equal the
  set of tickers that fell at least 5%. Score: F1 against that set; valid only at an exact match.

## Task 4: `chess-move` (on mind-sports-arena)

- Builds on `../mind-sports-arena`: board page, headless browser over CDP, screenshots, mouse
  drags, Stockfish, win-probability scoring (`msa.score`).
- `.env` declares `MSA_ROOT`. `run.sh` checks Stockfish is built (`sandbox.sh`), `node_modules`
  is present and a Chromium binary exists.
- Arguments: `fen`, the starting position.
- Reference tool `pin_moves(fen)`: Stockfish scores every legal move (fixed nodes, one thread, so
  deterministic) and pins each move's resulting position and win probability.
- Agent tools: `screenshot()` (image), `drag(from_xy, to_xy)`, `click(xy)`, on msa's CDP mouse.
  Every action records the engine-reported position to `workspace/board.json`.
- `verify_task`: match the final position against the pinned ones to find the move. No move, an
  illegal move, or more than one move fails. Report its strength as the win-probability loss
  against the best move; score is 1 minus the loss.
- If msa's chess app cannot start from a FEN, add that to msa; otherwise start from the opening.

## Task 5: `meal-suggestion`

- Inputs: `ingredients.json` (nutrition per 100 g), `recipes.json` (ingredients per serving and
  tags such as `vegetarian`, `dairy`), via `inputs:`. Sample data ships in `tests/fixtures/`.
- Arguments: the meal, nutrition constraints, the food preference and one objective (for example
  maximize protein, minimize kcal). The preference is a hard filter on recipe tags.
- Reference tool `solve(...)`: HiGHS (SciPy) MILP over whole servings; pins the optimum plan, its
  objective value and each recipe's nutrition.
- Agent tools: `list_recipes(preference)`, `nutrition(recipe)`, `submit_meal(dishes)`.
- `verify_task`: recompute the suggestion's totals; every constraint and the preference must hold.
  Score: the suggestion's objective over the pinned optimum.

## Execution

1. Make shared change 1, then build tasks 1, 3 and 5 in parallel, one agent each.
2. Make shared changes 2 and 3, then build task 4.
3. Each agent works only in `plugins/<id>/` and `examples/<id>/`. It must pass `plugin inspect`,
   the plugin's tests and ruff, and do one live `nanoagent plugin agent` run (Opus 5.5, Bedrock).
4. Integrate: README, the reference-plugin conformance test, and the full test suites.

## Status (2026-10-06)

All four built; every live run (Opus 5.5 on Bedrock) was valid at score 1.00.

| Task | Plugin | Example | Live result |
|---|---|---|---|
| 1 | `plugins/bibtex-check` | `examples/bibtex_check` | 9/9 verdicts right |
| 3 | `plugins/nasdaq-drawdown` | `examples/nasdaq_drawdown` | the 7 tickers down ≥5% on 2026-10-02 |
| 4 | `plugins/chess-move` | `examples/chess_move` | played the pinned best move |
| 5 | `plugins/meal-suggestion` | `examples/meal_suggestion` | the pinned optimum |

Departures from this plan, found while building:

- Task 3: Stooq now serves a JavaScript proof-of-work page to scripted clients, so every price
  comes from `api.nasdaq.com`. Its closes are split-adjusted but not dividend-adjusted, and its
  constituent list is today's, so a past week is judged by today's membership. `get_closes` takes
  up to 25 tickers per call. `pin_week` makes about 100 requests, so the example's `timeout` is
  900 s.
- Task 4: msa's chess app now starts from a FEN (`msa/engines.py`, uncommitted in msa). The board
  runs `driven`, so the engine never replies to the agent's move. `.env` declares nothing: the
  plugin finds msa, Stockfish and Chrome itself.
- Task 5: a meal needs at least one dish; valid means feasible plus the preference, and the score
  is total / optimum (maximize) or optimum / total (minimize).
- Task 1: title, author and year are required fields; an entry missing one is unparseable.
