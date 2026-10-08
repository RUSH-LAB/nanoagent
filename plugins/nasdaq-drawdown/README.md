# Nasdaq-100 Weekly Drawdown

A `nanoagent.plugin/v1` plugin, created by `nanoagent plugin new` with the
structure of NanoAgent's reference plugin, `plugins/arxiv-source`. Its task,
`nasdaq-down-5`, asks an agent which Nasdaq-100 constituents fell by at least
5% over the week ending on a date.

## Tools

| Tool | Does | Code |
|---|---|---|
| `pin_week` | Every constituent's close on `as_of` and 5 sessions earlier; the task's pinned reference | `src/plugin/week.py` |
| `list_constituents` | The constituents Nasdaq lists now, and the week ending `as_of`: its first session (`start`) and every session | `src/plugin/week.py` |
| `get_closes` | Up to 25 tickers' closes on one trading session; a day a ticker did not trade fails | `src/plugin/week.py` |
| `submit_tickers` | Writes the answer to `tickers.json`, replacing an earlier one | `src/plugin/week.py` |

All data comes from Nasdaq's public API, `api.nasdaq.com`
(`src/plugin/nasdaq.py`): the constituent list
(`/api/quote/list-type/nasdaq100`) and daily history
(`/api/quote/<symbol>/historical`, `NDX` for the index). It needs no key, but
refuses clients without a browser-like User-Agent. The plugin waits 0.5 s
between requests; pinning a week takes one request per constituent, about five
minutes for 101.

### The week

The week is the 5 trading sessions ending on `as_of`: a constituent's change
is its close on `as_of` over its close 5 sessions earlier (`start`), minus 1.
Sessions are the Nasdaq-100 index's own trading days, so `as_of` must be one,
and a past day in New York (a session still trading has no final close); any
other date fails. A constituent with no close on either day fails the pin.

### Data caveats

- **Constituents are the current list.** Nasdaq publishes only today's
  Nasdaq-100 membership, so the pinned constituents are the list at pin time:
  `listed_at` is Nasdaq's stamp on the list (US Eastern) and `pinned_at` the
  pin time (UTC). For a past week, a company that joined or left the index
  since then is judged by today's membership.
- **Closes are split-adjusted, not dividend-adjusted.** Nasdaq rescales its
  history for splits (Apple's 5 Oct 2016 close comes back as $28.2625, the
  $113.05 traded close over its 2020 4:1 split), but not for dividends: a
  constituent that went ex-dividend during the week shows the dividend as a
  fall. The plan asked for adjusted closes; this source has no
  dividend-adjusted series, so the task uses these closes as they are.
- **History requests run to today.** Nasdaq serves a period chosen by the
  requested range's length and ending today, then cuts it to the range, so a
  range ending in the past can come back short. Every request asks from the
  day needed through today, and the index history must hold a session before
  the week, or the week fails.
- Stooq, the second source the plan named, now answers scripted clients with a
  JavaScript proof-of-work page instead of CSV, so the plugin does not use it.

### Verifier

`verifier/pin.py` recomputes every change from the pinned closes, in decimal
arithmetic: a constituent fell by at least 5% when its close on `as_of` is at
most 95% of its close at `start`. The answer in `tickers.json` must equal that
set. The score is the answer's F1 against it; the verdict is valid only at an
exact match. Details report the expected tickers with their changes, and the
missing, extra and non-constituent tickers.

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
├── .env             # environment variable NAMEs this plugin needs (none here)
├── run.sh           # exits 0 when this environment can run the plugin
├── src/plugin/      # the MCP server (__main__.py, its TOOLS table), the Nasdaq client and the tools
├── tests/
└── verifier/        # deterministic verifier package, one module per tool
```

`contract.py` types every value: the server builds each call's input into its
class and checks its output against its own, and NanoAgent and the verifier
get the same classes. `verifier/` imports only the standard library and
`contract`. Its input checks hold what a type cannot: dates are YYYY-MM-DD,
tickers are distinct Nasdaq symbols, and `get_closes` takes 1 to 25 of them.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
```

From the NanoAgent repository root:

```bash
.venv/bin/nanoagent plugin inspect plugins/nasdaq-drawdown
bash examples/nasdaq_drawdown/runs/step1_nasdaq_down_5.sh   # agent: the week ending 2026-10-02
```
