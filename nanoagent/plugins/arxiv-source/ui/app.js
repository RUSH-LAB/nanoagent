// The arXiv page: Find papers and save their sources, a Daily digest of the people you follow, and
// the Library of what is saved. Chat with the plugin's agent sits in the drawer.
// Design: docs/plans/plugin-ui-arxiv-source.md.
import { appShell, banner, h, jsonStore, listFiles, segmented } from "./kit/components.js";
import { digestView } from "./digest.js";
import { findView } from "./find.js";
import { libraryView, libraryItems } from "./library.js";

const STATE = ".arxiv-source/state.json";
const VIEWS = ["find", "digest", "library"];

/** The workspace's file list, shared by every view and refreshed after each run. */
function filesHub() {
  const listeners = new Set();
  const hub = {
    list: [],
    loaded: false,
    error: null,
    async refresh() {
      try {
        hub.list = await listFiles();
        hub.error = null;
      } catch (problem) {
        hub.error = problem.message;
      }
      hub.loaded = true;
      listeners.forEach((listener) => listener(hub.list));
      return hub.list;
    },
    on(listener) {
      listeners.add(listener);
    },
    has: (prefix) => hub.list.some((file) => file.path.startsWith(prefix)),
  };
  return hub;
}

/** One run at a time on the page: whoever holds it names what it is doing ("Saving 2 of 5"). */
function runLock() {
  const listeners = new Set();
  const lock = {
    holder: null,
    take(label) {
      if (lock.holder) return false;
      lock.holder = label;
      listeners.forEach((listener) => listener(lock.holder));
      return true;
    },
    relabel(label) {
      lock.holder = label;
      listeners.forEach((listener) => listener(lock.holder));
    },
    release() {
      lock.holder = null;
      listeners.forEach((listener) => listener(lock.holder));
    },
    on(listener) {
      listeners.add(listener);
    },
  };
  return lock;
}

async function arxivLayout({ plugin }) {
  const store = jsonStore({ path: STATE, version: 1, initial: { people: [], library: {}, digests: {} } });
  const files = filesHub();
  let unreadable = null;
  let memory = null; // the state while the saved file can't be read (nothing is written)
  const [loaded] = await Promise.allSettled([store.load(), files.refresh()]);
  if (loaded.status === "rejected") {
    unreadable = loaded.reason.message;
    memory = { version: 1, people: [], library: {}, digests: {} };
  }

  const stateBanner = h("div");
  const app = {
    plugin,
    files,
    lock: runLock(),
    state: () => memory ?? store.get(),
    /** Change the page's state and save it (not while the saved file can't be read). */
    save(change) {
      if (memory) {
        change(memory);
        return Promise.resolve(memory);
      }
      return store.update(change).catch((problem) => {
        stateBanner.replaceChildren(banner({ tone: "warn", title: "Your settings couldn't be saved.", body: problem.message }));
      });
    },
    go(view, options) {
      show(view, options);
    },
  };

  const find = findView(app);
  const digest = digestView(app);
  const library = libraryView(app);
  const views = { find, digest, library };

  const tabs = segmented({
    label: "View",
    options: [
      { value: "find", label: "Find" },
      { value: "digest", label: "Daily digest" },
      { value: "library", label: "Library", count: "…" },
    ],
    value: "find",
    onChange: (value) => show(value),
  });
  tabs.element.classList.add("view-tabs");
  const countLibrary = () => tabs.setCounts({ library: files.error ? "!" : String(libraryItems(app).length) });
  files.on(countLibrary);

  const shell = appShell({
    plugin,
    nav: tabs.element,
    width: "normal",
    chat: {
      title: "Ask the arXiv agent",
      buttonLabel: "Ask",
      note: "Find a paper by description, compare what you saved, or ask about a result. Anything it saves shows up in your Library.",
      intro: h("div", { class: "chat-intro small" }, h("img", { src: plugin.product.icon, alt: "" }), h("p", { class: "muted", text: "Ask about papers on arXiv or the ones you saved." })),
      placeholder: "Ask about a paper…",
      suggestions: [
        { label: "Find a paper by description", text: "Find the paper that introduced " },
        { label: "Summarize a saved paper", text: "Summarize the paper saved in papers/" },
        { label: "Newest papers on a topic", text: "What are this week's newest arXiv papers on " },
      ],
      prepare: (text) => {
        const people = app.state().people;
        return `(From the arXiv page: save a paper's source in papers/<arxiv id without version>/ so it shows in my Library.${people.length ? ` I follow: ${people.join(", ")}.` : ""})\n\n${text}`;
      },
      onTurnDone: () => files.refresh(),
    },
  });

  if (unreadable) {
    stateBanner.replaceChildren(
      banner({
        tone: "warn",
        title: "Your saved settings can't be read, so changes aren't being saved.",
        body: `The file ${STATE} isn't in a form this page understands. Your papers are untouched.`,
        details: unreadable,
        actions: [
          h("button", {
            type: "button",
            class: "button small",
            text: "Start fresh",
            onclick: async () => {
              await store.reset();
              memory = null;
              unreadable = null;
              stateBanner.replaceChildren();
              digest.refresh();
            },
          }),
        ],
      }),
    );
  }
  shell.main.append(stateBanner, find.element, digest.element, library.element);

  let current = null;
  function show(view, options = {}) {
    if (!VIEWS.includes(view)) view = "find";
    current = view;
    tabs.set(view);
    for (const [name, one] of Object.entries(views)) one.element.hidden = name !== view;
    // The hash keeps the view across reloads (the opaque-origin frame has no other storage).
    if (location.hash !== `#${view}`) location.hash = view;
    views[view].shown?.(options);
  }
  window.addEventListener("hashchange", () => {
    if (location.hash.slice(1) !== current) show(location.hash.slice(1));
  });
  show(location.hash.slice(1) || "find");
  countLibrary();
  return shell.element;
}

export default arxivLayout;
