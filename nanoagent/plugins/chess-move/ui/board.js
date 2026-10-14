// A chess board to look at: 64 squares with the Chessnut pieces, coordinates in the corners, the
// last move's squares marked and an SVG arrow for it.

import { h } from "./kit/components.js";
import { colorOf, fileOf, rankOf, squareName } from "./chess.js";

const SVG = "http://www.w3.org/2000/svg";

/** The file of a piece's image, e.g. "pieces/wN.svg" for "N". */
export function pieceSrc(piece) {
  return `pieces/${colorOf(piece)}${piece.toUpperCase()}.svg`;
}

function svg(tag, attrs) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

/**
 * A chess board showing `board` (64 squares, a8 first) with `bottom` ("w" or "b") nearest the
 * viewer, and `last`, the move that led to it as {from, to} square indexes, as an arrow.
 * @param {{board: Array<string|null>, bottom?: string, last?: {from: number, to: number}|null, label?: string}} options
 */
export function chessBoard({ board, bottom = "w", last = null, label = "Chess board" }) {
  // Visual position 0..63 (top-left first) <-> square index (a8 = 0).
  const indexAt = (position) => (bottom === "w" ? position : 63 - position);
  const centre = (index) => {
    const position = bottom === "w" ? index : 63 - index;
    return [(position % 8) * 100 + 50, Math.floor(position / 8) * 100 + 50];
  };

  const squares = Array.from({ length: 64 }, (_, position) => {
    const index = indexAt(position);
    const piece = board[index];
    const name = squareName(index);
    const marked = last && (index === last.from || index === last.to);
    return h(
      "div",
      { class: `sq ${(fileOf(index) + rankOf(index)) % 2 ? "dark" : "light"}${marked ? " last" : ""}` },
      position % 8 === 0 ? h("span", { class: "coord rank", text: String(rankOf(index)) }) : null,
      position >= 56 ? h("span", { class: "coord file", text: name[0] }) : null,
      piece ? h("img", { class: `piece ${colorOf(piece)}`, src: pieceSrc(piece), alt: "", draggable: false }) : null,
    );
  });
  const layer = svg("svg", { class: "board-marks", viewBox: "0 0 800 800", "aria-hidden": "true" });
  if (last) layer.append(arrow(centre(last.from), centre(last.to)));
  return h("div", { class: "chessboard", role: "img", "aria-label": label }, h("div", { class: "board-grid", "aria-hidden": "true" }, squares), layer);
}

function arrow([x1, y1], [x2, y2]) {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length];
  const head = 34;
  const [bx, by] = [x2 - ux * head, y2 - uy * head];
  const [nx, ny] = [-uy, ux];
  const group = svg("g", { class: "arrow" });
  group.append(
    svg("line", { x1: x1 + ux * 18, y1: y1 + uy * 18, x2: bx, y2: by, "stroke-width": 15, "stroke-linecap": "round" }),
    svg("polygon", { points: `${x2},${y2} ${bx + nx * head * 0.62},${by + ny * head * 0.62} ${bx - nx * head * 0.62},${by - ny * head * 0.62}` }),
  );
  return group;
}
