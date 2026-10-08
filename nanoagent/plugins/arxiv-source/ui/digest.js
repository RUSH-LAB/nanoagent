// Daily digest: the people you follow, a day, and the agent's checked digest of their new papers
// with every source saved under docs/raw/.
import { banner, chipRow, chipsInput, copyButton, dateInput, errorCard, explainError, formatDuration, h, icon, isoDate, parseToolOutput, plural, readJSON, readText, runButton, skeleton, taskRun, verdictBanner } from "./kit/components.js";
import { ERROR_RULES, digestProblem, formatLongDay, formatShortDay, formatWhen, personOf } from "./arxiv.js";

const DIGEST = /^docs\/digest-(\d{4}-\d{2}-\d{2})\.json$/;
const EARLIER_SHOWN = 7;
const COMFORTABLE_PEOPLE = 20;

const utcToday = () => isoDate({ timeZone: "UTC" });
const utcYesterday = () => isoDate({ timeZone: "UTC", days: -1 });

export function digestView(app) {
  let showAllEarlier = false;
  let titles = new Map(); // arxiv id -> title, from this run's save_raw_paper outputs
  let shownDate = null;

  const people = chipsInput({
    label: "People you follow",
    values: app.state().people,
    placeholder: "Add a person, e.g. Yoshua Bengio",
    hint: "Use the name as arXiv lists it. Press Enter to add.",
    validate: (value, list) => {
      if (value.includes('"')) return "Leave out quotation marks.";
      const same = list.find((one) => one.toLowerCase() === value.toLowerCase());
      return same ? `${same} is already in the list.` : null;
    },
    onChange: (values) => {
      app.save((state) => {
        state.people = values;
      });
      update();
    },
  });

  const date = dateInput({
    label: "Day (UTC)",
    value: utcYesterday(),
    max: utcToday(),
    chips: [
      { label: "Yesterday", value: utcYesterday() },
      { label: "Today", value: utcToday() },
    ],
    caption: "Papers first submitted on this day, in arXiv's time (UTC).",
    check: (value) => (value > utcToday() ? { message: "That day hasn't started yet in UTC.", fix: { label: "Use today", value: utcToday() } } : null),
    onChange: () => update(),
  });

  const existing = h("div", { class: "existing-note", hidden: true });
  const run = taskRun({
    task: "daily-digest",
    title: "Writing the digest",
    steps: [
      { id: "listing", label: "Getting arXiv's own listing to check against" },
      { id: "lookup", label: "Looking up each person" },
      { id: "save", label: "Saving each paper's source" },
      { id: "write", label: "Writing the digest" },
      { id: "check", label: "Checking the digest against arXiv" },
    ],
    onEvent,
  });
  const button = runButton({ label: "Write digest", onClick: start, run });
  const timeNote = h("p", { class: "muted small-text" });
  const earlier = chipRow({ label: "Earlier digests", items: [], onPick: (item) => (item.value === "more" ? ((showAllEarlier = true), renderEarlier()) : showDigest(item.value)), scroll: true });
  const earlierRow = h("div", { class: "earlier", hidden: true }, h("span", { class: "filter-label", text: "Earlier digests" }), earlier.element);
  const result = h("div", { class: "stack digest-result", "aria-live": "polite" });

  // While it runs, the progress card below holds Stop; the setup shows no second control.
  const actions = h("div", { class: "digest-actions" }, button.element, timeNote);
  const setup = h(
    "section",
    { class: "card digest-setup", "aria-label": "Digest settings" },
    h("div", { class: "card-head" }, h("div", { class: "card-titles" }, h("h2", { text: "Your daily digest" }), h("p", { class: "muted", text: "Follow people to get a short, checked digest of the papers they put on arXiv each day, with every source saved." }))),
    h("div", { class: "digest-fields" }, h("div", { class: "people-field" }, people.element), h("div", { class: "date-field" }, date.element)),
    existing,
    actions,
    earlierRow,
  );
  const element = h("section", { class: "view digest-view", "aria-label": "Daily digest" }, setup, run.element, result);

  const digestDates = () =>
    app.files.list
      .map((file) => file.path.match(DIGEST)?.[1])
      .filter(Boolean)
      .sort()
      .reverse();

  function update() {
    const list = people.values();
    const day = date.value();
    const busy = app.lock.holder && !run.busy;
    button.setBlocked(busy ? `Busy: ${app.lock.holder}.` : !list.length ? "Add at least one person to follow." : !date.valid() ? "Pick a day that has started in UTC." : null);
    people.setDisabled(run.busy);
    date.setDisabled(run.busy);
    date.setCaption(day === utcToday() ? "Today isn't over in UTC yet: papers submitted later today won't be in it." : "Papers first submitted on this day, in arXiv's time (UTC).");
    const seconds = list.length * 8 + 30;
    timeNote.textContent = list.length > COMFORTABLE_PEOPLE ? "With this many people it will take a few minutes." : list.length ? `Usually about ${formatDuration(seconds)}.` : "";
    const has = digestDates().includes(day);
    existing.hidden = !has || run.busy || shownDate === day;
    actions.hidden = run.busy;
    existing.replaceChildren(icon("info", { size: 16 }), h("span", { text: `You already have a digest for ${formatShortDay(day)}. Writing it again replaces it.` }), h("button", { type: "button", class: "button ghost small", text: "Show it", onclick: () => showDigest(day) }));
    renderEarlier();
  }

  function renderEarlier() {
    const dates = digestDates();
    earlierRow.hidden = dates.length === 0;
    const digests = app.state().digests;
    const shown = showAllEarlier ? dates : dates.slice(0, EARLIER_SHOWN);
    earlier.setItems([
      ...shown.map((day) => {
        const check = digests[day];
        return {
          value: day,
          label: h("span", { class: "earlier-chip" }, check ? icon(check.valid ? "check" : "alert", { size: 14 }) : null, formatShortDay(day)),
          title: check ? (check.valid ? "Checked against arXiv" : "Needs attention") : "Not checked by this page",
          tone: check ? (check.valid ? "ok" : "warn") : undefined,
          selected: day === shownDate,
        };
      }),
      ...(dates.length > shown.length ? [{ value: "more", label: `More (${dates.length - shown.length})` }] : []),
    ]);
  }

  // ------------------------------------------------------------------ the run
  function onEvent(name, data, controller) {
    if (name === "task.started") controller.step("listing");
    if (name === "task.reference") controller.step("listing", { state: "done", detail: `For ${plural(people.values().length, "person", "people")}` });
    if (name === "task.answer") controller.step("check");
    if (name !== "task.tool") return;
    const out = parseToolOutput(data.output);
    const args = data.arguments ?? {};
    if (data.name === "search_papers") {
      controller.step("lookup");
      const person = personOf(args.query) ?? "someone";
      if (data.isError || !out) controller.note(`Couldn't look up ${person}; the agent may try again.`, { step: "lookup", tone: "warn" });
      else controller.note(`${person}: ${plural(out.papers?.length ?? 0, "paper")}`, { step: "lookup" });
    } else if (data.name === "save_raw_paper") {
      controller.step("save");
      const id = String(args.arxiv_id ?? "").replace(/v\d+$/, "");
      if (data.isError || !out) {
        const plain = explainError(data.output, ERROR_RULES);
        const already = plain.rule === "exists" || app.files.list.some((file) => file.path.startsWith("docs/raw/") && file.path.includes(`-${id}-${args.date}/`));
        controller.note(already ? `Already saved: ${titles.get(id) ?? id}` : `Couldn't save ${id}: ${plain.text}`, { step: "save", tone: already ? "neutral" : "warn" });
      } else {
        titles.set(out.arxiv_id, out.title);
        controller.note(`Saved “${out.title}”`, { step: "save" });
      }
    } else if (data.name === "write_digest") {
      if (data.isError || !out) controller.note("Writing the digest didn't work; the agent may try again.", { step: "write", tone: "warn" });
      else controller.step("write", { state: "done", detail: plural(out.entries, "paper") });
    }
  }

  async function start() {
    const list = people.values();
    const day = date.value();
    if (!list.length || !date.valid() || !app.lock.take(`writing the ${formatShortDay(day)} digest`)) return;
    titles = new Map();
    shownDate = null;
    result.replaceChildren();
    update();
    const startPromise = run.start({ people: list, date: day });
    run.setTitle(`Writing the digest for ${formatShortDay(day)}`);
    const outcome = await startPromise;
    app.lock.release();
    await app.files.refresh();
    if (outcome.verdict) {
      await app.save((state) => {
        state.digests[day] = { valid: outcome.verdict.valid, score: outcome.verdict.score, message: outcome.verdict.message, details: outcome.verdict.details, checkedAt: new Date().toISOString(), answer: outcome.answer };
      });
    }
    if (outcome.status === "cancelled") {
      result.replaceChildren(banner({ tone: "neutral", title: "Stopped. Papers already saved stay in your library." }));
      update();
      return;
    }
    if (outcome.status === "error") {
      result.replaceChildren(errorCard({ message: outcome.error, rules: ERROR_RULES, title: outcome.startFailed ? "Couldn't start the digest." : undefined, actions: [h("button", { type: "button", class: "button small", text: "Try again", onclick: start })] }));
      update();
      return;
    }
    await showDigest(day, { fresh: true });
  }

  // ------------------------------------------------------------------ showing a digest
  function verdictWords(verdict, day) {
    const details = verdict.details ?? {};
    if (verdict.valid) {
      const count = details.papers?.length ?? 0;
      if (!count) return { tone: "neutral", title: `No new papers from these people on ${formatShortDay(day)}.`, body: "arXiv shows none, so there was nothing to save.", score: "" };
      return { tone: "ok", title: `Checked against arXiv: ${count === 1 ? "the new paper is in the digest, with its source saved." : `all ${count} new papers are in the digest, with their sources saved.`}`, score: "" };
    }
    if (details.expected) {
      return { tone: "bad", title: "The agent didn't write a digest.", body: `arXiv lists ${plural(details.expected.length, "paper")} for this day.`, score: "", actions: [h("button", { type: "button", class: "button small", text: "Try again", onclick: () => (date.set(day), start()) })] };
    }
    if (details.problems) {
      const { expected, wrong, correct } = tally(details.problems, verdict.score);
      const needing = expected - correct;
      return {
        tone: "warn",
        title: needing ? `${plural(needing, "paper needs", "papers need")} attention.` : `${plural(wrong, "entry")} shouldn't be in the digest.`,
        body: [`${correct} of ${expected} correct`, wrong ? `${plural(wrong, "entry")} shouldn't be there` : null].filter(Boolean).join(" · "),
        score: "",
      };
    }
    return { tone: "bad", title: "The digest file couldn't be checked.", score: "" };
  }

  /** How many papers arXiv lists (from the score), how many entries are wrong, how many are right. */
  function tally(problems, score) {
    const flagged = Object.values(problems).map((list) => list.map(digestProblem));
    const wrong = flagged.filter((list) => list.some((one) => one.wrong)).length;
    const listedWithProblems = flagged.length - wrong;
    // score = correct / expected and the problem papers among them are expected - correct.
    const expected = score < 1 ? Math.round(listedWithProblems / (1 - score)) : listedWithProblems;
    return { expected, wrong, correct: expected - listedWithProblems };
  }

  async function showDigest(day, { fresh = false } = {}) {
    shownDate = day;
    date.set(day);
    update();
    result.replaceChildren(skeleton({ lines: 4, block: true }));
    let digest;
    let markdown = "";
    try {
      digest = await readJSON(`docs/digest-${day}.json`);
    } catch (problem) {
      const check = app.state().digests[day];
      result.replaceChildren(check ? verdictBanner(check, (verdict) => verdictWords(verdict, day)) : banner({ tone: "bad", title: `Couldn't open the digest for ${formatShortDay(day)}.`, body: problem.message }));
      return;
    }
    try {
      markdown = await readText(`docs/digest-${day}.md`);
    } catch {
      markdown = ""; // the Copy as Markdown button is left out
    }
    const check = app.state().digests[day];
    const problems = check?.details?.problems ?? {};
    const entries = Array.isArray(digest.entries) ? digest.entries : [];
    const listed = new Set(entries.map((entry) => entry.arxiv_id));
    const missing = Object.entries(problems).filter(([id, list]) => !listed.has(id) && list.some((one) => digestProblem(one).missing));
    const followed = new Set(people.values());

    const verdict = check
      ? h("div", { class: "stack verdict-block" }, verdictBanner(check, (one) => verdictWords(one, day)), fresh ? null : h("p", { class: "muted small-text checked-at", text: `Checked ${formatWhen(check.checkedAt)}` }))
      : banner({ tone: "neutral", title: "Not checked by this page.", body: "This digest was made elsewhere (for example in chat). Write it again here to check it against arXiv." });

    const count = entries.length;
    const head = h(
      "div",
      { class: "digest-head" },
      h("div", { class: "card-titles" }, h("h2", { text: `Digest for ${formatLongDay(day)}` }), h("p", { class: "muted", text: plural(count, "paper") })),
      h("div", { class: "card-actions" }, markdown ? copyButton({ text: markdown, label: "Copy as Markdown" }) : null, count ? h("button", { type: "button", class: "button ghost small", onclick: () => app.go("library") }, icon("folder", { size: 15 }), h("span", { text: "Open in Library" })) : null),
    );

    const cards = [
      ...entries.map((entry) => entryCard(entry, day, problems[entry.arxiv_id] ?? [], followed)),
      ...missing.map(([id, list]) => entryCard({ arxiv_id: id, title: titles.get(id) ?? `arXiv ${id}`, authors: [], summary: "", link: `https://arxiv.org/abs/${id}` }, day, list, followed, true)),
    ];
    const answer = check?.answer;
    result.replaceChildren(
      ...[
        verdict,
        h("section", { class: "digest-paper-list", "aria-label": `Digest for ${day}` }, head, cards.length ? h("ol", { class: "entry-list" }, cards) : null),
        answer ? h("details", { class: "disclosure agent-note" }, h("summary", {}, icon("chevron", { size: 16 }), h("span", { class: "disclosure-label", text: "The agent's note" })), h("div", { class: "disclosure-body" }, h("p", { text: answer }))) : null,
      ].filter(Boolean),
    );
    renderEarlier();
  }

  function entryCard(entry, day, problemList, followed, missing = false) {
    const plain = problemList.map(digestProblem);
    const wrong = plain.some((one) => one.wrong);
    // The verdict outranks the file list: a folder the check didn't accept isn't shown as saved.
    const folder = plain.some((one) => one.unsaved) ? null : app.files.list.find((file) => file.path.startsWith("docs/raw/") && file.path.includes(`-${entry.arxiv_id}-${day}/`))?.path.split("/").slice(0, 3).join("/");
    const fileCount = folder ? app.files.list.filter((file) => file.path.startsWith(`${folder}/`)).length : 0;
    const lines = String(entry.summary ?? "").split("\n").filter((line) => line.trim());
    return h(
      "li",
      { class: `entry${wrong ? " wrong" : ""}${missing ? " missing" : ""}${plain.length ? " flagged" : ""}` },
      h("div", { class: "entry-top" }, h("h3", { class: "entry-title", text: entry.title }), h("span", { class: "paper-id" }, h("code", { text: entry.arxiv_id }), copyButton({ text: entry.arxiv_id, iconOnly: true, label: `Copy arXiv id ${entry.arxiv_id}` }))),
      entry.authors?.length ? h("p", { class: "paper-authors" }, entry.authors.map((author, index) => [index ? ", " : "", followed.has(author) ? h("strong", { text: author }) : author])) : null,
      lines.length ? h("div", { class: "entry-summary" }, lines.map((line) => h("p", { text: line }))) : null,
      plain.length ? h("ul", { class: "entry-problems", "aria-label": "Problems found" }, plain.map((one) => h("li", { class: "pill tone-warn" }, icon("alert", { size: 14 }), one.text))) : null,
      h(
        "div",
        { class: "entry-foot" },
        folder ? h("span", { class: "pill tone-ok" }, icon("check", { size: 14 }), `Source saved · ${plural(fileCount, "file")}`) : missing || wrong || plain.some((one) => one.unsaved) ? null : h("span", { class: "pill tone-neutral", text: "No saved source" }),
        folder ? h("button", { type: "button", class: "button small", text: "Open files", onclick: () => app.go("library", { folder }) }) : null,
        copyButton({ text: entry.link, label: "Copy link" }),
      ),
    );
  }

  run.subscribe(update);
  app.lock.on(update);
  app.files.on(update);
  update();

  return {
    element,
    refresh() {
      people.set(app.state().people);
      update();
    },
    shown() {
      if (!people.values().length) people.focus();
    },
  };
}
