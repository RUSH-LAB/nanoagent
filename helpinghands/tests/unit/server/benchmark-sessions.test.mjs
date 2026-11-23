import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {allowed} = require('../../../src/runner/protocol.js');
const {MODEL} = require('../../../src/server/ai-settings.js');
const {createBenchmarkService} = require('../../../src/server/benchmark/service.js');
const {TERMINAL_LIMITS} = require('../../../src/server/benchmark/limits.js');
const route = loadRoute('benchmark');
const workerRoute = require('../../../src/server/routes/benchmark-worker.js');
const CONTEXT = {userId: 'u', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const SHA = 'a'.repeat(64);
const PATH = '/api/benchmark/sessions';

/** The plugin frame NanoAgent reads from the installed plugin for a Terminal session's `nanoagent`. */
const frame = {
  name: 'harness-session', plugin_id: 'p', plugin_name: 'P', version: '1.0.0', package_sha256: SHA, task_id: 'sum',
  task: {kind: 'agent', description: 'd', input_schema: {}, output_schema: {}, tools: [], egress_hosts: []},
};

function ctxFor({computer, app = {value: {id: 'p', sha256: SHA, status: 'ready', tasks: [{id: 'sum', description: 'Add two numbers'}, {id: 'other', description: 'o'}]}}} = {}) {
  const calls = [];
  const on = computer ?? {
    benchmarkSessionFrame: async (sha, bodyText) => { calls.push(['frame', sha, JSON.parse(bodyText)]); return {value: JSON.stringify({...frame, case_id: 'p-01'})}; },
  };
  const ctx = makeCtx({
    benchmark: {
      service: {
        session: async (context, sessionFrame, options) => { calls.push(['session', sessionFrame, options]); return {run_id: 'r1', attempt_id: 'a1'}; },
      },
      repository: {
        run: async (context, id) => ({run_id: id}),
        liveSession: async () => null,
      },
    },
    runners: {computer: () => on},
    workspaceApps: {open: async (context, id) => { calls.push(['open', id]); return app; }},
  });
  return {ctx, calls};
}

const post = (ctx, body) => invoke(route, {method: 'POST', path: PATH, body, requestContext: CONTEXT, ctx});
const BODY = {plugin_id: 'p', harness: 'shell', interactive: true};

describe('POST /api/benchmark/sessions', () => {
  it('queues a free-form Terminal session with nothing of its plugin opened or read: the plugin\'s id its label, the Terminal\'s limits', async () => {
    const {ctx, calls} = ctxFor();
    const {status, payload} = await post(ctx, BODY);
    assert.equal(status, 201);
    assert.deepEqual(payload, {run: {run_id: 'r1'}, attempt_id: 'a1'});
    assert.deepEqual(calls.map(([what]) => what), ['session']);
    const queued = calls[0][1];
    assert.deepEqual(queued, {name: 'harness-session', plugin_id: 'p', model: MODEL.model, endpoint_profile: 'openrouter', limits: TERMINAL_LIMITS});
  });

  it('is only the Terminal with its member at it: a case runs by POST /runs, never by a session', async () => {
    const {ctx, calls} = ctxFor();
    for (const body of [{...BODY, harness: 'claude'}, {...BODY, harness: 'claude-code'}, {...BODY, interactive: false}, {...BODY, harness: 'nanoagent', interactive: false}]) {
      const {status, payload} = await post(ctx, body);
      assert.deepEqual([status, payload.code], [400, 'invalid_request'], JSON.stringify(body));
    }
    assert.deepEqual(calls, []);
  });

  it('gives every free-form start the member\'s live session, on any plugin, as a new terminal of it (joined), never ending it or starting a second', async () => {
    const OLD = '11111111-1111-4111-8111-111111111111';
    const {ctx, calls} = ctxFor();
    ctx.benchmark.repository.liveSession = async () => ({run_id: 'live', attempt_id: 'a-live', free: true});
    ctx.benchmark.repository.terminalRows = async () => [{attempt_id: OLD, harness_name: 'shell', task_id: null, state: 'final', processes: [], calls: [], costs: {}, chats: [{agent: 'claude', id: 'a'}]}];
    const live = {run: {run_id: 'live'}, attempt_id: 'a-live', joined: true};
    for (const body of [{}, {start: 'claude'}, {start: 'codex'}, {resume: OLD, chat: {agent: 'claude', id: 'a', run: null}}]) {
      const {status, payload} = await post(ctx, {plugin_id: 'other', harness: 'shell', interactive: true, ...body});
      assert.deepEqual([status, payload], [201, live], JSON.stringify(body));
    }
    assert.deepEqual(calls, []);
    // A start that cannot be a terminal of it is refused, the live one left running.
    const refused = async body => {
      const {status, payload} = await post(ctx, body);
      return [status, payload.code];
    };
    assert.deepEqual(await refused({plugin_id: 'p', harness: 'shell', interactive: true, resume: OLD}), [409, 'session_running']);
    assert.deepEqual(calls, []);
    // None live: a new session runs what was asked in its first terminal.
    ctx.benchmark.repository.liveSession = async () => null;
    assert.deepEqual((await post(ctx, {plugin_id: 'p', harness: 'shell', interactive: true, start: 'claude'})).payload, {run: {run_id: 'r1'}, attempt_id: 'a1'});
    assert.equal(calls.find(([what]) => what === 'session')[2].startCli, 'claude');
  });

  it('resumes an ended free-form Terminal session of the member\'s as a new session linked to it, and no other', async () => {
    const OLD = '11111111-1111-4111-8111-111111111111';
    const rows = {
      [OLD]: {attempt_id: OLD, harness_name: 'shell', task_id: null, state: 'final'},
      '22222222-2222-4222-8222-222222222222': {attempt_id: '22222222-2222-4222-8222-222222222222', harness_name: 'shell', task_id: null, state: 'leased'},
      '33333333-3333-4333-8333-333333333333': {attempt_id: '33333333-3333-4333-8333-333333333333', harness_name: 'claude', task_id: 'sum', state: 'final'},
    };
    const {ctx, calls} = ctxFor();
    ctx.benchmark.repository.terminalRows = async (context, {attemptId}) => (rows[attemptId] ? [rows[attemptId]] : []);
    const body = resume => ({plugin_id: 'p', harness: 'shell', interactive: true, resume});
    assert.equal((await post(ctx, body(OLD))).status, 201);
    assert.deepEqual(calls.find(([what]) => what === 'session')[2], {interactive: true, resumedFrom: OLD, startCli: null, resumeChat: null});
    const refused = async (resume, extra = {}) => {
      const {status, payload} = await post(ctx, {...body(resume), ...extra});
      return [status, payload.code];
    };
    assert.deepEqual(await refused('22222222-2222-4222-8222-222222222222'), [409, 'session_running']);
    for (const other of ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'not-an-id']) assert.deepEqual(await refused(other), [404, 'unknown_session']);
    assert.deepEqual(await refused(OLD, {harness: 'claude'}), [400, 'invalid_request']);
  });

  it('resumes an ended session for one of its chats, which its first terminal reopens, and for no chat it did not hold', async () => {
    const OLD = '11111111-1111-4111-8111-111111111111';
    const chat = {agent: 'claude', id: 'aaaa', title: 'say ok', started_at: '2026-11-18T00:00:00Z', ended_at: '2026-11-18T00:00:05Z', started_ns: '1', ended_ns: '5'};
    const aider = {span_id: 'p:1', parent_id: 'process-tree', argv: ['python', '/harness/rush.py', 'run', 'aider', '--yes'], cwd: '/rush/workspace', start_ns: '10', end_ns: '20'};
    const row = {
      attempt_id: OLD, harness_name: 'shell', task_id: null, state: 'final', calls: [{call_id: 'c1', status: 'ok', start_ns: '12', end_ns: '13', prompt: 'hi'}],
      processes: [aider], costs: {}, chats: [chat],
    };
    const {ctx, calls} = ctxFor();
    ctx.benchmark.repository.terminalRows = async () => [row];
    const body = extra => ({plugin_id: 'p', harness: 'shell', interactive: true, resume: OLD, ...extra});
    assert.equal((await post(ctx, body({chat: {agent: 'claude', id: 'aaaa', run: null}}))).status, 201);
    assert.deepEqual(calls.find(([what]) => what === 'session')[2].resumeChat, {agent: 'claude', id: 'aaaa', run: null});
    const run = {argv: ['rush', 'aider', '--yes'], cwd: '/rush/workspace'};  // a `rush <command>` run, which its first terminal reruns
    assert.equal((await post(ctx, body({chat: {agent: 'aider', id: null, run}}))).status, 201);
    assert.deepEqual(calls.filter(([what]) => what === 'session').at(-1)[2].resumeChat, {agent: 'aider', id: null, run});
    const status = async extra => (await post(ctx, body(extra))).status;
    assert.deepEqual(
      [await status({chat: {agent: 'claude', id: 'bbbb', run: null}}), await status({chat: {agent: 'aider', id: null, run: {...run, argv: ['rm', '-rf', '/']}}}),
        await status({chat: {agent: 'claude', id: '$(rm -rf /)', run: null}}), await status({chat: {agent: 'aider', id: null, run: null}}),
        await status({chat: {agent: 'claude', id: 'aaaa', run: null}, resume: undefined})],
      [404, 404, 400, 400, 400],
    );
  });

  it('starts a new free-form Terminal session running an agent\'s CLI, and no other', async () => {
    const {ctx, calls} = ctxFor();
    const body = {plugin_id: 'p', harness: 'shell', interactive: true, start: 'claude'};
    assert.equal((await post(ctx, body)).status, 201);
    assert.deepEqual(calls.find(([what]) => what === 'session')[2], {interactive: true, resumedFrom: null, startCli: 'claude', resumeChat: null});
    for (const extra of [{start: 'claude; rm -rf /'}, {start: ''}, {interactive: false}, {harness: 'claude'}]) {
      assert.equal((await post(ctx, {...body, ...extra})).status, 400);
    }
  });

  it('takes the session\'s model from the request', async () => {
    const {ctx, calls} = ctxFor();
    await post(ctx, {...BODY, model: 'openai/gpt-5.5'});
    assert.equal(calls[0][1].model, 'openai/gpt-5.5');
    assert.equal((await post(ctxFor().ctx, {...BODY, interactive: undefined})).status, 400);
  });

  it('runs only on the member\'s own computer', async () => {
    const offline = makeCtx({benchmark: {repository: {liveSession: async () => null}, service: {}}, runners: {computer: () => null}});
    assert.equal((await post(offline, BODY)).status, 503);
  });

  it('is a plugin frame request the relay lets through to NanoAgent, and no longer a case pin or a harness build', () => {
    assert.ok(allowed('POST', `/v1/installs/${SHA}/benchmark/session-frame`));
    assert.ok(!allowed('POST', `/v1/installs/${SHA}/benchmark/session`));
    assert.ok(!allowed('GET', '/v1/benchmark/reference-harnesses/claude-code'));
  });
});

describe('a Terminal session\'s plugin: POST /api/benchmark-worker/attempts/{id}/tools', () => {
  const ATTEMPT = '00000000-0000-4000-8000-000000000009';
  const scoring = () => {
    const {ctx, calls} = ctxFor();
    ctx.benchmark.worker = {
      authenticate: async bearer => (bearer === 'cred' ? 'u' : null),
      terminalSession: async (userId, attemptId, fence) => {
        assert.deepEqual([userId, attemptId, fence], ['u', ATTEMPT, 3]);
        return {workspaceId: 'w', pluginId: 'p'};
      },
    };
    return {ctx, calls};
  };

  // The member's computer, its plugin installed as the sha256 of `kept`, and the package it serves for that install, `served`.
  const installedAs = (kept, served) => {
    const {ctx, calls} = scoring();
    const sha = createHash('sha256').update(kept).digest('hex');
    const on = ctx.runners.computer();
    on.benchmarkSessionFrame = async (at, bodyText) => { calls.push(['frame', at, JSON.parse(bodyText)]); return {value: JSON.stringify({...frame, case_id: 'p-01', package_sha256: sha})}; };
    on.installedPackage = async at => { calls.push(['package', at]); return {value: Buffer.from(served)}; };
    const ask = part => () => invoke(workerRoute, {
      method: 'POST', path: `/api/benchmark-worker/attempts/${ATTEMPT}/${part}`, headers: {authorization: 'Bearer cred'}, body: {fence: 3}, ctx, auth: null,
    });
    return {tools: ask('tools'), score: ask('score'), calls, sha};
  };

  it('opens the first task of the session\'s plugin, with the package installed on the member\'s computer, for the session\'s `nanoagent`', async () => {
    const {tools, calls, sha} = installedAs('zip', 'zip');
    const opened = await tools();
    assert.deepEqual([opened.status, opened.payload], [200, {
      plugin: {id: 'p', name: 'P', version: '1.0.0', sha256: sha}, task: {id: 'sum', plugin_name: 'P', ...frame.task}, package: Buffer.from('zip').toString('base64'),
    }]);
    assert.deepEqual(calls.filter(([what]) => what !== 'open'), [['frame', SHA, {task: 'sum', text: 'Add two numbers'}], ['package', sha]]);
  });

  it('has no score route: nothing in a Terminal session is scored', async () => {
    const {score} = installedAs('zip', 'zip');
    assert.equal((await score()).status, 404);
  });

  it('refuses a package that is not the version installed', async () => {
    const opened = await installedAs('zip', 'other').tools();
    assert.deepEqual([opened.status, opened.payload.code], [502, 'package_unavailable']);
  });
});

describe('a free-form session\'s run', () => {
  const capabilities = {models: [MODEL.model], max_cost_usd: 100, wall_time_ms: 10_000_000, max_model_calls: 10_000, max_output_tokens_per_call: 100_000,
    cpus: 8, memory_mb: 64_000, pids: 10_000, workspace_bytes: 1e12, workspace_files: 1e9, tmp_bytes: 1e12, build_wall_ms: 1e9, build_memory_mb: 64_000,
    build_output_bytes: 1e12, build_files: 1e9, build_tmp_bytes: 1e12, internet_access: true};

  it('is queued at once as a run of a benchmark nobody publishes, of the shell, with no case and no plugin version', async () => {
    const kept = [];
    const repository = {
      publisher: async userId => ({id: userId, name: 'Ada', github: null}),
      capabilities: async () => capabilities,
      createRun: async (context, request, resolved, benchmark, options) => { kept.push([request, resolved, benchmark, options]); return {run_id: 'r1', attempt_id: 'a1', replayed: false}; },
    };
    const service = createBenchmarkService({repository});
    const sessionFrame = {name: 'harness-session', plugin_id: 'p', model: MODEL.model, endpoint_profile: 'openrouter', limits: TERMINAL_LIMITS};
    assert.deepEqual(await service.session(CONTEXT, sessionFrame, {interactive: true}), {run_id: 'r1', attempt_id: 'a1'});
    const [request, resolved, benchmark, options] = kept[0];
    assert.deepEqual(options, {session: true, interactive: true, free: true, resumedFrom: null, startCli: null, resumeChat: null}); // a session's run, which the member's results do not list
    assert.deepEqual([request.harness, request.request_digest.length], ['shell', 64]);
    assert.deepEqual(resolved, {cases: [], limits: TERMINAL_LIMITS});
    assert.deepEqual([benchmark.case_set_id, benchmark.publisher.name, benchmark.plugin, benchmark.task], [null, 'Ada', {id: 'p', name: null, version: null, sha256: null}, null]);
  });
});

describe('the worker\'s wait for work', () => {
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

  it('has no case route: a claim carries its case', async () => {
    const got = await call({}, {method: 'GET', path: `/api/benchmark-worker/attempts/${ATTEMPT}/case`});
    assert.equal(got.status, 404);
  });
});
