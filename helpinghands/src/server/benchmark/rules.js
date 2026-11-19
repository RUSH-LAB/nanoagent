'use strict';

/** The scoring and budget rules, pure so they can be tested without a database. */

const METRIC_FIELDS = ['total_tokens', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'elapsed_ms'];
/** The attempt metric that counts, per model call, how many calls did not report the token field. */
const MISSING_CALLS_KEY = {total_tokens: 'total', input_tokens: 'input', output_tokens: 'output', cache_read_tokens: 'cache_read', cache_write_tokens: 'cache_write'};

/** Each case's newest attempt, by attempt number: `Map<key, attempt>`, keyed by case id unless `keyOf` says otherwise. */
function latestByCase(attempts, keyOf = attempt => attempt.case_id) {
  const latest = new Map();
  for (const attempt of attempts) {
    const key = keyOf(attempt);
    const current = latest.get(key);
    if (!current || attempt.attempt_no > current.attempt_no) latest.set(key, attempt);
  }
  return latest;
}

/**
 * A run's score from each case's newest attempt: the cases that passed over the cases scored, those whose
 * attempt reached a verdict. `value` is null when none was scored, with the reason; `unscored` counts the others
 * (still running, failed before a verifier saw them, or a verifier error), and `complete` says every case's newest attempt is final.
 */
function runScore(caseIds, attempts) {
  const latest = latestByCase(attempts);
  const newest = caseIds.map(id => latest.get(id));
  const scored = newest.filter(attempt => attempt?.verdict === 'pass' || attempt?.verdict === 'fail');
  const passed = scored.filter(attempt => attempt.verdict === 'pass').length;
  const complete = newest.every(attempt => attempt?.state === 'final');
  const verifierErrors = newest.filter(attempt => attempt?.verifier_error).length;
  let unavailable = null;
  if (!scored.length) unavailable = verifierErrors ? 'verifier_error' : complete ? 'no_scored_cases' : 'scoring_pending';
  return {
    value: scored.length ? passed / scored.length : null, passed, scored: scored.length, total: caseIds.length,
    unscored: caseIds.length - scored.length, verifier_errors: verifierErrors, complete, unavailable_reason: unavailable,
  };
}

/**
 * Sum the primary metrics over `attempts`' metrics objects. Each field gives its known `total`
 * (an attempt's known subtotal counts) and the number of attempts that did not fully report it:
 * those without the field and those with a model call that did not report it.
 */
function sumMetrics(metricsList) {
  const sums = {};
  for (const field of METRIC_FIELDS) {
    const reported = metricsList.map(metrics => metrics?.[field]).filter(value => typeof value === 'number' && Number.isFinite(value));
    const partial = metricsList.filter(metrics => metrics?.missing_calls?.[MISSING_CALLS_KEY[field]] > 0 && Number.isFinite(metrics?.[field])).length;
    sums[field] = {total: reported.reduce((sum, value) => sum + value, 0), missing_attempts: metricsList.length - reported.length + partial};
  }
  return sums;
}

/**
 * Whether a model call of `reserve` USD may be admitted: null, or the scope that is exhausted
 * (`calls`, `attempt`, `member` or `workspace`). Each `committed` is what the scope has reserved or spent.
 */
function overBudget({reserve, callsAdmitted, maxCalls, attemptCommitted, maxCost, memberCommitted, memberCap, workspaceCommitted, workspaceCap}) {
  if (callsAdmitted + 1 > maxCalls) return 'calls';
  if (attemptCommitted + reserve > maxCost) return 'attempt';
  if (memberCommitted + reserve > memberCap) return 'member';
  if (workspaceCommitted + reserve > workspaceCap) return 'workspace';
  return null;
}

module.exports = {latestByCase, runScore, sumMetrics, overBudget};
