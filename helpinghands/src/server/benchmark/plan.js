'use strict';

const {BenchmarkError} = require('./errors');
const {exceeded} = require('./limits');

/** Throws unless the member's own worker (`capabilities`, null when it has not advertised lately) can give `limits` and price `model`. */
function checkWorkers(limits, model, capabilities, endpointProfile) {
  if (!capabilities) throw new BenchmarkError(409, 'worker_unavailable', `Your benchmark worker is not running for endpoint profile ${endpointProfile}. Open RUSH Lab on this computer: its worker starts once you are signed in there and your OpenRouter key is in Settings, and the Benchmarks page says why while it cannot`);
  const over = exceeded(limits, capabilities);
  if (over.length) {
    throw new BenchmarkError(400, 'limit_exceeds_worker', `Your worker for ${endpointProfile} cannot give ${over.map(o => `${o.field} ${o.limit} (at most ${o.max})`).join(', ')}`, {exceeded: over});
  }
  if (!capabilities.models.includes(model)) {
    throw new BenchmarkError(400, 'unknown_model', `Your worker for ${endpointProfile} does not price model ${model}; it prices ${capabilities.models.join(', ')}`, {model, models: capabilities.models});
  }
}

/**
 * The cases of `benchmark` (with its cases, public parts only) a run takes, all of them in the benchmark's order, once the
 * member's worker `capabilities` can give its limits.
 */
function resolve({benchmark, capabilities}) {
  checkWorkers(benchmark.limits, benchmark.model, capabilities, benchmark.endpoint_profile);
  const cases = benchmark.cases.map((c, position) => ({...c, position}));
  return {cases, limits: benchmark.limits};
}

module.exports = {checkWorkers, resolve};
