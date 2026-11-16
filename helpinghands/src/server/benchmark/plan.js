'use strict';

const {BenchmarkError} = require('./errors');
const {exceeded} = require('./limits');
const {RENDERER_VERSION, canonicalJson, renderCoding, renderTaskTools, sha256Hex} = require('./prompt');

/** One case's prompt `{system, user, sha256}` under the policy and prompt text. */
function renderCase({benchmark, policy, text, c}) {
  return policy === 'coding'
    ? renderCoding(text, {task: benchmark.task, context: benchmark.context, args: c.arguments})
    : renderTaskTools({pluginName: benchmark.plugin.name, task: benchmark.task, instructions: text, args: c.arguments});
}

/** Throws unless the endpoint's workers (`capabilities`, null when none has advertised) can give `limits` and price `model`. */
function checkWorkers(limits, model, capabilities, endpointProfile) {
  if (!capabilities) throw new BenchmarkError(409, 'worker_unavailable', `No worker has advertised for endpoint profile ${endpointProfile}`);
  const over = exceeded(limits, capabilities);
  if (over.length) {
    throw new BenchmarkError(400, 'limit_exceeds_worker', `The workers for ${endpointProfile} cannot give ${over.map(o => `${o.field} ${o.limit} (at most ${o.max})`).join(', ')}`, {exceeded: over});
  }
  if (!capabilities.models.includes(model)) {
    throw new BenchmarkError(400, 'unknown_model', `No worker for ${endpointProfile} prices model ${model}; it prices ${capabilities.models.join(', ')}`, {model, models: capabilities.models});
  }
}

/**
 * What a run of `benchmark` (with its cases, public parts only) under `policy` resolves to against the endpoint's worker `capabilities`:
 * the benchmark's id and digest, every case with its rendered prompt, the prompt text the policy takes from the benchmark, and the
 * benchmark's limits. Throws when the workers cannot give the limits or the pinned template fails to render.
 */
function resolve({benchmark, policy, capabilities}) {
  checkWorkers(benchmark.limits, benchmark.model, capabilities, benchmark.endpoint_profile);
  const text = policy === 'coding' ? benchmark.coding_template : benchmark.task_instructions;
  const cases = benchmark.cases.map((c, position) => ({
    case_id: c.case_id, position, kind: c.kind, arguments: c.arguments, expected_error: c.expected_error, content_digest: c.content_digest,
    prompt: renderCase({benchmark, policy, text, c}),
  }));
  const plan = {
    benchmark_id: benchmark.benchmark_id, benchmark_digest: benchmark.digest,
    policy,
    prompt: {source: 'benchmark', text},
    limits: benchmark.limits,
    // The tool container's network under task_tools (HTTPS to these hosts only); there is no tool container under coding.
    egress_hosts: policy === 'task_tools' ? benchmark.task.egress_hosts : null,
    endpoint_profile: benchmark.endpoint_profile,
    model: benchmark.model,
    renderer_version: RENDERER_VERSION,
    cases: cases.map(({case_id: id, position, kind, content_digest: contentDigest, prompt}) => ({case_id: id, position, kind, content_digest: contentDigest, prompt})),
  };
  return {plan, cases, digest: sha256Hex(canonicalJson(plan))};
}

/** The top-level parts of two plans that differ: what made a preview stale. */
const changedParts = (a, b) => Object.keys({...a, ...b}).filter(key => canonicalJson(a[key] ?? null) !== canonicalJson(b[key] ?? null));

module.exports = {checkWorkers, resolve, changedParts};
