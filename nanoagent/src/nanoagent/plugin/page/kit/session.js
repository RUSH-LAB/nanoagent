// Sessions: one sitting with the plugin's page, which people leave and come back to. The host
// keeps each session's saved state, its conversation, and every run it made with what the run
// cost and how long it took. The page gets its session as `ctx.session`; the dashboard lists them.
// A new session is only the page's until it does something: the host starts it on its first
// run, chat message or save (bridge.js), so a session nobody used leaves nothing behind.

import { onSessionRequest, request } from "./bridge.js";
import { formatDuration, h, icon, plural } from "./dom.js";
import { dataTable } from "./display.js";

let current = null;
// Starts the page's session on the host, if it has not started yet.
let start = async () => {};

onSessionRequest(() => start());

/** The session the page is in, or null on the dashboard before one is opened. */
export function currentSession() {
  return current;
}

/**
 * Make `opened` (what `session.resume` answered) the page's session, or with no `opened`, a
 * new one, which the host starts when the page first runs, chats or saves in it.
 * @param {object|null} [opened]
 * @returns {{id: string|null, title: string, state: unknown, chat: Array<{prompt: string, answer: string, tools: Array<{name: string, arguments: object, output: unknown, isError: boolean}>}>, save: (state: unknown, options?: {title?: string}) => Promise<void>}}
 *   `id` is null until a new session starts. `state` is what the page last saved (null for a
 *   new session). `save` keeps a new state, and a title when given; saves run one after
 *   another, so the last one wins.
 */
export function enterSession(opened = null) {
  let queue = Promise.resolve();
  const session = {
    id: opened?.id ?? null,
    title: opened?.title ?? "",
    state: opened?.state ?? null,
    chat: opened?.chat ?? [],
    save(state, { title } = {}) {
      session.state = state;
      if (title !== undefined) session.title = title;
      const saving = queue.then(() => request("session.save", { state, ...(title === undefined ? {} : { title }) }));
      queue = saving.catch(() => {});
      return saving;
    },
  };
  let starting = null;
  start = opened
    ? async () => {}
    : () =>
        (starting ??= request("session.start").then(
          (reply) => {
            session.id = reply.session.id;
          },
          (problem) => {
            starting = null;
            throw problem;
          },
        ));
  current = session;
  return session;
}

/** "$0.00", "$0.0042", "$0.012", "$1.25": a cost in US dollars, with enough digits to show a small one. */
export function formatCost(usd) {
  if (usd === null || usd === undefined) return "—";
  if (usd === 0) return "$0.00";
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

const when = (at) => {
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return date.toLocaleString(undefined, { year, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const titled = (session) => session.title || "Untitled session";

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
 * The dashboard: the person's sessions with this plugin, newest first, and what they cost in
 * all; from here they start a new session or resume one, and open a session's runs.
 * @param {object} options
 * @param {(session: object|null) => void} options.onOpen With what `session.resume` answered,
 *   or null for a new session.
 * @returns {{element: HTMLElement, refresh: () => Promise<number|null>}} `refresh` lists the
 *   sessions again and resolves with how many there are, or null when the host could not say.
 */
export function dashboard({ onOpen }) {
  const summary = h("p", { class: "dashboard-summary" });
  const status = h("p", { class: "error-text", role: "alert" });
  const list = h("ul", { class: "session-list" });
  const newButton = h("button", { type: "button", class: "button small", onclick: () => onOpen(null) }, icon("plus", { size: 16 }), "New session");

  async function resume(session, button) {
    button.disabled = true;
    try {
      onOpen((await request("session.resume", { id: session.id })).session);
    } catch (problem) {
      status.textContent = problem.message;
    } finally {
      button.disabled = false;
    }
  }

  async function toggleRuns(session, button, panel) {
    const opening = panel.hidden;
    button.setAttribute("aria-expanded", String(opening));
    panel.hidden = !opening;
    if (!opening || panel.childElementCount) return;
    panel.replaceChildren(h("p", { class: "muted", text: "Loading its runs…" }));
    try {
      const { session: full } = await request("session.get", { id: session.id });
      panel.replaceChildren(callsTable(full.calls).element);
    } catch (problem) {
      panel.replaceChildren(h("p", { class: "error-text", role: "alert", text: problem.message }));
    }
  }

  function row(session) {
    const meta = [when(session.updatedAt), plural(session.runs, "run"), formatCost(session.cost)];
    if (session.ttftS != null) meta.push(`first token ${formatSeconds(session.ttftS)}`);
    const open = h(
      "button",
      { type: "button", class: "session-open", title: "Resume this session" },
      h("span", { class: "session-title", text: titled(session) }),
      h("span", { class: "session-meta", text: meta.join(" · ") }),
    );
    open.addEventListener("click", () => resume(session, open));
    const panel = h("div", { class: "session-runs", hidden: true });
    const runs = session.runs
      ? h("button", { type: "button", class: "button small ghost", "aria-expanded": "false", text: "Runs" })
      : null;
    runs?.addEventListener("click", () => toggleRuns(session, runs, panel));
    return h("li", { class: "session-row" }, h("div", { class: "session-line" }, open, runs), panel);
  }

  async function refresh() {
    status.textContent = "";
    let sessions;
    try {
      ({ sessions } = await request("sessions.list"));
    } catch (problem) {
      status.textContent = problem.message;
      return null;
    }
    const runs = sessions.reduce((sum, one) => sum + one.runs, 0);
    const timed = sessions.filter((one) => one.ttftS != null);
    const timedRuns = timed.reduce((sum, one) => sum + one.runs, 0);
    const parts = [plural(sessions.length, "session"), plural(runs, "run"), formatCost(sessions.reduce((sum, one) => sum + one.cost, 0))];
    if (timedRuns) parts.push(`first token ${formatSeconds(timed.reduce((sum, one) => sum + one.ttftS * one.runs, 0) / timedRuns)} on average`);
    summary.textContent = sessions.length ? parts.join(" · ") : "";
    const newest = [...sessions].sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt));
    list.replaceChildren(
      ...(newest.length
        ? newest.map(row)
        : [h("li", { class: "session-empty", text: "No sessions yet. A new session is kept once you run something in it." })]),
    );
    return sessions.length;
  }

  const element = h(
    "section",
    { class: "dashboard" },
    h("header", { class: "dashboard-head" }, h("div", { class: "dashboard-titles" }, h("h2", { text: "Sessions" }), summary), newButton),
    status,
    list,
  );
  return { element, refresh };
}
