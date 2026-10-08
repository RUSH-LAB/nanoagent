// Chess facts the page needs and can be sure of: reading and writing FEN, the checks a position
// must pass before Stockfish sees it, whether a square is attacked, and a UCI move in words.
// There is no move generator: what a move is worth comes from the plugin's Stockfish.

/** The same pattern as the plugin's verifier (verifier/checks.py FEN). */
export const FEN_PATTERN = /^([pnbrqkPNBRQK1-8]{1,8}\/){7}[pnbrqkPNBRQK1-8]{1,8} [wb] (-|K?Q?k?q?) (-|[a-h][36]) \d+ \d+$/;
const MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][nbrq]?$/;

export const PIECE_NAMES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
export const SIDE_NAMES = { w: "White", b: "Black" };
export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Square index 0..63, a8 = 0 and h1 = 63, the order FEN lists them in. */
export const fileOf = (index) => index % 8;
export const rankOf = (index) => 8 - Math.floor(index / 8);
export const squareName = (index) => `${"abcdefgh"[fileOf(index)]}${rankOf(index)}`;
export const squareIndex = (name) => (8 - Number(name[1])) * 8 + "abcdefgh".indexOf(name[0]);
export const colorOf = (piece) => (piece === piece.toUpperCase() ? "w" : "b");

/** "white knight", for a FEN piece letter. */
export function pieceWords(piece) {
  return `${colorOf(piece) === "w" ? "white" : "black"} ${PIECE_NAMES[piece.toLowerCase()]}`;
}

/** The placement field of a FEN as 64 squares (a piece letter or null). Throws on a bad field. */
export function parsePlacement(placement) {
  const rows = placement.split("/");
  if (rows.length !== 8) throw new Error("a FEN placement has eight ranks");
  const board = [];
  for (const row of rows) {
    let count = 0;
    for (const char of row) {
      if (/[1-8]/.test(char)) {
        for (let i = 0; i < Number(char); i += 1) board.push(null);
        count += Number(char);
      } else if (/[pnbrqkPNBRQK]/.test(char)) {
        board.push(char);
        count += 1;
      } else throw new Error(`${char} is not a piece`);
    }
    if (count !== 8) throw new Error("each rank has eight squares");
  }
  return board;
}

/** The placement field for 64 squares. */
export function placementOf(board) {
  const rows = [];
  for (let rank = 0; rank < 8; rank += 1) {
    let row = "";
    let empty = 0;
    for (const piece of board.slice(rank * 8, rank * 8 + 8)) {
      if (piece) {
        if (empty) row += empty;
        row += piece;
        empty = 0;
      } else empty += 1;
    }
    rows.push(row + (empty ? empty : ""));
  }
  return rows.join("/");
}

/** A FEN that matches {@link FEN_PATTERN}, as {board, side, castling, ep}; null when it doesn't. */
export function parseFen(fen) {
  const text = String(fen ?? "").trim();
  if (!FEN_PATTERN.test(text)) return null;
  const [placement, side, castling, ep] = text.split(" ");
  try {
    return { board: parsePlacement(placement), side, castling, ep, fen: text };
  } catch {
    return null;
  }
}

/** The castling rights the placement allows: each one exactly when its king and rook are home. */
export function castlingFor(board) {
  const at = (name) => board[squareIndex(name)];
  let rights = "";
  if (at("e1") === "K") {
    if (at("h1") === "R") rights += "K";
    if (at("a1") === "R") rights += "Q";
  }
  if (at("e8") === "k") {
    if (at("h8") === "r") rights += "k";
    if (at("a8") === "r") rights += "q";
  }
  return rights || "-";
}

/** The FEN of an edited position, the way Stockfish writes it back: rights from the placement,
 * no en passant square, fresh counters. */
export function canonicalFen(board, side) {
  return `${placementOf(board)} ${side} ${castlingFor(board)} - 0 1`;
}

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 1], [1, 0], [1, -1], [0, 1], [0, -1], [-1, 1], [-1, 0], [-1, -1]];
const ROOK_LINES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_LINES = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** True when a piece of `by` ("w" or "b") attacks square `index`. */
export function attacked(board, index, by) {
  const file = fileOf(index);
  const rank = rankOf(index);
  const at = (f, r) => (f >= 0 && f < 8 && r >= 1 && r <= 8 ? board[(8 - r) * 8 + f] : undefined);
  const own = (letter) => (by === "w" ? letter.toUpperCase() : letter);
  const pawnRank = by === "w" ? rank - 1 : rank + 1;
  if (at(file - 1, pawnRank) === own("p") || at(file + 1, pawnRank) === own("p")) return true;
  if (KNIGHT.some(([df, dr]) => at(file + df, rank + dr) === own("n"))) return true;
  if (KING.some(([df, dr]) => at(file + df, rank + dr) === own("k"))) return true;
  const slides = (lines, letters) =>
    lines.some(([df, dr]) => {
      for (let step = 1; step < 8; step += 1) {
        const piece = at(file + df * step, rank + dr * step);
        if (piece === undefined) return false;
        if (piece) return letters.some((letter) => piece === own(letter));
      }
      return false;
    });
  return slides(ROOK_LINES, ["r", "q"]) || slides(BISHOP_LINES, ["b", "q"]);
}

/** What makes the position one Stockfish can't play, in plain words; empty when it is fine. */
export function positionProblems(board, side) {
  const problems = [];
  const count = (piece) => board.filter((one) => one === piece).length;
  if (count("K") !== 1 || count("k") !== 1) problems.push("Each side needs exactly one king.");
  const backRanks = [...board.slice(0, 8), ...board.slice(56)];
  if (backRanks.some((piece) => piece === "P" || piece === "p")) problems.push("Pawns can't stand on the first or last rank.");
  if (count("K") === 1 && count("k") === 1) {
    const other = side === "w" ? "b" : "w";
    const king = board.indexOf(other === "w" ? "K" : "k");
    if (attacked(board, king, side)) problems.push(`${SIDE_NAMES[other]} is in check but it's ${SIDE_NAMES[side]}'s turn: that can't happen.`);
  }
  return problems;
}

/**
 * A UCI move of the position `board`, in words and short algebraic form, with only what can be
 * derived for sure (no check marks, no disambiguation). Null when the move can't be read.
 * @returns {null|{from: number, to: number, piece: string, words: string, short: string, said: string}}
 *   `words` "Knight c3 takes the queen on d5"; `short` "Nxd5"; `said` "knight c3 to d5" (for announcements).
 */
export function describeMove(board, uci) {
  if (!MOVE_PATTERN.test(uci ?? "")) return null;
  const from = squareIndex(uci.slice(0, 2));
  const to = squareIndex(uci.slice(2, 4));
  const piece = board[from];
  if (!piece) return null;
  const kind = piece.toLowerCase();
  const name = PIECE_NAMES[kind];
  const Name = name[0].toUpperCase() + name.slice(1);
  const fromName = squareName(from);
  const toName = squareName(to);
  const promotion = uci[4] ? PIECE_NAMES[uci[4]] : null;
  const said = `${name} ${fromName} to ${toName}`;
  if (kind === "k" && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    const kingside = fileOf(to) > fileOf(from);
    return { from, to, piece, words: `Castles ${kingside ? "kingside" : "queenside"}`, short: kingside ? "O-O" : "O-O-O", said: `castles ${kingside ? "kingside" : "queenside"}` };
  }
  let captured = board[to];
  let enPassant = false;
  if (!captured && kind === "p" && fileOf(to) !== fileOf(from)) {
    captured = colorOf(piece) === "w" ? "p" : "P";
    enPassant = true;
  }
  let words = captured ? `${Name} ${fromName} takes the ${PIECE_NAMES[captured.toLowerCase()]} on ${toName}` : `${Name} ${fromName} to ${toName}`;
  if (enPassant) words += " (en passant)";
  if (promotion) words += ` and becomes a ${promotion}`;
  const letter = kind === "p" ? "" : kind.toUpperCase();
  const short = `${letter}${captured ? `${kind === "p" ? "abcdefgh"[fileOf(from)] : ""}x` : ""}${toName}${promotion ? `=${uci[4].toUpperCase()}` : ""}`;
  return { from, to, piece, words, short, said: `${said}${promotion ? `, becoming a ${promotion}` : ""}` };
}
