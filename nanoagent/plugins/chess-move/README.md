# Chess Move

Play one chess move with the mouse on a live board, scored by Stockfish. Everything it runs is in
this folder or comes from PyPI and GitHub when it is installed, except Chrome.

## Tools

| Tool | Does | Code |
|---|---|---|
| `pin_moves` | Scores every legal move of a position with Stockfish (fixed nodes, one thread) and pins each one's resulting FEN and win probability for the mover; the `play-move` task's reference | `src/plugin/pin.py` |
| `open_board` | Opens the board on the given FEN, with the agent playing the side to move, and returns a screenshot of the board drawn from that side | `src/plugin/board.py` |
| `screenshot` | A fresh screenshot of the live board | `src/plugin/play.py` |
| `drag` | Press at `from_xy`, drag to `to_xy`, release — pixels in the board screenshot | `src/plugin/play.py` |
| `click` | Click at `xy`, a point in the board screenshot | `src/plugin/play.py` |

The server, the headless browser and the game live for the whole task: NanoAgent runs one plugin
process per `nanoagent plugin agent` run. After every mouse action the plugin writes
`board.json` into the workspace, with the FEN the game started from, every move played since (UCI)
and the FEN after each one. The board takes a move only from the side to move at the start, and
only on its turn, so the one move it records is the agent's.

Stockfish is deterministic here: one thread, `ucinewgame` before every search, a fixed node
budget per legal move (`NODES`), and both the pin and the live board use the same binary.

## The play-move task

`play-move` runs an agent that reads one FEN. `pin_moves(fen)` runs first in a scratch workspace;
its output is pinned (`reference.json`) and passed to `verify_task`. The agent gets `open_board`,
`screenshot`, `drag` and `click`.

`verifier/play.py` reads `board.json`, picks the agent's move (`moves[0]`), checks that it is one
of the pinned legal moves, and that the position recorded after it matches the one `pin_moves`
pinned. The score is 1 minus the win probability it gave away against the pinned best move. A run
with no agent move, an illegal one, or more than one agent move fails.

## The board

`src/plugin/board.py` serves the page in `src/plugin/page/` on loopback: chessgroundx 10.7.5
(lichess's board, copied into `page/chessgroundx/`) drawing the game, which Stockfish keeps legal.
The page offers only the moves Stockfish lists and the server takes only those; a pawn reaching the
last rank becomes a queen. `src/plugin/chrome.py` starts the first Chrome installed where Chrome
installs itself, headless, and drives it over the DevTools protocol: the screenshot is the board
alone, and a drag or a click is real mouse events at the screenshot's pixels. `run.sh` checks for
Chrome before every launch and refuses with a clear message if it is missing.

## Stockfish

`src/chess-move-stockfish/` is the `chess-move-stockfish` package, a path dependency. Its
`vendor/Stockfish` is official-stockfish/Stockfish at `762dd1da9a5d` (stockfish-dev-20260803,
GPLv3), and its `setup.py` compiles it with `make build ARCH=native`, embedding the NNUE net it
fetches from GitHub's copy of official-stockfish/networks and checks against the sha256 in its
name. So installing the plugin builds Stockfish: it needs `make` and a C++ compiler, and takes
about a minute.

## Layout

```text
.
├── nanoagent.yaml   # manifest (a slimconfig ManifestConfig): tools, tasks (play-move: runner agent, reference pin_moves)
├── contract.py      # each tool's and task's typed input and output: slimconfig Output classes
├── README.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── .gitignore
├── .env             # no variables
├── run.sh           # checks the browser
├── src/
│   ├── plugin/      # the MCP server (__main__.py, its IMPLEMENTATIONS table), one module per tool, the board and Chrome
│   │   └── page/    # the board's page and chessgroundx
│   └── chess-move-stockfish/  # the vendored Stockfish and the build that compiles it
├── tests/
└── verifier/        # deterministic verifier, one module per tool, play.py for the task
```

`contract.py` types every value: the server builds each call's input into its class and checks
its output against its own, and NanoAgent and the verifier get the same classes. A failing tool
raises, and the MCP server returns the error. The screenshot's `images` are what NanoAgent
forwards to the model as images. `verifier/` imports only the standard library and `contract`;
it checks what the types cannot (a FEN's and a move's spelling, points of two non-negative
pixels, a win probability between 0 and 1) and reads `board.json` from the workspace.

## Develop and run

```bash
uv sync --extra dev
uv run pytest
uv run ruff check .
bash run.sh
# From the NanoAgent root:
.venv/bin/nanoagent plugin inspect plugins/chess-move
bash examples/chess_move/runs/step1_play_move.sh
```
