/**
 * The attempt trace view's model, derived from the stored span index and links (GET attempts/{id}/spans) alone: the span tree
 * as rows, the waterfall's bars, the transcript, the upstream waits and the local work that overlaps them, and the causal
 * links to follow from one action. Times are nanosecond strings (they exceed 2^53), kept as BigInt until they are offsets.
 */

export const ERROR_STATUSES = new Set(['error', 'rejected']);
const LOCAL_KINDS = new Set(['tool', 'command']);
const TRANSCRIPT_KINDS = new Set(['model_call', 'proposal', 'tool', 'command']);
// Links that connect actions across the tree: what a proposal became, what came back, a command's process, a retried call.
export const CAUSAL_KINDS = new Set(['proposal_invocation', 'result_delivery', 'command_process', 'process_lineage', 'retry']);

const big = ns => (ns === null || ns === undefined || ns === '' ? null : BigInt(ns));

function interval(span) {
  const start = big(span.start_ns);
  const end = big(span.end_ns) ?? start;
  return start === null ? null : {start, end: end < start ? start : end};
}

const byStart = (a, b) => {
  const x = big(a.start_ns);
  const y = big(b.start_ns);
  if (x === y) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
};

// Spans outside the harness phase: the attempt that wraps it and the workspace snapshot taken after it.
const OUTSIDE_HARNESS = new Set(['attempt', 'snapshot']);

/** The model of `{spans, links}`: the harness phase and what ran in it, without the spans outside it. */
export function buildTrace({spans: all = [], links = []}) {
  const spans = all.filter(span => !OUTSIDE_HARNESS.has(span.kind));
  const byId = new Map(spans.map(span => [span.id, span]));
  const children = new Map();
  const roots = [];
  for (const span of [...spans].sort(byStart)) {
    if (span.parent && byId.has(span.parent) && span.parent !== span.id) {
      if (!children.has(span.parent)) children.set(span.parent, []);
      children.get(span.parent).push(span);
    } else roots.push(span);
  }
  const rows = [];
  const seen = new Set();
  const walk = (span, depth) => {
    if (seen.has(span.id)) return;
    seen.add(span.id);
    rows.push({id: span.id, depth, span, hasChildren: children.has(span.id)});
    for (const child of children.get(span.id) ?? []) walk(child, depth + 1);
  };
  roots.forEach(root => walk(root, 0));
  // A span in a parent cycle has no root above it; it still gets a row.
  [...spans].sort(byStart).forEach(span => walk(span, 0));

  const times = spans.flatMap(span => [big(span.start_ns), big(span.end_ns)]).filter(value => value !== null);
  const start = times.length ? times.reduce((a, b) => (a < b ? a : b)) : 0n;
  const end = times.length ? times.reduce((a, b) => (a > b ? a : b)) : 0n;
  const from = new Map();
  const to = new Map();
  for (const link of links) {
    if (!from.has(link.from)) from.set(link.from, []);
    if (!to.has(link.to)) to.set(link.to, []);
    from.get(link.from).push(link);
    to.get(link.to).push(link);
  }
  return {spans, links, byId, children, rows, window: {start, end}, linksFrom: from, linksTo: to};
}

/** `{left, width}` on an elapsed-time scale, or null when the span was never timed. */
export function barOf(model, span, total = model.window.end - model.window.start) {
  const at = interval(span);
  if (!at) return null;
  if (total <= 0n) return {left: 0, width: 100};
  const left = Number(((at.start - model.window.start) * 100000n) / total) / 1000;
  const width = Number(((at.end - at.start) * 100000n) / total) / 1000;
  return {left, width: Math.max(width, 0.4)};
}

/** Relative timing in milliseconds, keeping unknown starts and ends distinct from zero. */
export function spanTiming(model, span) {
  const start = big(span.start_ns);
  if (start === null) return null;
  const end = big(span.end_ns);
  return {offset: Number(start - model.window.start) / 1e6, duration: end === null || end < start ? null : Number(end - start) / 1e6};
}

/** The spans, in time order, that make up the conversation: model calls, their proposals, tool calls and commands. */
export const transcriptOf = model => model.spans.filter(span => TRANSCRIPT_KINDS.has(span.kind)).sort(byStart);

/**
 * The upstream waits (model calls with a recorded interval) and the local work (tools and commands) that overlaps any of them,
 * with the waits each overlaps. Both come from recorded intervals; a span never timed is in neither.
 */
export function waitsOf(model) {
  const waits = model.spans.filter(span => span.kind === 'model_call' && interval(span));
  const overlapping = new Map();
  for (const span of model.spans) {
    const at = LOCAL_KINDS.has(span.kind) ? interval(span) : null;
    if (!at) continue;
    const during = waits.filter(wait => {
      const w = interval(wait);
      return at.start < w.end && w.start < at.end;
    });
    if (during.length) overlapping.set(span.id, during.map(wait => wait.id));
  }
  return {upstream: new Set(waits.map(wait => wait.id)), overlapping};
}

/** The other spans of the same kind and scope whose recorded interval overlaps `id`'s: its parallel calls. */
export function parallelWith(model, id) {
  const span = model.byId.get(id);
  const at = span && interval(span);
  if (!at) return [];
  return model.spans.filter(other => {
    const o = other.id !== id && other.kind === span.kind && other.scope === span.scope ? interval(other) : null;
    return o && at.start < o.end && o.start < at.end;
  }).sort(byStart);
}

/** The causal links touching `id`, each as `{link, direction, otherId}` (`out` leaves it, `in` arrives), to follow. */
export function causalFrom(model, id) {
  const out = (model.linksFrom.get(id) ?? []).filter(link => CAUSAL_KINDS.has(link.kind)).map(link => ({link, direction: 'out', otherId: link.to}));
  const incoming = (model.linksTo.get(id) ?? []).filter(link => CAUSAL_KINDS.has(link.kind)).map(link => ({link, direction: 'in', otherId: link.from}));
  return [...incoming, ...out].filter(({otherId}) => model.byId.has(otherId));
}

/** Every span in the causal chain through `id`, followed in both directions: what to highlight with the selection. */
export function causalChain(model, id) {
  const reached = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const {otherId} of causalFrom(model, queue.shift())) {
      if (!reached.has(otherId)) {
        reached.add(otherId);
        queue.push(otherId);
      }
    }
  }
  return reached;
}

export const EMPTY_FILTERS = Object.freeze({q: '', kind: '', errorsOnly: false, scope: '', provenance: ''});

export const filtersActive = filters => Boolean(filters.q || filters.kind || filters.errorsOnly || filters.scope || filters.provenance);

function matches(span, filters) {
  if (filters.kind && span.kind !== filters.kind) return false;
  if (filters.errorsOnly && !ERROR_STATUSES.has(span.status)) return false;
  if (filters.scope && span.scope !== filters.scope) return false;
  if (filters.provenance && span.provenance !== filters.provenance) return false;
  const q = filters.q.trim().toLowerCase();
  return !q || [span.id, span.name, span.target, span.scope].some(text => typeof text === 'string' && text.toLowerCase().includes(q));
}

/**
 * The tree rows that match `filters`, each with `context: false`, and the ancestors needed to place them as `context: true`.
 * With no filter, every row.
 */
export function filterRows(model, filters) {
  if (!filtersActive(filters)) return model.rows.map(row => ({...row, context: false}));
  const shown = new Map();
  for (const row of model.rows) {
    if (!matches(row.span, filters)) continue;
    shown.set(row.id, false);
    for (let parent = row.span.parent; parent && model.byId.has(parent) && !shown.has(parent); parent = model.byId.get(parent).parent) shown.set(parent, true);
  }
  return model.rows.filter(row => shown.has(row.id)).map(row => ({...row, context: shown.get(row.id)}));
}

export const distinct = (model, field) => [...new Set(model.spans.map(span => span[field]).filter(Boolean))].sort();

/** The selection once the trace was read again: kept while its span still exists, otherwise cleared. */
export const keepSelection = (model, selectedId) => (selectedId && model.byId.has(selectedId) ? selectedId : null);
