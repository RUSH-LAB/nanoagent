/**
 * The compare view's display logic over the server's comparison (GET compare?a=&b=): which rows to show, the header's flags,
 * how an aligned row reads, and which actions to highlight in the two timelines. Alignment itself is NanoAgent's.
 */

export const STATUS_LABELS = {
  same: 'Same', changed: 'Changed', only_a: 'Only in A', only_b: 'Only in B', ambiguous: 'Ambiguous', unknown: 'Unknown',
};

const isUnknown = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'unknown' in value;
const changed = diff => isUnknown(diff) || (Array.isArray(diff) && diff.length > 0);

/** Whether a row records no difference at all (NanoAgent's `Row.is_equal`): an unknown field is not equal. */
export function isEqualRow(row) {
  if (row.status !== 'same') return false;
  if ([row.input_diff, row.output_diff, row.status_diff].some(changed)) return false;
  if (isUnknown(row.sequence_changed) || row.sequence_changed || row.concurrency_changed) return false;
  // An unrecorded token or cost count is Unknown, never a difference: only a recorded change in either one differs.
  return ![row.token_delta, row.cost_delta].some(delta => !isUnknown(delta) && delta);
}

/** The rows to list: all of them, or with Show differences only those that differ, each keeping its index in the full list. */
export const visibleRows = (rows, differencesOnly) => (differencesOnly ? rows.filter(row => !isEqualRow(row)) : rows);

/** A row's title: its action's kind and target. */
export function rowTitle(row) {
  const action = row.a[0] ?? row.b[0];
  return action ? `${action.kind.replace('_', ' ')}: ${action.target || action.action_id}` : 'Action';
}

/** The action ids of a row on each side, which the two timelines highlight. */
export const rowActionIds = row => ({a: row.a.map(action => action.action_id), b: row.b.map(action => action.action_id)});

const FIELD_LABELS = {
  harness_revision: 'Harness revision', prompt_digest: 'Prompt digest', endpoint_profile: 'Endpoint profile', model: 'Model', provider: 'Provider endpoint',
  dialect: 'Dialect', policy: 'Participant policy', internet_access: 'Internet access', egress_hosts: 'Egress hosts', limits: 'Limits', timing_method: 'Timing method', reference_tokens_per_second: 'Reference token rate', coverage: 'Coverage',
};

const isPair = item => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string';

/** A recorded value as text: Unknown when absent, a list of hosts joined, the limits as `name=value` pairs. */
const shown = value => {
  if (value === null || value === undefined) return 'Unknown';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.every(isPair) ? value.map(([name, item]) => `${name}=${item}`).join(', ') : value.join(', ');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

/**
 * The header's conditions as `{name, label, a, b, state}`, each `different`, `unknown` (a side did not record it) or `same`.
 * Flagged ones come first so a difference is seen before any delta.
 */
export function conditionRows(header) {
  const different = new Set(header.condition_differences.map(diff => diff.name));
  const unknown = new Set(header.unknown_fields);
  const rank = {different: 0, unknown: 1, same: 2};
  return Object.keys(FIELD_LABELS)
    .map((name, position) => ({
      name, label: FIELD_LABELS[name], a: shown(header.conditions_a?.[name]), b: shown(header.conditions_b?.[name]), position,
      state: different.has(name) ? 'different' : unknown.has(name) ? 'unknown' : 'same',
    }))
    .sort((x, y) => rank[x.state] - rank[y.state] || x.position - y.position);
}

/** The estimate comparison: a delta only under the same timing method and reference rate, else why it is withheld. */
export function estimateText(header) {
  if (header.estimate_withheld) return `Withheld: ${header.estimate_withheld}`;
  const ns = header.estimate_delta_ns;
  if (ns === null || ns === undefined) return 'Unknown';
  return `${ns > 0 ? '+' : ns < 0 ? '-' : ''}${Math.abs(ns / 1e9).toFixed(3)} s (B relative to A)`;
}

/** A delta field of a row as text (`+3`, `-2.500 ms`, Unknown), for `unit` `''`, `ms` (the value is nanoseconds) or `usd`. */
export function deltaText(delta, unit = '') {
  if (delta === null || delta === undefined) return '';
  if (isUnknown(delta)) return `Unknown (${delta.unknown})`;
  const n = Number(delta);
  if (!Number.isFinite(n)) return 'Unknown';
  // No change is not worth a mark; an Unknown one is, above.
  if (n === 0) return '';
  const value = unit === 'ms' ? n / 1e6 : n;
  return `${value > 0 ? '+' : ''}${Number.isInteger(value) ? value : value.toFixed(3)}${unit === 'ms' ? ' ms' : unit === 'usd' ? ' USD' : ''}`;
}

/** The field-level differences of a row as `{unknown, fields: [{path, a, b}]}`; Unknown when a side's evidence is missing or redacted. */
export function fieldDiffs(diff) {
  if (isUnknown(diff)) return {unknown: diff.unknown, fields: []};
  return {unknown: null, fields: (diff ?? []).map(field => ({path: field.path, a: field.a_present === false ? 'absent' : shown(field.a), b: field.b_present === false ? 'absent' : shown(field.b)}))};
}

/** The payload digests an action records (`*_sha256`, in its input or output), to open in an inspector. */
export function actionPayloads(action) {
  if (!action) return [];
  const found = [];
  for (const [label, value] of [['input', action.input], ['output', action.output]]) {
    if (!value || typeof value !== 'object') continue;
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith('_sha256') && typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)) found.push({label: `${label} ${key.replace(/_sha256$/, '').replace('_', ' ')}`, sha: item});
    }
  }
  return found;
}
