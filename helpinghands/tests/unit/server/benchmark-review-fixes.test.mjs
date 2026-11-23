import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, test} from 'node:test';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {createPostgresBenchmarkWorker} = require('../../../src/server/postgres/benchmark-worker.js');
const {chargeStorage} = require('../../../src/server/postgres/benchmark-context.js');
const {MEMBER_STORAGE_BYTES, DEFAULT_LIMITS} = require('../../../src/server/benchmark/limits.js');
const {checkTaskAgainstEntry} = require('../../../src/server/benchmark/entry-check.js');

const config = {leaseSeconds: 60, uncertainDeadlineSeconds: 3600, memberBudgetUsd: 25, workspaceBudgetUsd: 100};

/** A pool whose clients record every statement, answering `answers[prefix]` rows for a statement starting with that prefix. */
function recordingPool(answers = {}) {
  const statements = [];
  return {
    statements,
    async connect() {
      return {
        async query(sql, values) {
          const text = String(sql.text ?? sql).replace(/\s+/g, ' ').trim();
          statements.push({text, params: sql.values ?? values ?? []});
          const key = Object.keys(answers).find(prefix => text.startsWith(prefix));
          return key ? {rows: answers[key], rowCount: answers[key].length} : {rows: [], rowCount: 0};
        },
        release() {},
      };
    },
  };
}

describe('the member storage quota', () => {
  const client = used => ({query: async sql => ({rows: String(sql).includes('sum(octet_length(archive))') ? [{used}] : [{prior: 'off'}]})});

  test('refuses bytes that would pass the quota with a 413, takes the member\'s lock first and reads as the system only for the total', async () => {
    const statements = [];
    const recording = {query: async (sql, values) => { statements.push([String(sql), values]); return {rows: [{used: String(MEMBER_STORAGE_BYTES - 10), prior: 'off'}]}; }};
    await chargeStorage(recording, 'u', 10);
    assert.match(statements[0][0], /pg_advisory_xact_lock/);
    assert.deepEqual(statements.at(-1), ["select set_config('app.benchmark_system', $1, true)", ['off']]);
    await assert.rejects(chargeStorage(client(String(MEMBER_STORAGE_BYTES - 10)), 'u', 11), {status: 413, code: 'storage_quota_exceeded'});
  });
});

describe('the worker credential and claim', () => {
  test('a suspended member\'s credential does not authenticate', async () => {
    const pool = recordingPool({'update benchmark_worker_credential': [{user_id: 'u'}]});
    await createPostgresBenchmarkWorker({pool, config}).authenticate('rwk_x');
    assert.match(pool.statements.find(s => s.text.startsWith('update benchmark_worker_credential')).text, /not exists \(select 1 from app_user u where u\.id = benchmark_worker_credential\.user_id and u\.banned_at is not null\)/);
  });

  test('a claim sees only runs of workspaces the member is in, locks a run with skip locked, and reads as the member', async () => {
    const pool = recordingPool({'select r.run_id, r.limits': [{run_id: 'r', limits: {...DEFAULT_LIMITS}}]});
    await createPostgresBenchmarkWorker({pool, config}).claim('u', 'w', 'mock', {...DEFAULT_LIMITS, models: ['m']}, false);
    assert.match(pool.statements.find(s => s.text.startsWith('select r.run_id, r.limits')).text, /from workspace_member m where m\.workspace_id = r\.workspace_id and m\.user_id = r\.user_id/);
    assert.match(pool.statements.find(s => s.text.startsWith('select * from benchmark_run where run_id')).text, /for update skip locked$/);
    assert.ok(pool.statements.some(s => s.text.includes("set_config('app.user_id', 'u'") && s.text.includes("set_config('app.benchmark_system', 'on'")));
  });
});

describe('migration 0054', () => {
  test('deletes the old capabilities with force row level security lifted', () => {
    const sql = fs.readFileSync(new URL('../../../src/server/postgres/migrations/0054_benchmark_worker_credential.sql', import.meta.url), 'utf8');
    const lines = sql.split('\n').filter(line => /benchmark_worker_capability/.test(line) && /force row level security|^delete/.test(line));
    assert.deepEqual(lines.map(line => line.replace(/;$/, '')), [
      'alter table benchmark_worker_capability no force row level security', 'delete from benchmark_worker_capability',
      'alter table benchmark_worker_capability force row level security',
    ]);
  });
});

describe('a published task is checked against the package\'s catalog entry', () => {
  const entry = {
    name: 'Plugin', permissions: {network: {hosts: ['b.example', 'a.example', 'a.example']}, filesystem: {write: []}},
    tools: [{name: 'ref', description: 'pins'}, {name: 'work', description: 'does'}],
    tasks: [{id: 'sum', runner: 'agent', description: 'd', instructions: 'i', reference: 'ref', tools: ['ref', 'work']}],
  };
  const publication = () => ({
    plugin_id: 'p', version: '1', plugin_name: 'Plugin', task_id: 'sum',
    task: {kind: 'agent', description: 'd', egress_hosts: ['a.example', 'b.example'], tools: [{name: 'work', description: 'does', writes: false}]},
  });

  test('accepts what NanoAgent derived', () => checkTaskAgainstEntry(entry, publication()));

  test('refuses a tool, a host, a description, a name or a task the package does not have, with 422 task_mismatch', () => {
    for (const [change, differing] of [
      [p => { p.task.tools[0].description = 'x'; }, ['tools']], [p => { p.task.tools.push({name: 'ref', description: 'pins', writes: false}); }, ['tools']],
      [p => { p.task.egress_hosts.push('evil.example'); }, ['egress_hosts']], [p => { p.task.description = 'x'; }, ['description']],
      [p => { p.plugin_name = 'Other'; }, ['plugin_name']], [p => { p.task_id = 'nope'; }, ['task_id']],
    ]) {
      const published = publication();
      change(published);
      assert.throws(() => checkTaskAgainstEntry(entry, published), error => error.status === 422 && error.code === 'task_mismatch' && JSON.stringify(error.extra.differing) === JSON.stringify(differing));
    }
  });
});

describe('GET /api/benchmark/compare/attempts bounds what it loads', () => {
  const route = loadRoute('benchmark');
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const SHA = 'a'.repeat(64);
  const event = (cursor, payloads = []) => ({cursor, event_id: `e${cursor}`, source: 'w', kind: 'k', sequence: cursor, occurred_ns: '1', data: {}, payload_sha256s: payloads});
  const compare = events => invoke(route, {
    path: '/api/benchmark/compare/attempts', query: {a: A, b: B}, requestContext: {userId: 'u', workspaceId: 'w', membershipId: 'm', role: 'owner'},
    ctx: makeCtx({benchmark: {service: {}, repository: {
      attempt: async (_c, id) => ({attempt_id: id, run_id: 'r', case_id: 'c', sealed: true}),
      run: async () => ({case_set: {plugin: {sha256: 'p'}, task_id: 't'}, cases: [{case_id: 'c', content_digest: 'd'}]}),
      events: events.page,
      payload: events.payload ?? (async () => null),
    }}, ai: {benchmarkCompare: async () => ({value: {}})}}),
  });

  test('refuses an attempt whose events\' data total more than the byte cap, 413 evidence_too_large', async () => {
    const {status, payload} = await compare({page: async (_c, _id, after) => ({
      events: [{...event(after + 1), data: {pad: 'x'.repeat(33 * 1024 * 1024)}}], has_more: true, sealed: true, final_cursor: 0, high_water_cursor: 0,
    })});
    assert.deepEqual([status, payload.code], [413, 'evidence_too_large']);
  });

  test('refuses an attempt whose payloads total more than the cap', async () => {
    const {status, payload} = await compare({
      page: async () => ({events: [event(1, [SHA])], has_more: false, sealed: true, final_cursor: 1, high_water_cursor: 1}),
      payload: async () => ({data: Buffer.from('x'), size: 65 * 1024 * 1024, redaction: 'none'}),
    });
    assert.deepEqual([status, payload.code], [413, 'evidence_too_large']);
  });
});
