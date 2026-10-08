// The nasdaq-drawdown page's own pieces: New York week rules, the join of the agent's prices with
// the verifier's list, the faller list, the change strip, the verdict and error wording.

import { banner, dataTable, disclosure, h, icon } from "./kit/components.js";

export const NEW_YORK = "America/New_York";
const DAY = 86400000;
// How many fallers the list shows before "Show all N" (a crash week can have dozens).
const FALLER_LIMIT = 15;

// ----- Dates (YYYY-MM-DD strings, calendar arithmetic in UTC) -----

const toDate = (iso) => new Date(`${iso}T12:00:00Z`);
const addDays = (iso, days) => new Date(toDate(iso).getTime() + days * DAY).toISOString().slice(0, 10);
const weekday = (iso) => toDate(iso).getUTCDay();
const isWeekend = (iso) => weekday(iso) === 0 || weekday(iso) === 6;

/** The latest weekday strictly before `iso`. */
function weekdayBefore(iso) {
  let day = addDays(iso, -1);
  while (isWeekend(day)) day = addDays(day, -1);
  return day;
}

/** The latest Friday strictly before `iso`. */
function fridayBefore(iso) {
  let day = addDays(iso, -1);
  while (weekday(day) !== 5) day = addDays(day, -1);
  return day;
}

/** The week picker's quick picks for today in New York. */
export function weekPicks(today) {
  const latest = weekdayBefore(today);
  const lastFriday = fridayBefore(today);
  const chips = [
    { label: "Last full week", value: lastFriday },
    { label: "Week before", value: addDays(lastFriday, -7) },
  ];
  if (latest !== lastFriday) chips.push({ label: `Latest close · ${formatDay(latest, { year: false })}`, value: latest });
  return { latest, lastFriday, chips };
}

/** A plain-words problem with a week's last day (and a better day), or null. */
export function dayProblem(value, today) {
  if (value >= today) {
    const latest = weekdayBefore(today);
    return { message: "That day's trading isn't over yet.", fix: { label: `Use ${formatDay(latest, { year: false })}`, value: latest } };
  }
  if (isWeekend(value)) {
    const friday = addDays(value, weekday(value) === 6 ? -1 : -2);
    return { message: "Markets are closed on weekends.", fix: { label: `Use ${formatDay(friday, { year: false })}`, value: friday } };
  }
  return null;
}

/** "Fri, Oct 2, 2026"; `{weekday: false}` drops the day name, `{year: false}` the year. */
export function formatDay(iso, { weekday: withDay = true, year = true } = {}) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: withDay ? "short" : undefined, month: "short", day: "numeric", year: year ? "numeric" : undefined }).format(toDate(iso));
}

/** "Fri, Sep 25 → Fri, Oct 2, 2026" */
export function formatWeek(start, asOf) {
  return start ? `${formatDay(start, { year: start.slice(0, 4) !== asOf.slice(0, 4) })} → ${formatDay(asOf)}` : `Week ending ${formatDay(asOf)}`;
}

// ----- Numbers -----

/** "−14.16%", "+2.10%", "0.00%" with a true minus sign. */
function formatChange(percent) {
  const text = `${Math.abs(percent).toFixed(2)}%`;
  return percent < 0 ? `−${text}` : percent > 0 ? `+${text}` : text;
}

// Closing prices to the cent: Nasdaq's split-adjusted closes carry more decimals (71.145), which
// read as noise beside the others.
const PRICE = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatPrice = (value) => PRICE.format(value);

// The verifier's rule, `end <= start × 0.95`, in exact integer arithmetic (closes have at most 4 decimals).
const fellFivePercent = (start, end) => Math.round(end * 10000) * 100 <= Math.round(start * 10000) * 95;
const changeOf = (start, end) => Math.round((end / start - 1) * 10000) / 100;

/** "Apple Inc. Common Stock" → "Apple Inc." */
function shortName(name) {
  const short = name
    .replace(/\s+(\([A-Z]{2}\)\s+)?((Class|Series) [A-Z]\s+)?(Common Stock|Common Shares|Ordinary Shares|Capital Stock|American Depositary Shares|New York Registry Shares|Subordinate Voting Shares)\b.*$/, "")
    .replace(/,$/, "")
    .trim();
  return short || name;
}

// ----- The run's data -----

/**
 * What the result card shows, from one run: the week and every constituent with its two closes,
 * from the agent's tool outputs (only the calls that succeeded), and the verdict, whose
 * `details.expected` is the authoritative list of fallers.
 */
export function weekFromRun(asOf, outcome) {
  const ok = (name) => outcome.tools.filter((tool) => tool.name === name && !tool.isError && tool.data?.ok);
  const listed = ok("list_constituents").at(-1)?.data ?? null;
  const closes = {};
  for (const { data } of ok("get_closes")) {
    closes[data.date] ??= {};
    for (const row of data.closes) closes[data.date][row.ticker] = row.close;
  }
  const start = listed?.start ?? null;
  return {
    version: 1,
    as_of: asOf,
    start,
    listed_at: listed?.listed_at ?? null,
    ran_at: new Date().toISOString(),
    verdict: outcome.verdict,
    answer: outcome.answer,
    constituents: (listed?.constituents ?? []).map(({ ticker, name }) => ({
      ticker,
      name,
      start_close: closes[start]?.[ticker] ?? null,
      end_close: closes[asOf]?.[ticker] ?? null,
    })),
  };
}

/** Check that a saved week has the shape {@link weekFromRun} writes; throws a plain message if not. */
export function checkSavedWeek(week, path) {
  const fine = week && week.version === 1 && typeof week.as_of === "string" && week.verdict && typeof week.verdict.details?.expected === "object" && Array.isArray(week.constituents);
  if (!fine) throw new Error(`${path} is not a saved week this page can read.`);
  return week;
}

function rowsOf(week) {
  return week.constituents.map((row) => {
    const priced = row.start_close > 0 && row.end_close > 0;
    return { ...row, short: shortName(row.name), change: priced ? changeOf(row.start_close, row.end_close) : null, fell: priced ? fellFivePercent(row.start_close, row.end_close) : null };
  });
}

// ----- Words -----

const listed = (map) => Object.entries(map ?? {}).map(([ticker, change]) => `${ticker} (${formatChange(change)})`).join(", ");

/**
 * The verdict in this page's words (design 3.5): plain words only. The checker's own `message` and
 * `details` are not shown, even folded away: they are a developer's wording of the list above.
 * @param {object} verdict A `task.verdict`.
 * @param {number} fallers How many stocks the card lists, so an empty week reads as a sentence.
 */
function verdictBanner(verdict, fallers) {
  if (verdict.valid) {
    const title = fallers
      ? "Checked. The list matches Nasdaq's closing prices exactly."
      : "Checked. Nasdaq's closing prices confirm that no company fell 5% or more.";
    return banner({ tone: "ok", title });
  }
  const details = verdict.details ?? {};
  const lines = [
    Object.keys(details.missing ?? {}).length ? `It missed: ${listed(details.missing)}` : null,
    Object.keys(details.extra ?? {}).length ? `It wrongly included: ${listed(details.extra)}` : null,
    details.not_constituents?.length ? `Not in the Nasdaq-100: ${details.not_constituents.join(", ")}` : null,
  ].filter(Boolean);
  if (lines.length) {
    const score = typeof verdict.score === "number" ? ` Match score ${Math.round(verdict.score * 100)}%.` : "";
    return banner({ tone: "warn", title: "The agent's list was off.", body: `The list below is the corrected one, recomputed from Nasdaq's prices.${score}`, lines });
  }
  return banner({ tone: "bad", title: "The agent did not finish its answer, so it could not be checked.", body: "The list below comes straight from Nasdaq's prices, so you can still use it." });
}

/** Known task errors in plain words (design 6), tried before the kit's common ones. */
export const ERROR_RULES = [
  { id: "cancelled", match: (message) => message === "cancelled", text: "Stopped. Nothing new was saved.", tone: "neutral" },
  {
    id: "holiday",
    match: /(\d{4}-\d{2}-\d{2}) is not a Nasdaq-100 trading session/,
    text: (_, found) => `The market was closed on ${formatDay(found[1])}, so there is no closing price for that day. Pick another day.`,
  },
  { id: "future", match: "is not a past day in New York", text: "That day's trading isn't over yet. Pick an earlier day." },
  { id: "history", match: /index history before .* too short/, text: "Nasdaq can't give enough history for that week. Try a more recent week." },
  { id: "no-close", match: /Nasdaq has no close for (\S+)/, text: (_, found) => `Nasdaq has no price for ${found[1]} that week, so the week can't be checked.` },
  { id: "nasdaq", match: /Nasdaq (refused|listed|response exceeds)/, text: "Couldn't get prices from Nasdaq. Try again in a minute." },
  { id: "input", match: "invalid input", text: "That date isn't valid. Pick another day." },
];

/** The day an error offers instead (the weekday before a holiday), or null. */
export function errorFix(message, today) {
  const holiday = message.match(/(\d{4}-\d{2}-\d{2}) is not a Nasdaq-100 trading session/);
  if (holiday) return weekdayBefore(holiday[1]);
  if (message.includes("is not a past day in New York")) return weekdayBefore(today);
  return null;
}

/** A muted progress note for a tool call that failed (the agent usually retries). */
export function failedCallNote(tool) {
  const text = String(tool.output ?? "");
  const ticker = text.match(/no close for (\S+)/)?.[1];
  if (ticker) return `Nasdaq had no price for ${ticker}; the agent retried.`;
  if (tool.name === "get_closes") return "One price request failed; the agent retried.";
  return "One step failed; the agent retried.";
}

// ----- Views -----

function fallerList(fallers, priced, week) {
  const deepest = Math.max(...fallers.map((one) => Math.abs(one.change)), 5);
  const missed = week.verdict.details.missing ?? {};
  // Without every company's prices the closes column is left out altogether, so the list does not
  // end in an empty band (design 6, "verdict without names or closes").
  const withCloses = priced && Boolean(week.start);
  const item = (one) => {
    const row = one.row;
    return h(
      "li",
      { class: "faller" },
      h("span", { class: "faller-ticker", text: one.ticker }),
      h("span", { class: "faller-name", title: row?.name ?? null, text: row?.short ?? "" }),
      h("span", { class: "faller-bar", "aria-hidden": "true" }, h("span", { style: `width: ${Math.max(4, (Math.abs(one.change) / deepest) * 100)}%` })),
      h("span", { class: "faller-change numeric", text: formatChange(one.change) }),
      withCloses ? h("span", { class: "faller-closes numeric muted", text: row ? `${formatPrice(row.start_close)} → ${formatPrice(row.end_close)}` : "" }) : null,
      one.ticker in missed ? h("span", { class: "pill tone-warn faller-tag", text: "Agent missed this" }) : null,
    );
  };
  const list = h("ol", { class: "fallers", "aria-label": "Stocks that fell 5% or more" }, fallers.slice(0, FALLER_LIMIT).map(item));
  const head = h(
    "div",
    { class: "faller faller-head", "aria-hidden": "true" },
    h("span", { text: "Stock" }),
    h("span"),
    h("span", { text: "Fall" }),
    h("span", { class: "numeric", text: "Change" }),
    withCloses ? h("span", { class: "numeric", text: `Close ${formatDay(week.start, { weekday: false, year: false })} → ${formatDay(week.as_of, { weekday: false, year: false })}` }) : null,
  );
  const more =
    fallers.length > FALLER_LIMIT
      ? h("button", {
          type: "button",
          class: "button small",
          text: `Show all ${fallers.length}`,
          onclick: (event) => {
            list.append(...fallers.slice(FALLER_LIMIT).map(item));
            event.currentTarget.remove();
          },
        })
      : null;
  return h("div", { class: `faller-block${withCloses ? "" : " no-closes"}` }, head, list, more);
}

function strip(rows) {
  const priced = rows.filter((row) => row.change !== null).sort((a, b) => a.change - b.change);
  const values = priced.map((row) => row.change);
  const low = Math.min(-10, Math.floor(values[0]) - 1);
  const high = Math.max(5, Math.ceil(values.at(-1)) + 1);
  const at = (value) => ((value - low) / (high - low)) * 100;
  // A small beeswarm: each dot takes the lowest lane where it does not touch the previous dot.
  const lanes = [];
  const dots = priced.map((row) => {
    const x = at(row.change);
    let lane = lanes.findIndex((last) => x - last >= 1.6);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = x;
    return h("span", { class: `strip-dot${row.fell ? " fell" : row.change > 0 ? " rose" : ""}`, style: `left: ${x}%; --lane: ${lane}`, title: `${row.ticker} ${formatChange(row.change)}` });
  });
  const ticks = [low, -5, 0, high].map((value) => h("span", { class: `strip-tick${value === -5 ? " cut" : ""}`, style: `left: ${at(value)}%`, text: value === 0 ? "0%" : formatChange(value).replace(".00", "") }));
  const fell = priced.filter((row) => row.fell).length;
  return h(
    "figure",
    { class: "strip" },
    h(
      "div",
      { class: "strip-plot", style: `--lanes: ${Math.max(1, lanes.length)}`, role: "img", "aria-label": `${priced.length} companies, from ${formatChange(values[0])} to ${formatChange(values.at(-1))}; ${fell} at −5% or lower.` },
      h("span", { class: "strip-line zero", style: `left: ${at(0)}%` }),
      h("span", { class: "strip-line cut", style: `left: ${at(-5)}%` }),
      dots,
    ),
    h("div", { class: "strip-axis", "aria-hidden": "true" }, ticks),
    h(
      "figcaption",
      { class: "strip-caption muted small-text" },
      h("span", {}, h("span", { class: "strip-key fell" }), "Fell 5% or more"),
      h("span", {}, h("span", { class: "strip-key" }), "Fell less"),
      h("span", {}, h("span", { class: "strip-key rose" }), "Rose"),
      h("span", { text: "One dot per company, from the prices collected for this week." }),
    ),
  );
}

function companyTable(rows, week) {
  const day = (iso) => (iso ? formatDay(iso, { weekday: false, year: false }) : "");
  return dataTable({
    columns: [
      { key: "ticker", label: "Ticker", primary: true, render: (row) => h("span", { class: "mono-strong", text: row.ticker }) },
      { key: "short", label: "Company", render: (row) => h("span", { title: row.name, text: row.short }) },
      { key: "start_close", label: `Close ${day(week.start)}`, numeric: true, render: (row) => (row.start_close ? formatPrice(row.start_close) : null) },
      { key: "end_close", label: `Close ${day(week.as_of)}`, numeric: true, render: (row) => (row.end_close ? formatPrice(row.end_close) : null) },
      { key: "change", label: "Change", numeric: true, render: (row) => (row.change === null ? null : h("span", { class: `change ${row.change < 0 ? "down" : row.change > 0 ? "up" : ""}`, text: formatChange(row.change) })) },
    ],
    rows,
    sort: { key: "change", dir: "asc" },
    filterPlaceholder: "Find a company or ticker",
    rowClass: (row) => (row.fell ? "highlight" : ""),
    caption: "Every Nasdaq-100 company's change over the week",
    empty: "No company matches.",
  });
}

/**
 * The result card of one week (design 3.4), from a run or a saved week.
 * @param {object} week What {@link weekFromRun} returns.
 * @param {{saved?: boolean, actions?: Node[]}} [options] `saved` adds "Saved on …".
 */
export function resultCard(week, { saved = false, actions = [] } = {}) {
  const rows = rowsOf(week);
  const byTicker = Object.fromEntries(rows.map((row) => [row.ticker, row]));
  const expected = week.verdict.details.expected;
  const fallers = Object.entries(expected)
    .map(([ticker, change]) => ({ ticker, change, row: byTicker[ticker] }))
    .sort((a, b) => a.change - b.change);
  const total = rows.length || null;
  const priced = rows.length > 0 && rows.every((row) => row.change !== null);
  const counted = total ? (fallers.length === total ? "All" : `${fallers.length} of ${total}`) : String(fallers.length);
  const headline = fallers.length
    ? `${counted} Nasdaq-100 ${fallers.length === 1 ? "stock" : "stocks"} fell 5% or more`
    : total
      ? `None of the ${total} Nasdaq-100 stocks fell 5% or more`
      : "No Nasdaq-100 stock fell 5% or more";
  const nearMisses = priced
    ? rows
        .filter((row) => !row.fell && row.change <= -4)
        .sort((a, b) => a.change - b.change)
        .slice(0, 3)
    : [];

  const parts = [
    h(
      "header",
      { class: "result-head" },
      h("div", { class: "result-titles" }, h("h2", { class: "result-headline", text: headline }), h("p", { class: "muted result-week" }, icon("calendar", { size: 16 }), formatWeek(week.start, week.as_of))),
      actions.length ? h("div", { class: "card-actions" }, actions) : null,
    ),
    saved ? h("p", { class: "muted small-text" }, `Saved on ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(week.ran_at))}. Nothing new was fetched.`) : null,
    verdictBanner(week.verdict, fallers.length),
    fallers.length ? fallerList(fallers, priced, week) : null,
    nearMisses.length
      ? h("p", { class: "near-misses" }, h("span", { class: "near-label", text: "Just missed" }), nearMisses.map((row) => h("span", { class: "near", title: row.name }, h("strong", { text: row.ticker }), ` ${row.short} `, h("span", { class: "numeric", text: formatChange(row.change) }))))
      : null,
    priced ? strip(rows) : banner({ tone: "neutral", title: "Prices from this run are incomplete.", body: "The list above comes from Nasdaq's prices; the other companies' prices aren't shown.", live: false }),
    priced ? disclosure({ summary: `See all ${total} companies`, hint: "Sort, search" }, companyTable(rows, week).element) : null,
    week.answer ? disclosure({ summary: "The agent's summary" }, h("p", { class: "prose", text: week.answer })) : null,
    disclosure(
      { summary: "About this data" },
      h(
        "ul",
        { class: "about-list" },
        h("li", { text: "Each change compares a company's close on the week's last day with its close 5 trading days earlier. A fall of exactly 5% counts." }),
        h("li", { text: "Membership is today's Nasdaq-100 list, also for past weeks." }),
        h("li", { text: "Prices are adjusted for stock splits, not dividends: a stock that paid a dividend that week shows it as a small fall." }),
        h("li", { text: `Source: Nasdaq (api.nasdaq.com).${week.listed_at ? ` List stamped ${week.listed_at} ET.` : ""}` }),
      ),
    ),
  ];
  return h("section", { class: "card large result-card", "aria-label": headline }, parts);
}

/** A saved week as a chip label: "Oct 2 · 7 fell" and a check or a warning. */
export function savedChipLabel(week) {
  const count = Object.keys(week.verdict.details.expected).length;
  return [
    h("span", { text: `${formatDay(week.as_of, { weekday: false, year: false })} · ${count ? `${count} fell` : "none fell"}` }),
    icon(week.verdict.valid ? "check" : "alert", { size: 14, label: week.verdict.valid ? "checked" : "the agent's list was off" }),
  ];
}
