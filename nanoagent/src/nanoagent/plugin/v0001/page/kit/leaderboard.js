// The Leaderboard tab every plugin's page has (kit/shell.js): the harnesses run on one of the plugin's tasks, ranked from every
// member's scored runs RUSH keeps (`leaderboard`): by correct rate, then average time, then average cost. Picking a harness lists
// its runs; the member's own open their trace (`leaderboard.trace`), and other members' open nothing, as traces are not shared.

import { request } from "./bridge.js";
import { statusPill, dataTable } from "./display.js";
import { h, humanize } from "./dom.js";
import { formatCost, formatSeconds } from "./session.js";

const EMPTY = "No scored runs for this plugin yet.";
const seconds = (ms) => formatSeconds(ms === null ? null : ms / 1000);
const date = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** "92% (12/13)": how many of a harness's scored runs were right. */
export const correctText = ({ passed, scored }) => `${Math.round((passed / scored) * 100)}% (${passed}/${scored})`;

/** One event of a run's trace: its kind over its data. */
const traceEvent = (event) => h("li", { class: "leaderboard-event" }, h("h4", { text: event.kind }), h("pre", { text: JSON.stringify(event.data, null, 2) }));

/**
 * The Leaderboard tab, read again each time `refresh` is called (each time the tab is shown).
 * @returns {{element: HTMLElement, refresh: () => Promise<void>}}
 */
export function leaderboardPage(plugin) {
  let task = plugin.tasks[0].id;
  let entries = [];
  let picked = null;
  const status = h("p", { class: "error-text", role: "alert" });
  const runsBox = h("section", { class: "leaderboard-runs", hidden: true });
  const trace = h("section", { class: "leaderboard-trace", hidden: true });

  const board = dataTable({
    columns: [
      { key: "rank", label: "Rank", numeric: true },
      { key: "harness", label: "Harness", primary: true, render: (entry) => h("button", { type: "button", class: "leaderboard-pick", text: entry.harness, onclick: () => pick(entry) }) },
      { key: "correct", label: "Correct", numeric: true, value: (entry) => entry.passed / entry.scored, render: correctText },
      { key: "avg_elapsed_ms", label: "Avg time", numeric: true, render: (entry) => seconds(entry.avg_elapsed_ms) },
      { key: "avg_cost_usd", label: "Avg cost", numeric: true, render: (entry) => formatCost(entry.avg_cost_usd) },
      { key: "scored", label: "Runs", numeric: true },
    ],
    rows: [],
    sort: { key: "rank" },
    rowClass: (entry) => (entry.harness === picked ? "highlight" : ""),
    caption: "Harnesses ranked by correct rate, then average time, then average cost",
    empty: EMPTY,
  });

  async function openTrace(run, button) {
    button.disabled = true;
    try {
      const { events } = await request("leaderboard.trace", { attemptId: run.attempt_id });
      trace.replaceChildren(h("h3", { text: `Trace · ${date(run.created_at)}` }), h("ol", { class: "leaderboard-events" }, events.map(traceEvent)));
      trace.hidden = false;
    } catch (problem) {
      status.textContent = problem.message;
    } finally {
      button.disabled = false;
    }
  }

  function pick(entry) {
    picked = entry.harness;
    board.setRows(entries);
    trace.hidden = true;
    const runs = dataTable({
      columns: [
        { key: "created_at", label: "Date", primary: true, render: (run) => date(run.created_at) },
        { key: "verdict", label: "Result", render: (run) => (run.verdict === "pass" ? statusPill("Right", "ok") : statusPill("Wrong", "bad")) },
        { key: "elapsed_ms", label: "Time", numeric: true, render: (run) => seconds(run.elapsed_ms) },
        { key: "cost_usd", label: "Cost", numeric: true, render: (run) => formatCost(run.cost_usd) },
        {
          key: "trace", label: "Trace", sortable: false,
          render: (run) => (run.mine
            ? h("button", { type: "button", class: "button small ghost", text: "Open", onclick: (event) => openTrace(run, event.currentTarget) })
            : h("span", { class: "muted", text: "Not shared" })),
        },
      ],
      rows: entry.runs,
      sort: { key: "created_at", dir: "desc" },
      caption: `${entry.harness}'s runs`,
    });
    runsBox.replaceChildren(h("h3", { text: `${entry.harness} · runs` }), runs.element);
    runsBox.hidden = false;
  }

  async function refresh() {
    status.textContent = "";
    try {
      ({ harnesses: entries } = await request("leaderboard", { task }));
    } catch (problem) {
      status.textContent = problem.message;
      return;
    }
    const still = entries.find((entry) => entry.harness === picked);
    if (still) pick(still);
    else {
      picked = null;
      runsBox.hidden = true;
      trace.hidden = true;
      board.setRows(entries);
    }
  }

  // A plugin with more than one task ranks each on its own.
  const chooser = plugin.tasks.length > 1
    ? h("select", { class: "input", "aria-label": "Task" }, plugin.tasks.map((one) => h("option", { value: one.id, text: humanize(one.id) })))
    : null;
  chooser?.addEventListener("change", () => {
    task = chooser.value;
    picked = null;
    refresh();
  });
  const element = h(
    "section",
    { class: "leaderboard-page", "aria-label": "Leaderboard" },
    h("header", { class: "dashboard-head" }, h("h2", { text: "Leaderboard" }), chooser),
    status,
    board.element,
    runsBox,
    trace,
  );
  return { element, refresh };
}
