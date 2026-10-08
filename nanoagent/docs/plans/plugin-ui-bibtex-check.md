# Plan: the BibTeX Hallucination Check page (`plugins/bibtex-check/ui/`)

The plugin's own page, replacing the template's full-page chat. It runs on the `nanoagent.ui/v1`
bridge only (docs/plans/plugin-ui.md) and is built from `components.js` blocks plus a few of its
own.

## 1. The user job

> "An AI wrote my bibliography. Tell me which citations are fake or wrong before I submit, and
> show me exactly what is off."

The user is a researcher or student with two files: the `.bib` an LLM produced and a `.bib` they
trust (exported from Zotero, Google Scholar, a past paper). They want, in one click: a list of
the bad entries first, and for each one what differs (year, an extra author, a swapped DOI digit,
a made-up paper, or an entry that does not even parse), with proof that the answer was checked.

They never see tool names (`parse_bibtex`, `read_bibtex`, `submit_verdicts`), JSON, file paths
or the words "schema" and "record".

## 2. What the plugin actually does (the facts the page is built on)

- One task, `check-bibtex` (runner `agent`), input `ParseInput {reference, raw}`: two workspace
  paths. The page uses `inputs/reference.bib` and `inputs/raw.bib`, as the example does.
- Before the agent: NanoAgent emits `task.reference {tool: "parse_bibtex"}` and parses both files
  in a scratch folder. If any **reference** entry fails to parse, or either file has a key twice,
  or a block is not an entry with a key, the run ends with `task.error` (message like
  `ValueError: reference entries do not parse into the schema: a, b` or
  `ValueError: raw.bib has these keys twice: x`) and then `task.done`.
- The agent calls `read_bibtex` on each file. Each call arrives as
  `task.tool {name: "read_bibtex", arguments: {path}, output, isError}`; `output` is a JSON
  string `{"ok": true, "path", "entries": [{key, record|null, error|null}]}` where `record` is
  `{entry_type, title, authors[], year, venue|null, doi|null}`, already normalized (braces
  dropped, whitespace collapsed). An entry with `record: null` has `error` beginning
  `unparseable: ...` or `not in the schema: missing year` / `has a field twice` /
  `has both a journal and a booktitle`.
- The agent calls `submit_verdicts` (`arguments.verdicts`: key -> `real` | `hallucinated`); it
  writes `verdicts.json` at the workspace root. It may call it more than once; the last wins.
- `task.answer {text}`: a one-paragraph report naming each hallucinated entry and what differs.
- `task.verdict {valid, score, message, details}` from the offline verifier:
  - valid: `message` "all N verdict(s) are right", `details.expected` key -> true label.
  - not valid: `message` "K verdict(s) fail the check", `score` = fraction right,
    `details.problems` key -> "no verdict" | "verdict X is wrong: the entry is Y" |
    "not a raw entry" | "verdict 'x' is not real or hallucinated". Or, with no verdicts file,
    `message` "no verdicts at verdicts.json", `score` 0, no details.
- `real` means equal to some reference entry in all six fields; the citation key never matters.

## 3. Layout

### Wide (>= 900 px)

```
+--------------------------------------------------------------------------------------------+
| [icon] BibTeX Hallucination Check                                     [ Ask the checker  ] |
|        Catch hallucinated citations before they ship                                       |
+--------------------------------------------------------------------------------------------+
| +-------------------------------------------+  +-----------------------------------------+ |
| | 1  Bibliography to check                  |  | 2  References you trust                 | |
| |    The .bib an AI model wrote             |  |    Your verified .bib (Zotero, Scholar) | |
| |  +-------------------------------------+  |  |  +-----------------------------------+  | |
| |  |   Drop a .bib file here             |  |  |  |  refs.bib            6 entries  x |  | |
| |  |   or  [Choose file]  [Paste text]   |  |  |  |  12.4 KB                          |  | |
| |  +-------------------------------------+  |  |  +-----------------------------------+  | |
| |  Use a file already in your workspace v   |  |  Use a file already in your workspace v | |
| +-------------------------------------------+  +-----------------------------------------+ |
|                                                                                            |
|   [  Check 9 entries  ]     Try it with sample files                                       |
|   Runs offline. Compares type, title, authors, year, venue and DOI.                        |
+--------------------------------------------------------------------------------------------+
| RESULT                                                                                     |
| +--------------------------------------------------------------------------------------+   |
| |  6 of 9 entries look hallucinated                                                    |   |
| |  [ 6 Hallucinated ] [ 3 Real ] [ 1 of them unreadable ]                              |   |
| |  (check) Verified: every verdict was re-checked against your references.             |   |
| +--------------------------------------------------------------------------------------+   |
|   Show: (All 9) (Hallucinated 6) (Real 3)                        [ Save report ]           |
|                                                                                            |
| +--------------------------------------------------------------------------------------+   |
| | HALLUCINATED  bert                                                                    |  |
| | BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding      |  |
| | Devlin, Chang, Lee, Toutanova . 2018 . Proc. NAACL-HLT 2019                           |  |
| |   Closest reference: devlin2019bert                                                   |  |
| |   Year      2018            ->  reference says 2019                                   |  |
| +--------------------------------------------------------------------------------------+  |
| | HALLUCINATED  vaswani_attention                                                       |  |
| |   DOI       10.48550/arXiv.1706.037[26]  ->  10.48550/arXiv.1706.037[62]              |  |
| +--------------------------------------------------------------------------------------+  |
| | HALLUCINATED  gradient_folding                                                        |  |
| |   Not in your references: nothing similar was found. Likely invented.                 |  |
| +--------------------------------------------------------------------------------------+  |
| | HALLUCINATED  kingma_broken                                                           |  |
| |   Could not be read: the entry is malformed (unbalanced brace near the title).        |  |
| +--------------------------------------------------------------------------------------+  |
| | REAL  transformer                       Matches vaswani2017attention exactly          |  |
| +--------------------------------------------------------------------------------------+  |
|                                                                                            |
|   > The checker's summary  (collapsed: task.answer paragraph)                              |
+--------------------------------------------------------------------------------------------+
```

The chat drawer slides in from the right (400 px) over the result column when "Ask the checker"
is pressed; the page behind stays scrollable.

### Narrow (< 640 px)

```
+------------------------------+
| [icon] BibTeX Check     [?]  |   [?] = Ask the checker (icon button with label for AT)
+------------------------------+
| 1 Bibliography to check      |
| [ Drop or choose .bib ]      |
| 2 References you trust       |
| [ refs.bib  6 entries   x ]  |
| [   Check 9 entries   ]      |
| Try it with sample files     |
+------------------------------+
| 6 of 9 look hallucinated     |
| (check) Verified             |
| (All)(Halluc. 6)(Real 3)     |
+------------------------------+
| HALLUCINATED  bert           |
| BERT: Pre-training of ...    |
| Year                         |
|   yours      2018            |
|   reference  2019            |
+------------------------------+
```

Input cards stack; diff rows switch from "yours -> reference" on one line to two stacked lines;
the chat drawer becomes a full-screen sheet with a close button; filter chips scroll
horizontally. 640-900 px: input cards side by side, result full width, drawer overlays.

## 4. Components

### 4.1 Header

Icon, name and tagline from `describe().plugin` (catalog entry; `product/product.yaml` copy).
Right: "Ask the checker" button opening the chat drawer (4.7). Theme: `applyTheme(describe().theme)`
then `on("host.theme", ...)`.

### 4.2 File cards ("Bibliography to check", "References you trust")

Each card is a **file drop zone** with three ways in, all ending in one `workspace.write`:

| Way | Does |
|---|---|
| Drop / Choose file | Reads the file with `FileReader.readAsText` (UTF-8), writes `{path, text}` |
| Paste text | Expands a textarea; "Use this text" writes it |
| Use a file already in your workspace | A menu of `workspace.list()` files ending in `.bib`; picking one reads it with `workspace.read` and writes it to the card's path (so the task's two paths stay fixed) |

Paths: raw card -> `inputs/raw.bib`, reference card -> `inputs/reference.bib`. The write happens
when the file is chosen, not at run time, so the card can show the chosen state immediately and
a write failure shows on the card it belongs to.

Chosen state: file name (the user's original name, kept in page memory), size (`formatSize`),
"N entries" and a remove (x) button that clears the card (no workspace delete exists; the stale
file is simply not used until replaced, and the Check button is disabled while a card is empty).

Entry count: lines matching `^\s*@(?!comment|string|preamble)\w+\s*\{` (case-insensitive). It is
shown as "about N entries" only before the first run; after a run the cards show the parser's
exact count from `read_bibtex` output. It only labels the card and the button, never decides
anything.

Validation before upload, shown inline on the card: not UTF-8 text (FileReader error or
U+FFFD present) -> "This doesn't look like a text .bib file"; zero entries -> "No BibTeX entries
found in this file"; over 5 MB -> "This file is too large to check here".

On load, if `workspace.list()` already has `inputs/raw.bib` / `inputs/reference.bib`, the cards
show them as chosen ("from your workspace") so a returning user can re-run at once.

"Try it with sample files": writes the two fixtures (`tests/fixtures/raw.bib`,
`reference.bib`, copied into `ui/samples.js` as string constants, since `.bib` is not an allowed
`ui/` file type) to the two paths and fills both cards. Sample names show as
"sample-ai.bib" / "sample-references.bib".

### 4.3 Check button and run progress

Primary button: "Check N entries" (N = the raw card's count; "Check bibliography" while unknown).
Disabled until both cards are filled; a hint under it says which one is missing.

Click -> `startRun("runTask", {task: "check-bibtex", arguments: {reference: "inputs/reference.bib",
raw: "inputs/raw.bib"}}, onEvent)`. While running, the button becomes "Cancel" (`cancel {runId}`)
and a **step tracker** replaces the result area:

| Step (user words) | Becomes active on | Done when |
|---|---|---|
| Reading your references | `task.started` / `task.reference` | first `task.tool` |
| Reading the bibliography | `task.tool` read_bibtex | both files read; shows "9 entries, 6 references" from outputs |
| Comparing every entry | after both reads | `task.tool` submit_verdicts ("9 verdicts") |
| Writing the summary | submit_verdicts seen | `task.answer` |
| Double-checking the verdicts | `task.answer` | `task.verdict` |

Elapsed seconds tick beside the active step. A `read_bibtex` call with `isError` or an output that
is not `ok` is shown under its step as a muted note ("The checker retried reading a file"); the
run continues, since the agent may recover. The input cards are locked (no re-pick) during a run.

### 4.4 Summary banner (the verdict, in plain words)

Built on `task.verdict`, combined with the last `submit_verdicts` arguments (the agent's labels)
and the `read_bibtex` outputs.

- Headline: "6 of 9 entries look hallucinated" / "All 9 entries match your references" (green) /
  "9 of 9 entries look hallucinated".
- Count chips: Hallucinated, Real, and "N unreadable" (raw entries with `record: null`), each also
  a filter.
- Trust line, from the verifier:
  - `valid` -> check icon, "Verified: every verdict was re-checked against your references."
  - not valid with `problems` -> warning tone, "The checker got K of N wrong. The corrected answer
    is shown below." (score shown as "N-K of N right").
  - not valid, no verdicts file -> error tone, "The checker didn't finish its verdicts. Try again."
    and no entry list beyond what was read.
  - Underneath, small and muted: the verifier `message` verbatim, for the technical user.

**Which label an entry shows.** The verifier is the authority:
- valid: `details.expected[key]`.
- not valid: the agent's label, except for keys in `details.problems`: a "wrong" problem carries
  the true label in its text ("the entry is real"), which the page parses and shows with a
  "Corrected by the check" tag; a "no verdict" key shows "Not checked by the agent" with no label;
  a "not a raw entry" key (agent invented a key) is listed once under the banner:
  "The checker also judged keys that aren't in your file: foo".
The page never computes `real`/`hallucinated` itself.

### 4.5 Entry list

Filter chips (All / Hallucinated / Real) and a "Search title or key" field when there are more
than 12 entries. Order: hallucinated first, then not-checked, then real; within a group, file
order. Each entry is a card:

- Left: status pill. HALLUCINATED (red-ish, `--bad`), REAL (green, `--ok`), NOT CHECKED (neutral).
  Pills carry text, never colour alone.
- Title line: citation key (monospace, small), then the title, authors (up to 3 surnames, "+N"),
  year, venue, DOI (as plain text; no links, the frame has no network and no popups).
- "What differs" block, only on hallucinated entries, from the `read_bibtex` records:
  - **Could not be read** (`record: null`): plain reasons mapped from `error`:
    `unparseable: ...` -> "The entry is malformed, so it can't match anything (often a missing
    brace or quote)." plus the raw reason in a muted line; `missing year` -> "It has no year";
    `has a field twice` -> "A field appears twice"; `has both a journal and a booktitle` ->
    "It lists both a journal and a proceedings".
  - **Closest reference**: the reference record sharing the most of the six fields with it (DOI or
    title equal breaks ties toward that one). If it shares title or DOI, or at least four fields,
    the card says "Closest reference: <key>" and lists only the differing fields as rows:
    `Field | yours | reference`. Field labels: Type, Title, Authors, Year, Venue, DOI. Authors
    show the set difference: "Extra author: Ilya Sutskever", "Missing author: ...", or "Order
    differs". Strings show a character-level highlight of the differing span (longest common
    prefix/suffix; `<mark>` styled, not colour only). A missing value shows "none".
  - **Not in your references**: no reference qualifies -> "Nothing similar is in your references.
    The paper may not exist, or your references don't include it."
- Real entries collapse to one line: "Matches <reference key> exactly".
- When the page has no `read_bibtex` output for the raw file (the agent never read it, or the
  output did not parse), the card shows the key and label only and the line "Details aren't
  available for this run."

This diff is a display aid: its exact-match comparison uses the same normalization as
`verifier/schema.py` (records arrive normalized), and if it ever finds an exact match for an
entry the verifier marked hallucinated (or none for a real one) it shows no diff rows and the
line "Details aren't available for this run." rather than contradicting the verdict.

### 4.6 The checker's summary and saving

- "The checker's summary": a collapsed section holding `task.answer.text` as plain text.
- "Save report": writes `reports/bibtex-check.md` with `workspace.write` (headline, verifier line,
  one bullet per hallucinated entry with its differing fields, then the real ones), then shows
  "Saved to your workspace as reports/bibtex-check.md". The sandbox has no downloads and no
  clipboard permission, so there is no Download or Copy button. A "Hallucinated keys" box
  (read-only, selectable text, one key per line) lets the user select and copy manually.

### 4.7 Chat drawer ("Ask the checker")

`chatPanel` from components.js inside a drawer (`role="dialog"`, `aria-modal` on narrow only,
focus trapped while open, Esc closes, focus returns to the header button). Uses `prompt {text}`
and `chat.*` events; tool calls are not shown. Intro: "Ask about a citation or about how the
check works." After a result, suggestion chips fill the input (not auto-send): "Why is <first
hallucinated key> flagged?", "What would make my references stricter?". The drawer keeps its
conversation while closed (host keeps it for the page's lifetime). A chat turn and a task run can
be in flight together.

## 5. States

| State | Shows |
|---|---|
| Loading | Header skeleton until `describe` resolves (timeout 10 s -> "Can't reach NanoAgent. Reload the page."). No host (`hasHost()` false) -> one card: "Open this page from Mochi." |
| Empty | Two empty drop zones, disabled Check button with hint "Add both files to start", sample link. Result area: three-line explainer from `product.yaml` `steps`. |
| Ready | Both cards filled, "Check N entries" enabled. |
| Running | Step tracker, Cancel button, cards locked. |
| Cancelled | `task.error {message: "cancelled"}` -> neutral "Check cancelled." with "Check again". |
| Result | Banner, filters, entries, summary, save. A previous result stays visible (dimmed, "Previous check") while a new run is running and is replaced on `task.verdict`. |
| Error | `task.error` before any verdict -> red banner in plain words, attached to the card at fault when known (below). "Check again" button. |

Error mapping (`task.error.message`, matched on substrings; anything else is shown verbatim
under "Something went wrong"):

| Message contains | Shown | Where |
|---|---|---|
| `reference entries do not parse into the schema: k1, k2` | "Some of your trusted references can't be read: k1, k2. Each needs a title, author and year, no repeated fields, and only one of journal or booktitle." | reference card |
| `<file> has these keys twice: k` | "The key k appears twice in this file. Rename one and try again." | the card whose path's file name matches |
| `is not an entry with a key` | "Line N of this file isn't a BibTeX entry." | matching card |
| `no file at` | "The file is no longer in your workspace. Add it again." | matching card |
| `under maintenance` / `plugin not found` | "The checker is unavailable right now." | page |

A `workspace.write` rejection shows on its card: "Couldn't save this file to your workspace:
<message>". A `runTask` rejection (no runId) shows as a page error.

## 6. Theme, accessibility, look

- `style.css` tokens extended: accent `#3b5998` / dark `#8ea6d6`, Inter (system fallback stack
  since fonts must ship in `ui/`; ship Inter woff2 only if size allows), cards 16 px radius, 1 px
  soft borders, status colours with >= 4.5:1 text contrast in both themes, `<mark>` diff
  background tuned per theme.
- Status is always text + colour. The summary headline is an `aria-live="polite"` region; step
  changes announce once per step. All controls reachable by keyboard; drop zones are buttons.
- No horizontal scroll down to 320 px; long titles, DOIs and keys wrap (`overflow-wrap: anywhere`).

## 7. Files

`ui/index.html`, `ui/style.css`, `ui/bridge.js` (template, unchanged), `ui/components.js`
(template, unchanged), `ui/app.js` (this page: `mountApp(layout)` with the layout below),
`ui/bib.js` (entry counting, error-text mapping, closest-reference and field diff, report
Markdown), `ui/samples.js` (the two fixtures as strings).

## 8. Edge cases

- Raw file with zero parseable entries but some broken ones: every entry is "Could not be read";
  headline "N of N entries look hallucinated".
- Empty raw file: blocked before upload (no entries). Reference file with entries the page counts
  but the parser rejects: surfaced only by the run's `task.error` (4.2 never pre-judges).
- Same citation key in both files but different content: keys don't matter; the closest reference
  may be a differently keyed entry. The card names the reference key to make this clear.
- Two reference entries equally close: the first in file order; no ambiguity warning.
- Very large files (hundreds of entries): list renders hallucinated entries first, real ones
  behind "Show N real entries"; search box appears.
- Agent calls `submit_verdicts` twice: the last call's arguments are the agent's labels.
- Agent reads files under other paths or reads one twice: only outputs whose `path` is
  `inputs/raw.bib` / `inputs/reference.bib` are used; the last one wins.
- Run ends with `task.done` but no `task.verdict` and no `task.error`: "The check stopped before
  it finished." with "Check again".
- Theme changes mid-run: only CSS changes; nothing re-renders.
- Non-UTF-8 `.bib` (Latin-1 export): rejected at the card (the plugin reads UTF-8 only), with the
  hint "Save it as UTF-8 and try again".

## 9. As built (changes the kit or the real data forced)

- Files: `ui/app.js` (the page), `ui/app.css`, `ui/bib.js`, `ui/samples.js`; `ui/index.html` and
  `ui/kit/` are the shared kit (not `style.css`/`components.js` at the top level).
- File cards are the kit's `fileDrop`: "Drop a file here or choose one", "Paste text instead", and
  the workspace menu (shown only when the workspace has other `.bib` files). A chosen file shows
  "Replace" rather than an (x). Numbers "1"/"2" and the one-line description are page additions.
  Non-UTF-8 files are refused by the kit with "Save it as UTF-8 and try again".
- The run uses `taskRun` with the five steps of 4.3; the Check button turns into Cancel while it
  runs, and the progress card has its own Stop. After a verdict the card reads "Done in N s" with
  "Show steps".
- Count chips and filters are one control: segmented chips "All / Hallucinated / Real (/ Not
  checked)" under the summary, plus count tiles in the summary card. Unreadable entries are a line
  ("1 of the hallucinated entries could not be read at all").
- Trust line: the kit's `verdictBanner`; the verifier's raw message and details are under
  "Details". When the verifier corrects the agent, the title is "The checker got K of N entries
  wrong, so the check stepped in." and the score reads "N-K of N right", where K counts corrected
  entries and entries with no verdict (keys outside the file are listed separately).
- The sandbox may allow the clipboard after all, so "Copy flagged keys" uses the kit's
  `copyButton`, which falls back to selected text with "Press Ctrl+C" when copying is refused.
  "Save report" writes `reports/bibtex-check.md`.
- The chat drawer (kit `chatDrawer`) sends the page's last result as context with each message
  (`prepare`); the user's bubble shows only what they typed.
- When the files change after a check, the old result stays with "These results are for the files
  you checked before."
- The checker's summary has its Markdown backticks removed, since it is shown as plain text.
