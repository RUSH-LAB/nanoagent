// How this plugin's page draws check-bibtex's verdicts: a count per label, then a table of the
// entries with each one's label, its closest reference and what to fix.
import { dataTable, h, plural, statusPill } from "./kit/components.js";

const LABELS = {
  real: { word: "Real", tone: "ok" },
  fixable: { word: "Fixable", tone: "warn" },
  invented: { word: "Invented", tone: "bad" },
  unreadable: { word: "Unreadable", tone: "neutral" },
};
const FIELDS = { entry_type: "Type", title: "Title", authors: "Authors", year: "Year", venue: "Venue", doi: "DOI" };
const ORDER = Object.keys(LABELS);

function fix(verdict) {
  if (verdict.label === "fixable") return `Fix ${verdict.differs.map((field) => FIELDS[field]).join(", ")}`;
  if (verdict.label === "unreadable") return verdict.error;
  if (verdict.label === "invented") return "No reference is close";
  return null;
}

export default {
  CheckOutput: ({ verdicts }) =>
    h(
      "div",
      {},
      h(
        "p",
        { class: "bib-counts" },
        ORDER.filter((label) => verdicts.some((verdict) => verdict.label === label)).map((label) =>
          statusPill(`${verdicts.filter((verdict) => verdict.label === label).length} ${LABELS[label].word.toLowerCase()}`, LABELS[label].tone),
        ),
      ),
      dataTable({
        caption: `${plural(verdicts.length, "entry", "entries")} checked`,
        columns: [
          { key: "key", label: "Entry", primary: true, render: (verdict) => h("code", { text: verdict.key }) },
          { key: "title", label: "Title" },
          { key: "label", label: "Verdict", value: (verdict) => ORDER.indexOf(verdict.label), render: (verdict) => statusPill(LABELS[verdict.label].word, LABELS[verdict.label].tone) },
          { key: "closest", label: "Closest reference", render: (verdict) => (verdict.closest ? h("code", { text: verdict.closest }) : null) },
          { key: "fix", label: "What to fix", value: fix, sortable: false },
        ],
        rows: verdicts,
        filterPlaceholder: verdicts.length > 12 ? "Filter entries" : undefined,
      }).element,
    ),
};
