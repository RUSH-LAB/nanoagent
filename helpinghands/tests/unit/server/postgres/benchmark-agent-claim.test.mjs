/**
 * Installed Terminal agents through the migrated database: live catalogs, worker eligibility and one installation per run.
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
const {benchmarkPublication, runBody} = require('../../../../src/server/benchmark/validate.js');
const {DEFAULT_LIMITS, RUN_ENDPOINT, RUN_MODEL} = require('../../../../src/server/benchmark/limits.js');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const PACKAGE = Buffer.from('the package');
const ARCHIVE = gzipSync(Buffer.from('fixture tar'));
const FIXTURES = {sha256: sha256(ARCHIVE), files: {'inputs/a.csv': 'b'.repeat(64)}, archive: ARCHIVE.toString('base64')};
const CAPABILITIES = {...DEFAULT_LIMITS, models: [RUN_MODEL]};
const CONFIG = {leaseSeconds: 60, uncertainDeadlineSeconds: 3600, memberBudgetUsd: 25, workspaceBudgetUsd: 100};
const ENTRY = {name: 'P', permissions: {}, tools: [], tasks: [{id: 't', runner: 'agent', description: 'Sum', tools: []}]};

const publication = (extra = {}) => {
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
  return benchmarkPublication(body);
};

let db;
let repository;
let worker;
let service;

describe('installed agent claim selection', () => {
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

  it('keeps each live worker catalog and checks the selected agent against its worker', async () => {
    await worker.claim('alice', 'agent-a', RUN_ENDPOINT, {...CAPABILITIES, installed_agents: ['alpha']}, false);
    await worker.claim('alice', 'agent-b', RUN_ENDPOINT, {...CAPABILITIES, models: ['other/model'], installed_agents: ['beta']}, false);
    await worker.claim('alice', 'empty', RUN_ENDPOINT, CAPABILITIES, false);
    const endpoint = (await repository.endpoints('alice')).find(row => row.label === RUN_ENDPOINT);
    assert.deepEqual(endpoint.capabilities.installed_agents, ['alpha', 'beta']);
    assert.deepEqual((await repository.capabilities('alice', RUN_ENDPOINT, {agent: 'beta'})).models, ['other/model']);
    assert.equal(await repository.capabilities('alice', RUN_ENDPOINT, {agent: 'missing'}), null);
    const {benchmark} = await service.publish('alice', publication({name: 'catalog-test'}));
    await assert.rejects(service.submit(as('alice'), runBody({benchmark_id: benchmark.benchmark_id, harness: 'rush beta', idempotency_key: 'beta'})), {code: 'unknown_model'});
    await assert.rejects(service.submit(as('alice'), runBody({benchmark_id: benchmark.benchmark_id, harness: 'rush missing', idempotency_key: 'missing'})), {code: 'agent_not_installed'});
  });

  it('leases only to a worker with the command and pins the run to that worker', async () => {
    await worker.claim('alice', 'installed', RUN_ENDPOINT, {...CAPABILITIES, installed_agents: ['aider']}, false);
    const {benchmark} = await service.publish('alice', publication());
    const {run_id} = await service.submit(as('alice'), runBody({benchmark_id: benchmark.benchmark_id, harness: 'rush aider', idempotency_key: 'agent'}));
    assert.equal(await worker.claim('alice', 'other', RUN_ENDPOINT, CAPABILITIES, false), null);
    const first = await worker.claim('alice', 'installed', RUN_ENDPOINT, {...CAPABILITIES, installed_agents: ['aider']}, false);
    assert.equal(first.run.run_id, run_id);
    assert.equal(await worker.claim('alice', 'other', RUN_ENDPOINT, {...CAPABILITIES, installed_agents: ['aider']}, false), null);
    const second = await worker.claim('alice', 'installed', RUN_ENDPOINT, CAPABILITIES, false);
    assert.equal(second.run.run_id, run_id);
    assert.notEqual(first.attempt_id, second.attempt_id);
  });
});
