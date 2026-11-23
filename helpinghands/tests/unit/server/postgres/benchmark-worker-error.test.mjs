/**
 * A worker's failure on a benchmark case is not a failed case, through the real SQL (PGlite, every migration applied): a case attempt that
 * ends `worker_error`, or whose lease runs out, is queued again until it has had three attempts; after the third the run is not graded.
 * A free-form session is not retried.
 */
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
const CAPABILITIES = {...DEFAULT_LIMITS, models: [RUN_MODEL]};
const CONFIG = {leaseSeconds: 60, uncertainDeadlineSeconds: 3600, memberBudgetUsd: 25, workspaceBudgetUsd: 100};
const ENTRY = {name: 'P', permissions: {}, tools: [], tasks: [{id: 't', runner: 'agent', description: 'Sum', tools: []}]};
const FREE_RUN = '00000000-0000-4000-8000-0000000000f1';
const FREE_ATTEMPT = '00000000-0000-4000-8000-0000000000f2';

let db;
let repository;
let worker;
let runId;
const claim = () => worker.claim('alice', 'w1', RUN_ENDPOINT, CAPABILITIES, false);
const attempts = async caseId => (await db.query(
  'select attempt_no, rerun_of, state, execution_status, execution_reason, attempt_id from benchmark_attempt where run_id = $1 and case_id = $2 order by attempt_no', [runId, caseId],
)).rows;
const expire = attemptId => db.query("update benchmark_attempt set lease_expires_at = now() - interval '1 second' where attempt_id = $1", [attemptId]);
const workerError = (job, reason = 'SandboxError: start_failed') => worker.finalize('alice', job.attempt_id, job.fence, finalizeBody({
  fence: job.fence, execution: {status: 'worker_error', reason}, coverage: {}, metrics: {}, final_cursor_expected: 0,
}).final);

describe('a worker error on a benchmark case', () => {
  before(async () => {
    const migrated = await migratedDatabase();
    db = migrated.db;
    const pool = {
      async connect() {
        const client = await migrated.pool.connect();
        const query = pgQuery(db);
        const counted = result => ({...result, rowCount: result.rows.length || result.rowCount});
        return {...client, query: (sql, values) => (typeof sql === 'string' ? query(sql, values) : query(sql.text, sql.values)).then(result => (Array.isArray(result) ? result : counted(result)))};
      },
    };
    repository = createPostgresBenchmark({pool});
    worker = createPostgresBenchmarkWorker({pool, config: CONFIG});
    const service = createBenchmarkService({repository});
    await db.exec('alter table market_plugin no force row level security; alter table market_plugin_version no force row level security');
    await db.exec(`
      insert into market_plugin (id, owner_id, version) values ('p', 'alice', '1');
      insert into market_plugin_version (plugin_id, version, entry, package, sha256, size) values ('p', '1', '${JSON.stringify(ENTRY)}', '\\x${PACKAGE.toString('hex')}', '${sha256(PACKAGE)}', ${PACKAGE.length});
    `);
    await db.exec('alter table market_plugin force row level security; alter table market_plugin_version force row level security');
    await worker.claim('alice', 'w1', RUN_ENDPOINT, CAPABILITIES, false);
    const {benchmark} = await service.publish('alice', benchmarkPublication({
      name: 'sums', plugin_id: 'p', plugin_name: 'P', version: '1', package_sha256: sha256(PACKAGE), task_id: 't',
      task: {kind: 'agent', description: 'Sum', input_schema: {type: 'object'}, output_schema: {type: 'object'}, tools: [], egress_hosts: []},
      cases: [
        {case_id: 'p-01', kind: 'answer', prompt: 'Add x: 1', arguments: {x: 1}, fixtures: null, expected_error: null},
        {case_id: 'p-02', kind: 'answer', prompt: 'Add x: 2', arguments: {x: 2}, fixtures: null, expected_error: null},
      ],
      private: {'p-01': {sum: 1}, 'p-02': {sum: 2}},
    }));
    runId = (await service.submit(as('alice'), runBody({benchmark_id: benchmark.benchmark_id, harness: 'claude', idempotency_key: 'k1'}))).run_id;
  });

  after(async () => db?.close());

  it('has no stored selection: a run\'s cases are its case rows', async () => {
    const columns = (await db.query("select column_name from information_schema.columns where table_name = 'benchmark_run'")).rows.map(row => row.column_name);
    assert.ok(!columns.includes('selection'));
  });

  it('refuses a verdict, or a verifier error, on a worker error', () => {
    for (const extra of [{verdict: 'fail'}, {verifier_error: 'boom'}]) {
      assert.throws(() => finalizeBody({fence: 1, execution: {status: 'worker_error', reason: 'x'}, ...extra, coverage: {}, metrics: {}, final_cursor_expected: 0}), {code: 'verdict_not_allowed'});
    }
  });

  let first;
  it('queues the case again, a rerun of the attempt, in the transaction that finalizes a worker error', async () => {
    first = await claim();
    assert.equal(first.case.case_id, 'p-01');
    // The run's other case answers, so only p-01 has attempts left to claim.
    const other = await claim();
    assert.equal(other.case.case_id, 'p-02');
    await worker.finalize('alice', other.attempt_id, other.fence, finalizeBody({
      fence: other.fence, execution: {status: 'answered'}, verdict: 'pass', coverage: {}, metrics: {}, final_cursor_expected: 0,
    }).final);
    assert.equal((await workerError(first)).sealed, true);
    const [one, two] = await attempts('p-01');
    assert.deepEqual([one.execution_status, one.execution_reason, two.attempt_no, two.rerun_of, two.state], ['worker_error', 'SandboxError: start_failed', 2, one.attempt_id, 'queued']);
    // The run is still going: the retry is the case's newest attempt, so nothing reads as a worker error yet.
    const run = await repository.run(as('alice'), runId);
    assert.deepEqual([run.status === 'complete', run.score.unavailable_reason, run.score.complete], [false, null, false]);
  });

  it('retries a worker whose lease ran out as it does a worker error, and does not call it interrupted', async () => {
    const second = await claim();
    assert.equal(second.attempt_no, 2);
    await expire(second.attempt_id);
    await repository.run(as('alice'), runId); // a member's read sweeps
    const [, two, three] = await attempts('p-01');
    assert.deepEqual([two.execution_status, two.execution_reason, three.attempt_no, three.rerun_of, three.state],
      ['worker_error', 'The worker stopped renewing the attempt\'s lease', 3, two.attempt_id, 'queued']);
    // The dead worker's late finalize is refused, as an interrupted attempt's is.
    await assert.rejects(worker.finalize('alice', second.attempt_id, second.fence, finalizeBody({
      fence: second.fence, execution: {status: 'worker_error', reason: 'late'}, coverage: {}, metrics: {}, final_cursor_expected: 0,
    }).final), {status: 409, code: 'lease_lost'});
  });

  it('stops after the third attempt, and a run with a case in a worker error is not graded', async () => {
    const third = await claim();
    assert.equal(third.attempt_no, 3);
    await workerError(third, 'RuntimeError: the workspace volume vanished');
    assert.equal((await attempts('p-01')).length, 3, 'no fourth attempt');
    const run = await repository.run(as('alice'), runId);
    assert.deepEqual([run.status, run.score.value, run.score.unavailable_reason, run.score.complete], ['complete', null, 'worker_error', true]);
    const listed = (await repository.listRuns(as('alice'), {limit: 10, before: null})).find(one => one.run_id === runId);
    assert.deepEqual([listed.status, listed.score.value, listed.score.unavailable_reason], ['complete', null, 'worker_error']);
  });

  it('retries a lease that runs out on the last try no further: its case ends as a worker error', async () => {
    const last = '00000000-0000-4000-8000-0000000000d1';
    await db.exec(`
      insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, model, endpoint_label, limits, benchmark_id, benchmark_name,
          harness_name, publisher, plugin_id)
        values ('${last}', 'lab', 'alice', 'd', '${sha256('d')}', 'm', 'openrouter', '{}', '${last}', 'b', 'claude', '{}', 'p');
      insert into benchmark_run_case (run_id, case_id, position, kind, prompt, prompt_sha256, arguments, content_digest)
        values ('${last}', 'c1', 0, 'answer', 'x', '${sha256('x')}', '{}', '${sha256('d')}');
      insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, execution_status, finalized_at, sealed)
        values ('00000000-0000-4000-8000-0000000000d2', '${last}', 'c1', 1, 'final', 'worker_error', now(), true),
               ('00000000-0000-4000-8000-0000000000d3', '${last}', 'c1', 2, 'final', 'worker_error', now(), true);
      insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, fence, worker_id, lease_expires_at)
        values ('00000000-0000-4000-8000-0000000000d4', '${last}', 'c1', 3, 'leased', 1, 'w1', now() - interval '1 second');`);
    const run = await repository.run(as('alice'), last); // a member's read sweeps
    assert.deepEqual(run.cases[0].attempts.map(one => [one.attempt_no, one.execution.status]), [[1, 'worker_error'], [2, 'worker_error'], [3, 'worker_error']]);
    assert.deepEqual([run.status, run.score.value, run.score.unavailable_reason], ['complete', null, 'worker_error']);
  });

  it('retries a worker error after the member\'s own reruns: only worker errors in a row count toward the three', async () => {
    const reran = '00000000-0000-4000-8000-0000000000e1';
    await db.exec(`
      insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, model, endpoint_label, limits, benchmark_id, benchmark_name,
          harness_name, publisher, plugin_id)
        values ('${reran}', 'lab', 'alice', 'e', '${sha256('e')}', 'm', 'openrouter', '{}', '${reran}', 'b', 'claude', '{}', 'p');
      insert into benchmark_run_case (run_id, case_id, position, kind, prompt, prompt_sha256, arguments, content_digest)
        values ('${reran}', 'c1', 0, 'answer', 'x', '${sha256('x')}', '{}', '${sha256('e')}');
      insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, execution_status, verdict, finalized_at, sealed)
        values ('00000000-0000-4000-8000-0000000000e2', '${reran}', 'c1', 1, 'final', 'answered', 'pass', now(), true),
               ('00000000-0000-4000-8000-0000000000e3', '${reran}', 'c1', 2, 'final', 'answered', 'pass', now(), true);
      insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, fence, worker_id, lease_expires_at)
        values ('00000000-0000-4000-8000-0000000000e4', '${reran}', 'c1', 3, 'leased', 1, 'w1', now() - interval '1 second');`);
    const run = await repository.run(as('alice'), reran); // a member's read sweeps
    assert.deepEqual(run.cases[0].attempts.map(one => [one.attempt_no, one.state]), [[1, 'final'], [2, 'final'], [3, 'final'], [4, 'queued']]);
    assert.equal(run.score.unavailable_reason, 'scoring_pending');
  });

  it('says a trace read that its row limit cut is truncated (regression: the count was taken after the limit, so it never was)', async () => {
    const attempt = '00000000-0000-4000-8000-0000000000e2';
    await db.exec(`insert into benchmark_span (attempt_id, span_id, kind, name, start_ns) values
      ('${attempt}', 's1', 'process', 'a', 1), ('${attempt}', 's2', 'process', 'b', 2), ('${attempt}', 's3', 'process', 'c', 3)`);
    const cut = await repository.spans(as('alice'), attempt, {kind: null, status: null, q: null, limit: 2});
    assert.deepEqual([cut.spans.map(span => span.id), cut.truncated], [['s1', 's2'], true]);
    const whole = await repository.spans(as('alice'), attempt, {kind: null, status: null, q: null, limit: 3});
    assert.deepEqual([whole.spans.length, whole.truncated], [3, false]);
  });

  it('does not retry a free-form session, whose lease expiry stays interrupted', async () => {
    await db.exec(`
      insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, model, endpoint_label,
          limits, benchmark_id, benchmark_name, harness_name, publisher, plugin_id, session, interactive)
        values ('${FREE_RUN}', 'lab', 'alice', 'free', '${sha256('free')}', 'm', 'openrouter', '{}', '${FREE_RUN}', 'harness-session', 'shell', '{}', 'p', true, true);
      insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, fence, worker_id, lease_expires_at)
        values ('${FREE_ATTEMPT}', '${FREE_RUN}', null, 1, 'leased', 1, 'w1', now() - interval '1 second');`);
    await repository.listRuns(as('alice'), {limit: 10, before: null});
    const rows = (await db.query('select attempt_no, state, execution_status from benchmark_attempt where run_id = $1', [FREE_RUN])).rows;
    assert.deepEqual(rows.map(row => [row.attempt_no, row.state, row.execution_status]), [[1, 'final', 'interrupted']]);
  });

  it('queues no retry for a canceled run', async () => {
    const canceled = '00000000-0000-4000-8000-0000000000c1';
    await db.exec(`
      insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, model, endpoint_label, limits, benchmark_id, benchmark_name,
          harness_name, publisher, plugin_id, canceled_at)
        values ('${canceled}', 'lab', 'alice', 'c', '${sha256('c')}', 'm', 'openrouter', '{}', '${canceled}', 'b', 'claude', '{}', 'p', now());
      insert into benchmark_run_case (run_id, case_id, position, kind, prompt, prompt_sha256, arguments, content_digest)
        values ('${canceled}', 'c1', 0, 'answer', 'x', '${sha256('x')}', '{}', '${sha256('d')}');
      insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, fence, worker_id, lease_expires_at)
        values ('00000000-0000-4000-8000-0000000000c2', '${canceled}', 'c1', 1, 'leased', 1, 'w1', now() - interval '1 second');`);
    await repository.listRuns(as('alice'), {limit: 10, before: null});
    assert.equal((await db.query('select count(*) as n from benchmark_attempt where run_id = $1', [canceled])).rows[0].n, 1);
  });
});
