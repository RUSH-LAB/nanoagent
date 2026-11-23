import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {strToU8, zipSync} = require('fflate');
const {REFERENCE_HARNESSES, REFERENCE_LABELS, harnessOf, referenceHarnessOf, uploadedHarnessOf} = require('../../../src/server/benchmark/harness.js');

const MANIFEST = `protocol: rush.harness.v1
name: my-harness
version: "1.3"
dialects: [chat_completions, responses]
toolchain: go-1
lockfiles: []
build: {argv: [go, build], outputs: [harness]}
run: {argv: [/harness/harness]}
`;
const zip = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))));
const withoutField = field => MANIFEST.split('\n').filter(line => !line.startsWith(`${field}:`)).join('\n');

describe('the harness a source ZIP declares', () => {
  it('reads name, version and dialects from the harness.yaml at the root', () => {
    assert.deepEqual(harnessOf(zip({'harness.yaml': MANIFEST, 'src/main.go': 'package main'})), {name: 'my-harness', version: '1.3', dialects: ['chat_completions', 'responses']});
  });

  it('refuses what is not a ZIP, a ZIP without the manifest at its root, and a manifest that does not validate', () => {
    assert.throws(() => harnessOf(Buffer.from('not a zip at all, but long enough to look like one')), {code: 'invalid_zip', status: 400});
    assert.throws(() => harnessOf(zip({'sub/harness.yaml': MANIFEST})), {code: 'missing_manifest'});
    assert.throws(() => harnessOf(zip({'harness.yaml': ': : :'})), {code: 'invalid_manifest'});
    for (const field of ['name', 'version', 'dialects']) {
      assert.throws(() => harnessOf(zip({'harness.yaml': withoutField(field)})), {code: 'invalid_manifest', message: new RegExp(`'${field}'`)});
    }
    assert.throws(() => harnessOf(zip({'harness.yaml': MANIFEST.replace('name: my-harness', 'name: My Harness')})), {code: 'invalid_manifest'});
    assert.throws(() => harnessOf(zip({'harness.yaml': MANIFEST.replace('version: "1.3"', 'version: 1.3')})), {code: 'invalid_manifest'});
    assert.throws(() => harnessOf(zip({'harness.yaml': MANIFEST.replace('[chat_completions, responses]', '[responses, responses]')})), {code: 'invalid_manifest'});
    assert.throws(() => harnessOf(zip({'harness.yaml': MANIFEST.replace('[chat_completions, responses]', '[]')})), {code: 'invalid_manifest'});
    assert.throws(() => harnessOf(zip({'harness.yaml': `${MANIFEST}extra: 1\n`})), {code: 'invalid_manifest'});
  });
});

describe('the reference harnesses', () => {
  it('are each named by its agent\'s CLI command', () => {
    assert.deepEqual(Object.keys(REFERENCE_LABELS).sort(), [...REFERENCE_HARNESSES].sort());
  });

  it('have reserved names: a member\'s own upload with one is refused, the reference path takes it only under its own name', () => {
    const named = name => zip({'harness.yaml': MANIFEST.replace('name: my-harness', `name: ${name}`)});
    assert.throws(() => uploadedHarnessOf(named('claude-code')), {code: 'reserved_harness_name', status: 400});
    assert.equal(uploadedHarnessOf(named('mine')).name, 'mine');
    assert.equal(referenceHarnessOf(named('claude-code'), 'claude-code').name, 'claude-code');
    assert.throws(() => referenceHarnessOf(named('codex'), 'claude-code'), {code: 'reference_name_mismatch'});
    assert.throws(() => referenceHarnessOf(named('mine'), 'mine'), {code: 'unknown_reference'});
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
      benchmarkResults: async (_context, _id, filter) => { seen.push(filter); return []; },
    };
    for (const path of ['/api/benchmark/benchmarks', '/api/benchmark/runs', `/api/benchmark/benchmarks/${ID}/results`]) {
      assert.equal((await get(repository, path, {before: '1', limit: '7'})).status, 200, path);
      assert.equal((await get(repository, path, {before: 'nonsense'})).payload.code, 'invalid_request', path);
      assert.equal((await get(repository, path, {limit: '201'})).payload.code, 'invalid_request', path);
    }
    assert.ok(seen.every(filter => filter.before === new Date(Date.parse('1')).toISOString() && filter.limit === 7));
    assert.equal(seen.length, 3);
  });

  it('show one benchmark, and its results, answering 404 unknown_benchmark for any other id', async () => {
    const repository = {
      benchmark: async (_context, id) => (id === ID ? {benchmark_id: ID, cases: []} : null),
      benchmarkResults: async (_context, id, options) => (id === ID ? [{run_id: 'r', options}] : null),
    };
    assert.deepEqual((await get(repository, `/api/benchmark/benchmarks/${ID}`)).payload, {benchmark: {benchmark_id: ID, cases: []}});
    assert.deepEqual((await get(repository, `/api/benchmark/benchmarks/${ID}/results`, {limit: '5'})).payload.runs[0].options.limit, 5);
    for (const path of [`/api/benchmark/benchmarks/${ID.replace('1', '2')}`, `/api/benchmark/benchmarks/${ID.replace('1', '2')}/results`, '/api/benchmark/benchmarks/pinned-not', '/api/benchmark/benchmarks/x/results']) {
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

describe('the reference harness built on the member\'s computer', () => {
  const ref = name => zip({'harness.yaml': MANIFEST.replace('name: my-harness', `name: ${name}`)});
  const post = (path, computer, repository) => invoke(route, {method: 'POST', path, requestContext: CONTEXT, ctx: makeCtx({benchmark: {repository, service: {}}, runners: {computer: () => computer}})});

  it('is stored as the member\'s source under the reference\'s own name', async () => {
    const saved = [];
    const repository = {saveSource: async (_context, data, harness) => { saved.push(harness.name); return {harness}; }};
    const asked = [];
    const computer = {benchmarkReferenceHarness: async name => { asked.push(name); return {value: ref(name)}; }};
    assert.equal((await post('/api/benchmark/sources/references/codex/computer', computer, repository)).status, 201);
    assert.deepEqual([asked, saved], [['codex'], ['codex']]);
  });

  it('is refused for a name that is no reference, before the computer is asked, and when the computer is offline', async () => {
    const computer = {benchmarkReferenceHarness: async () => assert.fail('asked')};
    assert.equal((await post('/api/benchmark/sources/references/mine/computer', computer, {})).payload.code, 'unknown_reference');
    assert.equal((await post('/api/benchmark/sources/references/codex/computer', null, {})).payload.code, 'runner_offline');
  });

  it('is relayed from NanoAgent\'s GET route', () => {
    const {allowed} = require('../../../src/runner/protocol.js');
    assert.ok(allowed('GET', '/v1/benchmark/reference-harnesses/claude-code'));
  });
});
