'use strict';

const {REFERENCE_HARNESSES} = require('./harness');
const {SUBMIT} = require('./prompt');

// What each reference harness is called: its agent's CLI command (a unit test keeps these equal to REFERENCE_HARNESSES).
const REFERENCE_LABELS = Object.freeze({
  'nanoagent': 'nanoagent', 'claude-code': 'claude', 'codex': 'codex', 'dsh': 'dsh', 'hermes': 'hermes', 'pi': 'pi', 'shell': 'shell',
});

// The figures each run shows and each harness averages, from its attempt's metrics (a run made in RUSH records some, an imported run
// all) and its cost; a figure a run did not record is null.
const FIGURES = Object.freeze({
  latency_ms: 'elapsed_ms', model_ms: 'model_ms', tools_ms: 'tools_ms', overhead_ms: 'overhead_ms', input_tokens: 'input_tokens',
  cached_tokens: 'cache_read_tokens', output_tokens: 'output_tokens', model_calls: 'model_calls', tool_calls: 'tool_calls',
});
const figures = row => ({
  ...Object.fromEntries(Object.entries(FIGURES).map(([name, key]) => [name, typeof row.metrics?.[key] === 'number' ? row.metrics[key] : null])),
  cost_usd: row.cost_usd,
});
/** The mean of `values`, null when one of them is unknown: an average of only some runs would not be the harness's. */
const mean = values => (values.includes(null) ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
/** Smaller first, an unknown figure last. */
const ascending = (x, y) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x - y);

/**
 * A plugin's leaderboard from its scored attempts on any of its tasks (`benchmark_leaderboard` rows), as member `viewerId` sees it.
 *
 * `harnesses`: one entry per harness, a reference harness by its name and a saved one, which only its owner runs, as "name (@owner)";
 * ranked by correct rate, then average latency, then average cost. Each averages every figure (FIGURES and the cost) over its runs, null
 * when one of them did not record it.
 *
 * `cases`: the runs grouped by the case they ran (its content digest), the case of the newest run first, each run of RUSH first. A case
 * shows its arguments and its reference from the viewer's own runs of it, and nothing from other members'; only the viewer's own runs carry their attempt, whose trace is theirs alone, why they failed,
 * and what their harness was given (`inputs`): under the task tools policy (RUSH) the system prompt, the user message and the tools (the
 * task's and submit), under the coding policy the prompt and no plugin tools.
 */
function leaderboard(rows, viewerId) {
  const harnesses = new Map();
  const cases = new Map();
  for (const row of rows) {
    const reference = REFERENCE_HARNESSES.includes(row.harness_name);
    const key = reference ? row.harness_name : `${row.harness_name}@${row.user_id}`;
    const harness = reference ? REFERENCE_LABELS[row.harness_name] : `${row.harness_name} (@${row.user_github ?? row.user_name})`;
    if (!harnesses.has(key)) harnesses.set(key, {harness, reference, runs: []});
    harnesses.get(key).runs.push({verdict: row.verdict, ...figures(row)});
    if (!cases.has(row.content_digest)) {
      cases.set(row.content_digest, {content_digest: row.content_digest, case_id: row.case_id, kind: row.kind, arguments: null, reference: null, runs: []});
    }
    const shown = cases.get(row.content_digest);
    const mine = row.user_id === viewerId;
    if (mine && shown.arguments === null) Object.assign(shown, {arguments: row.arguments, reference: row.reference});
    shown.runs.push({
      harness, rush: row.harness_name === 'nanoagent', model: row.model, created_at: row.created_at, verdict: row.verdict, ...figures(row), mine,
      ...(mine
        ? {
            attempt_id: row.attempt_id, explanation: row.explanation, execution: row.execution_status, execution_reason: row.execution_reason,
            inputs: {policy: row.policy, system: row.prompt_system, user: row.prompt_user, tools: row.policy === 'coding' ? [] : [...row.tools.map(tool => tool.name), SUBMIT]},
          }
        : {attempt_id: null, explanation: null, execution: null, execution_reason: null, inputs: null}),
    });
  }
  const entries = [...harnesses.values()].map(({harness, reference, runs}) => ({
    harness, reference, rush: harness === REFERENCE_LABELS.nanoagent, passed: runs.filter(run => run.verdict === 'pass').length, scored: runs.length,
    ...Object.fromEntries([...Object.keys(FIGURES), 'cost_usd'].map(name => [`avg_${name}`, mean(runs.map(run => run[name]))])),
  }));
  entries.sort((x, y) => y.passed / y.scored - x.passed / x.scored || ascending(x.avg_latency_ms, y.avg_latency_ms)
    || ascending(x.avg_cost_usd, y.avg_cost_usd) || x.harness.localeCompare(y.harness));
  // Rows come newest first, so each case's runs and the cases themselves are in that order already.
  for (const shown of cases.values()) shown.runs.sort((x, y) => y.rush - x.rush || x.harness.localeCompare(y.harness));
  return {harnesses: entries.map((entry, index) => ({rank: index + 1, ...entry})), cases: [...cases.values()]};
}

module.exports = {REFERENCE_LABELS, leaderboard};
