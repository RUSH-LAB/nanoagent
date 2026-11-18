/** Display logic for the run cards and the run view: labels over a run summary (GET runs, GET benchmarks/{id}/results) or a run (GET runs/{id}), and what a live update may change. */

import {primaryMetrics} from './metrics.js';

const EXECUTION_LABELS = {
  answered: 'Answered', refused: 'Refused', execution_failed: 'Execution failed', build_failed: 'Build failed', canceled: 'Canceled', interrupted: 'Interrupted', ended: 'Ended',
};

export const POLICY_LABELS = {coding: 'Coding', task_tools: 'Task tools'};

/** The verifier's explanation codes, as people read them. */
const EXPLANATION_LABELS = {
  invalid_answer: 'The answer does not have the shape the task requires.',
  refused_answer_case: 'The harness refused a case that has an answer.',
  answered_refusal_case: 'The harness answered a case it should have refused.',
  execution_failed: 'The harness did not produce a result.',
};

const VERDICT_LABELS = {pass: 'Pass', fail: 'Fail'};

/** What an attempt is doing or did: `Queued`, `Running`, or its execution status. */
export function attemptStatus(attempt) {
  if (attempt.state === 'queued') return 'Queued';
  if (attempt.state === 'leased') return attempt.cancel_requested ? 'Canceling' : 'Running';
  return attempt.execution ? EXECUTION_LABELS[attempt.execution.status] ?? attempt.execution.status : 'Finished';
}

/** An explanation code as text (an unknown code is shown as it is), or `''` for none. */
export const explanationText = code => (code ? EXPLANATION_LABELS[code] ?? code : '');

/** A case's verdict as text: `Pass`, `Fail`, or `Verifier error` when the verifier crashed, else `–`. */
export const verdictText = attempt => VERDICT_LABELS[attempt.verdict] ?? (attempt.verifier_error ? 'Verifier error' : '–');

/** An attempt's or compared side's outcome: its execution status, else its state. */
export const outcomeText = outcome => EXECUTION_LABELS[outcome] ?? (outcome ? outcome[0].toUpperCase() + outcome.slice(1) : '–');

const SCORE_REASONS = {verifier_error: 'the verifier reported an error', no_scored_cases: 'no case has a verdict', scoring_pending: 'scoring is pending'};

/** A run's `score` object as the line the run shows: the value with what it covers, or why it is unavailable. */
export function scoreText(score) {
  if (!score) return 'Unavailable';
  if (Number.isFinite(score.value)) {
    const parts = [`${score.passed} of ${score.scored} scored passed`];
    if (score.unscored) parts.push(`${score.unscored} unscored${score.verifier_errors ? ` (${score.verifier_errors} verifier error${score.verifier_errors === 1 ? '' : 's'})` : ''}`);
    if (!score.complete) parts.push('provisional');
    return `${Number(score.value.toFixed(4))} (${parts.join(', ')})`;
  }
  return `Unavailable: ${SCORE_REASONS[score.unavailable_reason] ?? score.unavailable_reason ?? 'no reason given'}`;
}

/** Every attempt of a run, flat, with where it sits: `{case, attempt}`. */
export const attemptsOf = run => run.cases.flatMap(item => item.attempts.map(attempt => ({case: item, attempt})));

/** The attempts a live view should stream: those a worker holds, whose events are still arriving. */
export const liveAttempts = run => attemptsOf(run).filter(({attempt}) => attempt.state === 'leased').map(({attempt}) => attempt.attempt_id);

/** Whether the run still changes by itself, so its view keeps reading it. */
export const runIsActive = run => run.status === 'queued' || run.status === 'running';

/** A person as the marketplace shows an owner: their name, and their GitHub login when they have one. */
export const personLabel = person => (person ? `${person.name}${person.github ? ` (@${person.github})` : ''}` : '');

/** A run summary's status line: `{text, tone}`, the score as `Passed 8/10` once final and `3/10 passed so far` while it runs. */
function statusLine(run) {
  const {score} = run;
  if (run.status === 'queued') return {text: 'Queued', tone: 'pending'};
  if (run.status === 'canceled') return {text: 'Canceled', tone: 'bad'};
  if (!Number.isFinite(score?.value)) return {text: runIsActive(run) ? 'Running' : 'Score unavailable', tone: runIsActive(run) ? 'pending' : 'bad'};
  if (runIsActive(run) || !score.complete) return {text: `Running · ${score.passed}/${score.total} passed so far`, tone: 'pending'};
  return {text: `Passed ${score.passed}/${score.total}`, tone: score.passed === score.total ? 'good' : score.passed === 0 ? 'bad' : 'partial'};
}

/** One metric of a run summary as a phrase: `48,210 tokens`, `… so far` while the run is live, and `partial` with the attempts that did not report it. */
function metricText(run, key, unit) {
  const row = primaryMetrics(run.metrics).find(item => item.key === key);
  const value = row.value === null ? `${unit ? `${unit} ` : ''}unknown` : `${row.text}${unit ? ` ${unit}` : ''}`;
  return `${value}${runIsActive(run) && row.value !== null ? ' so far' : ''}${row.missing ? ` (partial: ${row.missing})` : ''}`;
}

/**
 * What a run card shows of a run summary: `{title, subtitle, status, tone, model, tokens, elapsed, user, select}`. `ticked` are the run
 * ids selected for comparison: `select` is `{checked, label}` with the label `Select`, or `Run A` / `Run B` once ticked.
 */
export function runSummary(run, ticked = []) {
  const {text, tone} = statusLine(run);
  const at = ticked.indexOf(run.run_id);
  return {
    title: `${run.harness.name} v${run.harness.version}`,
    subtitle: `${run.plugin.name ?? run.plugin.id} · ${run.benchmark.name} v${run.plugin.version}`,
    status: text, tone, model: run.model,
    tokens: metricText(run, 'total_tokens', 'tokens'),
    elapsed: metricText(run, 'elapsed_ms', ''),
    user: personLabel(run.user),
    select: {checked: at >= 0, label: at < 0 ? 'Select' : at === 0 ? 'Run A' : 'Run B'},
  };
}

/** Run ids ticked in the list after toggling `id`: at most two, the newest tick replacing the oldest, only runs the list still has. */
export function toggleRun(ticked, id, runs) {
  const known = new Set(runs.map(run => run.run_id));
  const kept = ticked.filter(item => known.has(item));
  return kept.includes(id) ? kept.filter(item => item !== id) : [...kept, id].slice(-2);
}

/** Why two ticked runs cannot be compared, when the list already shows it (the server decides: the package digest is checked there). */
export function runPairProblem(ticked, runs) {
  if (ticked.length !== 2) return 'Tick two runs of one plugin';
  const [first, second] = ticked.map(id => runs.find(run => run.run_id === id));
  if (!first || !second) return 'Tick two runs of one plugin';
  if (first.plugin.id !== second.plugin.id) return 'Runs are comparable when they use the same plugin';
  return null;
}
