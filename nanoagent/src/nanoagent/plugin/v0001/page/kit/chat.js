// Chat with the plugin's agent over `prompt`: every plugin's Session page (kit/shell.js).

import { request, startRun } from "./bridge.js";
import { h, icon } from "./dom.js";
import { graphView } from "./graph.js";
import { markdown } from "./markdown.js";
import { currentSession, metricsLine } from "./session.js";

/**
 * A conversation with the plugin's agent. Answers are shown as Markdown. Each of the agent's
 * tools is one of the plugin's tasks. Above each answer, a trail shows what the agent did, a row
 * each, as it does it: each thought, its first line opening to all of it, and each task it ran,
 * with the tools the task's agent called and what it is doing until it ends. A task's row is
 * then its result's chip, marked with whether it passed its check, and picking it draws the
 * result with `show`, beside the chat, without taking the place of the graph while a turn runs;
 * a task that failed says why. Each turn's provenance graph (kit/graph.js) streams in with
 * `trace` as the turn runs, and the Graph button under the answer draws it again. The host keeps
 * the conversation with the session, task results and all the agent did included, so a resumed
 * session shows it again, its latest result drawn, and continues it; a message it is still
 * answering shows being answered, to its end, the page having been closed or not, and Mochi
 * having restarted meanwhile or not. Each answer says what it cost and how long it took.
 * @param {object} options
 * @param {Node} options.intro What the empty log shows.
 * @param {string} options.placeholder The message box's placeholder.
 * @param {Record<string, {label: string, title: string, draw: (result: {output: unknown, verdict: object}, call: {send: (text: string) => void}) => Node}>} options.tasks
 *   One entry per task id: its chip's `label` and `title`, and `draw`, which draws what the task
 *   returned. `send` sends a message as if the person typed it, e.g. from a card's button.
 * @param {(node: Node, options?: {focus?: boolean}) => void} options.show Draws a task's result beside the chat, in sight unless `focus` is false.
 * @param {(node: Node) => void} options.trace Draws a turn's provenance graph (kit/graph.js) beside the chat.
 * @param {boolean} [options.closed] Whether the conversation is only read: it has no message box.
 * @returns {{element: HTMLElement, busy: () => boolean}} `busy` is true while a message is being answered.
 */
export function chatPanel({ intro, placeholder, tasks, show, trace, closed = false }) {
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" }, intro);
  const input = h("textarea", { class: "input", rows: 2, placeholder, "aria-label": placeholder });
  const sendButton = h("button", { type: "button", class: "button primary", text: "Send" });
  const stop = h("button", { type: "button", class: "button", text: "Stop", hidden: true });
  let runId = null;
  let fresh = true;

  let picked = null;
  /** Marks `chip` picked and draws its task's result beside the chat, in sight unless `focus` is false. */
  const pick = (chip, focus = true) => {
    picked?.setAttribute("aria-pressed", "false");
    picked = chip;
    chip.setAttribute("aria-pressed", "true");
    chip.draw(focus);
  };
  const labelOf = (name) => tasks[name]?.label ?? name;
  /** The tools a task's agent called, each name once in the order first called, with how often and how often it failed. */
  const toolsText = (steps) => {
    const counts = new Map();
    for (const { name, isError } of steps) {
      const count = counts.get(name) ?? { calls: 0, failed: 0 };
      count.calls += 1;
      if (isError) count.failed += 1;
      counts.set(name, count);
    }
    const failed = (count) => (!count.failed ? "" : count.failed === count.calls ? " failed" : ` (${count.failed} failed)`);
    return [...counts].map(([name, count]) => `${name}${count.calls > 1 ? ` ×${count.calls}` : ""}${failed(count)}`).join(", ");
  };
  /** The first line of what the agent thought, for its row. */
  const firstLine = (text) => text.trim().split("\n")[0];
  /** The end of what the agent is thinking now, for its row while it thinks. */
  const lastWords = (text) => {
    const line = text.trim().replace(/\s+/g, " ");
    return line.length > 120 ? `…${line.slice(-119)}` : line;
  };

  /**
   * A thought, one row of a turn's trail: its first line, opening to all of it. `add(text)`
   * streams more of it in, its row showing the end of it until `end()`.
   */
  const thoughtRow = (text = "") => {
    const preview = h("span", { class: "trail-preview" });
    const body = h("p", { class: "thinking-text" });
    const element = h("li", { class: "trail-step think" }, h("details", {}, h("summary", {}, h("span", { class: "trail-name", text: "Thought" }), preview), body));
    let all = "";
    const row = {
      element,
      add: (more) => {
        all += more;
        body.textContent = all;
        preview.textContent = element.classList.contains("live") ? lastWords(all) : firstLine(all);
      },
      end: () => {
        element.classList.remove("live");
        preview.textContent = firstLine(all);
      },
    };
    row.add(text);
    return row;
  };
  /**
   * A task the agent ran, one row of a turn's trail: its name and the tools its agent called.
   * While it runs it says what it is doing; `done(call)` ends it with its call, `{name, output,
   * isError}`, after which the row is the task's result chip, or says why it failed.
   */
  const taskRow = ({ name, steps = [] }) => {
    const mark = h("span", { class: "trail-mark" });
    const tools = h("span", { class: "trail-tools", text: toolsText(steps) });
    const status = h("span", { class: "trail-status" });
    const head = h("span", { class: "trail-head" }, mark, h("span", { class: "trail-name", text: labelOf(name) }), tools);
    const element = h("li", { class: "trail-step task" }, head, status);
    return {
      element,
      called: () => {
        tools.textContent = toolsText(steps);
      },
      status: (text) => {
        status.textContent = text;
      },
      done: ({ name: called, output, isError }) => {
        element.classList.remove("live");
        status.textContent = "";
        const task = tasks[called];
        if (!task || isError) {
          element.classList.add("bad");
          mark.replaceChildren(icon("error", { size: 14, label: "Failed" }));
          status.textContent = task ? `Failed: ${output}` : `The agent called ${called}, which is not one of the plugin's tasks.`;
          status.classList.add("error-text");
          return null;
        }
        const result = JSON.parse(output);
        const valid = result.verdict.valid;
        mark.replaceChildren(icon(valid ? "check" : "error", { size: 14, label: valid ? "Checked" : "Check failed" }));
        const chip = h("button", { type: "button", class: `trail-result${valid ? "" : " bad"}`, "aria-pressed": "false", title: task.title }, head);
        chip.draw = (focus) => show(task.draw(result, { send: (text) => submit(text) }), { focus });
        chip.addEventListener("click", () => pick(chip));
        element.prepend(chip);
        return chip;
      },
    };
  };
  /** A turn's trail: one row per thought and per task the agent ran, in order, on a rail. A long one shows its first and last rows, the rest behind a button. */
  const trail = () => h("ol", { class: "trail" });
  const shorten = (list) => {
    const rows = [...list.children];
    if (rows.length <= 6) return;
    const hidden = rows.slice(2, -3);
    hidden.forEach((row) => {
      row.hidden = true;
    });
    const more = h("button", { type: "button", class: "trail-more", text: `${hidden.length} more steps` });
    more.addEventListener("click", () => {
      hidden.forEach((row) => {
        row.hidden = false;
      });
      more.parentElement.remove();
    });
    rows[2].before(h("li", { class: "trail-step more" }, more));
  };
  /** A turn's provenance graph, in the Graph tab beside the chat. */
  const turnGraph = (graph) => {
    const view = graphView({ names: labelOf });
    if (graph) view.replace(graph);
    view.settle();
    return view;
  };
  /** The plugin version an answer ran on, and what it cost and took, which a turn kept before turns kept it lacks. */
  const answerLine = (version, metrics) => [version && `v${version}`, metrics && metricsLine(metrics)].filter(Boolean).join(" · ");
  /** Under a turn's answer: what it ran on, took and cost, and the button that draws its graph. */
  const turnFoot = (metrics, drawGraph) =>
    h("div", { class: "turn-foot" }, metrics, drawGraph ? h("button", { type: "button", class: "button ghost small", text: "Graph", onclick: drawGraph }) : null);
  /**
   * A turn the session kept, as its parts: what the agent did, each task its result's chip, its
   * answer, the plugin version it ran on with what it cost and took, and why it was not answered.
   */
  const keptTurn = ({ answer, tools = [], activity = [], graph, metrics, error, version }) => {
    const list = trail();
    // The turn's tools are its tasks' calls, in the same order.
    const calls = [...tools];
    for (const entry of activity) {
      if (entry.kind === "thought") list.append(thoughtRow(entry.text).element);
      else {
        const row = taskRow(entry);
        row.done(calls.shift());
        list.append(row.element);
      }
    }
    shorten(list);
    // A turn kept before graphs were recorded has none.
    let view = null;
    const drawGraph = graph ? () => trace((view ??= turnGraph(graph)).element) : null;
    return [
      list.children.length ? list : null,
      answer ? h("div", { class: "message agent" }, markdown(answer)) : null,
      turnFoot(h("p", { class: "message-metrics", text: answerLine(version, metrics) }), drawGraph),
      // A message the session did not answer (it failed, was stopped or interrupted) says why.
      error ? h("p", { class: "error-text", text: error }) : null,
    ];
  };
  const clearIntro = () => {
    if (fresh) log.replaceChildren();
    fresh = false;
  };
  for (const kept of currentSession()?.chat ?? []) {
    clearIntro();
    log.append(h("div", { class: "message user" }, h("p", { text: kept.prompt })), h("div", { class: "turn" }, keptTurn(kept)));
  }
  // The latest turn's graph, and its latest task's result in the Result tab.
  const latest = currentSession()?.chat.at(-1);
  if (latest?.graph) trace(turnGraph(latest.graph).element);
  const chips = log.querySelectorAll(".trail-result");
  if (chips.length) pick(chips[chips.length - 1], !latest?.graph);

  const scroll = () => {
    log.scrollTop = log.scrollHeight;
  };
  async function submit(typed) {
    const text = (typed ?? input.value).trim();
    if (!text || sendButton.disabled || closed) return;
    if (typed === undefined) input.value = "";
    await answer(text, (onEvent) => startRun("prompt", { text }, onEvent));
  }

  /** Show `text` as the person's message and the agent's reply to it, which `start(onEvent)` streams. */
  async function answer(text, start) {
    clearIntro();
    log.append(h("div", { class: "message user" }, h("p", { text })));
    const typing = () => h("p", { class: "typing", "aria-label": "The agent is replying" }, h("span"), h("span"), h("span"));
    const reply = h("div", { class: "message agent" }, typing());
    // What the agent does, a row each, as it does it.
    let list = trail();
    // The turn's provenance graph, drawn beside the chat as it streams in.
    const view = graphView({ names: labelOf });
    const drawGraph = () => trace(view.element);
    drawGraph();
    const metrics = h("p", { class: "message-metrics", hidden: true });
    const turn = h("div", { class: "turn" }, list, reply, turnFoot(metrics, drawGraph));
    // Whether the turn the session kept took this one's place.
    let replaced = false;
    log.append(turn);
    scroll();
    sendButton.disabled = true;
    let streamed = "";
    let started = false;
    // What the agent is thinking now, until it does something else; a thought after that is a new one.
    let thinking = null;
    const thought = () => {
      thinking?.end();
      thinking = null;
    };
    const think = (text) => {
      if (!thinking) {
        thinking = thoughtRow();
        thinking.element.classList.add("live");
        list.append(thinking.element);
      }
      thinking.add(text);
    };
    // Each task running, by its call's id, until its call ends: its row, and the tools its agent called.
    const running = new Map();
    const startTask = ({ id, name }) => {
      const steps = [];
      const row = taskRow({ name, steps });
      row.element.classList.add("live");
      row.status("Starting…");
      running.set(id, { row, steps });
      list.append(row.element);
    };
    /** Show what a running task reports: the `task.*` events of TaskTool.report (nanoagent.web.plugin_agent). */
    const taskProgress = ({ id, event, data }) => {
      const task = running.get(id);
      if (!task) return;
      if (event === "task.reference") task.row.status(`Running its reference, ${data.tool}…`);
      else if (event === "task.tool") {
        task.steps.push({ name: data.name, isError: Boolean(data.isError) });
        task.row.called();
        task.row.status("Working…");
      } else if (event === "task.delta") task.row.status(data.kind === "reasoning" ? "Thinking…" : "Working…");
      else if (event === "task.result") task.row.status("Checking the result…");
    };
    const write = (value) => {
      started = true;
      reply.replaceChildren(markdown(value));
    };
    const done = () => {
      runId = null;
      sendButton.disabled = false;
      stop.hidden = true;
      stop.disabled = false;
      thought();
      // A call that never ended: the agent retried it, or the run stopped while it ran.
      for (const { row } of running.values()) row.element.remove();
      running.clear();
      view.settle();
      if (!replaced) shorten(list);
      if (!started) reply.remove();
    };
    try {
      runId = await start((name, data) => {
        switch (name) {
          case "chat.reasoning":
            think(data.text ?? "");
            break;
          case "chat.delta":
            thought();
            streamed += data.text ?? "";
            write(streamed);
            break;
          case "chat.tool.started":
            thought();
            startTask(data);
            break;
          case "chat.tool.progress":
            taskProgress(data);
            break;
          // A change to the turn's graph as it is made, then, once it ends, the whole graph.
          case "chat.graph":
            if (data.patch) view.apply(data.patch);
            else view.replace(data.graph);
            break;
          case "chat.tool": {
            thought();
            const task = running.get(data.id) ?? { row: taskRow({ name: data.name }) };
            running.delete(data.id);
            if (!task.row.element.isConnected) list.append(task.row.element);
            // Its result goes in the Result tab, leaving the graph in sight while the turn runs.
            const chip = task.row.done(data);
            if (chip) pick(chip, false);
            break;
          }
          // The host follows the run again after its stream dropped, from its first event.
          case "chat.restart":
            thinking = null;
            running.clear();
            streamed = "";
            started = false;
            {
              const fresh = trail();
              list.replaceWith(fresh);
              list = fresh;
            }
            view.replace({ nodes: [], edges: [] });
            metrics.hidden = true;
            reply.replaceChildren(typing());
            break;
          // It ended while no stream followed it: the turn the session kept, in place of the one shown.
          case "chat.turn": {
            thinking = null;
            running.clear();
            started = true;
            replaced = true;
            turn.replaceChildren(...keptTurn(data.turn).filter(Boolean));
            if (data.turn.graph) view.replace(data.turn.graph);
            const shown = turn.querySelectorAll(".trail-result");
            if (shown.length) pick(shown[shown.length - 1], false);
            break;
          }
          case "chat.answer":
            thought();
            write(data.text ?? "");
            {
              metrics.textContent = answerLine(data.version, data.metrics);
              metrics.hidden = !metrics.textContent;
            }
            break;
          case "chat.error":
            turn.append(h("p", { class: "error-text", role: "alert", text: data.message === "cancelled" ? "Stopped." : data.message }));
            break;
          case "chat.done":
            done();
            break;
        }
        scroll();
      });
      if (sendButton.disabled) stop.hidden = false;
    } catch (problem) {
      turn.append(h("p", { class: "error-text", role: "alert", text: problem.message }));
      done();
    }
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  sendButton.addEventListener("click", () => submit());
  stop.addEventListener("click", async () => {
    if (!runId) return;
    stop.disabled = true;
    try {
      await request("cancel", { runId });
    } catch (problem) {
      stop.disabled = false;
      log.append(h("p", { class: "error-text", role: "alert", text: `Stop failed: ${problem.message}` }));
    }
  });

  // A session opened while it still answers a message follows that answer to its end.
  const running = currentSession()?.running;
  if (running) answer(running.prompt, (onEvent) => startRun("follow", {}, onEvent));

  const box = closed ? null : h("div", { class: "chat-input" }, input, h("div", { class: "chat-buttons" }, stop, sendButton));
  return {
    busy: () => sendButton.disabled,
    element: h("section", { class: "chat", "aria-label": "Chat" }, log, box),
  };
}
