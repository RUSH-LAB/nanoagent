# Chess Move

Play one chess move on [mind-sports-arena](https://github.com/zeyuyang8/mind-sports-arena)'s live
board, scored by Stockfish.

## Tools

| Tool | Does | Code |
|---|---|---|
| `pin_moves` | Scores every legal move of a position with Stockfish (fixed nodes, one thread) and pins each one's resulting FEN and win probability for the mover; the `play-move` task's reference | `src/plugin/pin.py` |
| `open_board` | Starts msa's chess app on the given FEN, with the agent playing the side to move, and returns a screenshot of the board drawn from that side | `src/plugin/board.py` |
| `screenshot` | A fresh screenshot of the live board | `src/plugin/play.py` |
| `drag` | Press at `from_xy`, drag to `to_xy`, release — pixels in the board screenshot | `src/plugin/play.py` |
| `click` | Click at `xy`, a point in the board screenshot | `src/plugin/play.py` |

The server, the headless browser and the game live for the whole task: NanoAgent runs one plugin
process per `nanoagent plugin agent` run. After every mouse action the plugin writes
`board.json` into the workspace, with the FEN the game started from, every move msa's engine has
played since (UCI) and the FEN after each one. The agent moves first from the start position, so
the moves at even indices are the agent's own; a message from msa's web app that replies with its
own move will show at an odd index and is not scored against the agent.

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

## mind-sports-arena

msa's checkout is found at `MSA_ROOT` (its `src/msa` is added to `sys.path`; it is a virtual
project with no wheel). `LOCALDB` is where msa's `sandbox.sh` builds Stockfish, and `CHROME_BIN`
is the browser `msa.cdp.Headless` opens the page in. `run.sh` checks all three before every
launch and refuses with a clear message if any is missing.

This plugin needs msa's chess app to start from a FEN. The smallest change — a `fen` attribute on
`UciGame` that `_position` sends to the engine, and `side` counted from that FEN — lives on
`UciGame` in `src/msa/engines.py`.

## Layout

```text
.
├── nanoagent.yaml   # manifest: tools, tasks (play-move: runner agent, reference pin_moves)
├── README.md
├── LICENSE
├── pyproject.toml
├── uv.lock
├── .gitignore
├── .env             # MSA_ROOT, LOCALDB, CHROME_BIN — names only
├── run.sh           # checks the three variables, Stockfish, node_modules and the browser
├── schemas/
├── src/plugin/      # the MCP server (__main__.py) and one module per tool
├── tests/
└── verifier/        # deterministic verifier, one module per tool, play.py for the task
```

## Develop and run

```bash
uv sync --extra dev
uv run pytest
uv run ruff check .
MSA_ROOT=<mind-sports-arena> LOCALDB=<msa>/local/db CHROME_BIN=<chrome> bash run.sh
# From the NanoAgent root:
.venv/bin/nanoagent plugin inspect plugins/chess-move
bash examples/chess_move/runs/step1_play_move.sh
```
