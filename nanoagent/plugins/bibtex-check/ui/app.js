// The BibTeX Hallucination Check page: add the bibliography an AI wrote and the references you
// trust, press Check, and read which entries are hallucinated and what differs in each. The chat
// with the checker stays one click away in a drawer. Design: docs/plans/plugin-ui-bibtex-check.md.
import {
  appShell,
  banner,
  card,
  copyButton,
  disclosure,
  emptyState,
  errorCard,
  explainError,
  fileDrop,
  h,
  howItWorks,
  icon,
  parseToolOutput,
  plural,
  runButton,
  segmented,
  statusPill,
  taskRun,
  writeText,
} from "./kit/components.js";
import { ERROR_RULES, authorsDiff, closestReference, countEntries, errorCard as cardForError, exactMatch, inspectBib, labelsFrom, reportMarkdown, shortAuthors, spanDiff, unreadableReason } from "./bib.js";
import { SAMPLE_RAW, SAMPLE_REFERENCE } from "./samples.js";

const TASK = "check-bibtex";
const PATHS = { raw: "inputs/raw.bib", reference: "inputs/reference.bib" };
const REPORT = "reports/bibtex-check.md";
const STEPS = [
  { id: "refs", label: "Reading your references" },
  { id: "raw", label: "Reading the bibliography" },
  { id: "compare", label: "Comparing every entry" },
  { id: "answer", label: "Writing the summary" },
  { id: "verify", label: "Double-checking the verdicts" },
];
const LABELS = {
  hallucinated: { word: "Hallucinated", tone: "bad" },
  real: { word: "Real", tone: "ok" },
  null: { word: "Not checked", tone: "neutral" },
};
// Above this many entries the list gets a search box; above the second, real entries fold away.
const SEARCH_FROM = 12;
const FOLD_REAL_FROM = 30;

export default layout;

async function layout({ plugin }) {
  if (!plugin.tasks.some((task) => task.id === TASK)) throw new Error(`This plugin has no ${TASK} task, which this page runs.`);

  let last = null; // the latest result, for the chat's context and the report
  let attempt = null; // what the run in progress has seen

  const cards = {
    raw: fileDrop({ title: "Bibliography to check", path: PATHS.raw, extensions: [".bib"], description: "The .bib file an AI model wrote", inspect: inspectBib, onChange: () => filesChanged() }),
    reference: fileDrop({ title: "References you trust", path: PATHS.reference, extensions: [".bib"], description: "Exported from Zotero, Google Scholar or a past paper", inspect: inspectBib, onChange: () => filesChanged() }),
  };
  Object.values(cards).forEach((one, index) => one.element.querySelector(".drop-title").prepend(h("span", { class: "step-number", "aria-hidden": "true", text: String(index + 1) })));

  const run = taskRun({ task: TASK, title: "Checking your bibliography", steps: STEPS, onEvent, onFinish });
  const check = runButton({ label: "Check bibliography", onClick: start, run, cancelWhileBusy: true });
  const sample = h("button", { type: "button", class: "button ghost", onclick: useSamples }, icon("spark", { size: 16 }), h("span", { text: "Try it with sample files" }));
  run.subscribe((busy) => (sample.disabled = busy));

  const notice = h("div", { class: "page-notice" });
  const previous = h("p", { class: "previous-label", hidden: true }, icon("info", { size: 15 }), h("span"));
  const results = h("div", { class: "results stack" });
  const empty = card(
    { className: "empty-card", label: "How it works" },
    emptyState({ icon: "file", title: "Your results will show here", body: plugin.product.summary }, howItWorks(plugin.product.steps, { title: "" })),
  );

  const shell = appShell({
    plugin,
    chat: {
      title: "Ask the checker",
      buttonLabel: "Ask the checker",
      note: "It knows how the check works and can explain a verdict. Your files only change when you add them on the page.",
      intro: h("div", { class: "chat-intro small" }, h("img", { src: plugin.product.icon, alt: "" }), h("p", { class: "muted", text: "Ask about a citation or about how the check works." })),
      placeholder: "Ask about a citation",
      suggestions: ["How does the check decide an entry is real?", "What makes a reference file unreadable?"],
      prepare: withPageContext,
    },
  });
  shell.main.append(
    h("div", { class: "inputs" }, cards.raw.element, cards.reference.element),
    h("div", { class: "check-area" }, h("div", { class: "check-row" }, check.element, sample), h("p", { class: "muted small-text", text: "Runs offline. Compares type, title, authors, year, venue and DOI." })),
    notice,
    run.element,
    previous,
    results,
    empty,
  );

  // A returning user's files are still in the workspace: show them as chosen.
  await Promise.all(
    Object.values(cards).map((one) => one.restore().catch((problem) => one.setError(`Couldn't look in your workspace: ${problem.message}`))),
  );
  filesChanged();
  return shell.element;

  // -------------------------------------------------------------------------------------------

  function filesChanged() {
    const raw = cards.raw.value();
    const reference = cards.reference.value();
    const count = raw ? countEntries(raw.text) : 0;
    check.setLabel(count ? `Check ${plural(count, "entry", "entries")}` : "Check bibliography");
    check.setBlocked(raw && reference ? null : !raw && !reference ? "Add both files to start." : !raw ? "Add the bibliography to check." : "Add the references you trust.");
    if (last && !run.busy) showPrevious("These results are for the files you checked before. Press Check to update them.", last.files !== fingerprint());
  }

  function fingerprint() {
    return [cards.raw.value()?.text, cards.reference.value()?.text].join("\u0000");
  }

  function showPrevious(text, show) {
    previous.lastChild.textContent = text;
    previous.hidden = !show;
    results.classList.toggle("dimmed", show && run.busy);
  }

  async function useSamples() {
    const done = await Promise.all([cards.raw.useText(SAMPLE_RAW, "sample-ai.bib", "sample"), cards.reference.useText(SAMPLE_REFERENCE, "sample-references.bib", "sample")]);
    if (done.every(Boolean)) check.button.focus();
  }

  function start() {
    for (const one of Object.values(cards)) {
      one.setError(null);
      one.setDisabled(true);
    }
    notice.replaceChildren();
    empty.hidden = true;
    attempt = { files: fingerprint(), reads: {}, agentLabels: null, answer: null };
    if (last) {
      previous.lastChild.textContent = "Previous check. It will be replaced when this one finishes.";
      previous.hidden = false;
      results.classList.add("dimmed");
    }
    run.start({ reference: PATHS.reference, raw: PATHS.raw });
  }

  function onEvent(name, data, progress) {
    if (name === "task.started" || name === "task.reference") progress.step("refs");
    else if (name === "task.error" && cardForError(data.message ?? "", PATHS) === "raw") progress.step("raw");
    else if (name === "task.answer") {
      attempt.answer = data.text ?? "";
      progress.step("verify");
    } else if (name === "task.tool" && data.name === "read_bibtex") {
      const output = parseToolOutput(data.output);
      if (data.isError || !output || output.ok === false || !Array.isArray(output.entries)) {
        progress.note("The checker had trouble reading a file and tried again.");
        return;
      }
      const which = Object.keys(PATHS).find((key) => PATHS[key] === data.arguments?.path);
      if (!which) return;
      attempt.reads[which] = output.entries;
      const { raw, reference } = attempt.reads;
      if (reference) progress.step("refs", { state: "done", detail: plural(reference.length, "reference") });
      progress.step("raw", { state: raw && reference ? "done" : "active", detail: raw ? plural(raw.length, "entry", "entries") : undefined });
      if (raw && reference) progress.step("compare", { detail: `${plural(raw.length, "entry", "entries")} against ${plural(reference.length, "reference")}` });
    } else if (name === "task.tool" && data.name === "submit_verdicts") {
      const verdicts = data.arguments?.verdicts;
      if (data.isError || !verdicts || typeof verdicts !== "object") {
        progress.note("The checker had trouble saving its verdicts and tried again.");
        return;
      }
      attempt.agentLabels = verdicts;
      progress.step("compare", { state: "done", detail: plural(Object.keys(verdicts).length, "verdict") });
      progress.step("answer");
    }
  }

  function onFinish(outcome) {
    for (const one of Object.values(cards)) one.setDisabled(false);
    if (attempt.reads.raw) cards.raw.setSummary(plural(attempt.reads.raw.length, "entry", "entries"));
    if (attempt.reads.reference) cards.reference.setSummary(plural(attempt.reads.reference.length, "entry", "entries"));
    results.classList.remove("dimmed");
    const again = () => h("button", { type: "button", class: "button small", onclick: start }, icon("refresh", { size: 15 }), h("span", { text: "Check again" }));

    if (outcome.status === "valid" || outcome.status === "invalid") {
      showResult(outcome);
    } else {
      if (outcome.status === "cancelled") notice.replaceChildren(banner({ tone: "neutral", title: "Check cancelled.", body: "Nothing was changed. Press Check when you're ready.", actions: [again()] }));
      else if (outcome.status === "unchecked") notice.replaceChildren(banner({ tone: "warn", title: "The check stopped before it finished.", body: "No verdicts came back. Try again.", actions: [again()] }));
      else {
        const plain = explainError(outcome.error, ERROR_RULES);
        const where = cardForError(outcome.error, PATHS);
        if (where) cards[where].setError(plain.text);
        const title = outcome.startFailed ? "Couldn't start the check" : where ? `The check couldn't run: there's a problem with ${where === "raw" ? "the bibliography" : "your references"}` : undefined;
        notice.replaceChildren(errorCard({ message: outcome.error, rules: ERROR_RULES, title, actions: [again()] }));
      }
      if (last) showPrevious("Showing your previous check.", true);
      else empty.hidden = false;
    }
    attempt = null;
  }

  // -------------------------------------------------------------------------------------------
  // The result: the verifier's verdict, the agent's labels and what read_bibtex reported.

  function showResult(outcome) {
    const { verdict } = outcome;
    const reads = attempt.reads;
    const rawKeys = reads.raw?.map((entry) => entry.key);
    const { labels, extra } = labelsFrom(verdict, attempt.agentLabels, rawKeys);
    previous.hidden = true;
    empty.hidden = true;

    if (!labels.size) {
      last = null;
      results.replaceChildren(
        banner({ tone: "bad", title: "The checker didn't finish its verdicts.", body: "Nothing was judged. Try again; if it keeps happening, ask the checker what went wrong.", actions: [h("button", { type: "button", class: "button small", onclick: start, text: "Check again" })] }),
      );
      shell.drawer.chat.setSuggestions(["Why didn't the check finish?"]);
      return;
    }

    const source = reads.raw ?? [...labels.keys()].map((key) => ({ key, record: undefined, error: null }));
    const rows = source.map((entry) => describe(entry, labels.get(entry.key) ?? { label: null, corrected: false }, reads.reference ?? null));
    const count = (label) => rows.filter((row) => row.label === label).length;
    const flagged = count("hallucinated");
    const real = count("real");
    const unchecked = count(null);
    const unreadable = rows.filter((row) => row.label === "hallucinated" && row.record === null).length;
    const total = rows.length;

    const headline =
      flagged === 0 && unchecked === 0
        ? total === 1 ? "The entry matches your references" : `All ${total} entries match your references`
        : `${flagged} of ${plural(total, "entry", "entries")} ${flagged === 1 ? "looks" : "look"} hallucinated`;
    const wrong = rows.filter((row) => row.corrected).length + unchecked;
    const trust = verdict.valid
      ? { tone: "ok", title: "Verified: every verdict was re-checked against your references." }
      : {
          tone: "warn",
          title: `The checker got ${wrong} of ${plural(total, "entry", "entries")} wrong, so the check stepped in.`,
          body: [rows.some((row) => row.corrected) ? "The labels below are the corrected ones." : "", unchecked ? `${plural(unchecked, "entry", "entries")} got no verdict and ${unchecked === 1 ? "is" : "are"} marked Not checked.` : ""].filter(Boolean).join(" "),
          lines: extra.length ? [`The checker also judged ${extra.length === 1 ? "a key that isn't" : "keys that aren't"} in your file: ${extra.join(", ")}.`] : [],
        };

    const summary = card(
      { size: "large", className: `summary tone-${flagged || unchecked ? "bad" : "ok"}`, label: "Result" },
      h("p", { class: "eyebrow", text: "Result" }),
      h("h2", { class: "headline", "aria-live": "polite", text: headline }),
      h(
        "div",
        { class: "tallies" },
        tally(flagged, "Hallucinated", "bad"),
        tally(real, "Real", "ok"),
        unchecked ? tally(unchecked, "Not checked", "neutral") : null,
        unreadable ? h("p", { class: "muted small-text tally-note", text: `${unreadable} of the hallucinated entries could not be read at all.` }) : null,
      ),
      banner(trust),
    );

    const list = h("div", { class: "entries" });
    const search = total > SEARCH_FROM ? h("input", { type: "search", class: "input entry-search", placeholder: "Search title or key", "aria-label": "Search title or key", oninput: () => draw() }) : null;
    let showReal = total <= FOLD_REAL_FROM;
    const filter = segmented({
      label: "Show",
      look: "chips",
      value: "all",
      options: [
        { value: "all", label: "All", count: total },
        { value: "hallucinated", label: "Hallucinated", count: flagged },
        { value: "real", label: "Real", count: real },
        ...(unchecked ? [{ value: "unchecked", label: "Not checked", count: unchecked }] : []),
      ],
      onChange: () => draw(),
    });
    const order = { hallucinated: 0, null: 1, real: 2 };
    const sorted = [...rows].sort((a, b) => order[a.label] - order[b.label]);
    const draw = () => {
      const chosen = filter.value();
      const needle = search?.value.trim().toLowerCase() ?? "";
      const shown = sorted.filter(
        (row) =>
          (chosen === "all" || (chosen === "unchecked" ? row.label === null : row.label === chosen)) &&
          (!needle || row.key.toLowerCase().includes(needle) || (row.record?.title ?? "").toLowerCase().includes(needle)),
      );
      const folded = !showReal && chosen === "all" && !needle ? shown.filter((row) => row.label === "real") : [];
      list.replaceChildren(
        ...shown.filter((row) => !folded.includes(row)).map(entryCard),
        folded.length ? h("button", { type: "button", class: "button block show-real", onclick: () => ((showReal = true), draw()), text: `Show ${plural(folded.length, "real entry", "real entries")}` }) : null,
        shown.length ? null : h("p", { class: "muted none-shown", text: "No entries match." }),
      );
    };
    draw();

    const flaggedKeys = rows.filter((row) => row.label === "hallucinated").map((row) => row.key);
    const saved = h("p", { class: "muted small-text save-status", role: "status" });
    const report = reportMarkdown({ headline, trust: trust.title, rows, answer: plainAnswer(attempt.answer), files: PATHS });
    const save = h("button", { type: "button", class: "button small" }, icon("file", { size: 15 }), h("span", { text: "Save report" }));
    save.addEventListener("click", async () => {
      save.disabled = true;
      saved.classList.remove("error-text");
      try {
        await writeText(REPORT, report);
        saved.textContent = `Saved to your workspace as ${REPORT}`;
      } catch (problem) {
        saved.textContent = `Couldn't save the report: ${problem.message}`;
        saved.classList.add("error-text");
      } finally {
        save.disabled = false;
      }
    });

    results.replaceChildren(
      summary,
      h("div", { class: "list-tools" }, filter.element, search, h("div", { class: "list-actions" }, flaggedKeys.length ? copyButton({ text: flaggedKeys.join("\n"), label: "Copy flagged keys" }) : null, save)),
      saved,
      list,
      attempt.answer ? disclosure({ summary: "The checker's summary", className: "answer card" }, h("p", { class: "answer-text", text: plainAnswer(attempt.answer) })) : null,
    );
    last = { files: attempt.files, flaggedKeys, realKeys: rows.filter((row) => row.label === "real").map((row) => row.key) };
    shell.drawer.chat.setSuggestions(
      flaggedKeys.length ? [`Why is ${flaggedKeys[0]} flagged?`, "How do I fix the flagged entries?", "What would make my references stricter?"] : ["What would make my references stricter?"],
    );
  }

  /** One raw entry as the page shows it: its label and what explains it. */
  function describe(entry, { label, corrected }, references) {
    const row = { key: entry.key, record: entry.record, label, corrected, match: null, closest: null, unreadable: null, notFound: false, unavailable: false, why: [] };
    if (entry.record === undefined) row.unavailable = true;
    else if (label === "real") {
      const match = references && exactMatch(entry.record, references);
      if (match) row.match = match.key;
      else row.unavailable = true;
    } else if (label === "hallucinated") {
      if (entry.record === null) {
        row.unreadable = unreadableReason(entry.error);
        row.why.push(`Could not be read: ${row.unreadable.text}`);
      } else if (!references || exactMatch(entry.record, references)) row.unavailable = true;
      else {
        row.closest = closestReference(entry.record, references);
        if (row.closest) row.why.push(...row.closest.differs.map((field) => `${field.label} differs from \`${row.closest.entry.key}\`: ${describeField(field.key, entry.record[field.key], row.closest.entry.record[field.key])}`));
        else {
          row.notFound = true;
          row.why.push("Nothing similar is in your references.");
        }
      }
    }
    return row;
  }

  function withPageContext(text) {
    if (!last) return text;
    const flagged = last.flaggedKeys.length ? last.flaggedKeys.join(", ") : "none";
    return `${text}\n\n(Context from the page: the last check compared ${PATHS.raw} with ${PATHS.reference}. Hallucinated: ${flagged}. Real: ${last.realKeys.join(", ") || "none"}.)`;
  }
}

// ---------------------------------------------------------------------------------------------
// Building blocks of the result.

function tally(value, label, tone) {
  return h("div", { class: `tally tone-${tone}` }, h("span", { class: "tally-value numeric", text: String(value) }), h("span", { class: "tally-label", text: label }));
}

function plainAnswer(text) {
  return (text ?? "").replaceAll("`", "");
}

function show(value) {
  if (value === null || value === undefined || value === "") return "none";
  return Array.isArray(value) ? value.join(", ") : value;
}

function describeField(key, mine, theirs) {
  if (key === "authors") {
    const { extra, missing, reordered } = authorsDiff(mine, theirs);
    if (reordered) return "same names in a different order";
    return [extra.length ? `extra ${extra.join(", ")}` : "", missing.length ? `missing ${missing.join(", ")}` : ""].filter(Boolean).join("; ");
  }
  return `yours ${show(mine)}, reference ${show(theirs)}`;
}

function highlighted(value, other) {
  if (typeof value !== "string" || typeof other !== "string") return value === null || value === undefined ? h("em", { class: "muted", text: "none" }) : String(value);
  const diff = spanDiff(value, other);
  return [diff.before, diff.mine ? h("mark", { text: diff.mine }) : null, diff.after];
}

function diffRow(field, mine, theirs) {
  if (field.key === "authors") {
    const { extra, missing, reordered } = authorsDiff(mine, theirs);
    const lines = reordered
      ? [h("li", { text: "The same authors, in a different order" })]
      : [
          ...extra.map((name) => h("li", {}, "Extra author: ", h("mark", { text: name }))),
          ...missing.map((name) => h("li", {}, "Missing author: ", h("mark", { text: name }))),
        ];
    return h("div", { class: "diff-row authors" }, h("dt", { text: field.label }), h("dd", { class: "diff-wide" }, h("ul", { class: "author-changes" }, lines)));
  }
  return h(
    "div",
    { class: "diff-row" },
    h("dt", { text: field.label }),
    h("dd", { class: "mine" }, h("span", { class: "who", text: "Yours" }), h("span", { class: "value" }, highlighted(mine, theirs))),
    h("dd", { class: "theirs" }, h("span", { class: "who", text: "Reference" }), h("span", { class: "value" }, highlighted(theirs, mine))),
  );
}

function entryCard(row) {
  const look = LABELS[row.label];
  const record = row.record;
  const meta = record ? [shortAuthors(record.authors), record.year, record.venue, record.doi].filter(Boolean).join(" · ") : "";
  let detail = null;
  if (row.unavailable) detail = h("p", { class: "muted small-text", text: "Details aren't available for this run." });
  else if (row.match) detail = h("p", { class: "match-line" }, icon("check", { size: 15 }), "Matches ", h("code", { text: row.match }), " exactly");
  else if (row.unreadable) {
    detail = h(
      "div",
      { class: "diff unreadable" },
      h("p", { class: "diff-head" }, h("strong", { text: "Could not be read. " }), row.unreadable.text),
      row.unreadable.raw ? h("p", { class: "muted small-text", text: `The parser said: ${row.unreadable.raw}` }) : null,
    );
  } else if (row.notFound) {
    detail = h("div", { class: "diff" }, h("p", { class: "diff-head" }, h("strong", { text: "Not in your references. " }), "Nothing similar is there. The paper may not exist, or your references don't include it."));
  } else if (row.closest) {
    const { entry, differs } = row.closest;
    detail = h(
      "div",
      { class: "diff" },
      h("p", { class: "diff-head" }, "Closest reference: ", h("code", { text: entry.key }), h("span", { class: "muted", text: ` · ${plural(differs.length, "field differs", "fields differ")}` })),
      h("dl", { class: "diff-rows" }, differs.some((field) => field.key !== "authors") ? h("div", { class: "diff-row diff-labels", "aria-hidden": "true" }, h("span"), h("span", { text: "Yours" }), h("span", { text: "Reference" })) : null, differs.map((field) => diffRow(field, record[field.key], entry.record[field.key]))),
    );
  } else if (row.label === null) {
    detail = h("p", { class: "muted small-text", text: "The checker gave no verdict for this entry, so it isn't judged here." });
  }
  return h(
    "article",
    { class: `entry is-${row.label ?? "unchecked"}`, "aria-label": `${row.key}: ${look.word}` },
    h("div", { class: "entry-head" }, statusPill(look.word, look.tone, { icon: true }), row.corrected ? statusPill("Corrected by the check", "warn") : null, h("code", { class: "entry-key", text: row.key })),
    record ? h("p", { class: "entry-title", text: record.title }) : null,
    meta ? h("p", { class: "entry-meta muted small-text", text: meta }) : null,
    detail,
  );
}
