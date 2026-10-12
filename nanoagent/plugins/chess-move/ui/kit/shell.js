// The page frame: `mountApp` (run by kit/boot.js) connects to the host and shows the tabs every
// plugin has, its Dashboard and the open session's page; `appShell` is the header (icon, name,
// tagline, "Ask the agent") over a page with the chat in a drawer; `chatLayout` is the template's
// default page, a full-page chat.

import { hasHost, on, request } from "./bridge.js";
import { chatDrawer, chatPanel } from "./chat.js";
import { applyTheme, h, icon } from "./dom.js";
import { dashboard, enterSession } from "./session.js";

/**
 * A designed page's frame: a header with the plugin's icon, name and tagline, optional controls
 * (`nav`, `actions`), and an "Ask the agent" button opening the chat drawer; under it, the page's
 * own content in `main`. The chat stays one click away but out of the way.
 *
 * @param {object} options
 * @param {object} options.plugin The catalog entry from `describe` (name, product.icon, product.tagline).
 * @param {Node} [options.nav] Shown in the header after the title, e.g. a `segmented` mode switch.
 * @param {Node[]} [options.actions] Header buttons before the chat button.
 * @param {false|object} [options.chat] `false` for no chat; otherwise {@link chatDrawer} options
 *   plus `buttonLabel` (default "Ask the agent"; on narrow screens the button is icon-only).
 * @param {"normal"|"wide"|"narrow"} [options.width] "normal" and "wide" fill the frame; "narrow" caps the content at 760 px.
 * @param {...Node} children The page's content, put in `main`.
 * @returns {{element: HTMLElement, main: HTMLElement, header: HTMLElement, drawer: ReturnType<typeof chatDrawer>|null}}
 */
export function appShell({ plugin, nav, actions = [], chat = {}, width = "normal" }, ...children) {
  const drawer =
    chat === false
      ? null
      : chatDrawer({
          title: chat.title ?? "Ask the agent",
          placeholder: chat.placeholder ?? `Message ${plugin.name}`,
          intro: chat.intro ?? h("div", { class: "chat-intro small" }, h("img", { src: plugin.product.icon, alt: "" }), h("p", { class: "muted", text: `Ask ${plugin.name} anything about what it does.` })),
          ...chat,
        });
  const ask = drawer
    ? h("button", { type: "button", class: "button ask-button", "aria-label": chat.buttonLabel ?? "Ask the agent", onclick: () => drawer.open() }, icon("chat"), h("span", { class: "button-label", text: chat.buttonLabel ?? "Ask the agent" }))
    : null;
  const header = h(
    "header",
    { class: "app-header" },
    h(
      "div",
      { class: "app-header-inner" },
      h("img", { class: "app-icon", src: plugin.product.icon, alt: "" }),
      h("div", { class: "app-titles" }, h("h1", { text: plugin.name }), h("p", { class: "app-tagline", text: plugin.product.tagline })),
      nav ? h("div", { class: "app-nav" }, nav) : null,
      h("div", { class: "app-actions" }, actions, ask),
    ),
  );
  const main = h("main", { class: "page" }, children);
  return { element: h("div", { class: `app width-${width}` }, header, main, drawer?.element), main, header, drawer };
}

/**
 * The template's default layout: the whole page is a chat with the plugin's agent, with its icon,
 * name and tagline until the first message.
 * @param {{plugin: object}} context What {@link mountApp} passes a layout.
 * @returns {HTMLElement}
 */
export function chatLayout({ plugin }) {
  const intro = h("div", { class: "chat-intro" }, h("img", { src: plugin.product.icon, alt: "" }), h("h1", { text: plugin.name }), h("p", { class: "muted", text: plugin.product.tagline }));
  return h("div", { class: "chat-page" }, chatPanel({ intro, placeholder: `Message ${plugin.name}` }).element);
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
 * The tabs over every plugin's page: its Dashboard, and the session open in it.
 * @returns {{element: HTMLElement, show: (tab: "dashboard"|"session") => void, setSession: (title: string) => void, onShow: (tab: string) => void}}
 */
function frameTabs() {
  const tabs = {};
  const bar = h("nav", { class: "kit-tabs", role: "tablist", "aria-label": "Plugin" });
  for (const [id, label] of [["dashboard", "Dashboard"], ["session", "Session"]]) {
    tabs[id] = h("button", { type: "button", class: "kit-tab", role: "tab", "aria-selected": "false", text: label, onclick: () => frame.show(id) });
    bar.append(tabs[id]);
  }
  tabs.session.disabled = true;
  const frame = {
    element: bar,
    onShow: () => {},
    show(tab) {
      for (const [id, button] of Object.entries(tabs)) button.setAttribute("aria-selected", String(id === tab));
      frame.onShow(tab);
    },
    setSession(title) {
      tabs.session.disabled = false;
      tabs.session.textContent = title ? `Session: ${title}` : "Session";
    },
  };
  return frame;
}

/**
 * Connect to the host and show the page: asks the host to `describe` the plugin, applies its
 * theme (and follows `host.theme`), then shows the Dashboard, where people start a session or
 * resume one. Opening one shows `layout({plugin, workspace, session})` under the Session tab;
 * the page saves what it should come back to with `session.save(state)` and finds it again in
 * `session.state`. A page opened outside a host, or a host that doesn't answer within 10 s,
 * gets a plain message instead.
 * @param {(context: {plugin: object, workspace: {id: string}, session: ReturnType<typeof enterSession>}) => Node|Promise<Node>} layout
 *   The page, app.js's default export. It may be async (e.g. to read workspace files first).
 * @returns {Promise<void>}
 */
export async function mountApp(layout) {
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
  document.title = described.plugin.name;
  if (typeof layout !== "function") {
    fatal(root, "This page could not start", "The plugin's app.js must export its page as its default export.");
    return;
  }

  const tabs = frameTabs();
  const board = dashboard({ plugin: described.plugin, onOpen: (opened) => openSession(opened) });
  const home = appShell({ plugin: described.plugin, chat: false }, board.element);
  const page = h("div", { class: "kit-session", hidden: true });
  tabs.onShow = (tab) => {
    home.element.hidden = tab !== "dashboard";
    page.hidden = tab !== "session";
    if (tab === "dashboard") board.refresh();
  };

  async function openSession(opened) {
    const session = enterSession(opened);
    const save = session.save;
    // A title the page gives its session shows on the tab too.
    session.save = (state, options) => {
      if (options?.title !== undefined) tabs.setSession(options.title);
      return save(state, options);
    };
    tabs.setSession(session.title);
    page.replaceChildren(h("div", { class: "loading", role: "status" }, h("span", { class: "run-spinner", "aria-hidden": "true" }), "Opening…"));
    tabs.show("session");
    try {
      page.replaceChildren(await layout({ plugin: described.plugin, workspace: described.workspace, session }));
    } catch (problem) {
      fatal(page, "This session could not open", problem.message);
      throw problem;
    }
  }

  root.replaceChildren(tabs.element, home.element, page);
  tabs.show("dashboard");
}
