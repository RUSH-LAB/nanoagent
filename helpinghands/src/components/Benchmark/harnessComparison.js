/** Harness comparisons use the published benchmark id, not a plugin or benchmark name. */
export const harnessKey = run => JSON.stringify([run.user.id, run.harness.name, run.harness.version, run.policy]);

export function harnessesOf(results) {
  const groups = new Map();
  for (const run of results.flatMap(item => item.runs)) {
    const key = harnessKey(run);
    if (!groups.has(key)) groups.set(key, {key, user: run.user, harness: run.harness, policy: run.policy});
  }
  return [...groups.values()].sort((a, b) => `${a.harness.name} ${a.harness.version} ${a.user.name} ${a.policy}`.localeCompare(`${b.harness.name} ${b.harness.version} ${b.user.name} ${b.policy}`));
}

/** A completed result takes precedence; within each status the newest run comes first. */
function orderedRuns(runs) {
  return [...runs].sort((a, b) => Number(b.status === 'complete') - Number(a.status === 'complete') || Date.parse(b.created_at) - Date.parse(a.created_at) || a.run_id.localeCompare(b.run_id));
}

export function comparisonRows(results, left, right, choices = {}) {
  return results.map(({benchmark, runs}) => {
    const sides = [left, right].map((key, side) => {
      const options = orderedRuns(runs.filter(run => harnessKey(run) === key));
      const selected = options.find(run => run.run_id === choices[`${benchmark.benchmark_id}:${side}`]) ?? options[0] ?? null;
      return {options, run: selected};
    });
    return {benchmark, a: sides[0], b: sides[1]};
  }).filter(row => row.a.run || row.b.run).sort((a, b) => `${a.benchmark.plugin.name} ${a.benchmark.name}`.localeCompare(`${b.benchmark.plugin.name} ${b.benchmark.name}`));
}

/** Only complete, entirely scored pairs contribute to either headline. */
export function comparableScore(run) {
  const s = run?.score;
  return run?.status === 'complete' && s?.complete && s.total > 0 && s.scored === s.total && s.unscored === 0 && !s.verifier_errors ? s : null;
}

export function comparisonTotals(rows) {
  const paired = rows.filter(row => comparableScore(row.a.run) && comparableScore(row.b.run));
  const side = key => paired.reduce((sum, row) => {
    const score = comparableScore(row[key].run);
    sum.benchmarks += Number(score.passed === score.total);
    sum.passed += score.passed;
    sum.cases += score.total;
    return sum;
  }, {benchmarks: 0, passed: 0, cases: 0});
  return {shared: rows.filter(row => row.a.run && row.b.run).length, paired: paired.length, a: side('a'), b: side('b')};
}
