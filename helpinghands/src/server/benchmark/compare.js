'use strict';

const {diffLines} = require('diff');
const {BenchmarkError} = require('./errors');
const {LIMIT_FIELDS} = require('./limits');
const {canonicalJson} = require('./prompt');

const PAGE = 1000;
// What one attempt's comparison loads into memory: its events' data and its payloads' bytes.
const MAX_EVIDENCE_EVENT_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_PAYLOAD_BYTES = 64 * 1024 * 1024;

const tooLarge = (attemptId, what) => new BenchmarkError(413, 'evidence_too_large', `Attempt ${attemptId} is too large to compare: it has over ${what}`);

/** Everything one sealed attempt stored that the comparison reads, under the member's own access. */
async function evidenceOf(repository, context, attemptId) {
  const attempt = await repository.attempt(context, attemptId);
  if (!attempt) throw new BenchmarkError(404, 'unknown_attempt', `No such attempt: ${attemptId}`);
  if (!attempt.sealed) throw new BenchmarkError(409, 'attempt_not_sealed', `Attempt ${attemptId} is not sealed; compare only sealed attempts`);
  const run = await repository.run(context, attempt.run_id);
  const pinned = run?.cases.find(candidate => candidate.case_id === attempt.case_id);
  if (!pinned) throw new BenchmarkError(404, 'unknown_attempt', `No such attempt: ${attemptId}`);
  const records = [];
  let eventBytes = 0;
  for (let after = 0;;) {
    const page = await repository.events(context, attemptId, after, PAGE);
    if (!page) throw new BenchmarkError(404, 'unknown_attempt', `No such attempt: ${attemptId}`);
    records.push(...page.events);
    eventBytes += page.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.data)), 0);
    if (eventBytes > MAX_EVIDENCE_EVENT_BYTES) throw tooLarge(attemptId, `${MAX_EVIDENCE_EVENT_BYTES} bytes of events`);
    if (!page.has_more) break;
    after = page.events.at(-1).cursor;
  }
  const payloads = {};
  const redactions = {};
  const missing = [];
  let payloadBytes = 0;
  for (const sha of new Set(records.flatMap(event => event.payload_sha256s ?? [])).values()) {
    const stored = await repository.payload(context, attemptId, sha);
    if (!stored) {
      missing.push(sha);
      continue;
    }
    payloadBytes += stored.size;
    if (payloadBytes > MAX_EVIDENCE_PAYLOAD_BYTES) throw tooLarge(attemptId, `${MAX_EVIDENCE_PAYLOAD_BYTES} bytes of payloads`);
    payloads[sha] = Buffer.from(stored.data).toString('base64');
    redactions[sha] = stored.redaction;
  }
  return {
    attempt,
    verifier: {package_sha256: run.case_set.plugin.sha256, task_id: run.case_set.task_id},
    identity: {package_sha256: run.case_set.plugin.sha256, task_id: run.case_set.task_id, content_digest: pinned.content_digest},
    records, payloads, redactions, missing: missing.sort(),
  };
}

/**
 * The comparison of two sealed attempts of the same pinned case (same package digest, task and case content digest), from their
 * stored evidence alone. NanoAgent computes it with the projection and comparison the CLI's step 4 runs
 * (nanoagent.uploaded.compare_view); `ai.benchmarkCompare` posts the evidence to it.
 */
async function compareAttempts({repository, ai, context, a, b}) {
  const [first, second] = [await evidenceOf(repository, context, a), await evidenceOf(repository, context, b)];
  const differing = Object.keys(first.verifier).filter(key => first.verifier[key] !== second.verifier[key]);
  if (differing.length) {
    throw new BenchmarkError(409, 'not_same_verifier', `The attempts do not share a task verifier: ${differing.join(', ')} differ`, {differing});
  }
  if (first.identity.content_digest !== second.identity.content_digest) {
    throw new BenchmarkError(409, 'not_same_case', 'The attempts are not the same pinned case: their content digests differ', {differing: ['content_digest']});
  }
  const sides = [first, second].map(({records, payloads, redactions}) => ({records, payloads, redactions}));
  const result = await ai.benchmarkCompare({a: sides[0], b: sides[1]});
  if (result.error) throw new BenchmarkError(result.status === 400 ? 502 : result.status ?? 502, 'compare_unavailable', result.error);
  const {rows, first_difference: firstDifference, ...conditions} = result.value;
  return {
    header: {
      attempt_a: a, attempt_b: b, case: first.identity, ...conditions,
      redactions: {a: [...new Set(Object.values(first.redactions))].sort(), b: [...new Set(Object.values(second.redactions))].sort()},
      missing_payloads: {a: first.missing, b: second.missing},
    },
    rows, first_difference: firstDifference,
  };
}

/** `a` against `b` line by line, as `[{type: 'same' | 'removed' | 'added', text}]`. */
const textDiff = (a, b) => diffLines(a ?? '', b ?? '').filter(part => part.value)
  .map(part => ({type: part.added ? 'added' : part.removed ? 'removed' : 'same', text: part.value}));

/** What one side of an aligned case shows: its newest attempt's outcome, verdict, tokens, cost and latency. */
function sideOf(c, costs) {
  const attempt = c.attempts.find(candidate => candidate.attempt_id === c.latest_attempt_id) ?? null;
  const metrics = attempt?.metrics ?? {};
  // A complete attempt with no admitted call spent nothing: its cost is a known zero, not an unknown one.
  const spent = attempt ? costs.get(attempt.attempt_id) ?? (attempt.sealed && attempt.coverage?.status === 'complete' ? {cost_usd: 0, uncertain_calls: 0} : undefined) : undefined;
  return {
    case_id: c.case_id, attempt_id: attempt?.attempt_id ?? null,
    outcome: attempt ? attempt.execution?.status ?? attempt.state : null, execution_reason: attempt?.execution?.reason ?? null,
    verdict: attempt?.verdict ?? null, explanation: attempt?.explanation ?? null, verifier_error: attempt?.verifier_error ?? null,
    tokens: {total: metrics.total_tokens ?? null, input: metrics.input_tokens ?? null, output: metrics.output_tokens ?? null},
    cost_usd: spent?.cost_usd ?? null, uncertain_cost: (spent?.uncertain_calls ?? 0) > 0, latency_ms: metrics.elapsed_ms ?? null,
  };
}

/** Every setting of a run that a comparison shows, as `{field: value}`. */
function configOf(run) {
  return {
    benchmark_id: run.benchmark.benchmark_id, harness: `${run.harness.name}@${run.harness.version}`,
    case_set_id: run.case_set.case_set_id, case_set_digest: run.case_set.digest, policy: run.policy, model: run.model,
    endpoint_profile: run.endpoint_profile, dialects: run.dialects,
    ...Object.fromEntries(LIMIT_FIELDS.map(name => [`limits.${name}`, run.limits[name]])),
    egress_hosts: run.egress_hosts,
    selection: run.cases.map(c => c.case_id), renderer_version: run.prompt.renderer_version,
  };
}

const summaryOf = run => ({
  run_id: run.run_id, status: run.status, case_set_id: run.case_set.case_set_id, case_set_name: run.case_set.name, policy: run.policy, model: run.model,
  endpoint_profile: run.endpoint_profile, score: run.score, source: run.source, created_at: run.created_at,
});

/**
 * The comparison of two runs that share a task verifier (the same plugin package digest and task id), whatever their case sets, selections,
 * policies, models, prompts and limits: every difference in configuration, the prompt text diffed (and each shared case's rendered prompt),
 * the cases both ran aligned by their pinned content, those only one ran, and whether either run had internet access (egress that
 * the gateway cannot account for).
 */
async function compareRuns({repository, context, a, b}) {
  const load = async id => {
    const run = await repository.run(context, id);
    if (!run) throw new BenchmarkError(404, 'unknown_run', `No such run: ${id}`);
    return {run, costs: await repository.runCosts(context, id)};
  };
  const [first, second] = [await load(a), await load(b)];
  const verifier = run => ({package_sha256: run.case_set.plugin.sha256, task_id: run.case_set.task_id});
  const differing = Object.keys(verifier(first.run)).filter(key => verifier(first.run)[key] !== verifier(second.run)[key]);
  if (differing.length) {
    throw new BenchmarkError(409, 'not_same_verifier', `The runs do not share a task verifier: ${differing.join(', ')} differ`, {differing});
  }
  const [left, right] = [configOf(first.run), configOf(second.run)];
  const config = Object.keys(left).map(field => ({field, a: left[field], b: right[field], differs: canonicalJson(left[field]) !== canonicalJson(right[field])}));
  // Cases align by content, the n-th occurrence of a digest in one run with the n-th in the other.
  const waiting = new Map();
  for (const c of second.run.cases) waiting.set(c.content_digest, [...(waiting.get(c.content_digest) ?? []), c]);
  const shared = [];
  const onlyA = [];
  for (const c of first.run.cases) {
    const match = waiting.get(c.content_digest)?.shift();
    if (match) shared.push({content_digest: c.content_digest, kind: c.kind, a: sideOf(c, first.costs), b: sideOf(match, second.costs), prompts: [c.prompt, match.prompt]});
    else onlyA.push({content_digest: c.content_digest, kind: c.kind, ...sideOf(c, first.costs)});
  }
  const onlyB = [...waiting.values()].flat().sort((x, y) => x.position - y.position)
    .map(c => ({content_digest: c.content_digest, kind: c.kind, ...sideOf(c, second.costs)}));
  return {
    verifier: verifier(first.run),
    a: summaryOf(first.run), b: summaryOf(second.run),
    config, differences: config.filter(entry => entry.differs).map(entry => entry.field),
    prompt_diff: {
      a_kind: first.run.policy === 'coding' ? 'template' : 'instructions', b_kind: second.run.policy === 'coding' ? 'template' : 'instructions',
      text: textDiff(first.run.prompt.text, second.run.prompt.text),
      rendered: shared.map(({content_digest: digest, a: left_, b: right_, prompts: [pa, pb]}) => {
        const identical = pa.sha256 === pb.sha256 && pa.system === pb.system && pa.user === pb.user;
        return {
          content_digest: digest, a_case_id: left_.case_id, b_case_id: right_.case_id, identical,
          ...(identical ? {} : {system: textDiff(pa.system, pb.system), user: textDiff(pa.user, pb.user)}),
        };
      }),
    },
    shared: shared.map(({prompts, ...rest}) => rest),
    only_a: onlyA, only_b: onlyB,
    unverified_egress: {a: first.run.unverified_egress, b: second.run.unverified_egress},
  };
}

module.exports = {compareAttempts, compareRuns};
