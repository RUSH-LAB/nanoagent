import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {strToU8, zipSync} = require('fflate');
const {allowed} = require('../../../src/runner/protocol.js');
const {MODEL} = require('../../../src/server/ai-settings.js');
const {createBenchmarkService} = require('../../../src/server/benchmark/service.js');
const {benchmarkPublication, publicationFrame} = require('../../../src/server/benchmark/validate.js');
const {BenchmarkError} = require('../../../src/server/benchmark/errors.js');
const {TERMINAL_LIMITS} = require('../../../src/server/benchmark/limits.js');
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
/** The case set but its case, which NanoAgent reads from the installed plugin at once. */
const {cases: _cases, private: _private, ...frame} = {...pinned, case_id: 'p-01'};
/** Let the session's pin, which runs after the answer, finish. */
const settled = () => new Promise(resolve => setTimeout(resolve, 10));

function ctxFor({computer, app = {value: {id: 'p', sha256: SHA, status: 'ready', tasks: [{id: 'sum', description: 'Add two numbers'}, {id: 'other', description: 'o'}]}}} = {}) {
  const calls = [];
  const on = computer ?? {
    benchmarkSessionFrame: async (sha, bodyText) => { calls.push(['frame', sha, JSON.parse(bodyText)]); return {value: JSON.stringify(frame)}; },
    benchmarkSession: async (sha, bodyText) => { calls.push(['pin', sha, JSON.parse(bodyText)]); return {value: JSON.stringify(pinned)}; },
    benchmarkReferenceHarness: async name => { calls.push(['build', name]); return {value: referenceZip(name)}; },
  };
  const ctx = makeCtx({
    benchmark: {
      service: {
        session: async (context, sessionFrame, source, policy, options) => { calls.push(['session', sessionFrame, source, policy, options]); return {run_id: 'r1', attempt_id: 'a1', session: {run_id: 'r1'}}; },
        pinSession: async (context, session, publication) => { calls.push(['pinned', session, publication]); },
      },
      repository: {
        saveSource: async (context, data, harness) => ({source_sha256: 'b'.repeat(64), size: data.length, harness}),
        run: async (context, id) => ({run_id: id}),
        savedHarness: async (context, name) => (name === 'my-agent' ? SAVED : null),
        liveTerminal: async () => null,
        failSessionCase: async (context, runId, caseId, error) => { calls.push(['failed', runId, caseId, error]); },
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
  it('queues the run on its case set\'s frame at once, then has the member\'s computer fill the task\'s input with the model every run uses and pin it', async () => {
    const {ctx, calls} = ctxFor();
    const {status, payload} = await post(ctx, BODY);
    assert.equal(status, 201);
    assert.deepEqual(payload, {run: {run_id: 'r1'}, attempt_id: 'a1'});
    assert.deepEqual(calls.slice(0, 3), [['open', 'p'], ['frame', SHA, {task: 'sum', text: 'Add one and two'}], ['build', 'claude-code']]);
    const [, queued, source, policy, options] = calls[3];
    assert.deepEqual([queued.model, queued.endpoint_profile, queued.context, queued.case_id, queued.cases], [MODEL.model, 'openrouter', 'Add one and two', 'p-01', undefined]);
    assert.deepEqual([source.harness.name, policy, options], ['claude-code', 'coding', {interactive: true, resumedFrom: null, startCli: null, resumeChat: null}]);
    await settled();
    assert.deepEqual(calls[4], ['pin', SHA, {task: 'sum', text: 'Add one and two', model: MODEL}]);
    const [what, session, publication] = calls[5];
    assert.deepEqual([what, session, publication.cases.length, publication.case_set_digest.length], ['pinned', {run_id: 'r1'}, 1, 64]);
  });

  it('queues a free-form Terminal session with nothing of its plugin opened or read: the plugin\'s id its label, the Terminal\'s limits', async () => {
    const {ctx, calls} = ctxFor();
    const {status, payload} = await post(ctx, {plugin_id: 'p', harness: 'shell', interactive: true});
    assert.equal(status, 201);
    assert.deepEqual(payload, {run: {run_id: 'r1'}, attempt_id: 'a1'});
    assert.deepEqual(calls.map(([what]) => what), ['build', 'session']);
    const queued = calls[1][1];
    assert.deepEqual([queued.plugin_id, queued.package_sha256, queued.task_id, queued.task, queued.case_id, queued.limits], ['p', null, null, null, null, TERMINAL_LIMITS]);
    await settled();
    assert.ok(!calls.some(([what]) => what === 'pin'));
    for (const extra of [{text: 'hi'}, {task_id: 'sum'}]) assert.equal((await post(ctx, {plugin_id: 'p', harness: 'shell', interactive: true, ...extra})).status, 400);
  });

  it('gives the member\'s free-form session on the plugin that still runs, not a new one, when it is shown again; resume and start still start one', async () => {
    const {ctx, calls} = ctxFor();
    const asked = [];
    ctx.benchmark.repository.liveTerminal = async (context, pluginId) => { asked.push(pluginId); return {run_id: 'live', attempt_id: 'a-live'}; };
    const {status, payload} = await post(ctx, {plugin_id: 'p', harness: 'shell', interactive: true});
    assert.deepEqual([status, payload, asked, calls], [201, {run: {run_id: 'live'}, attempt_id: 'a-live'}, ['p'], []]);
    assert.equal((await post(ctx, {plugin_id: 'p', harness: 'shell', interactive: true, start: 'codex'})).status, 201);
    assert.deepEqual([asked, calls.find(([what]) => what === 'session')[4].startCli], [['p'], 'codex']);
  });

  it('resumes an ended free-form Terminal session of the member\'s as a new session linked to it, and no other', async () => {
    const OLD = '11111111-1111-4111-8111-111111111111';
    const rows = {
      [OLD]: {attempt_id: OLD, harness_name: 'shell', task_id: null, state: 'final'},
      '22222222-2222-4222-8222-222222222222': {attempt_id: '22222222-2222-4222-8222-222222222222', harness_name: 'shell', task_id: null, state: 'leased'},
      '33333333-3333-4333-8333-333333333333': {attempt_id: '33333333-3333-4333-8333-333333333333', harness_name: 'claude-code', task_id: 'sum', state: 'final'},
    };
    const {ctx, calls} = ctxFor();
    ctx.benchmark.repository.terminalRows = async (context, {attemptId}) => (rows[attemptId] ? [rows[attemptId]] : []);
    const body = resume => ({plugin_id: 'p', harness: 'shell', interactive: true, resume});
    assert.equal((await post(ctx, body(OLD))).status, 201);
    assert.deepEqual(calls.find(([what]) => what === 'session')[4], {interactive: true, resumedFrom: OLD, startCli: null, resumeChat: null});
    const refused = async (resume, extra = {}) => {
      const {status, payload} = await post(ctx, {...body(resume), ...extra});
      return [status, payload.code];
    };
    assert.deepEqual(await refused('22222222-2222-4222-8222-222222222222'), [409, 'session_running']);
    for (const other of ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'not-an-id']) assert.deepEqual(await refused(other), [404, 'unknown_session']);
    assert.deepEqual(await refused(OLD, {harness: 'claude-code', task_id: 'sum', text: 'hi'}), [400, 'invalid_request']);
  });

  it('resumes an ended session for one of its chats, which its first terminal reopens, and for no chat it did not hold', async () => {
    const OLD = '11111111-1111-4111-8111-111111111111';
    const chat = {agent: 'claude', id: 'aaaa', title: 'say ok', started_at: '2026-11-18T00:00:00Z', ended_at: '2026-11-18T00:00:05Z', started_ns: '1', ended_ns: '5'};
    const row = {attempt_id: OLD, harness_name: 'shell', task_id: null, state: 'final', calls: [], processes: [], costs: {}, chats: [chat]};
    const {ctx, calls} = ctxFor();
    ctx.benchmark.repository.terminalRows = async () => [row];
    const body = extra => ({plugin_id: 'p', harness: 'shell', interactive: true, resume: OLD, ...extra});
    assert.equal((await post(ctx, body({chat: {agent: 'claude', id: 'aaaa'}}))).status, 201);
    assert.deepEqual(calls.find(([what]) => what === 'session')[4].resumeChat, {agent: 'claude', id: 'aaaa'});
    const status = async extra => (await post(ctx, body(extra))).status;
    assert.deepEqual(
      [await status({chat: {agent: 'claude', id: 'bbbb'}}), await status({chat: {agent: 'claude', id: '$(rm -rf /)'}}), await status({chat: {agent: 'claude', id: 'aaaa'}, resume: undefined})],
      [404, 400, 400],
    );
  });

  it('starts a new free-form Terminal session running an agent\'s CLI, and no other', async () => {
    const {ctx, calls} = ctxFor();
    const body = {plugin_id: 'p', harness: 'shell', interactive: true, start: 'claude'};
    assert.equal((await post(ctx, body)).status, 201);
    assert.deepEqual(calls.find(([what]) => what === 'session')[4], {interactive: true, resumedFrom: null, startCli: 'claude', resumeChat: null});
    for (const extra of [{start: 'claude; rm -rf /'}, {start: ''}, {interactive: false}, {harness: 'claude-code', task_id: 'sum', text: 'hi'}]) {
      assert.equal((await post(ctx, {...body, ...extra})).status, 400);
    }
  });

  it('takes the harness\'s model and whether the member is at its terminal from the request', async () => {
    const {ctx, calls} = ctxFor();
    await post(ctx, {...BODY, interactive: false, model: 'openai/gpt-5.5'});
    assert.deepEqual([calls[3][1].model, calls[3][4]], ['openai/gpt-5.5', {interactive: false, resumedFrom: null, startCli: null, resumeChat: null}]);
    await settled();
    assert.deepEqual(calls[4][2].model, MODEL); // the case is pinned with the model every run uses
    assert.equal((await post(ctxFor().ctx, {...BODY, interactive: undefined})).status, 400);
  });

  it('works RUSH\'s own harness with the task\'s tools', async () => {
    const {ctx, calls} = ctxFor();
    await post(ctx, {...BODY, harness: 'nanoagent'});
    assert.equal(calls[3][3], 'task_tools');
  });

  it('refuses a harness that is no reference harness, a missing field and an unknown task, and keeps why a pin failed for the worker', async () => {
    assert.deepEqual((await post(ctxFor().ctx, {...BODY, harness: 'mine'})).payload.code, 'unknown_harness');
    assert.equal((await post(ctxFor().ctx, {...BODY, text: ''})).status, 400);
    const unknown = ctxFor({computer: {benchmarkSessionFrame: async () => ({error: 'p has an unknown task: nope', status: 422})}});
    const refused = await post(unknown.ctx, BODY);
    assert.deepEqual([refused.status, refused.payload.code, refused.payload.error], [422, 'pin_failed', 'p has an unknown task: nope']);
    const failing = ctxFor();
    const on = {
      benchmarkSessionFrame: async () => ({value: JSON.stringify(frame)}), benchmarkReferenceHarness: async name => ({value: referenceZip(name)}),
      benchmarkSession: async () => ({error: 'the model could not make task sum\'s input', status: 422}),
    };
    failing.ctx.runners.computer = () => on;
    assert.equal((await post(failing.ctx, BODY)).status, 201); // queued before the pin fails
    await settled();
    assert.deepEqual(failing.calls.at(-1), ['failed', 'r1', 'p-01', 'the model could not make task sum\'s input']);
  });

  it('reruns a harness the member saved from a Terminal session, its latest version under the coding prompt, with nothing to build', async () => {
    const {ctx, calls} = ctxFor();
    assert.equal((await post(ctx, {...BODY, harness: 'my-agent'})).status, 201);
    await settled();
    assert.deepEqual(calls.map(([what]) => what), ['open', 'frame', 'session', 'pin', 'pinned']);
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
    assert.ok(allowed('POST', `/v1/installs/${SHA}/benchmark/session-frame`));
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
        terminalSession: async (userId, attemptId, fence) => {
          if (!session) throw new BenchmarkError(403, 'not_a_session', 'Only a session someone works in saves a harness');
          return userId === 'u' && attemptId === ATTEMPT && fence === 3 ? {workspaceId: 'w'} : null;
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

describe('`rush score`: POST /api/benchmark-worker/attempts/{id}/score and GET .../score/{attempt}', () => {
  const ATTEMPT = '00000000-0000-4000-8000-000000000009';
  const SCORED = '00000000-0000-4000-8000-00000000000a';
  const scoring = () => {
    const {ctx, calls} = ctxFor();
    ctx.benchmark.worker = {
      authenticate: async bearer => (bearer === 'cred' ? 'u' : null),
      terminalSession: async (userId, attemptId, fence) => {
        assert.deepEqual([userId, attemptId, fence], ['u', ATTEMPT, 3]);
        return {workspaceId: 'w', pluginId: 'p'};
      },
    };
    ctx.benchmark.repository.attempt = async (context, id) => (id === SCORED ? {attempt_id: id, sealed: true, verdict: 'pass'} : null);
    ctx.benchmark.repository.accounting = async () => ({totals: {calls: 2, settled_usd: 0.011}});
    return {ctx, calls};
  };

  it('works the member\'s saved harness once on the first task of the session\'s plugin, as the one-shot `nanoagent harness` does, the task\'s description its request', async () => {
    const {ctx, calls} = scoring();
    const started = await invoke(workerRoute, {
      method: 'POST', path: `/api/benchmark-worker/attempts/${ATTEMPT}/score`, headers: {authorization: 'Bearer cred'}, body: {fence: 3, harness: 'my-agent'}, ctx, auth: null,
    });
    assert.deepEqual([started.status, started.payload], [201, {run: {run_id: 'r1'}, attempt_id: 'a1'}]);
    await settled();
    assert.deepEqual(calls.map(([what]) => what), ['open', 'open', 'frame', 'session', 'pin', 'pinned']);
    assert.deepEqual([calls[2][2], calls[3][2], calls[3][3], calls[3][4]], [{task: 'sum', text: 'Add two numbers'}, SAVED, 'coding', {interactive: false, resumedFrom: null, startCli: null, resumeChat: null}]);
  });

  it('reads how the scored attempt went, and what its calls cost', async () => {
    const {ctx} = scoring();
    const read = await invoke(workerRoute, {
      method: 'GET', path: `/api/benchmark-worker/attempts/${ATTEMPT}/score/${SCORED}`, headers: {authorization: 'Bearer cred', 'x-rush-fence': '3'}, ctx, auth: null,
    });
    assert.deepEqual([read.status, read.payload], [200, {attempt: {attempt_id: SCORED, sealed: true, verdict: 'pass'}, totals: {calls: 2, settled_usd: 0.011}}]);
  });

  // The member's computer, its plugin installed as the sha256 of `kept`, and the package it serves for that install, `served`.
  const installedAs = (kept, served) => {
    const {ctx, calls} = scoring();
    const sha = createHash('sha256').update(kept).digest('hex');
    const on = ctx.runners.computer();
    on.benchmarkSessionFrame = async (at, bodyText) => { calls.push(['frame', at, JSON.parse(bodyText)]); return {value: JSON.stringify({...frame, package_sha256: sha})}; };
    on.installedPackage = async at => { calls.push(['package', at]); return {value: Buffer.from(served)}; };
    const tools = () => invoke(workerRoute, {
      method: 'POST', path: `/api/benchmark-worker/attempts/${ATTEMPT}/tools`, headers: {authorization: 'Bearer cred'}, body: {fence: 3}, ctx, auth: null,
    });
    return {tools, calls, sha};
  };

  it('opens the first task of the session\'s plugin, with the package installed on the member\'s computer, for the session\'s `nanoagent`', async () => {
    const {tools, calls, sha} = installedAs('zip', 'zip');
    const opened = await tools();
    assert.deepEqual([opened.status, opened.payload], [200, {
      plugin: {id: 'p', name: 'P', version: '1.0.0', sha256: sha}, task: {id: 'sum', plugin_name: 'P', ...pinned.task}, package: Buffer.from('zip').toString('base64'),
    }]);
    assert.deepEqual(calls.filter(([what]) => what !== 'open'), [['frame', SHA, {task: 'sum', text: 'Add two numbers'}], ['package', sha]]);
  });

  it('refuses a package that is not the version installed', async () => {
    const opened = await installedAs('zip', 'other').tools();
    assert.deepEqual([opened.status, opened.payload.code], [502, 'package_unavailable']);
  });
});

describe('a session\'s run', () => {
  const capabilities = {models: [MODEL.model], max_cost_usd: 100, wall_time_ms: 10_000_000, max_model_calls: 10_000, max_output_tokens_per_call: 100_000,
    cpus: 8, memory_mb: 64_000, pids: 10_000, workspace_bytes: 1e12, workspace_files: 1e9, tmp_bytes: 1e12, build_wall_ms: 1e9, build_memory_mb: 64_000,
    build_output_bytes: 1e12, build_files: 1e9, build_tmp_bytes: 1e12, internet_access: true};

  it('is queued on its frame before its case is known, a run of a benchmark nobody publishes, and pinned like any run once it is', async () => {
    const kept = [];
    const repository = {
      publisher: async userId => ({id: userId, name: 'Ada', github: null}),
      saveCaseSet: async (userId, publication) => { kept.push(['case set', userId, publication.case_set_digest]); return {id: userId, name: 'Ada', github: null}; },
      capabilities: async () => capabilities,
      savePreview: async (context, plan, digest, id) => { kept.push(['preview', plan.cases.length, digest.length, id]); return id; },
      createRun: async (context, request, resolved, benchmark, harness, options) => { kept.push(['run', request, resolved, benchmark, harness, options]); return {run_id: 'r1', replayed: false}; },
      pinSessionCase: async (context, runId, benchmark, c) => { kept.push(['pin', runId, benchmark.case_set_id, c]); },
    };
    const service = createBenchmarkService({repository});
    const sessionFrame = {...publicationFrame({...frame, model: MODEL.model, endpoint_profile: 'openrouter'}), case_id: 'p-01'};
    const source = {source_sha256: 'b'.repeat(64), harness: {name: 'shell', version: 'abc', dialects: ['anthropic_messages']}};
    const {run_id: runId, session} = await service.session(CONTEXT, sessionFrame, source, 'coding', {interactive: true});
    assert.equal(runId, 'r1');
    const [, request, resolved, benchmark, harness, options] = kept[0];
    assert.deepEqual(options, {session: true, interactive: true, free: false, resumedFrom: null, startCli: null, resumeChat: null}); // a session's run, which the member's results do not list
    assert.deepEqual([request.policy, request.source_sha256, request.request_digest.length], ['coding', 'b'.repeat(64), 64]);
    assert.deepEqual(resolved.cases, [{case_id: 'p-01', position: 0, kind: 'answer', arguments: null, expected_error: null, content_digest: null, prompt: null}]);
    assert.deepEqual([benchmark.case_set_id, benchmark.publisher.name, benchmark.plugin.sha256, benchmark.context, harness.name], [null, 'Ada', SHA, 'Add one and two', 'shell']);
    const publication = benchmarkPublication({...pinned, model: MODEL.model, endpoint_profile: 'openrouter'});
    await service.pinSession(CONTEXT, session, publication);
    assert.deepEqual(kept.slice(1, 3), [['case set', 'u', publication.case_set_digest], ['preview', 1, 64, request.preview_id]]);
    const [, pinnedRun, caseSetId, c] = kept[3];
    assert.deepEqual([pinnedRun, caseSetId, c.case_id, c.arguments, c.prompt.sha256.length], ['r1', publication.case_set_digest, 'p-01', {x: 1, y: 2}, 64]);
  });

  it('is never pinned to a case set whose frame differs from the one it was queued on', async () => {
    const repository = {publisher: async () => ({}), capabilities: async () => capabilities, createRun: async () => ({run_id: 'r1'}), saveCaseSet: async () => assert.fail('must not keep it')};
    const service = createBenchmarkService({repository});
    const sessionFrame = {...publicationFrame({...frame, model: MODEL.model, endpoint_profile: 'openrouter'}), case_id: 'p-01'};
    const {session} = await service.session(CONTEXT, sessionFrame, {source_sha256: 'b'.repeat(64), harness: {name: 'shell', version: 'a', dialects: ['responses']}}, 'coding', {interactive: true});
    const other = benchmarkPublication({...pinned, context: 'Something else', model: MODEL.model, endpoint_profile: 'openrouter'});
    await assert.rejects(service.pinSession(CONTEXT, session, other), error => error.code === 'case_mismatch' && /context/.test(error.message));
  });
});

describe('the worker\'s wait for work and for a session\'s case', () => {
  const {wake} = require('../../../src/server/benchmark/wake.js');
  const ATTEMPT = '00000000-0000-4000-8000-000000000009';
  const CAPS = {wall_time_ms: 1, max_model_calls: 1, max_output_tokens_per_call: 1, max_cost_usd: 1, cpus: 1, memory_mb: 1, pids: 1, workspace_bytes: 1,
    workspace_files: 1, tmp_bytes: 1, build_wall_ms: 1, build_memory_mb: 1, build_output_bytes: 1, build_files: 1, build_tmp_bytes: 1, internet_access: false, models: ['m']};
  const call = (worker, req) => invoke(workerRoute, {
    ...req, headers: {authorization: 'Bearer cred', 'x-rush-fence': '1', ...req.headers}, auth: null,
    ctx: makeCtx({benchmark: {worker: {authenticate: async () => 'u', ...worker}}}),
  });

  it('holds a claim with nothing queued until the member\'s work is, and answers it then', async () => {
    let queued = null;
    const started = Date.now();
    setTimeout(() => { queued = {kind: 'attempt', attempt_id: ATTEMPT}; wake('claim:u'); }, 50);
    const {status, payload} = await call({claim: async () => queued}, {
      method: 'POST', path: '/api/benchmark-worker/claim', body: {worker_id: 'w', endpoint_profile: {label: 'l', mode: 'm'}, capabilities: CAPS, interactive: false, wait_s: 5},
    });
    assert.deepEqual([status, payload.attempt_id], [200, ATTEMPT]);
    assert.ok(Date.now() - started < 1000);
    const idle = await call({claim: async () => null}, {method: 'POST', path: '/api/benchmark-worker/claim', body: {worker_id: 'w', endpoint_profile: {label: 'l', mode: 'm'}, capabilities: CAPS, interactive: false}});
    assert.equal(idle.res.written.status, 204); // no wait_s: answered at once
  });

  it('gives a pending case once it is pinned, and why it could not be', async () => {
    let state = {case: null, pin_error: null};
    const pinnedCase = async () => ({run_id: 'r1', created_at: new Date().toISOString(), ...state});
    setTimeout(() => { state = {case: {case_id: 'p-01'}, prompt: {user: 'u'}, case_set: null, private_reference: null}; wake('case:r1'); }, 50);
    const got = await call({pinnedCase}, {method: 'GET', path: `/api/benchmark-worker/attempts/${ATTEMPT}/case`});
    assert.deepEqual([got.status, got.payload.case, got.payload.run_id], [200, {case_id: 'p-01'}, undefined]);
    state = {case: null, pin_error: 'no input'};
    const failed = await call({pinnedCase}, {method: 'GET', path: `/api/benchmark-worker/attempts/${ATTEMPT}/case`});
    assert.deepEqual([failed.status, failed.payload.code, failed.payload.error], [422, 'case_failed', 'no input']);
  });
});
