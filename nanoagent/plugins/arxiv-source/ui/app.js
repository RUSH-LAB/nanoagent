// The arXiv page: a chat with the plugin's agent. What its tools return is drawn as cards: the
// papers a search found, each with a button to save its source, the sources it saved, and the
// digests it wrote. Design: docs/plans/plugin-ui-arxiv-source.md.
import { chatLayout, copyButton, h, icon, markdown, plural } from "./kit/components.js";

const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const SHOWN = 5;
const AUTHORS = 4;
const LONG = 200; // an abstract longer than this shows two lines and "More"

/** "1706.03762v7" -> "1706.03762". */
const baseId = (id) => id.replace(/v\d+$/, "");
const pdfUrl = (absUrl) => absUrl.replace("/abs/", "/pdf/");

const external = (href, label) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);

function authorLine(authors) {
  if (authors.length <= AUTHORS) return authors.join(", ");
  return `${authors.slice(0, AUTHORS).join(", ")} and ${plural(authors.length - AUTHORS, "other")}`;
}

/** A card's heading row: an icon, a title and a note on the right. */
const head = (name, title, note) => h("header", { class: "result-head" }, icon(name, { size: 16 }), h("h3", { text: title }), note ? h("span", { class: "muted", text: note }) : null);

/** The first `SHOWN` items, and a button that shows the rest. */
function capped(items, draw) {
  const list = h("ol", { class: "paper-list" }, items.slice(0, SHOWN).map(draw));
  if (items.length <= SHOWN) return list;
  const more = h("button", {
    type: "button",
    class: "button ghost small",
    text: `Show ${items.length - SHOWN} more`,
    onclick: () => {
      list.append(...items.slice(SHOWN).map(draw));
      more.remove();
    },
  });
  return h("div", { class: "capped" }, list, more);
}

function abstract(text) {
  if (text.length <= LONG) return h("p", { class: "paper-abstract", text });
  const body = h("p", { class: "paper-abstract clamped", text });
  const toggle = h("button", {
    type: "button",
    class: "link-button",
    text: "More",
    onclick: () => {
      toggle.textContent = body.classList.toggle("clamped") ? "More" : "Less";
    },
  });
  return [body, toggle];
}

function paperItem(paper, { send }) {
  const id = baseId(paper.arxiv_id);
  return h(
    "li",
    { class: "paper" },
    h("h4", { class: "paper-title" }, external(paper.abs_url, paper.title)),
    h("p", { class: "paper-authors", text: authorLine(paper.authors) }),
    h("p", { class: "paper-meta muted" }, h("span", { text: DAY.format(new Date(paper.published)) }), h("span", { class: "paper-id" }, h("code", { text: id }), copyButton({ text: id, iconOnly: true, label: `Copy arXiv id ${id}` }))),
    paper.summary ? abstract(paper.summary) : null,
    h(
      "div",
      { class: "paper-actions" },
      h("button", { type: "button", class: "button small", onclick: () => send(`Save the source of arXiv ${id}.`) }, icon("folder", { size: 14 }), "Save source"),
      external(pdfUrl(paper.abs_url), "PDF"),
      external(paper.abs_url, "Abstract"),
    ),
  );
}

/** A saved folder: its path and, behind a toggle, its files. */
function savedFolder(folder, files) {
  return h("details", { class: "saved-folder" }, h("summary", {}, h("code", { text: folder }), h("span", { class: "muted", text: ` · ${plural(files.length, "file")}` })), h("ul", { class: "file-list" }, files.map((file) => h("li", {}, h("code", { text: file })))));
}

function savedItem(paper) {
  return h("li", { class: "paper" }, h("h4", { class: "paper-title" }, paper.abs_url ? external(paper.abs_url, paper.title) : paper.title), paper.authors ? h("p", { class: "paper-authors", text: authorLine(paper.authors) }) : null, savedFolder(paper.folder, paper.files));
}

const card = (...children) => h("section", { class: "card result-card" }, children);

// One renderer per tool: its output's shape is contract.py's.
const render = {
  search_papers: (data, call) =>
    card(
      head("search", data.papers.length ? `${plural(data.papers.length, "paper")} found` : "No papers found", data.query),
      data.papers.length ? capped(data.papers, (paper) => paperItem(paper, call)) : null,
    ),
  save_search_results: (data) => card(head("folder", `Saved ${plural(data.papers.length, "paper")}`, data.folder), capped(data.papers, savedItem)),
  download_source: (data) => card(head("check", `Saved the source of ${data.arxiv_id}`), savedFolder(data.folder, data.files)),
  save_raw_paper: (data) => card(head("check", "Saved the source"), h("ol", { class: "paper-list" }, savedItem(data))),
  list_daily_papers: (data) =>
    card(
      head("calendar", `New papers on ${DAY.format(new Date(`${data.date}T12:00:00Z`))}`),
      data.people.map((person) => h("div", { class: "person" }, h("h4", { text: `${person.name} · ${plural(person.papers.length, "paper")}` }), person.papers.length ? capped(person.papers, (paper) => h("li", { class: "paper" }, h("h4", { class: "paper-title" }, external(paper.abs_url, paper.title)), h("p", { class: "paper-authors", text: authorLine(paper.authors) }))) : null)),
    ),
  write_digest: (data) => card(head("file", `Digest of ${plural(data.entries, "paper")}`, data.path), h("div", { class: "digest" }, markdown(data.markdown))),
};

export default (context) =>
  chatLayout(context, {
    placeholder: "Describe the papers you want…",
    suggestions: [
      { label: "Find a paper by description", text: "Find the paper that introduced " },
      { label: "Search a topic", text: "Show me this month's newest papers on " },
      { label: "Save a paper's source", text: "Save the source of arXiv " },
      { label: "Daily digest", text: "Write a digest of yesterday's new papers by " },
    ],
    render,
  });
