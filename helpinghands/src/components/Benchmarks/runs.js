/** What the Benchmarks section computes from the benchmark API's answers without drawing: verdicts, scores, the runs' filter and selection, the compare table. */

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

/** "$0.0042", "$0.012", "$1.25": a cost in US dollars, "—" when unknown. */
export function formatCost(usd) {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}

/** "4.2 s", "1m 05s": a duration in milliseconds, with a `+` after it when some attempts reported none. */
export function formatTime(ms, missing) {
  const seconds = ms / 1000;
  const text = seconds < 10 ? `${seconds.toFixed(1)} s` : seconds < 60 ? `${Math.round(seconds)} s` : `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  return `${text}${missing ? '+' : ''}`;
}

/** "373", "4.2k": a token count, with a `+` after it when some attempts reported none. */
export const formatTokens = (total, missing) => `${total < 1000 ? total : `${(total / 1000).toFixed(1)}k`}${missing ? '+' : ''}`;

/** The benchmarks of the installed version first, then the newest of the rest. */
export const installedFirst = (benchmarks, version) => [...benchmarks].sort((a, b) => (
  Number(b.plugin.version === version) - Number(a.plugin.version === version) || b.published_at.localeCompare(a.published_at)));

/** A benchmark's identity in run summaries, which name it and its plugin version but not its id: a name is unique per plugin version. */
export const benchmarkKey = run => `${run.plugin.id}@${run.plugin.version}/${run.benchmark.name}`;

// The case set name every Terminal session's run is kept under (server/routes/benchmark.js SESSION_NAME): those runs are in GET runs too, but are no benchmark's.
export const SESSION_BENCHMARK = 'harness-session';

/** Whether a run summary is a run of a published benchmark, not a Terminal session. */
export const isBenchmarkRun = run => Boolean(run.benchmark?.name) && run.benchmark.name !== SESSION_BENCHMARK;

/** The benchmarks the run summaries (newest first) are of: `{key, name, plugin, runs}` each, the one with the newest run first. */
export function benchmarksOf(summaries) {
  const groups = new Map();
  for (const run of summaries.filter(isBenchmarkRun)) {
    const group = groups.get(benchmarkKey(run)) ?? {key: benchmarkKey(run), name: run.benchmark.name, plugin: run.plugin, runs: []};
    groups.set(group.key, {...group, runs: [...group.runs, run]});
  }
  return [...groups.values()];
}

/** The harnesses the runs were made with, in the order of their newest run. */
export const harnessNames = runs => [...new Set(runs.map(run => run.harness.name))];

export const harnessLabel = name => name.startsWith('rush ') ? name.split(/\s+/)[1] : name;

/** The runs of the harnesses in `picked` (a Set), all of them when none is picked. */
export const filterRuns = (runs, picked) => (picked.size ? runs.filter(run => picked.has(run.harness.name)) : runs);

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

/** The picked run ids that are among the runs in view. */
export const selectedIn = (selected, runs) => selected.filter(id => runs.some(run => run.run_id === id));

/**
 * The compare table of runs read in full (GET runs/{id}): a row per case, a column per run, each cell `{verdict, attemptId}`
 * (`verdict` null and no attempt for a case the run has not reached).
 */
export function compareTable(runs) {
  const newest = runs.map(latestAttempts);
  const cases = [...new Set(runs.flatMap(run => run.cases.map(one => one.case_id)))];
  return {
    columns: runs.map(run => ({runId: run.run_id, harness: run.harness.name})),
    rows: cases.map(caseId => ({
      caseId,
      cells: newest.map(attempts => ({verdict: attempts[caseId] ? verdictOf(attempts[caseId]) : null, attemptId: attempts[caseId]?.attempt_id ?? null})),
    })),
  };
}

/** Filter the chronological run history by plugin and harness. */
export function historyRuns(runs, {plugins, harnesses}) {
  return [...runs].filter(isBenchmarkRun).filter(run => (
    (!plugins.size || plugins.has(run.plugin.id))
    && (!harnesses.size || harnesses.has(harnessLabel(run.harness.name)))
  )).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.run_id.localeCompare(b.run_id));
}
