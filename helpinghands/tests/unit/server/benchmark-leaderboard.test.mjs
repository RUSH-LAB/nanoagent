import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {REFERENCE_HARNESSES} = require('../../../src/server/benchmark/harness.js');
const {REFERENCE_LABELS, leaderboard} = require('../../../src/server/benchmark/leaderboard.js');
const route = loadRoute('benchmark');
const CONTEXT = {userId: 'me', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const SHA = 'a'.repeat(64);

const row = (harness, verdict, {user = 'me', elapsed = 1000, cost = 0.01, at = '2026-11-12T00:00:00Z', attempt = 'a1'} = {}) => ({
  run_id: `r-${attempt}`, attempt_id: attempt, user_id: user, user_name: `${user} name`, user_github: user === 'me' ? 'me-gh' : null,
  harness_name: harness, verdict, elapsed_ms: elapsed, cost_usd: cost, created_at: at,
});

describe('a plugin task\'s leaderboard', () => {
  it('names every reference harness', () => {
    assert.deepEqual(Object.keys(REFERENCE_LABELS).sort(), [...REFERENCE_HARNESSES].sort());
  });

  it('ranks by correct rate, then average time, then average cost, naming a saved harness by its owner', () => {
    const board = leaderboard([
      row('codex', 'pass', {elapsed: 3000}), row('codex', 'fail', {elapsed: 1000}),
      row('pi', 'pass', {elapsed: 2000, cost: 0.02}), row('pi', 'fail', {elapsed: 2000, cost: 0.02}),
      row('dsh', 'pass', {elapsed: 2000, cost: 0.01}), row('dsh', 'fail', {elapsed: 2000, cost: null}),
      row('nanoagent', 'pass'),
      row('my-agent', 'fail', {user: 'other'}),
    ], 'me');
    assert.deepEqual(board.map(({rank, harness, passed, scored}) => [rank, harness, passed, scored]), [
      [1, 'RUSH', 1, 1], [2, 'Codex', 1, 2], [3, 'DSH', 1, 2], [4, 'Pi', 1, 2], [5, 'my-agent (@other name)', 0, 1],
    ]);
    assert.deepEqual([board[2].avg_elapsed_ms, board[2].avg_cost_usd], [2000, 0.01]);
  });

  it('lists each harness\'s runs newest first, carrying the attempt of the viewer\'s own only', () => {
    const [entry] = leaderboard([
      row('pi', 'pass', {at: '2026-11-12T00:00:00Z', attempt: 'old'}), row('pi', 'fail', {user: 'other', at: '2026-11-13T00:00:00Z', attempt: 'theirs'}),
    ], 'me');
    assert.deepEqual(entry.runs.map(run => [run.verdict, run.mine, run.attempt_id]), [['fail', false, null], ['pass', true, 'old']]);
  });
});

const ENTRY = {name: 'P', tasks: [{id: 'sum', runner: 'agent', description: 'd', instructions: 'i', tools: [], reference: null}]};
const FRAME = {
  name: 'step3-batch-runs', plugin_id: 'p', plugin_name: 'P', version: '1.0.0', task_id: 'sum',
  task: {kind: 'agent', description: 'd', instructions: 'i', input_schema: {}, output_schema: {}, tools: [], egress_hosts: []},
  context: 'Add', model: 'deepseek/deepseek-v4-flash-0731', endpoint_profile: 'openrouter',
};
const RECORD = {
  frame: FRAME, source_sha256: 'b'.repeat(64), case_id: 'p-01', kind: 'answer', started_at: '2026-11-12T20:16:11+00:00', execution: 'answered',
  correct: true, verdict: 'right', elapsed_ms: 95491, input_tokens: 144474, output_tokens: 4685, cost_usd: 0.009929466,
};

function ctxFor(published = {entry: ENTRY, sha256: SHA}) {
  const calls = [];
  const ctx = makeCtx({
    benchmark: {
      service: {},
      repository: {
        leaderboard: async (context, pluginId, taskId) => { calls.push(['board', pluginId, taskId]); return [row('pi', 'pass')]; },
        marketVersion: async (context, pluginId, version) => { calls.push(['market', pluginId, version]); return published; },
        importRun: async (context, frame, record) => { calls.push(['import', frame, record]); return {run_id: 'r1', created: calls.length < 3}; },
      },
    },
  });
  return {ctx, calls};
}

describe('GET /api/benchmark/leaderboard', () => {
  it('ranks the harnesses of the plugin task from every member\'s scored runs, as the caller sees them', async () => {
    const {ctx, calls} = ctxFor();
    const {status, payload} = await invoke(route, {method: 'GET', path: '/api/benchmark/leaderboard', query: {plugin_id: 'p', task_id: 'sum'}, requestContext: CONTEXT, ctx});
    assert.equal(status, 200);
    assert.deepEqual(calls, [['board', 'p', 'sum']]);
    assert.deepEqual([payload.harnesses[0].harness, payload.harnesses[0].runs[0].attempt_id], ['Pi', 'a1']);
    assert.equal((await invoke(route, {method: 'GET', path: '/api/benchmark/leaderboard', query: {plugin_id: 'p'}, requestContext: CONTEXT, ctx})).status, 400);
  });
});

describe('POST /api/benchmark/imports', () => {
  const post = (ctx, body) => invoke(route, {method: 'POST', path: '/api/benchmark/imports', body, requestContext: CONTEXT, ctx});

  it('keeps the run on the package of its plugin version as published, once', async () => {
    const {ctx, calls} = ctxFor();
    const first = await post(ctx, RECORD);
    assert.deepEqual([first.status, first.payload], [201, {run_id: 'r1', created: true}]);
    const [, frame, record] = calls[1];
    assert.deepEqual([calls[0], frame.package_sha256, frame.task_instructions, record.started_at], [['market', 'p', '1.0.0'], SHA, 'i', '2026-11-12T20:16:11.000Z']);
    assert.equal((await post(ctx, RECORD)).status, 200);
  });

  it('refuses a version that is not published, a task that is not the version\'s, and a malformed record', async () => {
    assert.equal((await post(ctxFor(null).ctx, RECORD)).payload.code, 'unknown_plugin_version');
    const changed = await post(ctxFor().ctx, {...RECORD, frame: {...FRAME, task: {...FRAME.task, instructions: 'other'}}});
    assert.deepEqual([changed.status, changed.payload.code], [422, 'task_mismatch']);
    assert.equal((await post(ctxFor().ctx, {...RECORD, execution: 'canceled'})).status, 400);
    assert.equal((await post(ctxFor().ctx, {...RECORD, extra: 1})).status, 400);
  });
});
