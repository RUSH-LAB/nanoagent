import {describe, it, mock} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {allowed} = require('../../../src/runner/protocol.js');
const {createNanoAgentGateway, PIN_TIMEOUT_MS} = require('../../../src/server/ai.js');
const {RUN_ENDPOINT, RUN_MODEL} = require('../../../src/server/benchmark/limits.js');
const route = loadRoute('benchmark');
const CONTEXT = {userId: 'u', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const SHA = 'a'.repeat(64);
const PATH = '/api/benchmark/benchmarks/pinned';

/** The pinned case set NanoAgent answers (as text, with `1.0` spelled as Python wrote it) for a spec. */
const pinned = {
  name: 's', plugin_id: 'p', plugin_name: 'P', version: '1.0.0', package_sha256: SHA, task_id: 'sum',
  task: {kind: 'agent', description: 'd', input_schema: {}, output_schema: {}, tools: [], egress_hosts: []},
  cases: [{case_id: 'p-01', kind: 'answer', prompt: 'Do x: 1.0', arguments: {x: 1.0}, fixtures: null, expected_error: null}], private: {'p-01': {v: 1.0}},
};
const pinnedText = JSON.stringify(pinned).replace('"x":1', '"x":1.0').replace('"v":1', '"v":1.0');
const CASE_FILE = 'plugin: p\ntask: sum\ncases:\n  - prompt: |-\n      Do x: 1.0\n    arguments:\n      x: 1.0\n    fixtures: fx\n';
const BODY = JSON.stringify({plugin_id: 'p', name: 's', case_file: CASE_FILE, files: {'fx/a.csv': 'YQ=='}, limits: {max_cost_usd: 0.5}});

/** A ctx whose member has a computer that pins `answer`, and one installed app. */
function ctxFor({computer, app = {value: {id: 'p', sha256: SHA, status: 'ready'}}} = {}) {
  const calls = [];
  const published = [];
  const pinning = computer ?? {benchmarkCaseSet: async (sha, bodyText) => { calls.push([sha, bodyText]); return {value: pinnedText}; }};
  return {
    calls,
    published,
    ctx: makeCtx({
      benchmark: {service: {publish: async (userId, publication) => { published.push([userId, publication]); return {created: true, benchmark: {benchmark_id: 'b', name: publication.name}}; }}, repository: {}},
      runners: {computer: () => pinning},
      workspaceApps: {open: async (context, id, on) => { calls.push(['open', id, on === pinning]); return app; }},
    }),
  };
}

const post = (ctx, body) => invoke(route, {method: 'POST', path: PATH, body, requestContext: CONTEXT, ctx});

describe('POST /api/benchmark/benchmarks/pinned', () => {
  it('installs the member\'s app on their computer, has it pin the cases there from the text it was sent, and publishes the benchmark with the member\'s configuration, without the plugin id', async () => {
    const {ctx, calls, published} = ctxFor();
    const {status, payload} = await post(ctx, BODY);
    assert.equal(status, 201);
    assert.deepEqual([payload.benchmark.name, payload.created], ['s', true]);
    assert.equal(payload.private, undefined, 'the private references stay on the server');
    assert.deepEqual(calls, [['open', 'p', true], [SHA, JSON.stringify({name: 's', case_file: CASE_FILE, files: {'fx/a.csv': 'YQ=='}})]]);
    assert.equal(published.length, 1);
    const [userId, publication] = published[0];
    assert.equal(userId, 'u');
    assert.deepEqual([publication.model, publication.endpoint_profile, publication.limits.max_cost_usd, publication.digest.length], [RUN_MODEL, RUN_ENDPOINT, 0.5, 64]);
  });

  it('keeps the spelling of a number NanoAgent writes, in what it publishes', async () => {
    const {ctx, published} = ctxFor();
    await post(ctx, BODY);
    assert.equal(String(published[0][1].cases[0].arguments.x), '1.0');
  });

  it('takes only the configuration from the member: nothing it sends overrides what NanoAgent pinned', async () => {
    const {ctx, published} = ctxFor();
    await post(ctx, BODY.replace('"name"', '"package_sha256":"' + 'b'.repeat(64) + '","private":{},"task_id":"other","name"'));
    assert.deepEqual([published[0][1].package_sha256, published[0][1].task_id, Object.keys(published[0][1].private)], [SHA, 'sum', ['p-01']]);
  });

  it('says why the pinning failed, as the computer says it', async () => {
    const {ctx} = ctxFor({computer: {benchmarkCaseSet: async () => ({error: 'echo could not answer {}, a case to answer: boom', status: 422})}});
    const {status, payload} = await post(ctx, BODY);
    assert.deepEqual([status, payload.code, payload.error], [422, 'pin_failed', 'echo could not answer {}, a case to answer: boom']);
  });

  it('pins nowhere but the member\'s own computer, and not an app that is not ready or not theirs', async () => {
    const offline = makeCtx({benchmark: {repository: {}, service: {}}, runners: {computer: () => null}, workspaceApps: {open: async () => { throw new Error('must not open'); }}});
    assert.equal((await post(offline, BODY)).status, 503);
    assert.equal((await post(ctxFor({app: {error: 'You have not installed a plugin named p', status: 404}}).ctx, BODY)).status, 404);
    const refused = await post(ctxFor({app: {value: {id: 'p', sha256: SHA, status: 'refused'}}}).ctx, BODY);
    assert.deepEqual([refused.status, refused.payload.code], [409, 'app_unavailable']);
    assert.equal((await post(ctxFor().ctx, {name: 's'})).status, 400);
  });

  it('refuses a body without a case file or a name, or with a model or an endpoint, or with files that are not text, before pinning anything', async () => {
    const {ctx, calls} = ctxFor();
    for (const field of ['case_file', 'files', 'name']) {
      const body = JSON.parse(BODY);
      delete body[field];
      assert.equal((await post(ctx, body)).status, 400, field);
    }
    for (const change of [{case_file: {plugin: 'p'}}, {files: {'a.csv': 5}}, {files: []}, {model: 'vendor/model'}, {endpoint_profile: 'mock'}, {name: 'Not A Name'}, {cases: {plugin: 'p'}, case_file: undefined}]) {
      assert.equal((await post(ctx, {...JSON.parse(BODY), ...change})).status, 400, JSON.stringify(change));
    }
    assert.deepEqual(calls, []);
  });

  it('reads a body as large as a publication, not only the small default', async () => {
    const {ctx, published} = ctxFor();
    const big = JSON.stringify({...JSON.parse(BODY), files: {'fx/big.bin': 'A'.repeat(12 * 1024 * 1024)}});
    assert.equal((await post(ctx, big)).status, 201);
    assert.equal(published.length, 1);
  });
});

describe('the pin request to the member\'s computer', () => {
  it('goes to NanoAgent\'s install of the package, and the relay lets it through', async () => {
    assert.ok(allowed('POST', `/v1/installs/${SHA}/benchmark/case-set`));
    assert.ok(!allowed('GET', `/v1/installs/${SHA}/benchmark/case-set`));
    const seen = [];
    const gateway = createNanoAgentGateway({
      endpoint: {url: 'http://runner'}, local: true,
      fetchImpl: async (url, init) => { seen.push([url, init.method, init.body]); return new Response('{"ok":true}', {status: 200}); },
    });
    const result = await gateway.benchmarkCaseSet(SHA, '{"name":"s"}');
    assert.equal(result.value, '{"ok":true}', 'the answer is text, as NanoAgent wrote it');
    assert.deepEqual(seen, [[`http://runner/v1/installs/${SHA}/benchmark/case-set`, 'POST', '{"name":"s"}']]);
  });
});

describe('the time pinning may take', () => {
  // NanoAgent's BENCHMARK_PIN_TIMEOUT is 900 seconds for one case's reference tool.
  it('is bounded: the reference tool\'s 900 seconds and a margin', () => {
    assert.ok(PIN_TIMEOUT_MS > 900_000 && PIN_TIMEOUT_MS <= 1_200_000, `${PIN_TIMEOUT_MS}`);
  });

  it('is the socket timeout of POST benchmarks/pinned, never none', async () => {
    const {ctx} = ctxFor();
    const seen = [];
    await invoke(route, {method: 'POST', path: PATH, body: BODY, requestContext: CONTEXT, ctx, onRequest: req => { req.setTimeout = ms => { seen.push(ms); return req; }; }});
    assert.deepEqual(seen, [PIN_TIMEOUT_MS]);
  });

  it('is how long the call to NanoAgent waits', async () => {
    mock.timers.enable({apis: ['setTimeout']});
    try {
      let signal;
      const gateway = createNanoAgentGateway({
        endpoint: {url: 'http://runner'}, local: true,
        fetchImpl: (url, init) => { signal = init.signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); },
      });
      const result = gateway.benchmarkCaseSet(SHA, '{}');
      mock.timers.tick(PIN_TIMEOUT_MS - 1);
      assert.equal(signal.aborted, false);
      mock.timers.tick(1);
      assert.equal(signal.aborted, true);
      assert.equal((await result).status, 504);
    } finally {
      mock.timers.reset();
    }
  });
});
