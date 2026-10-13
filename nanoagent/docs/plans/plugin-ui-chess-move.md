# Plan: the chess-move page (`plugins/chess-move/ui/`)

The chess-move plugin's own page replaces the template's full-page chat. It is a static page on
the `nanoagent.ui/v1` bridge (docs/plans/plugin-ui.md), built from the shared kit's blocks (`kit/components.js`) plus a
chess board this plugin owns.

## 1. The user job

> "Here is a chess position. Let the agent play a move on a real board, and tell me, in plain
> words I can trust, how good that move was."

The user brings a position: one they typed in, pasted from a chess site, or picked from a few
ready-made puzzles. They press one button. A minute or two later they see the move the agent
played as an arrow on the board, a grade ("Best move", "Mistake"), how much winning chance it
kept compared with Stockfish's best move, and the agent's own short explanation. Then they try
another position or ask the agent about this one.

What the user never sees: tool names (`open_board`, `drag`, ...), JSON, `board.json`, pixel
coordinates, the task id. FEN shows up only as an optional "paste a position" field and in a
copy button.

## 2. What the plugin gives the page (the facts the design rests on)

| Fact | Source |
|---|---|
| One task, `play-move`, input `{fen}` (a `contract.Position`). Nothing else. No files are needed as input, so the page never calls `workspace.write`. | `nanoagent.yaml`, `contract.TASKS` |
| The FEN must be exactly as Stockfish writes it, or the reference fails with `ValueError: Stockfish reads the position as '<fen>': give the fen exactly as it writes it`. | `src/plugin/pin.py` |
| A position with no legal move fails with `the side to move has no legal move: the game is over`. | `src/plugin/pin.py` |
| The run: `task.started`, `task.reference {tool: "pin_moves"}` (Stockfish scores every legal move, in a scratch folder; its output is **not** streamed), then `task.tool` events for the agent's `open_board`, `screenshot`, `drag`, `click`, then `task.answer {text}`, `task.verdict`, `task.done`. | `src/nanoagent/plugin/tasks.py` |
| `task.tool` outputs carry **no screenshot**: the runtime pops `images` before the text (`{"ok": true, "width": 676, "height": 676}`). The page cannot show what the agent saw; it draws its own board. | `src/nanoagent/plugin/runtime.py` |
| After `open_board` and every `drag`/`click`, the plugin writes `board.json` in the user's workspace: `{fen, moves: [uci...], positions: [fen...]}`. `moves[0]` is the agent's move; an odd index is the app's reply and is not scored. | `src/plugin/play.py`, `README.md` |
| The verdict on success: `valid: true`, `score = 1 - loss`, `details {move, win_prob, best, best_win_prob, loss}`; `win_prob` is the mover's win probability after the move, 0 to 1. | `verifier/play.py`, `examples/chess_move/outputs/step1_play_move/verdict.json` |
| The verdict on failure: `valid: false`, `score: 0`, and one of the messages "there is no board.json", "the agent played no move", "the agent played N moves: ...", "X is not a legal move in this position" (`details.legal`), "the position recorded after X is not the one X leads to", "the game was played from another position", or a malformed-record message. | `verifier/play.py`, `verifier/checks.py`, `tests/test_verifier.py` |
| A run needs Chrome; the plugin carries its board and builds its Stockfish when it is installed. Without Chrome the run fails with a `task.error` carrying `run.sh`'s message ("no Chrome installed ..."), or `runTask` itself is refused while the plugin is under maintenance (409). | `run.sh`, `src/nanoagent/web/app.py` |
| A run takes about one to two minutes (the example: two agent turns plus one Stockfish search per legal move at 200,000 nodes). The server's request timeout bounds it. | `examples/chess_move`, `src/plugin/pin.py` |
| The chat agent (`prompt`) gets the plugin's tools with no shared session, so every tool call is its own process: the chat agent **cannot** play a move on the live board (a `drag` after `open_board` finds no board). Chat is for talking about chess, not for playing. | `src/nanoagent/web/plugin_agent.py` |

## 3. Layout

### Wide (≥ 880 px)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ [icon] Chess Move                                                   [ Ask the agent  ◧ ]   │
│ An agent that plays chess on a real board                                                  │
├──────────────────────────────────────────────┬─────────────────────────────────────────────┤
│                                              │  ┌ Position ──────────────────────────────┐ │
│   8 ♜ · ♝ · · ♜ ♚ ·                          │  │ Start from                              │ │
│   7 ♟ ♟ ♟ · · ♟ ♟ ♟                          │  │ (Win the queen) (Mate in one) (Opening) │ │
│   6 · · ♞ · · ♞ · ·                          │  │ (Black to move) (Empty board)           │ │
│   5 · · · ♛ ♟ · · ·                          │  │                                         │ │
│   4 · ♝ · · · · · ·                          │  │ Side to move   [● White | ○ Black ]     │ │
│   3 · · ♘ ♙ · ♘ · ·                          │  │                                         │ │
│   2 ♙ ♙ ♙ · ♗ ♙ ♙ ♙                          │  │ ▸ Edit pieces   ▸ Paste a position      │ │
│   1 ♖ · ♗ ♕ · ♖ ♔ ·                          │  └─────────────────────────────────────────┘ │
│     a b c d e f g h            [⟲ Flip]       │                                             │
│                                              │  [        Play a move as White        ]     │
│   (square board, max 560 px, card r=18)      │   Usually takes a minute or two.            │
│                                              │                                             │
│                                              │  ┌ Recent ────────────────────────────────┐ │
│                                              │  │ Nxd5  Best move   · Win the queen      │ │
│                                              │  │ Rd8#  Best move   · Mate in one        │ │
│                                              │  └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────┴─────────────────────────────────────────────┘
```

### Running

```
┌──────────────────────────────────────────────┬─────────────────────────────────────────────┐
│   (board, dimmed editing, pulsing outline;   │  Playing as White                 0:47      │
│    the moved piece animates in when the      │                                             │
│    agent's drag lands)                       │  ✓ Setting up                               │
│                                              │  ✓ Stockfish scored every legal move        │
│                                              │  ✓ The agent is looking at the board        │
│                                              │  ● The agent moved a piece        ← live    │
│                                              │  ○ Checking the move                        │
│                                              │                                             │
│                                              │  [ Stop ]                                   │
└──────────────────────────────────────────────┴─────────────────────────────────────────────┘
```

### Result

```
┌──────────────────────────────────────────────┬─────────────────────────────────────────────┐
│   8 ♜ · ♝ · · ♜ ♚ ·                          │  ┌───────────────────────────────────────┐  │
│   7 ♟ ♟ ♟ · · ♟ ♟ ♟                          │  │ ★ BEST MOVE                    1.00   │  │
│   6 · · ♞ · · ♞ · ·                          │  │ Knight takes queen on d5   Nxd5       │  │
│   5 · · · ♘ ♟ · · ·   ← solid accent arrow   │  │                                       │  │
│   4 · ♝ · ↑ · · · ·     c3 → d5               │  │ White's winning chances               │  │
│   3 · · · ♙ · ♘ · ·                          │  │ after this move  ███████████████ 92%  │  │
│   2 ♙ ♙ ♙ · ♗ ♙ ♙ ♙                          │  │ after the best   ███████████████ 92%  │  │
│   1 ♖ · ♗ ♕ · ♖ ♔ ·                          │  │                                       │  │
│     a b c d e f g h                          │  │ ✓ Checked by Stockfish: a legal move, │  │
│                                              │  │   played on the board, and the best   │  │
│   [ ◀ Before | After ▶ ]                     │  │   one in this position.               │  │
│                                              │  └───────────────────────────────────────┘  │
│                                              │  “The white knight on c3 takes Black's      │
│                                              │   queen on d5, which wasn't defended…”      │
│                                              │   — the agent                     ▸ more    │
│                                              │                                             │
│                                              │  [ Try another position ] [ Play again ]    │
│                                              │  [ Ask why ]                                │
│                                              │  ▸ How this was checked                     │
└──────────────────────────────────────────────┴─────────────────────────────────────────────┘
```

When the agent's move is not the best one, the board also shows a dashed, muted arrow for
Stockfish's best move, and the card reads, for example:

```
│ ▲ MISTAKE                                   0.57 │
│ Pawn a2 to a3                         a3         │
│ White's winning chances                          │
│ after this move   ███████░░░░░░░░  49%           │
│ after the best    ██████████████░  92%  Nxd5 ⇢   │
│ It gave away 43 points of winning chance.        │
```

### Narrow (< 880 px; down to 320 px)

```
┌──────────────────────────────┐
│ [icon] Chess Move     [ 💬 ] │
├──────────────────────────────┤
│  board, full width,          │
│  square, min 280 px          │
│  [⟲ Flip]                    │
├──────────────────────────────┤
│ (Win the queen)(Mate in one) │  ← chips scroll sideways
│ Side to move [White|Black]   │
│ ▸ Edit pieces ▸ Paste        │
├──────────────────────────────┤
│ [   Play a move as White   ] │  ← sticky at the bottom
└──────────────────────────────┘
```

Single column: header, board, then the panel (setup, progress or result). The primary button
sticks to the bottom of the viewport while setting up. The chat opens as a full-height bottom
sheet. Under 360 px the rank and file labels move inside the squares' corners.

## 4. Components

Every part is a function or a kit component built with `h()`; the page is passed to
`mountApp(page)` in `app.js`. Plugin-only modules live in `ui/chess.js` (rules and FEN) and
`ui/board.js` (drawing); the rest comes from `kit/components.js`.

### 4.1 Header

Plugin icon (`product/icon.svg` copied into `ui/`), name and tagline from `describe`
(`plugin.name`, `plugin.tagline`). Right side: "Ask the agent" button that opens the chat drawer
(4.8). No settings, no task picker (there is one task).

### 4.2 Board (`board.js`, plugin-only)

- An SVG 8×8 board, drawn from a FEN placement, oriented from the side to move by default (the
  same way the agent sees it); "Flip" turns it over without changing the side.
- Pieces: SVG pieces shipped in `ui/pieces/` (12 files; a permissively licensed set such as
  cburnett under its BSD-style license, with attribution in `ui/pieces/LICENSE`). Not Unicode
  glyphs: they render differently per font and are unreadable in dark mode.
- Square colours are mixes of the kit's `--accent` into `--surface`, so they follow the host's
  theme: light 12 % and 54 %, dark 52 % and 16 %. Each pair keeps about 2.1:1 contrast with
  itself, the way a printed board does (lichess's board is 2.3:1). White pieces keep a dark
  outline and black pieces a light inner stroke, so both read on both themes.
- The rank and file labels are one ink per theme (dark in light, light in dark, 4.9:1 or better
  against both square colours), each with a 2 px halo of its own square's colour so a label stays
  legible where a piece reaches into the corner.
- Overlays: last-move square tint, a solid accent arrow (`--accent`: `#3b5998` / `#8ea6d6`) for
  the agent's move, a dashed muted arrow for Stockfish's best move when different, a soft
  red ring for "not legal" in the illegal-move verdict.
- States: `editable` (setup), `locked` (running: no edits, pulsing 2 px accent outline),
  `review` (result: Before/After toggle shows the start FEN or `positions[0]`).
- When `board.json` gains a move during the run, the moving piece slides from its square to the
  target (200 ms, disabled under `prefers-reduced-motion`).
- Accessibility: each square is a `button` with `aria-label` "e4, white pawn" / "e4, empty";
  arrow keys move focus, Enter or Space picks up and drops a piece in edit mode. A visually
  hidden live region announces "The agent played knight c3 to d5".

### 4.3 Position setup panel (plugin-only)

- **Start from**: chips for ready positions. Selecting one loads it on the board. The default
  selected chip is "Win the queen" (the plugin's own test and example position), because it shows
  the grading at its clearest.

  | Chip | FEN | Side |
  |---|---|---|
  | Win the queen | `r1b2rk1/ppp2ppp/2n2n2/3qp3/1b6/2NP1N2/PPP1BPPP/R1BQ1RK1 w - - 0 8` | White |
  | Mate in one | `6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1` | White |
  | Opening | `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1` | White |
  | Black to move | `rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1` | Black |
  | Kings only | `4k3/8/8/8/8/8/8/4K3 w - - 0 1` | White |

  Each preset was confirmed to echo unchanged through the plugin's Stockfish (`engine.fen`) while
  the page was built, so no preset can hit the "Stockfish reads the position as" error. The chips
  wrap on a wide panel and scroll sideways on a phone.
- **Side to move**: a two-option segmented control. Changing it flips the board to that side
  and updates the button label ("Play a move as Black").
- **Edit pieces** (disclosure, closed by default): a palette of the 12 pieces plus an eraser.
  Click a palette piece then squares to place it; drag pieces on the board to move them; drag one
  off the board to remove it. Buttons: "Clear the board", "Starting position". Castling rights are not asked:
  the page grants each right exactly when the king and that rook stand on their home squares;
  en passant is always "-"; counters are "0 1". This is the canonical form Stockfish echoes for
  edited positions.
- **Paste a position** (disclosure): one text field, "Paste a FEN from any chess site". On
  paste the page checks it with the same pattern as `verifier/checks.py` and, if it passes,
  loads it on the board and leaves it as typed (the page sends a pasted FEN unchanged). A
  "Copy position" link copies the current FEN.
- **Live checks** (inline, under the board, in plain words; the Play button is disabled while
  any holds):
  - "Each side needs exactly one king."
  - "Pawns can't stand on the first or last rank."
  - "Black is in check but it's White's turn: that can't happen." (side not to move in check,
    from a small attack test in `chess.js`)
  The pasted FEN's own problem ("That doesn't look like a chess position.") stays on its field,
  not under the board. The line under the Play button names the paste problem, or, for a problem
  of the board itself, points at the list: "Fix the position first."

### 4.4 Play button (kit: run button)

Primary, full width of the panel: "Play a move as White/Black". Under it, muted: "Usually takes
a minute or two." Click: `runTask {task: "play-move", arguments: {fen}}`. Enter on the paste
field does the same. Disabled while a run is in progress or a live check fails.

### 4.5 Progress (kit: step timeline)

Replaces the setup panel while running. Title "Playing as White", an elapsed timer, and five
steps, each pending / active (spinner) / done:

| Step label | Becomes active on | Done on |
|---|---|---|
| Setting up | `runTask` reply `{runId}` / `task.started` | `task.reference` |
| Stockfish is scoring every legal move | `task.reference` | first `task.tool` |
| The agent is looking at the board | first `task.tool` (`open_board`) | first `task.tool` named `drag` or `click` after which `board.json` holds a move |
| The agent moved a piece | that event | `task.answer` |
| Checking the move | `task.answer` | `task.verdict` |

Details:
- After every `task.tool` whose `name` is `drag` or `click` (the names are read, never shown)
  the page calls `workspace.read {path: "board.json"}`, parses it, and if `moves` grew, animates
  the move on the board and fills the "moved a piece" step's sub-line ("Knight c3 → d5"). The
  board's caption then reads "The agent played Nxd5": the position on screen is no longer the one
  the side to move faced.
- A `drag` or `click` that leaves `moves` empty (a miss) shows a muted sub-line "A try didn't
  land; the agent is checking the board" under the looking step. An `isError: true` tool event
  is treated the same way: it is the agent's to recover from; the verdict decides.
- `task.tool` events arrive in batches (one per agent turn); the timeline only moves forward.
- "Stop" calls `cancel {runId}`.

### 4.6 Result card (kit: verdict badge + meter; plugin copy)

Built from `task.verdict`, the start FEN and the last `board.json` read (re-read once after
`task.verdict` so the board shows the final record).

- **Grade**, from `details.loss` (the page's labels; the number stays visible beside them):

  | loss | Label | Icon / tone |
  |---|---|---|
  | 0 (move = best) | Best move | ★ ok |
  | < 0.02 | Excellent | ok |
  | < 0.05 | Good | ok |
  | < 0.10 | Inaccuracy | warn |
  | < 0.20 | Mistake | warn |
  | ≥ 0.20 | Blunder | bad |

  Score shown at the right as "1.00" with `aria-label` "score 1.00 out of 1". Two decimals, except
  where they would round a score the run did not earn to a perfect (or a zero) one: an "Excellent"
  move whose score is 0.9982 shows "0.998", so the grade and the number never disagree.
- **Move in words**, from `details.move` (UCI) and the start FEN: the piece on the from-square,
  "takes <piece> on <square>" when the target is occupied (or en passant: pawn to an empty
  diagonal square), "castles kingside/queenside" when a king moves two files, "and becomes a
  queen" for a promotion suffix. A short algebraic form (`Nxd5`, `O-O`, `e8=Q`) beside it, in
  muted text, without check marks or disambiguation (the page has no move generator; it says
  only what it can derive for sure).
- **Winning chances**: a horizontal meter for the move played (`details.win_prob`), and, when the
  move was not Stockfish's best, a second one for it (`details.best_win_prob`, labelled with that
  move), plus "It gave away N points of winning chance." (N = round(loss × 100)). For the best move
  the second meter is left out: it would repeat the first to the last digit.
- **Checked line** (plain words of the verdict): "Checked by Stockfish: a legal move, played on
  the board, and the best one in this position." or "... and Stockfish's best was Nxd5."
  The raw `message` is in "How this was checked".
- **The agent's words**: `task.answer.text`, rendered as plain text (markdown bold stripped, and
  the closing "Move played: c3d5" line dropped: the card already says the move), first three lines
  with "more".
- **App reply** (rare): if `board.json` has `moves[1]`, a muted line "The board's engine
  answered with ...; that move is not scored."
- **How this was checked** (disclosure): "Before the agent saw the board, Stockfish scored every
  legal move of this position with a fixed search, the same way every time. The agent then
  played on the real board with the mouse, the way a person would. The page reads the game the
  board recorded and checks the move is legal, that it leads to the position Stockfish expects,
  and that it was the only move the agent played." Then the raw verdict message and the start FEN
  with a copy button.
- **Actions**: "Try another position" (back to setup, board keeps the start position), "Play
  again" (same FEN; the agent can choose differently), "Ask why" (opens the chat with a prepared
  question, 4.8).

### 4.7 Recent (plugin-only list, kit list styling)

The runs of this page's lifetime, newest first: short move, grade, preset name or "Your
position". Clicking one shows its result card again (kept in memory: start FEN, `board.json`
record, verdict, answer). Not written to the workspace; it is gone on reload. Hidden while empty.

### 4.8 Chat drawer (kit: `chatPanel` inside a drawer)

- "Ask the agent" in the header opens a right drawer (420 px) on wide screens, a full-height
  bottom sheet on narrow ones; Escape and a close button close it; focus is trapped while open
  and returns to the opener.
- Inside, the template's `chatPanel` over `prompt`. Intro: "Ask about chess or this position.
  To have the agent play on the board, use Play a move." (The chat agent cannot keep a live board
  across calls; see section 2.)
- Suggestion chips, which put text in the box (not sent until the user presses Send):
  - before a run: "What's the best plan for White here?"
  - after a result: "Why is Nxd5 the best move?", "What should Black do now?"
  Each suggestion includes the position, so the agent knows it without the board: "In the
  position <FEN> (White to move), the agent played c3d5 and Stockfish's best was c3d5. Why is
  Nxd5 the best move?"
- The chat's tool calls are not shown (the template's default).

## 5. Bridge calls and events, end to end

| When | Call / event | Used for |
|---|---|---|
| Load | `describe` | name, tagline, `theme` (applyTheme); the task list confirms `play-move` exists, or the page shows "This page doesn't match the installed plugin." |
| Theme change | `host.theme` | applyTheme; the board's colours are CSS variables, no redraw |
| Play | `runTask {task: "play-move", arguments: {fen}}` | `{runId}` |
| Running | `task.started`, `task.reference`, `task.tool`, `task.answer`, `task.verdict`, `task.error`, `task.done` | progress (4.5), result (4.6), errors (6) |
| After a `drag`/`click` event and after the verdict | `workspace.read {path: "board.json"}` | live move on the board, the final record |
| Stop | `cancel {runId}` | stop |
| Chat | `prompt {text}`, `chat.*` | the drawer |

Not used: `workspace.write` (the task takes no files), `workspace.list`, `task.result` (an agent
task sends none). The page never reads `board.json` outside a run: a file left by an earlier run
or another tab is not this run's result.

## 6. States and edge cases

- **Empty (first visit)**: the "Win the queen" position on the board, White to move, the Play
  button ready. Above the setup card one line: "Pick a position. The agent plays one move on a
  real board, and Stockfish grades it." Recent is hidden.
- **Running**: setup locked; the board shows the start position until `board.json` records a
  move. Leaving the page does not stop the server's run; on return the page starts fresh.
- **Two tabs, one workspace**: both runs write the same `board.json`. The page compares the
  record's `fen` with its own start FEN and ignores a record for another position; the verdict
  is the host's and stays authoritative.
- **Stopped**: `task.error {message: "cancelled"}` then `task.done`: neutral note "Stopped.
  Nothing was scored." and the setup panel returns with the same position.
- **Errors** (`task.error`, or a rejected `runTask`): a banner card in `--bad-soft` with a plain
  sentence, one action, and the original message under "Details":

  | Message contains | Plain words | Action |
  |---|---|---|
  | `Stockfish reads the position as '<fen>'` | "Stockfish writes this position a little differently." | "Use Stockfish's version" (loads `<fen>` and replays) |
  | `no legal move: the game is over` | "There's no move to play: this is checkmate or stalemate." | "Edit the position" |
  | `invalid input for task` | "That position couldn't be read." | "Edit the position" |
  | `no Stockfish`, `the board is not installed`, `no Chrome`, `under maintenance` | "The chess board isn't available on this server right now." | none (Play disabled until reload) |
  | `TimeoutError` / `timed out` | "The agent ran out of time before finishing." | "Try again" |
  | anything else | "Something went wrong while playing." | "Try again" |

- **Not valid verdicts** (score 0): the result card in its "bad" tone, the board shows what was
  recorded, and a plain sentence:
  - no `board.json` / "played no move": "The agent didn't manage to move a piece."
  - "played N moves": "The agent moved more than once. Only one move counts, so this run
    doesn't score." The arrows show each recorded move of the agent's, numbered.
  - "not a legal move": "The agent tried <move in words>, which isn't legal here." Red ring on
    the target square, and the board stays on the start position: the record of a move that
    cannot be played says nothing about where the pieces ended up. The legend under the board says
    the arrow shows the move the agent *tried*, not one it played.
  - "position recorded after ... is not the one": "The board's record didn't match the move, so
    it can't be scored."
  - "played from another position": "The board started from a different position than the
    one you gave."
  - "Play again" is the primary action here.
- **Promotion**: the plugin always queens (task instructions), so UCI ends in `q`; the words say
  "and becomes a queen".
- **Castling** UCI is king-two-files (`e1g1`): drawn as a king arrow, words "castles kingside".
- **Pasted FEN with an en-passant square or odd counters**: sent unchanged; if Stockfish writes
  it differently, the first error row above offers its version in one click.
- **Narrow widths**: section 3. The board never goes below 280 px; the palette wraps into two
  rows of six; meters stack label over bar; the sticky Play button respects the safe-area inset.
- **Themes**: every colour is a CSS variable under `html[data-theme]`; the board, arrows,
  meters and grade tones each have light and dark values, checked for 3:1 contrast against
  their background (arrows and meter fills) and 4.5:1 for text.
- **Reduced motion**: no piece slide, no pulsing outline; the timeline spinner becomes a static
  dot.

## 7. Files

```
plugins/chess-move/ui/
├── app.js            # the whole page: header, board, setup / progress / result, recent, chat drawer
├── board.js          # the SVG board, arrows, highlights, editing, animation
├── chess.js          # FEN parse/serialize, live checks, attack test, move-in-words
├── app.css           # this page's styles, every colour from the kit's variables
├── pieces/           # 12 SVG pieces + LICENSE.md
└── fonts/            # Inter woff2 (OFL) + LICENSE.md
```

All static, under the 5 MB limit, no build step. The page is one `app.js` rather than a separate
`layout.js`: the board, the setup, the progress and the result all read and write the same
position, so splitting them only moved the state across files.

Checked while building, with a host page that replays the plugin's own events (fixtures built by
`verifier.verify_task` over the example run in `examples/chess_move/outputs/step1_play_move/` and
real `pin_moves` output, so every verdict and answer on screen is one the plugin can produce):
best move, excellent, blunder, illegal move, two moves, no move, a board reply, a stop, and each
error row of section 6, in light and dark and at 420 px. `chess.js` was checked separately against
the fixture positions (FEN round trip, castling rights from the placement, the live checks, and
move-in-words for a capture, castling, en passant and a promotion).
