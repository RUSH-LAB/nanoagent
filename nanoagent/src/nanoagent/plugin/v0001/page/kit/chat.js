// Chat with the plugin's agent over `prompt`: every plugin's Session page (kit/shell.js).

import { request, startRun } from "./bridge.js";
import { h } from "./dom.js";
import { graphView } from "./graph.js";
import { loopView, partRow } from "./loop.js";
import { currentSession, metricsLine } from "./session.js";

/**
 * A conversation with the plugin's agent. Each turn reads as its agent loop, a row per part of
 * it named by its part (kit/loop.js): the user's message, each reply's thinking and text, each
 * tool call and its result, each task's own run indented under its call, and the agent's
 * response, as Markdown. A task's result row has a button that draws the result with `show`,
 * beside the chat, without taking the place of the graph while a turn runs. The rows come from
 * the turn's provenance graph as it streams in, and `trace` draws the graph itself beside the
 * chat (kit/graph.js), as the Graph button under the turn does again. The host keeps the
 * conversation with the session, so a resumed session shows it again, its latest result drawn,
 * and continues it; a message it is still answering shows being answered, to its end, the page
 * having been closed or not, and Mochi having restarted meanwhile or not. Each answer says what
 * it cost and how long it took.
 * @param {object} options
 * @param {Node} options.intro What the empty log shows.
 * @param {string} options.placeholder The message box's placeholder.
 * @param {Record<string, {label: string, title: string, draw: (result: {output: unknown, verdict: object}, call: {send: (text: string) => void}) => Node}>} options.tasks
 *   One entry per task id: its `label` and `title`, and `draw`, which draws what the task
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
  let turns = 0;

  let picked = null;
  /** Marks `chip` picked and draws its task's result beside the chat, in sight unless `focus` is false. */
  const pick = (chip, focus = true) => {
    picked?.setAttribute("aria-pressed", "false");
    picked = chip;
    chip.setAttribute("aria-pressed", "true");
    chip.draw(focus);
  };
  const labelOf = (name) => tasks[name]?.label ?? name;
  /** The button that draws what the task `name` returned, `output`; null for a tool that is not one of the plugin's tasks. */
  const resultButton = (name, output) => {
    const task = tasks[name];
    if (!task) return null;
    const result = JSON.parse(output);
    const chip = h("button", { type: "button", class: "result-open", "aria-pressed": "false", title: task.title, text: "Open result" });
    chip.draw = (focus) => show(task.draw(result, { send: (text) => submit(text) }), { focus });
    chip.addEventListener("click", () => pick(chip));
    return chip;
  };
  /** A turn's rows, as its graph streams in; `first` whether it is the session's first turn. */
  const turnLoop = (first, onResult) => loopView({ first, names: labelOf, result: resultButton, onResult });
  /** A turn's provenance graph, in the Graph tab beside the chat. */
  const turnGraph = (graph) => {
    const view = graphView({ names: labelOf });
    if (graph) view.replace(graph);
    view.settle();
    return view;
  };
  /** The plugin version an answer ran on, and what it cost and took, which a turn kept before turns kept it lacks. */
  const answerLine = (version, metrics) => [version && `v${version}`, metrics && metricsLine(metrics)].filter(Boolean).join(" · ");
  /** Under a turn: what it ran on, took and cost, and the button that draws its graph. */
  const turnFoot = (metrics, drawGraph) =>
    h("div", { class: "turn-foot" }, metrics, drawGraph ? h("button", { type: "button", class: "button ghost small", text: "Graph", onclick: drawGraph }) : null);
  const userRow = (text) => h("ol", { class: "loop" }, partRow("User message", { whole: text, classes: "type-user_message" }));
  /** A kept turn's graph, null for one kept before graphs named each node's part. */
  const partsGraph = (graph) => (graph?.nodes.every((node) => node.typeLabel) ? graph : null);
  /**
   * A turn the session kept, as its parts: its loop, why it was not answered, and the plugin
   * version it ran on with what it cost and took. A turn kept before graphs named their parts
   * shows its tasks' results and its response.
   */
  const keptTurn = ({ answer, tools = [], graph: kept, metrics, error, version }, first) => {
    const graph = partsGraph(kept);
    let rows;
    if (graph) {
      const view = turnLoop(first);
      view.replace(graph);
      view.settle();
      rows = view.element;
    } else {
      const results = tools.filter((call) => !call.isError).map((call) => partRow("Tool result", { text: labelOf(call.name), extra: resultButton(call.name, call.output) }));
      rows = h("ol", { class: "loop" }, results, answer ? partRow("Response", { whole: answer, classes: "type-agent_message" }) : null);
    }
    let view = null;
    const drawGraph = graph ? () => trace((view ??= turnGraph(graph)).element) : null;
    return [
      rows,
      // A message the session did not answer (it failed, was stopped or interrupted) says why.
      error ? h("p", { class: "error-text", text: error }) : null,
      turnFoot(h("p", { class: "message-metrics", text: answerLine(version, metrics) }), drawGraph),
    ];
  };
  const clearIntro = () => {
    if (!turns) log.replaceChildren();
  };
  const kept = currentSession()?.chat ?? [];
  for (const turn of kept) {
    clearIntro();
    log.append(h("div", { class: "turn" }, userRow(turn.prompt), ...keptTurn(turn, turns === 0).filter(Boolean)));
    turns += 1;
  }
  // The latest turn's graph, and its latest task's result in the Result tab.
  const latest = partsGraph(kept.at(-1)?.graph);
  if (latest) trace(turnGraph(latest).element);
  const chips = log.querySelectorAll(".result-open");
  if (chips.length) pick(chips[chips.length - 1], !latest);

  const scroll = () => {
    log.scrollTop = log.scrollHeight;
  };
  async function submit(typed) {
    const text = (typed ?? input.value).trim();
    if (!text || sendButton.disabled || closed) return;
    if (typed === undefined) input.value = "";
    await answer(text, (onEvent) => startRun("prompt", { text }, onEvent));
  }

  /** Show `text` as the person's message and the agent's loop answering it, which `start(onEvent)` streams. */
  async function answer(text, start) {
    clearIntro();
    const first = turns === 0;
    turns += 1;
    const typing = h("p", { class: "typing", "aria-label": "The agent is replying" }, h("span"), h("span"), h("span"));
    // Its result goes in the Result tab, leaving the graph in sight while the turn runs.
    const rows = turnLoop(first, (chip) => pick(chip, false));
    // The turn's provenance graph, drawn beside the chat as it streams in.
    const view = graphView({ names: labelOf });
    const drawGraph = () => trace(view.element);
    drawGraph();
    const metrics = h("p", { class: "message-metrics", hidden: true });
    const foot = turnFoot(metrics, drawGraph);
    const turn = h("div", { class: "turn" }, userRow(text), rows.element, typing, foot);
    const fail = (message) => turn.querySelector(".turn-foot").before(h("p", { class: "error-text", role: "alert", text: message }));
    log.append(turn);
    scroll();
    sendButton.disabled = true;
    const done = () => {
      runId = null;
      sendButton.disabled = false;
      stop.hidden = true;
      stop.disabled = false;
      typing.remove();
      rows.settle();
      view.settle();
    };
    try {
      runId = await start((name, data) => {
        switch (name) {
          // A change to the turn's graph as it is made, then, once it ends, the whole graph.
          case "chat.graph":
            typing.remove();
            if (data.patch) {
              rows.apply(data.patch);
              view.apply(data.patch);
            } else {
              rows.replace(data.graph);
              view.replace(data.graph);
            }
            break;
          // The host follows the run again after its stream dropped, from its first event.
          case "chat.restart":
            rows.replace({ nodes: [], edges: [] });
            view.replace({ nodes: [], edges: [] });
            metrics.hidden = true;
            break;
          // It ended while no stream followed it: the turn the session kept, in place of the one shown.
          case "chat.turn": {
            turn.replaceChildren(userRow(text), ...keptTurn(data.turn, first).filter(Boolean));
            if (partsGraph(data.turn.graph)) view.replace(data.turn.graph);
            const shown = turn.querySelectorAll(".result-open");
            if (shown.length) pick(shown[shown.length - 1], false);
            break;
          }
          case "chat.answer":
            metrics.textContent = answerLine(data.version, data.metrics);
            metrics.hidden = !metrics.textContent;
            break;
          case "chat.error":
            fail(data.message === "cancelled" ? "Stopped." : data.message);
            break;
          case "chat.done":
            done();
            break;
        }
        scroll();
      });
      if (sendButton.disabled) stop.hidden = false;
    } catch (problem) {
      fail(problem.message);
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
