/**
 * The attempt trace view's model, derived from the stored span index and links (GET attempts/{id}/spans) alone. Times are
 * nanosecond strings (they exceed 2^53), kept as BigInt until they are offsets.
 */

export const ERROR_STATUSES = new Set(['error', 'rejected']);
// Links that connect actions across the tree: what a proposal became, what came back, a command's process, a retried call.
const CAUSAL_KINDS = new Set(['proposal_invocation', 'result_delivery', 'command_process', 'process_lineage', 'retry']);

export const big = ns => (ns === null || ns === undefined || ns === '' ? null : BigInt(ns));

/** `{start, end}` of a timed span; an unfinished one (null end) runs to `open`, the end of the trace's extent. A span with no start has none. */
export function interval(span, open = null) {
  const start = big(span.start_ns);
  const end = big(span.end_ns) ?? open ?? start;
  return start === null ? null : {start, end: end < start ? start : end};
}

export const byStart = (a, b) => {
  const x = big(a.start_ns);
  const y = big(b.start_ns);
  if (x === y) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
};

// Spans outside the harness phase: the attempt that wraps it and the workspace snapshot taken after it.
const OUTSIDE_HARNESS = new Set(['attempt', 'snapshot']);

/**
 * The model of `{spans, links}`: the harness phase and what ran in it, without the spans outside it. The window is the earliest start
 * to the latest end among the spans that have them, never the attempt's own span (a session's ends before its children start).
 */
export function buildTrace({spans: all = [], links = []}) {
  const spans = all.filter(span => !OUTSIDE_HARNESS.has(span.kind));
  const byId = new Map(spans.map(span => [span.id, span]));
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
  return {spans, links, byId, window: {start, end}, linksFrom: from, linksTo: to};
}

/** `{left, width}` in percent on an elapsed-time scale of `total` ns, or null when the span was never timed. */
export function barOf(model, span, total = model.window.end - model.window.start) {
  const at = interval(span, model.window.end);
  if (!at) return null;
  if (total <= 0n) return {left: 0, width: 100};
  const left = Number(((at.start - model.window.start) * 100000n) / total) / 1000;
  const width = Number(((at.end - at.start) * 100000n) / total) / 1000;
  return {left, width: Math.max(width, 0.4)};
}

/** The causal links touching `id`, each as `{link, direction, otherId}` (`out` leaves it, `in` arrives), to follow. */
export function causalFrom(model, id) {
  const visible = new Set(actionSpans(model).map(span => span.id));
  const out = (model.linksFrom.get(id) ?? []).filter(link => CAUSAL_KINDS.has(link.kind)).map(link => ({link, direction: 'out', otherId: link.to}));
  const incoming = (model.linksTo.get(id) ?? []).filter(link => CAUSAL_KINDS.has(link.kind)).map(link => ({link, direction: 'in', otherId: link.from}));
  return [...incoming, ...out].filter(({otherId}) => visible.has(otherId));
}

/** The selection once the trace was read again: kept while its span still exists, otherwise cleared. */
export const keepSelection = (model, selectedId) => (selectedId && model.byId.has(selectedId) ? selectedId : null);

const ACTION_KINDS = new Set(['model_call', 'proposal', 'tool', 'command', 'process', 'subagent']);
const SHELL_WRAPPERS = new Set(['/harness/shell.py', '/harness/rush.py']);

/** Actions worth reading: omit the harness launcher itself and duplicate command processes. */
export function actionSpans(model) {
  const wrappers = new Set(model.spans.filter(span => span.kind === 'process' && span.attributes?.argv?.some(arg => SHELL_WRAPPERS.has(arg))).map(span => span.id));
  return model.spans.filter(span => {
    if (!ACTION_KINDS.has(span.kind)) return false;
    if (span.kind !== 'process') return true;
    if (wrappers.has(span.id)) return false;
    if (ERROR_STATUSES.has(span.status)) return true;
    if (span.attributes?.linked_command) return false;
    // shell.py (or rush.py) starts the harness itself; its child processes are the useful work.
    if (wrappers.has(span.parent)) return false;
    if (/^process \d+$/.test(span.name) && !span.attributes?.argv && !span.attributes?.title) return false;
    return true;
  });
}

/**
 * `error` for a trace that could not be read at all, and `refreshError` for a read again (the live poll) that failed while the last
 * good trace is still on screen: that stays shown, with the failure beside it.
 */
export function traceErrors(attempt, spans) {
  const failed = read => read.error !== null && read.data === null;
  const stale = read => (read.error !== null && read.data !== null ? read.error : null);
  return {error: [attempt, spans].find(failed)?.error ?? null, refreshError: stale(attempt) ?? stale(spans)};
}
