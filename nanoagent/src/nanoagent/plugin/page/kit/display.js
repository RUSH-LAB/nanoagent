// Things a result shows: pills, disclosures and tables. Every tone is a word as well as a colour.

import { h, icon } from "./dom.js";

/** The tones kit components take: `ok` (green), `warn` (amber), `bad` (red), `info` (accent), `neutral` (grey). */
export const TONES = Object.freeze(["ok", "warn", "bad", "info", "neutral"]);
const TONE_ICON = { ok: "check", warn: "alert", bad: "error", info: "info", neutral: "info" };

function checkTone(tone) {
  if (!TONES.includes(tone)) throw new Error(`Unknown tone ${JSON.stringify(tone)}: expected one of ${TONES.join(", ")}.`);
  return tone;
}

/**
 * A short status word in a coloured pill, e.g. "Hallucinated", "Saved".
 * @param {string} text Always shown: the colour never carries the meaning alone.
 * @param {string} [tone] One of {@link TONES}, default "neutral".
 * @param {{icon?: boolean}} [options] `icon: true` adds the tone's icon.
 * @returns {HTMLElement}
 */
export function statusPill(text, tone = "neutral", { icon: withIcon = false } = {}) {
  return h("span", { class: `pill tone-${checkTone(tone)}` }, withIcon ? icon(TONE_ICON[tone], { size: 14 }) : null, text);
}

/**
 * A collapsible section: a `<details>` with a clickable summary line.
 * @param {{summary: string|Node, open?: boolean, hint?: string, className?: string, onToggle?: (open: boolean) => void}} options
 *   `hint` is a muted note at the right of the summary (e.g. "101 companies").
 * @param {...(Node|string)} children Shown when open.
 * @returns {HTMLDetailsElement}
 */
export function disclosure({ summary, open = false, hint, className = "", onToggle } = {}, ...children) {
  const element = h(
    "details",
    { class: `disclosure ${className}`.trim(), open },
    h("summary", {}, icon("chevron", { size: 16 }), h("span", { class: "disclosure-label" }, summary), hint ? h("span", { class: "muted disclosure-hint", text: hint }) : null),
    h("div", { class: "disclosure-body" }, children),
  );
  if (onToggle) element.addEventListener("toggle", () => onToggle(element.open));
  return element;
}

/**
 * A sortable, filterable table that turns into one card per row when its container is narrow
 * (each cell then shows its column label).
 *
 * @param {object} options
 * @param {Array<{key: string, label: string, value?: (row: object) => string|number|null, render?: (row: object) => Node|string, numeric?: boolean, sortable?: boolean, primary?: boolean}>} options.columns
 *   `value` gives the sort and filter value (default `row[key]`); `render` the cell (default the
 *   value); `numeric` right-aligns with tabular figures; `primary` is the card's title on narrow.
 * @param {object[]} options.rows
 * @param {{key: string, dir?: "asc"|"desc"}} [options.sort] The initial sort.
 * @param {string} [options.filterPlaceholder] Shows a filter box over the text of every column.
 * @param {(row: object) => string} [options.rowClass] Extra classes for a row (e.g. "highlight").
 * @param {string} [options.caption] An accessible caption, shown visually hidden.
 * @param {string} [options.empty] What an empty (or fully filtered) table says.
 * @param {number} [options.limit] Show at most this many rows, then a "Show all N" button.
 * @returns {{element: HTMLElement, setRows: (rows: object[]) => void}}
 */
export function dataTable({ columns, rows, sort, filterPlaceholder, rowClass, caption, empty = "Nothing to show.", limit }) {
  let data = rows;
  let order = sort ? { key: sort.key, dir: sort.dir ?? "asc" } : null;
  let showAll = false;
  const valueOf = (column, row) => (column.value ? column.value(row) : row[column.key]);
  const filter = filterPlaceholder ? h("input", { type: "search", class: "input", placeholder: filterPlaceholder, "aria-label": filterPlaceholder }) : null;
  const status = h("p", { class: "muted small-text table-status", "aria-live": "polite" });
  const head = h("thead");
  const body = h("tbody");
  const more = h("button", { type: "button", class: "button small", hidden: true, onclick: () => ((showAll = true), render()) });

  const renderHead = () => {
    head.replaceChildren(
      h(
        "tr",
        {},
        columns.map((column) => {
          const sortable = column.sortable !== false;
          const sorted = order?.key === column.key;
          const th = h("th", { scope: "col", class: column.numeric ? "numeric" : null, "aria-sort": sorted ? (order.dir === "asc" ? "ascending" : "descending") : null });
          if (!sortable) th.textContent = column.label;
          else {
            th.append(
              h(
                "button",
                {
                  type: "button",
                  class: "sort-button",
                  onclick: () => {
                    order = { key: column.key, dir: sorted && order.dir === "asc" ? "desc" : "asc" };
                    render();
                  },
                },
                column.label,
                h("span", { class: `sort-mark${sorted ? " on" : ""}`, "aria-hidden": "true", text: sorted ? (order.dir === "asc" ? "▲" : "▼") : "↕" }),
              ),
            );
          }
          return th;
        }),
      ),
    );
  };

  const render = () => {
    renderHead();
    const needle = filter?.value.trim().toLowerCase() ?? "";
    let shown = needle ? data.filter((row) => columns.some((column) => String(valueOf(column, row) ?? "").toLowerCase().includes(needle))) : [...data];
    if (order) {
      const column = columns.find((one) => one.key === order.key);
      const sign = order.dir === "asc" ? 1 : -1;
      shown.sort((a, b) => {
        const x = valueOf(column, a);
        const y = valueOf(column, b);
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sign;
      });
    }
    const total = shown.length;
    if (limit && !showAll && total > limit) shown = shown.slice(0, limit);
    more.hidden = shown.length === total;
    more.textContent = `Show all ${total}`;
    status.textContent = needle ? `${total} of ${data.length} shown` : "";
    body.replaceChildren(
      ...(total
        ? shown.map((row) =>
            h(
              "tr",
              { class: rowClass?.(row) || null },
              columns.map((column) => {
                const content = column.render ? column.render(row) : valueOf(column, row);
                return h("td", { class: [column.numeric ? "numeric" : "", column.primary ? "primary" : ""].filter(Boolean).join(" ") || null, "data-label": column.label }, content ?? "—");
              }),
            ),
          )
        : [h("tr", { class: "empty-row" }, h("td", { colspan: String(columns.length), text: empty }))]),
    );
  };

  filter?.addEventListener("input", render);
  render();
  const element = h(
    "div",
    { class: "data-table" },
    filter ? h("div", { class: "table-tools" }, filter, status) : null,
    h("div", { class: "table-scroll" }, h("table", {}, caption ? h("caption", { class: "visually-hidden", text: caption }) : null, head, body)),
    more,
  );
  return {
    element,
    setRows(next) {
      data = next;
      showAll = false;
      render();
    },
  };
}

