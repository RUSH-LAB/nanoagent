// The page's own logic over what the check reports: counting entries in a file, the label each
// entry shows (the verifier decides; the page never judges an entry itself), the closest reference
// and the fields that differ (a display aid), plain words for errors, and the saved report.

/** The six fields an entry is compared in, with the words the page shows for them. */
export const FIELDS = [
  { key: "entry_type", label: "Type" },
  { key: "title", label: "Title" },
  { key: "authors", label: "Authors" },
  { key: "year", label: "Year" },
  { key: "venue", label: "Venue" },
  { key: "doi", label: "DOI" },
];

const ENTRY_START = /^\s*@(?!comment\b|string\b|preamble\b)\w+\s*\{/gim;

/** How many entries a .bib text seems to hold (it only labels the card and the button). */
export function countEntries(text) {
  return (text.match(ENTRY_START) ?? []).length;
}

/** fileDrop's `inspect`: a short summary of a .bib text, or an Error in plain words. */
export function inspectBib(text) {
  if (text.includes("�")) throw new Error("This doesn't look like a text .bib file. Save it as UTF-8 and try again.");
  const count = countEntries(text);
  if (!count) throw new Error("No BibTeX entries found in this file.");
  return `about ${count} ${count === 1 ? "entry" : "entries"}`;
}

/** Why an entry has no record, in plain words, with the parser's own reason kept for the curious. */
export function unreadableReason(error) {
  const raw = String(error ?? "");
  if (raw.startsWith("unparseable:")) {
    return { text: "The entry is malformed, so it can't match anything (often a missing brace or quote).", raw: raw.slice("unparseable:".length).trim() };
  }
  const known = [
    ["missing", (rest) => `It has no ${rest.replace(/^missing /, "").replace("author", "authors")}.`],
    ["has a field twice", () => "A field appears twice."],
    ["has both a journal and a booktitle", () => "It lists both a journal and a proceedings."],
  ];
  const reason = raw.replace(/^not in the schema: /, "");
  for (const [start, words] of known) if (reason.startsWith(start)) return { text: words(reason), raw: null };
  return { text: "It can't be read into the six compared fields.", raw: reason };
}

function same(field, a, b) {
  if (field === "authors") return a.length === b.length && a.every((name, index) => name === b[index]);
  return a === b;
}

/** The reference entry exactly equal to `record` in all six fields, or null. */
export function exactMatch(record, references) {
  return references.find((entry) => entry.record && FIELDS.every(({ key }) => same(key, record[key], entry.record[key]))) ?? null;
}

/**
 * The reference entry most like `record` and the fields that differ, or null when none is close:
 * it must share the title or the DOI, or at least four of the six fields. Ties go to a shared DOI
 * or title, then to the first in file order.
 */
export function closestReference(record, references) {
  let best = null;
  for (const entry of references) {
    if (!entry.record) continue;
    const shared = FIELDS.filter(({ key }) => same(key, record[key], entry.record[key])).map(({ key }) => key);
    const anchored = shared.includes("title") || (record.doi !== null && shared.includes("doi"));
    const score = shared.length * 2 + (anchored ? 1 : 0);
    if (!best || score > best.score) best = { entry, shared, anchored, score };
  }
  if (!best || !(best.anchored || best.shared.length >= 4)) return null;
  return { entry: best.entry, differs: FIELDS.filter(({ key }) => !best.shared.includes(key)) };
}

/** Two strings split around the span where they differ: {before, mine, theirs, after}. */
export function spanDiff(mine, theirs) {
  let start = 0;
  while (start < mine.length && start < theirs.length && mine[start] === theirs[start]) start += 1;
  let end = 0;
  while (end < mine.length - start && end < theirs.length - start && mine[mine.length - 1 - end] === theirs[theirs.length - 1 - end]) end += 1;
  return { before: mine.slice(0, start), mine: mine.slice(start, mine.length - end), theirs: theirs.slice(start, theirs.length - end), after: mine.slice(mine.length - end) };
}

/** What differs between two author lists: names only in yours, names only in the reference, or the order. */
export function authorsDiff(mine, theirs) {
  const extra = mine.filter((name) => !theirs.includes(name));
  const missing = theirs.filter((name) => !mine.includes(name));
  return { extra, missing, reordered: !extra.length && !missing.length };
}

/** "Vaswani, Shazeer, Parmar +5": up to three surnames. */
export function shortAuthors(authors) {
  const surname = (name) => (name.includes(",") ? name.split(",")[0] : name.split(" ").pop()).trim();
  const names = authors.slice(0, 3).map(surname).join(", ");
  return authors.length > 3 ? `${names} +${authors.length - 3}` : names;
}

/**
 * The label each raw entry shows, from the verifier (the authority) and the agent's last submitted
 * labels: `{labels: Map(key -> {label: "real"|"hallucinated"|null, corrected}), extra: [keys]}`.
 * `label: null` means the agent gave no usable verdict for it. With no verdicts at all, `labels` is empty.
 */
export function labelsFrom(verdict, agentLabels, rawKeys) {
  const labels = new Map();
  const extra = [];
  if (verdict.valid) {
    for (const [key, label] of Object.entries(verdict.details?.expected ?? {})) labels.set(key, { label, corrected: false });
    return { labels, extra };
  }
  const problems = verdict.details?.problems;
  if (!problems) return { labels, extra };
  const keys = rawKeys ?? [...new Set([...Object.keys(agentLabels ?? {}), ...Object.keys(problems)])].filter((key) => problems[key] !== "not a raw entry");
  for (const key of keys) {
    const problem = problems[key];
    if (problem === undefined) labels.set(key, { label: agentLabels?.[key] ?? null, corrected: false });
    else {
      const truth = /the entry is (real|hallucinated)$/.exec(problem);
      labels.set(key, { label: truth ? truth[1] : null, corrected: Boolean(truth) });
    }
  }
  for (const [key, problem] of Object.entries(problems)) if (problem === "not a raw entry") extra.push(key);
  return { labels, extra };
}

/** A run's error message in plain words, and which card it belongs to ("raw", "reference" or null). */
export const ERROR_RULES = [
  {
    id: "reference",
    match: /reference entries do not parse into the schema: (.+)$/,
    text: (_, found) => `Some of your trusted references can't be read: ${found[1]}. Each needs a title, authors and a year, no repeated fields, and only one of journal or booktitle.`,
  },
  { id: "twice", match: /(\S+\.bib) has these keys twice: (.+)$/, text: (_, found) => (found[2].includes(",") ? `The keys ${found[2]} each appear twice in this file. Rename one of each pair and try again.` : `The key ${found[2]} appears twice in this file. Rename one and try again.`) },
  { id: "block", match: /(\S+\.bib) line (\d+) is not an entry with a key/, text: (_, found) => `Line ${found[2]} of this file isn't a BibTeX entry with a citation key.` },
  { id: "missing", match: /no file at (\S+)/, text: "The file is no longer in your workspace. Add it again." },
  { id: "unavailable", match: /plugin not found|unknown plugin/i, text: "The checker is unavailable right now. Try again later." },
];

/** Which card an error message is about, from the file it names. */
export function errorCard(message, paths) {
  if (/reference entries do not parse/.test(message)) return "reference";
  for (const [card, path] of Object.entries(paths)) {
    const name = path.split("/").pop();
    if (message.includes(`no file at ${path}`) || message.includes(`${name} has these keys twice`) || message.includes(`${name} line `)) return card;
  }
  return null;
}

/** The report saved to the workspace, as Markdown. */
export function reportMarkdown({ headline, trust, rows, answer, files }) {
  const lines = ["# BibTeX check", "", `Checked ${files.raw} against ${files.reference}.`, "", `**${headline}**`, "", trust, ""];
  const group = (title, items, describe) => {
    if (!items.length) return;
    lines.push(`## ${title}`, "");
    for (const row of items) lines.push(`- \`${row.key}\`${row.record ? `: ${row.record.title}` : ""}${describe(row)}`);
    lines.push("");
  };
  group("Hallucinated", rows.filter((row) => row.label === "hallucinated"), (row) => (row.why.length ? `\n${row.why.map((line) => `  - ${line}`).join("\n")}` : ""));
  group("Not checked", rows.filter((row) => row.label === null), () => "");
  group("Real", rows.filter((row) => row.label === "real"), (row) => (row.match ? ` (matches \`${row.match}\`)` : ""));
  if (answer) lines.push("## The checker's summary", "", answer, "");
  return lines.join("\n");
}
