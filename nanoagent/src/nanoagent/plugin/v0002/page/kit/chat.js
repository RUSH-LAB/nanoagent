// Chat with the plugin's agent over `prompt`: every plugin's Session page (kit/shell.js).

import { request, startRun } from "./bridge.js";
import { h } from "./dom.js";
import { graphView, sessionGraph } from "./graph.js";
import { loopView, partRow } from "./loop.js";
import { PARTS, TYPES } from "./parts.js";
import { currentSession } from "./session.js";

/**
 * A conversation with the plugin's agent. Each turn reads as its agent loop, a row per part of
 * it named by its part (kit/loop.js): the user's message, each reply's thinking and text, each
 * tool call and its result, each task's own run indented under its call, and the agent's
 * response, as Markdown. Each task's result is drawn with `show`, beside the chat, without
 * taking the place of the graph while a turn runs. The rows come from the turn's provenance
 * graph as it streams in, and `trace` draws the session's graph, every turn's joined, beside
 * the chat (kit/graph.js sessionGraph). The host keeps the conversation with the session, so a
 * resumed session shows it again, its graph and latest result drawn, and continues it; a
 * message it is still answering shows being answered, to its end, the page having been closed
 * or not, and RUSH having restarted meanwhile or not. What the session cost and took is in its
 * graph's summary.
 * @param {object} options
 * @param {Node} options.intro What the empty log shows.
 * @param {string} options.placeholder The message box's placeholder.
 * @param {Record<string, {label: string, title: string, draw: (result: {output: unknown, verdict: object}, call: {send: (text: string) => void}) => Node}>} options.tasks
 *   One entry per task id: its `label` and `title`, and `draw`, which draws what the task
 *   returned. `send` sends a message as if the person typed it, e.g. from a card's button.
 * @param {(node: Node, options?: {focus?: boolean}) => void} options.show Draws a task's result beside the chat, in sight unless `focus` is false.
 * @param {(node: Node) => void} options.trace Draws the session's provenance graph (kit/graph.js) beside the chat.
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

  const labelOf = (name) => tasks[name]?.label ?? name;
  /**
   * What draws what the task `name` returned, `output`, beside the chat, in sight unless `focus`
   * is false; null for a tool that is not one of the plugin's tasks.
   */
  const resultDraw = (name, output) => {
    const task = tasks[name];
    if (!task) return null;
    const result = JSON.parse(output);
    return (focus) => show(task.draw(result, { send: (text) => submit(text) }), { focus });
  };
  /** A turn's rows, as its graph streams in; `first` whether it is the session's first turn, `onResult` given what draws each result. */
  const turnLoop = (first, onResult) => loopView({ first, names: labelOf, result: resultDraw, onResult });
  // The session's provenance graph, every turn's joined, in the Graph tab beside the chat.
  const session = sessionGraph();
  const view = graphView({ names: labelOf });
  const userRow = (text) => h("ol", { class: "loop" }, partRow(PARTS[TYPES.USER_MESSAGE], { whole: text }));
  /** A kept turn's graph, null for one kept before its nodes' types were the parts of kit/parts.js. */
  const partsGraph = (graph) => (graph?.nodes.every((node) => node.type in PARTS) ? graph : null);
  /**
   * A turn the session kept, as its parts: its loop and why it was not answered; `onResult` is
   * given what draws each of its tasks' results. A turn kept before graphs named their parts
   * shows its tasks' results and its response.
   */
  const keptTurn = ({ answer, tools = [], graph: kept, error }, first, onResult) => {
    const graph = partsGraph(kept);
    let rows;
    if (graph) {
      const loop = turnLoop(first, onResult);
      loop.replace(graph);
      loop.settle();
      rows = loop.element;
    } else {
      const calls = tools.filter((call) => !call.isError);
      for (const call of calls) {
        const draw = resultDraw(call.name, call.output);
        if (draw) onResult(draw);
      }
      rows = h("ol", { class: "loop" }, calls.map((call) => partRow(PARTS[TYPES.TOOL_RESULT], { text: labelOf(call.name) })), answer ? partRow(PARTS[TYPES.RESPONSE], { whole: answer }) : null);
    }
    return [
      rows,
      // A message the session did not answer (it failed, was stopped or interrupted) says why.
      error ? h("p", { class: "error-text", text: error }) : null,
    ];
  };
  const clearIntro = () => {
    if (!turns) log.replaceChildren();
  };
  const kept = currentSession()?.chat ?? [];
  let lastResult = null;
  for (const turn of kept) {
    clearIntro();
    log.append(h("div", { class: "turn" }, userRow(turn.prompt), ...keptTurn(turn, turns === 0, (draw) => (lastResult = draw)).filter(Boolean)));
    session.turn(partsGraph(turn.graph));
    turns += 1;
  }
  // The session's graph, and the latest task's result in the Result tab.
  const drawn = session.graph().nodes.length > 0;
  view.replace(session.graph());
  view.settle();
  if (drawn) trace(view.element);
  lastResult?.(!drawn);

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
    // The turn's part of the session's graph, drawn beside the chat as it streams in.
    session.turn();
    view.resume();
    trace(view.element);
    // Its result goes in the Result tab, leaving the graph in sight while the turn runs.
    const rows = turnLoop(first, (draw) => draw(false));
    const turn = h("div", { class: "turn" }, userRow(text), rows.element, typing);
    const fail = (message) => turn.append(h("p", { class: "error-text", role: "alert", text: message }));
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
              for (const patch of session.patch(data.patch)) view.apply(patch);
            } else {
              rows.replace(data.graph);
              session.redo(data.graph);
              view.replace(session.graph());
            }
            break;
          // The host follows the run again after its stream dropped, from its first event.
          case "chat.restart":
            rows.replace({ nodes: [], edges: [] });
            session.redo({ nodes: [], edges: [] });
            view.replace(session.graph());
            break;
          // It ended while no stream followed it: the turn the session kept, in place of the one shown.
          case "chat.turn": {
            let draw = null;
            turn.replaceChildren(userRow(text), ...keptTurn(data.turn, first, (each) => (draw = each)).filter(Boolean));
            session.redo(partsGraph(data.turn.graph));
            view.replace(session.graph());
            draw?.(false);
            break;
          }
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
