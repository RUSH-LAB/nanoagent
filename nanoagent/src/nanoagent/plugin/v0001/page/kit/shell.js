// The page frame: `mountApp` (run by kit/boot.js) connects to the host and shows the tabs every
// plugin has: its Dashboard, and its Session, a chat with the plugin's agent in which each task
// the agent runs shows its result, drawn by kit/result.js or the plugin's renderer.

import { hasHost, on, request } from "./bridge.js";
import { chatPanel } from "./chat.js";
import { applyTheme, h, humanize, icon } from "./dom.js";
import { resultCard, resultsPane } from "./result.js";
import { dashboard, enterSession } from "./session.js";

/** Where `repository`'s folder is on GitHub at the commit the plugin was published from. */
const sourceUrl = ({ owner, repo, commit, path }) => `https://github.com/${owner}/${repo}/tree/${commit}${path ? `/${path}` : ""}`;

/** What changed on GitHub from the commit `from` was published from to `to`'s, or null when they are in different repositories. */
function changesUrl(from, to) {
  if (!from || !to || from.owner !== to.owner || from.repo !== to.repo) return null;
  return `https://github.com/${from.owner}/${from.repo}/compare/${from.commit}...${to.commit}`;
}

/**
 * The version the person runs, with a link to its source when the host names the repository it
 * was published from; and for a plugin the host can update (`latest` names its newest version),
 * Update when that is newer, with what changed since. `plugin.version` asks the host for it, and a
 * host that moves the plugin to another version opens its page again.
 */
function versionControl(plugin) {
  const box = h("div", { class: "app-version" });
  const error = h("span", { class: "error-text small-text", role: "alert" });
  let state = {
    version: plugin.version,
    latest: plugin.latest ?? null,
    repository: plugin.repository ?? null,
    latestRepository: plugin.latestRepository ?? null,
  };

  async function choose(version, control) {
    control.disabled = true;
    error.textContent = "";
    try {
      state = await request("plugin.version", { version });
    } catch (problem) {
      error.textContent = problem.message;
    }
    draw();
  }

  function draw() {
    const current = h("span", { class: "app-version-current", text: `v${state.version}` });
    const source = state.repository
      ? h("a", { class: "button small ghost", href: sourceUrl(state.repository), target: "_blank", rel: "noopener noreferrer", text: "Source on GitHub" })
      : null;
    const behind = state.latest !== null && state.version !== state.latest;
    const update = behind ? h("button", { type: "button", class: "button small primary", text: `Update to v${state.latest}` }) : null;
    update?.addEventListener("click", () => choose(state.latest, update));
    const fresh = state.latest !== null && !behind ? h("span", { class: "muted small-text", text: "Up to date" }) : null;
    const changes = behind ? changesUrl(state.repository, state.latestRepository) : null;
    const news = changes ? h("a", { class: "button small ghost", href: changes, target: "_blank", rel: "noopener noreferrer", text: "What's new" }) : null;
    return box.replaceChildren(...[current, fresh, source, news, update, error].filter(Boolean));
  }

  if (plugin.version) draw();
  return box;
}

/** The plugin's header (its icon, name, tagline and version) over `children`. */
function homePage(plugin, ...children) {
  const header = h(
    "header",
    { class: "app-header" },
    h(
      "div",
      { class: "app-header-inner" },
      h("img", { class: "app-icon", src: plugin.product.icon, alt: "" }),
      h("div", { class: "app-titles" }, h("h1", { text: plugin.name }), h("p", { class: "app-tagline", text: plugin.product.tagline })),
      versionControl(plugin),
    ),
  );
  return h("div", { class: "app" }, header, h("main", { class: "page" }, children));
}

/**
 * A session: a chat with the plugin's agent on the left, and on the right, in two tabs, a turn's
 * provenance graph, streamed in while it runs, and the result of the task picked in the chat. Each of the agent's tools is one of the plugin's tasks, and each task it runs shows
 * as a result card: its output, drawn by the plugin's renderer for its output class or from its
 * JSON Schema, and its verdict. With `closed`, the chat is only read.
 * @returns {{element: HTMLElement, busy: () => boolean}} `busy` is true while its chat is being answered.
 */
function sessionPage(plugin, renderers, closed) {
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
  const chat = chatPanel({ intro, placeholder: `Tell ${plugin.name} what you need`, tasks, show: results.show, trace: results.trace, closed });
  return { element: h("div", { class: "chat-page" }, chat.element, results.element), busy: chat.busy };
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
 * @returns {{element: HTMLElement, select: (tab: "dashboard"|"session") => void, reveal: (tab: string, shown: boolean) => void, onPick: (tab: string) => void}}
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
    reveal(tab, shown) {
      tabs[tab].hidden = !shown;
    },
  };
  return frame;
}

/**
 * Connect to the host and show the page: asks the host to `describe` the plugin, applies its
 * theme (and follows `host.theme`), then shows the Dashboard, where people resume a session or
 * start a new one; for a version the host no longer runs, only resume one, to read it. A session
 * is the chat; the host keeps its conversation, so a resumed session shows it again. A page opened
 * outside a host, or a host that doesn't answer within 10 s, gets a plain message instead.
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

  // A version the host no longer runs (`status` "refused") keeps its sessions to read, and starts none.
  const closed = plugin.status === "refused";
  const tabs = frameTabs();
  const board = dashboard({ onOpen: (opened) => openSession(opened), closed });
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

  // The session pages in the frame: the one shown, and any other still answering a message. The
  // host keeps a turn only once it is answered, so a session left mid-answer and opened again
  // shows its page, still answering, not what the host kept.
  const pages = new Set();
  function openSession(opened) {
    const session = enterSession(opened);
    let shown = opened && [...pages].find((one) => one.session.id === opened.id);
    for (const one of pages) {
      if (one !== shown && !one.busy()) {
        one.element.remove();
        pages.delete(one);
      }
    }
    if (!shown) {
      shown = { session, ...sessionPage(plugin, renderers, closed) };
      pages.add(shown);
      page.append(shown.element);
    }
    for (const one of pages) one.element.hidden = one !== shown;
    open = true;
    tabs.reveal("session", true);
    show("session");
  }

  root.replaceChildren(tabs.element, home, page);
  // With no new session to start, Session shows only once one is opened.
  tabs.reveal("session", !closed);
  show("dashboard");
  board.refresh();
}
