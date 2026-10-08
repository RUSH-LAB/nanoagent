// Library: every saved paper folder (papers/… from Find or chat, docs/raw/… from digests), its
// files, and a viewer for them.
import { banner, emptyState, formatSize, h, icon, plural, readFile, readJSON, readText, skeleton } from "./kit/components.js";
import { formatShortDay, isPdf, mainFile } from "./arxiv.js";

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const RAW = /-(\d{4}\.\d{5})-(\d{4}-\d{2}-\d{2})$/;
const MAX_LINES = 5000;

/** The saved paper folders: from the workspace files, with what the page's index knows about each. */
export function libraryItems(app) {
  const records = new Map(Object.entries(app.state().library).map(([id, record]) => [record.folder, { id, ...record }]));
  const items = new Map();
  const add = (folder, kind, file) => {
    if (!items.has(folder)) items.set(folder, { folder, kind, files: [], record: records.get(folder) ?? null });
    items.get(folder).files.push(file);
  };
  for (const file of app.files.list) {
    const paper = file.path.match(/^(papers\/[^/]+)\//);
    const raw = file.path.match(/^(docs\/raw\/[^/]+)\//);
    if (paper) add(paper[1], "paper", file);
    else if (raw) add(raw[1], "digest", file);
    else for (const folder of records.keys()) if (file.path.startsWith(`${folder}/`)) add(folder, "paper", file);
  }
  for (const item of items.values()) {
    const name = item.folder.split("/").pop();
    const raw = item.kind === "digest" ? name.match(RAW) : null;
    item.id = item.record?.id ?? raw?.[1] ?? name.replace("_", "/");
    item.date = raw?.[2] ?? null;
    item.size = item.files.reduce((sum, file) => sum + file.size, 0);
  }
  return [...items.values()];
}

/** The folder holding a paper's saved source, or null: the page's own folder, an index entry, or a chat's versioned folder. */
export function savedFolder(app, folder, id) {
  const known = app.state().library[id]?.folder;
  for (const candidate of [folder, known, `papers/${id.replace("/", "_")}`].filter(Boolean)) {
    if (app.files.has(`${candidate}/`)) return candidate;
  }
  const versioned = app.files.list.find((file) => file.path.match(/^papers\/([^/]+)\//)?.[1].replace(/v\d+$/, "") === id.replace("/", "_"));
  return versioned ? versioned.path.split("/").slice(0, 2).join("/") : null;
}

export function libraryView(app) {
  const digests = new Map(); // date -> digest entries, for the titles of docs/raw folders
  const mains = new Map(); // folder -> main file (relative), or "" when there is none
  const expanded = new Set();
  let openPath = null;

  const filter = h("input", { type: "search", class: "input", placeholder: "Filter by title, author, id or file", "aria-label": "Filter saved papers" });
  const summary = h("span", { class: "muted small-text library-summary", "aria-live": "polite" });
  const refreshButton = h("button", { type: "button", class: "button small", onclick: () => app.files.refresh() }, icon("refresh", { size: 15 }), h("span", { text: "Refresh" }));
  const list = h("div", { class: "library-list" });
  const viewer = h("section", { class: "card viewer-card", hidden: true, "aria-label": "File viewer" });
  const grid = h("div", { class: "library-grid" }, list, viewer);
  const element = h("section", { class: "view library-view", "aria-label": "Library" }, h("div", { class: "library-tools" }, h("div", { class: "filter-box" }, icon("search", { size: 16 }), filter), summary, refreshButton), grid);

  const titleOf = (item) => {
    if (item.record?.title) return item.record.title;
    const entry = item.date ? digests.get(item.date)?.find((one) => one.arxiv_id === item.id) : null;
    return entry?.title ?? `arXiv ${item.id}`;
  };
  const authorsOf = (item) => item.record?.authors ?? (item.date ? digests.get(item.date)?.find((one) => one.arxiv_id === item.id)?.authors : null) ?? [];

  async function loadDigests() {
    const dates = new Set(libraryItems(app).map((item) => item.date).filter(Boolean));
    await Promise.all(
      [...dates].filter((date) => !digests.has(date)).map(async (date) => {
        try {
          digests.set(date, (await readJSON(`docs/digest-${date}.json`)).entries ?? []);
        } catch {
          digests.set(date, []); // a folder without its digest keeps its folder name as its title
        }
      }),
    );
  }

  async function findMain(item) {
    if (mains.has(item.folder)) return;
    const root = item.files.map((file) => file.path.slice(item.folder.length + 1)).filter((rel) => !rel.includes("/"));
    let main = mainFile(root);
    if (!main) {
      for (const name of root.filter((one) => one.toLowerCase().endsWith(".tex"))) {
        try {
          if ((await readText(`${item.folder}/${name}`)).includes("\\documentclass")) {
            main = name;
            break;
          }
        } catch {
          // not text: it is not the main LaTeX file
        }
      }
    }
    mains.set(item.folder, main ?? "");
    render();
  }

  function itemCard(item) {
    const open = expanded.has(item.folder);
    const authors = authorsOf(item);
    const year = item.record?.published?.slice(0, 4) || null;
    const meta = [authors.length ? (authors.length > 2 ? `${authors[0]} et al.` : authors.join(" and ")) : null, item.kind === "digest" ? `From the ${formatShortDay(item.date)} digest` : year].filter(Boolean).join(" · ");
    const head = h(
      "button",
      { type: "button", class: "lib-head", "aria-expanded": String(open), onclick: () => toggle(item) },
      h("span", { class: "lib-chevron" }, icon("chevron", { size: 16 })),
      h("span", { class: "lib-titles" }, h("span", { class: "lib-title", text: titleOf(item) }), meta ? h("span", { class: "lib-meta muted", text: meta }) : null, h("span", { class: "lib-path muted" }, h("code", { text: `${item.folder}/` }), ` · ${plural(item.files.length, "file")} · ${formatSize(item.size)}`)),
    );
    const main = mains.get(item.folder);
    const tree = open
      ? h(
          "ul",
          { class: "file-tree" },
          item.files.map((file) => {
            const rel = file.path.slice(item.folder.length + 1);
            const slash = rel.lastIndexOf("/");
            return h(
              "li",
              {},
              h(
                "button",
                { type: "button", class: `tree-file${file.path === openPath ? " current" : ""}`, "aria-current": file.path === openPath ? "true" : null, onclick: () => openFile(file.path, item) },
                icon("file", { size: 15 }),
                h("span", { class: "tree-name" }, slash >= 0 ? h("span", { class: "muted", text: rel.slice(0, slash + 1) }) : null, rel.slice(slash + 1)),
                rel === main ? h("span", { class: "pill tone-info", text: "main" }) : null,
                h("span", { class: "tree-size muted", text: formatSize(file.size) }),
              ),
            );
          }),
        )
      : null;
    return h("article", { class: `lib-item${open ? " open" : ""}`, "data-folder": item.folder }, head, tree);
  }

  function toggle(item) {
    if (expanded.has(item.folder)) expanded.delete(item.folder);
    else {
      expanded.add(item.folder);
      findMain(item);
    }
    render();
  }

  function render() {
    if (app.files.error) {
      summary.textContent = "";
      list.replaceChildren(banner({ tone: "bad", title: "Couldn't list your saved papers.", body: app.files.error, actions: [h("button", { type: "button", class: "button small", text: "Retry", onclick: () => app.files.refresh() })] }));
      return;
    }
    if (!app.files.loaded) {
      list.replaceChildren(skeleton({ lines: 4 }));
      return;
    }
    const items = libraryItems(app);
    if (!items.length) {
      summary.textContent = "";
      viewer.hidden = true;
      grid.classList.remove("viewing");
      list.replaceChildren(
        h(
          "div",
          { class: "card" },
          emptyState({
            icon: "folder",
            title: "Nothing saved yet",
            body: "Search for a paper and press Save source, or write a daily digest. Saved sources show up here, one folder per paper.",
            actions: [h("button", { type: "button", class: "button primary", text: "Find a paper", onclick: () => app.go("find") }), h("button", { type: "button", class: "button", text: "Write a digest", onclick: () => app.go("digest") })],
          }),
        ),
      );
      return;
    }
    const needle = filter.value.trim().toLowerCase();
    const shown = items.filter((item) => !needle || [titleOf(item), ...authorsOf(item), item.id, item.folder, ...item.files.map((file) => file.path)].join("\n").toLowerCase().includes(needle));
    const total = items.reduce((sum, item) => sum + item.size, 0);
    summary.textContent = needle ? `${shown.length} of ${plural(items.length, "paper")}` : `${plural(items.length, "paper")} · ${formatSize(total)}`;
    const group = (title, kind) => {
      const members = shown.filter((item) => item.kind === kind).sort((a, b) => (b.date ?? b.record?.savedAt ?? "").localeCompare(a.date ?? a.record?.savedAt ?? "") || titleOf(a).localeCompare(titleOf(b)));
      return members.length ? h("section", { class: "lib-group" }, h("h2", { class: "lib-group-title" }, title, h("span", { class: "muted", text: ` ${members.length}` })), members.map(itemCard)) : null;
    };
    list.replaceChildren(...[group("Saved papers", "paper"), group("From digests", "digest")].filter(Boolean));
    if (!shown.length) list.replaceChildren(h("p", { class: "muted lib-none", text: `No saved paper matches “${filter.value.trim()}”.` }));
  }

  function closeViewer() {
    openPath = null;
    viewer.hidden = true;
    grid.classList.remove("viewing");
    render();
  }

  async function openFile(path, item) {
    openPath = path;
    grid.classList.add("viewing");
    render();
    const rel = path.slice(item.folder.length + 1);
    const label = h("span", { class: "viewer-label muted small-text" });
    const body = h("div", { class: "viewer-body" }, skeleton({ lines: 6 }));
    viewer.hidden = false;
    viewer.replaceChildren(
      h(
        "header",
        { class: "viewer-head" },
        h("button", { type: "button", class: "button ghost small viewer-back", onclick: closeViewer }, h("span", { class: "flip" }, icon("chevron", { size: 15 })), h("span", { text: "Library" })),
        h("div", { class: "viewer-titles" }, h("span", { class: "viewer-paper", text: titleOf(item) }), h("code", { class: "viewer-path", text: rel })),
        h("button", { type: "button", class: "button ghost icon-only small viewer-close", "aria-label": "Close file", onclick: closeViewer }, icon("close", { size: 16 })),
      ),
      label,
      body,
    );
    if (window.matchMedia("(max-width: 880px)").matches) viewer.scrollIntoView({ block: "start" });
    const size = item.files.find((file) => file.path === path)?.size ?? 0;
    try {
      const file = await readFile(path);
      if (openPath !== path) return;
      const extension = path.split(".").pop().toLowerCase();
      if (typeof file.text === "string") {
        const lines = file.text.split("\n");
        label.textContent = `${plural(lines.length, "line")} · ${formatSize(size)}`;
        body.replaceChildren(h("pre", { class: "code-view" }, h("code", {}, lines.slice(0, MAX_LINES).map((line) => h("span", { class: "line" }, line, "\n")))));
        if (lines.length > MAX_LINES) body.append(h("p", { class: "muted small-text", text: `Showing the first ${MAX_LINES} lines.` }));
      } else if (IMAGE_TYPES[extension]) {
        label.textContent = `Image · ${formatSize(size)}`;
        body.replaceChildren(h("img", { class: "viewer-image", src: `data:${IMAGE_TYPES[extension]};base64,${file.base64}`, alt: rel }));
      } else if (isPdf(file)) {
        const pdfAsTex = extension !== "pdf";
        label.textContent = pdfAsTex ? `PDF (saved as ${rel}) · ${formatSize(size)}` : `PDF · ${formatSize(size)}`;
        body.replaceChildren(emptyState({ icon: "file", title: pdfAsTex ? "arXiv has only a PDF for this paper" : "A PDF file", body: pdfAsTex ? `There is no LaTeX source, so arXiv's PDF was saved as ${rel}. It isn't shown here.` : "PDFs aren't shown here; open it from your workspace." }));
      } else {
        label.textContent = formatSize(size);
        body.replaceChildren(emptyState({ icon: "file", title: "A binary file", body: "It isn't shown here." }));
      }
    } catch (problem) {
      if (openPath !== path) return;
      body.replaceChildren(banner({ tone: "bad", title: `Couldn't open ${rel}.`, body: problem.message, actions: [h("button", { type: "button", class: "button small", text: "Try again", onclick: () => openFile(path, item) })] }));
    }
  }

  filter.addEventListener("input", render);
  app.files.on(async () => {
    digests.clear(); // a digest may have been rewritten
    await loadDigests();
    render();
  });

  return {
    element,
    async shown({ folder } = {}) {
      await loadDigests();
      if (folder) {
        expanded.add(folder);
        filter.value = "";
      }
      render();
      const item = folder ? libraryItems(app).find((one) => one.folder === folder) : null;
      if (!item) return;
      await findMain(item);
      list.querySelector(`[data-folder="${CSS.escape(folder)}"]`)?.scrollIntoView({ block: "nearest" });
      const main = mains.get(folder);
      if (main) openFile(`${folder}/${main}`, item);
    },
  };
}
