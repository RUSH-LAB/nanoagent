import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {AGENTS, checkHarness, rushProgram} = require('../../../src/server/benchmark/harness.js');

const SHARED_SCHEMA = fileURLToPath(new URL('../../../../nanoagent/src/nanoagent/uploaded/uploaded-harness-v1.schema.json', import.meta.url));
const OWN_SCHEMA = fileURLToPath(new URL('../../../src/server/benchmark/uploaded-harness-v1.schema.json', import.meta.url));
const AGENT_BIN = fileURLToPath(new URL('../../../../nanoagent/src/nanoagent/uploaded/reference_harnesses/shell/bin', import.meta.url));

describe('the harness request schema', () => {
  it('keeps the server\'s copy of the shared schema equal to the contract\'s', () => {
    assert.deepEqual(JSON.parse(readFileSync(OWN_SCHEMA, 'utf8')), JSON.parse(readFileSync(SHARED_SCHEMA, 'utf8')));
  });

  it('gives a harness the case\'s id and prompt only: no arguments, schemas, context or policy', () => {
    const {$defs} = JSON.parse(readFileSync(OWN_SCHEMA, 'utf8'));
    assert.deepEqual(Object.keys($defs.Case.properties), ['case_id']);
    assert.ok(!$defs.Policy && !$defs.Request.properties.policy);
    assert.ok(!('instructions' in $defs.Task.properties));
  });
});

describe('the harness a run names', () => {
  it('is an agent of the shell harness, or rush <command> for a member\'s own', () => {
    // A member's own agent may carry its headless arguments, the case's prompt following as the last one.
    for (const name of [...AGENTS, 'rush aider', 'rush my-agent_2.0', 'rush aider --yes --message', 'rush goose run -t', 'rush a b']) assert.equal(checkHarness(name), name);
    for (const name of ['claude-code', 'shell', 'rush', 'rush  aider', 'rush Aider', 'rush aider ', 'rush aider  -m', 'rush aider "-m"', 'rush aider $(x)',
      'rush forget', 'rush help', 'rush forget x', 'Claude', '', undefined, null, 3]) {
      assert.throws(() => checkHarness(name), {code: 'unknown_harness', status: 400}, String(name));
    }
  });

  it('names the program of a member\'s own agent, without its arguments', () => {
    assert.equal(rushProgram('rush aider --yes --message'), 'aider');
    assert.equal(rushProgram('rush aider'), 'aider');
    assert.equal(rushProgram('claude'), null);
  });

  it('are the agent CLIs the shell harness\'s bin/ wrappers run (mgen is nanoagent\'s second name)', () => {
    const wrappers = readdirSync(AGENT_BIN).filter(name => name !== 'mgen').sort();
    assert.deepEqual([...AGENTS], wrappers);
  });
});

const route = loadRoute('benchmark');
const CONTEXT = {userId: 'u', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const ID = '00000000-0000-4000-8000-000000000001';
const get = (repository, path, query) => invoke(route, {path, query, requestContext: CONTEXT, ctx: makeCtx({benchmark: {repository, service: {}}})});

describe('the benchmark read routes', () => {
  it('list benchmarks filtered by plugin and version, and refuse a version without a plugin', async () => {
    const seen = [];
    const repository = {benchmarks: async (_context, filter) => { seen.push(filter); return [{benchmark_id: ID}]; }};
    assert.deepEqual((await get(repository, '/api/benchmark/benchmarks', {plugin_id: 'p', version: '1'})).payload, {benchmarks: [{benchmark_id: ID}]});
    await get(repository, '/api/benchmark/benchmarks');
    assert.deepEqual(seen, [{pluginId: 'p', version: '1', limit: 50, before: null}, {pluginId: null, version: null, limit: 50, before: null}]);
    const refused = await get(repository, '/api/benchmark/benchmarks', {version: '1'});
    assert.deepEqual([refused.status, refused.payload.code], [400, 'invalid_request']);
  });

  it('bound the lists by limit and a before cursor, normalized to ISO and refused when it is no date', async () => {
    const seen = [];
    const repository = {
      benchmarks: async (_context, filter) => { seen.push(filter); return []; },
      listRuns: async (_context, filter) => { seen.push(filter); return []; },
    };
    for (const path of ['/api/benchmark/benchmarks', '/api/benchmark/runs']) {
      assert.equal((await get(repository, path, {before: '1', limit: '7'})).status, 200, path);
      assert.equal((await get(repository, path, {before: 'nonsense'})).payload.code, 'invalid_request', path);
      assert.equal((await get(repository, path, {limit: '201'})).payload.code, 'invalid_request', path);
    }
    assert.ok(seen.every(filter => filter.before === new Date(Date.parse('1')).toISOString() && filter.limit === 7));
    assert.equal(seen.length, 2);
  });

  it('validates and passes a run cursor with its timestamp and run id', async () => {
    const seen = [];
    const repository = {listRuns: async (_context, filter) => { seen.push(filter); return []; }};
    assert.equal((await get(repository, '/api/benchmark/runs', {before: '2026-01-01T00:00:00Z', before_id: ID})).status, 200);
    assert.deepEqual(seen[0], {limit: 50, before: '2026-01-01T00:00:00.000Z', beforeId: ID});
    for (const query of [{before_id: ID}, {before: '2026-01-01', before_id: 'bad'}]) {
      assert.equal((await get(repository, '/api/benchmark/runs', query)).payload.code, 'invalid_request');
    }
  });

  it('show one benchmark, answering 404 unknown_benchmark for any other id, and have no route for the results of other members\' runs', async () => {
    const repository = {
      benchmark: async (_context, id) => (id === ID ? {benchmark_id: ID, cases: []} : null),
    };
    assert.deepEqual((await get(repository, `/api/benchmark/benchmarks/${ID}`)).payload, {benchmark: {benchmark_id: ID, cases: []}});
    // The route does not match, so the dispatcher answers it as it does any unknown path.
    assert.equal((await get(repository, `/api/benchmark/benchmarks/${ID}/results`)).status, undefined);
    for (const path of [`/api/benchmark/benchmarks/${ID.replace('1', '2')}`, '/api/benchmark/benchmarks/pinned-not']) {
      const {status, payload} = await get(repository, path);
      assert.deepEqual([status, payload.code], [404, 'unknown_benchmark'], path);
    }
  });
});

describe('POST /api/benchmark/benchmarks', () => {
  const publish = (service, requestContext = null, auth) => invoke(route, {
    method: 'POST', path: '/api/benchmark/benchmarks', body: {name: 'Bad Name'}, requestContext, ...(auth !== undefined && {auth}), ctx: makeCtx({benchmark: {repository: {}, service}}),
  });

  it('answers a body that is no benchmark with 400 invalid_request, and needs a signed-in member', async () => {
    const refused = await publish({publish: async () => { throw new Error('must not publish'); }});
    assert.deepEqual([refused.status, refused.payload.code], [400, 'invalid_request']);
    assert.equal((await publish({}, null, {})).status, 401);
  });
});

describe('the routes of the removed features', () => {
  it('are gone: previews, source uploads, reference harnesses and imports match no route of the benchmark API', async () => {
    for (const path of ['/api/benchmark/previews', '/api/benchmark/sources', '/api/benchmark/sources/references/codex', '/api/benchmark/sources/references/codex/computer', '/api/benchmark/imports']) {
      const reply = await invoke(route, {method: 'POST', path, requestContext: CONTEXT, ctx: makeCtx({benchmark: {repository: {}, service: {}}})});
      assert.equal(reply.status, undefined, path);  // the route answered nothing, so a later route takes the request (and finds none)
    }
  });
});

describe('POST /api/benchmark/benchmarks, the publication', () => {
  it('is read with the larger limit its fixtures need, and refuses the old shape naming the field', async () => {
    const limits = require('../../../src/server/benchmark/limits.js');
    const seen = [];
    const ctx = makeCtx({benchmark: {repository: {}, service: {publish: async () => assert.fail('must not publish')}}});
    const sent = {name: 'sums', context: 'old', plugin_id: 'p'};
    ctx.readRawBody = async (req, max) => { seen.push(max); return Buffer.from(JSON.stringify(sent)); };
    const {status, payload} = await invoke(route, {method: 'POST', path: '/api/benchmark/benchmarks', requestContext: null, ctx});
    assert.deepEqual([status, payload.code, /context is no longer a field/.test(payload.error)], [400, 'invalid_request', true]);
    assert.deepEqual(seen, [limits.MAX_PUBLISH_BYTES]);
    assert.ok(limits.MAX_PUBLISH_BYTES > 10 * 1024 * 1024);
  });
});

describe('the worker route for a case\'s fixtures', () => {
  const workerRoute = require('../../../src/server/routes/benchmark-worker.js');
  const ATTEMPT = '00000000-0000-4000-8000-000000000009';
  const asked = (worker, part, headers = {'x-rush-fence': '3'}) => invoke(workerRoute, {
    method: 'GET', path: `/api/benchmark-worker/attempts/${ATTEMPT}/${part}`, headers: {authorization: 'Bearer cred', ...headers}, auth: null,
    ctx: makeCtx({benchmark: {worker: {authenticate: async () => 'u', ...worker}}}),
  });

  it('answers the archive as application/gzip with its sha256, for the lease\'s fence', async () => {
    const data = Buffer.from('gzipped tar');
    const calls = [];
    const reply = await asked({artifact: async (...args) => { calls.push(args); return {data, sha256: 'a'.repeat(64)}; }}, 'fixtures');
    assert.equal(reply.res.written.status, 200);
    assert.deepEqual([reply.res.written.headers['Content-Type'], reply.res.written.headers['X-Rush-Sha256'], reply.res.written.body.equals(data)], ['application/gzip', 'a'.repeat(64), true]);
    assert.deepEqual(calls, [['u', ATTEMPT, 3, 'fixtures']]);
  });

  it('answers 404 no_fixtures for a case with none, and 400 without the fence', async () => {
    const {BenchmarkError} = require('../../../src/server/benchmark/errors.js');
    const none = await asked({artifact: async () => { throw new BenchmarkError(404, 'no_fixtures', 'none'); }}, 'fixtures');
    assert.deepEqual([none.status, none.payload.code], [404, 'no_fixtures']);
    const unfenced = await asked({artifact: async () => assert.fail('asked')}, 'fixtures', {});
    assert.deepEqual([unfenced.status, unfenced.payload.code], [400, 'invalid_request']);
  });

  it('has no source and no case route: the harness is no ZIP, and a claim carries its case', async () => {
    for (const part of ['source', 'case']) assert.equal((await asked({}, part)).status, 404, part);
  });
});
