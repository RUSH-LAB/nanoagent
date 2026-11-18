'use strict';

const crypto = require('crypto');
const {BenchmarkError} = require('./errors');
const {DEFAULT_LIMITS} = require('./limits');
const {REFERENCE_HARNESSES} = require('./harness');
const {checkWorkers, resolve, changedParts} = require('./plan');
const {RENDERER_VERSION, DEFAULT_CODING_TEMPLATE, PLACEHOLDERS, canonicalJson, sha256Hex} = require('./prompt');

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

    /**
     * Queue the run of a session in a plugin page's Harness tab before its one case is pinned: `frame` (`publicationFrame`, with the
     * case's id as `case_id`) is its case set but the case, `source` the harness (`saveSource`'s answer) and `policy` the one it works
     * under. It is a run of a benchmark nobody publishes, which the member's benchmark results never list; an `interactive` one's
     * member is at its terminal, and a one-shot one (`nanoagent harness prompt=…`) runs alone. `{run_id, session}`, where `session`
     * is what `pinSession` takes once the case is pinned. A free-form Terminal session's frame has `case_id` null: its run has no case
     * and one attempt, which nothing pins.
     */
    async session(context, frame, source, policy, {interactive}) {
      checkWorkers(frame.limits, frame.model, await repository.capabilities(context.userId, frame.endpoint_profile), frame.endpoint_profile);
      const benchmark = {
        benchmark_id: crypto.randomUUID(), name: frame.name, publisher: await repository.publisher(context.userId),
        plugin: {id: frame.plugin_id, name: frame.plugin_name, version: frame.version, sha256: frame.package_sha256},
        case_set_id: null, case_set_digest: null, task_id: frame.task_id, task: frame.task, context: frame.context,
        model: frame.model, endpoint_profile: frame.endpoint_profile, limits: frame.limits,
        coding_template: frame.coding_template, task_instructions: frame.task_instructions,
      };
      const plan = {
        policy, prompt: {source: 'benchmark', text: policy === 'coding' ? frame.coding_template : frame.task_instructions}, limits: frame.limits,
        endpoint_profile: frame.endpoint_profile, model: frame.model, renderer_version: RENDERER_VERSION,
      };
      const cases = frame.case_id === null ? [] : [{case_id: frame.case_id, position: 0, kind: 'answer', arguments: null, expected_error: null, content_digest: null, prompt: null}];
      // The preview is kept with this id once the case is pinned, as the plan it resolves to has the case's prompt.
      const request = {benchmark_id: benchmark.benchmark_id, policy, preview_id: crypto.randomUUID(), source_sha256: source.source_sha256, idempotency_key: crypto.randomUUID()};
      const {run_id: runId} = await repository.createRun(
        context, {...request, request_digest: sha256Hex(canonicalJson(request))}, {plan, cases}, benchmark, source.harness, {session: true, interactive, free: !cases.length},
      );
      return {run_id: runId, session: {run_id: runId, benchmark, policy, preview_id: request.preview_id, frame}};
    },

    /**
     * Pin the case of a session `session.session` gave, from `publication` (validated): its case set, on the same frame, is kept as
     * publishing keeps one and resolved against the member's worker as any run's, and the run's case filled in.
     */
    async pinSession(context, {run_id: runId, benchmark, policy, preview_id: previewId, frame}, publication) {
      const differing = Object.keys(frame).filter(key => key !== 'case_id' && canonicalJson(frame[key]) !== canonicalJson(publication[key]));
      if (publication.cases.length !== 1 || publication.cases[0].case_id !== frame.case_id) differing.push('cases');
      if (differing.length) throw new BenchmarkError(422, 'case_mismatch', `The pinned case set differs from the session's: ${differing.join(', ')}`);
      await repository.saveCaseSet(context.userId, publication);
      const pinned = {...benchmark, case_set_id: publication.case_set_digest, case_set_digest: publication.case_set_digest, digest: publication.digest, cases: publication.cases};
      const {resolved} = await resolveRequest(context, pinned, {policy});
      await repository.savePreview(context, keptPlan(resolved.plan), resolved.digest, previewId);
      await repository.pinSessionCase(context, runId, pinned, resolved.cases[0]);
    },
  });
}

module.exports = {createBenchmarkService};
