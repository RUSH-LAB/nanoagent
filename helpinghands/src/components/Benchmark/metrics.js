/**
 * What the benchmark screens show of an attempt's or a run's numbers: the primary metrics first (tokens by class, with
 * what is known and what is missing, then total elapsed time), then the timing analysis. An attempt's `metrics` are the
 * worker's (`missing_calls` counts physical requests that did not report a field); a run's or suite's are sums
 * (`{total, missing_attempts}`).
 */

const TOKENS = [
  ['total_tokens', 'Total tokens', 'total'],
  ['input_tokens', 'Input tokens', 'input'],
  ['output_tokens', 'Output tokens', 'output'],
  ['cache_read_tokens', 'Cache reads', 'cache_read'],
  ['cache_write_tokens', 'Cache writes', 'cache_write'],
];

export const formatCount = value => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : 'Unknown');

/** `1.2 s`, `340 ms`, `2 m 5 s`. */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return 'Unknown';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} m ${whole % 60} s`;
}

export const formatNs = ns => (Number.isFinite(ns) ? formatMs(ns / 1e6) : 'Unknown');

const missingText = (count, unit) => (count > 0 ? `${count} ${unit}${count === 1 ? '' : 's'} without it` : null);

/**
 * The six primary metrics, in order: `{key, label, value, text, missing}`. `value` is the known subtotal (or null), `text`
 * what to show, `missing` the note about calls or attempts that did not report it (null when none).
 */
export function primaryMetrics(metrics) {
  const rows = [];
  for (const [key, label, short] of TOKENS) {
    const entry = metrics?.[key];
    let value = null;
    let missing = null;
    if (entry && typeof entry === 'object') {
      value = Number.isFinite(entry.total) ? entry.total : null;
      missing = missingText(entry.missing_attempts, 'attempt');
    } else if (Number.isFinite(entry)) {
      value = entry;
      missing = missingText(metrics?.missing_calls?.[short], 'call');
    }
    rows.push({key, label, value, text: formatCount(value), missing});
  }
  const elapsed = metrics?.elapsed_ms;
  const total = elapsed && typeof elapsed === 'object' ? elapsed.total : elapsed;
  const missing = elapsed && typeof elapsed === 'object' ? missingText(elapsed.missing_attempts, 'attempt') : null;
  rows.push({key: 'elapsed_ms', label: 'Total elapsed', value: Number.isFinite(total) ? total : null, text: formatMs(total), missing});
  return rows;
}

/**
 * The timing analysis of one attempt, after the primary metrics: the measured figures, then the estimate without OpenRouter
 * latency labeled with the reference rate it was modeled at. A figure the evidence cannot support reads Unknown with why.
 */
export function timingRows(metrics) {
  if (!metrics || typeof metrics !== 'object') return [];
  const unknown = name => metrics[`${name}_unknown`] ?? metrics.timing_unavailable ?? 'the evidence is incomplete';
  const figure = (name, label, note) => {
    const value = metrics[name];
    const known = Number.isFinite(value);
    return {key: name, label, text: known ? formatNs(value) : 'Unknown', note: known ? note : unknown(name), known};
  };
  const rate = metrics.timing_method?.reference_tokens_per_second;
  const estimate = figure('estimated_ns', 'Estimated without OpenRouter latency', Number.isFinite(rate) ? `modeled at ${formatCount(rate)} tokens per second` : 'modeled');
  return [
    figure('no_request_ns', 'Time with no OpenRouter request in flight', 'measured'),
    figure('outside_waits_ns', 'Measured time outside OpenRouter waits', 'measured'),
    figure('cpu_ns', 'Local CPU time', 'measured; can exceed elapsed time on several cores'),
    {...estimate, label: Number.isFinite(rate) ? `${estimate.label} (${formatCount(rate)} tokens/s)` : estimate.label, estimate: true},
  ];
}

/** One line on an attempt's coverage: complete, or partial and why. */
export function coverageText(coverage) {
  if (!coverage || typeof coverage !== 'object' || !coverage.status) return 'Coverage unknown';
  if (coverage.status === 'complete') return 'Coverage complete';
  const reasons = Array.isArray(coverage.reasons) ? coverage.reasons : [];
  return reasons.length ? `Coverage partial: ${reasons.join('; ')}` : 'Coverage partial';
}
