/**
 * A benchmark case as a Terminal session's input, through the real SQL under the real row-level security (PGlite, every migration applied):
 * publishing keeps each case's prompt, fixtures and arguments with one archive per digest, a run copies what it runs, a claim carries the
 * case, the worker fetches its fixtures, and a verdict's checks are read only by the run's member.
 */
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {as, migratedDatabase, pgQuery} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresBenchmark} = require('../../../../src/server/postgres/benchmark.js');
const {createPostgresBenchmarkWorker} = require('../../../../src/server/postgres/benchmark-worker.js');
const {createBenchmarkService} = require('../../../../src/server/benchmark/service.js');
const {benchmarkPublication, finalizeBody, runBody} = require('../../../../src/server/benchmark/validate.js');
const {DEFAULT_LIMITS, RUN_ENDPOINT, RUN_MODEL} = require('../../../../src/server/benchmark/limits.js');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const PACKAGE = Buffer.from('the package');
const ARCHIVE = gzipSync(Buffer.from('fixture tar'));
const FIXTURES = {sha256: sha256(ARCHIVE), files: {'inputs/a.csv': 'b'.repeat(64)}, archive: ARCHIVE.toString('base64')};
const CAPABILITIES = {...DEFAULT_LIMITS, models: [RUN_MODEL], installed_agents: ['aider']};
const CONFIG = {leaseSeconds: 60, uncertainDeadlineSeconds: 3600, memberBudgetUsd: 25, workspaceBudgetUsd: 100};
const ENTRY = {name: 'P', permissions: {}, tools: [], tasks: [{id: 't', runner: 'agent', description: 'Sum', tools: []}]};

const publication = (extra = {}, mutate) => {
  const body = {
    name: 'sums', plugin_id: 'p', plugin_name: 'P', version: '1', package_sha256: sha256(PACKAGE), task_id: 't',
    task: {kind: 'agent', description: 'Sum', input_schema: {type: 'object'}, output_schema: {type: 'object'}, tools: [], egress_hosts: []},
    cases: [
      {case_id: 'p-01', kind: 'answer', prompt: 'Add x: 1 using inputs/a.csv', arguments: {x: 1}, fixtures: structuredClone(FIXTURES), expected_error: null},
      {case_id: 'p-02', kind: 'answer', prompt: 'Add x: 2 using inputs/a.csv', arguments: {x: 2.0}, fixtures: structuredClone(FIXTURES), expected_error: null},
      {case_id: 'p-03', kind: 'refuse', prompt: 'Add x: none', arguments: {x: null}, fixtures: null, expected_error: 'x is required'},
    ],
    private: {'p-01': {sum: 1, before: {a: 1}}, 'p-02': null, 'p-03': 'x is required'},
    ...extra,
  };
  mutate?.(body);
  return benchmarkPublication(body);
};

let db;
let repository;
let worker;
let service;
const count = async table => Number((await db.query(`select count(*) as n from ${table}`)).rows[0].n);

describe('benchmark cases with prompts and fixtures', () => {
  before(async () => {
    const migrated = await migratedDatabase();
    db = migrated.db;
    const pool = {
      async connect() {
        const client = await migrated.pool.connect();
        const query = pgQuery(db);
        // PGlite answers a select's `affectedRows` as 0, where pg answers its row count.
        const counted = result => ({...result, rowCount: result.rows.length || result.rowCount});
        return {...client, query: (sql, values) => (typeof sql === 'string' ? query(sql, values) : query(sql.text, sql.values)).then(result => (Array.isArray(result) ? result : counted(result)))};
      },
    };
    repository = createPostgresBenchmark({pool});
    worker = createPostgresBenchmarkWorker({pool, config: CONFIG});
    service = createBenchmarkService({repository});
    // Each its own transaction: the plugin's latest-version key is deferred, and a table with pending trigger events cannot be altered.
    await db.exec('alter table market_plugin no force row level security; alter table market_plugin_version no force row level security');
    await db.exec(`
      insert into market_plugin (id, owner_id, version) values ('p', 'alice', '1');
      insert into market_plugin_version (plugin_id, version, entry, package, sha256, size) values ('p', '1', '${JSON.stringify(ENTRY)}', '\\x${PACKAGE.toString('hex')}', '${sha256(PACKAGE)}', ${PACKAGE.length});
    `);
    await db.exec('alter table market_plugin force row level security; alter table market_plugin_version force row level security');
    // The worker advertises what it can do before anything is published or run against its endpoint.
    await worker.claim('alice', 'w1', RUN_ENDPOINT, CAPABILITIES, false);
  });

  after(async () => db?.close());

  it('keeps each case\'s prompt, digests, fixtures\' files and arguments, and one archive per digest', async () => {
    const {created, benchmark} = await service.publish('alice', publication());
    assert.equal(created, true);
    assert.deepEqual([benchmark.case_count, benchmark.answer_count, benchmark.refuse_count], [3, 2, 1]);
    assert.equal(await count('benchmark_fixtures'), 1, 'two cases hold one archive');
    const stored = (await db.query('select case_id, prompt, prompt_sha256, fixtures_sha256, fixtures_files, expected_error from benchmark_case_set_case order by position')).rows;
    assert.deepEqual(stored.map(row => [row.case_id, row.prompt, row.prompt_sha256 === sha256(row.prompt), row.fixtures_sha256, row.expected_error]), [
      ['p-01', 'Add x: 1 using inputs/a.csv', true, FIXTURES.sha256, null],
      ['p-02', 'Add x: 2 using inputs/a.csv', true, FIXTURES.sha256, null],
      ['p-03', 'Add x: none', true, null, 'x is required'],
    ]);
    assert.deepEqual(stored[0].fixtures_files, FIXTURES.files);
    assert.equal(stored[2].fixtures_files, null);
    const archive = (await db.query('select archive, publisher_id from benchmark_fixtures')).rows[0];
    assert.deepEqual([Buffer.from(archive.archive).equals(ARCHIVE), archive.publisher_id], [true, 'alice']);
  });

  it('answers an identical republish created: false and the same name with other content 409 benchmark_name_taken, storing nothing', async () => {
    const before = [await count('benchmark'), await count('benchmark_case_set'), await count('benchmark_fixtures')];
    assert.equal((await service.publish('alice', publication())).created, false);
    await assert.rejects(service.publish('alice', publication({}, body => { body.cases[0].prompt = 'Add x: 1, with another prompt'; })), {status: 409, code: 'benchmark_name_taken'});
    assert.deepEqual([await count('benchmark'), await count('benchmark_case_set'), await count('benchmark_fixtures')], before);
  });

  it('shows every member the case read: prompt, kind, fixtures\' digest and files (never the archive), arguments and expected error', async () => {
    const [{benchmark_id: id}] = (await db.query('select benchmark_id from benchmark')).rows;
    const read = await repository.benchmark(as('bob'), id);
    assert.deepEqual(read.cases.map(c => c.case_id), ['p-01', 'p-02', 'p-03']);
    assert.deepEqual(read.cases[0], {
      case_id: 'p-01', position: 0, kind: 'answer', prompt: 'Add x: 1 using inputs/a.csv', prompt_sha256: sha256('Add x: 1 using inputs/a.csv'),
      fixtures: {sha256: FIXTURES.sha256, files: FIXTURES.files}, arguments: {x: 1}, expected_error: null, content_digest: read.cases[0].content_digest,
    });
    assert.equal(read.cases[2].fixtures, null);
    assert.equal(JSON.stringify(read).includes(FIXTURES.archive), false);
    assert.ok(!('coding_template' in read) && !('task_instructions' in read) && !('context' in read));
  });

  it('keeps no template, instructions or context of the old shape in its tables', async () => {
    const columns = (await db.query("select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name like 'benchmark%'")).rows
      .map(row => `${row.table_name}.${row.column_name}`);
    for (const gone of ['benchmark.coding_template', 'benchmark.task_instructions', 'benchmark_case_set.context', 'benchmark_run.policy', 'benchmark_run.source_sha256',
      'benchmark_run.prompt_text', 'benchmark_run_case.prompt_system', 'benchmark_run_case.prompt_user']) assert.ok(!columns.includes(gone), gone);
    const tables = (await db.query("select table_name from information_schema.tables where table_schema = 'public' and table_name like 'benchmark%'")).rows.map(row => row.table_name);
    for (const gone of ['benchmark_source', 'benchmark_preview', 'benchmark_harness_version']) assert.ok(!tables.includes(gone), gone);
  });

  let runId;
  it('runs a benchmark by harness name: the run copies every case as published', async () => {
    const [{benchmark_id: id}] = (await db.query('select benchmark_id from benchmark')).rows;
    const body = runBody({benchmark_id: id, harness: 'claude', idempotency_key: 'k1'});
    const {run_id: submitted, replayed} = await service.submit(as('alice'), body);
    runId = submitted;
    assert.equal(replayed, false);
    const run = await repository.run(as('alice'), runId);
    assert.deepEqual(run.harness, {name: 'claude'});
    assert.deepEqual(run.cases.map(c => [c.case_id, c.position, c.prompt, c.fixtures?.sha256 ?? null]), [
      ['p-01', 0, 'Add x: 1 using inputs/a.csv', FIXTURES.sha256], ['p-02', 1, 'Add x: 2 using inputs/a.csv', FIXTURES.sha256], ['p-03', 2, 'Add x: none', null],
    ]);
    assert.equal(run.cases[0].prompt_sha256, sha256('Add x: 1 using inputs/a.csv'));
    // The same key and request again is the same run, another request under it is refused.
    assert.deepEqual(await service.submit(as('alice'), body), {run_id: runId, replayed: true});
    await assert.rejects(service.submit(as('alice'), runBody({benchmark_id: id, harness: 'codex', idempotency_key: 'k1'})), {status: 409, code: 'idempotency_conflict'});
    assert.equal((await service.submit(as('alice'), runBody({benchmark_id: id, harness: 'rush aider', idempotency_key: 'k3'}))).replayed, false);
    assert.equal((await db.query("select harness_name from benchmark_run where idempotency_key = 'k3'")).rows[0].harness_name, 'rush aider');
  });

  let job;
  it('hands the worker the case, the reference and the task, and no policy, rendered prompt or source', async () => {
    job = await worker.claim('alice', 'w1', RUN_ENDPOINT, CAPABILITIES, false);
    assert.deepEqual(Object.keys(job).sort(), [
      'attempt_id', 'attempt_no', 'case', 'fence', 'free_form', 'kind', 'lease_expires_at', 'lease_seconds', 'plugin', 'private_reference', 'resume', 'run', 'start', 'task',
    ]);
    assert.deepEqual(job.case, {
      case_id: 'p-01', kind: 'answer', prompt: 'Add x: 1 using inputs/a.csv', prompt_sha256: sha256('Add x: 1 using inputs/a.csv'), arguments: {x: 1},
      fixtures: {sha256: FIXTURES.sha256, files: FIXTURES.files}, expected_error: null,
    });
    assert.deepEqual(job.private_reference, {sum: 1, before: {a: 1}});
    assert.deepEqual(job.task, {
      id: 't', kind: 'agent', description: 'Sum', input_schema: {type: 'object'}, output_schema: {type: 'object'}, plugin_name: 'P', tools: [], egress_hosts: [],
    });
    assert.deepEqual(job.run.harness, 'claude');
    assert.deepEqual(Object.keys(job.run).sort(), ['endpoint_profile', 'harness', 'interactive', 'limits', 'model', 'prompt_bound', 'providers', 'run_id']);
    assert.deepEqual(job.run.providers, ['deepinfra', 'nebius']);  // the benchmark's pinned providers, in order
    assert.equal(job.free_form, false);
  });

  it('serves the fixtures archive of the leased attempt\'s case, and 404 no_fixtures for a case with none', async () => {
    const fetched = await worker.artifact('alice', job.attempt_id, job.fence, 'fixtures');
    assert.deepEqual([fetched.data.equals(ARCHIVE), fetched.sha256], [true, FIXTURES.sha256]);
    await worker.claim('alice', 'w1', RUN_ENDPOINT, CAPABILITIES, false);  // p-02, which holds the same archive
    const second = await worker.claim('alice', 'w1', RUN_ENDPOINT, CAPABILITIES, false);
    assert.equal(second.case.case_id, 'p-03');
    assert.equal(second.case.fixtures, null);
    await assert.rejects(worker.artifact('alice', second.attempt_id, second.fence, 'fixtures'), {status: 404, code: 'no_fixtures'});
    await assert.rejects(worker.artifact('bob', job.attempt_id, job.fence, 'fixtures'), {status: 404, code: 'unknown_attempt'});
    await assert.rejects(worker.artifact('alice', job.attempt_id, job.fence + 1, 'fixtures'), {status: 409, code: 'lease_lost'});
  });

  it('stores the verdict\'s checks with the attempt and shows them only to the run\'s member', async () => {
    const checks = [{name: 'outcome_exists', status: 'passed'}, {name: 'values_match', status: 'failed'}, {name: 'side_effects', status: 'skipped'}];
    const {final} = finalizeBody({
      fence: job.fence, execution: {status: 'answered'}, verdict: 'fail', explanation: 'invalid_answer', checks, coverage: {}, metrics: {tool_calls: 4, tool_calls_complete: false}, final_cursor_expected: 0,
    });
    assert.equal((await worker.finalize('alice', job.attempt_id, job.fence, final)).sealed, true);
    assert.deepEqual((await repository.attempt(as('alice'), job.attempt_id)).checks, checks);
    assert.equal(await repository.attempt(as('bob'), job.attempt_id), null, 'another member of the workspace sees no attempt of alice\'s run');
    assert.equal(await repository.run(as('bob'), runId), null);
    const detail = await repository.run(as('alice'), runId);
    assert.deepEqual(detail.cases[0].attempts[0].checks, checks);
    assert.equal(detail.cases[0].attempts[0].metrics.tool_calls, 4);
    assert.deepEqual(detail.metrics.tool_calls, {total: 4, missing_attempts: 3});
    assert.deepEqual((await repository.listRuns(as('alice'), {limit: 100, before: null})).find(run => run.run_id === runId).metrics.tool_calls, detail.metrics.tool_calls);
    // A verdict without checks keeps none.
    const second = (await db.query("select attempt_id, fence from benchmark_attempt where state = 'leased'")).rows[0];
    const bare = finalizeBody({fence: second.fence, execution: {status: 'refused'}, verdict: 'pass', coverage: {}, metrics: {}, final_cursor_expected: 0}).final;
    await worker.finalize('alice', second.attempt_id, second.fence, bare);
    assert.equal((await repository.attempt(as('alice'), second.attempt_id)).checks, null);
  });

  it('has no read of another member\'s runs: a benchmark\'s runs are listed only to their own member, with verdicts and metrics only', async () => {
    assert.equal(repository.benchmarkResults, undefined);
    assert.deepEqual(await repository.listRuns(as('bob'), {limit: 10, before: null}), []);
    const own = await repository.listRuns(as('alice'), {limit: 10, before: null});
    assert.ok(own.length >= 1 && own.every(run => run.benchmark.name));
    assert.equal(JSON.stringify(own).includes('outcome_exists'), false);
  });

  it('pages through runs sharing a timestamp without losing any, including sub-millisecond ties', async () => {
    await db.query("update benchmark_run set created_at = '2026-01-01T00:00:00.123456Z' where user_id = 'alice'");
    const all = await repository.listRuns(as('alice'), {limit: 100, before: null});
    assert.ok(all.length >= 2);
    const seen = [];
    let before = null;
    let beforeId = null;
    while (true) {
      const page = await repository.listRuns(as('alice'), {limit: 1, before, beforeId});
      if (!page.length) break;
      seen.push(page[0].run_id);
      before = new Date(page[0].created_at).toISOString();
      beforeId = page[0].run_id;
    }
    assert.deepEqual(seen, all.map(run => run.run_id));
    assert.deepEqual(await repository.listRuns(as('alice'), {limit: 100, before: '2026-01-01T00:00:00.123Z'}), []);
  });

  it('seals a case attempt with the session fields a free-form session sends, and reads them back like a Terminal session\'s', async () => {
    await worker.claim('alice', 'w2', RUN_ENDPOINT, CAPABILITIES, false);
    const claimed = (await db.query("select attempt_id, fence from benchmark_attempt where state = 'leased'")).rows.at(-1);
    const chat = {agent: 'claude', id: 'c0ffee', title: 'say ok', started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:05Z', started_ns: '1', ended_ns: '5'};
    const {final} = finalizeBody({
      fence: claimed.fence, execution: {status: 'answered'}, verdict: 'pass', checks: [{name: 'outcome_exists', status: 'passed'}], coverage: {}, metrics: {},
      final_cursor_expected: 0, chats: [chat], resumable: true, workspace: {error: 'too large'},
    });
    assert.equal((await worker.finalize('alice', claimed.attempt_id, claimed.fence, final)).sealed, true);
    const [row] = await repository.terminalRows(as('alice'), {attemptId: claimed.attempt_id});
    assert.deepEqual([row.attempt_id, row.chats, row.resumable], [claimed.attempt_id, [chat], true]);
    assert.deepEqual((await repository.attempt(as('alice'), claimed.attempt_id)).workspace, {error: 'too large'});
    assert.deepEqual(await repository.terminalRows(as('bob'), {attemptId: claimed.attempt_id}), []);
    // The Dashboard's list of sessions still holds only the Terminal's own sessions, not a benchmark case's.
    assert.equal((await repository.terminalRows(as('alice'), {pluginId: 'p'})).some(each => each.attempt_id === claimed.attempt_id), false);
  });
});
