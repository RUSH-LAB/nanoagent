# Plan: the `nasdaq-drawdown` page (`plugins/nasdaq-drawdown/ui/`)

The plugin's own page, on the `nanoagent.ui/v1` bridge (`docs/plans/plugin-ui.md`). It replaces the
template's full-page chat with a page built for one question, with the chat moved into a drawer.

## 1. The user job

> "Which Nasdaq-100 stocks fell 5% or more over the week ending *this day*, and by how much? Can I
> trust the list?"

The user is an investor, analyst or curious reader. They don't know or care about tools, sessions,
`as_of`, or `tickers.json`. They pick a week, wait a few minutes, and get a short ranked list of
the stocks that fell, each with its company name, its change, and its two closing prices, plus a
plain-words statement that the list was checked against Nasdaq's prices.

What the plugin gives the page (from `nanoagent.yaml`, `contract.py`, `src/plugin/week.py`,
`verifier/pin.py`):

- One task, `nasdaq-down-5`, `runner: agent`, arguments `{"as_of": "YYYY-MM-DD"}`, no input files.
  `as_of` must be a Nasdaq-100 trading session and a past day in New York.
- Run order: `task.started` → `task.reference {tool: "pin_week"}` (then about 1 to 5 minutes with
  no events while every constituent's two closes are pinned) → `task.tool` for the agent's
  `list_constituents`, then about 9 `get_closes` calls (25 tickers each, start and as_of), then
  `submit_tickers` → `task.answer {text}` (a one-paragraph report) → `task.verdict` →
  `task.done`. No `task.result` (agent runner).
- `task.tool.output` is the tool's text: a JSON object with `ok: true` and the contract output
  (`ConstituentsOutput`, `ClosesOutput`, `SubmitOutput`). `isError` marks a failed call.
- `task.verdict`: `{valid, score, message, details}`. `details.expected` is always present:
  `{ticker: change_percent}` for exactly the pinned constituents that fell at least 5%,
  recomputed by the verifier in decimal arithmetic from the pinned closes. When not valid,
  `details.missing` `{ticker: pct}`, `details.extra` `{ticker: pct}` and
  `details.not_constituents` `[ticker]` say how the agent's answer differs.
- The workspace afterwards holds `tickers.json` (`{"tickers": [...]}`), replaced by each run. The
  pinned reference itself never reaches the page.

So the authoritative list and its percentages come from `task.verdict.details.expected`; company
names, the week's dates and the two closes per company come from the agent's tool outputs.

## 2. Layout

Wide (>= 900 px): one centered column, max 1040 px. The chat is a right-hand drawer, closed by
default.

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [icon] Nasdaq-100 Weekly Drawdown                                  [ Ask the agent ] │
│        See which Nasdaq-100 stocks fell 5% this week                                 │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ Pick a week ───────────────────────────────────────────────────────────────────┐ │
│ │ Week ending   [ Fri, Oct 2, 2026  📅 ]   ( Last full week ) ( Week before )      │ │
│ │ Compares each company's close that day with its close 5 trading days earlier.   │ │
│ │                                                         [  Find the fallers  ]  │ │
│ │ Takes about 5–10 minutes: every company is checked twice.                       │ │
│ └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│ ┌ Running ───────────────────────────────────────────────────── 3 min 12 s [Stop] ┐ │
│ │ ✓ Official prices pinned                                                        │ │
│ │ ✓ Week found            Fri Sep 25 → Fri Oct 2 · 101 companies                  │ │
│ │ ● Agent collecting prices   ███████████████░░░░░░░  150 of 202                  │ │
│ │ ○ Agent picks the fallers                                                       │ │
│ │ ○ Checking the answer                                                           │ │
│ └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│ ┌ Result ─────────────────────────────────────────────────────────────────────────┐ │
│ │  7 of 101 Nasdaq-100 stocks fell 5% or more                                     │ │
│ │  Week of Fri Sep 25 → Fri Oct 2, 2026                                           │ │
│ │  ┌──────────────────────────────────────────────────────────────────────────┐   │ │
│ │  │ ✓ Checked. The list matches Nasdaq's closing prices exactly.             │   │ │
│ │  └──────────────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                                 │ │
│ │  ALNY  Alnylam Pharmaceuticals   ██████████████  −14.16%   255.96 → 219.72      │ │
│ │  APP   AppLovin                  █████████████   −13.69%   310.75 → 268.22      │ │
│ │  WDC   Western Digital           █████████       −9.09%    456.81 → 415.29      │ │
│ │  QCOM  QUALCOMM                  ████████        −8.47%    201.97 → 184.87      │ │
│ │  STX   Seagate Technology        ███████         −7.40%    916.83 → 848.99      │ │
│ │  REGN  Regeneron                 ██████          −6.71%    788.04 → 735.20      │ │
│ │  NFLX  Netflix                   █████           −5.74%     71.15 →  67.06      │ │
│ │                                                                                 │ │
│ │  Just missed: KDP Keurig Dr Pepper −4.95%                                       │ │
│ │                                                                                 │ │
│ │  All 101 companies   −15%  ·  ·:·|·::::::::::::::·::·:·  · +10%   (strip)       │ │
│ │                                ^ −5% line                                       │ │
│ │  ▸ See all 101 companies (table)                                                │ │
│ │  ▸ The agent's summary                                                          │ │
│ │  ▸ About this data                                                              │ │
│ └─────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                      │
│ Recent weeks   ( Oct 2 · 7 fell ✓ )  ( Sep 25 · 2 fell ✓ )  ( Sep 18 · 0 fell ✓ )   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Narrow (< 640 px): everything stacks; the date chips wrap under the date input; the run button is
full width; each faller row becomes a two-line card; the drawer becomes a full-screen sheet.

```text
┌──────────────────────────────┐
│ [icon] Nasdaq-100 Drawdown 💬│
├──────────────────────────────┤
│ Week ending                  │
│ [ Fri, Oct 2, 2026      📅 ] │
│ (Last full week)(Week before)│
│ [     Find the fallers     ] │
├──────────────────────────────┤
│ 7 of 101 fell 5% or more     │
│ Sep 25 → Oct 2, 2026         │
│ ✓ Checked against Nasdaq's   │
│   closing prices             │
│ ┌──────────────────────────┐ │
│ │ ALNY            −14.16%  │ │
│ │ Alnylam ████████████████ │ │
│ │ 255.96 → 219.72          │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │ APP             −13.69%  │ │
│ │ …                        │ │
└──────────────────────────────┘
```

## 3. Components

All files are static in `ui/`: `index.html`, `app.js` (this page's layout, passed to
`mountApp`), `drawdown.js` (the plugin-only pieces below), `components.js` and `bridge.js`
(unchanged from the template), `style.css` (template tokens, overridden as in section 5),
`fonts/Inter-*.woff2` (CSP `font-src 'self'`, so Inter is bundled) and `demo/` (section 7).

### 3.1 Header

Icon (`plugin.product.icon`), `plugin.name`, `plugin.product.tagline`, from `describe`. On the
right, an "Ask the agent" button (an icon-only chat bubble below 640 px, with `aria-label`) that
opens the chat drawer (3.7).

### 3.2 Week picker

- A native `<input type="date">` labelled "Week ending", plus two chips: "Last full week" (the
  latest Friday before today in New York) and "Week before" (that Friday minus 7 days).
- Default value: the latest weekday before today in New York. "Today in New York" is computed with
  `Intl.DateTimeFormat("en-CA", {timeZone: "America/New_York"})`; today itself is never allowed
  (`past_day`: a session still trading has no final close). `max` is set to that default.
- Under the input, one plain line: "Compares each company's close that day with its close 5
  trading days earlier." Once a run reports the week, the line becomes "Fri Sep 25 → Fri Oct 2".
- Inline checks before running, each with a one-click fix:
  - Saturday or Sunday: "Markets are closed on weekends." [Use Fri, Oct 2]
  - Today or later: "That day's trading isn't over yet." [Use Thu, Oct 6]
  Holidays are not known to the page; the plugin rejects them within seconds (3.4 errors).
- The primary button, "Find the fallers", calls `runTask`. Below it: "Takes about 5–10 minutes:
  every company is checked twice. Keep this page open." While a run is on, the picker is disabled.
- Sends `{"task": "nasdaq-down-5", "arguments": {"as_of": "<the date>"}}`. The user never sees the
  argument name or JSON.

### 3.3 Progress card

Shown from `runTask` until `task.done`. A five-step list, a live elapsed timer, and Stop
(`cancel {runId}`). Built on the kit's `runControls` start/cancel logic, with its own view.

| Step | Becomes active on | Done on | Shows |
|---|---|---|---|
| Pinning official prices | `task.started` / `task.reference` | the first `task.tool` | indeterminate bar, "Fetching every company's closing prices from Nasdaq (a few minutes)" |
| Week found | the first `task.tool` | `list_constituents` (ok) | "Fri Sep 25 → Fri Oct 2 · 101 companies" from its `start`, `as_of`, `constituents.length` |
| Agent collecting prices | first `get_closes` | `submit_tickers` | determinate bar: tickers received over `2 × constituents` |
| Agent picks the fallers | `submit_tickers` | `task.answer` | "Picked 7 stocks" from `SubmitOutput.tickers` |
| Checking the answer | `task.answer` | `task.verdict` | — |

The step labels avoid tool names. A `task.tool` with `isError` (for example a ticker
that did not trade that day) adds a muted line "Nasdaq had no price for XYZ; the agent retried"
under the active step, and does not fail the run. `aria-live="polite"` announces step changes,
not every tick.

### 3.4 Result card

Built when `task.verdict` arrives (never before). Data:

- **Fallers**: `verdict.details.expected`, sorted by change, most negative first. This is the
  verifier's own recomputation from the pinned prices, so it is the list shown whether or not the
  agent got it right.
- **Names, closes, week dates**: joined by ticker from the agent's `list_constituents` output
  (`name`, `start`, `as_of`) and `get_closes` outputs (the close whose `date` is `start`, and the
  one whose `date` is `as_of`). Names drop Nasdaq's share-class suffix for display ("Apple Inc.
  Common Stock" → "Apple Inc."); the full name is the row's `title`.

Parts:

1. **Headline**: "7 of 101 Nasdaq-100 stocks fell 5% or more" (or "None of the 101 … fell 5% or
   more this week" for an empty `expected`), and the week "Fri Sep 25 → Fri Oct 2, 2026".
2. **Verdict banner** (3.5).
3. **Faller list**: one row per faller: ticker (mono, bold), short name, a horizontal bar whose
   length is the fall over the largest fall in the list, the change ("−14.16%", from `expected`,
   two decimals, true minus sign), and "255.96 → 219.72". Rows are a `<table>` on wide screens and
   cards on narrow ones. A row the agent missed carries a small "Agent missed this" tag; that only
   happens when the verdict is not valid.
4. **Just missed**: up to 3 constituents with a change between −5% and −4%, computed from the
   agent's closes, labelled "Just missed". Omitted when there are none.
5. **All-companies strip**: a one-line dot plot of every constituent's change (agent's closes),
   with a dashed line at −5% and the fallers' dots in the decline color; hover/focus shows ticker
   and change. Caption: "From the prices collected during this run."
6. **"See all 101 companies"** (`<details>`): a sortable table (ticker, company, close on start,
   close on as_of, change) with a filter box; fallers highlighted. Sorted by change by default.
7. **"The agent's summary"** (`<details>`): `task.answer.text` as prose.
8. **"About this data"** (`<details>`), the README's caveats in plain words:
   - "Membership is today's Nasdaq-100 list, also for past weeks."
   - "Prices are adjusted for stock splits, not dividends: a stock that paid a dividend that week
     shows it as a small fall."
   - "Source: Nasdaq (api.nasdaq.com). List stamped Oct 6, 2026 3:26 PM ET." (`listed_at` from
     `list_constituents`).

### 3.5 Verdict banner

Plain words from `task.verdict`, never the raw `message` as the headline (it is shown smaller
under "Details").

| Verdict | Banner |
|---|---|
| `valid: true` | Green check. "Checked. The list matches Nasdaq's closing prices exactly." |
| `valid: false`, `details.missing`/`extra`/`not_constituents` present | Amber. "The agent's list was off. Shown above is the corrected list, recomputed from Nasdaq's prices." Then one line each when non-empty: "It missed: KDP (−5.00%)", "It wrongly included: GILD (−4.10%)", "Not in the Nasdaq-100: NVDA". Then "Match score 80%" (`score` as a percent, F1). |
| `valid: false`, no differences (no answer file, wrong week) | Red. "The agent did not finish its answer, so it could not be checked." The corrected list above still comes from `details.expected`, labelled "From Nasdaq's prices". |

A "Details" disclosure shows `message` and the raw `details` for those who want it.

### 3.6 Recent weeks

So a returning user sees what they already looked up. After a verdict, the page writes
`drawdown-weeks/<as_of>.json` with `workspace.write`: `{as_of, start, listed_at, ran_at, verdict:
{valid, score}, expected, constituents: [{ticker, name, start_close, end_close}]}` (the joined data
the result card used). On load, `workspace.list` → paths under `drawdown-weeks/` →
`workspace.read` of the latest 8 → chips "Oct 2 · 7 fell ✓". Clicking a chip renders that week's
result card from the file, with "Saved on Oct 6, 9:31 PM" and a "Run again" button; no run starts.
Running a week that already has a file replaces it. Hidden when there are none.

### 3.7 Chat drawer

The kit's `chatPanel` inside a drawer (right side, 380 px; full-screen sheet below 640 px; Esc and
a close button close it; focus is trapped while open and returns to the opener). The intro reads
"Ask about Nasdaq-100 prices, for example a company's close on a day." Suggestion chips fill the
input, using the current week when there is one: "Which stocks rose the most the week ending Oct
2?", "What did NVDA close at on Oct 2?". The conversation lives for the page's lifetime (host
behavior); closing the drawer keeps it. A chat turn and a task run can be in flight at the same
time; they have different `runId`s.

## 4. Bridge calls and events

| Call / event | Used by |
|---|---|
| `describe` | header (name, tagline, icon), theme, `workspace.id` |
| `host.theme` | theme switch |
| `runTask {task: "nasdaq-down-5", arguments: {as_of}}` | week picker |
| `task.started`, `task.reference` | progress steps |
| `task.tool` (`list_constituents`, `get_closes`, `submit_tickers`; `output` parsed with `JSON.parse`) | progress, week dates, names and closes for the result |
| `task.answer` | "The agent's summary", progress |
| `task.verdict` | result card, verdict banner |
| `task.error` | error card (below) |
| `task.done` | ends the run: stops the timer, re-enables the picker, writes the recent-week file |
| `cancel {runId}` | Stop |
| `prompt` and `chat.*` | chat drawer |
| `workspace.list`, `workspace.read`, `workspace.write` | recent weeks |

The page does not read `tickers.json`: everything it needs is in the events.

## 5. Look

- Tokens over the template's `style.css`: `--accent: #3b5998` (dark `#8ea6d6`), `--sans: Inter,
  …`, `--radius: 16px` for cards (20 px for the result card, 999 px for chips), soft 1 px borders.
- Change colors are separate from the accent: decline `--down` `#c42b1c` / dark `#ff7b6e`, rise
  `--up` `#1a7f37` / dark `#5cc97a`; amber for the "off" banner `#9a6700` / dark `#e3b341`, each
  with a `-soft` background. A change is never shown by color alone: it always carries its signed
  number, and the verdict banner carries an icon and words.
- Numbers use `font-variant-numeric: tabular-nums` and right alignment so changes line up.
- Both themes come from `html[data-theme]` (`describe`, `host.theme`); the strip chart and bars use
  CSS variables only, so they switch with the theme.
- Widths: the layout is fluid from 320 px. Breakpoints at 640 px (cards, sheet drawer) and 900 px
  (drawer beside the content instead of over it).

## 6. States and edge cases

- **Loading**: `mountApp`'s "Connecting…", then the picker with its default date. A host that does
  not answer `describe` gets the kit's fatal message.
- **Empty (first visit)**: picker, plus a short "How it works" row from `product.steps` (three
  numbered items). No result card.
- **Running**: progress card; the picker is disabled; the result area shows a skeleton of the
  headline. Leaving the page during a run is the host's business; the page says "Keep this page
  open".
- **Stopped**: `cancel` → `task.error {message: "cancelled"}` → "Stopped. Nothing new was saved."
  with "Run again". The progress card stays, frozen, so the user sees how far it got.
- **Errors**: `task.error.message` is matched against the plugin's known messages; the raw text is
  always under "Technical details".

  | Message contains | Shown |
  |---|---|
  | `is not a Nasdaq-100 trading session` | "Markets were closed on Mon, Sep 7 (a holiday?). Pick another day." with the previous weekday as a one-click fix |
  | `is not a past day in New York` | "That day's trading isn't over yet. Pick an earlier day." |
  | `index history before` … `too short` | "Nasdaq can't give enough history for that week. Try a more recent week." |
  | `Nasdaq has no close for` (during the pin) | "Nasdaq has no price for XYZ that week, so the week can't be checked." |
  | `Nasdaq refused`, network or timeout errors | "Couldn't get prices from Nasdaq. Try again in a minute." |
  | `invalid input` (from `runTask`'s reply error) | "That date isn't valid." |
  | anything else | "Something went wrong." |

  An error before `task.verdict` shows no result card. `runTask` itself failing (host refuses)
  shows the same card with "Couldn't start".
- **Verdict without names or closes** (the agent failed before `list_constituents` or skipped
  `get_closes`): the faller list still renders from `details.expected` with tickers and changes
  only; the closes column, "Just missed", the strip and the table are hidden, with "Prices from
  this run are incomplete" in their place. Nothing is guessed.
- **No fallers**: "None of the 101 Nasdaq-100 stocks fell 5% or more that week." plus the strip and
  "Just missed" so the user still sees the week.
- **Exactly −5.00%**: counts as a fall (the verifier's `end <= start × 0.95`); the row shows
  "−5.00%". "Just missed" uses the agent's closes with the same rule, so KDP at exactly −5% never
  appears there.
- **Many fallers** (a crash week, say 60): the list shows the first 15 and "Show all 60".
- **Long names**: truncated with an ellipsis; the ticker never truncates.
- **A second run**: the old result stays, dimmed, under the progress card until the new verdict
  replaces it.

## 7. Previews without the network

Pages are previewed with no Nasdaq access. `ui/demo/` holds a recorded event stream,
`week-2026-10-02.json`: `[{event, data, delayMs}]`, built once from the real run in
`examples/nasdaq_drawdown/outputs/step1_nasdaq_down_5/` (its `messages.json` gives the
`task.tool` and `task.answer` events, `verdict.json` the `task.verdict`), and a small one,
`fallers-off.json`, from `tests/test_verifier.py`'s `REFERENCE` (ALNY −14.16%, KDP −5.00%, GILD
−4.10%, AAPL up) with the answer `["ALNY", "KDP", "GILD"]` to show the "off" banner, plus one
`task.error` stream per error row in section 6. Opening `index.html#demo=<name>` replays that
stream through the same event handler with `delayMs` compressed, and shows a "Demo data" ribbon.
Without the hash the page only uses the host; there is no silent switch to demo data.

## 8. Kit versus plugin

Generic, belongs in `components.js` for other pages: a run card with staged steps, elapsed time,
Stop and a plain-words verdict badge; a chat drawer wrapping `chatPanel`; an error card that maps
known messages and keeps the raw text; a "saved runs" strip on a workspace folder; a sortable,
filterable table; a demo replay of a recorded `task.*` stream.

Plugin only (`drawdown.js`): the week picker with New York date rules, the faller list with bars,
the change strip chart, the join of `list_constituents`/`get_closes`/`verdict` data, and the
verdict wording.
