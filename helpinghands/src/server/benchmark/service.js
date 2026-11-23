'use strict';

const crypto = require('crypto');
const {BenchmarkError} = require('./errors');
const {DEFAULT_LIMITS, RUN_ENDPOINT, RUN_MODEL, RUN_PROVIDERS} = require('./limits');
const {AGENTS, rushProgram} = require('./harness');
const {checkWorkers, resolve} = require('./plan');
const {canonicalJson, sha256Hex} = require('./prompt');

/** A benchmark as listed: without the case set's task and cases. */
const summaryOf = ({task, cases, ...summary}) => summary;

/**
 * What a member does with benchmarks over the repository: the defaults a publication starts from, publishing, and submitting a run.
 * A request (validated by `runBody`) names a published benchmark and a harness, so nothing is read from the member's installed apps.
 */
function createBenchmarkService({repository}) {
  const benchmarkOf = async (context, id) => {
    const benchmark = await repository.benchmark(context, id);
    if (!benchmark) throw new BenchmarkError(404, 'unknown_benchmark', `No such benchmark: ${id}`);
    return benchmark;
  };

  return Object.freeze({
    /** What a publication starts from: the default limits and the capabilities of the member's own worker for each endpoint; and the agents a run may name as its harness (or `rush <command>`). */
    async defaults(userId) {
      return {limits: DEFAULT_LIMITS, endpoint_profile: RUN_ENDPOINT, model: RUN_MODEL, endpoints: await repository.endpoints(userId), harnesses: AGENTS};
    },

    /**
     * Publish a validated benchmark (`benchmarkPublication`) as `userId`, once the member's own worker can give its limits: `{created, benchmark}`.
     * Nothing is stored when it is refused.
     */
    async publish(userId, publication) {
      checkWorkers(publication.limits, publication.model, await repository.capabilities(userId, publication.endpoint_profile), publication.endpoint_profile);
      const {created, benchmark_id: id} = await repository.publishBenchmark(userId, publication);
      return {created, benchmark: summaryOf(await repository.benchmark({userId}, id))};
    },

    /** Pin and queue a run from `request` (validated): one attempt per case of the benchmark. */
    async submit(context, request) {
      const replay = await repository.runByKey(context, request.idempotency_key);
      if (replay) {
        if (replay.request_digest !== request.request_digest) throw new BenchmarkError(409, 'idempotency_conflict', 'That idempotency_key was used for a different request');
        return {run_id: replay.run_id, replayed: true};
      }
      const benchmark = await benchmarkOf(context, request.benchmark_id);
      const agent = rushProgram(request.harness) ?? undefined;
      const capabilities = await repository.capabilities(context.userId, benchmark.endpoint_profile, {agent});
      if (agent && !capabilities) throw new BenchmarkError(400, 'agent_not_installed', 'This agent is not installed in a kept Terminal session on your computer.');
      const plan = resolve({benchmark, capabilities});
      if (agent && !capabilities.installed_agents?.includes(agent)) {
        throw new BenchmarkError(400, 'agent_not_installed', 'This agent is not installed in a kept Terminal session on your computer.');
      }
      return repository.createRun(context, request, plan, benchmark);
    },

    /**
     * Queue a free-form Terminal session (nothing of a plugin is opened for it): `frame` is `{name, plugin_id, model, endpoint_profile, limits}`,
     * the page it was opened from and what the Terminal runs on. It is a run of a benchmark nobody publishes, which the member's benchmark results
     * never list; its run has no case and one attempt of none. `{run_id, attempt_id}`.
     */
    async session(context, frame, {interactive, resumedFrom = null, startCli = null, resumeChat = null}) {
      checkWorkers(frame.limits, frame.model, await repository.capabilities(context.userId, frame.endpoint_profile), frame.endpoint_profile);
      const benchmark = {
        benchmark_id: crypto.randomUUID(), name: frame.name, publisher: await repository.publisher(context.userId),
        plugin: {id: frame.plugin_id, name: null, version: null, sha256: null},
        case_set_id: null, case_set_digest: null, task_id: null, task: null,
        model: frame.model, endpoint_profile: frame.endpoint_profile, providers: RUN_PROVIDERS, limits: frame.limits,
      };
      const request = {benchmark_id: benchmark.benchmark_id, harness: 'shell', idempotency_key: crypto.randomUUID()};
      const {run_id: runId, attempt_id: attemptId} = await repository.createRun(
        context, {...request, request_digest: sha256Hex(canonicalJson(request))}, {cases: [], limits: frame.limits}, benchmark, {session: true, interactive, free: true, resumedFrom, startCli, resumeChat},
      );
      return {run_id: runId, attempt_id: attemptId};
    },
  });
}

module.exports = {createBenchmarkService};
