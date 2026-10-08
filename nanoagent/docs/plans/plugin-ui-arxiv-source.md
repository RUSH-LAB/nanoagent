# Plan: the arxiv-source page (`plugins/arxiv-source/ui/`)

The page a researcher opens to find arXiv papers, keep their LaTeX sources, and follow the people
they care about. It replaces the template's full-page chat with a purpose-built page on the
`nanoagent.ui/v1` bridge (docs/plans/plugin-ui.md). No tool names, no JSON, no arXiv query syntax
unless the user asks for it. The plugin's agent stays one click away in a drawer.

## 1. The user job

> "I want the source of *that* paper (or of these few papers), and every morning I want to know
> what the people I follow put out yesterday, with the sources already saved."

Two jobs, one page:

1. **Find and keep papers**: type a title, an author, a topic, an arXiv id or an arXiv URL; scan
   the results; save the ones you want. The source lands in the workspace, one folder per paper.
2. **Daily digest**: keep a list of people; pick a date (default: yesterday, UTC); get a short,
   checked digest of their new papers with every source saved.

A third view, **Library**, shows what is already saved, so the user never saves twice and can
open a paper's `.tex` files.

## 2. What the plugin gives the page (facts the design rests on)

| Task (`runTask`) | Runner | Arguments the page sends | What comes back |
|---|---|---|---|
| `search-papers` | tool | `{query, max_results}` (1..50) | `task.result.response`: `SearchOutput {query, source_url, papers: [Paper]}`; `Paper = {arxiv_id (versioned, e.g. 1706.03762v7), title, authors[], summary (abstract), published (ISO), abs_url}` |
| `save-paper-source` | tool | `{arxiv_id, destination}`; `destination` must be a new folder | `DownloadOutput {arxiv_id, source_url, folder (absolute path), files[] (relative to folder)}` |
| `save-search-results` | tool | `{query, max_results (1..10), destination}` | `SaveOutput {query, folder, papers: [SavedPaper]}` (not used by the page, see 6.4) |
| `find-and-save-paper` | agent | `{query: <the user's description>, max_results}` | no `task.result`; `task.tool` events for `search_papers` and `download_source` (its `arguments.destination` is the agent's relative folder), then `task.answer {text}` |
| `daily-digest` | agent, reference `list_daily_papers` | `{people[], date "YYYY-MM-DD"}` | `task.reference {tool}` (the pinned listing itself is not sent), `task.tool` for `search_papers` / `save_raw_paper` / `write_digest`, `task.answer`, then files `docs/digest-<date>.json` (`{date, entries: [{arxiv_id, title, authors, summary (2 lines), link}]}`), `docs/digest-<date>.md`, and `docs/raw/<lastname>-<4 title words>-<id>-<date>/…` |

Every run ends with `task.verdict {valid, score, message, details}` (or `task.error {message}`)
and then `task.done`.

- Tool tasks: each tool call's output is already checked by the verifier (the files on disk are
  exactly the declared ones, the folder is the requested one, ids and titles are well formed). A
  failed check arrives as `task.error`, not as an invalid verdict. The verdict itself is always
  `valid: true, "every tool call was verified"`.
- `daily-digest`: `verifier/daily.py` compares the digest with the pinned arXiv listing.
  `details.problems` is `{arxiv_id: [problem strings]}`; `details.papers` lists the ids when all
  are right; `details.expected` lists the ids when no digest was written; `score` is the share of
  listed papers that are right.
- Paths in tool outputs (`folder`) are absolute on the server. The page never shows them; it
  works with the workspace-relative paths it chose itself (`destination`) or that
  `workspace.list` returns.
- arXiv asks for 3 s between requests; the plugin waits inside multi-request tools. A single
  `save-paper-source` does one request, so the page waits 3 s between the runs it queues.
- `download_source` writes whatever arXiv's `/e-print/` returns. For a PDF-only submission that is
  a PDF saved as `main.tex`; `workspace.read` then returns `{base64}` instead of `{text}`. The page
  detects this (6.6).

## 3. Layout

### Wide (>= 900 px)

```
+------------------------------------------------------------------------------------------+
| [icon] arXiv Papers                        [ Find | Daily digest | Library (12) ]  [Ask] |
|        Find arXiv papers and keep their sources                                           |
+------------------------------------------------------------------------------------------+
|                                                                                          |
|  +------------------------------------------------------------------------------------+  |
|  | (search)  attention is all you need                                    [ Search ]  |  |
|  +------------------------------------------------------------------------------------+  |
|   Look in: (Anywhere) (Title) (Author) (Abstract)   Subject: [Any subject  v]           |
|   Show: [10 v] results        Can't remember the title? Describe the paper ->           |
|                                                                                          |
|   10 papers for "attention is all you need"        Sort: (Best match) (Newest)          |
|   [ ] Select all                                                                         |
|  +------------------------------------------------------------------------------------+  |
|  | [x]  Attention Is All You Need                                    [ Save source ]  |  |
|  |      Ashish Vaswani, Noam Shazeer, Niki Parmar, +5 more   ·  12 Jun 2017           |  |
|  |      1706.03762  ·  cs.CL                                                          |  |
|  |      The dominant sequence transduction models are based on complex recurrent ...  |  |
|  |      Show abstract v                                                               |  |
|  +------------------------------------------------------------------------------------+  |
|  | [ ]  Attention Is All You Need In Speech Separation               (v) Saved  Open  |  |
|  |      Cem Subakan, Mirco Ravanelli, ...                    ·  25 Oct 2020           |  |
|  +------------------------------------------------------------------------------------+  |
|  ...                                                                                     |
|                                                                                          |
| +--------------------------------------------------------------------------------------+ |
| | 2 selected                                  [ Clear ]   [ Save 2 sources ]           | |  <- sticky action bar
| +--------------------------------------------------------------------------------------+ |
+------------------------------------------------------------------------------------------+
```

Daily digest view:

```
+------------------------------------------------------------------------------------------+
|  People you follow                                  Date (UTC)                            |
|  (Yoshua Bengio x) (Yann LeCun x) [+ Add a person]  [ 2026-09-09 ] (Yesterday) (Today)    |
|                                                                   [ Write digest ]       |
|                                                                                          |
|  Earlier digests: (Sep 9) (Sep 8) (Sep 5)                                                |
|                                                                                          |
|  +------------------------------------------------------------------------------------+  |
|  | (v) Checked against arXiv: all 3 new papers are in the digest, sources saved.      |  |
|  |     Checked 07:42 · 3 of 3 correct                                                  |  |
|  +------------------------------------------------------------------------------------+  |
|                                                                                          |
|  Digest for Wednesday, 9 September 2026 · 3 papers                                       |
|  +------------------------------------------------------------------------------------+  |
|  | A Paper Title Exactly As arXiv Lists It                                 2609.10630 |  |
|  | **Yoshua Bengio**, Jane Doe, ...                                                   |  |
|  | First line of the agent's summary.                                                 |  |
|  | Second line of the agent's summary.                                                |  |
|  | (v) Source saved · 14 files                              [ Open files ] [ Copy link]|  |
|  +------------------------------------------------------------------------------------+  |
|  ...                                                                                     |
+------------------------------------------------------------------------------------------+
```

Running (digest; the same progress card serves every task):

```
|  +------------------------------------------------------------------------------------+  |
|  |  Writing the digest for 9 Sep 2026 ...                         1:12   [ Cancel ]   |  |
|  |  (v) Took arXiv's listing for 2 people as the answer key                            |  |
|  |  (v) Looked up Yoshua Bengio: 2 papers                                              |  |
|  |  (v) Looked up Yann LeCun: 1 paper                                                  |  |
|  |  (v) Saved "A Paper Title ..."                                                      |  |
|  |  (o) Saving "Another Paper ..."                                                     |  |
|  +------------------------------------------------------------------------------------+  |
```

Library view:

```
+------------------------------------------------------------------------------------------+
|  (filter) Filter saved papers                                      12 papers · 38 MB      |
|  +----------------------------------+  +-----------------------------------------------+ |
|  | Attention Is All You Need        |  | papers/1706.03762/ms.tex                  [x] | |
|  | Vaswani et al. · 2017            |  | ------------------------------------------------| |
|  | papers/1706.03762 · 9 files      |  | \documentclass{article}                       | |
|  |   ms.tex  (main)                 |  | \usepackage{...}                              | |
|  |   model_architecture.tex         |  | ...                                           | |
|  |   Figures/ModalNet-21.png        |  |                                               | |
|  +----------------------------------+  |                                               | |
|  | From the 9 Sep digest            |  |                                               | |
|  |   bengio-a-paper-title-...       |  |                                               | |
|  +----------------------------------+  +-----------------------------------------------+ |
+------------------------------------------------------------------------------------------+
```

Chat drawer (opened by **Ask**): slides in from the right, 380 px wide, over the content with a
scrim; the page underneath stays as it was.

```
                                                       +----------------------------------+
                                                       | Ask the arXiv agent          [x] |
                                                       | "Find the 2023 paper on ..."     |
                                                       | "Which of my saved papers ..."   |
                                                       | ...                              |
                                                       | [ Message ...          ] [Send]  |
                                                       +----------------------------------+
```

### Narrow (< 600 px)

```
+------------------------------+
| [icon] arXiv Papers   [Ask]  |
| [ Find | Digest | Library ]  |   <- full-width segmented control
+------------------------------+
| (search) attention is ...    |
| [ Search ]                   |
| Filters (Title, 10) v        |   <- filters collapse into one disclosure
+------------------------------+
| [x] Attention Is All You ... |
|     Vaswani +7 · 2017        |
|     1706.03762               |
|     [ Save source ]          |   <- action moves under the text, full width
+------------------------------+
| ...                          |
+------------------------------+
| 2 selected  [Save 2 sources] |   <- sticky bottom bar
+------------------------------+
```

- Library: the file viewer replaces the list (with a Back button) instead of sitting beside it.
- Chat drawer: a full-screen sheet with a Close button.
- Between 600 and 900 px: one column, the header tabs stay in the header row.

## 4. Components

Each lists its data source and the bridge calls / events that feed it. "State file" is
`.arxiv-source/state.json` (6.1).

### 4.1 Header

- Icon, `plugin.name` and `plugin.product.tagline` from `describe`.
- Tabs: **Find**, **Daily digest**, **Library (N)**; N = number of saved papers from the library
  index (4.7). Tab choice is kept in `location.hash` (`#find`, `#digest`, `#library`) so a reload
  keeps the view.
- **Ask** button opens the chat drawer (4.9).
- Theme from `describe.theme`, then `host.theme` events (`applyTheme`).

### 4.2 Smart search bar (Find)

One input, placeholder "Title, author, topic, arXiv id or link". What the page does with the text
(all client-side, before `runTask`):

| The user types | Detected as | What happens |
|---|---|---|
| `1706.03762`, `1706.03762v5`, `hep-th/9901001` | arXiv id (the plugin's `ARXIV_ID` pattern, mirrored in JS) | arXiv's `id_list` parameter is not a task input, so the page runs `search-papers` with `{query: "id:<base id>", max_results: 1}` (arXiv's `id:` field) and shows the one card, ready to save with the id exactly as typed. If arXiv returns nothing: "arXiv has no paper with id …". |
| `https://arxiv.org/abs/1706.03762`, `…/pdf/1706.03762v2`, `…/e-print/…` | arXiv link | The id is taken from the path, then as above. |
| anything else | words | A search, built from the **Look in** chip (below). |

Query building (shown to the user only under "Advanced"):

- **Anywhere** (default): each word `w` becomes `all:w`, joined with ` AND `; a quoted phrase in
  the input stays one term `all:"…"`.
- **Title**: `ti:"<text>"`. **Author**: `au:"<text>"`. **Abstract**: `abs:"<text>"`.
- **Subject** select (Any, Computer Science > AI `cs.AI`, Computation and Language `cs.CL`,
  Computer Vision `cs.CV`, Machine Learning `cs.LG`, Statistics ML `stat.ML`, Robotics `cs.RO`,
  Cryptography and Security `cs.CR`, Quantum Physics `quant-ph`, High Energy Physics Theory
  `hep-th`, Mathematics `math`): adds ` AND cat:<code>`.
- **Show** select: 10 (default), 25, 50 → `max_results`.
- **Advanced** disclosure: a text field holding the built query, editable, with a one-line hint
  ("arXiv search syntax, e.g. `au:vaswani AND cat:cs.CL`"). Editing it switches the bar to
  "using your own query".

Validation before running: empty input disables **Search**; a quote character inside a
Title/Author/Abstract phrase is stripped with a note.

Feeds: `runTask("search-papers", {query, max_results})`; `task.result.response.papers` fills the
result list; `task.error` fills the inline error (6.3).

### 4.3 Result list and paper card (Find)

- Heading: "N papers for "<what the user typed>"" (not the arXiv query).
- **Sort**: Best match (arXiv's order) / Newest (client sort on `published`).
- Card, from one `Paper`:
  - Title (2 lines max, full title in the `title` attribute).
  - Authors: first 3, then "+N more" which expands inline.
  - Date: `published` formatted "12 Jun 2017" (UTC).
  - Id: base id without the version, with a **Copy** icon. The version stays in a tooltip.
  - Abstract (`summary`): 2 lines, **Show abstract** expands it.
  - **Link**: "Copy arXiv link" copies `abs_url` (the sandbox has no `allow-popups`; 6.8).
  - Checkbox for multi-select.
  - Right side, one of: **Save source** (primary) / "Saving…" spinner / "Queued (2 of 3)" /
    "(v) Saved · Open" (the folder already exists in the workspace; **Open** jumps to Library with
    it selected) / "(!) Couldn't save · Retry" with the reason on hover and below on narrow.
- **Select all** / sticky action bar "N selected · Clear · Save N sources" (hidden at 0).

Saved state comes from `workspace.list`: a paper is saved when any file starts with
`papers/<folder>/` (folder naming in 6.2). The list is refreshed after every run.

### 4.4 Save queue (Find)

Saving one or many papers is the same queue:

1. For each selected paper not yet saved: `runTask("save-paper-source", {arxiv_id: <versioned
   id from the result>, destination: "papers/<folder>"})`.
2. One run at a time; 3 s pause after each run before the next (arXiv's rate rule).
3. On `task.result`: record the paper in the state file's library index (title, authors,
   published, abs_url, arxiv_id, folder, files, savedAt), mark the card Saved with "N files".
4. On `task.verdict` valid: the card shows "(v) Saved and checked". On `task.error`: the card
   shows the plain-words reason (6.3) and the queue continues with the next paper.
5. A queue bar above the list while it runs: "Saving 2 of 5 · about 15 s left" (`remaining x
   (typical run + 3 s)`), with **Stop** (cancels the current run with `cancel {runId}` and drops
   the rest; already saved papers stay).

### 4.5 Describe mode (Find, agent)

"Can't remember the title? Describe the paper ->" switches the bar to a textarea: "Describe the
paper, e.g. the 2017 Google paper that introduced the Transformer". **Find and save** runs
`runTask("find-and-save-paper", {query: <the description>, max_results: 10})`.

- Progress card (4.8) lines from `task.tool`:
  - `search_papers` → "Searched arXiv: N candidates" (`output.papers.length`); the candidates are
    kept to name the chosen one.
  - `download_source` → "Saved <title>" (title looked up by `arguments.arxiv_id` in the
    candidates; else the id).
  - `isError: true` → a muted line "A step failed, the agent is trying again" (the agent may
    recover; the verdict decides).
- Result: a paper card for the downloaded paper ("Picked for you"), with its folder
  (`arguments.destination`, relative), file count (`output.files.length`), and the agent's
  `task.answer` text in a quote block below ("Why this one"). The page adds it to the library
  index under the agent's folder.
- If the agent saved nothing: "The agent couldn't pin down one paper. Try adding an author or a
  year, or search instead." with a button that copies the description into the normal search.

### 4.6 Daily digest view

**People you follow**: chips with remove (x), an "Add a person" input (Enter or comma adds).
Stored in the state file's `people`, saved on every change (`workspace.write`). Rules shown
inline, matching the plugin: names must be distinct (case-sensitive like the plugin, but the page
also warns on case-only duplicates), not blank, no `"`. Hint: "Use the name as arXiv lists it,
e.g. Yoshua Bengio".

**Date**: a native `<input type="date">`, default yesterday in UTC, max today (UTC). Quick chips:
Yesterday, Today. Caption: "Papers first submitted on this day, arXiv time (UTC)."

**Write digest** (primary): `runTask("daily-digest", {people, date})`. Disabled with a reason
when the list is empty.

**Earlier digests**: chips from `workspace.list` files matching `docs/digest-YYYY-MM-DD.json`,
newest first, at most 7 then "More…". Clicking one loads that digest (below) without running.

**Progress** (4.8) lines:

| Event | Line |
|---|---|
| `task.started` | "Writing the digest for 9 Sep 2026" |
| `task.reference` | "Got arXiv's own listing for N people (used to check the result)" |
| `task.tool` `search_papers` | "Looked up <person>: N papers" (person parsed from `arguments.query`'s `au:"…"`) |
| `task.tool` `save_raw_paper` | "Saved <output.title>" / on error "Couldn't save <id>: <reason>" |
| `task.tool` `write_digest` | "Wrote the digest (N papers)" (`output.entries`) |
| `task.answer` | kept for the result's "Agent's note" disclosure |

**Verdict banner** (from `task.verdict`, in plain words):

| Verdict | Banner |
|---|---|
| valid, `details.papers` non-empty | (v) green: "Checked against arXiv: all N new papers are in the digest, with sources saved." |
| valid, no papers | (v) neutral: "No new papers from these people on 9 Sep 2026. arXiv shows none, so there is nothing to save." |
| invalid, `details.problems` | (!) amber: "K of N papers need attention." `score` as "M of N correct". Each problem lands on its paper card (below). |
| invalid, no digest file | (x) red: "The agent didn't write a digest. arXiv lists N papers for this day." with **Try again**. |

Problem strings from `verifier/daily.py` rewritten for people:

| Verifier says | Card says |
|---|---|
| `title differs from the arXiv record` | "Title doesn't match arXiv" |
| `authors differ from the arXiv record` | "Author list doesn't match arXiv" |
| `summary is not exactly two lines` | "Summary isn't two lines" |
| `link is not …` | "Link is wrong" |
| `published but missing from the digest` | "Missing from the digest" (the card is built from what we know: id, and the title if a `save_raw_paper` output named it) |
| `no saved source in docs/raw/…` | "Source not saved" |
| `not a paper arXiv shows for these people on <date>` | "Not one of their papers that day" (card struck through) |
| `listed twice` / `id is not of the form YYMM.NNNNN` | "Listed twice" / "Bad arXiv id" |

The verdict is stored in the state file under `digests[<date>]` with the time, so loading an
earlier digest shows "Checked 07:42 on 10 Sep: all 3 correct", or "Not checked by this page" when
the digest was made elsewhere (e.g. by chat).

**Digest result**: `workspace.read("docs/digest-<date>.json")` → entry cards:

- Title, id (copy), authors with the followed people in bold, the two summary lines.
- "(v) Source saved · N files · Open files" when `workspace.list` has files under a
  `docs/raw/<name>/` folder whose name ends in `-<id>-<date>` (the plugin's naming rule in
  `src/plugin/naming.py` puts the id and date last), unless the check says the source isn't saved.
- "Copy link" (`entry.link`).
- Toolbar: "Copy as Markdown" (reads `docs/digest-<date>.md`, copies its text), "Open in Library".
- "Agent's note" disclosure with `task.answer`.

### 4.7 Library view

Data: `workspace.list` plus the state file's library index.

- Groups: **Saved papers** (`papers/*/`) and **From digests** (`docs/raw/*/`, labelled with the
  digest date taken from the folder name's tail).
- Per paper: title and authors from the index (or, for digest folders, from the digest JSON of
  that date; for unknown folders, the folder name), folder path, file count, total size.
- Expand: the file tree; the main file is marked "(main)": `main.tex` / `ms.tex` / the only
  root `.tex` / else the first root `.tex` containing `\documentclass` (read on expand, root
  `.tex` files only).
- Viewer: `workspace.read(path)`; text in a monospace pane with line numbers; images (`png`,
  `jpg`, `gif`, `webp`, `svg`) as images; PDFs and other binaries: "A binary file; not shown
  here." plus its size.
- Filter box over titles, authors, ids and paths.
- Empty state: an illustration-free card "Nothing saved yet. Search for a paper and press Save
  source, or write a digest." with buttons to Find and Daily digest.

### 4.8 Progress card (shared)

One card per active run: a title line, an elapsed timer, **Cancel**, and a list of short
checklist lines ((o) running, (v) done, (!) soft failure). Built on `runControls`' `startRun` /
`cancel`, but its lines come from each view's event mapping above; tool names never appear. On
`task.done` it collapses into the result (or the error). Only one task run at a time on the page
(the save queue counts as one); other run buttons are disabled with "Busy: saving 2 of 5".

### 4.9 Chat drawer

`chatPanel` inside a drawer. Intro: "Ask the arXiv agent: find a paper by description, compare
saved papers, or explain a result." with three example prompts as chips. `onTurnDone` refreshes
`workspace.list`, so anything the agent saved shows up in Library and as Saved on result cards.
The drawer keeps its conversation while closed (the host keeps it for the page's lifetime).

## 5. States

| State | Find | Daily digest | Library |
|---|---|---|---|
| First visit (empty) | Search bar focused; under it three example searches as chips ("Attention Is All You Need", "Author: Yann LeCun", "Topic: diffusion models, cs.CV") and the product highlights in one line each | "Follow people to get a daily digest of their new papers." People input focused; date preset to yesterday | The empty card of 4.7 |
| Loading the page | "Connecting…" (mountApp), then the view; Library count shows "…" until `workspace.list` answers | the people list shows a skeleton until the state file is read | skeleton rows |
| Running | Search button shows a spinner; previous results dimmed, not cleared | Progress card (4.8) | Refresh disabled |
| Done, nothing found | "No papers match "<text>". Try fewer words, Anywhere instead of Title, or another subject." | the neutral banner of 4.6 | — |
| Error | inline red box under the bar (6.3), input kept | red box in place of the progress card, with **Try again** | inline error with **Retry** |
| Cancelled | "Search stopped." | "Stopped. Papers already saved stay in your library." | — |

## 6. Edge cases and rules

### 6.1 The page's own state

`.arxiv-source/state.json` in the workspace, read once at start (`workspace.read`; missing file
= fresh state) and written whole after each change (`workspace.write`), writes serialized in one
promise chain:

```json
{"version": 1,
 "people": ["Yoshua Bengio", "Yann LeCun"],
 "library": {"1706.03762": {"title": "...", "authors": ["..."], "published": "...", "abs_url": "...",
                            "folder": "papers/1706.03762", "files": 9, "savedAt": "..."}},
 "digests": {"2026-09-09": {"valid": true, "score": 1, "message": "...", "checkedAt": "..."}}}
```

A file that does not parse or has another `version` is not overwritten: the page shows "Your
saved settings can't be read (.arxiv-source/state.json)" and runs without saving settings until
the user presses **Start fresh** (which replaces it).

### 6.2 Folder naming

- Find saves go to `papers/<base id>/`: the version is dropped (`1706.03762v7` → `1706.03762`) so
  one paper has one folder; legacy ids replace `/` with `_` (`hep-th/9901001` →
  `papers/hep-th_9901001`), like `src/plugin/save.py`.
- The run passes the versioned id, so the folder holds the version the user saw.
- `download_source` fails when the folder exists, so the page never starts a save for a folder
  `workspace.list` already shows; such cards are Saved.
- Digest saves are the agent's, under `docs/raw/` (4.6).

### 6.3 Errors in plain words

`task.error.message` is matched (substring) and shown as:

| Message contains | Shown |
|---|---|
| `arXiv rejected the query` | "arXiv couldn't read that search. Try plain words, or check the Advanced query." |
| `invalid arXiv id` | "That isn't an arXiv id. Ids look like 1706.03762 or hep-th/9901001." |
| `File exists` / `destination already exists` | "Already in your library." (card turns Saved after a refresh) |
| `exceeds the download limit` / `extraction limit` / `too many files` | "This paper's source is too large to save (over 100 MB, or over 10,000 files)." |
| `unsafe archive path` / `unsupported archive entry` | "arXiv's archive for this paper has unsafe entries, so nothing was saved." |
| `arXiv has no paper` | "arXiv has no paper with that id." |
| `or more papers on` | "<person> has 50 or more papers that day, so the digest can't be complete. Remove them or pick another date." |
| `people must be distinct` | (prevented by the people input) |
| `URLError`, `timed out`, `Connection`, `HTTP Error 5` | "Couldn't reach arXiv. It may be busy; try again in a minute." |
| `HTTP Error 403` / `HTTP Error 429` | "arXiv is limiting requests right now. Wait a minute and try again." |
| `plugin output verification failed` | "The result failed the plugin's own check, so it wasn't trusted: <rest of message>" |
| anything else | "Something went wrong: <message>" |

The full message is always available under "Details" for bug reports.

### 6.4 Why the page doesn't use `save-search-results`

It searches again and saves into a new `<destination>/<id>/` that must not exist, so the user
would get papers grouped by search instead of one folder per paper, could not choose which
results to keep, and might get a different result set than the one on screen. The save queue over
`save-paper-source` saves exactly the cards the user ticked into the one library layout. Chat can
still use it.

### 6.5 Digest specifics

- Re-running a date: `write_digest` replaces the digest, but `save_raw_paper` fails for papers
  already in `docs/raw/` (the folder exists). Those `task.tool` errors are shown as "(v) Already
  saved" when the folder exists in `workspace.list`, not as failures; the verdict still judges the
  folder. Before running, the page says "A digest for this date exists; running again replaces
  it."
- Future dates: the date input's `max` is today (UTC).
- Today: allowed, with the note "Today isn't over in UTC; papers submitted later won't be in it."
- A person with no papers: shown in progress as "0 papers"; not an error.
- A paper by two followed people is one card; both names are bold.
- Long lists: up to 20 people is the comfortable size (each person is a 3 s arXiv request for the
  listing and again for the agent); above 20 the page warns "This will take a few minutes."

### 6.6 PDF-only papers

After a save, the page reads `<folder>/main.tex` when `files` is exactly `["main.tex"]`. If the
reply is `{base64}` and starts with `%PDF` (`JVBERi0` in base64), the card and the Library entry
show "arXiv has only a PDF for this paper; it was saved as main.tex". The Library viewer labels
the file "PDF (saved as main.tex)".

### 6.7 Narrow screens and accessibility

- Breakpoints at 600 and 900 px (4/3). No horizontal scrolling at 320 px; long ids and paths wrap
  (`overflow-wrap: anywhere`).
- Hit targets at least 40 px; sticky bars respect `env(safe-area-inset-bottom)`.
- Tabs are a `role="tablist"`; progress lines are an `aria-live="polite"` list; banners use
  `role="status"` (ok) or `role="alert"` (failed); the drawer traps focus and closes on Escape.
- Every status has an icon and words, never color alone.

### 6.8 Sandbox limits

- No `allow-popups` and no `allow-downloads`: arXiv links are copied, not opened, and there is no
  "Download zip". The copy button uses `navigator.clipboard.writeText`; if the sandbox refuses it,
  the link is selected in a read-only field with "Press Ctrl/Cmd+C" (an explicit message, not a
  silent substitute).
- No network: Inter is shipped in `ui/fonts/` as `woff2` (allowed by the UI file rule), with
  `font-src 'self'`.

## 7. Look

- Tokens over the template's `style.css` variables: `--accent: #3b5998` (dark `#8ea6d6`),
  `--accent-soft` `#e9edf6` (dark `#1f2a40`), `--sans: Inter, …`, cards `border-radius: 16px`
  (chips 999px, inputs 12px), `1px solid var(--border)`, shadows only on the drawer and sticky
  bars. Amber for "needs attention": `--warn #9a6700 / --warn-soft #fff4d6` (dark `#e3b341 /
  #3a2e12`).
- Type: titles 15/600, meta 13/400 muted, ids in `--mono` 12.
- Both themes come from `html[data-theme]`; every color in this page is a variable, so `host.theme`
  switches everything at once.

## 8. Files and build

All static, on the shared kit (`ui/index.html` and `ui/kit/` are the template's, unchanged):

```
plugins/arxiv-source/ui/
  app.js          mountApp(arxivLayout): tabs, chat drawer, the shared file list and run lock,
                  .arxiv-source/state.json through the kit's jsonStore
  arxiv.js        query building, id/link parsing, raw-folder naming (mirrors src/plugin/naming.py), error wording
  find.js         search bar, result list, save queue, describe mode
  digest.js       people, date, run, verdict banner, digest cards
  library.js      library groups, file tree, viewer
  app.css         this page's rules over kit/kit.css variables
```

No font is bundled: the kit names Inter first and falls back to the system stack.

`arxiv.js` is pure functions, so its rules (query building, id parsing, naming) can be checked
against the Python with the same cases as `tests/test_daily.py`
(`"Łukasz Kaiser"` → `kaiser-attention-is-all-you-1706.03762-2017-06-12`).

## 9. Previews without arXiv

The page needs `export.arxiv.org` for live data. For design review and tests, a mock host frames
the page and answers the bridge from fixtures built from the plugin's test data:

- `search-papers`: the `tests/fakes.py` feed (ids `1706.03762v7` and a few `2609.1063Nv1`,
  "Paper <id> Wrapped" titles, authors Ashish Vaswani and Noam Shazeer, published
  `2017-06-12T17:57:34Z`) plus the example query `ti:"attention is all you need"` from
  `examples/arxiv_source/configs/step2_search_papers_arguments.json`.
- `save-paper-source`: `{folder, files: ["main.tex"]}` and a valid verdict; one fixture returns
  `task.error "invalid arXiv id"`, one a PDF-only `main.tex`.
- `daily-digest`: people `["Yoshua Bengio", "Yann LeCun"]`, date `2026-09-09`
  (`step4_daily_digest_arguments.json`), the `task.tool` stream, a digest file with entry
  `2609.10630`, and three verdicts: all valid, valid with no papers, and invalid with each problem
  string of 4.6.
- `workspace.*`: an in-memory file map seeded with `papers/1706.03762/ms.tex` and
  `docs/raw/vaswani-paper-2609-10630-wrapped-2609.10630-2026-09-09/main.tex`.

The mock host is a kit need (one for every plugin), not part of this plugin's `ui/`.
