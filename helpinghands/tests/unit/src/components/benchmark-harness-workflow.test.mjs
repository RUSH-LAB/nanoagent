import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {defaultPolicy, maximumCost, submitBatch} from '../../../../src/components/Benchmark/batch.js';
import {comparisonRows, comparisonTotals, harnessKey, harnessesOf} from '../../../../src/components/Benchmark/harnessComparison.js';
import {allPages, SPAN_LIMIT, spansCut} from '../../../../src/components/Benchmark/pagination.js';
import {screenOf, searchFor} from '../../../../src/components/Benchmark/location.js';

const score = (passed, total = 2) => ({passed, total, scored: total, unscored: 0, verifier_errors: 0, complete: true, value: passed / total});
const run = (id, name, over = {}) => ({run_id: id, user: {id: 'u', name: 'User'}, harness: {name, version: '1'}, policy: 'coding', status: 'complete', score: score(2), created_at: '2026-01-01T00:00:00.000Z', ...over});
const benchmark = id => ({benchmark_id: id, name: 'same-name', plugin: {name: id}});

describe('multi-benchmark workflow', () => {
  it('matches only exact benchmark identities, leaves missing runs out of scores, and allows another run to be selected', () => {
    const a = run('a', 'A'), old = run('old', 'B'), newer = run('new', 'B', {score: score(1), created_at: '2026-01-02T00:00:00.000Z'});
    const missing = run('missing', 'A');
    const pending = run('pending', 'B', {status: 'running', score: {...score(0), complete: false}});
    const results = [{benchmark: benchmark('one'), runs: [a, old, newer]}, {benchmark: benchmark('two'), runs: [missing]}, {benchmark: benchmark('three'), runs: [a, pending]}];
    const rows = comparisonRows(results, harnessKey(a), harnessKey(old));
    assert.equal(harnessesOf(results).length, 2);
    assert.equal(rows.find(row => row.benchmark.benchmark_id === 'one').b.run.run_id, 'new');
    assert.equal(rows.find(row => row.benchmark.benchmark_id === 'two').b.run, null);
    assert.deepEqual(comparisonTotals(rows), {shared: 2, paired: 1, a: {benchmarks: 1, passed: 2, cases: 2}, b: {benchmarks: 0, passed: 1, cases: 2}});
    const chosen = comparisonRows(results, harnessKey(a), harnessKey(old), {'one:1': 'old'});
    assert.equal(chosen.find(row => row.benchmark.benchmark_id === 'one').b.run.run_id, 'old');
  });

  it('defaults NanoAgent to task tools and other or uploaded harnesses to coding', () => {
    assert.equal(defaultPolicy('nanoagent'), 'task_tools');
    assert.equal(defaultPolicy('pi'), 'coding');
    assert.equal(defaultPolicy(null), 'coding');
  });

  it('calculates the cost limit per case', () => {
    assert.equal(maximumCost([{limits: {effective: {max_cost_usd: 1.5}}, cases: [{}, {}, {}]}, {limits: {effective: {max_cost_usd: 2}}, cases: [{}]}]), 6.5);
  });

  it('persists requests before submission and retries only unconfirmed requests with their original keys', async () => {
    const initial = {policy: 'coding', source: {source_sha256: 'sha'}, entries: [
      {benchmark: benchmark('one'), previewId: 'p1', key: 'k1', runId: null},
      {benchmark: benchmark('two'), previewId: 'p2', key: 'k2', runId: null},
    ]};
    const saved = [], sent = [];
    const first = await submitBatch(initial, {persist: batch => saved.push(structuredClone(batch)), send: async body => {
      assert.ok(saved.length); sent.push(body);
      if (body.idempotency_key === 'k2') throw new Error('connection lost');
      return {run: {run_id: 'r1'}};
    }});
    assert.equal(first.entries[0].runId, 'r1');
    assert.equal(first.entries[1].error, 'connection lost');
    const second = await submitBatch(first, {persist: () => {}, send: async body => {sent.push(body); return {run: {run_id: 'r2'}};}});
    assert.deepEqual(sent.map(body => body.idempotency_key), ['k1', 'k2', 'k2']);
    assert.deepEqual(second.entries.map(entry => entry.runId), ['r1', 'r2']);
    await assert.rejects(submitBatch(initial, {persist: () => {throw new Error('storage full');}, send: () => {throw new Error('must not send');}}), /storage full/);
  });

  it('reads all pages without losing runs at the timestamp boundary', async () => {
    const at = '2026-01-02T00:00:00.000Z', earlier = '2026-01-01T00:00:00.000Z';
    const first = Array.from({length: 200}, (_, i) => ({run_id: String(i), created_at: at}));
    const page = [...first.slice(198), {run_id: 'older', created_at: earlier}];
    const calls = [];
    const runs = await allPages(async before => {calls.push(before); return before ? page : first;});
    assert.equal(runs.length, 201);
    assert.deepEqual(calls, [undefined, '2026-01-02T00:00:00.001Z']);
    await assert.rejects(allPages(async () => first), /share a timestamp/);
  });

  it('pages benchmarks by published_at and benchmark_id, and flags a trace that reached the span limit', async () => {
    const at = '2026-01-02T00:00:00.000Z';
    const first = Array.from({length: 200}, (_, i) => ({benchmark_id: String(i), published_at: at}));
    const calls = [];
    const all = await allPages(async before => {calls.push(before); return before ? [{benchmark_id: 'older', published_at: '2026-01-01T00:00:00.000Z'}] : first;}, {key: 'benchmark_id', time: 'published_at'});
    assert.equal(all.length, 201);
    assert.deepEqual(calls, [undefined, '2026-01-02T00:00:00.001Z']);
    assert.equal(spansCut({spans: new Array(SPAN_LIMIT - 1)}), false);
    assert.equal(spansCut({spans: new Array(SPAN_LIMIT)}), true);
    assert.equal(spansCut(undefined), false);
  });

  it('preserves missing benchmark selections and their harness across navigation', () => {
    const id = '1f0c0000-aaaa-4bbb-8ccc-dddddddddddd';
    const harness = {harness: {name: 'A', version: '1'}, policy: 'coding', user: {id: 'u'}};
    assert.deepEqual(screenOf(searchFor({view: 'new', benchmarks: [id], harness})).initialSelection, {benchmarks: [id], harness});
    const pair = `${id},2f0c0000-aaaa-4bbb-8ccc-dddddddddddd`;
    assert.equal(screenOf(searchFor({runs: pair, fromHarness: true})).fromHarness, true);
  });
});
