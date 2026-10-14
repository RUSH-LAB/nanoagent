// Chess facts the renderer needs and can be sure of: reading a FEN's placement, squares by name,
// and a UCI move in words. What a move is worth comes from the plugin's Stockfish.

const MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][nbrq]?$/;

export const PIECE_NAMES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
export const SIDE_NAMES = { w: "White", b: "Black" };

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

/**
 * A UCI move that led to the position `board`, in words, from the piece now on its target square:
 * "Knight c3 to d5", "Castles kingside", "Pawn e7 to e8, becoming a queen". Null when it can't be read.
 * @returns {null|{from: number, to: number, words: string}}
 */
export function describePlayed(board, uci) {
  if (!MOVE_PATTERN.test(uci ?? "")) return null;
  const from = squareIndex(uci.slice(0, 2));
  const to = squareIndex(uci.slice(2, 4));
  const piece = board[to];
  if (!piece) return null;
  if (piece.toLowerCase() === "k" && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    return { from, to, words: `Castles ${fileOf(to) > fileOf(from) ? "kingside" : "queenside"}` };
  }
  const name = uci[4] ? "pawn" : PIECE_NAMES[piece.toLowerCase()];
  const words = `${name[0].toUpperCase()}${name.slice(1)} ${squareName(from)} to ${squareName(to)}`;
  return { from, to, words: uci[4] ? `${words}, becoming a ${PIECE_NAMES[uci[4]]}` : words };
}
