'use strict';

const {BenchmarkError} = require('./errors');
const {DEFAULT_LIMITS} = require('./limits');
const {REFERENCE_HARNESSES} = require('./harness');
const {checkWorkers, resolve, changedParts} = require('./plan');
const {RENDERER_VERSION, DEFAULT_CODING_TEMPLATE, PLACEHOLDERS} = require('./prompt');

/** The plan a preview keeps: all but the rendered prompts, which resolving the same request again gives back. */
const keptPlan = plan => ({...plan, cases: plan.cases.map(({prompt, ...rest}) => ({...rest, prompt_sha256: prompt.sha256}))});

/** A benchmark as listed: without the case set's task, context and cases. */
const summaryOf = ({task, context, cases, ...summary}) => summary;

/**
 * What a member does with benchmarks over the repository: the defaults a publication starts from, publishing, previews, and submitting a run.
 * A request (validated by `previewBody`/`runBody`) names a published benchmark, so nothing is read from the member's installed apps.
 */
function createBenchmarkService({repository}) {
  const benchmarkOf = async (context, id) => {
    const benchmark = await repository.benchmark(context, id);
    if (!benchmark) throw new BenchmarkError(404, 'unknown_benchmark', `No such benchmark: ${id}`);
    return benchmark;
  };

  async function resolveRequest(context, benchmark, request) {
    const capabilities = await repository.capabilities(context.userId, benchmark.endpoint_profile);
    return {capabilities, resolved: resolve({benchmark, policy: request.policy, capabilities})};
  }

  const view = ({plan, cases}, benchmark, capabilities) => ({
    benchmark: summaryOf(benchmark), policy: plan.policy, prompt: plan.prompt,
    limits: {effective: plan.limits, capabilities}, egress_hosts: plan.egress_hosts, endpoint_profile: plan.endpoint_profile, model: plan.model,
    renderer_version: plan.renderer_version, unverified_egress: plan.limits.internet_access,
    cases: cases.map(({case_id: caseId, position, kind, content_digest: contentDigest, prompt}) => ({case_id: caseId, position, kind, content_digest: contentDigest, prompt})),
  });

  return Object.freeze({
    /** What a publication starts from: the default limits, the default coding template and its placeholders, and the capabilities of the member's own worker for each endpoint; and the reference harnesses a run may use. */
    async defaults(userId) {
      return {
        limits: DEFAULT_LIMITS, coding_template: DEFAULT_CODING_TEMPLATE, placeholders: PLACEHOLDERS, renderer_version: RENDERER_VERSION,
        endpoints: await repository.endpoints(userId), reference_harnesses: REFERENCE_HARNESSES,
      };
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

    async preview(context, request) {
      const benchmark = await benchmarkOf(context, request.benchmark_id);
      const {resolved, capabilities} = await resolveRequest(context, benchmark, request);
      const previewId = await repository.savePreview(context, keptPlan(resolved.plan), resolved.digest);
      return {preview_id: previewId, ...view(resolved, benchmark, capabilities)};
    },

    /** Pin and queue a run from `request` (validated), or answer 409 stale_preview with what is current. */
    async submit(context, request) {
      const replay = await repository.runByKey(context, request.idempotency_key);
      if (replay) {
        if (replay.request_digest !== request.request_digest) throw new BenchmarkError(409, 'idempotency_conflict', 'That idempotency_key was used for a different request');
        return {run_id: replay.run_id, replayed: true};
      }
      const benchmark = await benchmarkOf(context, request.benchmark_id);
      const stored = await repository.preview(context, request.preview_id);
      if (!stored) throw new BenchmarkError(404, 'unknown_preview', 'No such preview');
      const source = await repository.source(context, request.source_sha256);
      if (!source) throw new BenchmarkError(404, 'unknown_source', 'Upload the source first');
      const {capabilities, resolved} = await resolveRequest(context, benchmark, request);
      if (resolved.digest !== stored.plan_digest) {
        const stale = changedParts(stored.plan, keptPlan(resolved.plan));
        throw new BenchmarkError(409, 'stale_preview', 'The request no longer resolves to what was previewed; review the current setup and preview again', {stale, current: view(resolved, benchmark, capabilities)});
      }
      return repository.createRun(context, request, resolved, benchmark, source.harness);
    },
  });
}

module.exports = {createBenchmarkService, summaryOf};
