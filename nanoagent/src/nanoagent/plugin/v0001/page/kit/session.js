// Sessions: one sitting with the plugin's page, which people leave and come back to. The host
// keeps each session's conversation, and every run it made with what the run cost and how long it
// took. The chat continues the page's session (`currentSession`); the dashboard lists them.
// A new session is only the page's until it does something: the host starts it on its first
// chat message (bridge.js), so a session nobody used leaves nothing behind.

import { onSessionRequest, request } from "./bridge.js";
import { formatDuration, h, icon, plural } from "./dom.js";
import { statItems, statusPill } from "./display.js";

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
// The agent of the chats, by its CLI command as every agent is named: the dashboard's first chip.
const NANOAGENT = "nanoagent";
// How many sessions (or chats) a harness's usage is over, above it.
const counted = (count, unit = "session") => h("p", { class: "muted small-text", text: plural(count, unit) });

/** "4.3k" with "4,321" for its title: a count of tokens. */
const tokens = (count) => [thousands(Math.round(count)), Math.round(count).toLocaleString()];
// The figures the dashboard's usage shows, a column each, in the order of a run's graph summary:
// each one's label, the field it is, how a value of it is written (with a title for the exact
// figure), and what its header's title says it is.
const FIGURES = [
  ["End-to-End Latency", "durationS", (value) => [formatSeconds(value)], "agent working time; time waiting for you is excluded"],
  ["Model Time", "modelS", (value) => [formatSeconds(value)]],
  ["Tool Time", "toolsS", (value) => [formatSeconds(value)]],
  ["Input Tokens", "inputTokens", tokens],
  ["Output Tokens", "outputTokens", tokens],
  ["Cost", "cost", (value) => [formatCost(value)]],
];

/**
 * One harness's usage, as the dashboard shows it: a column per figure (FIGURES), its Total over
 * its Average, from `usages` (each a session's, every figure `{sum, count}`) averaged per `unit`:
 * the chats count their messages, a Harness session counts itself. A Total that not every one of
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
      h("thead", {}, h("tr", {}, h("td"), FIGURES.map(([label, , , title]) => h("th", { scope: "col", text: label, title })))),
      h("tbody", {}, row("Total", undefined, figures.map((figure) => figure.total)), row("Average", `Per ${unit}`, figures.map((figure) => figure.average))),
    ),
  );
}

/** What the dashboard's list says with nothing in view: `unit` is "session". */
function emptyText(archived, closed, unit) {
  if (archived) return closed ? `Every ${unit} is archived.` : `Every ${unit} is archived. Start a new one with New session.`;
  return closed ? `No ${unit}s.` : `No ${unit}s yet. Start one with New session.`;
}

/**
 * How a chat of a Terminal session (`sessions.list`'s `terminals`) clicked on the Dashboard opens, always in a terminal of the Harness
 * tab: `{resume, chat}` reopens it from the ended session that holds it; one that cannot be reopened (it ran in a harness run, or this
 * computer no longer keeps its files) starts its agent anew, saying why (`{start, line}`); one whose session still runs is open in
 * that session (`{}`).
 */
export function reopening(chat) {
  const fresh = (why) => ({ start: chat.agent, line: `${why}, so it can't be reopened; started a new ${chat.agent} session` });
  if (chat.running) return {};
  if (!chat.freeForm) return fresh("That session ran in a harness run, not a terminal");
  if (!chat.resumable) return fresh("That session's files are no longer on this computer");
  return { resume: chat.attemptId, chat: { agent: chat.agent, id: chat.conversation, run: chat.run } };
}

/**
 * The dashboard, by agent: chips name, by its CLI command, every agent that made a model call on
 * this plugin, nanoagent (the person's chats) first and chosen at first, and the one chosen shows
 * its usage and its chats, newest first. A chat is one conversation with the agent: under
 * nanoagent the person's sessions, and every agent's chats in the Harness tab's terminals (a
 * Claude Code conversation, a Codex thread, a run of dsh), each with its title (its first prompt),
 * when, its tokens, cost and End-to-End Latency. Under nanoagent New session starts a chat, and
 * they resume one; under any other agent it starts a Harness session running that agent's CLI,
 * and clicking a chat always opens it in a terminal of the Harness tab (reopening). They archive a chat; archived ones
 * leave the agent's list for that agent's Archived view, where they can be opened or restored;
 * talking in one again restores it. Download traces (JSON) downloads the plugin's traces as JSON Lines: theirs, or for a platform
 * administrator, who picks All members, every member's.
 * @param {object} options
 * @param {(session: object|null) => void} options.onOpen With what `session.resume` answered,
 *   or null for a new session.
 * @param {(chat: object) => void} options.onChat With a chat of a Terminal session (`sessions.list`'s `terminals`), to open it.
 * @param {(agent: string) => void} options.onStart With the chosen agent's CLI command, to start a Harness session running it.
 * @param {boolean} [options.closed] Whether no new session may start: the sessions are only read.
 * @returns {{element: HTMLElement, refresh: () => Promise<void>, resume: (id: string) => Promise<boolean>}}
 *   `refresh` lists the sessions again; `resume` opens session `id`, saying why not when it cannot, and whether it did.
 */
export function dashboard({ onOpen, onChat, onStart, closed = false }) {
  const stats = h("div", { class: "dashboard-usage" });
  const status = h("p", { class: "error-text", role: "alert" });
  const list = h("ul", { class: "session-list" });
  const heading = h("h2", { text: "Sessions" });
  const newButton = h("button", { type: "button", class: "button small", hidden: closed, onclick: () => (chosen === NANOAGENT ? onOpen(null) : onStart(chosen)) }, icon("plus", { size: 16 }), "New session");
  const viewButton = h("button", { type: "button", class: "button small ghost", hidden: true });
  const chips = h("div", { class: "harness-chips", role: "group", "aria-label": "Harness" });
  // Download traces (JSON): the plugin's traces as JSON Lines, the member's own, or for a platform administrator every member's.
  const whose = h("select", { class: "trace-scope", "aria-label": "Whose traces", hidden: true },
    h("option", { value: "me", text: "My traces" }), h("option", { value: "all", text: "All members" }));
  const download = h("button", { type: "button", class: "button small ghost", text: "Download traces (JSON)", onclick: async () => {
    status.textContent = "";
    try {
      await request("traces.download", { all: whose.value === "all" });
    } catch (problem) {
      status.textContent = problem.message;
    }
  } });
  request("traces.scope").then(({ admin }) => { whose.hidden = !admin; }, (problem) => { status.textContent = problem.message; });
  let archivedView = false;
  let chosen = NANOAGENT;
  viewButton.addEventListener("click", () => {
    archivedView = !archivedView;
    refresh();
  });

  async function archive(session, button, terminal) {
    button.disabled = true;
    try {
      await request(...(terminal
        ? ["terminal.archive", { attemptId: session.attemptId, chat: session.key, archived: !session.archivedAt }]
        : ["session.archive", { id: session.id, archived: !session.archivedAt }]));
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

  // A row: its title over when it was last used (and, for a scored `rush` run, right or wrong), what it read and wrote (a chat of a
  // Terminal session), cost and took at its end, in line with the others', and Archive (or Restore). `onClick` opens it; a row with
  // none only reads.
  function line(session, { title, running, verdict, tokens, cost, took, onClick, terminal }) {
    const open = h(
      onClick ? "button" : "div",
      { ...(onClick ? { type: "button", title: terminal ? "Reopen this session" : "Resume this session" } : {}), class: "session-open" },
      h("span", { class: "session-title", text: title }),
      h(
        "span", { class: "session-meta" }, running ? statusPill(running, "info") : null,
        verdict ? statusPill(verdict, verdict === "right" ? "ok" : "bad", { icon: true }) : null, when(session.updatedAt),
      ),
    );
    if (onClick) open.addEventListener("click", () => onClick(open));
    const spent = tokens === undefined
      ? h("span", { class: "session-cost", title: "Cost / End-to-End Latency", text: `${cost} / ${took}` })
      : h("span", { class: "session-cost", title: "Tokens · Cost / End-to-End Latency", text: `${tokens} tokens · ${cost} / ${took}` });
    const label = session.archivedAt ? "Restore" : "Archive";
    const archiving = h("button", { type: "button", class: "button small ghost", text: label, title: `${label} ${title}` });
    archiving.addEventListener("click", () => archive(session, archiving, terminal));
    return h("li", { class: "session-row" }, h("div", { class: "session-line" }, open, spent, archiving));
  }

  function row(session) {
    return line(session, {
      title: titled(session), running: session.running && "Answering", cost: formatCost(session.cost),
      took: session.usage.durationS.count ? formatSeconds(session.usage.durationS.sum) : "—", onClick: (open) => resume(session.id, open),
    });
  }

  // A chat of a Terminal session: clicking it opens it in the Harness tab.
  function chatRow(chat) {
    const { usage } = chat;
    const read = usage.inputTokens.count || usage.outputTokens.count;
    return line(chat, {
      title: chat.title, running: chat.running && "Running", verdict: chat.verdict, tokens: read ? thousands(usage.inputTokens.sum + usage.outputTokens.sum) : "—",
      cost: usage.cost.count ? formatCost(usage.cost.sum) : "—", took: usage.durationS.count ? formatSeconds(usage.durationS.sum) : "—", terminal: true,
      onClick: closed ? null : () => onChat(chat),
    });
  }

  async function refresh() {
    status.textContent = "";
    let all;
    let chats;
    try {
      ({ sessions: all, terminals: chats } = await request("sessions.list"));
    } catch (problem) {
      status.textContent = problem.message;
      return;
    }
    // The same chips in both views; each agent's Archived view holds its own archived chats.
    const used = [...new Set([NANOAGENT, ...chats.map((one) => one.agent).sort()])];
    if (!used.includes(chosen)) chosen = NANOAGENT;
    chips.hidden = used.length < 2;
    chips.replaceChildren(...used.map((harness) => h("button", {
      type: "button", class: "harness-chip", text: harness, "aria-pressed": String(harness === chosen),
      onclick: () => {
        chosen = harness;
        refresh();
      },
    })));
    const mine = chats.filter((one) => one.agent === chosen);
    const sessions = chosen === NANOAGENT ? all : [];
    const archived = [...sessions, ...mine].filter((one) => one.archivedAt).length;
    if (!archived) archivedView = false;
    newButton.hidden = closed;
    viewButton.hidden = !archived;
    viewButton.textContent = archivedView ? "Back to sessions" : `Archived (${archived})`;
    heading.textContent = archivedView ? "Archived sessions" : "Sessions";
    const inView = (one) => Boolean(one.archivedAt) === archivedView;
    const newest = (rows) => rows.sort(([x], [y]) => new Date(y.updatedAt) - new Date(x.updatedAt)).map(([one, made]) => made(one));
    const shown = mine.filter(inView);
    const listed = (rows, unit) => list.replaceChildren(
      ...(rows.length ? newest(rows) : [h("li", { class: "session-empty", text: emptyText(archivedView && archived, closed, unit) })]),
    );
    if (chosen !== NANOAGENT) {
      stats.replaceChildren(...(shown.length && !archivedView ? [counted(shown.length, "session"), harnessUsage(shown.map((one) => one.usage), shown.length, "session")] : []));
      listed(shown.map((one) => [one, chatRow]), "session");
      return;
    }
    const own = sessions.filter(inView);
    const runs = own.reduce((sum, one) => sum + one.runs, 0);
    stats.replaceChildren(...(runs && !archivedView ? [counted(own.length), harnessUsage(own.map((one) => one.usage), runs, "message")] : []));
    listed([...own.map((one) => [one, row]), ...shown.map((one) => [one, chatRow])], "session");
  }

  const element = h(
    "section",
    { class: "dashboard" },
    h("header", { class: "dashboard-head" }, heading, h("div", { class: "dashboard-actions" }, whose, download, viewButton, newButton)),
    status,
    chips,
    stats,
    list,
  );
  return { element, refresh, resume };
}
