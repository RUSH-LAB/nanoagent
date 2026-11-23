import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const route = loadRoute('benchmark');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const CONTEXT = {userId: 'u', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const SHA = 'a'.repeat(64);
const PATH = '/api/benchmark/compare/attempts';
const RUN_PATH = '/api/benchmark/compare';

const event = (cursor, payloads = []) => ({cursor, event_id: `e${cursor}`, source: 'worker', kind: 'k', sequence: cursor, occurred_ns: '1', data: {}, payload_sha256s: payloads});

/** A repository holding attempts a and b of one pinned case, `held[id]` overriding what one holds. */
function repository(held = {}) {
  const attempts = {
    [A]: {attempt_id: A, run_id: 'run-a', case_id: 'c', sealed: true, digest: 'd1', sha: 'pkg', task: 't', ...held[A]},
    [B]: {attempt_id: B, run_id: 'run-b', case_id: 'c', sealed: true, digest: 'd1', sha: 'pkg', task: 't', ...held[B]},
  };
  const calls = [];
  return {
    calls,
    async attempt(_context, id) { return attempts[id] ?? null; },
    async run(_context, runId) {
      const attempt = Object.values(attempts).find(candidate => candidate.run_id === runId);
      return {case_set: {plugin: {sha256: attempt.sha}, task_id: attempt.task}, cases: [{case_id: attempt.case_id, content_digest: attempt.digest}]};
    },
    async events(_context, id, after, limit) {
      calls.push(['events', id, after, limit]);
      const all = [event(1, [SHA]), event(2), event(3, ['b'.repeat(64)])];
      const events = all.filter(item => item.cursor > after).slice(0, 2);
      return {events, has_more: events.at(-1).cursor < 3, sealed: true, final_cursor: 3, high_water_cursor: 3};
    },
    async payload(_context, id, sha) { return sha === SHA ? {data: Buffer.from('hello'), redaction: 'redacted'} : null; },
  };
}

const run = (repo, ai, query = {a: A, b: B}, method = 'GET') => invoke(route, {
  method, path: PATH, query, requestContext: CONTEXT,
  ctx: makeCtx({benchmark: {repository: repo, service: {}}, ai}),
});

describe('GET /api/benchmark/compare/attempts', () => {
  it('posts both attempts\' pages of events and payloads to NanoAgent and returns its comparison under a header', async () => {
    const repo = repository();
    const posted = [];
    const ai = {benchmarkCompare: async body => { posted.push(body); return {value: {conditions_a: {}, conditions_b: {}, condition_differences: [], unknown_fields: ['model'], estimate_delta_ns: 5, estimate_withheld: null, rows: [{index: 0, status: 'same'}], first_difference: null}}; }};
    const {status, payload} = await run(repo, ai);
    assert.equal(status, 200);
    assert.deepEqual(payload.rows, [{index: 0, status: 'same'}]);
    assert.equal(payload.first_difference, null);
    assert.deepEqual(payload.header.case, {package_sha256: 'pkg', task_id: 't', content_digest: 'd1'});
    assert.deepEqual([payload.header.attempt_a, payload.header.attempt_b, payload.header.unknown_fields], [A, B, ['model']]);
    assert.deepEqual(payload.header.redactions, {a: ['redacted'], b: ['redacted']});
    assert.deepEqual(payload.header.missing_payloads, {a: ['b'.repeat(64)], b: ['b'.repeat(64)]});
    assert.equal(posted[0].a.records.length, 3);
    assert.equal(posted[0].a.payloads[SHA], Buffer.from('hello').toString('base64'));
    assert.deepEqual(repo.calls.filter(call => call[1] === A).map(call => call[2]), [0, 2]);
  });

  it('refuses attempts that do not share a verifier or a pinned case, and an unsealed one, without asking NanoAgent', async () => {
    const ai = {benchmarkCompare: async () => { throw new Error('must not be called'); }};
    for (const [held, code] of [
      [{[B]: {case_id: 'other', digest: 'd2'}}, 'not_same_case'], [{[B]: {digest: 'd2'}}, 'not_same_case'],
      [{[B]: {sha: 'other'}}, 'not_same_verifier'], [{[B]: {task: 'u'}}, 'not_same_verifier'], [{[B]: {sealed: false}}, 'attempt_not_sealed'],
    ]) {
      const {status, payload} = await run(repository(held), ai);
      assert.equal(payload.code, code);
      assert.ok([404, 409].includes(status));
    }
  });

  it('answers 400 for an id that is not a UUID, 404 for an attempt the member cannot see, 405 for a write', async () => {
    const ai = {benchmarkCompare: async () => ({value: {}})};
    assert.equal((await run(repository(), ai, {a: A, b: 'x'})).status, 400);
    const none = repository();
    none.attempt = async () => null;
    assert.equal((await run(none, ai)).payload.code, 'unknown_attempt');
    assert.equal((await run(repository(), ai, {a: A, b: B}, 'POST')).status, 405);
  });

  it('relays NanoAgent being unavailable', async () => {
    const {status, payload} = await run(repository(), {benchmarkCompare: async () => ({error: 'Could not reach NanoAgent.', status: 502})});
    assert.equal(status, 502);
    assert.equal(payload.code, 'compare_unavailable');
  });
});

// Runs as repository.run shows them.
const limits = {wall_time_ms: 600000, max_model_calls: 50, max_output_tokens_per_call: 32768, max_cost_usd: 1.5, cpus: 1, memory_mb: 1024, pids: 256,
  workspace_bytes: 1, workspace_files: 1, tmp_bytes: 1, build_wall_ms: 1, build_memory_mb: 1, build_output_bytes: 1, build_files: 1, build_tmp_bytes: 1, internet_access: true};
const caseOf = (id, digest, position, user, attempt = {}) => ({
  case_id: id, position, kind: 'answer', content_digest: digest, prompt: user, prompt_sha256: `sha-${user}`, latest_attempt_id: `att-${id}`,
  attempts: [{attempt_id: `att-${id}`, state: 'final', execution: {status: 'answered', reason: null}, verdict: 'pass', verifier_error: null, metrics: {total_tokens: 10, input_tokens: 6, output_tokens: 4, elapsed_ms: 99}, ...attempt}],
});
const runOf = (id, overrides = {}) => ({
  run_id: id, status: 'complete', created_at: 't', benchmark: {benchmark_id: 'b1', name: 'bm'}, harness: {name: 'claude'}, model: 'm1', endpoint_profile: 'mock', limits, unverified_egress: true, egress_hosts: null,
  score: {value: 1},
  case_set: {case_set_id: 'cs@u', name: 'cs', digest: 'dd', plugin: {id: 'p', sha256: 'pkg'}, task_id: 't'},
  cases: [caseOf('a1', 'd-1', 0, 'one'), caseOf('a2', 'd-2', 1, 'two')],
  ...overrides,
});
const runRepository = runs => ({
  async run(_context, id) { return runs[id] ?? null; },
  async runCosts(_context, id) { return new Map([[`att-${runs[id].cases[0].case_id}`, {cost_usd: 0.25, calls: 2, uncertain_calls: 1}]]); },
});
const RA = '33333333-3333-4333-8333-333333333333';
const RB = '44444444-4444-4444-8444-444444444444';
const compareRuns = (runs, query = {a: RA, b: RB}) => invoke(route, {
  method: 'GET', path: RUN_PATH, query, requestContext: CONTEXT, ctx: makeCtx({benchmark: {repository: runRepository(runs), service: {}}}),
});

describe('GET /api/benchmark/compare (runs)', () => {
  it('aligns shared cases by content digest, lists the others, and shows every configuration difference', async () => {
    const {status, payload} = await compareRuns({
      [RA]: runOf(RA),
      [RB]: runOf(RB, {
        model: 'm2', unverified_egress: false, limits: {...limits, internet_access: false, memory_mb: 512},
        benchmark: {benchmark_id: 'b2', name: 'other'}, harness: {name: 'nanoagent'},
        case_set: {case_set_id: 'other', name: 'other', digest: 'ee', plugin: {id: 'p', sha256: 'pkg'}, task_id: 't'},
        cases: [caseOf('x9', 'd-2', 0, 'two'), caseOf('x1', 'd-3', 1, 'three', {verdict: 'fail', execution: {status: 'refused', reason: null}})],
      }),
    });
    assert.equal(status, 200);
    assert.deepEqual(payload.verifier, {package_sha256: 'pkg', task_id: 't'});
    assert.deepEqual(payload.shared.map(c => [c.content_digest, c.a.case_id, c.b.case_id]), [['d-2', 'a2', 'x9']]);
    assert.deepEqual(payload.only_a.map(c => c.case_id), ['a1']);
    assert.deepEqual(payload.only_b.map(c => [c.case_id, c.outcome, c.verdict]), [['x1', 'refused', 'fail']]);
    assert.deepEqual(payload.differences.sort(), [
      'benchmark_id', 'case_set_digest', 'case_set_id', 'harness', 'limits.internet_access', 'limits.memory_mb', 'model', 'selection',
    ]);
    assert.deepEqual(payload.unverified_egress, {a: true, b: false});
    assert.deepEqual(payload.config.find(entry => entry.field === 'limits.memory_mb'), {field: 'limits.memory_mb', a: 1024, b: 512, differs: true});
    assert.deepEqual([payload.a.harness, payload.b.harness], ['claude', 'nanoagent']);
    assert.deepEqual(payload.prompt_diff.rendered.map(r => [r.content_digest, r.identical]), [['d-2', true]]);
    assert.deepEqual(payload.shared[0].a, {
      case_id: 'a2', attempt_id: 'att-a2', outcome: 'answered', execution_reason: null, verdict: 'pass', explanation: null, verifier_error: null,
      tokens: {total: 10, input: 6, output: 4}, cost_usd: null, uncertain_cost: false, latency_ms: 99,
    });
    assert.equal(payload.only_a[0].cost_usd, 0.25);
    assert.equal(payload.only_a[0].uncertain_cost, true);
  });

  it('diffs the prompt of a shared case when it differs', async () => {
    const {payload} = await compareRuns({
      [RA]: runOf(RA),
      [RB]: runOf(RB, {cases: [caseOf('a1', 'd-1', 0, 'one changed'), caseOf('a2', 'd-2', 1, 'two')]}),
    });
    assert.deepEqual(payload.prompt_diff.rendered.map(r => r.identical), [false, true]);
    assert.deepEqual(payload.prompt_diff.rendered[0].text, [{type: 'removed', text: 'one'}, {type: 'added', text: 'one changed'}]);
  });

  it('refuses runs that do not share a task verifier, with 409 not_same_verifier', async () => {
    for (const case_set of [{plugin: {sha256: 'other'}, task_id: 't'}, {plugin: {sha256: 'pkg'}, task_id: 'u'}]) {
      const {status, payload} = await compareRuns({[RA]: runOf(RA), [RB]: runOf(RB, {case_set: {case_set_id: 'x', name: 'x', digest: 'x', ...case_set}})});
      assert.equal(status, 409);
      assert.equal(payload.code, 'not_same_verifier');
    }
  });

  it('answers 400 for an id that is not a UUID and 404 for a run the member cannot see', async () => {
    assert.equal((await compareRuns({}, {a: RA, b: 'x'})).status, 400);
    const {status, payload} = await compareRuns({[RA]: runOf(RA)});
    assert.deepEqual([status, payload.code], [404, 'unknown_run']);
  });
});
