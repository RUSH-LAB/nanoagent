/**
 * The Benchmark Your Harness form's logic: the benchmark cards, the policy, the preview and run requests, the uploaded harness's identity,
 * and the stale-preview report. A benchmark fixes the model, endpoint, limits and prompts; the member chooses only the policy and the harness.
 */
import {personLabel} from './runs.js';

export const POLICIES = [
  ['coding', 'Coding', 'Use this for a coding agent or standalone solver. It receives a prompt with the case inputs and schemas, uses its own tools such as scripts or shell commands, and writes answer.json in the case workspace. Plugin tools are unavailable.'],
  ['task_tools', 'Task tools', 'Use this to test a harness with the plugin’s task instructions and tools. The harness can call the approved plugin tools through RUSH and writes its answer or refusal to the RUSH_RESULT path.'],
];

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A benchmark's card: name, task, creator, cases, model, runs and runners. */
export const benchmarkCard = benchmark => ({
  id: benchmark.benchmark_id,
  name: benchmark.name,
  task: benchmark.task_id,
  creator: personLabel(benchmark.publisher),
  cases: `${plural(benchmark.case_count, 'case')} (${benchmark.answer_count} answer, ${benchmark.refuse_count} refuse)`,
  model: benchmark.model,
  runs: plural(benchmark.run_count, 'run'),
  runners: plural(benchmark.runner_count, 'runner'),
});

/** The benchmarks as cards grouped by plugin version, the installed version first, then the others in the order given (newest first): `{version, installed, cards}`. */
export function benchmarkGroups(benchmarks, installedVersion) {
  const groups = new Map();
  for (const benchmark of benchmarks) {
    const {version} = benchmark.plugin;
    if (!groups.has(version)) groups.set(version, {version, installed: version === installedVersion, cards: []});
    groups.get(version).cards.push(benchmarkCard(benchmark));
  }
  return [...groups.values()].sort((a, b) => Number(b.installed) - Number(a.installed));
}

/** The body of POST previews, or `{error}` naming what is missing. */
export function previewBody({benchmarkId, policy}) {
  if (!benchmarkId) return {error: 'Choose a benchmark'};
  return {body: {benchmark_id: benchmarkId, policy}};
}

/** The body of POST runs: the preview's body and what a run adds, or `{error}` naming what is missing. */
export function runBody({key, preview, setup, source}) {
  if (!setup) return {error: 'Choose a benchmark first'};
  if (!source) return {error: 'Upload a harness source ZIP or use a reference harness'};
  if (!preview) return {error: 'Preview the run first'};
  return {body: {...setup, idempotency_key: key, preview_id: preview, source_sha256: source}};
}

/** The harness identity the uploaded manifest declared, as the labelled facts the form echoes. */
export const harnessFacts = ({harness}) => [['Name', harness.name], ['Version', harness.version], ['Dialects', harness.dialects.join(', ')]];

/**
 * The idempotency key for the next submit: the one in use while the request is unchanged, a new one when anything in it
 * changed (a key names one request; the server refuses it for another). `previous` is `{digest, key}` or null.
 */
export function keyFor(previous, body, make) {
  const digest = JSON.stringify({...body, idempotency_key: undefined});
  return previous?.digest === digest ? previous : {digest, key: make()};
}

const STALE_PARTS = {
  benchmark_id: 'The benchmark', benchmark_digest: 'The benchmark', cases: 'The resolved cases', policy: 'The participant policy', prompt: 'The prompt',
  limits: 'The limits', egress_hosts: 'The egress hosts', endpoint_profile: 'The endpoint', model: 'The model', renderer_version: 'The prompt renderer',
};

export const stalePart = name => STALE_PARTS[name] ?? name;

/** What a stale_preview answer shows for review: the parts that changed, and the setup as it resolves now. */
export function staleReport(error) {
  const details = error?.details;
  if (details?.code !== 'stale_preview') return null;
  return {stale: (details.stale ?? []).map(name => ({name, text: stalePart(name)})), current: details.current ?? null};
}

/** The tool container's network a preview resolved: its hosts, none, or not applicable under coding. */
export const egressText = preview => (preview.egress_hosts === null ? 'Not applicable: the coding policy has no tool container' : preview.egress_hosts.length ? preview.egress_hosts.join(', ') : 'None');
