// Things a page shows: cards, banners, pills, disclosures, meters, tables, empty states,
// skeletons and the page's layout pieces. Every tone is a word as well as a colour.

import { h, icon, nextId } from "./dom.js";

/** The tones kit components take: `ok` (green), `warn` (amber), `bad` (red), `info` (accent), `neutral` (grey). */
export const TONES = Object.freeze(["ok", "warn", "bad", "info", "neutral"]);
const TONE_ICON = { ok: "check", warn: "alert", bad: "error", info: "info", neutral: "info" };

function checkTone(tone) {
  if (!TONES.includes(tone)) throw new Error(`Unknown tone ${JSON.stringify(tone)}: expected one of ${TONES.join(", ")}.`);
  return tone;
}

/**
 * A rounded content card.
 * @param {{title?: string|Node, subtitle?: string|Node, actions?: Node[], tone?: string, size?: "normal"|"large", className?: string, label?: string}} options
 *   `actions` sit at the right of the title row; `size: "large"` uses the 20 px radius for a
 *   page's main result; `tone` tints the border.
 * @param {...(Node|string)} children The card's body.
 * @returns {HTMLElement} A `<section class="card">`.
 */
export function card({ title, subtitle, actions = [], tone, size = "normal", className = "", label } = {}, ...children) {
  const headingId = title ? nextId("card") : null;
  const head =
    title || actions.length
      ? h(
          "header",
          { class: "card-head" },
          h("div", { class: "card-titles" }, title ? h("h2", { id: headingId }, title) : null, subtitle ? h("p", { class: "muted" }, subtitle) : null),
          actions.length ? h("div", { class: "card-actions" }, actions) : null,
        )
      : null;
  return h(
    "section",
    {
      class: ["card", size === "large" ? "large" : "", tone ? `tone-${checkTone(tone)}` : "", className].filter(Boolean).join(" "),
      "aria-labelledby": headingId,
      "aria-label": headingId ? null : label,
    },
    head,
    children,
  );
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
 * A message strip with an icon, a headline and optional lines, actions and a collapsed details
 * section; the shape of verdicts, errors and notices.
 * @param {{tone?: string, title: string, body?: string|Node, lines?: Array<string|Node>, actions?: Node[], details?: Node|string, detailsLabel?: string, live?: boolean}} options
 *   `details` is shown under a closed "Details" disclosure (`detailsLabel`). `live` (default true)
 *   announces the banner: `role="alert"` for `bad`, `role="status"` otherwise.
 * @returns {HTMLElement}
 */
export function banner({ tone = "info", title, body, lines = [], actions = [], details, detailsLabel = "Details", live = true }) {
  checkTone(tone);
  return h(
    "div",
    { class: `banner tone-${tone}`, role: live ? (tone === "bad" ? "alert" : "status") : null },
    h("span", { class: "banner-icon" }, icon(TONE_ICON[tone], { size: 20 })),
    h(
      "div",
      { class: "banner-body" },
      h("p", { class: "banner-title", text: title }),
      body ? h("p", { class: "banner-text" }, body) : null,
      lines.length ? h("ul", { class: "banner-lines" }, lines.map((line) => h("li", {}, line))) : null,
      actions.length ? h("div", { class: "banner-actions" }, actions) : null,
      details ? disclosure({ summary: detailsLabel, className: "banner-details" }, typeof details === "string" ? h("pre", { text: details }) : details) : null,
    ),
  );
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
 * A labelled horizontal bar for a value on a scale, with an optional target band; e.g. "Protein
 * 82 g" against "at least 90 g", or a winning chance of 64 %.
 * @param {{label: string, value: number, min?: number, max?: number, band?: [number|null, number|null], tone?: string, valueText?: string, caption?: string}} options
 *   `band` draws the target range (`null` for an open end); `valueText` is what the number says
 *   (default the value); `caption` is a muted line under the bar (e.g. "12 g short").
 * @returns {HTMLElement}
 */
export function meter({ label, value, min = 0, max = 1, band, tone = "info", valueText, caption }) {
  checkTone(tone);
  const span = max - min || 1;
  const at = (number) => `${Math.min(100, Math.max(0, ((number - min) / span) * 100))}%`;
  const track = h("div", { class: "meter-track" }, h("span", { class: "meter-fill", style: `width: ${at(value)}` }));
  if (band) {
    const [low, high] = band;
    const left = low === null || low === undefined ? "0%" : at(low);
    const right = high === null || high === undefined ? "100%" : at(high);
    track.prepend(h("span", { class: "meter-band", style: `left: ${left}; width: calc(${right} - ${left})` }));
  }
  const text = valueText ?? String(value);
  return h(
    "div",
    { class: `meter tone-${tone}` },
    h("div", { class: "meter-head" }, h("span", { class: "meter-label", text: label }), h("span", { class: "meter-value", text })),
    h("div", { role: "meter", "aria-label": label, "aria-valuemin": String(min), "aria-valuemax": String(max), "aria-valuenow": String(value), "aria-valuetext": text }, track),
    caption ? h("p", { class: "meter-caption", text: caption }) : null,
  );
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

/**
 * A friendly placeholder for "nothing here yet", with what to do next.
 * @param {{title: string, body?: string|Node, actions?: Node[], icon?: string}} options
 * @param {...(Node|string)} children Extra content (e.g. example chips or {@link howItWorks}).
 * @returns {HTMLElement}
 */
export function emptyState({ title, body, actions = [], icon: name }, ...children) {
  return h(
    "div",
    { class: "empty-state" },
    name ? h("span", { class: "empty-icon" }, icon(name, { size: 22 })) : null,
    h("p", { class: "empty-title", text: title }),
    body ? h("p", { class: "muted" }, body) : null,
    children,
    actions.length ? h("div", { class: "empty-actions" }, actions) : null,
  );
}

/**
 * Numbered steps, e.g. the plugin's `product.steps` as a "How it works" row.
 * @param {string[]} steps
 * @param {{title?: string}} [options] Default title "How it works"; `title: ""` drops it.
 * @returns {HTMLElement}
 */
export function howItWorks(steps, { title = "How it works" } = {}) {
  return h("div", { class: "how-it-works" }, title ? h("h3", { text: title }) : null, h("ol", {}, steps.map((step) => h("li", {}, h("span", { text: step })))));
}

/**
 * Grey shimmering placeholders standing in for content that is on its way.
 * @param {{lines?: number, block?: boolean}} [options] `lines` text bars (default 3); `block` adds
 *   a tall box first (e.g. a card or chart).
 * @returns {HTMLElement}
 */
export function skeleton({ lines = 3, block = false } = {}) {
  return h(
    "div",
    { class: "skeleton", "aria-hidden": "true" },
    block ? h("span", { class: "skeleton-block" }) : null,
    Array.from({ length: lines }, (_, index) => h("span", { class: "skeleton-line", style: `width: ${[92, 76, 60, 84][index % 4]}%` })),
  );
}

/**
 * A bar of actions that sticks to the bottom of the viewport: always (`sticky: "always"`), or
 * only on narrow screens (`"narrow"`, the default), e.g. a page's primary button or "3 selected ·
 * Save 3 sources". It respects the safe-area inset.
 * @param {{sticky?: "narrow"|"always"}} [options]
 * @param {...(Node|string)} children
 * @returns {HTMLElement}
 */
export function actionBar({ sticky = "narrow" } = {}, ...children) {
  return h("div", { class: `action-bar sticky-${sticky}` }, children);
}

/**
 * Two columns side by side on wide screens, one column (main first unless `asideFirst`) under
 * 880 px. `aside` is the narrower column (default 360 px wide).
 * @param {{main: Node, aside: Node, asideWidth?: string, asideFirst?: boolean, asideSide?: "left"|"right"}} options
 * @returns {HTMLElement}
 */
export function columns({ main, aside, asideWidth = "360px", asideFirst = false, asideSide = "right" }) {
  return h(
    "div",
    { class: `columns aside-${asideSide}${asideFirst ? " aside-first" : ""}`, style: `--aside-width: ${asideWidth}` },
    h("div", { class: "column-main" }, main),
    h("div", { class: "column-aside" }, aside),
  );
}
