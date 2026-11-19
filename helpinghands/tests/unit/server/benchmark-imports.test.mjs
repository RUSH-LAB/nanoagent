import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {createPostgresBenchmark} = require('../../../src/server/postgres/benchmark.js');
const route = loadRoute('benchmark');
const CONTEXT = {userId: 'me', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const SHA = 'a'.repeat(64);

const PROFILE = {model_ms: 800, tools_ms: 150, overhead_ms: 50, cache_read_tokens: 4, model_calls: 3, tool_calls: 2};
const ENTRY = {name: 'P', tasks: [{id: 'sum', runner: 'agent', description: 'd', instructions: 'i', tools: [], reference: null}]};
const FRAME = {
  name: 'step3-batch-runs', plugin_id: 'p', plugin_name: 'P', version: '1.0.0', task_id: 'sum',
  task: {kind: 'agent', description: 'd', instructions: 'i', input_schema: {}, output_schema: {}, tools: [], egress_hosts: []},
  context: 'Add', model: 'deepseek/deepseek-v4-flash-0731', endpoint_profile: 'openrouter',
};
const RECORD = {
  frame: FRAME, source_sha256: 'b'.repeat(64), case_id: 'p-01', kind: 'answer', started_at: '2026-11-12T20:16:11+00:00', execution: 'answered',
  correct: true, verdict: 'right', elapsed_ms: 95491, input_tokens: 144474, output_tokens: 4685, cost_usd: 0.009929466,
  profile: {model_ms: 94000, tools_ms: 1000, overhead_ms: 491, cache_read_tokens: 90000, model_calls: 7, tool_calls: 6},
  arguments: {a: 1}, expected_error: null, reference: {sum: 1}, answer: {sum: 1}, trajectory: [{step_id: 1, source: 'user', message: 'Add'}],
};

function ctxFor(published = {entry: ENTRY, sha256: SHA}) {
  const calls = [];
  const ctx = makeCtx({
    benchmark: {
      service: {},
      repository: {
        marketVersion: async (context, pluginId, version) => { calls.push(['market', pluginId, version]); return published; },
        importRun: async (context, frame, record) => { calls.push(['import', frame, record]); return {run_id: 'r1', created: calls.length < 3, filled: calls.length < 3}; },
      },
    },
  });
  return {ctx, calls};
}

describe('POST /api/benchmark/imports', () => {
  const post = (ctx, body) => invoke(route, {method: 'POST', path: '/api/benchmark/imports', body, requestContext: CONTEXT, ctx});

  it('keeps the run on the package of its plugin version as published, once', async () => {
    const {ctx, calls} = ctxFor();
    const first = await post(ctx, RECORD);
    assert.deepEqual([first.status, first.payload], [201, {run_id: 'r1', created: true, filled: true}]);
    const [, frame, record] = calls[1];
    assert.deepEqual([calls[0], frame.package_sha256, frame.task_instructions, record.started_at], [['market', 'p', '1.0.0'], SHA, 'i', '2026-11-12T20:16:11.000Z']);
    assert.deepEqual([record.case.arguments, record.case.reference, record.case.content_digest.length, record.trajectory.length], [{a: 1}, {sum: 1}, 64, 1]);
    assert.deepEqual(record.profile, RECORD.profile);
    assert.equal((await post(ctx, RECORD)).status, 200);
  });

  it('refuses a version that is not published, a task that is not the version\'s, and a malformed record', async () => {
    assert.equal((await post(ctxFor(null).ctx, RECORD)).payload.code, 'unknown_plugin_version');
    const changed = await post(ctxFor().ctx, {...RECORD, frame: {...FRAME, task: {...FRAME.task, instructions: 'other'}}});
    assert.deepEqual([changed.status, changed.payload.code], [422, 'task_mismatch']);
    assert.equal((await post(ctxFor().ctx, {...RECORD, execution: 'canceled'})).status, 400);
    assert.equal((await post(ctxFor().ctx, {...RECORD, extra: 1})).status, 400);
    assert.equal((await post(ctxFor().ctx, {...RECORD, profile: {...RECORD.profile, tool_calls: 1.5}})).payload.error, 'profile.tool_calls must be an integer from 0 to 2147483647');
    const {reference: _reference, ...unreferenced} = RECORD;
    assert.equal((await post(ctxFor().ctx, unreferenced)).payload.error, 'reference is required (null for none)');
    assert.equal((await post(ctxFor().ctx, {...RECORD, kind: 'refuse'})).status, 400);
    assert.equal((await post(ctxFor().ctx, {...RECORD, trajectory: [{message: 'a\u0000b'}]})).payload.error, 'A trajectory step may not contain the character \\u0000');
  });
});

describe('importRun kept again', () => {
  /** A pool holding one imported run kept before, with its trace but without a profile, whose verifier said `said`. */
  const keptPool = (said = {correct: true, verdict: 'right'}) => {
    const statements = [];
    const answers = {
      'select harness_name': [{harness_name: 'hermes', harness_version: '1', dialects: []}],
      'select run_id, version': [{run_id: 'r1', version: '1.0.0'}],
      'select a.attempt_id': [{attempt_id: 'a1', profiled: false, prompt_sha256: 'p', said, answered: {answer: {sum: 1}}}],
    };
    return {statements, async connect() {
      return {async query(sql, values) {
        const text = String(sql.text ?? sql).replace(/\s+/g, ' ').trim();
        statements.push({text, values: sql.values ?? values});
        const key = Object.keys(answers).find(prefix => text.startsWith(prefix));
        return key ? {rows: answers[key], rowCount: 1} : {rows: [], rowCount: 0};
      }, release() {}};
    }};
  };
  // A later build of the harness: another source, start time, tokens and cost, and now a profile.
  const again = {...RECORD, source_sha256: 'c'.repeat(64), started_at: '2026-11-18T00:00:00.000Z', input_tokens: 1, cost_usd: 0.5, case: {case_id: 'p-01'}};

  it('fills in a profile added on re-import', async () => {
    const pool = keptPool();
    assert.deepEqual(await createPostgresBenchmark({pool}).importRun(CONTEXT, FRAME, again), {run_id: 'r1', created: false, filled: true});
    const update = pool.statements.find(s => s.text.startsWith('update benchmark_attempt set metrics'));
    assert.deepEqual(JSON.parse(update.values[1]), {elapsed_ms: 95491, input_tokens: 1, output_tokens: 4685, total_tokens: 4686, ...RECORD.profile});
    assert.ok(!pool.statements.some(s => s.text.startsWith('insert into benchmark_run ')));
  });

  it('still refuses a different verdict or answer', async () => {
    await assert.rejects(createPostgresBenchmark({pool: keptPool({correct: false, verdict: 'wrong'})}).importRun(CONTEXT, FRAME, again), {code: 'idempotency_conflict'});
    await assert.rejects(createPostgresBenchmark({pool: keptPool()}).importRun(CONTEXT, FRAME, {...again, answer: {sum: 2}}), {code: 'idempotency_conflict'});
  });
});
