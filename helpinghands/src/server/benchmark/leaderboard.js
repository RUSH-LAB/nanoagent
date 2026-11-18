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
 * A plugin's leaderboard from its scored attempts on any of its tasks (`benchmark_leaderboard` rows), as member `viewerId` sees it.
 *
 * `harnesses`: one entry per harness, a reference harness by its name and a saved one, which only its owner runs, as "name (@owner)";
 * ranked by correct rate, then average time, then average cost.
 *
 * `cases`: the runs grouped by the case they ran (its content digest), the case of the newest run first, each run of RUSH first. A case
 * shows its arguments, the prompt its coding harnesses got (or RUSH's, with no coding run) and its reference from the viewer's own runs
 * of it, and nothing from other members'; only the viewer's own runs carry their attempt, whose trace is theirs alone, and why they failed.
 */
function leaderboard(rows, viewerId) {
  const harnesses = new Map();
  const cases = new Map();
  for (const row of rows) {
    const reference = REFERENCE_HARNESSES.includes(row.harness_name);
    const key = reference ? row.harness_name : `${row.harness_name}@${row.user_id}`;
    const harness = reference ? REFERENCE_LABELS[row.harness_name] : `${row.harness_name} (@${row.user_github ?? row.user_name})`;
    if (!harnesses.has(key)) harnesses.set(key, {harness, reference, runs: []});
    harnesses.get(key).runs.push(row);
    if (!cases.has(row.content_digest)) {
      cases.set(row.content_digest, {content_digest: row.content_digest, case_id: row.case_id, kind: row.kind, arguments: null, prompt: null, reference: null, runs: []});
    }
    const shown = cases.get(row.content_digest);
    const mine = row.user_id === viewerId;
    if (mine && shown.arguments === null) Object.assign(shown, {arguments: row.arguments, reference: row.reference});
    if (mine && (shown.prompt === null || (shown.prompt.policy !== 'coding' && row.policy === 'coding'))) {
      shown.prompt = {policy: row.policy, system: row.prompt_system, user: row.prompt_user};
    }
    shown.runs.push({
      harness, rush: row.harness_name === 'nanoagent', model: row.model, created_at: row.created_at, verdict: row.verdict,
      elapsed_ms: row.elapsed_ms, input_tokens: row.input_tokens === null ? null : Number(row.input_tokens),
      output_tokens: row.output_tokens === null ? null : Number(row.output_tokens), cost_usd: row.cost_usd, mine,
      ...(mine
        ? {attempt_id: row.attempt_id, explanation: row.explanation, execution: row.execution_status, execution_reason: row.execution_reason}
        : {attempt_id: null, explanation: null, execution: null, execution_reason: null}),
    });
  }
  const entries = [...harnesses.values()].map(({harness, reference, runs}) => {
    const passed = runs.filter(run => run.verdict === 'pass').length;
    return {
      harness, reference, rush: harness === REFERENCE_LABELS.nanoagent, passed, scored: runs.length,
      avg_elapsed_ms: mean(runs.map(run => run.elapsed_ms).filter(value => value !== null)),
      avg_cost_usd: mean(runs.map(run => run.cost_usd).filter(value => value !== null)),
    };
  });
  entries.sort((x, y) => y.passed / y.scored - x.passed / x.scored || ascending(x.avg_elapsed_ms, y.avg_elapsed_ms)
    || ascending(x.avg_cost_usd, y.avg_cost_usd) || x.harness.localeCompare(y.harness));
  // Rows come newest first, so each case's runs and the cases themselves are in that order already.
  for (const shown of cases.values()) shown.runs.sort((x, y) => y.rush - x.rush || x.harness.localeCompare(y.harness));
  return {harnesses: entries.map((entry, index) => ({rank: index + 1, ...entry})), cases: [...cases.values()]};
}

module.exports = {REFERENCE_LABELS, leaderboard};
