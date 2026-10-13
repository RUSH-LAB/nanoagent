// The user's workspace through the bridge: listing, reading and writing files, a JSON state file,
// and the generic files panel. The page has an opaque origin (no localStorage), so whatever it
// should remember lives in the workspace.

import { request } from "./bridge.js";
import { formatSize, h } from "./dom.js";

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/**
 * The workspace's files, sorted by path.
 * @param {{prefix?: string, extensions?: string[]}} [filter] Keep paths starting with `prefix`
 *   and/or ending with one of `extensions` (e.g. `[".bib"]`, case-insensitive).
 * @returns {Promise<Array<{path: string, size: number}>>}
 */
export async function listFiles({ prefix = "", extensions } = {}) {
  const result = await request("workspace.list");
  if (!result || !Array.isArray(result.files)) throw new Error("The host's workspace.list reply has no files list.");
  const endings = extensions?.map((ending) => ending.toLowerCase());
  return result.files
    .filter((file) => file.path.startsWith(prefix) && (!endings || endings.some((ending) => file.path.toLowerCase().endsWith(ending))))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A workspace file as the host sends it: `{text}` for UTF-8 text, otherwise `{base64}`.
 * @param {string} path
 * @returns {Promise<{text?: string, base64?: string}>}
 */
export async function readFile(path) {
  const file = await request("workspace.read", { path });
  if (!file || (typeof file.text !== "string" && typeof file.base64 !== "string")) {
    throw new Error(`The host's workspace.read reply for ${path} has neither text nor base64.`);
  }
  return file;
}

/**
 * A workspace text file's contents; rejects when the file is not UTF-8 text.
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readText(path) {
  const file = await readFile(path);
  if (typeof file.text !== "string") throw new Error(`${path} is not a text file.`);
  return file.text;
}

/**
 * A workspace JSON file, parsed; rejects with a message naming the file when it does not parse.
 * @param {string} path
 * @returns {Promise<unknown>}
 */
export async function readJSON(path) {
  const text = await readText(path);
  try {
    return JSON.parse(text);
  } catch (problem) {
    throw new Error(`${path} is not valid JSON: ${problem.message}`);
  }
}

/**
 * Write (create or replace) a workspace text file.
 * @param {string} path A workspace path such as "inputs/raw.bib".
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeText(path, text) {
  await request("workspace.write", { path, text });
}

/**
 * Write a value as indented JSON (with a final newline).
 * @param {string} path
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJSON(path, value) {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The page's own state, kept whole in one workspace JSON file, e.g. ".my-plugin/state.json".
 *
 * `load()` reads it once: a missing file gives `initial`; a file that does not parse, is not an
 * object, or has another `version` is never overwritten: `load()` rejects, `update()` refuses,
 * until the page calls `reset()` (say, from a "Start fresh" button). Writes are whole-file and
 * serialized, so two quick updates never interleave.
 *
 * @param {{path: string, version?: number, initial: object}} options `version` is stored in the
 *   file and checked on load (default 1).
 * @returns {{load: () => Promise<object>, get: () => object, update: (change: (state: object) => object|void) => Promise<object>, reset: () => Promise<object>}}
 */
export function jsonStore({ path, version = 1, initial }) {
  let state = null;
  let unreadable = null;
  let chain = Promise.resolve();
  const fresh = () => ({ ...structuredClone(initial), version });
  const save = () => {
    const snapshot = JSON.stringify(state, null, 2);
    chain = chain.then(() => writeText(path, `${snapshot}\n`));
    return chain.then(() => state);
  };
  return {
    async load() {
      const files = await listFiles({ prefix: path });
      if (!files.some((file) => file.path === path)) {
        state = fresh();
        return state;
      }
      let value;
      try {
        value = await readJSON(path);
      } catch (problem) {
        unreadable = problem.message;
        throw new Error(`Your saved settings can't be read (${path}): ${problem.message}`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== version) {
        unreadable = `expected an object with version ${version}`;
        throw new Error(`Your saved settings can't be read (${path}): ${unreadable}.`);
      }
      state = value;
      return state;
    },
    get() {
      if (!state) throw new Error(`The state in ${path} is not loaded: call load() first.`);
      return state;
    },
    update(change) {
      if (unreadable) return Promise.reject(new Error(`Not saving over ${path}, which can't be read (${unreadable}). Start fresh to replace it.`));
      if (!state) return Promise.reject(new Error(`The state in ${path} is not loaded: call load() first.`));
      state = change(state) ?? state;
      return save();
    },
    reset() {
      unreadable = null;
      state = fresh();
      return save();
    },
  };
}

/**
 * The generic workspace view: a filterable file list; clicking a file shows it (text, image, or a
 * note for binaries). For developer views and simple pages.
 * @returns {{element: HTMLElement, refresh: () => Promise<Array<{path: string, size: number}>>, open: (path: string) => Promise<void>, files: () => Array<{path: string, size: number}>}}
 */
export function filesPanel() {
  let files = [];
  const list = h("ul", { class: "file-list" });
  const count = h("span", { class: "muted small-text" });
  const filter = h("input", { type: "search", class: "input", placeholder: "Filter files", "aria-label": "Filter files" });
  const viewer = h("div", { class: "viewer", hidden: true });

  const render = () => {
    const needle = filter.value.trim().toLowerCase();
    const shown = files.filter((file) => file.path.toLowerCase().includes(needle));
    count.textContent = files.length ? `${shown.length} of ${files.length}` : "";
    list.replaceChildren(
      ...(files.length ? [] : [h("li", { class: "muted", text: "No files yet." })]),
      ...shown.slice(0, 500).map((file) =>
        h(
          "li",
          {},
          h("button", { type: "button", class: "file", title: file.path, onclick: () => open(file.path) }, h("span", { class: "path", text: file.path }), h("span", { class: "size", text: formatSize(file.size) })),
        ),
      ),
      ...(shown.length > 500 ? [h("li", { class: "muted", text: `${shown.length - 500} more; filter to find them.` })] : []),
    );
  };

  async function refresh() {
    try {
      files = await listFiles();
      render();
    } catch (problem) {
      list.replaceChildren(h("li", { class: "error-text", role: "alert", text: `Could not list the workspace: ${problem.message}` }));
    }
    return files;
  }

  async function open(path) {
    viewer.hidden = false;
    const body = h("div", { class: "viewer-body" }, h("p", { class: "muted", text: "Loading…" }));
    viewer.replaceChildren(
      h("div", { class: "viewer-head" }, h("code", { class: "path", text: path }), h("button", { type: "button", class: "button ghost small", "aria-label": "Close file", text: "Close", onclick: () => (viewer.hidden = true) })),
      body,
    );
    try {
      const file = await readFile(path);
      const extension = path.split(".").pop().toLowerCase();
      if (typeof file.text === "string") body.replaceChildren(h("pre", { text: file.text }));
      else if (IMAGE_TYPES[extension]) body.replaceChildren(h("img", { src: `data:${IMAGE_TYPES[extension]};base64,${file.base64}`, alt: path }));
      else body.replaceChildren(h("p", { class: "muted", text: "A binary file; it is not shown here." }));
    } catch (problem) {
      body.replaceChildren(h("p", { class: "error-text", role: "alert", text: `Could not read ${path}: ${problem.message}` }));
    }
  }

  filter.addEventListener("input", render);
  const element = h(
    "section",
    { class: "card files", "aria-label": "Workspace files" },
    h("div", { class: "section-head" }, h("h2", { text: "Workspace" }), count, h("button", { type: "button", class: "button small", text: "Refresh", onclick: refresh })),
    filter,
    list,
    viewer,
  );
  return { element, refresh, open, files: () => files };
}
