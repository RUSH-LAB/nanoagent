// Find: search arXiv in plain words (or paste an id or link), tick papers and save their sources,
// one run at a time; or describe a paper and let the agent find and save it.
import { actionBar, announce, banner, copyButton, disclosure, errorCard, explainError, formatDuration, h, icon, parseToolOutput, plural, readFile, segmented, taskRun } from "./kit/components.js";
import { ERROR_RULES, FIELDS, SUBJECTS, baseId, buildQuery, formatDay, isPdf, paperFolder, parseId } from "./arxiv.js";
import { savedFolder } from "./library.js";

// arXiv asks for 3 s between requests; each save is one request.
const PAUSE_MS = 3000;
const TYPICAL_SAVE_S = 6;
const EXAMPLES = [
  { label: "Attention Is All You Need", value: { text: "Attention Is All You Need", field: "ti", subject: "" } },
  { label: "Author: Yann LeCun", value: { text: "Yann LeCun", field: "au", subject: "" } },
  { label: "Topic: diffusion models, Computer Vision", value: { text: "diffusion models", field: "all", subject: "cs.CV" } },
];
const AUTHORS_SHOWN = 3;
const ABSTRACT_CLAMP = 240;

const https = (url) => url.replace(/^http:\/\//, "https://");

export function findView(app) {
  let mode = "search";
  let results = null; // {typed, papers, id}
  let order = "best";
  let ownQuery = false;
  let queueRunning = false;
  let stopping = false;
  let wake = null;
  const selected = new Set(); // base ids
  const jobs = new Map(); // base id -> {state: "queued"|"saving"|"failed", text, raw}
  const expandedAuthors = new Set();
  const expandedAbstracts = new Set();
  const queue = [];
  const batch = { total: 0, done: 0, seconds: [] };

  const searchRun = taskRun({ task: "search-papers" });
  const saveRun = taskRun({ task: "save-paper-source" });

  // ---------------------------------------------------------------- search bar and filters
  const input = h("input", { type: "search", class: "search-input", placeholder: "Title, author, topic, arXiv id or link", "aria-label": "Search arXiv", autocomplete: "off", enterkeyhint: "search" });
  const searchLabel = h("span", { text: "Search" });
  const searchButton = h("button", { type: "submit", class: "button primary search-button" }, h("span", { class: "button-spinner", hidden: true, "aria-hidden": "true" }), searchLabel);
  const bar = h("form", { class: "search-bar", role: "search" }, h("span", { class: "search-icon" }, icon("search", { size: 20 })), input, searchButton);
  const barNote = h("p", { class: "bar-note muted small-text", hidden: true, "aria-live": "polite" });

  const field = segmented({ label: "Look in", options: FIELDS, value: "all", look: "chips", onChange: sync });
  const subject = h("select", { class: "input select-compact", "aria-label": "Subject", onchange: sync }, SUBJECTS.map((one) => h("option", { value: one.value, text: one.label })));
  const count = h("select", { class: "input select-compact", "aria-label": "How many results", onchange: sync }, [10, 25, 50].map((n) => h("option", { value: String(n), text: `${n} results` })));
  const advancedBox = h("textarea", { class: "input code", rows: 2, spellcheck: false, "aria-label": "arXiv query" });
  const ownNote = h("p", { class: "own-note small-text", hidden: true }, icon("info", { size: 15 }), h("span", { text: "Using your own query; the words and filters above don't change it." }), h("button", { type: "button", class: "button ghost small", text: "Use my words instead", onclick: () => ((ownQuery = false), sync()) }));
  const advanced = disclosure(
    { summary: "Advanced: the arXiv query", className: "advanced" },
    advancedBox,
    h("p", { class: "hint" }, "arXiv search syntax, e.g. ", h("code", { text: "au:vaswani AND cat:cs.CL" }), ". Edit it to search exactly that."),
    ownNote,
  );
  const describeLink = h("button", { type: "button", class: "link-button", onclick: () => setMode("describe") }, "Can't remember the title? Describe the paper", icon("chevron", { size: 15 }));
  const filtersSummary = h("span", { class: "muted" });
  const filtersToggle = h("button", { type: "button", class: "button ghost small filters-toggle", "aria-expanded": "false" }, h("span", { text: "Filters" }), filtersSummary, icon("chevron", { size: 15 }));
  const filters = h(
    "div",
    { class: "filters" },
    h("div", { class: "filter-group" }, h("span", { class: "filter-label", text: "Look in" }), field.element),
    h("div", { class: "filter-group" }, h("span", { class: "filter-label", text: "Subject" }), subject),
    h("div", { class: "filter-group" }, h("span", { class: "filter-label", text: "Show" }), count),
  );
  filtersToggle.addEventListener("click", () => {
    const open = !filters.classList.contains("open");
    filters.classList.toggle("open", open);
    filtersToggle.setAttribute("aria-expanded", String(open));
  });
  const searchCard = h("section", { class: "card search-card", "aria-label": "Search arXiv" }, bar, barNote, filtersToggle, filters, h("div", { class: "search-foot" }, advanced, describeLink));

  // ---------------------------------------------------------------- describe mode (agent)
  let candidates = new Map();
  let picked = null; // the paper the agent saved, shown in pickedList
  const pickedList = h("ol", { class: "paper-list" });
  const describeBox = h("textarea", { class: "input describe-box", rows: 3, placeholder: "e.g. the 2017 Google paper that introduced the Transformer", "aria-label": "Describe the paper" });
  const describeButton = h("button", { type: "button", class: "button primary large", text: "Find and save" });
  const describeReason = h("p", { class: "run-reason", hidden: true });
  const describeRun = taskRun({
    task: "find-and-save-paper",
    title: "Finding the paper you described",
    steps: [
      { id: "search", label: "Searching arXiv" },
      { id: "pick", label: "Picking the paper that matches" },
      { id: "save", label: "Saving its source" },
      { id: "check", label: "Checking the saved files" },
    ],
    onEvent: (name, data, run) => {
      if (name === "task.started") run.step("search");
      if (name === "task.answer") run.step("check");
      if (name !== "task.tool") return;
      const out = parseToolOutput(data.output);
      if (data.name === "search_papers") {
        if (data.isError || !out) return run.note("A search didn't work; the agent is trying again.", { step: "search", tone: "warn" });
        for (const paper of out.papers ?? []) candidates.set(baseId(paper.arxiv_id), paper);
        run.step("search", { state: "done", detail: `${plural(candidates.size, "candidate")} so far` });
        run.step("pick");
      } else if (data.name === "download_source") {
        const id = baseId(String(data.arguments?.arxiv_id ?? ""));
        if (data.isError || !out) return run.note(`Couldn't save ${id}: ${explainError(data.output, ERROR_RULES).text}`, { step: "save", tone: "warn" });
        run.step("save", { state: "done", detail: `“${candidates.get(id)?.title ?? id}” · ${plural(out.files?.length ?? 0, "file")}` });
        run.step("check");
      }
    },
  });
  const describeResult = h("div", { class: "stack describe-result" });
  const describeCard = h(
    "section",
    { class: "card describe-card", hidden: true, "aria-label": "Describe the paper" },
    h("div", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", { text: "Describe the paper" }), h("p", { class: "muted", text: "The agent searches arXiv, picks the paper that fits best and saves its source." })), h("button", { type: "button", class: "button ghost small", onclick: () => setMode("search") }, icon("search", { size: 15 }), h("span", { text: "Back to search" }))),
    describeBox,
    h("div", { class: "run-button" }, describeButton, describeReason, h("p", { class: "muted small-text", text: "Usually under a minute." })),
  );

  // ---------------------------------------------------------------- results
  const heading = h("h2", { class: "results-title" });
  const sort = segmented({ label: "Sort", options: [{ value: "best", label: "Best match" }, { value: "new", label: "Newest" }], value: "best", onChange: (value) => ((order = value), render()) });
  const selectAll = h("input", { type: "checkbox", onchange: () => toggleAll(selectAll.checked) });
  const headRow = h("div", { class: "results-head" }, heading, h("div", { class: "results-tools" }, h("label", { class: "check select-all" }, selectAll, "Select all"), sort.element));
  const list = h("ol", { class: "paper-list", "aria-label": "Papers" });
  const message = h("div", { class: "results-message" });
  const intro = introCard();
  const resultsWrap = h("section", { class: "results", "aria-label": "Results" }, headRow, list);

  const queueText = h("span", { class: "queue-text" });
  const queueStop = h("button", { type: "button", class: "button small", onclick: stopQueue }, icon("stop", { size: 15 }), h("span", { text: "Stop" }));
  const queueBar = h("div", { class: "card queue-bar", hidden: true, role: "status" }, h("span", { class: "run-spinner", "aria-hidden": "true" }), queueText, queueStop);

  const selectedText = h("span", { class: "selected-text" });
  const saveSelected = h("button", { type: "button", class: "button primary", onclick: () => enqueue(currentPapers().filter((paper) => selected.has(baseId(paper.arxiv_id)))) });
  const selectionBar = actionBar({ sticky: "always" }, selectedText, h("button", { type: "button", class: "button ghost", text: "Clear", onclick: () => (selected.clear(), render()) }), saveSelected);
  selectionBar.classList.add("selection-bar");

  const element = h("section", { class: "view find-view", "aria-label": "Find papers" }, searchCard, describeCard, describeRun.element, describeResult, queueBar, message, intro, resultsWrap, selectionBar);

  // ---------------------------------------------------------------- behaviour
  function sync() {
    const text = input.value.trim();
    if (!ownQuery) {
      const id = parseId(text);
      advancedBox.value = !text ? "" : id ? `id:${baseId(id)}` : buildQuery(text, field.value(), subject.value);
    }
    ownNote.hidden = !ownQuery;
    const parts = [FIELDS.find((one) => one.value === field.value()).label, subject.value ? subject.selectedOptions[0].textContent : null, count.value].filter(Boolean);
    filtersSummary.textContent = parts.join(", ");
    const id = !ownQuery && parseId(text);
    barNote.hidden = !id && !(field.value() !== "all" && text.includes('"'));
    barNote.textContent = id ? `Looks like an arXiv id: this finds ${baseId(id)}.` : "Quotation marks are left out of the search.";
    updateButtons();
  }

  function updateButtons() {
    const busyElsewhere = app.lock.holder && !searchRun.busy;
    searchButton.disabled = searchRun.busy ? false : !input.value.trim() || Boolean(busyElsewhere) || (ownQuery && !advancedBox.value.trim());
    searchButton.title = busyElsewhere ? `Busy: ${app.lock.holder}` : "";
    searchLabel.textContent = searchRun.busy ? "Stop" : "Search";
    searchButton.classList.toggle("primary", !searchRun.busy);
    searchButton.firstChild.hidden = !searchRun.busy;
    const describeBusy = describeRun.busy;
    const reason = describeBusy ? null : app.lock.holder ? `Busy: ${app.lock.holder}.` : !describeBox.value.trim() ? "Describe the paper first." : null;
    describeButton.disabled = describeBusy || Boolean(reason);
    describeReason.textContent = reason ?? "";
    describeReason.hidden = !reason || (!describeBox.value.trim() && !app.lock.holder);
    describeBox.disabled = describeBusy;
  }

  function setMode(next) {
    mode = next;
    searchCard.hidden = mode !== "search";
    describeCard.hidden = mode !== "describe";
    describeRun.element.hidden = mode !== "describe" || !describeRun.element.dataset.used;
    describeResult.hidden = mode !== "describe";
    render();
    (mode === "describe" ? describeBox : input).focus();
  }

  function introCard() {
    const examples = h(
      "div",
      { class: "chips examples", role: "group", "aria-label": "Example searches" },
      EXAMPLES.map((example) => h("button", { type: "button", class: "chip", onclick: () => useExample(example.value) }, icon("search", { size: 14 }), example.label)),
    );
    return h(
      "section",
      { class: "card intro-card", "aria-label": "Getting started" },
      h("h2", { text: "Find a paper and keep its LaTeX source" }),
      h("p", { class: "muted", text: "Type what you remember. Tick the papers you want and save them: each source lands in your workspace, one folder per paper." }),
      h("div", { class: "intro-try" }, h("span", { class: "filter-label", text: "Try" }), examples),
      h("ul", { class: "highlights" }, app.plugin.product.highlights.map((line) => h("li", {}, h("span", { class: "highlight-mark" }, icon("check", { size: 14 })), line))),
    );
  }

  function useExample({ text, field: where, subject: topic }) {
    input.value = text;
    field.set(where);
    subject.value = topic;
    ownQuery = false;
    sync();
    search();
  }

  function currentPapers() {
    if (!results) return [];
    const papers = [...results.papers];
    if (order === "new") papers.sort((a, b) => b.published.localeCompare(a.published));
    return papers;
  }

  const folderOf = (paper) => savedFolder(app, paperFolder(paper.arxiv_id), baseId(paper.arxiv_id));
  const selectable = (paper) => !folderOf(paper) && !["queued", "saving"].includes(jobs.get(baseId(paper.arxiv_id))?.state);

  function toggleAll(on) {
    for (const paper of currentPapers()) {
      const id = baseId(paper.arxiv_id);
      if (on && selectable(paper)) selected.add(id);
      else selected.delete(id);
    }
    render();
  }

  async function search() {
    if (searchRun.busy) return searchRun.cancel();
    const text = input.value.trim();
    if (!text || !app.lock.take("searching arXiv")) return;
    const id = ownQuery ? null : parseId(text);
    const query = ownQuery ? advancedBox.value.trim() : id ? `id:${baseId(id)}` : buildQuery(text, field.value(), subject.value);
    resultsWrap.classList.add("dim");
    resultsWrap.setAttribute("aria-busy", "true");
    updateButtons();
    const outcome = await searchRun.start({ query, max_results: id ? 1 : Number(count.value) });
    app.lock.release();
    resultsWrap.classList.remove("dim");
    resultsWrap.removeAttribute("aria-busy");
    message.replaceChildren();
    if (outcome.status === "cancelled") {
      message.replaceChildren(banner({ tone: "neutral", title: "Search stopped." }));
    } else if (outcome.status === "error") {
      message.replaceChildren(errorCard({ message: outcome.error, rules: ERROR_RULES, title: outcome.startFailed ? "Couldn't start the search." : undefined, actions: [h("button", { type: "button", class: "button small", text: "Try again", onclick: search })] }));
    } else {
      let papers = outcome.result?.papers ?? [];
      if (id) papers = papers.filter((paper) => baseId(paper.arxiv_id) === baseId(id)).map((paper) => ({ ...paper, saveId: /v\d+$/.test(id) ? id : paper.arxiv_id }));
      results = { typed: text, papers, id };
      selected.clear();
      expandedAuthors.clear();
      expandedAbstracts.clear();
      if (!papers.length) message.replaceChildren(noResults(text, id));
      announce(`${plural(papers.length, "paper")} found`);
    }
    render();
  }

  function noResults(text, id) {
    if (id) return banner({ tone: "neutral", title: `arXiv has no paper with id ${id}.`, body: "Check the id, or search by its title instead." });
    const actions = field.value() !== "all" || subject.value ? [h("button", { type: "button", class: "button small", text: "Search anywhere, any subject", onclick: () => (field.set("all"), (subject.value = ""), sync(), search()) })] : [];
    return banner({ tone: "neutral", title: `No papers match “${text}”.`, body: "Try fewer words, Anywhere instead of Title, or another subject.", actions });
  }

  // ---------------------------------------------------------------- saving, one run at a time
  function enqueue(papers) {
    const fresh = papers.filter(selectable);
    if (!fresh.length || (app.lock.holder && !queueRunning)) return;
    for (const paper of fresh) {
      const id = baseId(paper.arxiv_id);
      jobs.set(id, { state: "queued" });
      selected.delete(id);
      queue.push(paper);
    }
    batch.total += fresh.length;
    if (!queueRunning) runQueue();
    else updateQueue();
    render();
  }

  const pause = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  function updateQueue() {
    queueBar.hidden = !queueRunning;
    if (!queueRunning) return;
    const left = batch.total - batch.done;
    const typical = batch.seconds.length ? batch.seconds.reduce((a, b) => a + b, 0) / batch.seconds.length : TYPICAL_SAVE_S;
    const estimate = left * typical + Math.max(0, left - 1) * (PAUSE_MS / 1000);
    const position = `${Math.min(batch.done + 1, batch.total)} of ${batch.total}`;
    queueText.textContent = batch.total === 1 ? "Saving the source…" : left > 1 ? `Saving ${position} · about ${formatDuration(estimate)} left` : `Saving ${position}, the last one…`;
    app.lock.relabel(batch.total === 1 ? "saving a source" : `saving ${Math.min(batch.done + 1, batch.total)} of ${batch.total}`);
  }

  async function runQueue() {
    queueRunning = true;
    stopping = false;
    app.lock.take("saving sources");
    while (queue.length && !stopping) {
      const paper = queue.shift();
      const id = baseId(paper.arxiv_id);
      jobs.set(id, { state: "saving" });
      updateQueue();
      render();
      const destination = paperFolder(paper.arxiv_id);
      const outcome = await saveRun.start({ arxiv_id: paper.saveId ?? paper.arxiv_id, destination });
      batch.done += 1;
      batch.seconds.push(outcome.seconds);
      if (outcome.result && (outcome.status === "valid" || outcome.status === "unchecked")) {
        const files = outcome.result.files ?? [];
        let pdfOnly = false;
        if (files.length === 1 && files[0] === "main.tex") {
          try {
            pdfOnly = isPdf(await readFile(`${destination}/main.tex`));
          } catch {
            pdfOnly = false; // unreadable here; the Library viewer says so when opened
          }
        }
        await app.save((state) => {
          state.library[id] = { title: paper.title, authors: paper.authors, published: paper.published, abs_url: paper.abs_url, arxiv_id: paper.saveId ?? paper.arxiv_id, folder: destination, files: files.length, pdfOnly, savedAt: new Date().toISOString() };
        });
        jobs.delete(id);
        await app.files.refresh();
        announce(`Saved ${paper.title}`);
      } else if (outcome.status === "cancelled") {
        jobs.delete(id);
      } else {
        const plain = explainError(outcome.error, ERROR_RULES);
        if (plain.rule === "exists") await app.files.refresh();
        if (plain.rule === "exists" && folderOf(paper)) jobs.delete(id);
        else jobs.set(id, { state: "failed", text: plain.text, raw: outcome.error });
      }
      render();
      if (queue.length && !stopping) {
        updateQueue();
        await pause(PAUSE_MS);
      }
    }
    for (const paper of queue.splice(0)) jobs.delete(baseId(paper.arxiv_id));
    Object.assign(batch, { total: 0, done: 0, seconds: [] });
    queueRunning = false;
    wake = null;
    app.lock.release();
    updateQueue();
    render();
  }

  function stopQueue() {
    stopping = true;
    for (const paper of queue.splice(0)) jobs.delete(baseId(paper.arxiv_id));
    wake?.();
    saveRun.cancel();
    render();
  }

  // ---------------------------------------------------------------- describe
  async function describe() {
    const text = describeBox.value.trim();
    if (!text || !app.lock.take("finding the paper you described")) return;
    candidates = new Map();
    picked = null;
    describeResult.replaceChildren();
    describeRun.element.dataset.used = "1";
    updateButtons();
    const outcome = await describeRun.start({ query: text, max_results: 10 });
    app.lock.release();
    const saves = outcome.tools.filter((tool) => tool.name === "download_source" && !tool.isError && tool.data);
    const last = saves.at(-1);
    if (outcome.status === "cancelled") {
      describeResult.replaceChildren(banner({ tone: "neutral", title: "Stopped. Anything already saved stays in your library." }));
    } else if (outcome.status === "error" && !last) {
      describeResult.replaceChildren(errorCard({ message: outcome.error, rules: ERROR_RULES, title: outcome.startFailed ? "Couldn't start." : undefined, actions: [h("button", { type: "button", class: "button small", text: "Try again", onclick: describe })] }));
    } else if (!last) {
      describeResult.replaceChildren(
        banner({
          tone: "info",
          title: "The agent couldn't pin down one paper.",
          body: "Try adding an author or a year, or search instead.",
          lines: outcome.answer ? [h("span", { class: "muted", text: outcome.answer })] : [],
          actions: [h("button", { type: "button", class: "button small", text: "Search with these words", onclick: () => ((input.value = text), setMode("search"), sync()) })],
        }),
      );
    } else {
      const id = baseId(String(last.data.arxiv_id ?? last.arguments.arxiv_id));
      const folder = String(last.arguments.destination).replace(/^\.\//, "").replace(/\/+$/, "");
      const paper = candidates.get(id) ?? { arxiv_id: id, title: `arXiv ${id}`, authors: [], summary: "", published: "", abs_url: `https://arxiv.org/abs/${id}` };
      picked = paper;
      await app.save((state) => {
        state.library[id] = { title: paper.title, authors: paper.authors, published: paper.published, abs_url: paper.abs_url, arxiv_id: last.data.arxiv_id ?? id, folder, files: last.data.files?.length ?? 0, pdfOnly: false, savedAt: new Date().toISOString() };
      });
      await app.files.refresh();
      const others = saves.length - 1;
      render();
      describeResult.replaceChildren(
        ...[
          h("h2", { class: "picked-title" }, icon("spark", { size: 18 }), "Picked for you"),
          pickedList,
          outcome.answer ? h("figure", { class: "why" }, h("figcaption", { text: "Why this one" }), h("blockquote", { text: outcome.answer })) : null,
          others > 0 ? h("p", { class: "muted small-text", text: `The agent also saved ${plural(others, "other paper")}; they're in your Library.` }) : null,
          outcome.status === "error" ? errorCard({ message: outcome.error, rules: ERROR_RULES, title: "The source was saved, but the run ended with a problem." }) : null,
        ].filter(Boolean),
      );
    }
    updateButtons();
  }

  // ---------------------------------------------------------------- rendering
  function statusArea(paper) {
    const id = baseId(paper.arxiv_id);
    const folder = folderOf(paper);
    const job = jobs.get(id);
    if (folder) {
      const record = app.state().library[id];
      return h(
        "div",
        { class: "paper-status" },
        h("span", { class: "pill tone-ok" }, icon("check", { size: 14 }), record?.files ? `Saved · ${plural(record.files, "file")}` : "Saved"),
        h("button", { type: "button", class: "button small", text: "Open", "aria-label": `Open ${paper.title} in Library`, onclick: () => app.go("library", { folder }) }),
        record?.pdfOnly ? h("p", { class: "status-note muted small-text", text: "arXiv has only a PDF for this paper; it was saved as main.tex." }) : null,
      );
    }
    if (job?.state === "queued") {
      // The one being saved is number done + 1; the queue follows it.
      const position = batch.done + 2 + queue.findIndex((one) => baseId(one.arxiv_id) === id);
      return h("div", { class: "paper-status" }, h("span", { class: "pill tone-neutral", text: `Queued (${position} of ${batch.total})` }));
    }
    if (job?.state === "saving") return h("div", { class: "paper-status" }, h("span", { class: "saving" }, h("span", { class: "run-spinner", "aria-hidden": "true" }), "Saving…"));
    const busy = Boolean(app.lock.holder) && !queueRunning;
    const save = h("button", { type: "button", class: "button primary small save-button", disabled: busy, title: busy ? `Busy: ${app.lock.holder}` : null, onclick: () => enqueue([paper]) }, job?.state === "failed" ? "Retry" : "Save source");
    if (job?.state === "failed") {
      return h("div", { class: "paper-status" }, h("span", { class: "pill tone-bad" }, icon("alert", { size: 14 }), "Couldn't save"), save, h("p", { class: "status-note error-text small-text", title: job.raw, text: job.text }));
    }
    return h("div", { class: "paper-status" }, save);
  }

  function paperItem(paper, { pickable = true } = {}) {
    const id = baseId(paper.arxiv_id);
    const authors = paper.authors ?? [];
    const showAll = expandedAuthors.has(id) || authors.length <= AUTHORS_SHOWN + 1;
    const authorLine = h(
      "p",
      { class: "paper-authors" },
      (showAll ? authors : authors.slice(0, AUTHORS_SHOWN)).join(", "),
      showAll ? null : [" ", h("button", { type: "button", class: "link-button", text: `+${authors.length - AUTHORS_SHOWN} more`, onclick: () => (expandedAuthors.add(id), render()) })],
    );
    const long = (paper.summary ?? "").length > ABSTRACT_CLAMP;
    const open = expandedAbstracts.has(id);
    const checkbox = pickable
      ? h("input", { type: "checkbox", class: "paper-check", checked: selected.has(id), disabled: !selectable(paper), "aria-label": `Select ${paper.title}`, onchange: (event) => (event.target.checked ? selected.add(id) : selected.delete(id), renderSelection()) })
      : null;
    return h(
      "li",
      { class: `paper${selected.has(id) ? " selected" : ""}` },
      checkbox,
      h(
        "div",
        { class: "paper-body" },
        h("h3", { class: "paper-title", title: paper.title, text: paper.title }),
        authors.length ? authorLine : null,
        h(
          "p",
          { class: "paper-meta muted" },
          paper.published ? h("span", { text: formatDay(paper.published) }) : null,
          h("span", { class: "paper-id", title: `Version ${paper.arxiv_id}` }, h("code", { text: id }), copyButton({ text: id, iconOnly: true, label: `Copy arXiv id ${id}` })),
        ),
        paper.summary ? h("p", { class: `paper-abstract${long && !open ? " clamped" : ""}`, text: paper.summary }) : null,
        h(
          "div",
          { class: "paper-links" },
          long ? h("button", { type: "button", class: "link-button", "aria-expanded": String(open), text: open ? "Hide abstract" : "Show abstract", onclick: () => (open ? expandedAbstracts.delete(id) : expandedAbstracts.add(id), render()) }) : null,
          copyButton({ text: https(paper.abs_url), label: "Copy arXiv link" }),
        ),
      ),
      statusArea(paper),
    );
  }

  function renderSelection() {
    const papers = currentPapers();
    const pickable = papers.filter(selectable);
    const chosen = pickable.filter((paper) => selected.has(baseId(paper.arxiv_id)));
    selectAll.checked = pickable.length > 0 && chosen.length === pickable.length;
    selectAll.indeterminate = chosen.length > 0 && chosen.length < pickable.length;
    selectAll.disabled = pickable.length === 0;
    selectionBar.hidden = mode !== "search" || chosen.length === 0;
    selectedText.textContent = `${chosen.length} selected`;
    const busy = Boolean(app.lock.holder) && !queueRunning;
    saveSelected.textContent = `Save ${plural(chosen.length, "source")}`;
    saveSelected.disabled = busy;
    saveSelected.title = busy ? `Busy: ${app.lock.holder}` : "";
    for (const item of list.children) item.classList.toggle("selected", Boolean(item.querySelector(".paper-check:checked")));
  }

  function render() {
    const searching = mode === "search";
    intro.hidden = !searching || results !== null || searchRun.busy;
    message.hidden = !searching;
    queueBar.hidden = !queueRunning;
    resultsWrap.hidden = !searching || !results || results.papers.length === 0;
    if (results && results.papers.length) {
      heading.textContent = results.id ? `arXiv ${baseId(results.id)}` : `${plural(results.papers.length, "paper")} for “${results.typed}”`;
      sort.element.hidden = results.papers.length < 2;
      list.replaceChildren(...currentPapers().map((paper) => paperItem(paper)));
    }
    if (picked) pickedList.replaceChildren(paperItem(picked, { pickable: false }));
    renderSelection();
    updateButtons();
  }

  bar.addEventListener("submit", (event) => {
    event.preventDefault();
    search();
  });
  input.addEventListener("input", sync);
  advancedBox.addEventListener("input", () => {
    ownQuery = advancedBox.value.trim() !== "";
    ownNote.hidden = !ownQuery;
    updateButtons();
  });
  describeBox.addEventListener("input", updateButtons);
  describeBox.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) describe();
  });
  describeButton.addEventListener("click", describe);
  app.lock.on(render);
  app.files.on(render);
  sync();
  render();

  return {
    element,
    shown() {
      if (mode === "search" && !results) input.focus({ preventScroll: true });
    },
  };
}
