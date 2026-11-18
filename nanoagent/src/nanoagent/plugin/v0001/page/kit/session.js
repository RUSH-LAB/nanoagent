// Sessions: one sitting with the plugin's page, which people leave and come back to. The host
// keeps each session's conversation, and every run it made with what the run cost and how long it
// took. The chat continues the page's session (`currentSession`); the dashboard lists them.
// A new session is only the page's until it does something: the host starts it on its first
// chat message (bridge.js), so a session nobody used leaves nothing behind.

import { onSessionRequest, request } from "./bridge.js";
import { formatDuration, h, icon, plural } from "./dom.js";
import { statItems, statusPill } from "./display.js";
import { recording } from "./recording.js";

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
 * new one, which the host starts when the page first chats in it, and then calls `onStarted`.
 * @param {object|null} [opened]
 * @param {() => void} [onStarted]
 * @returns {{id: string|null, chat: Array<{prompt: string, answer: string, tools: Array<{name: string, arguments: object, output: unknown, isError: boolean}>, error: string|null}>, running: {prompt: string}|null}}
 *   A turn with an `error` was not answered, which says why; `id` is null until a new session starts; `running` is the message it is still answering.
 */
export function enterSession(opened = null, onStarted = () => {}) {
  const session = {
    id: opened?.id ?? null,
    chat: opened?.chat ?? [],
    running: opened?.running ?? null,
  };
  let starting = null;
  start = opened
    ? async () => {}
    : () =>
        (starting ??= request("session.start").then(
          (reply) => {
            session.id = reply.session.id;
            onStarted();
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

/** "373", "4.2k": a count, in thousands once it is a thousand or more. */
export const thousands = (count) => (count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`);

/**
 * What one model request took, read and cost, as stats (display.js statItems): Total Time, Time
 * to First Token, Generation Time, Input Tokens, Output Tokens and Cost. Figures the request did
 * not report are left out, Time to First Token for one not streamed.
 * @param {{cost?: number|null, ttft_s?: number|null, generation_s?: number|null, duration_s?: number|null, usage?: object}} metrics
 *   A model request's or a `chat.answer`'s `metrics`.
 */
export function runStats(metrics) {
  const figures = [];
  if (metrics.duration_s != null) figures.push(["Total Time", formatSeconds(metrics.duration_s)]);
  if (metrics.ttft_s != null) figures.push(["Time to First Token", formatSeconds(metrics.ttft_s)]);
  if (metrics.generation_s) figures.push(["Generation Time", formatSeconds(metrics.generation_s)]);
  const { prompt_tokens: input, completion_tokens: output } = metrics.usage ?? {};
  if (input != null) figures.push(["Input Tokens", thousands(input), input.toLocaleString()]);
  if (output != null) figures.push(["Output Tokens", thousands(output), output.toLocaleString()]);
  figures.push(["Cost", formatCost(metrics.cost)]);
  return h("dl", { class: "stats run-stats" }, statItems(figures));
}

/** "Oct 19, 2:46 AM", with the year when it is not this one. */
const when = (at) => {
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return `${date.toLocaleDateString(undefined, { year, month: "short", day: "numeric" })}, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
};
const titled = (session) => session.title || "Untitled session";
// The harness of the chats, the dashboard's first chip.
const RUSH = "RUSH";
// How many sessions a harness's usage is over, above it.
const counted = (count) => h("p", { class: "muted small-text", text: plural(count, "session") });

/** "4.3k" with "4,321" for its title: a count of tokens. */
const tokens = (count) => [thousands(Math.round(count)), Math.round(count).toLocaleString()];
// The figures the dashboard's usage shows, a column each, in the order of a run's graph summary:
// each one's label, the field it is, and how a value of it is written, with a title for the exact figure.
const FIGURES = [
  ["End-to-End Latency", "durationS", (value) => [formatSeconds(value)]],
  ["Model Time", "modelS", (value) => [formatSeconds(value)]],
  ["Tool Time", "toolsS", (value) => [formatSeconds(value)]],
  ["Input Tokens", "inputTokens", tokens],
  ["Output Tokens", "outputTokens", tokens],
  ["Cost", "cost", (value) => [formatCost(value)]],
];

/**
 * One harness's usage, as the dashboard shows it: a column per figure (FIGURES), its Total over
 * its Average, from `usages` (each a session's, every figure `{sum, count}`) averaged per `unit`:
 * RUSH's chats count their messages, a Harness session counts itself. A Total that not every one of
 * the `units` counted says so in its title.
 */
function harnessUsage(usages, units, unit) {
  const figures = FIGURES.map(([, key, format]) => {
    const sum = usages.reduce((total, usage) => total + usage[key].sum, 0);
    const count = usages.reduce((total, usage) => total + usage[key].count, 0);
    const total = count ? format(sum) : ["—"];
    if (count && count < units) {
      const why = unit === "message" ? "those sent before RUSH counted it lack it" : "the others did not record it";
      total[1] = `For ${count.toLocaleString()} of ${plural(units, unit)}: ${why}`;
    }
    return { total, average: count ? format(sum / count) : ["—"] };
  });
  const row = (head, title, cells) => h("tr", {}, h("th", { scope: "row", text: head, title }), cells.map(([text, cellTitle]) => h("td", { text, title: cellTitle })));
  return h(
    "div",
    { class: "usage-summary table-scroll" },
    h(
      "table",
      {},
      h("caption", { class: "visually-hidden", text: `Usage: in all, and on average per ${unit}` }),
      h("thead", {}, h("tr", {}, h("td"), FIGURES.map(([label]) => h("th", { scope: "col", text: label })))),
      h("tbody", {}, row("Total", undefined, figures.map((figure) => figure.total)), row("Average", `Per ${unit}`, figures.map((figure) => figure.average))),
    ),
  );
}

/** What the dashboard's list says with no session in view. */
function emptyText(archived, closed) {
  if (archived) return closed ? "Every session is archived." : "Every session is archived. Start a new one with New session.";
  return closed ? "No sessions." : "No sessions yet. Start one with New session.";
}

/**
 * The dashboard, by harness: chips name every harness the person used on this plugin, RUSH (their
 * chats) first and chosen at first, and the one chosen shows its usage and its sessions, newest
 * first. From RUSH's they start a new session or resume one, and archive a session; archived
 * sessions leave the list for its Archived view, where they can be opened or restored; chatting in
 * one again restores it. Another harness's are the person's Harness tab sessions (a free-form
 * Terminal one under each agent that worked in it), each opened as its read-only recording.
 * @param {object} options
 * @param {(session: object|null) => void} options.onOpen With what `session.resume` answered,
 *   or null for a new session.
 * @param {boolean} [options.closed] Whether no new session may start: the sessions are only read.
 * @returns {{element: HTMLElement, refresh: () => Promise<void>, resume: (id: string) => Promise<boolean>}}
 *   `refresh` lists the sessions again; `resume` opens session `id`, saying why not when it cannot, and whether it did.
 */
export function dashboard({ onOpen, closed = false }) {
  const stats = h("div", { class: "dashboard-usage" });
  const status = h("p", { class: "error-text", role: "alert" });
  const list = h("ul", { class: "session-list" });
  const heading = h("h2", { text: "Sessions" });
  const newButton = h("button", { type: "button", class: "button small", hidden: closed, onclick: () => onOpen(null) }, icon("plus", { size: 16 }), "New session");
  const viewButton = h("button", { type: "button", class: "button small ghost", hidden: true });
  const chips = h("div", { class: "harness-chips", role: "group", "aria-label": "Harness" });
  let archivedView = false;
  let chosen = RUSH;
  viewButton.addEventListener("click", () => {
    archivedView = !archivedView;
    refresh();
  });

  async function archive(session, button) {
    button.disabled = true;
    try {
      await request("session.archive", { id: session.id, archived: !session.archivedAt });
      await refresh();
    } catch (problem) {
      status.textContent = problem.message;
      button.disabled = false;
    }
  }

  async function resume(id, button = null) {
    if (button) button.disabled = true;
    try {
      onOpen((await request("session.resume", { id })).session);
      return true;
    } catch (problem) {
      status.textContent = problem.message;
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function row(session) {
    // Its title over when it was last used, and what it cost and took at the row's end, in line with the others'.
    const open = h(
      "button",
      { type: "button", class: "session-open", title: "Resume this session" },
      h("span", { class: "session-title", text: titled(session) }),
      h("span", { class: "session-meta" }, session.running ? statusPill("Answering", "info") : null, when(session.updatedAt)),
    );
    const took = session.usage.durationS.count ? formatSeconds(session.usage.durationS.sum) : "—";
    const spent = h("span", { class: "session-cost", title: "Cost / End-to-End Latency", text: `${formatCost(session.cost)} / ${took}` });
    open.addEventListener("click", () => resume(session.id, open));
    const label = session.archivedAt ? "Restore" : "Archive";
    const archiving = h("button", { type: "button", class: "button small ghost", text: label, title: `${label} ${titled(session)}` });
    archiving.addEventListener("click", () => archive(session, archiving));
    return h("li", { class: "session-row" }, h("div", { class: "session-line" }, open, spent, archiving));
  }

  // A Harness session, with what the chosen harness's calls in it cost and took; opening it shows its recording under it.
  function terminalRow(session) {
    const { usage } = session.harnesses.find((one) => one.harness === chosen);
    const open = h(
      "button",
      { type: "button", class: "session-open", title: "Show this session's recording", "aria-expanded": "false" },
      h("span", { class: "session-title", text: session.title }),
      h("span", { class: "session-meta" }, session.running ? statusPill("Running", "info") : null, when(session.updatedAt)),
    );
    const took = usage.durationS.count ? formatSeconds(usage.durationS.sum) : "—";
    const spent = h("span", { class: "session-cost", title: "Cost / End-to-End Latency", text: `${usage.cost.count ? formatCost(usage.cost.sum) : "—"} / ${took}` });
    const item = h("li", { class: "session-row" }, h("div", { class: "session-line" }, open, spent));
    let shown = null;
    open.addEventListener("click", () => {
      if (shown) shown.remove();
      shown = shown ? null : item.appendChild(recording(session.id));
      open.setAttribute("aria-expanded", String(Boolean(shown)));
    });
    return item;
  }

  async function refresh() {
    status.textContent = "";
    let all;
    let terminals;
    try {
      ({ sessions: all, terminals } = await request("sessions.list"));
    } catch (problem) {
      status.textContent = problem.message;
      return;
    }
    const used = [RUSH, ...new Set(terminals.flatMap((one) => one.harnesses.map(({ harness }) => harness)).sort())];
    if (!used.includes(chosen)) chosen = RUSH;
    const archived = all.filter((one) => one.archivedAt);
    if (!archived.length || chosen !== RUSH) archivedView = false;
    chips.hidden = used.length < 2 || archivedView;
    chips.replaceChildren(...used.map((harness) => h("button", {
      type: "button", class: "harness-chip", text: harness, "aria-pressed": String(harness === chosen),
      onclick: () => {
        chosen = harness;
        refresh();
      },
    })));
    newButton.hidden = closed || chosen !== RUSH;
    viewButton.hidden = !archived.length || chosen !== RUSH;
    viewButton.textContent = archivedView ? "Back to sessions" : `Archived (${archived.length})`;
    heading.textContent = archivedView ? "Archived sessions" : "Sessions";
    if (chosen !== RUSH) {
      const mine = terminals.filter((one) => one.harnesses.some(({ harness }) => harness === chosen));
      const usages = mine.map((one) => one.harnesses.find(({ harness }) => harness === chosen).usage);
      stats.replaceChildren(counted(mine.length), harnessUsage(usages, mine.length, "session"));
      list.replaceChildren(...[...mine].sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt)).map(terminalRow));
      return;
    }
    const sessions = archivedView ? archived : all.filter((one) => !one.archivedAt);
    const runs = sessions.reduce((sum, one) => sum + one.runs, 0);
    stats.replaceChildren(...(runs && !archivedView ? [counted(sessions.length), harnessUsage(sessions.map((one) => one.usage), runs, "message")] : []));
    const newest = [...sessions].sort((x, y) => new Date(y.updatedAt) - new Date(x.updatedAt));
    list.replaceChildren(
      ...(newest.length
        ? newest.map(row)
        : [h("li", { class: "session-empty", text: emptyText(archived.length, closed) })]),
    );
  }

  const element = h(
    "section",
    { class: "dashboard" },
    h("header", { class: "dashboard-head" }, heading, h("div", { class: "dashboard-actions" }, viewButton, newButton)),
    status,
    chips,
    stats,
    list,
  );
  return { element, refresh, resume };
}
