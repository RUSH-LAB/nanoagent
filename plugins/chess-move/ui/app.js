// Chess Move's page: set up a position on a board, let the agent play one move on the live board,
// and read how good it was in plain words. The chat with the agent sits in a drawer.

import {
  actionBar,
  announce,
  appShell,
  banner,
  card,
  columns,
  copyButton,
  copyField,
  chipRow,
  disclosure,
  emptyState,
  explainError,
  errorCard,
  h,
  icon,
  labeled,
  meter,
  mountApp,
  plural,
  readJSON,
  runButton,
  segmented,
  statusPill,
  taskRun,
} from "./kit/components.js";
import { SIDE_NAMES, START_FEN, canonicalFen, describeMove, parseFen, positionProblems, squareIndex } from "./chess.js";
import { PALETTE, chessBoard, paletteLabel, pieceSrc } from "./board.js";

const TASK = "play-move";
const RECORD = "board.json";

// Each one echoes unchanged through the plugin's Stockfish (engine.fen), so none can hit the
// "Stockfish reads the position as" error.
const PRESETS = [
  { id: "queen", label: "Win the queen", fen: "r1b2rk1/ppp2ppp/2n2n2/3qp3/1b6/2NP1N2/PPP1BPPP/R1BQ1RK1 w - - 0 8" },
  { id: "mate", label: "Mate in one", fen: "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1" },
  { id: "opening", label: "Opening", fen: START_FEN },
  { id: "black", label: "Black to move", fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1" },
  { id: "kings", label: "Kings only", fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1" },
];

const STEPS = [
  { id: "setup", label: "Setting up" },
  { id: "score", label: "Stockfish is scoring every legal move" },
  { id: "look", label: "The agent is looking at the board" },
  { id: "move", label: "The agent moved a piece" },
  { id: "check", label: "Checking the move" },
];

const UNAVAILABLE = "The chess board isn't available on this server right now.";

const other = (side) => (side === "w" ? "b" : "w");
const percent = (value) => `${Math.round(value * 100)}%`;
// The verifier's score, in two decimals, unless they would read as a perfect (or a zero) score the
// run did not earn: 0.998 stays 0.998 beside "Excellent".
const scoreText = (score) => {
  const text = score.toFixed(2);
  return (text === "1.00" && score < 1) || (text === "0.00" && score > 0) ? score.toFixed(3) : text;
};
// The agent writes a little markdown; the page shows plain text.
// Its closing "Move played: c3d5" line repeats what the result card already says, so it is dropped.
const plainText = (text) =>
  String(text ?? "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*Move played:\s*[a-h][1-8][a-h][1-8][nbrq]?\s*$/gim, "")
    .trim();

/** The grade of a scored move, from the win probability it gave away. */
function grade({ move, best, loss }) {
  if (move === best || loss === 0) return { label: "Best move", tone: "ok", icon: "spark" };
  if (loss < 0.02) return { label: "Excellent", tone: "ok", icon: "check" };
  if (loss < 0.05) return { label: "Good", tone: "ok", icon: "check" };
  if (loss < 0.1) return { label: "Inaccuracy", tone: "warn", icon: "alert" };
  if (loss < 0.2) return { label: "Mistake", tone: "warn", icon: "alert" };
  return { label: "Blunder", tone: "bad", icon: "error" };
}

/** Why a run that was checked did not score, in plain words. */
function notScored(entry) {
  const message = entry.verdict.message ?? "";
  if (message.includes(`no ${RECORD}`) || message.includes("played no move")) return "The agent didn't manage to move a piece.";
  if (/played \d+ moves/.test(message)) return "The agent moved more than once. Only one move counts, so this run doesn't score.";
  const illegal = message.match(/^(\S+) is not a legal move/);
  if (illegal) {
    const move = describeMove(entry.board, illegal[1]);
    return `The agent tried ${move ? move.words.replace(/^./, (c) => c.toLowerCase()) : illegal[1]}, which isn't legal here.`;
  }
  if (message.includes("is not the one")) return "The board's record didn't match the move, so it can't be scored.";
  if (message.includes("another position")) return "The board started from a different position than the one you gave.";
  return "The board's record couldn't be read, so this run doesn't score.";
}

function chessPage({ plugin }) {
  if (!plugin.tasks?.some((task) => task.id === TASK)) {
    const shell = appShell({ plugin, chat: false });
    shell.main.append(card({}, emptyState({ icon: "alert", title: "This page doesn't match the installed plugin.", body: `It plays the ${TASK} task, which this version of ${plugin.name} doesn't have.` })));
    return shell.element;
  }

  let position = null; // {board, side, fen, preset}
  let view = "setup"; // setup | running | result
  let flipped = false;
  let pasteProblem = null;
  let unavailable = false;
  let current = null; // the run in progress
  let shown = null; // the result on screen
  const history = [];

  // Board column ------------------------------------------------------------------------------

  const board = chessBoard({ label: "Chess board", onEdit: (next) => setPosition({ board: next, side: position.side, fen: canonicalFen(next, position.side), preset: null }) });
  const turn = h("p", { class: "board-turn" });
  const checks = h("ul", { class: "live-checks", "aria-live": "polite" });
  const flip = h("button", { type: "button", class: "button ghost small", onclick: () => ((flipped = !flipped), orient()) }, icon("refresh", { size: 15 }), h("span", { text: "Flip board" }));
  const beforeAfter = segmented({
    label: "Show the board",
    options: [
      { value: "before", label: "Before" },
      { value: "after", label: "After" },
    ],
    value: "after",
    onChange: () => drawResultBoard(),
  });
  const legend = h("p", { class: "board-legend muted small-text" });
  const boardCard = h(
    "section",
    { class: "card large board-card", "aria-label": "Board" },
    h("div", { class: "board-head" }, turn),
    board.element,
    checks,
    h("div", { class: "board-tools" }, beforeAfter.element, h("span", { class: "spacer" }), flip),
    legend,
  );

  // Setup -------------------------------------------------------------------------------------

  const presets = chipRow({
    label: "Start from",
    scroll: true,
    items: PRESETS.map((preset) => ({ label: preset.label, value: preset.id, selected: false })),
    onPick: (item) => loadFen(PRESETS.find((preset) => preset.id === item.value).fen, item.value),
  });
  const side = segmented({
    label: "Side to move",
    showLabel: true,
    options: [
      { value: "w", label: "White" },
      { value: "b", label: "Black" },
    ],
    onChange: (value) => {
      flipped = false;
      setPosition({ board: position.board, side: value, fen: canonicalFen(position.board, value), preset: null });
    },
  });

  let tool = null;
  const toolButtons = [];
  const toolButton = (value, label, content) => {
    const button = h("button", { type: "button", class: "palette-tool", "aria-pressed": String(value === tool), "aria-label": label, title: label, onclick: () => setTool(value) }, content);
    toolButtons.push({ value, button });
    return button;
  };
  const setTool = (value) => {
    tool = value;
    for (const one of toolButtons) one.button.setAttribute("aria-pressed", String(one.value === value));
    board.setTool(value);
  };
  const palette = h(
    "div",
    { class: "palette", role: "group", "aria-label": "Pieces" },
    toolButton(null, "Move pieces", h("span", { class: "palette-word", text: "Move" })),
    PALETTE.map((piece) => toolButton(piece, `Place a ${paletteLabel(piece).toLowerCase()}`, h("img", { src: pieceSrc(piece), alt: "" }))),
    toolButton("erase", "Remove pieces", h("span", { class: "palette-word" }, icon("close", { size: 16 }))),
  );
  const editor = disclosure(
    {
      summary: "Edit pieces",
      onToggle: (open) => {
        if (view === "setup") board.setMode(open ? "edit" : "view");
        if (!open) setTool(null);
      },
    },
    h("p", { class: "muted small-text", text: "With Move, drag a piece to its new square, or click it and then the square; drag it off the board to remove it. Pick a piece to place it on the squares you click." }),
    palette,
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", class: "button small", text: "Clear the board", onclick: () => setPosition({ board: Array(64).fill(null), side: position.side, fen: canonicalFen(Array(64).fill(null), position.side), preset: null }) }),
      h("button", { type: "button", class: "button small", text: "Starting position", onclick: () => loadFen(START_FEN, "opening") }),
    ),
  );

  const pasteInput = h("input", { type: "text", class: "input mono", placeholder: "e.g. rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", spellcheck: false, autocomplete: "off" });
  const paste = labeled({ label: "Position (FEN)", control: pasteInput, hint: "Paste a FEN from any chess site. Press Enter to play it." });
  pasteInput.addEventListener("input", () => {
    const text = pasteInput.value.trim().replace(/\s+/g, " ");
    if (!text) {
      pasteProblem = null;
      paste.setError(null);
    } else if (!parseFen(text)) {
      pasteProblem = "That doesn't look like a chess position.";
      paste.setError(pasteProblem);
    } else {
      pasteProblem = null;
      paste.setError(null);
      setPosition({ ...parseFen(text), preset: null }, { keepPaste: true });
      return;
    }
    refreshChecks();
  });
  pasteInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      start();
    }
  });
  const pasteBox = disclosure({ summary: "Paste a position" }, paste.element, copyButton({ text: () => position.fen, label: "Copy this position" }));

  const setupCard = card({ title: "Position", className: "setup-card" }, h("div", { class: "field" }, h("span", { class: "field-label", text: "Start from" }), presets.element), side.element, h("div", { class: "setup-more" }, editor, pasteBox));
  const intro = h("p", { class: "page-intro", text: "Pick a position. The agent plays one move on a real board, and Stockfish grades it." });
  const notice = h("div", { class: "notice" });

  // Running -----------------------------------------------------------------------------------

  const run = taskRun({
    task: TASK,
    title: "Playing a move",
    steps: STEPS,
    onEvent: (name, data) => {
      if (!current) return;
      if (name === "task.started") run.step("setup");
      if (name === "task.reference") run.step("score", { progress: "indeterminate" });
      if (name === "task.tool") {
        if (!current.looking) {
          current.looking = true;
          run.step("look");
        }
        if (data.isError) missed();
        if (data.name === "drag" || data.name === "click") follow(data.name);
      }
      if (name === "task.answer") run.step("check");
    },
  });
  const play = runButton({ label: "Play a move as White", block: true, run, note: "Usually takes a minute or two.", onClick: () => start() });
  const playBar = actionBar({ sticky: "narrow" }, play.element);

  const missed = () => {
    if (current.missNoted || current.known) return;
    current.missNoted = true;
    run.note("A try didn't land; the agent is checking the board.", { step: "look" });
  };

  // After each drag or click, the board's record in the workspace tells whether a move landed.
  function follow(action) {
    const mine = current;
    mine.reading = mine.reading.then(async () => {
      let record;
      try {
        record = await readJSON(RECORD);
      } catch (problem) {
        run.note(`Couldn't read the board's record yet (${problem.message}).`, { step: "look" });
        return;
      }
      if (mine !== current || record?.fen !== mine.fen || !Array.isArray(record.moves)) return; // another run's record
      if (record.moves.length === 0) {
        if (action === "drag") missed();
        return;
      }
      if (record.moves.length <= mine.known) return;
      mine.known = record.moves.length;
      const move = describeMove(mine.board, record.moves[0]);
      const after = parseFen(record.positions?.[0]);
      if (move && after) {
        board.show(after.board, { slide: { from: move.from, to: move.to } });
        board.setMarks({ last: [move.from, move.to] });
        announce(`The agent played ${move.said}.`);
      }
      run.step("move", { detail: move ? `${move.words} (${move.short})` : record.moves[0] });
      // The board no longer shows the position the side to move faced.
      turn.textContent = move && after ? `The agent played ${move.short}` : "The agent moved a piece";
    });
  }

  async function start(fen = position.fen) {
    if (run.busy || blockReason()) return;
    const begin = parseFen(fen);
    notice.replaceChildren();
    current = { fen, side: begin.side, board: begin.board, preset: position.preset, known: 0, looking: false, missNoted: false, reading: Promise.resolve() };
    shown = null;
    view = "running";
    editor.open = false;
    setTool(null);
    board.setMode("locked");
    board.show(begin.board);
    board.setMarks({});
    flipped = false;
    orient();
    render();
    const promise = run.start({ fen });
    run.setTitle(`Playing as ${SIDE_NAMES[begin.side]}`);
    run.step("setup");
    const outcome = await promise;
    await current.reading;
    const mine = current;
    current = null;
    finish(mine, outcome);
  }

  async function finish(mine, outcome) {
    if (outcome.status === "valid" || outcome.status === "invalid") {
      // The verifier read this record; re-read it once so the board shows what it judged.
      let record = null;
      try {
        const read = await readJSON(RECORD);
        if (read?.fen === mine.fen) record = read;
      } catch {
        record = null; // no record: the verdict says so
      }
      const name = PRESETS.find((preset) => preset.id === mine.preset && preset.fen === mine.fen)?.label ?? "Your position";
      const entry = { id: history.length + 1, fen: mine.fen, side: mine.side, board: mine.board, name, record, verdict: outcome.verdict, answer: outcome.answer, seconds: outcome.seconds };
      history.unshift(entry);
      renderRecent();
      showResult(entry);
      return;
    }
    view = "setup";
    if (outcome.status === "cancelled") {
      run.hide();
      notice.replaceChildren(banner({ tone: "neutral", title: "Stopped. Nothing was scored." }));
    } else if (outcome.status === "unchecked") {
      notice.replaceChildren(banner({ tone: "warn", title: "The run ended before the move was checked.", actions: [h("button", { type: "button", class: "button small", text: "Try again", onclick: () => start(mine.fen) })] }));
    } else {
      run.hide(); // the card below says what went wrong in plain words
      notice.replaceChildren(problemCard(outcome, mine));
    }
    setPosition(position);
  }

  function problemCard(outcome, mine) {
    const button = (label, onclick, primary = false) => h("button", { type: "button", class: `button small${primary ? " primary" : ""}`, text: label, onclick });
    const editPosition = () =>
      button("Edit the position", () => {
        editor.open = true;
        editor.querySelector("summary").focus();
      });
    const rules = [
      {
        id: "echo",
        match: /reads the position as '([^']+)'/,
        text: "Stockfish writes this position a little differently.",
      },
      { id: "over", match: "no legal move: the game is over", text: "There's no move to play: this is checkmate or stalemate." },
      { id: "unreadable", match: /invalid input for task|input verification failed|is not a chess position in FEN/, text: "That position couldn't be read." },
      { id: "unavailable", match: /no Stockfish|the board is not installed|no Chrome|cannot run the plugin|under maintenance/, text: UNAVAILABLE },
      { id: "timeout", match: /timed? ?out|TimeoutError/i, text: "The agent ran out of time before finishing." },
      { id: "other", match: () => true, text: "Something went wrong while playing." },
    ];
    const plain = explainError(outcome.error, rules);
    let actions = [button("Try again", () => start(mine.fen), true)];
    if (plain.rule === "echo") {
      const echoed = outcome.error.match(rules[0].match)[1];
      actions = [button("Use Stockfish's version", () => (loadFen(echoed, null), start(echoed)), true)];
    } else if (plain.rule === "over" || plain.rule === "unreadable") {
      actions = [editPosition()];
    } else if (plain.rule === "unavailable") {
      unavailable = true;
      actions = [];
    }
    return errorCard({ message: outcome.error, rules, title: outcome.startFailed ? "Couldn't start" : undefined, actions });
  }

  // Result ------------------------------------------------------------------------------------

  const resultSlot = h("div", { class: "result-slot" });

  // The board after the run: a scored run shows the agent's move; one that wasn't shows everything
  // the board recorded, except an illegal try, whose record can't be trusted (null: the start).
  function afterBoard(entry) {
    const positions = entry.record?.positions ?? [];
    if (entry.verdict.valid) return parseFen(positions[0])?.board ?? null;
    if (/is not a legal move/.test(entry.verdict.message ?? "")) return null;
    return parseFen(positions.at(-1))?.board ?? null;
  }

  function drawResultBoard() {
    const entry = shown;
    const after = afterBoard(entry);
    const before = beforeAfter.value() === "before" || !after;
    board.show(before ? entry.board : after);
    const details = entry.verdict.details ?? {};
    const arrows = [];
    let ring = null;
    const square = (uci) => [squareIndex(uci.slice(0, 2)), squareIndex(uci.slice(2, 4))];
    if (entry.verdict.valid) {
      const [from, to] = square(details.move);
      arrows.push({ from, to, kind: "agent" });
      if (details.best && details.best !== details.move) {
        const [bf, bt] = square(details.best);
        arrows.push({ from: bf, to: bt, kind: "best" });
      }
    } else {
      const agent = (entry.record?.moves ?? []).filter((uci, index) => index % 2 === 0 && /^[a-h][1-8][a-h][1-8]/.test(uci));
      agent.forEach((uci, index) => {
        const [from, to] = square(uci);
        arrows.push({ from, to, kind: "agent", label: agent.length > 1 ? String(index + 1) : undefined });
      });
      const illegal = (entry.verdict.message ?? "").match(/^([a-h][1-8])([a-h][1-8])\S* is not a legal move/);
      if (illegal) ring = squareIndex(illegal[2]);
    }
    board.setMarks({ arrows, ring, last: before || !arrows.length ? null : [arrows[0].from, arrows[0].to] });
    turn.textContent = !after ? `${SIDE_NAMES[entry.side]} to move` : before ? `Before the move · ${SIDE_NAMES[entry.side]} to move` : "After the agent's move";
    legend.textContent = arrows.some((one) => one.kind === "best")
      ? "Solid arrow: the agent's move. Dashed arrow: Stockfish's best move."
      : arrows.length > 1
        ? "The numbered arrows show the agent's moves, in order."
        : arrows.length
          ? entry.verdict.valid
            ? "The arrow shows the agent's move."
            : "The arrow shows the move the agent tried."
          : "";
  }

  function showResult(entry) {
    shown = entry;
    view = "result";
    board.setMode("view");
    flipped = false;
    beforeAfter.set("after");
    orient();
    resultSlot.replaceChildren(resultCard(entry));
    render();
    renderRecent();
    const top = resultSlot.querySelector(".result-head");
    top?.focus({ preventScroll: true });
  }

  function resultCard(entry) {
    const { verdict } = entry;
    const details = verdict.details ?? {};
    const mover = SIDE_NAMES[entry.side];
    const score = typeof verdict.score === "number" ? scoreText(verdict.score) : null;
    const button = (label, onclick, primary = false, extra = "") => h("button", { type: "button", class: `button${primary ? " primary" : ""} ${extra}`.trim(), text: label, onclick });
    const moved = verdict.valid ? describeMove(entry.board, details.move) : null;
    const best = verdict.valid ? describeMove(entry.board, details.best) : null;
    const question = !verdict.valid ? "What would be a good move here?" : details.move === details.best ? `Why is ${moved.short} the best move here?` : `Why is ${best.short} better than ${moved.short} here?`;
    const look = verdict.valid ? grade(details) : { label: "Not scored", tone: "bad", icon: "error" };

    const head = h(
      "div",
      { class: `result-head tone-${look.tone}`, tabindex: "-1" },
      h("span", { class: "grade" }, icon(look.icon, { size: 18 }), look.label),
      score !== null ? h("span", { class: "result-score numeric", "aria-label": `score ${score} out of 1`, title: "Score out of 1", text: score }) : null,
    );
    const body = [];
    if (verdict.valid) {
      body.push(h("p", { class: "move-words" }, moved?.words ?? details.move, " ", h("span", { class: "move-short", text: moved?.short ?? "" })));
      const lost = Math.round((details.loss ?? 0) * 100);
      const bestMove = details.move === details.best;
      body.push(
        h(
          "div",
          { class: "chances" },
          h("h3", { text: `${mover}'s winning chances` }),
          // The best move's own meter would repeat this one, to the last digit.
          meter({ label: bestMove ? "After this move" : "After the agent's move", value: details.win_prob, valueText: percent(details.win_prob), tone: look.tone === "ok" ? "ok" : look.tone }),
          bestMove ? null : meter({ label: `After Stockfish's best, ${best?.short ?? details.best}`, value: details.best_win_prob, valueText: percent(details.best_win_prob), tone: "info" }),
          details.loss > 0 ? h("p", { class: "muted small-text", text: lost ? `It gave away ${plural(lost, "point")} of winning chance.` : "It gave away less than one point of winning chance." }) : null,
        ),
      );
      body.push(
        h("p", { class: "checked-line" }, icon("check", { size: 16 }), details.move === details.best ? "Checked by Stockfish: a legal move, played on the board, and the best one in this position." : `Checked by Stockfish: a legal move, played on the board. Stockfish's best was ${best?.words.replace(/^./, (c) => c.toLowerCase()) ?? details.best} (${best?.short ?? details.best}).`),
      );
    } else {
      body.push(h("p", { class: "move-words", text: notScored(entry) }));
    }
    const reply = verdict.valid ? entry.record?.moves?.[1] : null;
    if (reply) {
      const replied = describeMove(parseFen(entry.record.positions[0])?.board ?? [], reply);
      body.push(h("p", { class: "muted small-text", text: `The board's own engine answered with ${replied ? replied.short : reply}; that move is not scored.` }));
    }
    if (entry.answer) {
      const words = h("p", { class: "agent-words", text: plainText(entry.answer) });
      const more = h("button", { type: "button", class: "button ghost small more", text: "Show more" });
      more.addEventListener("click", () => {
        const open = words.classList.toggle("open");
        more.textContent = open ? "Show less" : "Show more";
      });
      body.push(h("figure", { class: "agent-quote" }, h("blockquote", {}, words), h("figcaption", { class: "muted small-text" }, "The agent", more)));
      requestAnimationFrame(() => (more.hidden = words.scrollHeight <= words.clientHeight + 1));
    }
    body.push(
      h(
        "div",
        { class: "result-actions" },
        button("Try another position", () => backToSetup(entry), verdict.valid),
        button("Play again", () => (backToSetup(entry), start(entry.fen)), !verdict.valid),
        h("button", { type: "button", class: "button ghost", onclick: () => drawer?.open({ prefill: question }) }, icon("chat", { size: 16 }), h("span", { text: "Ask why" })),
      ),
    );
    body.push(
      disclosure(
        { summary: "How this was checked" },
        h("p", { class: "small-text", text: "Before the agent saw the board, Stockfish scored every legal move of this position with a fixed search, the same way every time. The agent then played on the real board with the mouse, the way a person would. The page reads the game the board recorded and checks that the move is legal, that it leads to the position Stockfish expects, and that it was the only move the agent played." }),
        h("p", { class: "muted small-text", text: `The check's own words: ${verdict.message ?? "none"}.` }),
        copyField({ label: "Start position (FEN)", value: entry.fen }),
      ),
    );
    return h("section", { class: `card large result-card tone-${look.tone}`, "aria-label": "Result" }, head, body);
  }

  function backToSetup(entry) {
    view = "setup";
    shown = null;
    run.hide();
    const preset = PRESETS.find((one) => one.fen === entry.fen && one.label === entry.name);
    loadFen(entry.fen, preset?.id ?? null);
  }

  // Recent ------------------------------------------------------------------------------------

  const recentList = h("ul", { class: "recent" });
  const recentCard = card({ title: "Recent", className: "recent-card" }, recentList);

  function renderRecent() {
    recentCard.hidden = history.length === 0;
    recentList.replaceChildren(
      ...history.map((entry) => {
        const details = entry.verdict.details ?? {};
        const look = entry.verdict.valid ? grade(details) : { label: "Not scored", tone: "bad" };
        const played = entry.verdict.valid ? details.move : entry.record?.moves?.[0];
        const move = played ? describeMove(entry.board, played)?.short ?? played : "No move";
        return h(
          "li",
          {},
          h(
            "button",
            { type: "button", class: "recent-item", "aria-current": shown === entry ? "true" : null, disabled: run.busy, onclick: () => showResult(entry) },
            h("span", { class: "recent-move", text: move }),
            statusPill(look.label, look.tone),
            h("span", { class: "recent-name muted", text: entry.name }),
          ),
        );
      }),
    );
  }

  // Position and view -------------------------------------------------------------------------

  function loadFen(fen, presetId) {
    const parsed = parseFen(fen);
    flipped = false;
    setPosition({ ...parsed, fen, preset: presetId });
  }

  function setPosition(next, { keepPaste = false } = {}) {
    position = { board: next.board, side: next.side, fen: next.fen, preset: next.preset ?? null };
    if (!keepPaste) {
      pasteInput.value = "";
      pasteProblem = null;
      paste.setError(null);
    }
    presets.select(position.preset);
    side.set(position.side);
    if (view === "setup") {
      board.show(position.board);
      board.setMarks({});
      orient();
    }
    play.setLabel(`Play a move as ${SIDE_NAMES[position.side]}`);
    refreshChecks();
    render();
  }

  function orient() {
    const mover = view === "setup" ? position.side : (current ?? shown).side;
    board.orient(flipped ? other(mover) : mover);
  }

  // Why Play can't run, for the line under the button. The board's own problems are listed under
  // the board and the pasted FEN's on its field, so this points there instead of repeating them.
  const blockReason = () => {
    if (unavailable) return `${UNAVAILABLE} Reload the page to try again.`;
    if (pasteProblem) return pasteProblem;
    return positionProblems(position.board, position.side).length ? "Fix the position first." : null;
  };

  function refreshChecks() {
    const problems = view === "setup" ? positionProblems(position.board, position.side) : [];
    checks.replaceChildren(...problems.map((text) => h("li", {}, icon("alert", { size: 16 }), h("span", { text }))));
    play.setBlocked(blockReason());
  }

  function render() {
    const setup = view === "setup";
    intro.hidden = history.length > 0 || !setup;
    setupCard.hidden = !setup;
    playBar.hidden = !setup;
    resultSlot.hidden = view !== "result";
    beforeAfter.element.hidden = view !== "result" || !afterBoard(shown);
    if (setup) {
      board.setMode(editor.open ? "edit" : "view");
      turn.textContent = `${SIDE_NAMES[position.side]} to move`;
      legend.textContent = "";
      refreshChecks();
    } else if (view === "running") {
      turn.textContent = `${SIDE_NAMES[current.side]} to move · the agent is playing`;
      legend.textContent = "";
      checks.replaceChildren();
    } else {
      drawResultBoard();
    }
    for (const button of recentList.querySelectorAll("button")) button.disabled = view === "running";
    drawer?.chat.setSuggestions(suggestions());
  }

  // Chat --------------------------------------------------------------------------------------

  function suggestions() {
    const entry = view === "result" ? shown : null;
    const mover = SIDE_NAMES[entry?.side ?? position.side];
    if (!entry?.verdict.valid) return [`What's the best plan for ${mover} here?`, "Explain this position in simple terms"];
    const details = entry.verdict.details;
    const moved = describeMove(entry.board, details.move)?.short ?? details.move;
    const best = describeMove(entry.board, details.best)?.short ?? details.best;
    return [details.move === details.best ? `Why is ${moved} the best move?` : `Why is ${best} better than ${moved}?`, `What should ${SIDE_NAMES[other(entry.side)]} do now?`];
  }

  // What the chat agent is told with each message, so it knows the board without seeing it.
  function context() {
    const entry = view === "result" ? shown : null;
    const fen = entry?.fen ?? current?.fen ?? position.fen;
    const parsed = parseFen(fen);
    const lines = [`The position on my board, in FEN: ${fen} (${SIDE_NAMES[parsed.side]} to move).`];
    if (entry?.verdict.valid) {
      const { move, best } = entry.verdict.details;
      lines.push(`The agent played ${move} (${describeMove(entry.board, move)?.short ?? move}) and Stockfish's best move was ${best} (${describeMove(entry.board, best)?.short ?? best}).`);
    }
    return lines.join(" ");
  }

  const shell = appShell({
    plugin,
    chat: {
      intro: h("div", { class: "chat-intro small" }, h("img", { src: plugin.product.icon, alt: "" }), h("p", { class: "muted", text: "Ask about chess or the position on your board." })),
      note: "It knows the position on your board. To have it play a move on the board, use Play a move.",
      placeholder: "Ask about chess or this position",
      prepare: (text) => `${context()}\n\n${text}`,
    },
  });
  const drawer = shell.drawer;

  const panel = h("div", { class: "panel stack" }, intro, notice, run.element, resultSlot, setupCard, playBar, recentCard);
  const layout = columns({ main: boardCard, aside: panel, asideWidth: "380px" });
  layout.classList.add("chess-columns");
  shell.main.append(layout);
  renderRecent();
  loadFen(PRESETS[0].fen, PRESETS[0].id);
  return shell.element;
}

mountApp(chessPage);
