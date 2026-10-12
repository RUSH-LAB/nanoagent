// Sessions: one sitting with the plugin's page, which people leave and come back to. The host
// keeps each session's saved state, its conversation, and every run it made with what the run
// cost and how long it took. The page gets its session as `ctx.session`; the dashboard lists them.

import { request } from "./bridge.js";
import { formatDuration, h, plural } from "./dom.js";
import { dataTable, emptyState, howItWorks } from "./display.js";

let current = null;

/** The session the page is in, or null on the dashboard before one is opened. */
export function currentSession() {
  return current;
}

/**
 * Make `opened` (what `session.start` / `session.resume` answered) the page's session.
 * @returns {{id: string, title: string, state: unknown, chat: Array<{prompt: string, answer: string}>, save: (state: unknown, options?: {title?: string}) => Promise<void>}}
 *   `state` is what the page last saved (null for a new session). `save` keeps a new state, and
 *   a title when given; saves run one after another, so the last one wins.
 */
export function enterSession(opened) {
  let queue = Promise.resolve();
  current = {
    id: opened.id,
    title: opened.title,
    state: opened.state,
    chat: opened.chat,
    save(state, { title } = {}) {
      current.state = state;
      if (title !== undefined) current.title = title;
      const saving = queue.then(() => request("session.save", { state, ...(title === undefined ? {} : { title }) }));
      queue = saving.catch(() => {});
      return saving;
    },
  };
  return current;
}

/** "$0.0042", "$0.012", "$1.25": a cost in US dollars, with enough digits to show a small one. */
export function formatCost(usd) {
  if (usd === null || usd === undefined) return "—";
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}

/** "0.8 s", "14 s", "3 min 12 s": a duration, to a tenth of a second when short. */
export function formatSeconds(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  return seconds < 10 ? `${seconds.toFixed(1)} s` : formatDuration(seconds);
}

/**
 * One line for what a run cost and how long it took: "$0.012 · first token 1.8 s · generating
 * 6.1 s · 14 s total · 1,200 → 300 tokens". Parts the run did not report are left out.
 * @param {{cost?: number|null, ttft_s?: number|null, generation_s?: number|null, duration_s?: number|null, usage?: object}} metrics
 *   A `task.done`'s or a `chat.answer`'s `metrics`.
 */
export function metricsLine(metrics) {
  const parts = [formatCost(metrics.cost)];
  if (metrics.ttft_s != null) parts.push(`first token ${formatSeconds(metrics.ttft_s)}`);
  if (metrics.generation_s) parts.push(`generating ${formatSeconds(metrics.generation_s)}`);
  if (metrics.duration_s != null) parts.push(`${formatSeconds(metrics.duration_s)} total`);
  const { prompt_tokens: input, completion_tokens: output } = metrics.usage ?? {};
  if (input != null && output != null) parts.push(`${input.toLocaleString()} → ${output.toLocaleString()} tokens`);
  return parts.join(" · ");
}

const when = (at) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const titled = (session) => session.title || `Session from ${when(session.createdAt)}`;

function stat(label, value) {
  return h("div", { class: "stat" }, h("span", { class: "stat-label", text: label }), h("span", { class: "stat-value tabular", text: value }));
}

/** Every call one session made, with what each cost and how long it took. */
function callsTable(calls) {
  return dataTable({
    caption: "Runs in this session",
    empty: "This session has not run anything yet.",
    sort: { key: "at", dir: "desc" },
    rows: calls,
    columns: [
      { key: "at", label: "When", render: (call) => when(call.at), primary: true },
      { key: "what", label: "What", value: (call) => (call.kind === "task" ? call.task : "Chat") },
      {
        key: "cost",
        label: "Cost",
        numeric: true,
        render: (call) => (call.estimated ? h("span", { title: "The run reported no cost, so it was charged the most a run may cost.", text: `≤ ${formatCost(call.cost)}` }) : formatCost(call.cost)),
      },
      { key: "ttftS", label: "First token", numeric: true, render: (call) => formatSeconds(call.ttftS) },
      { key: "generationS", label: "Generating", numeric: true, render: (call) => formatSeconds(call.generationS) },
      { key: "durationS", label: "Total", numeric: true, render: (call) => formatSeconds(call.durationS) },
      {
        key: "tokens",
        label: "Tokens in → out",
        numeric: true,
        value: (call) => (call.inputTokens == null ? null : call.inputTokens + (call.outputTokens ?? 0)),
        render: (call) => (call.inputTokens == null ? "—" : `${call.inputTokens.toLocaleString()} → ${(call.outputTokens ?? 0).toLocaleString()}`),
      },
    ],
  });
}

/**
 * The dashboard: the person's sessions with this plugin, what they cost in all, and each
 * session's runs; from here they start a new session or resume one.
 * @param {object} options
 * @param {object} options.plugin The catalog entry from `describe`; with no sessions yet, its product says what a session does.
 * @param {(session: object) => void} options.onOpen With what `session.start` or `session.resume` answered.
 * @returns {{element: HTMLElement, refresh: () => Promise<void>}}
 */
export function dashboard({ plugin, onOpen }) {
  const status = h("p", { class: "muted", role: "status" });
  const totals = h("div", { class: "stats" });
  const list = h("div");
  const details = h("section", { class: "card session-details", hidden: true, "aria-live": "polite" });
  const newButton = h("button", { type: "button", class: "button primary", text: "New session" });

  const open = async (method, params, button) => {
    button.disabled = true;
    try {
      onOpen((await request(method, params)).session);
    } catch (problem) {
      status.textContent = problem.message;
    } finally {
      button.disabled = false;
    }
  };
  newButton.addEventListener("click", () => open("session.start", {}, newButton));
  const startButton = h("button", { type: "button", class: "button primary", text: "Start your first session" });
  startButton.addEventListener("click", () => open("session.start", {}, startButton));
  const empty = h(
    "section",
    { class: "card dashboard-empty" },
    emptyState({ icon: "play", title: "No sessions yet", body: plugin.product.summary, actions: [startButton] }, howItWorks(plugin.product.steps)),
  );

  async function showDetails(session) {
    details.hidden = false;
    details.replaceChildren(h("h2", { text: titled(session) }), h("p", { class: "muted", text: "Loading its runs…" }));
    try {
      const { session: full } = await request("session.get", { id: session.id });
      details.replaceChildren(
        h("header", { class: "session-details-head" }, h("h2", { text: titled(full) }), h("span", { class: "muted", text: `${plural(full.runs, "run")} · ${formatCost(full.cost)}` })),
        callsTable(full.calls).element,
      );
    } catch (problem) {
      details.replaceChildren(h("p", { class: "error-text", role: "alert", text: problem.message }));
    }
  }

  async function refresh() {
    status.textContent = "";
    let sessions;
    try {
      ({ sessions } = await request("sessions.list"));
    } catch (problem) {
      status.textContent = problem.message;
      return;
    }
    // With no sessions the empty state's own button starts one, so the header's would repeat it.
    newButton.hidden = !sessions.length;
    if (!sessions.length) {
      totals.replaceChildren();
      list.replaceChildren(empty);
      details.hidden = true;
      return;
    }
    const runs = sessions.reduce((sum, one) => sum + one.runs, 0);
    const timed = sessions.filter((one) => one.ttftS != null);
    const timedRuns = timed.reduce((sum, one) => sum + one.runs, 0);
    totals.replaceChildren(
      stat("Sessions", String(sessions.length)),
      stat("Runs", String(runs)),
      stat("Cost", formatCost(sessions.reduce((sum, one) => sum + one.cost, 0))),
      stat("Average first token", timedRuns ? formatSeconds(timed.reduce((sum, one) => sum + one.ttftS * one.runs, 0) / timedRuns) : "—"),
    );
    list.replaceChildren(
      dataTable({
        caption: "Sessions",
        sort: { key: "updatedAt", dir: "desc" },
        rows: sessions,
        columns: [
          { key: "title", label: "Session", value: titled, primary: true },
          { key: "updatedAt", label: "Last used", render: (session) => when(session.updatedAt) },
          { key: "runs", label: "Runs", numeric: true },
          { key: "cost", label: "Cost", numeric: true, render: (session) => formatCost(session.cost) },
          { key: "ttftS", label: "First token (avg)", numeric: true, render: (session) => formatSeconds(session.ttftS) },
          {
            key: "actions",
            label: "",
            sortable: false,
            render: (session) => {
              const resume = h("button", { type: "button", class: "button small primary", text: "Resume" });
              resume.addEventListener("click", () => open("session.resume", { id: session.id }, resume));
              return h("div", { class: "row-actions" }, h("button", { type: "button", class: "button small", text: "Runs", onclick: () => showDetails(session) }), resume);
            },
          },
        ],
      }).element,
    );
  }

  const element = h(
    "div",
    { class: "dashboard" },
    h("header", { class: "dashboard-head" }, h("h2", { text: "Sessions" }), newButton),
    status,
    totals,
    list,
    details,
  );
  return { element, refresh };
}
