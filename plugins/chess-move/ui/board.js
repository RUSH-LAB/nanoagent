// The page's chess board: 64 square buttons with the Chessnut pieces, coordinates in the corners,
// an SVG layer for arrows and rings, editing (a palette tool, click to pick up and drop, drag, drag
// off to remove, the keyboard) and the slide of a piece the agent moved.

import { h } from "./kit/components.js";
import { PIECE_NAMES, colorOf, fileOf, pieceWords, rankOf, squareName } from "./chess.js";

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
 * A chess board.
 * @param {{label?: string, onEdit?: (board: Array<string|null>) => void}} options `onEdit` gets
 *   the new 64 squares after each change the person makes in edit mode.
 */
export function chessBoard({ label = "Chess board", onEdit } = {}) {
  let board = Array(64).fill(null);
  let bottom = "w";
  let mode = "view";
  let tool = null; // null (move pieces), a piece letter, or "erase"
  let picked = null;
  let focused = 56; // a1 when White is at the bottom
  let marks = { arrows: [], ring: null, last: null };
  let drag = null;
  let suppressClick = false;

  const squares = Array.from({ length: 64 }, (_, index) =>
    h("button", { type: "button", class: `sq ${(fileOf(index) + rankOf(index)) % 2 ? "dark" : "light"}`, "data-index": String(index), tabindex: "-1" }),
  );
  const grid = h("div", { class: "board-grid", role: "group", "aria-label": label }, squares);
  const layer = svg("svg", { class: "board-marks", viewBox: "0 0 800 800", "aria-hidden": "true" });
  const ghost = h("img", { class: "drag-ghost", alt: "", hidden: true, draggable: false });
  const element = h("div", { class: "chessboard", "data-mode": mode }, grid, layer, ghost);

  // Visual position 0..63 (top-left first) <-> square index (a8 = 0).
  const indexAt = (position) => (bottom === "w" ? position : 63 - position);
  const positionOf = (index) => (bottom === "w" ? index : 63 - index);
  const centre = (index) => {
    const position = positionOf(index);
    return [(position % 8) * 100 + 50, Math.floor(position / 8) * 100 + 50];
  };

  function render() {
    grid.replaceChildren(...Array.from({ length: 64 }, (_, position) => squares[indexAt(position)]));
    for (const [index, square] of squares.entries()) {
      const position = positionOf(index);
      const piece = board[index];
      const name = squareName(index);
      square.replaceChildren(
        ...[
          position % 8 === 0 ? h("span", { class: "coord rank", "aria-hidden": "true", text: String(rankOf(index)) }) : null,
          position >= 56 ? h("span", { class: "coord file", "aria-hidden": "true", text: name[0] }) : null,
          piece ? h("img", { class: `piece ${colorOf(piece)}`, src: pieceSrc(piece), alt: "", draggable: false }) : null,
        ].filter(Boolean),
      );
      square.setAttribute("aria-label", `${name}, ${piece ? pieceWords(piece) : "empty"}${picked === index ? ", picked up" : ""}`);
      square.tabIndex = index === focused ? 0 : -1;
      square.classList.toggle("picked", picked === index);
      square.classList.toggle("last", Boolean(marks.last?.includes(index)));
      square.disabled = false;
    }
    drawMarks();
  }

  function arrow({ from, to, kind = "agent", label: text }) {
    const [x1, y1] = centre(from);
    const [x2, y2] = centre(to);
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length];
    const head = 34;
    const width = kind === "agent" ? 15 : 11;
    const [bx, by] = [x2 - ux * head, y2 - uy * head];
    const [nx, ny] = [-uy, ux];
    const group = svg("g", { class: `arrow ${kind}` });
    group.append(
      svg("line", { x1: x1 + ux * 18, y1: y1 + uy * 18, x2: bx, y2: by, "stroke-width": width, "stroke-linecap": kind === "agent" ? "round" : "butt" }),
      svg("polygon", { points: `${x2},${y2} ${bx + nx * head * 0.62},${by + ny * head * 0.62} ${bx - nx * head * 0.62},${by - ny * head * 0.62}` }),
    );
    if (text) {
      const [cx, cy] = [x1 + ux * 22, y1 + uy * 22];
      const badge = svg("g", { class: "arrow-badge" });
      badge.append(svg("circle", { cx, cy, r: 17 }));
      const label = svg("text", { x: cx, y: cy + 6, "text-anchor": "middle" });
      label.textContent = text;
      badge.append(label);
      group.append(badge);
    }
    return group;
  }

  function drawMarks() {
    layer.replaceChildren();
    if (marks.ring !== null && marks.ring !== undefined) {
      const [cx, cy] = centre(marks.ring);
      layer.append(svg("circle", { class: "ring", cx, cy, r: 44 }));
    }
    // The best move under the agent's, so the agent's stays on top.
    for (const one of [...marks.arrows].sort((a, b) => (b.kind === "best") - (a.kind === "best"))) layer.append(arrow(one));
  }

  const change = (next) => {
    board = next;
    render();
    onEdit?.([...board]);
  };

  function act(index) {
    if (mode !== "edit") return;
    const next = [...board];
    if (tool === "erase") {
      if (!next[index]) return;
      next[index] = null;
    } else if (tool) {
      next[index] = next[index] === tool ? null : tool;
    } else if (picked === null) {
      if (!next[index]) return;
      picked = index;
      render();
      squares[index].focus();
      return;
    } else {
      if (index !== picked) {
        next[index] = next[picked];
        next[picked] = null;
      }
      picked = null;
    }
    change(next);
    squares[index].focus();
  }

  grid.addEventListener("click", (event) => {
    const square = event.target.closest(".sq");
    if (!square) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    focused = Number(square.dataset.index);
    act(focused);
  });

  grid.addEventListener("keydown", (event) => {
    const square = event.target.closest(".sq");
    if (!square) return;
    const index = Number(square.dataset.index);
    const position = positionOf(index);
    const moves = { ArrowLeft: position % 8 ? -1 : 0, ArrowRight: position % 8 < 7 ? 1 : 0, ArrowUp: position >= 8 ? -8 : 0, ArrowDown: position < 56 ? 8 : 0 };
    if (event.key in moves) {
      event.preventDefault();
      focused = indexAt(position + moves[event.key]);
      render();
      squares[focused].focus();
    } else if ((event.key === "Delete" || event.key === "Backspace") && mode === "edit" && board[index]) {
      event.preventDefault();
      picked = null;
      const next = [...board];
      next[index] = null;
      change(next);
      squares[index].focus();
    } else if (event.key === "Escape" && picked !== null) {
      picked = null;
      render();
      squares[index].focus();
    }
  });

  grid.addEventListener("pointerdown", (event) => {
    const square = event.target.closest(".sq");
    if (!square || mode !== "edit" || tool || event.button !== 0) return;
    const index = Number(square.dataset.index);
    if (!board[index]) return;
    drag = { index, x: event.clientX, y: event.clientY, moving: false, pointer: event.pointerId };
  });
  window.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!drag.moving && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    if (!drag.moving) {
      drag.moving = true;
      picked = null;
      ghost.src = pieceSrc(board[drag.index]);
      ghost.hidden = false;
      squares[drag.index].classList.add("lifted");
    }
    const box = element.getBoundingClientRect();
    const size = box.width / 8;
    ghost.style.width = `${size}px`;
    ghost.style.transform = `translate(${event.clientX - box.left - size / 2}px, ${event.clientY - box.top - size / 2}px)`;
  });
  window.addEventListener("pointerup", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const { index, moving } = drag;
    drag = null;
    if (!moving) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    ghost.hidden = true;
    squares[index].classList.remove("lifted");
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".sq");
    const next = [...board];
    if (target && grid.contains(target)) {
      const to = Number(target.dataset.index);
      if (to === index) return;
      next[to] = next[index];
    }
    next[index] = null; // dropped off the board: removed
    change(next);
  });

  return {
    element,
    /** Show 64 squares; `slide` animates the piece now on `slide.to` in from `slide.from`. */
    show(next, { slide } = {}) {
      board = [...next];
      picked = null;
      render();
      if (!slide) return;
      const piece = squares[slide.to].querySelector(".piece");
      if (!piece) return;
      const [x1, y1] = centre(slide.from);
      const [x2, y2] = centre(slide.to);
      piece.style.transition = "none";
      piece.style.transform = `translate(${x1 - x2}%, ${y1 - y2}%)`;
      piece.getBoundingClientRect();
      piece.style.transition = "";
      piece.style.transform = "";
    },
    /** Which side sits at the bottom, "w" or "b". */
    orient(side) {
      bottom = side;
      render();
    },
    /** "view" (look only), "edit" (the person changes the position) or "locked" (a run is on). */
    setMode(next) {
      mode = next;
      picked = null;
      element.dataset.mode = next;
      render();
    },
    /** In edit mode: null moves pieces; a piece letter places it; "erase" removes. */
    setTool(next) {
      tool = next;
      picked = null;
      element.dataset.tool = next ? "place" : "";
      render();
    },
    /** Arrows [{from, to, kind: "agent"|"best", label}], a red ring on one square, a last move [from, to]. */
    setMarks(next) {
      marks = { arrows: [], ring: null, last: null, ...next };
      render();
    },
  };
}

/** The pieces a palette offers, white then black. */
export const PALETTE = ["K", "Q", "R", "B", "N", "P", "k", "q", "r", "b", "n", "p"];
export const paletteLabel = (piece) => `${colorOf(piece) === "w" ? "White" : "Black"} ${PIECE_NAMES[piece.toLowerCase()]}`;
