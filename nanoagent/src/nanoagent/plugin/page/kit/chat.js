// Chat with the plugin's agent over `prompt`: the chat panel, and the drawer that keeps it one
// click away on a designed page (a side panel on wide screens, a full-screen sheet on narrow ones).

import { request, startRun } from "./bridge.js";
import { h, icon, nextId } from "./dom.js";
import { markdown } from "./markdown.js";
import { parseToolOutput } from "./run.js";
import { currentSession, metricsLine } from "./session.js";

/**
 * A conversation with the plugin's agent. Answers are shown as Markdown. A tool call the page has
 * a renderer for shows its result above the answer, as the page draws it; the other calls are the
 * agent's own business and are not shown. The host keeps the conversation with the session, tool
 * results included, so a resumed session shows it again and continues it. Each answer says what
 * it cost and how long it took.
 * @param {object} options
 * @param {Node} [options.intro] What the empty log shows.
 * @param {string} [options.placeholder] Default "Message the agent".
 * @param {Array<string|{label: string, text: string}>} [options.suggestions] Chips that put their
 *   text in the box (never send it): people read and edit before pressing Send.
 * @param {(text: string) => string} [options.prepare] Turns what the person typed into what is
 *   sent, e.g. to prefix the page's context ("My current dinner: …"). Their bubble shows what they typed.
 * @param {Record<string, (data: object, call: {arguments: object, send: (text: string) => void}) => Node|null>} [options.render]
 *   One renderer per tool name: it gets the tool's parsed output and draws it (null draws
 *   nothing). `send` sends a message as if the person typed it, e.g. from a card's button.
 * @param {() => void} [options.onTurnDone] After each reply (e.g. refresh workspace files).
 * @returns {{element: HTMLElement, prefill: (text: string) => void, send: (text: string) => void, setSuggestions: (suggestions: Array<string|{label: string, text: string}>) => void, focus: () => void, readonly busy: boolean}}
 */
export function chatPanel({ intro, placeholder = "Message the agent", suggestions = [], prepare, render = {}, onTurnDone }) {
  const log = h("div", { class: "chat-log", role: "log", "aria-live": "polite" }, intro);
  const input = h("textarea", { class: "input", rows: 2, placeholder, "aria-label": placeholder });
  const sendButton = h("button", { type: "button", class: "button primary", text: "Send" });
  const stop = h("button", { type: "button", class: "button", text: "Stop", hidden: true });
  const chips = h("div", { class: "chips chat-suggestions", role: "group", "aria-label": "Suggestions" });
  let runId = null;
  let fresh = true;

  /** The tool call's result as the page draws it, or null when it draws none. */
  const toolResult = ({ name, arguments: args, output, isError }) => {
    const data = isError || !render[name] ? null : parseToolOutput(output);
    const drawn = data ? render[name](data, { arguments: args ?? {}, send: (text) => submit(text) }) : null;
    return drawn ? h("div", { class: "tool-result" }, drawn) : null;
  };
  const clearIntro = () => {
    if (fresh) log.replaceChildren();
    fresh = false;
  };
  for (const { prompt, answer, tools = [] } of currentSession()?.chat ?? []) {
    clearIntro();
    log.append(h("div", { class: "message user" }, h("p", { text: prompt })), h("div", { class: "turn" }, tools.map(toolResult), h("div", { class: "message agent" }, markdown(answer))));
  }

  const scroll = () => {
    log.scrollTop = log.scrollHeight;
  };
  const prefill = (text) => {
    input.value = text;
    input.focus();
    input.setSelectionRange(text.length, text.length);
  };
  const setSuggestions = (next) => {
    chips.replaceChildren(
      ...next.map((one) => {
        const { label, text } = typeof one === "string" ? { label: one, text: one } : one;
        return h("button", { type: "button", class: "chip", text: label, title: text === label ? null : text, onclick: () => prefill(text) });
      }),
    );
    chips.hidden = next.length === 0;
  };

  async function submit(typed) {
    const text = (typed ?? input.value).trim();
    if (!text || sendButton.disabled) return;
    clearIntro();
    if (typed === undefined) input.value = "";
    log.append(h("div", { class: "message user" }, h("p", { text })));
    const reply = h("div", { class: "message agent" }, h("p", { class: "typing", "aria-label": "The agent is replying" }, h("span"), h("span"), h("span")));
    const results = h("div", { class: "tool-results" });
    const turn = h("div", { class: "turn" }, results, reply);
    log.append(turn);
    scroll();
    sendButton.disabled = true;
    let streamed = "";
    let started = false;
    const write = (value) => {
      started = true;
      reply.replaceChildren(markdown(value));
    };
    const done = () => {
      runId = null;
      sendButton.disabled = false;
      stop.hidden = true;
      stop.disabled = false;
      if (!started) reply.remove();
      onTurnDone?.();
    };
    try {
      runId = await startRun("prompt", { text: prepare ? prepare(text) : text }, (name, data) => {
        switch (name) {
          case "chat.delta":
            streamed += data.text ?? "";
            write(streamed);
            break;
          case "chat.tool": {
            const drawn = toolResult(data);
            if (drawn) results.append(drawn);
            break;
          }
          case "chat.answer":
            write(data.text ?? "");
            if (data.metrics) reply.append(h("p", { class: "message-metrics", text: metricsLine(data.metrics) }));
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
  setSuggestions(suggestions);

  return {
    element: h("section", { class: "chat", "aria-label": "Chat" }, log, chips, h("div", { class: "chat-input" }, input, h("div", { class: "chat-buttons" }, stop, sendButton))),
    prefill,
    send: (text) => submit(text),
    setSuggestions,
    focus: () => input.focus(),
    get busy() {
      return sendButton.disabled;
    },
  };
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The chat in a drawer: a right-hand panel over the page on wide screens, a full-screen sheet on
 * narrow ones. Escape, the close button or the backdrop close it; focus stays inside while it is
 * open and returns to whatever opened it. Closing keeps the conversation.
 * @param {object} options The {@link chatPanel} options, plus:
 * @param {string} [options.title] The drawer's heading, default "Ask the agent".
 * @param {string|Node} [options.note] A line under the heading, e.g. what the chat can't do.
 * @returns {{element: HTMLElement, chat: ReturnType<typeof chatPanel>, open: (options?: {prefill?: string}) => void, close: () => void, readonly isOpen: boolean}}
 */
export function chatDrawer({ title = "Ask the agent", note, ...chatOptions }) {
  const chat = chatPanel(chatOptions);
  const headingId = nextId("drawer");
  let opener = null;
  const closeButton = h("button", { type: "button", class: "button ghost icon-only", "aria-label": "Close chat" }, icon("close"));
  const panel = h(
    "aside",
    { class: "drawer-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": headingId },
    h("header", { class: "drawer-head" }, h("span", { class: "drawer-icon" }, icon("chat")), h("h2", { id: headingId, text: title }), closeButton),
    note ? h("p", { class: "drawer-note muted" }, note) : null,
    chat.element,
  );
  const element = h("div", { class: "drawer", hidden: true }, h("div", { class: "drawer-backdrop", onclick: () => close() }), panel);

  const close = () => {
    if (element.hidden) return;
    element.hidden = true;
    document.documentElement.classList.remove("drawer-open");
    opener?.focus?.();
  };
  const open = ({ prefill } = {}) => {
    opener = document.activeElement;
    element.hidden = false;
    document.documentElement.classList.add("drawer-open");
    if (prefill !== undefined) chat.prefill(prefill);
    else chat.focus();
  };
  closeButton.addEventListener("click", close);
  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter((item) => item.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  return {
    element,
    chat,
    open,
    close,
    get isOpen() {
      return !element.hidden;
    },
  };
}
