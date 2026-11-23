/** What the Benchmarks section computes from the benchmark API's answers without drawing: verdicts, scores, the runs' filter and selection. */

export const ACTIVE = new Set(['queued', 'running']);

/** An attempt's verdict as one word: the verifier's, else why it has none. */
export function verdictOf(attempt) {
  if (attempt.verdict) return attempt.verdict;
  if (attempt.verifier_error) return 'verifier_error';
  if (!attempt.execution) return attempt.state;
  // The worker failed on the case, which is no verdict on the harness: its reason is read in the trace.
  if (attempt.execution.status === 'worker_error') return 'worker error';
  return attempt.execution.reason ? `${attempt.execution.status}:${attempt.execution.reason}` : attempt.execution.status;
}

/** Each case's newest attempt of a run (GET runs/{id}), by case id. */
export function latestAttempts(run) {
  return Object.fromEntries(run.cases
    .filter(one => one.attempts.length)
    .map(one => [one.case_id, one.attempts.reduce((a, b) => (b.attempt_no > a.attempt_no ? b : a))]));
}

/** `1 case`, `2 cases`. */
export const countOf = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A pass rate as `0.80 (4/5)`, passed of the scored cases (the rate's own denominator), or `unavailable` when no case was scored. */
export const passText = (rate, passed, scored) => (rate === null ? 'unavailable' : `${rate.toFixed(2)} (${passed}/${scored})`);

/**
 * A run's `score` as that text, with the cases it leaves out (`, 1 unscored`) and `so far` while cases are still to be scored; or `worker
 * error` when a case ended in a worker error, which leaves the run not graded.
 */
export function scoreText(score) {
  if (score.unavailable_reason === 'worker_error') return 'worker error';
  const text = passText(score.value, score.passed, score.scored);
  if (score.value === null) return text;
  return `${text}${score.unscored ? `, ${score.unscored} unscored` : ''}${score.complete ? '' : ' so far'}`;
}

/** "4.2 s", "1m 05s": a duration in milliseconds, with a `+` after it when some attempts reported none. */
export function formatTime(ms, missing) {
  const seconds = ms / 1000;
  const text = seconds < 10 ? `${seconds.toFixed(1)} s` : seconds < 60 ? `${Math.round(seconds)} s` : `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  return `${text}${missing ? '+' : ''}`;
}

/** The benchmarks of the installed version first, then the newest of the rest. */
export const installedFirst = (benchmarks, version) => [...benchmarks].sort((a, b) => (
  Number(b.plugin.version === version) - Number(a.plugin.version === version) || b.published_at.localeCompare(a.published_at)));

// The case set name every Terminal session's run is kept under (server/routes/benchmark.js SESSION_NAME): those runs are in GET runs too, but are no benchmark's.
export const SESSION_BENCHMARK = 'harness-session';

/** Whether a run summary is a run of a published benchmark, not a Terminal session. */
export const isBenchmarkRun = run => Boolean(run.benchmark?.name) && run.benchmark.name !== SESSION_BENCHMARK;

/** The harnesses the runs were made with, in the order of their newest run. */
export const harnessNames = runs => [...new Set(runs.map(run => run.harness.name))];

export const harnessLabel = name => name.startsWith('rush ') ? name.split(/\s+/)[1] : name;

/** `item` in or out of `set`. */
export function toggled(set, item) {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
}

/** `selected` (run ids, oldest pick first) with `id` picked or unpicked; at most two stay picked, a third pick replacing the oldest. */
export function toggleSelection(selected, id) {
  return selected.includes(id) ? selected.filter(one => one !== id) : [...selected, id].slice(-2);
}

/** Filter the chronological run history by plugin and harness. */
export function historyRuns(runs, {plugins, harnesses}) {
  return [...runs].filter(isBenchmarkRun).filter(run => (
    (!plugins.size || plugins.has(run.plugin.id))
    && (!harnesses.size || harnesses.has(harnessLabel(run.harness.name)))
  )).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.run_id.localeCompare(b.run_id));
}
