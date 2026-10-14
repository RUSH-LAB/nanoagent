// How Chess Move's page draws its outputs: a played move as the board it led to, the move in words
// and an arrow, over the output's fields. A move the verifier did not check may not be a position
// at all, so it shows only the fields.

import { h, schemaView } from "./kit/components.js";
import { SIDE_NAMES, describePlayed, parsePlacement } from "./chess.js";
import { chessBoard } from "./board.js";

function playedMove(value, { task, verdict }) {
  const fields = schemaView(value, task.outputSchema);
  if (!verdict.valid) return fields;
  const [placement, toMove] = value.position.split(" ");
  const board = parsePlacement(placement);
  const mover = toMove === "w" ? "b" : "w";
  const played = describePlayed(board, value.move);
  const { best } = verdict.details;
  return h(
    "div",
    { class: "played-move" },
    h("p", { class: "move-words", text: `${SIDE_NAMES[mover]}: ${played.words}` }),
    chessBoard({ board, bottom: mover, last: played, label: `The board after ${played.words.toLowerCase()}` }),
    best === value.move ? null : h("p", { class: "muted", text: `Stockfish's best move was ${best}.` }),
    fields,
  );
}

export default { PlayedMove: playedMove };
