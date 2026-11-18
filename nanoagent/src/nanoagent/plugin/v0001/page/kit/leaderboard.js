// The Leaderboard tab every plugin's page has (kit/shell.js), laid out as examples/benchmark's report: one board per plugin, the
// harnesses run on any of its tasks, ranked from every member's scored runs RUSH keeps (`leaderboard`) by correct rate, then average
// time, then average cost; and under them the runs by case: the case (its input, the prompt the coding harnesses got and its reference) and one
// card per run with its verdict and figures. The member's own runs also show the verifier's word, the answer and the trajectory, read
// from their trace when the case is opened (`leaderboard.trace`); other members' traces are not shared. RUSH is highlighted.

import { request } from "./bridge.js";
import { dataTable, disclosure, statItems, statusPill } from "./display.js";
import { h, humanize } from "./dom.js";
import { formatCost, formatSeconds } from "./session.js";

const EMPTY = "No scored runs for this plugin yet.";
// A text longer than this shows cut, with a button that shows the rest.
const SHORT = 600;
const seconds = (ms) => formatSeconds(ms === null ? null : ms / 1000);
const tokens = (count) => (count === null ? "—" : count.toLocaleString());
const date = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const rushPill = () => h("span", { class: "pill rush-pill", text: "RUSH" });
const verdictPill = (verdict) => (verdict === "pass" ? statusPill("Right", "ok") : statusPill("Wrong", "bad"));

/** "92% (12/13)": how many of a harness's scored runs were right. */
export const correctText = ({ passed, scored }) => `${Math.round((passed / scored) * 100)}% (${passed}/${scored})`;

/** A label over a text or JSON value, cut to SHORT characters with a button that shows the rest; nothing for an empty one. */
function block(label, value) {
  if (value === null || value === undefined || value === "") return null;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const pre = h("pre", { class: "leaderboard-text", text: text.length > SHORT ? `${text.slice(0, SHORT)}…` : text });
  const more = text.length > SHORT
    ? h("button", { type: "button", class: "leaderboard-more", text: `Show more (${(text.length - SHORT).toLocaleString()} characters)`, onclick: (event) => {
        pre.textContent = text;
        event.currentTarget.remove();
      } })
    : null;
  return h("div", { class: "leaderboard-block" }, label ? h("div", { class: "leaderboard-label", text: label }) : null, pre, more);
}

/** One step of an ATIF trajectory, as the report draws it: its source, reasoning, message, tool calls and their results. */
const trajectoryStep = (step) => h(
  "li",
  { class: "leaderboard-step" },
  h("div", { class: "leaderboard-role", text: `${step.step_id} · ${step.source}` }),
  block("reasoning", step.reasoning_content),
  block(null, step.message),
  (step.tool_calls ?? []).map((call) => block(`call · ${call.function_name}`, call.arguments)),
  (step.observation?.results ?? []).map((result) => block("result", result.content)),
);

/** One event of a run made in RUSH: its kind over its data. */
const traceEvent = (event) => h("li", { class: "leaderboard-step" }, h("div", { class: "leaderboard-role", text: event.kind }), block(null, event.data));

/** What a member's own run's trace shows on its card: the verifier's word, the answer and the trajectory (or, for a run made in RUSH, its events). */
function traceParts(run, events) {
  const said = events.find((event) => event.kind === "verifier.verdict");
  const answered = events.find((event) => event.kind === "harness.answer");
  const steps = events.filter((event) => event.kind === "trajectory.step").map((event) => event.data);
  const rest = events.filter((event) => !["verifier.verdict", "harness.answer", "trajectory.step"].includes(event.kind));
  const why = [run.explanation && humanize(run.explanation), run.execution_reason].filter(Boolean).join(": ");
  return [
    block("verifier", said ? said.data.verdict : why),
    block("answer", answered?.data.answer),
    steps.length
      ? disclosure({ summary: `Trajectory (${steps.length} steps)` }, h("ol", { class: "leaderboard-steps" }, steps.map(trajectoryStep)))
      : disclosure({ summary: `Trace (${rest.length} events)` }, h("ol", { class: "leaderboard-steps" }, rest.map(traceEvent))),
  ];
}

/** One run's card: its harness, verdict, model and figures; its trace (`load`) for the member's own run, read once. */
function runCard(run, status) {
  const trace = h("div", { class: "leaderboard-trace" });
  const card = h(
    "article",
    { class: `card leaderboard-card${run.rush ? " rush" : ""}` },
    h("header", { class: "leaderboard-card-head" }, h("h4", {}, run.harness, run.rush ? rushPill() : null), verdictPill(run.verdict)),
    h("p", { class: "muted small-text", text: `${run.model} · ${date(run.created_at)}` }),
    h("dl", { class: "stats leaderboard-figures" }, statItems([
      ["Time", seconds(run.elapsed_ms)], ["Input tokens", tokens(run.input_tokens)], ["Output tokens", tokens(run.output_tokens)], ["Cost", formatCost(run.cost_usd)],
    ])),
    run.mine ? trace : h("p", { class: "muted small-text", text: "Another member's run: its trace is not shared." }),
  );
  let loaded = false;
  const load = async () => {
    if (!run.mine || loaded) return;
    loaded = true;
    trace.replaceChildren(h("p", { class: "muted small-text", text: "Reading the trace…" }));
    try {
      const { events } = await request("leaderboard.trace", { attemptId: run.attempt_id });
      trace.replaceChildren(...traceParts(run, events).filter(Boolean));
    } catch (problem) {
      loaded = false;
      trace.replaceChildren();
      status.textContent = problem.message;
    }
  };
  return { card, load };
}

/** One case: what it is, then a card per run side by side; its member's traces are read when it is first opened. */
function caseSection(shown, status, open) {
  const cards = shown.runs.map((run) => runCard(run, status));
  const right = shown.runs.filter((run) => run.verdict === "pass").length;
  const coding = shown.prompt?.policy === "coding";
  const body = [
    shown.arguments === null
      ? h("p", { class: "muted small-text", text: "None of your runs ran this case, so its input is not shared." })
      : [
          block("input", shown.arguments),
          block(coding ? "prompt (coding harnesses)" : "prompt (RUSH)", [shown.prompt.system, shown.prompt.user].filter(Boolean).join("\n\n")),
          shown.reference === null ? h("p", { class: "muted small-text", text: "No reference: the task is judged without one." }) : block("reference", shown.reference),
        ],
    h("div", { class: "leaderboard-cards" }, cards.map(({ card }) => card)),
  ];
  const section = disclosure(
    {
      summary: `${shown.case_id} · ${shown.kind === "refuse" ? "to refuse" : "to answer"}`,
      hint: `${right}/${shown.runs.length} right · #${shown.content_digest.slice(0, 8)}`,
      open,
      className: "leaderboard-case",
      onToggle: (opened) => opened && cards.forEach(({ load }) => load()),
    },
    body,
  );
  if (open) cards.forEach(({ load }) => load());
  return section;
}

/**
 * The Leaderboard tab, read again each time `refresh` is called (each time the tab is shown).
 * @returns {{element: HTMLElement, refresh: () => Promise<void>}}
 */
export function leaderboardPage() {
  const status = h("p", { class: "error-text", role: "alert" });
  const casesBox = h("section", { class: "leaderboard-cases", "aria-label": "Runs by case" });

  const board = dataTable({
    columns: [
      { key: "rank", label: "Rank", numeric: true },
      { key: "harness", label: "Harness", primary: true, render: (entry) => h("span", { class: "leaderboard-harness" }, entry.harness, entry.rush ? rushPill() : null) },
      { key: "correct", label: "Correct", numeric: true, value: (entry) => entry.passed / entry.scored, render: correctText },
      { key: "avg_elapsed_ms", label: "Avg time", numeric: true, render: (entry) => seconds(entry.avg_elapsed_ms) },
      { key: "avg_cost_usd", label: "Avg cost", numeric: true, render: (entry) => formatCost(entry.avg_cost_usd) },
      { key: "scored", label: "Runs", numeric: true },
    ],
    rows: [],
    sort: { key: "rank" },
    rowClass: (entry) => (entry.rush ? "highlight rush" : ""),
    caption: "Harnesses ranked by correct rate, then average time, then average cost",
    empty: EMPTY,
  });

  async function refresh() {
    status.textContent = "";
    let read;
    try {
      read = await request("leaderboard", {});
    } catch (problem) {
      status.textContent = problem.message;
      return;
    }
    board.setRows(read.harnesses);
    casesBox.replaceChildren(
      ...(read.cases.length ? [h("h3", { text: `Runs by case (${read.cases.length})` })] : []),
      ...read.cases.map((shown, index) => caseSection(shown, status, index === 0)),
    );
  }

  const element = h(
    "section",
    { class: "leaderboard-page", "aria-label": "Leaderboard" },
    h("header", { class: "dashboard-head" }, h("h2", { text: "Leaderboard" })),
    status,
    board.element,
    casesBox,
  );
  return { element, refresh };
}
