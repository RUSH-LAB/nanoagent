/**
 * The run comparison's display logic over the server's answer (GET compare?a=&b=): the configuration rows with their differences, the
 * prompt diffs, and how one side of an aligned case reads. The alignment and the diffs are the server's.
 */
import {LIMIT_LABELS} from './publish.js';
import {POLICY_LABELS, explanationText, outcomeText, verdictText} from './runs.js';

const FIELD_LABELS = {
  benchmark_id: 'Benchmark', harness: 'Harness', case_set_id: 'Case set', case_set_digest: 'Case set digest', policy: 'Participant policy', model: 'Model', endpoint_profile: 'Endpoint', dialects: 'Dialects',
  egress_hosts: 'Egress hosts', selection: 'Selected cases', prompt_source: 'Prompt source', renderer_version: 'Prompt renderer',
};

export const fieldLabel = field => (field.startsWith('limits.') ? LIMIT_LABELS[field.slice('limits.'.length)] ?? field : FIELD_LABELS[field] ?? field);

/** A configuration value as text: lists joined, `internet_access` as on/off, `null` egress hosts as not applicable. */
export function valueText(field, value) {
  if (field === 'egress_hosts') return value === null ? 'Not applicable (coding)' : value.length ? value.join(', ') : 'None';
  if (field === 'limits.internet_access') return value ? 'on' : 'off';
  if (field === 'policy') return POLICY_LABELS[value] ?? String(value);
  if (field.endsWith('digest')) return String(value).slice(0, 12);
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return 'none';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** The configuration as `{field, label, a, b, differs}`, differing rows first (each group in the server's order), or only those that differ. */
export function configRows(config, differencesOnly = false) {
  const rows = config.map((entry, position) => ({field: entry.field, label: fieldLabel(entry.field), a: valueText(entry.field, entry.a), b: valueText(entry.field, entry.b), differs: entry.differs, position}));
  return rows.filter(row => !differencesOnly || row.differs).sort((x, y) => Number(y.differs) - Number(x.differs) || x.position - y.position);
}

/** Whether a diff (`[{type, text}]`) records any change. */
export const diffChanged = parts => (parts ?? []).some(part => part.type !== 'same');

const MARKS = {same: ' ', removed: '-', added: '+'};

/** A line diff as `{type, line}` per line, each line marked as a unified diff marks it (` `, `-`, `+`). */
export const diffLines = parts => (parts ?? []).flatMap(part => (part.text === '' ? [] : part.text.replace(/\n$/, '').split('\n').map(line => ({type: part.type, line: `${MARKS[part.type] ?? ' '} ${line}`}))));

/** A cost in USD as text; unknown when a call's cost is not settled (never zero). */
export function costText(side) {
  if (side.cost_usd === null || side.cost_usd === undefined) return side.uncertain_cost ? 'Uncertain' : 'Unknown';
  return `$${Number(side.cost_usd.toPrecision(3))}${side.uncertain_cost ? ' (uncertain)' : ''}`;
}

export const latencyText = side => (side.latency_ms === null || side.latency_ms === undefined ? 'Unknown' : `${side.latency_ms.toLocaleString('en-US')} ms`);

export const tokensText = side => (side.tokens?.total === null || side.tokens?.total === undefined ? 'Unknown' : side.tokens.total.toLocaleString('en-US'));

/** One side of an aligned case as the cells the table shows. */
export const sideCells = side => ({
  outcome: outcomeText(side.outcome),
  verdict: verdictText({verdict: side.verdict, verifier_error: side.verifier_error}),
  explanation: explanationText(side.explanation),
  tokens: tokensText(side),
  cost: costText(side),
  latency: latencyText(side),
});

const FINAL = new Set(['answered', 'refused', 'execution_failed', 'build_failed', 'canceled', 'interrupted']);

/** Whether the attempts of a shared case are both sealed, so NanoAgent can compare them action by action. */
export const attemptsComparable = shared => Boolean(shared.a.attempt_id && shared.b.attempt_id) && FINAL.has(shared.a.outcome) && FINAL.has(shared.b.outcome);

/** The unverified-egress badges of the two runs: which sides had internet access. */
export const egressSides = flags => ['a', 'b'].filter(side => flags[side]).map(side => side.toUpperCase());

/** Whether the recorded outcome, verdict or explanation differs for a shared case. */
export function caseOutcomeChanged(item) {
  const {a, b} = item;
  return a.outcome !== b.outcome || a.verdict !== b.verdict || a.verifier_error !== b.verifier_error ||
    a.execution_reason !== b.execution_reason || explanationText(a.explanation) !== explanationText(b.explanation);
}

/** Show changed outcomes first while preserving server order within each group. */
export const orderedCases = cases => [...cases.filter(caseOutcomeChanged), ...cases.filter(item => !caseOutcomeChanged(item))];

/** Count only explicit pass/fail verdicts on each side of a matched case. */
export function pairedVerdicts(cases) {
  const counts = {bothPassed: 0, onlyAPassed: 0, onlyBPassed: 0, bothFailed: 0, unpaired: 0};
  for (const {a, b} of cases) {
    const key = `${a.verdict}:${b.verdict}`;
    switch (key) {
      case 'pass:pass': counts.bothPassed += 1; break;
      case 'pass:fail': counts.onlyAPassed += 1; break;
      case 'fail:pass': counts.onlyBPassed += 1; break;
      case 'fail:fail': counts.bothFailed += 1; break;
      default: counts.unpaired += 1;
    }
  }
  return counts;
}
