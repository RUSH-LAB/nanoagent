const unknown = value => value !== null && typeof value === 'object' && !Array.isArray(value) && 'unknown' in value;
const nonEmpty = value => unknown(value) || (Array.isArray(value) ? value.length > 0 : Boolean(value));
// A delta is a recorded change when it is not Unknown and not zero (a Decimal arrives as a string).
const changed = value => !unknown(value) && value !== null && value !== undefined && Number(value) !== 0;

/** Whether a compare row (GET compare/attempts) differs: the server's `Row.is_equal` rule, so a "same" row with a diff or delta still differs. */
export const rowDiffers = row => row.status !== 'same'
  || nonEmpty(row.input_diff) || nonEmpty(row.output_diff) || nonEmpty(row.status_diff)
  || unknown(row.sequence_changed) || row.sequence_changed === true || row.concurrency_changed === true
  || changed(row.token_delta) || changed(row.cost_delta);

/**
 * The two transcripts aligned by the comparison's rows: `[{left, right, differs, index}]` where each side is a transcript row or null.
 * An ambiguous row keeps every candidate: `leftAll` and `rightAll` list them (`left` and `right` are the first) and the pair is `ambiguous` and differing. A compare row's actions are span ids (`m:`, `t:`, `c:` plus the id); `index` is the compare row's index (null for a row the
 * comparison does not cover, such as a process), so `first_difference` finds its pair. A row the comparison does not cover sits before
 * the next row of its side that it does, the two sides' such rows side by side.
 */
export function alignTranscripts(left, right, comparison) {
  const rows = comparison?.rows ?? [];
  const sides = [['a', left], ['b', right]].map(([key, list]) => {
    const anchor = new Map();
    rows.forEach((row, at) => (row[key] ?? []).forEach(action => anchor.set(action.action_id, at)));
    // Uncovered rows wait for the next covered row of their side; those after the last wait at rows.length.
    const extras = new Map();
    let pending = [];
    for (const item of list) {
      if (anchor.has(item.id)) {
        if (pending.length) extras.set(anchor.get(item.id), [...(extras.get(anchor.get(item.id)) ?? []), ...pending]);
        pending = [];
      } else pending.push(item);
    }
    extras.set(rows.length, pending);
    return {list, extras, byId: new Map(list.map(item => [item.id, item]))};
  });
  const covered = (side, key, row) => (row[key] ?? []).map(action => side.byId.get(action.action_id)).filter(Boolean);
  const pairs = [];
  const flush = at => {
    const [a, b] = sides.map(side => side.extras.get(at) ?? []);
    for (let i = 0; i < Math.max(a.length, b.length); i++) pairs.push({left: a[i] ?? null, right: b[i] ?? null, leftAll: a[i] ? [a[i]] : [], rightAll: b[i] ? [b[i]] : [], differs: false, ambiguous: false, index: null});
  };
  rows.forEach((row, at) => {
    flush(at);
    const [leftAll, rightAll] = [covered(sides[0], 'a', row), covered(sides[1], 'b', row)];
    const ambiguous = row.status === 'ambiguous' || leftAll.length > 1 || rightAll.length > 1;
    if (leftAll.length || rightAll.length) pairs.push({left: leftAll[0] ?? null, right: rightAll[0] ?? null, leftAll, rightAll, differs: ambiguous || rowDiffers(row), ambiguous, index: row.index ?? at});
  });
  flush(rows.length);
  return pairs;
}

/** The id of the row on the other side that `id` is paired with, or null. */
export function matchingId(pairs, side, id) {
  const from = side === 'left' ? 'left' : 'right';
  const to = side === 'left' ? 'right' : 'left';
  return pairs.find(pair => pair[`${from}All`].some(row => row.id === id))?.[to]?.id ?? null;
}

/** The pair index of the compare row `first_difference` names, or -1. */
export const firstDifferencePair = (pairs, firstDifference) => (firstDifference === null || firstDifference === undefined ? -1 : pairs.findIndex(pair => pair.index === firstDifference));
