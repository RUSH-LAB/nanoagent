// The Harness tab every plugin's page has (kit/shell.js): the person's own terminals on their computer, in the harness VM, an empty
// workspace with the model a call away through RUSH (which records every call) and the reference CLIs installed, the same whichever
// plugin's page opened it. They run any agent there and prompt it themselves; only a `rush <command>` given the task's prompt is
// scored (the shell reference harness's rush.py).

import { startRun, request } from "./bridge.js";
import { h, icon } from "./dom.js";
import { formatCost, formatSeconds, reopening, thousands } from "./session.js";
import { Terminal } from "./vendor/xterm/xterm.mjs";
import { FitAddon } from "./vendor/xterm/addon-fit.mjs";

// The terminals one session opens at most (RUSH keeps 32: ids 0 to 31).
const MAX_TERMINALS = 32;
const bytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/** Why a Terminal session that did not end as its member ended it stopped, in a few words: its status, and its reason when it has one. */
const stopped = (outcome) => `${outcome.status}${outcome.reason ? `: ${outcome.reason}` : ""}`;

/**
 * The line a Terminal session that ran prints in its terminal once it is over: that it ended (or ran out of its time, or why it
 * stopped otherwise), then its time, tokens and cost, and why its files did not go to RUSH when they did not.
 */
export function outcomeText(outcome) {
  const end = outcome.reason === "timed_out"
    ? "Session time limit reached"
    : outcome.ended
    ? "Session ended"
    : `Session ended (${stopped(outcome)})`;
  const tokens = outcome.inputTokens === null ? "—" : thousands((outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0));
  const upload = outcome.uploadError ? [`Files not uploaded to RUSH: ${outcome.uploadError}`] : [];
  return [end, formatSeconds(outcome.elapsedMs === null ? null : outcome.elapsedMs / 1000), `${tokens} tokens`, formatCost(outcome.cost), ...upload].join(" · ");
}

/** The one plain line of a Terminal that could not start, with why. */
const failedText = (reason) => `Couldn't start the terminal: ${reason}`;

/**
 * The Harness tab: a free-form Terminal session that starts when the tab is first shown, nothing of the plugin loaded in it: the
 * member runs any agent there and prompts it themselves, and only `nanoagent` (and `mgen`) is given the plugin's tools, which start
 * the first time it runs. As in an editor's
 * terminal panel, they open more terminals in the same VM and workspace ("+"), switch between them by their tabs and close one (×);
 * a terminal whose shell they leave (exit, Ctrl-D) closes too. The session ends with its last terminal; its time, tokens and cost
 * print there, and Enter then starts a new one. Another tab shown, or the page left, the session runs on, and only its member ends it
 * (exit, its time limit, quitting RUSH Lab): started again while it runs, from here or anywhere else, this tab is given it again
 * (`harness.session` `joined`), and each of its terminals comes back with what it wrote from its first byte. `openChat(chat)` opens one
 * of their chats (the Dashboard's) in a terminal, always (session.js reopening): while their session runs, here or elsewhere, in a new
 * terminal of it, the chat's files in a folder of their own there; else in a new session that resumes the ended one holding it, the
 * worker putting back what it kept of it on their computer; and its agent's resume command runs there, or, for a chat that cannot be
 * reopened, its agent anew after a line saying why. `startCli(name)` runs the agent CLI `name` (`claude`) the same way: in a new
 * terminal of their running session, as "+" opens one, else in the first terminal of a new session.
 * @returns {{element: HTMLElement, openChat: (chat: object) => void, startCli: (name: string) => void}}
 */
export function harnessPage() {
  let runId = null;
  let attempt = null;  // the running session's attempt, once RUSH has queued it
  let generation = 0;  // which start() the events heard are for: a resume can start another while one is still running
  let ended = false;
  let next = 0;  // the id the next terminal opened gets
  let active = null;
  const views = new Map();  // by terminal id: {id, terminal, fit, screen, tab}
  const screens = h("div", { class: "harness-screens" });
  const add = h("button", { type: "button", class: "harness-tab-add", "aria-label": "New terminal", title: "New terminal", onclick: () => openAnother() }, icon("plus", { size: 15 }));
  const tabs = h("div", { class: "harness-tabs", role: "tablist", "aria-label": "Terminals" }, add);

  const send = (method, params, view) => runId && request(method, { runId, ...params }).catch((problem) => view.terminal.write(`\x1b[31m${problem.message}\x1b[0m\r\n`));

  /** A terminal's view, its tab and screen, shown at once (xterm measures its size by the shown screen). */
  function view(id) {
    const screen = h("div", { class: "harness-terminal" });
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, theme: { background: "#14161b" } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const label = `Terminal ${id + 1}`;
    const tab = h("div", { class: "harness-tab", role: "tab", onclick: () => show(id) },
      h("span", { text: label }),
      h("button", {
        type: "button", class: "harness-tab-close", "aria-label": `Close ${label}`, title: `Close ${label}`,
        onclick: (event) => { event.stopPropagation(); close(id); },
      }, icon("close", { size: 13 })));
    const entry = { id, terminal, fit, screen, tab };
    views.set(id, entry);
    screens.append(screen);
    tabs.insertBefore(tab, add);
    show(id);
    terminal.open(screen);
    fit.fit();
    terminal.onData((data) => {
      if (ended && data === "\r") start();
      else send("harness.input", { terminal: id, data }, entry);
    });
    return entry;
  }

  function show(id) {
    active = id;
    for (const entry of views.values()) {
      const shown = entry.id === id;
      entry.screen.hidden = !shown;
      entry.tab.setAttribute("aria-selected", String(shown));
    }
    const entry = views.get(id);
    if (entry.terminal.element) {
      entry.fit.fit();
      entry.terminal.focus();
    }
  }

  function remove(id) {
    const entry = views.get(id);
    views.delete(id);
    entry.terminal.dispose();
    entry.screen.remove();
    entry.tab.remove();
    if (active === id && views.size) show([...views.keys()].at(-1));
  }

  // "+": another terminal of the running session, the size the panel measures, its output followed from its first byte.
  async function openAnother() {
    if (!runId || ended || next >= MAX_TERMINALS) return;
    const id = next++;
    const entry = view(id);
    updateAdd();
    const { rows, cols } = entry.terminal;
    await send("harness.open", { terminal: id, rows, cols }, entry);
    entry.terminal.onResize((size) => send("harness.resize", { terminal: id, ...size }, entry));
  }

  // A terminal of the session this tab did not open: one the session it was given again already has.
  function adopt(id) {
    const entry = view(id);
    next = Math.max(next, id + 1);
    updateAdd();
    entry.terminal.onResize((size) => send("harness.resize", { terminal: id, ...size }, entry));
    send("harness.resize", { terminal: id, rows: entry.terminal.rows, cols: entry.terminal.cols }, entry);
    return entry;
  }

  // ×: the worker ends the terminal's processes; its tab goes when RUSH says it ended (harness.closed), the session with its last.
  function close(id) {
    if (runId && !ended) send("harness.close", { terminal: id }, views.get(id));
    else if (views.size > 1) remove(id);
  }

  function updateAdd() {
    add.disabled = !runId || ended || next >= MAX_TERMINALS;
  }

  // The first terminal opens once the tab is first shown, the size it measures by, and starts its first session then.
  let opened = false;
  new ResizeObserver(() => {
    if (!screens.offsetParent) return;
    if (!opened) {
      opened = true;
      start();
      return;
    }
    if (active !== null) views.get(active).fit.fit();
  }).observe(screens);

  // A chat to open in the next terminal of the session once this tab has it (openChat), and the session the chat is of.
  let reopen = null;
  let reopenOf = null;
  function reopenNext() {
    if (!runId || !attempt || ended || !reopen) return;  // once RUSH said which session this is (harness.session)
    const shown = views.get(active).terminal;
    const asked = reopen;
    reopen = null;
    if (next >= MAX_TERMINALS) {
      shown.write(`\r\n\x1b[31mThis session opened its ${MAX_TERMINALS} terminals: leave its shell (exit), then click the session again.\x1b[0m\r\n`);
      return;
    }
    next += 1;  // the worker opens the next terminal for it, which shows here as its output comes
    send("harness.reopen", { rows: shown.rows, cols: shown.cols, reopen: asked }, views.get(active));
  }

  async function start({ resume, chat, cli, line } = {}) {
    const mine = ++generation;
    attempt = null;
    for (const id of [...views.keys()]) remove(id);
    ended = false;
    runId = null;
    next = 1;
    const first = view(0);
    first.terminal.onResize((size) => send("harness.resize", { terminal: 0, ...size }, first));
    updateAdd();
    let preparing = false;
    // Whether the shell started (its first output came), and whether it was told it could not.
    let started = false;
    let failed = false;
    // What the session says as a whole (its outcome, an error) is told in the terminal shown.
    const shown = () => views.get(active).terminal;
    const fail = (reason) => {
      if (failed) return;
      failed = true;
      shown().write(`\r\n${failedText(reason)}\r\n`);
    };
    const done = () => {
      runId = null;
      attempt = null;
      ended = true;
      updateAdd();
      shown().write("Press Enter to start a new one.");
    };
    try {
      const params = { harness: "shell", ...(resume ? { resume, chat } : {}), ...(cli ? { start: cli } : {}) };
      const id = await startRun("harness.run", params, (name, data) => {
        if (mine !== generation) return;  // a session this tab has since replaced
        switch (name) {
          case "harness.session":
            attempt = data.attemptId;
            if (!data.joined) {
              reopen = null;  // this session is the chat's: its first terminal opens it
              if (line) first.terminal.write(`${line}\r\n`);
            } else if (attempt === reopenOf) {
              reopen = null;  // the chat is of the session running: it is open in it
            }
            reopenNext();
            break;
          case "harness.preparing":  // shown only while something downloads; otherwise the terminal just opens
            if (!data.total) break;
            preparing = true;
            first.terminal.write(`\r\x1b[KPreparing your computer (${Math.round(data.done / 1e6)} of ${Math.round(data.total / 1e6)} MB): the session starts once it is ready`);
            break;
          case "harness.output": {
            const entry = views.get(data.terminal) ?? adopt(data.terminal);
            if (preparing) entry.terminal.write("\r\x1b[K");
            preparing = false;
            started = true;
            entry.terminal.write(bytes(data.data));
            break;
          }
          case "harness.closed":  // the last terminal stays, for the session's outcome
            if (views.has(data.terminal) && views.size > 1) remove(data.terminal);
            break;
          case "harness.outcome":
            if (started) shown().write(`\r\n\x1b[1m${outcomeText(data)}\x1b[0m\r\n`);
            else fail(stopped(data));
            break;
          case "harness.error":
            if (started) shown().write(`\r\n\x1b[31m${data.message}\x1b[0m\r\n`);
            else fail(data.message);
            break;
          case "harness.done":
            done();
            break;
        }
      });
      // A session that ended while it started (its events came with the reply) has nothing left to send to.
      if (mine === generation && !ended) {
        runId = id;
        updateAdd();
        send("harness.resize", { terminal: 0, rows: first.terminal.rows, cols: first.terminal.cols }, first);
        first.terminal.focus();
        reopenNext();
      }
    } catch (problem) {
      if (mine !== generation) return;
      fail(problem.message);
      done();
    }
  }

  // `how` (`{resume, chat}`, `{start, line?}`, or {} for nothing), in a new terminal of the running session, else in the first of a new
  // one, or of the member's session running elsewhere, which RUSH gives this tab (`joined`); `of` the session a chat is of.
  function openIn(how, of) {
    opened = true;
    reopen = Object.keys(how).length ? how : null;
    reopenOf = of;
    if (runId && !ended) {
      if (of !== null && attempt === of) reopen = null;  // one of the running session's own chats: it is open in it
      reopenNext();
    } else {
      start({ ...(how.resume ? { resume: how.resume, chat: how.chat } : {}), ...(how.start ? { cli: how.start, line: how.line } : {}) });
    }
  }

  /** Opens `chat` (the Dashboard's) in a terminal: see harnessPage. */
  const openChat = (chat) => openIn(reopening(chat), chat.attemptId);

  /** Runs the agent CLI `name` in a new terminal of the running session, else in the first of a new one: see harnessPage. */
  const startCli = (name) => openIn({ start: name }, null);

  return { element: h("section", { class: "harness-page", "aria-label": "Harness" }, tabs, screens), openChat, startCli };
}
