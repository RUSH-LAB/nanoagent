'use strict';

const {REFERENCE_HARNESSES} = require('./harness');

// What people call each reference harness (a unit test keeps these equal to REFERENCE_HARNESSES).
const REFERENCE_LABELS = Object.freeze({
  'nanoagent': 'RUSH', 'claude-code': 'Claude Code', 'codex': 'Codex', 'dsh': 'DSH', 'hermes': 'Hermes', 'pi': 'Pi', 'shell': 'Terminal',
});

const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
/** Smaller first, an unknown figure last. */
const ascending = (x, y) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x - y);

/**
 * A plugin task's leaderboard from its scored attempts (`benchmark_leaderboard` rows), as member `viewerId` sees it: one entry per
 * harness, a reference harness by its name and a saved one, which only its owner runs, as "name (@owner)"; ranked by correct rate,
 * then average time, then average cost. Each entry lists its runs, newest first; only the viewer's own carry their attempt, whose
 * trace is theirs alone.
 */
function leaderboard(rows, viewerId) {
  const harnesses = new Map();
  for (const row of rows) {
    const reference = REFERENCE_HARNESSES.includes(row.harness_name);
    const key = reference ? row.harness_name : `${row.harness_name}@${row.user_id}`;
    if (!harnesses.has(key)) {
      harnesses.set(key, {
        harness: reference ? REFERENCE_LABELS[row.harness_name] : `${row.harness_name} (@${row.user_github ?? row.user_name})`, reference, runs: [],
      });
    }
    const mine = row.user_id === viewerId;
    harnesses.get(key).runs.push({
      created_at: row.created_at, verdict: row.verdict, elapsed_ms: row.elapsed_ms, cost_usd: row.cost_usd, mine, attempt_id: mine ? row.attempt_id : null,
    });
  }
  const entries = [...harnesses.values()].map(({harness, reference, runs}) => {
    const passed = runs.filter(run => run.verdict === 'pass').length;
    return {
      harness, reference, passed, scored: runs.length,
      avg_elapsed_ms: mean(runs.map(run => run.elapsed_ms).filter(value => value !== null)),
      avg_cost_usd: mean(runs.map(run => run.cost_usd).filter(value => value !== null)),
      runs: runs.sort((x, y) => new Date(y.created_at) - new Date(x.created_at)),
    };
  });
  entries.sort((x, y) => y.passed / y.scored - x.passed / x.scored || ascending(x.avg_elapsed_ms, y.avg_elapsed_ms)
    || ascending(x.avg_cost_usd, y.avg_cost_usd) || x.harness.localeCompare(y.harness));
  return entries.map((entry, index) => ({rank: index + 1, ...entry}));
}

module.exports = {REFERENCE_LABELS, leaderboard};
