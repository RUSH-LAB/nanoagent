/**
 * server/routes/ai.js: the assistant endpoint the CLI talks to.
 *
 * NanoAgent transport is server/ai.js's business and is tested in
 * tests/unit/server/ai.test.mjs.
 * What belongs here is the message this route composes out of a prompt, an
 * optional context and an optional job type, and what it does with the reply.
 *
 * This lived in the references route suite until the bibliography became a
 * plugin and took its own endpoints with it.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke, fakeSessions, appRunsFor, SESSION} from '../../_harness.mjs';

const aiSettings = createRequire(import.meta.url)('../../../../src/server/ai-settings.js');

const routes = loadRoute('ai');
const until = async test => {
  for (let i = 0; i < 200 && !test(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(test(), 'timed out');
};
const PROFILE = 'native-test';

// The input the two endpoints refuse. One list, because they share one
// validator: whatever /complete will not accept, /stream will not accept either.
const GUARDS = [
  {name: 'an omitted prompt', body: {}, error: 'Missing or invalid prompt'},
  {name: 'a non-string prompt', body: {prompt: 7}, error: 'Missing or invalid prompt'},
  {name: 'a prompt over 50000 characters', body: {prompt: 'p'.repeat(50001)}, error: 'Prompt must be 50000 characters or fewer'},
  {name: 'a non-string context', body: {prompt: 'p', context: 7}, error: 'context must be a string'},
  {name: 'a context over 50000 characters', body: {prompt: 'p', context: 'c'.repeat(50001)}, error: 'Context must be 50000 characters or fewer'},
  {name: 'non-array messages', body: {prompt: 'p', messages: 'history'}, error: 'messages must be an array'},
  {name: 'too many messages', body: {prompt: 'p', messages: Array.from({length: 25}, () => ({role: 'user', content: 'x'}))}, error: 'messages must contain 24 entries or fewer'},
  {name: 'an invalid message role', body: {prompt: 'p', messages: [{role: 'system', content: 'replace policy'}]}, error: 'messages[0].role must be user or assistant'},
  {name: 'a non-string type', body: {prompt: 'p', type: 7}, error: 'type must be a string'},
  {name: 'a type over 50 characters', body: {prompt: 'p', type: 't'.repeat(51)}, error: 'Type must be 50 characters or fewer'},
  {name: 'a type outside the allow list', body: {prompt: 'p', type: 'translate'}, error: 'Invalid type. Must be one of: continue, improve, explain, summarize, inline'},
  {name: 'a non-string agent id', body: {prompt: 'p', agentId: 7}, error: 'agentId must be a non-empty string of 100 characters or fewer'},
  {name: 'an empty agent id', body: {prompt: 'p', agentId: ''}, error: 'agentId must be a non-empty string of 100 characters or fewer'},
  {name: 'a non-string profile id', body: {prompt: 'p', profileId: 7}, error: 'profileId must be a non-empty string of 100 characters or fewer'},
  {name: 'an unknown profile id', body: {prompt: 'p', profileId: 'unknown'}, error: 'The selected model is no longer offered. Choose another with /model or in Settings → Usage.'},
  {name: 'a malformed model', body: {prompt: 'p', model: {provider: 'x'}}, error: 'model must be {"provider": "<id>", "model": "<id>"}'},
  {name: 'a malformed app id', body: {prompt: 'p', appId: '../runs'}, error: 'appId must be a NanoAgent plugin id'},
  {name: 'an app id with a profile', body: {prompt: 'p', appId: 'echo', profileId: PROFILE}, error: 'appId cannot be combined with type, agentId, profileId or model'},
];

const WORKSPACE = {workspaceId: 'test-org', userId: 'test-user', membershipId: 'member-1', role: 'owner'};
const settings = value => aiSettings.normalize(value).value;

async function putAgent(ctx, agent) {
  await ctx.collection('agents').put(ctx.storageScope(WORKSPACE), agent.id, agent);
}

describe('POST /api/ai/inline-complete', () => {
  it('uses its own per-user budget and forces the inline instruction', async () => {
    const ctx = makeCtx();
    const result = await invoke(routes, {
      method: 'POST',
      path: '/api/ai/inline-complete',
      body: {prompt: 'A Markdown prefix', type: 'summarize'},
      ctx,
      auth: {userId: 'writer-1'},
    });
    assert.deepEqual([result.status, result.payload], [200, {text: 'a completion'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'ai-inline:writer-1', maxPerMinute: 30}]);
    assert.match(ctx.calls.ai[0].instructions, /inline Markdown completion engine/);
    assert.equal(ctx.calls.ai[0].input, 'A Markdown prefix');
    assert.equal('profile' in ctx.calls.ai[0], false);
  });

  it('runs on the one model, without the member\'s instructions', async () => {
    const ctx = makeCtx();
    ctx.settings = settings({instructions: 'Be terse.'});
    await invoke(routes, {method: 'POST', path: '/api/ai/inline-complete', body: {prompt: 'x'}, ctx, auth: {userId: 'writer-1'}});
    assert.deepEqual(ctx.calls.ai[0].model, {provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731'});
    assert.doesNotMatch(ctx.calls.ai[0].instructions, /Be terse/);
  });

  it('returns its dedicated rate-limit message before reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const result = await invoke(routes, {
      method: 'POST', path: '/api/ai/inline-complete', ctx, auth: {userId: 'writer-1'},
    });
    assert.deepEqual([result.status, result.payload], [429, {error: 'Too many inline completions. Try again in a minute.'}]);
    assert.equal(reads, 0);
  });
});

describe('POST /api/ai/complete', () => {
  const OK = {prompt: 'Write something', type: 'continue'};

  it('returns 429 before reading the body, keyed on the caller address', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'ai-complete:test-user', maxPerMinute: 10}]);
    assert.equal(reads, 0);
  });

  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without troubling the assistant`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.ai, []);
    });
  }

  // Which model answers, and whether over HTTP or through the CLI on this
  // machine, is server/ai.js's business and is tested there. What belongs here
  // is the message this route composes and what it does with the reply.
  it('asks the assistant for the composed message and returns what comes back', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {...OK, context: 'earlier text'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {text: 'a completion'}]);
    assert.equal(ctx.calls.ai.length, 1);
    assert.equal(ctx.calls.ai[0].input, 'Write something');
    assert.deepEqual(ctx.calls.ai[0].messages, [{role: 'user', content: 'Context:\nearlier text'}]);
    assert.ok(ctx.calls.ai[0].instructions.startsWith('You are a writing assistant.'));
    assert.equal('profile' in ctx.calls.ai[0], false);
  });

  it('runs on the one model and the member\'s behaviour, with their own instructions', async () => {
    const ctx = makeCtx();
    ctx.settings = settings({
      behaviour: {thinking: 'high', maxTokens: 500, maxSteps: 3},
      instructions: 'Answer in French.',
    });
    await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {prompt: 'p'}, ctx});
    assert.deepEqual(ctx.calls.ai[0].model, {provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731'});
    assert.equal('profile' in ctx.calls.ai[0], false);
    // Chat takes thinking and output length; steps are for app runs.
    assert.deepEqual(ctx.calls.ai[0].settings, {thinking_level: 'high', max_tokens: 500});
    assert.match(ctx.calls.ai[0].instructions, /The member's own instructions:\nAnswer in French\.$/);
  });

  it('returns the answer accounting fields when NanoAgent provides them', async () => {
    const metrics = {duration_s: 1.2, model_s: 1, tools_s: 0.2, steps: []};
    const ctx = makeCtx({ai: {complete: async () => ({
      text: 'measured', usage: {prompt_tokens: 10, completion_tokens: 2},
      cost: 0.001, metrics, model: 'test-model', harness: 'native', profile: PROFILE,
      stopReason: 'answer',
    })}});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK, ctx});
    assert.deepEqual(r.payload, {
      text: 'measured', usage: {prompt_tokens: 10, completion_tokens: 2},
      cost: 0.001, metrics, model: 'test-model', harness: 'native', profile: PROFILE,
      stopReason: 'answer',
    });
  });

  it('sends the system prompt for the named job', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {prompt: 'p', type: 'summarize'}, ctx});
    assert.ok(ctx.calls.ai[0].instructions.startsWith('You are a summarization assistant.'));
  });

  it('uses a catalog-approved profile override for this chat, over the member\'s Chat model', async () => {
    const ctx = makeCtx();
    ctx.settings = settings({cloud: {chat: {profile: 'native-test'}}});
    await invoke(routes, {
      method: 'POST',
      path: '/api/ai/complete',
      body: {prompt: 'p', profileId: 'pi-test'},
      ctx,
    });
    assert.equal(ctx.calls.ai[0].profile, 'pi-test');
  });

  // The CLI at the foot of the site sends plain questions with no type, and an
  // assistant with no instruction at all answers like a chat product instead of
  // like part of this site.
  it('falls back to the site assistant when no type is given', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {prompt: 'p'}, ctx});
    assert.match(ctx.calls.ai[0].instructions, /assistant built into a personal research site/);
  });

  it('uses workspace agent instructions when an agent is selected', async () => {
    const ctx = makeCtx();
    await putAgent(ctx, {id: 'researcher', name: 'Researcher', instructions: 'Always cite evidence.', profileId: PROFILE});
    await invoke(routes, {
      method: 'POST',
      path: '/api/ai/complete',
      body: {prompt: 'p', agentId: 'researcher'},
      ctx,
      requestContext: WORKSPACE,
    });
    assert.match(ctx.calls.ai[0].instructions, /workspace agent Researcher/);
    assert.match(ctx.calls.ai[0].instructions, /Always cite evidence\./);
    // An agent brings instructions, not a model.
    assert.equal('profile' in ctx.calls.ai[0], false);
    assert.equal('provider' in ctx.calls.ai[0], false);
  });

  it('ignores a legacy stored provider and uses default instructions', async () => {
    const ctx = makeCtx();
    await putAgent(ctx, {id: 'mochi', name: 'Mochi', instructions: '', provider: 'claude-code'});
    await invoke(routes, {
      method: 'POST',
      path: '/api/ai/complete',
      body: {prompt: 'p', agentId: 'mochi'},
      ctx,
      requestContext: WORKSPACE,
    });
    assert.equal('provider' in ctx.calls.ai[0], false);
    assert.match(ctx.calls.ai[0].instructions, /assistant built into a personal research site/);
  });

  it('ignores the profile a stored agent once chose', async () => {
    const ctx = makeCtx();
    await putAgent(ctx, {id: 'stale', name: 'Stale', instructions: '', profileId: 'removed-profile'});
    const result = await invoke(routes, {
      method: 'POST',
      path: '/api/ai/complete',
      body: {prompt: 'p', agentId: 'stale'},
      ctx,
      requestContext: WORKSPACE,
    });
    assert.equal(result.status, 200);
    assert.equal('profile' in ctx.calls.ai[0], false);
    assert.deepEqual(ctx.calls.ai[0].model, {provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731'});
  });

  it('refuses a chat whose model is no longer offered', async () => {
    const ctx = makeCtx();
    const result = await invoke(routes, {
      method: 'POST',
      path: '/api/ai/complete',
      body: {prompt: 'p', profileId: 'removed-profile'},
      ctx,
    });
    assert.equal(result.status, 400);
    assert.match(result.payload.error, /no longer offered/);
    assert.equal(ctx.calls.ai.length, 0);
  });

  it('does not accept an agent id outside the workspace store', async () => {
    const r = await invoke(routes, {
      method: 'POST',
      path: '/api/ai/complete',
      body: {prompt: 'p', agentId: 'missing'},
      ctx: makeCtx(),
      requestContext: WORKSPACE,
    });
    assert.deepEqual([r.status, r.payload], [404, {error: 'Agent not found'}]);
  });

  it('passes a refusal through with the status the assistant chose', async () => {
    const ctx = makeCtx({ai: {complete: async () => ({error: 'No AI provider is available.', status: 503})}});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [503, {error: 'No AI provider is available.'}]);
  });

  it('answers 502 for a refusal that named no status', async () => {
    const ctx = makeCtx({ai: {complete: async () => ({error: 'something went wrong'})}});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK, ctx});
    assert.equal(r.status, 502);
  });

  it('reports the provider at /api/ai/status', async () => {
    const r = await invoke(routes, {path: '/api/ai/status'});
    assert.deepEqual([r.status, r.payload], [200, {available: true, provider: 'nanoagent', model: 'test-model'}]);
  });

  it('returns NanoAgent profiles', async () => {
    const r = await invoke(routes, {path: '/api/ai/profiles'});
    assert.equal(r.status, 200);
    assert.equal(r.payload.defaultProfile, PROFILE);
    assert.equal(r.payload.profiles[0].harness, 'nanoagent');
  });
  for (const [label, readBody] of [
    ['readBody rejects', async () => { throw new Error('bad json'); }],
    ['readBody resolves null', async () => null],
  ]) {
    it(`returns the generic 500 when ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', ctx: makeCtx({readBody})});
      assert.deepEqual([r.status, r.payload], [500, {error: 'AI request failed. Please try again later.'}]);
    });
  }
});

/**
 * The same answer, written as it is composed.
 *
 * This handler is the one place in the codebase that builds its own response
 * head, so what is worth pinning is everything json() would otherwise have done
 * for it: the CORS headers, the framing, and ending the response so the
 * dispatcher knows the request was answered.
 */
describe('POST /api/ai/stream', () => {
  const ask = (opts = {}) => invoke(routes, {method: 'POST', path: '/api/ai/stream', body: {prompt: 'hello'}, ...opts});

  it('streams editor completions with a separate budget and forced inline prompt', async () => {
    const ctx = makeCtx();
    const result = await invoke(routes, {
      method: 'POST',
      path: '/api/ai/inline-stream',
      body: {prompt: 'Markdown at <CURSOR>', type: 'summarize'},
      ctx,
      auth: {userId: 'writer-1'},
    });
    assert.equal(result.res.written.status, 200);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'ai-inline-stream:writer-1', maxPerMinute: 30}]);
    assert.match(ctx.calls.ai[0].instructions, /inline Markdown completion engine/);
    assert.equal('profile' in ctx.calls.ai[0], false);
    assert.equal(result.res.writes.at(-1), 'event: done\ndata: {"text":"a completion"}\n\n');
  });

  // The workspace added one app, arxiv-source, which NanoAgent has installed as SHA.
  const SHA = 'a'.repeat(64);
  const workspaceApps = {
    open: async (_context, id) => (id === 'arxiv-source'
      ? {value: {id, sha256: SHA}}
      : {error: `This workspace has no plugin named ${id}`, status: 404}),
  };

  /** A ctx with the workspace's one app, sessions, and plugin runs. */
  const appCtx = () => {
    const ctx = makeCtx();
    ctx.sessions = fakeSessions();
    ctx.workspaceApps = workspaceApps;
    ctx.appRuns = appRunsFor(ctx);
    return ctx;
  };

  it('sends an app prompt to that app with no profile or site instructions', async () => {
    const ctx = appCtx();
    const stream = ctx.ai.stream;
    const call = {id: 'c1', name: 'download_source', arguments: {arxiv_id: '1706.03762'}, output: '{"folder": "papers/1706.03762"}'};
    ctx.ai.stream = async request => {
      request.onEvent({type: 'reasoning.delta', runId: 'r1', text: 'Find the '});
      request.onEvent({type: 'reasoning.delta', runId: 'r1', text: 'paper.'});
      request.onEvent({type: 'tool.started', runId: 'r1', call: {id: 'c1', name: 'download_source'}});
      request.onEvent({type: 'tool.progress', runId: 'r1', call: {id: 'c1', name: 'download_source'}, event: 'task.tool', data: {name: 'fetch'}});
      request.onEvent({type: 'tool.progress', runId: 'r1', call: {id: 'c1', name: 'download_source'}, event: 'task.delta', data: {kind: 'reasoning', text: 'It is on arXiv.'}});
      request.onEvent({type: 'tool.progress', runId: 'r1', call: {id: 'c1', name: 'download_source'}, event: 'task.delta', data: {kind: 'text', text: 'Saved.'}});
      request.onEvent({type: 'tool.completed', runId: 'r1', call});
      // A call that never ends is not kept.
      request.onEvent({type: 'tool.started', runId: 'r1', call: {id: 'c3', name: 'download_source'}});
      request.onEvent({type: 'reasoning.delta', runId: 'r1', text: 'Again.'});
      request.onEvent({type: 'tool.failed', runId: 'r1', call: {...call, id: 'c2', output: 'arXiv is down'}});
      return stream(request);
    };
    const r = await ask({body: {prompt: 'save 1706.03762', appId: 'arxiv-source', sessionId: SESSION}, ctx, requestContext: WORKSPACE});
    assert.equal(r.res.written.status, 200);
    assert.deepEqual(ctx.calls.ai[0].app, 'arxiv-source');
    assert.equal(ctx.calls.ai[0].install, SHA);
    assert.equal(ctx.calls.ai[0].workspace, 'run-folder');
    // Held by the member's computer across its connections, by the run's id.
    assert.equal(ctx.calls.ai[0].run.resume, false);
    assert.equal('profile' in ctx.calls.ai[0], false);
    assert.equal('instructions' in ctx.calls.ai[0], false);
    // The session keeps the turn with its tool calls and what the agent did on the way, and the call is charged to it.
    assert.deepEqual(ctx.sessions.turns, [{
      pluginId: 'arxiv-source', id: SESSION, prompt: 'save 1706.03762', answer: 'a completion',
      tools: [
        {name: 'download_source', arguments: {arxiv_id: '1706.03762'}, output: '{"folder": "papers/1706.03762"}', isError: false},
        {name: 'download_source', arguments: {arxiv_id: '1706.03762'}, output: 'arXiv is down', isError: true},
      ],
      activity: [
        {kind: 'thought', text: 'Find the paper.'},
        {kind: 'task', name: 'download_source', steps: [{name: 'fetch', isError: false}], thinking: 'It is on arXiv.', text: 'Saved.'},
        {kind: 'thought', text: 'Again.'},
      ],
      error: null,
    }]);
    assert.equal(ctx.calls.aiUsage[0].pluginId, 'arxiv-source');
    assert.equal(ctx.calls.aiUsage[0].sessionId, SESSION);
    // Then the computer lets it go.
    assert.deepEqual(ctx.appRuns.released, [['test-user', ctx.calls.ai[0].run.id]]);
  });

  it('keeps an app run going after its caller leaves, answering one message at a time per session', async () => {
    const ctx = appCtx();
    let connection;
    let finish;
    let aborted = false;
    ctx.ai.stream = ({signal, onDelta}) => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true; });
      onDelta('half an ');
      finish = () => resolve({text: 'half an answer'});
      connection.destroyed = true;
      connection.emit('close');
    });
    const body = {prompt: 'save 1706.03762', appId: 'arxiv-source', sessionId: SESSION};
    const left = await ask({body, ctx, requestContext: WORKSPACE, onRequest: (_req, res) => { connection = res; }});
    assert.equal(left.res.writableEnded, true);
    assert.deepEqual([...ctx.sessions.rows.values()].map(row => row.prompt), ['save 1706.03762']);
    const again = await ask({body, ctx, requestContext: WORKSPACE});
    assert.equal(again.status, 409);
    assert.equal(again.payload.error, 'This session is still answering a message');
    finish();
    await until(() => ctx.sessions.turns.length);
    assert.equal(aborted, false);
    assert.deepEqual(ctx.sessions.turns.map(turn => turn.answer), ['half an answer']);
    assert.equal(ctx.sessions.rows.size, 0);
  });

  it('keeps a failed app run\'s turn, with why', async () => {
    const ctx = appCtx();
    ctx.ai.stream = async () => ({error: 'Mochi Lab disconnected, and was not back within 10 minutes', status: 503});
    const r = await ask({body: {prompt: 'save 1706.03762', appId: 'arxiv-source', sessionId: SESSION}, ctx, requestContext: WORKSPACE});
    assert.match(r.res.writes.join(''), /event: error\ndata: \{"error":"Mochi Lab disconnected, and was not back within 10 minutes","status":503\}/);
    assert.deepEqual(ctx.sessions.turns.map(({answer, error}) => ({answer, error})), [{answer: '', error: 'Mochi Lab disconnected, and was not back within 10 minutes'}]);
  });

  it('runs an app prompt only in one of the caller\'s sessions with it', async () => {
    const ctx = appCtx();
    const unnamed = await ask({body: {prompt: 'p', appId: 'echo'}, ctx, requestContext: WORKSPACE});
    assert.equal(unnamed.status, 400);
    const foreign = await ask({body: {prompt: 'p', appId: 'bibtex-check', sessionId: SESSION}, ctx, requestContext: WORKSPACE});
    assert.equal(foreign.status, 404);
  });

  it('runs an app prompt only on an app the workspace added', async () => {
    const ctx = appCtx();
    const r = await ask({body: {prompt: 'p', appId: 'echo', sessionId: SESSION}, ctx, requestContext: WORKSPACE});
    assert.equal(r.status, 404);
    assert.equal(r.payload.error, 'This workspace has no plugin named echo');
  });

  it('refuses an app prompt without the workspace file system, to a viewer as to an editor', async () => {
    for (const role of ['editor', 'viewer']) {
      const r = await ask({body: {prompt: 'p', appId: 'echo', sessionId: SESSION}, requestContext: {...WORKSPACE, role}});
      assert.equal(r.status, 409);
      assert.equal(r.payload.code, 'fs-disabled');
    }
  });

  it('frames the deltas, then the whole answer, then ends the response', async () => {
    const r = await ask();
    assert.equal(r.res.written.status, 200);
    assert.deepEqual(r.res.writes, [
      'event: delta\ndata: {"text":"a "}\n\n',
      'event: delta\ndata: {"text":"completion"}\n\n',
      'event: done\ndata: {"text":"a completion"}\n\n',
    ]);
    // The dispatcher reads writableEnded and nothing else. A handler that
    // returned mid stream would fall through to the 404 branch and try to send
    // a second set of headers down a response the caller is still reading.
    assert.equal(r.res.writableEnded, true);
    assert.deepEqual(r.replies, [], 'and json() was never involved');
  });

  it('includes accounting data in the answer frame', async () => {
    const metrics = {duration_s: 1.2, model_s: 1, tools_s: 0.2, steps: []};
    const ctx = makeCtx({ai: {stream: async ({onDelta}) => {
      onDelta('measured');
      return {
        text: 'measured', usage: {total_tokens: 12}, cost: 0.001, metrics,
        model: 'test-model', harness: 'native', profile: PROFILE, stopReason: 'answer',
      };
    }}});
    const r = await ask({ctx});
    assert.equal(r.res.writes.at(-1), `event: done\ndata: ${JSON.stringify({
      text: 'measured', usage: {total_tokens: 12}, cost: 0.001, metrics,
      model: 'test-model', harness: 'native', profile: PROFILE, stopReason: 'answer',
    })}\n\n`);
  });

  it('declares an unbuffered event stream', async () => {
    const {headers} = (await ask()).res.written;
    assert.equal(headers['Content-Type'], 'text/event-stream');
    assert.equal(headers['Cache-Control'], 'no-cache');
    assert.equal(headers.Connection, 'keep-alive');
    assert.equal(headers['X-Accel-Buffering'], 'no');
  });

  // json() attaches the CORS headers for every other reply and is the only
  // thing that does, so a hand-rolled head has to say it again or the browser
  // throws the whole stream away.
  it('echoes the caller origin, as every other reply does', async () => {
    const r = await ask({headers: {origin: 'https://reader.example'}});
    assert.equal(r.res.written.headers['Access-Control-Allow-Origin'], 'https://reader.example');
    assert.equal(r.res.written.headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(r.res.written.headers.Vary, 'Origin');
  });

  it('sends the configured origin instead when one is pinned', async () => {
    const ctx = makeCtx({CORS_ORIGIN: 'https://mochi.example'});
    const r = await ask({ctx, headers: {origin: 'https://reader.example'}});
    assert.equal(r.res.written.headers['Access-Control-Allow-Origin'], 'https://mochi.example');
  });

  // A raw newline would end the frame early and the rest of the sentence would
  // arrive as an unparseable fragment.
  it('escapes a newline in the answer rather than breaking the frame', async () => {
    const ctx = makeCtx({ai: {stream: async ({onDelta}) => { onDelta('one\ntwo'); return {text: 'one\ntwo'}; }}});
    const r = await ask({ctx});
    assert.equal(r.res.writes[0], 'event: delta\ndata: {"text":"one\\ntwo"}\n\n');
    assert.equal(r.res.writes[0].split('\n\n').length, 2, 'one frame, not two');
  });

  // server/index.js gives every request req.setTimeout(30000) and registers no
  // listener for it, so thirty silent seconds destroy the socket mid answer.
  it('writes a heartbeat comment every ten seconds while it waits', async (t) => {
    t.mock.timers.enable({apis: ['setInterval']});
    let answer;
    const ctx = makeCtx({ai: {stream: () => new Promise(resolve => { answer = resolve; })}});
    const running = ask({ctx});
    // Let the handler get as far as awaiting the assistant. setImmediate is not
    // mocked, so this resolves after every pending microtask.
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10_000);
    t.mock.timers.tick(10_000);
    answer({text: 'at last'});
    const r = await running;
    assert.deepEqual(r.res.writes, [
      ': ping\n\n',
      ': ping\n\n',
      'event: done\ndata: {"text":"at last"}\n\n',
    ]);
  });

  it('writes nothing more once the response has ended', async (t) => {
    t.mock.timers.enable({apis: ['setInterval']});
    const r = await ask();
    const after = r.res.writes.length;
    t.mock.timers.tick(60_000);
    assert.equal(r.res.writes.length, after, 'a ping after end() would throw on a real socket');
  });

  // A reader who closed the tab is not going to read what NanoAgent produces.
  // The disconnection is res.emit('close') and not req's, which is measured
  // rather than stylistic: a real request emits its own 'close' as soon as the
  // body has been read, one tick before the handler resumes, so a listener
  // there hears the end of the body or nothing at all. Watching req cost a
  // stand-in provider its life in a live run of this endpoint.
  it('aborts the assistant when the caller disconnects', async () => {
    let connection;
    let aborted = false;
    const ctx = makeCtx({
      ai: {
        stream: ({signal, onDelta}) => new Promise((resolve) => {
          onDelta('half an ');
          signal.addEventListener('abort', () => { aborted = true; resolve({text: 'half an answer'}); });
          connection.destroyed = true;
          connection.emit('close');
        }),
      },
    });
    const r = await ask({ctx, onRequest: (_req, res) => { connection = res; }});
    assert.equal(aborted, true);
    assert.deepEqual(r.res.writes, ['event: delta\ndata: {"text":"half an "}\n\n'], 'nothing written down a dead socket');
    assert.equal(r.res.writableEnded, true);
  });

  it('lets go of the connection listener before ending, so a clean finish is not an abort', async () => {
    let aborted = false;
    const ctx = makeCtx({ai: {stream: async ({signal}) => { signal.addEventListener('abort', () => { aborted = true; }); return {text: 'done'}; }}});
    const r = await ask({ctx});
    r.res.emit('close');
    assert.equal(aborted, false);
  });

  it('rate limits the person, not the socket', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/stream', ctx, auth: {userId: 'u-42'}});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'ai-stream:u-42', maxPerMinute: 10}]);
    assert.equal(reads, 0);
    assert.equal(r.res.written, null, 'refused before any header was sent');
  });

  // The two endpoints share one validator, so this is the same list the
  // buffered endpoint is held to above.
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} as JSON, before opening a stream`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/ai/stream', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.ai, []);
      assert.equal(r.res.written, null);
    });
  }

  for (const [label, readBody] of [
    ['readBody rejects', async () => { throw new Error('bad json'); }],
    ['readBody resolves null', async () => null],
  ]) {
    it(`returns the generic 500 as JSON when ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/ai/stream', ctx: makeCtx({readBody})});
      assert.deepEqual([r.status, r.payload], [500, {error: 'AI request failed. Please try again later.'}]);
      assert.equal(r.res.written, null);
    });
  }

  // Once the head is out the status line is spent, so a refusal that arrives
  // after it has to be an event rather than a status code.
  it('reports a refusal as an error event carrying the status', async () => {
    const ctx = makeCtx({ai: {stream: async () => ({error: 'No AI provider is available.', status: 503})}});
    const r = await ask({ctx});
    assert.deepEqual(r.res.writes, ['event: error\ndata: {"error":"No AI provider is available.","status":503}\n\n']);
    assert.equal(r.res.written.status, 200);
    assert.equal(r.res.writableEnded, true);
  });

  it('calls a refusal that named no status a 502', async () => {
    const ctx = makeCtx({ai: {stream: async () => ({error: 'something went wrong'})}});
    const r = await ask({ctx});
    assert.match(r.res.writes[0], /"status":502/);
  });

  it('ends the response even when the assistant throws', async () => {
    const ctx = makeCtx({ai: {stream: async () => { throw new Error('boom'); }}});
    const r = await ask({ctx});
    assert.deepEqual(r.res.writes, ['event: error\ndata: {"error":"AI request failed. Please try again later.","status":500}\n\n']);
    assert.equal(r.res.writableEnded, true);
  });

  it('asks the assistant the same composed message the buffered endpoint does', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'POST', path: '/api/ai/stream', body: {prompt: 'Write something', context: 'earlier text'}, ctx});
    assert.equal(ctx.calls.ai[0].input, 'Write something');
    assert.deepEqual(ctx.calls.ai[0].messages, [{role: 'user', content: 'Context:\nearlier text'}]);
    assert.match(ctx.calls.ai[0].instructions, /assistant built into a personal research site/);
    assert.equal('profile' in ctx.calls.ai[0], false);
  });
});

// ── Metadata search ───────────────────────────────────────────────────────

describe('/api/ai/settings and /api/ai/models', () => {
  const put = (ctx, value) => invoke(routes, {method: 'PUT', path: '/api/ai/settings', body: {settings: value}, ctx, auth: {userId: 'u1'}});

  it('says the one model every run is on, beside the member\'s settings', async () => {
    const ctx = makeCtx();
    const result = await invoke(routes, {method: 'GET', path: '/api/ai/settings', ctx, auth: {userId: 'u1'}});
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.model, {provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731'});
  });

  it('keeps a member\'s settings, refusing what is not one', async () => {
    const ctx = makeCtx();
    ctx.preferences = {merged: [], merge: async (userId, patch) => ctx.preferences.merged.push([userId, patch])};
    const value = {behaviour: {maxSteps: 40}, instructions: 'Be brief.'};
    const saved = await put(ctx, value);
    assert.equal(saved.status, 200);
    assert.deepEqual(ctx.preferences.merged, [['u1', {ai: saved.payload.settings}]]);
    assert.deepEqual(saved.payload.settings, value);
    for (const [bad, error] of [
      [{chat: {provider: 'anthropic', model: 'claude-x'}}, /chat is not an AI setting/],
      [{runner: 'cloud'}, /runner is not an AI setting/],
      [{instructions: 'x'.repeat(4001)}, /4000 characters/],
      [{temperature: 1}, /temperature is not an AI setting/],
    ]) {
      const refused = await put(ctx, bad);
      assert.equal(refused.status, 400);
      assert.match(refused.payload.error, error);
    }
    assert.equal(ctx.preferences.merged.length, 1);
  });

  it('lists the member\'s computer\'s models, each available once Mochi Lab holds its key', async () => {
    const ctx = makeCtx();
    assert.deepEqual(
      (await invoke(routes, {path: '/api/ai/models', ctx, auth: {userId: 'u1'}})).payload,
      {connected: false, device: null, providers: [], models: [], defaults: {}, limits: null},
    );
    ctx.runners = {
      status: () => ({connected: true, device: 'laptop', keys: [{env: 'OPENROUTER_API_KEY', label: 'OpenRouter', set: true}]}),
      computer: () => ({
        models: async () => ({value: {
          providers: [{id: 'openrouter', name: 'OpenRouter', keySet: true}, {id: 'anthropic', name: 'Anthropic', keySet: false}],
          models: [
            {provider: 'openrouter', id: 'a/b', name: 'B', contextWindow: 10, maxTokens: 5, reasoning: false, cost: {input: 1, output: 2}, apps: true},
            {provider: 'anthropic', id: 'claude-x', name: 'Claude X', contextWindow: 20, maxTokens: 5, reasoning: true, cost: {input: 3, output: 15}, apps: false},
          ],
          limits: {capped: false},
        }}),
        profiles: async () => ({defaultProfile: 'pi', profiles: [
          {id: 'pi', provider: 'openrouter', model: 'a/b', uses: ['chat', 'inline']},
          {id: 'app', provider: 'openrouter', model: 'a/b', uses: ['chat', 'apps']},
        ]}),
      }),
    };
    const r = (await invoke(routes, {path: '/api/ai/models', ctx, auth: {userId: 'u1'}})).payload;
    assert.equal(r.device, 'laptop');
    assert.deepEqual(r.defaults, {chat: 'openrouter/a/b', inline: 'openrouter/a/b', apps: 'openrouter/a/b'});
    assert.deepEqual(r.models.map(model => [model.key, model.uses.includes('apps'), model.available]), [
      ['openrouter/a/b', true, true],
      ['anthropic/claude-x', false, false],
    ]);
    assert.match(r.models[1].unavailableReason, /Needs your Anthropic key/);
  });

  it('tells what the OpenRouter key on the member\'s computer has spent, as OpenRouter says', async () => {
    const ctx = makeCtx();
    const get = () => invoke(routes, {path: '/api/runner/credit', ctx, auth: {userId: 'u1'}});
    const computer = usage => { ctx.runners = {computer: () => ({openrouterUsage: async () => usage})}; };
    ctx.runners = {computer: () => null};
    assert.deepEqual((await get()).payload, {credit: null});
    // The member's own key: what it has spent, against its own limit or none.
    const own = {usage: 0.75, limit: 10, limit_remaining: 9.25, workspace_id: 'theirs', workspace_budget: null};
    computer({value: own});
    assert.deepEqual((await get()).payload, {credit: {you: 0.75, total: {used: 0.75, cap: 10}}});
    computer({value: {...own, limit: null, limit_remaining: null}});
    assert.deepEqual((await get()).payload.credit.total, {used: 0.75, cap: null});
    // Mochi's: what the member spent on every key Mochi gave them, beside everyone's of the cap.
    ctx.openrouterKeys = {workspaceId: async () => 'ws1', spent: async userId => (userId === 'u1' ? 3.5 : 0)};
    computer({value: {usage: 0.5, limit: null, limit_remaining: null, workspace_id: 'ws1', workspace_budget: {spend: 6, limit: 10}}});
    assert.deepEqual((await get()).payload, {credit: {you: 3.5, total: {used: 6, cap: 10}}});
    computer({error: 'no OpenRouter key is set', status: 404});
    assert.deepEqual((await get()).payload, {credit: null});
    computer({error: 'OpenRouter answered 401', status: 502});
    assert.equal((await get()).status, 502);
  });

  it('passes API keys on to the member\'s computer, answering with what it said', async () => {
    const sent = [];
    const ctx = makeCtx();
    ctx.runners = {saveKeys: async (userId, changes) => {
      sent.push([userId, changes]);
      return changes.BAD ? {error: 'BAD is not a key Mochi Lab holds', status: 400} : {value: {saved: true}};
    }};
    const put = body => invoke(routes, {method: 'PUT', path: '/api/runner/keys', body, ctx, auth: {userId: 'u1'}});
    assert.deepEqual((await put({changes: {OPENROUTER_API_KEY: 'sk-1'}})).payload, {saved: true});
    const refused = await put({changes: {BAD: 'x'}});
    assert.equal(refused.status, 400);
    assert.match(refused.payload.error, /not a key/);
    assert.deepEqual(sent[0], ['u1', {OPENROUTER_API_KEY: 'sk-1'}]);
  });
});
