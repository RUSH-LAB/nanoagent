import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {strToU8, zipSync} = require('fflate');
const {allowed} = require('../../../src/runner/protocol.js');
const {MODEL} = require('../../../src/server/ai-settings.js');
const {createBenchmarkService} = require('../../../src/server/benchmark/service.js');
const {benchmarkPublication} = require('../../../src/server/benchmark/validate.js');
const {BenchmarkError} = require('../../../src/server/benchmark/errors.js');
const route = loadRoute('benchmark');
const workerRoute = require('../../../src/server/routes/benchmark-worker.js');
const CONTEXT = {userId: 'u', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const SHA = 'a'.repeat(64);
const PATH = '/api/benchmark/sessions';

/** The one-case case set NanoAgent pins for a session: the request as its context, the input its plugin model filled. */
const pinned = {
  name: 'harness-session', plugin_id: 'p', plugin_name: 'P', version: '1.0.0', package_sha256: SHA, task_id: 'sum',
  task: {kind: 'agent', description: 'd', instructions: 'i', input_schema: {}, output_schema: {}, tools: [], egress_hosts: []},
  context: 'Add one and two', cases: [{case_id: 'p-01', kind: 'answer', arguments: {x: 1, y: 2}, expected_error: null}], private: {'p-01': {sum: 3}},
};
const referenceZip = name => Buffer.from(zipSync({'harness.yaml': strToU8(`protocol: rush.harness.v1
name: ${name}
version: "abc"
dialects: [anthropic_messages]
toolchain: javascript-22
lockfiles: []
build: {argv: [npm, ci], outputs: [node_modules]}
run: {argv: [node, main.js]}
`)}));

const SAVED = {source_sha256: 'c'.repeat(64), size: 9, harness: {name: 'my-agent', version: '0123456789ab', dialects: ['chat_completions']}};

function ctxFor({computer, app = {value: {id: 'p', sha256: SHA, status: 'ready'}}} = {}) {
  const calls = [];
  const on = computer ?? {
    benchmarkSession: async (sha, bodyText) => { calls.push(['pin', sha, JSON.parse(bodyText)]); return {value: JSON.stringify(pinned)}; },
    benchmarkReferenceHarness: async name => { calls.push(['build', name]); return {value: referenceZip(name)}; },
  };
  const ctx = makeCtx({
    benchmark: {
      service: {session: async (context, publication, source, policy, options) => { calls.push(['session', publication, source, policy, options]); return {run_id: 'r1'}; }},
      repository: {
        saveSource: async (context, data, harness) => ({source_sha256: 'b'.repeat(64), size: data.length, harness}),
        run: async (context, id) => ({run_id: id}),
        savedHarness: async (context, name) => (name === 'my-agent' ? SAVED : null),
      },
    },
    runners: {computer: () => on},
    workspaceApps: {open: async (context, id) => { calls.push(['open', id]); return app; }},
  });
  return {ctx, calls};
}

const post = (ctx, body) => invoke(route, {method: 'POST', path: PATH, body, requestContext: CONTEXT, ctx});
const BODY = {plugin_id: 'p', task_id: 'sum', harness: 'claude-code', text: 'Add one and two', interactive: true};

describe('POST /api/benchmark/sessions', () => {
  it('has the member\'s computer fill the task\'s input from the request with the model every run uses and pin it, builds the reference harness, and queues its run', async () => {
    const {ctx, calls} = ctxFor();
    const {status, payload} = await post(ctx, BODY);
    assert.equal(status, 201);
    assert.deepEqual(payload, {run: {run_id: 'r1'}});
    assert.deepEqual(calls.slice(0, 3), [['open', 'p'], ['pin', SHA, {task: 'sum', text: 'Add one and two', model: MODEL}], ['build', 'claude-code']]);
    const [, publication, source, policy] = calls[3];
    assert.deepEqual([publication.model, publication.endpoint_profile, publication.context, publication.cases.length], [MODEL.model, 'openrouter', 'Add one and two', 1]);
    assert.deepEqual([source.harness.name, policy], ['claude-code', 'coding']);
    assert.deepEqual(calls[3][4], {interactive: true}); // the member is at the harness's terminal
  });

  it('takes the harness\'s model and whether the member is at its terminal from the request', async () => {
    const {ctx, calls} = ctxFor();
    await post(ctx, {...BODY, interactive: false, model: 'openai/gpt-5.5'});
    assert.deepEqual(calls[1][2].model, MODEL); // the case is pinned with the model every run uses
    assert.deepEqual([calls[3][1].model, calls[3][4]], ['openai/gpt-5.5', {interactive: false}]);
    assert.equal((await post(ctxFor().ctx, {...BODY, interactive: undefined})).status, 400);
  });

  it('works RUSH\'s own harness with the task\'s tools', async () => {
    const {ctx, calls} = ctxFor();
    await post(ctx, {...BODY, harness: 'nanoagent'});
    assert.equal(calls.at(-1)[3], 'task_tools');
  });

  it('refuses a harness that is no reference harness, a missing field, and says why pinning failed', async () => {
    assert.deepEqual((await post(ctxFor().ctx, {...BODY, harness: 'mine'})).payload.code, 'unknown_harness');
    assert.equal((await post(ctxFor().ctx, {...BODY, text: ''})).status, 400);
    const failing = ctxFor({computer: {benchmarkSession: async () => ({error: 'p has an unknown task: nope', status: 422})}});
    const {status, payload} = await post(failing.ctx, BODY);
    assert.deepEqual([status, payload.code, payload.error], [422, 'pin_failed', 'p has an unknown task: nope']);
  });

  it('reruns a harness the member saved from a Terminal session, its latest version under the coding prompt, with nothing to build', async () => {
    const {ctx, calls} = ctxFor();
    assert.equal((await post(ctx, {...BODY, harness: 'my-agent'})).status, 201);
    assert.deepEqual(calls.map(([what]) => what), ['open', 'pin', 'session']);
    assert.deepEqual([calls[2][2], calls[2][3]], [SAVED, 'coding']);
  });

  it('runs only on the member\'s own computer, and only an app of theirs that is ready', async () => {
    const offline = makeCtx({benchmark: {repository: {}, service: {}}, runners: {computer: () => null}, workspaceApps: {open: async () => assert.fail('must not open')}});
    assert.equal((await post(offline, BODY)).status, 503);
    const refused = await post(ctxFor({app: {value: {id: 'p', sha256: SHA, status: 'refused'}}}).ctx, BODY);
    assert.deepEqual([refused.status, refused.payload.code], [409, 'app_unavailable']);
  });

  it('is a request the relay lets through to NanoAgent', () => {
    assert.ok(allowed('POST', `/v1/installs/${SHA}/benchmark/session`));
  });
});

describe('POST /api/benchmark-worker/attempts/{id}/harness', () => {
  const ATTEMPT = '00000000-0000-4000-8000-000000000009';
  const savedZip = name => Buffer.from(zipSync({'harness.yaml': strToU8(`protocol: rush.harness.v1
name: ${name}
version: "0123456789ab"
dialects: [chat_completions]
toolchain: python-3
lockfiles: []
build: {argv: [sh, -c, "cp -R shell.py executables workspace /build-out/"], outputs: [shell.py, executables, workspace]}
run: {argv: [python, /harness/shell.py, "bash run.sh"]}
`)}));
  const send = async (data, session = true) => {
    const saved = [];
    const ctx = makeCtx({benchmark: {
      worker: {
        authenticate: async bearer => (bearer === 'cred' ? 'u' : null),
        sessionWorkspace: async (userId, attemptId, fence) => {
          if (!session) throw new BenchmarkError(403, 'not_a_session', 'Only a session someone works in saves a harness');
          return userId === 'u' && attemptId === ATTEMPT && fence === 3 ? 'w' : null;
        },
      },
      repository: {saveSource: async (context, zip, harness) => { saved.push([context, harness]); return {source_sha256: 'c'.repeat(64), size: zip.length, harness}; }},
    }});
    const result = await invoke(workerRoute, {
      method: 'POST', path: `/api/benchmark-worker/attempts/${ATTEMPT}/harness`, headers: {authorization: 'Bearer cred', 'x-rush-fence': '3'}, ctx, auth: null,
      onRequest: req => setTimeout(() => { req.emit('data', data); req.emit('end'); }, 5),
    });
    return {...result, saved};
  };

  it('keeps the harness a session saved as the member\'s own upload to the run\'s workspace', async () => {
    const {status, payload, saved} = await send(savedZip('my-agent'));
    assert.deepEqual([status, payload.harness.name], [201, 'my-agent']);
    assert.deepEqual(saved, [[{userId: 'u', workspaceId: 'w'}, {name: 'my-agent', version: '0123456789ab', dialects: ['chat_completions']}]]);
  });

  it('refuses a reference harness\'s name and a run nobody works in', async () => {
    assert.equal((await send(savedZip('shell'))).payload.code, 'reserved_harness_name');
    const refused = await send(savedZip('my-agent'), false);
    assert.deepEqual([refused.status, refused.payload.code, refused.saved], [403, 'not_a_session', []]);
  });
});

describe('a session\'s run', () => {
  it('is a run of a benchmark nobody publishes: its case set kept, resolved against the member\'s worker and queued like any run', async () => {
    const kept = [];
    const repository = {
      saveCaseSet: async (userId, publication) => { kept.push(['case set', userId, publication.case_set_digest]); return {id: userId, name: 'Ada', github: null}; },
      capabilities: async () => ({models: [MODEL.model], max_cost_usd: 100, wall_time_ms: 10_000_000, max_model_calls: 10_000, max_output_tokens_per_call: 100_000,
        cpus: 8, memory_mb: 64_000, pids: 10_000, workspace_bytes: 1e12, workspace_files: 1e9, tmp_bytes: 1e12, build_wall_ms: 1e9, build_memory_mb: 64_000,
        build_output_bytes: 1e12, build_files: 1e9, build_tmp_bytes: 1e12, internet_access: true}),
      savePreview: async (context, plan, digest) => { kept.push(['preview', plan.policy, digest.length]); return '00000000-0000-4000-8000-000000000001'; },
      createRun: async (context, request, resolved, benchmark, harness, options) => { kept.push(['run', request, resolved.cases.length, benchmark, harness, options]); return {run_id: 'r1', replayed: false}; },
    };
    const publication = benchmarkPublication({...pinned, model: MODEL.model, endpoint_profile: 'openrouter'});
    const source = {source_sha256: 'b'.repeat(64), harness: {name: 'claude-code', version: 'abc', dialects: ['anthropic_messages']}};
    const result = await createBenchmarkService({repository}).session(CONTEXT, publication, source, 'coding', {interactive: true});
    assert.deepEqual(result, {run_id: 'r1', replayed: false});
    assert.deepEqual(kept.slice(0, 2), [['case set', 'u', publication.case_set_digest], ['preview', 'coding', 64]]);
    const [, request, cases, benchmark, harness, options] = kept[2];
    assert.deepEqual(options, {session: true, interactive: true}); // a session's run, which the member's results do not list
    assert.deepEqual([request.policy, request.source_sha256, request.preview_id, request.request_digest.length], ['coding', 'b'.repeat(64), '00000000-0000-4000-8000-000000000001', 64]);
    assert.equal(cases, 1);
    assert.deepEqual([benchmark.case_set_id, benchmark.publisher.name, benchmark.plugin.sha256, benchmark.context], [publication.case_set_digest, 'Ada', SHA, 'Add one and two']);
    assert.equal(harness.name, 'claude-code');
  });
});
