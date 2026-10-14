// The page frame: `mountApp` (run by kit/boot.js) connects to the host and shows the tabs every
// plugin has: its Dashboard, and its Session, a chat with the plugin's agent in which each task
// the agent runs shows its result, drawn by kit/result.js or the plugin's renderer.

import { hasHost, on, request } from "./bridge.js";
import { chatPanel } from "./chat.js";
import { applyTheme, h, humanize, icon } from "./dom.js";
import { resultCard, resultsPane } from "./result.js";
import { dashboard, enterSession } from "./session.js";

/** The plugin's header (its icon, name and tagline) over `children`. */
function homePage(plugin, ...children) {
  const header = h(
    "header",
    { class: "app-header" },
    h(
      "div",
      { class: "app-header-inner" },
      h("img", { class: "app-icon", src: plugin.product.icon, alt: "" }),
      h("div", { class: "app-titles" }, h("h1", { text: plugin.name }), h("p", { class: "app-tagline", text: plugin.product.tagline })),
    ),
  );
  return h("div", { class: "app" }, header, h("main", { class: "page" }, children));
}

/**
 * A session: a chat with the plugin's agent on the left, and on the right the result of the task
 * picked in it. Each of the agent's tools is one of the plugin's tasks, and each task it runs shows
 * as a result card: its output, drawn by the plugin's renderer for its output class or from its
 * JSON Schema, and its verdict.
 */
function sessionPage(plugin, renderers) {
  const results = resultsPane();
  const tasks = Object.fromEntries(
    plugin.tasks.map((task) => [
      task.id,
      { label: humanize(task.id), title: task.description, draw: (result, { send }) => resultCard(task, result, renderers[task.output], send) },
    ]),
  );
  const intro = h(
    "div",
    { class: "chat-intro" },
    h("img", { src: plugin.product.icon, alt: "" }),
    h("h1", { text: plugin.name }),
    h("p", { class: "muted", text: plugin.product.summary }),
  );
  return h("div", { class: "chat-page" }, chatPanel({ intro, placeholder: `Tell ${plugin.name} what you need`, tasks, show: results.show }).element, results.element);
}

/** Why `renderers` (ui/renderers.js's default export) does not fit `plugin`, or null. */
function renderersProblem(renderers, plugin) {
  if (!renderers || typeof renderers !== "object" || Array.isArray(renderers)) {
    return "The plugin's renderers.js must export an object of renderers, one per output class, as its default export.";
  }
  const outputs = new Set(plugin.tasks.map((task) => task.output));
  const unknown = Object.keys(renderers).filter((name) => !outputs.has(name));
  if (unknown.length) return `The plugin's renderers.js draws ${unknown.join(", ")}, which no task outputs.`;
  const broken = Object.keys(renderers).filter((name) => typeof renderers[name] !== "function");
  return broken.length ? `The plugin's renderers.js gives ${broken.join(", ")} a renderer that is not a function.` : null;
}

function fatal(root, title, message) {
  root.replaceChildren(h("div", { class: "fatal", role: "alert" }, icon("alert", { size: 22 }), h("h1", { text: title }), h("p", { text: message })));
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The tabs over every plugin's page: its Dashboard, and its Session, the session open in it or,
 * with none open, a new one.
 * @returns {{element: HTMLElement, select: (tab: "dashboard"|"session") => void, onPick: (tab: string) => void}}
 */
function frameTabs() {
  const tabs = {};
  const bar = h("nav", { class: "kit-tabs", role: "tablist", "aria-label": "Plugin" });
  for (const [id, label] of [["dashboard", "Dashboard"], ["session", "Session"]]) {
    tabs[id] = h("button", { type: "button", class: "kit-tab", role: "tab", "aria-selected": "false", text: label, onclick: () => frame.onPick(id) });
    bar.append(tabs[id]);
  }
  const frame = {
    element: bar,
    onPick: () => {},
    select(tab) {
      for (const [id, button] of Object.entries(tabs)) button.setAttribute("aria-selected", String(id === tab));
    },
  };
  return frame;
}

/**
 * Connect to the host and show the page: asks the host to `describe` the plugin, applies its
 * theme (and follows `host.theme`), then shows the Dashboard, where people resume a session or
 * start a new one. A session is the chat; the host keeps its conversation, so a resumed session
 * shows it again. A page opened outside a host, or a host that doesn't answer within 10 s, gets a
 * plain message instead.
 * @param {Record<string, (value: unknown, context: {task: object, verdict: object, send: (text: string) => void}) => Node>} renderers
 *   ui/renderers.js's default export: a renderer per output class name.
 */
export async function mountApp(renderers) {
  const root = document.getElementById("app");
  if (!hasHost()) {
    fatal(root, "Open this page from Mochi", "This is a plugin's page. It runs inside the app that hosts the plugin, which connects it to its agent and your files.");
    return;
  }
  root.replaceChildren(h("div", { class: "loading", role: "status" }, h("span", { class: "run-spinner", "aria-hidden": "true" }), "Connecting…"));
  let described;
  try {
    described = await withTimeout(request("describe"), 10000, "The host did not answer within 10 seconds. Reload the page to try again.");
    if (!described || !described.plugin) throw new Error("The host's describe reply has no plugin.");
    applyTheme(described.theme);
  } catch (problem) {
    fatal(root, "This page could not start", problem.message);
    return;
  }
  on("host.theme", (data) => applyTheme(data.theme));
  const { plugin } = described;
  document.title = plugin.name;
  const problem = renderersProblem(renderers, plugin);
  if (problem) {
    fatal(root, "This page could not start", problem);
    return;
  }

  const tabs = frameTabs();
  const board = dashboard({ onOpen: (opened) => openSession(opened) });
  const home = homePage(plugin, board.element);
  const page = h("div", { class: "kit-session", hidden: true });
  let open = false;
  function show(tab) {
    tabs.select(tab);
    home.hidden = tab !== "dashboard";
    page.hidden = tab !== "session";
  }
  tabs.onPick = (tab) => {
    if (tab === "session" && !open) {
      openSession(null);
      return;
    }
    show(tab);
    if (tab === "dashboard") board.refresh();
  };

  function openSession(opened) {
    enterSession(opened);
    open = true;
    page.replaceChildren(sessionPage(plugin, renderers));
    show("session");
  }

  root.replaceChildren(tabs.element, home, page);
  show("dashboard");
  board.refresh();
}
