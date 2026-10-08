// The page's arXiv rules, as pure functions: ids and links, the search query built from what the
// user typed, folder names (mirroring src/plugin/save.py), dates, and the plugin's error messages
// in plain words.

// src/plugin/download.py's ARXIV_ID.
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;

/** The arXiv id in `text` when it is an id ("1706.03762v5", "arXiv:hep-th/9901001") or an arXiv link; else null. */
export function parseId(text) {
  const value = text.trim().replace(/^arxiv:\s*/i, "");
  if (ARXIV_ID.test(value)) return value;
  const link = value.match(/^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|e-print|src|html)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i);
  return link && ARXIV_ID.test(link[1]) ? link[1] : null;
}

/** "1706.03762v7" -> "1706.03762". */
export const baseId = (id) => id.replace(/v\d+$/, "");

/** Where the page saves a paper: one folder per paper, without the version; legacy ids' "/" as "_" (like save.py). */
export const paperFolder = (id) => `papers/${baseId(id).replace("/", "_")}`;

export const FIELDS = [
  { value: "all", label: "Anywhere" },
  { value: "ti", label: "Title" },
  { value: "au", label: "Author" },
  { value: "abs", label: "Abstract" },
];

export const SUBJECTS = [
  { value: "", label: "Any subject" },
  { value: "cs.AI", label: "Artificial Intelligence" },
  { value: "cs.CL", label: "Computation and Language" },
  { value: "cs.CV", label: "Computer Vision" },
  { value: "cs.LG", label: "Machine Learning" },
  { value: "stat.ML", label: "Statistics: Machine Learning" },
  { value: "cs.RO", label: "Robotics" },
  { value: "cs.CR", label: "Cryptography and Security" },
  { value: "quant-ph", label: "Quantum Physics" },
  { value: "hep-th", label: "High Energy Physics: Theory" },
];

/**
 * The arXiv search_query for what the user typed. Anywhere: every word (or "quoted phrase") must
 * appear; Title/Author/Abstract: the text as one phrase, without quotation marks.
 */
export function buildQuery(text, field, subject) {
  const clean = text.trim();
  let terms;
  if (field === "all") {
    const parts = [...clean.matchAll(/"([^"]+)"|(\S+)/g)].map((match) => (match[1] ? `"${match[1].trim()}"` : match[2].replace(/["():]/g, ""))).filter(Boolean);
    terms = parts.map((part) => `all:${part}`).join(" AND ");
  } else {
    terms = `${field}:"${clean.replace(/"/g, "").replace(/\s+/g, " ").trim()}"`;
  }
  return subject ? `${terms} AND cat:${subject}` : terms;
}

// Dates in the viewer's own language.
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const LONG_DAY = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });

const asDate = (value) => new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
/** "Jun 12, 2017" (in en-US) */
export const formatDay = (value) => DAY.format(asDate(value));
/** "Wednesday, September 9, 2026" (in en-US) */
export const formatLongDay = (value) => LONG_DAY.format(asDate(value));
/** "Sep 9" (in en-US) */
export const formatShortDay = (value) => SHORT_DAY.format(asDate(value));
/** "Sep 10, 07:42 AM" (in en-US), in the viewer's time zone. */
export const formatWhen = (value) => TIME.format(new Date(value));

/** The person a digest search looked up: `au:"Yoshua Bengio" AND ...` -> "Yoshua Bengio". */
export function personOf(query) {
  return String(query ?? "").match(/au:"([^"]+)"/)?.[1] ?? null;
}

/** The plugin's error messages in plain words (kit COMMON_ERRORS follow these). */
export const ERROR_RULES = [
  { id: "query", match: "arXiv rejected the query", text: "arXiv couldn't read that search. Try plain words, or check the arXiv query under Advanced." },
  { id: "id", match: "invalid arXiv id", text: "That isn't an arXiv id. Ids look like 1706.03762 or hep-th/9901001." },
  { id: "exists", match: /File exists|FileExistsError|destination already exists/, text: "This paper is already in your library.", tone: "neutral" },
  { id: "large", match: /exceeds the download limit|exceeds the extraction limit|too many files/, text: "This paper's source is too large to save (over 100 MB, or over 10,000 files)." },
  { id: "unsafe", match: /unsafe archive path|unsupported archive entry/, text: "arXiv's archive for this paper has unsafe entries, so nothing was saved." },
  { id: "missing", match: "arXiv has no paper", text: "arXiv has no paper with that id." },
  { id: "many", match: /(.+?) has 50 or more papers on/, text: (_, found) => `${found[1].split(": ").pop()} has 50 or more papers that day, so the digest couldn't be complete. Remove them or pick another date.` },
  { id: "people", match: "people must be distinct", text: "Each person must be listed once, without quotation marks." },
  { id: "limit", match: /HTTP Error 4(03|29)/, text: "arXiv is limiting requests right now. Wait a minute and try again." },
  { id: "network", match: /URLError|timed out|Connection|HTTP Error 5\d\d|Temporary failure in name resolution/, text: "Couldn't reach arXiv. It may be busy; try again in a minute." },
  { id: "checked", match: /plugin output verification failed:?\s*(.*)/, text: (_, found) => `The result failed the plugin's own check, so it wasn't trusted${found[1] ? `: ${found[1]}` : "."}` },
];

/** A digest problem from verifier/daily.py in plain words, with whether the entry should not be there. */
export function digestProblem(text) {
  if (text.startsWith("title differs")) return { text: "Title doesn't match arXiv" };
  if (text.startsWith("authors differ")) return { text: "Author list doesn't match arXiv" };
  if (text.startsWith("summary is not")) return { text: "Summary isn't two lines" };
  if (text.startsWith("link is not")) return { text: "Link is wrong" };
  if (text.startsWith("published but missing")) return { text: "Missing from the digest", missing: true };
  if (text.startsWith("no saved source")) return { text: "Source not saved", unsaved: true };
  if (text.startsWith("not a paper arXiv shows")) return { text: "Not one of their papers that day", wrong: true };
  if (text.startsWith("listed twice")) return { text: "Listed twice" };
  if (text.startsWith("id is not of the form")) return { text: "Bad arXiv id", wrong: true };
  return { text };
}

/** The main file of a paper folder from its root file names; null when only reading can tell. */
export function mainFile(rootNames) {
  const tex = rootNames.filter((name) => name.toLowerCase().endsWith(".tex"));
  for (const name of ["main.tex", "ms.tex"]) if (tex.includes(name)) return name;
  return tex.length === 1 ? tex[0] : null;
}

/** True when a `workspace.read` reply holds a PDF (base64 of "%PDF"). */
export const isPdf = (file) => typeof file.base64 === "string" && file.base64.startsWith("JVBERi0");
