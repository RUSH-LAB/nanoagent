import {byStart, interval} from './traceModel.js';

/**
 * The timeline's row packing, after lmnr's transformSpansToCondensedTimeline: each bar moves up into the fewest rows it fits, and a
 * child never sits above its parent. A span whose parent is not among `spans` is a root. Spans with no start get no bar; an unfinished one (null end) runs to `open`.
 * Returns `{bars: [{span, row, start, end}], rows}`, parents before children.
 */
export function packRows(spans, open = null) {
  const byId = new Map(spans.map(span => [span.id, span]));
  const children = new Map();
  const roots = [];
  for (const span of [...spans].sort(byStart)) {
    if (span.parent && span.parent !== span.id && byId.has(span.parent)) {
      if (!children.has(span.parent)) children.set(span.parent, []);
      children.get(span.parent).push(span);
    } else roots.push(span);
  }
  const ordered = [];
  const seen = new Set();
  const walk = span => {
    if (seen.has(span.id)) return;
    seen.add(span.id);
    ordered.push(span);
    (children.get(span.id) ?? []).forEach(walk);
  };
  roots.forEach(walk);
  // A span in a parent cycle has no root above it; it still gets a bar.
  [...spans].sort(byStart).forEach(walk);

  const rowOf = new Map();
  const occupied = [];
  const bars = [];
  for (const span of ordered) {
    const at = interval(span, open);
    if (!at) continue;
    let row = span.parent && rowOf.has(span.parent) ? rowOf.get(span.parent) + 1 : 0;
    // Source timestamps are compared, so touching bars (end == next start) share a row.
    while (occupied[row]?.some(other => at.start < other.end && other.start < at.end)) row++;
    rowOf.set(span.id, row);
    (occupied[row] ??= []).push(at);
    bars.push({span, row, start: at.start, end: at.end});
  }
  return {bars, rows: occupied.length};
}
