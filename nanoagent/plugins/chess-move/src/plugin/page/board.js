/** The board: draws GET /state, and sends the move a drag or two clicks make to POST /move.
 *
 * `data-busy` on <body> is "false" whenever the board shows the server's latest state, so the
 * plugin knows when a screenshot is of the position the game is in.
 */

import { Chessground } from "/chessgroundx/chessground.js";

// chessgroundx's role for each FEN letter: the names its cburnett.css draws.
const ROLES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const FILES = "abcdefgh";

let state = null;

/** Every square of the FEN's board, so a square the position leaves empty is emptied. */
function pieces(fen) {
  const diff = new Map();
  fen.split(" ")[0].split("/").forEach((row, index) => {
    let file = 0;
    for (const letter of row) {
      if (/\d/.test(letter)) {
        for (let n = 0; n < Number(letter); n++) diff.set(FILES[file++] + (8 - index), undefined);
      } else {
        const color = letter === letter.toUpperCase() ? "white" : "black";
        diff.set(FILES[file++] + (8 - index), { role: ROLES[letter.toLowerCase()], color });
      }
    }
  });
  return diff;
}

/** The legal moves as chessground's origin -> destinations map. */
function dests(legal) {
  const out = new Map();
  for (const move of legal) {
    const from = move.slice(0, 2), to = move.slice(2, 4);
    if (!out.has(from)) out.set(from, []);
    if (!out.get(from).includes(to)) out.get(from).push(to);
  }
  return out;
}

function draw(next) {
  state = next;
  cg.set({
    orientation: state.player,
    turnColor: state.turn,
    lastMove: state.last ? [state.last.slice(0, 2), state.last.slice(2, 4)] : undefined,
    movable: { color: state.turn === state.player ? state.player : undefined, dests: dests(state.legal) },
  });
  cg.setPieces(pieces(state.fen));
  document.body.dataset.busy = "false";
}

async function load(response) {
  if (!response.ok) throw new Error(`${response.url}: ${response.status} ${await response.text()}`);
  draw(await response.json());
}

/** The move between two squares: a pawn reaching the last rank becomes a queen. */
async function after(orig, dest) {
  document.body.dataset.busy = "true";
  const moves = state.legal.filter((move) => move.slice(0, 4) === orig + dest);
  const move = moves.find((m) => m.endsWith("q")) || moves[0];
  await load(await fetch("/move", { method: "POST", body: JSON.stringify({ move }) }));
}

const cg = Chessground(document.getElementById("board"), {
  coordinates: true,
  kingRoles: ["king"],
  autoCastle: false,
  movable: { free: false, showDests: true, events: { after } },
  premovable: { enabled: false },
  drawable: { enabled: false, visible: false },
  animation: { enabled: false },
});

await load(await fetch("/state"));
