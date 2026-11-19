import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {chatLine, runLine, streamText} = require('../../../src/server/benchmark/export.js');
const {isGlobalApiPath} = require('../../../src/server/workspace-context.js');
const route = loadRoute('trace-export');
const PATH = '/api/traces/export';

const sha = text => createHash('sha256').update(text).digest('hex');
const REQUEST = JSON.stringify({model: 'm', messages: [{role: 'user', content: 'Add one and two'}], stream: true});
const STREAM = [
  {type: 'message_start', message: {id: 'msg', model: 'm'}},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'It is '}},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: '3.'}},
  {type: 'message_stop'},
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

/** A run of member `user` on plugin `plugin`, one attempt with one model call, its process and its terminal. */
function run(id, user, plugin, createdAt) {
  const row = {
    run_id: id, workspace_id: 'w', user_id: user, user_name: user.toUpperCase(), user_github: user, plugin_id: plugin, plugin_name: 'P', version: '1.0.0',
    task_id: 'sum', benchmark_id: 'b', benchmark_name: 'harness-session', harness_name: 'claude-code', harness_version: 'v', start_cli: null,
    model: 'm', policy: 'coding', interactive: false, resumed_from: null, session: true, created_at: createdAt, canceled_at: null,
  };
  const attempt = {
    attempt_id: `${id}-a`, case_id: 'c1', attempt_no: 1, rerun_of: null, state: 'final', created_at: createdAt, claimed_at: createdAt, finalized_at: createdAt,
    execution_status: 'answered', execution_reason: null, verdict: 'pass', explanation: null, verifier_error: null, metrics: {elapsed_ms: 10}, chats: null,
  };
  const events = [
    {kind: 'process.exec', data: {argv: ['claude', '-p', 'Add one and two']}},
    {kind: 'model_call.admitted', data: {call_id: 'k1', dialect: 'anthropic_messages', model: 'm', submitted_request_sha256: sha(REQUEST)}},
    {kind: 'model_call.dispatched', data: {call_id: 'k1', url: 'https://openrouter.ai/api/v1/messages'}},
    {kind: 'model_call.response', data: {call_id: 'k1', dialect: 'anthropic_messages', terminal: 'completed', http_status: 200, usage: {input: 5, output: 3}, stream_payload_sha256: sha(STREAM)}},
    {kind: 'process.exit', data: {exit_code: 0}},
  ];
  const payloads = new Map([[sha(REQUEST), {data: Buffer.from(REQUEST), redaction: 'none'}], [sha(STREAM), {data: Buffer.from(STREAM), redaction: 'none'}]]);
  const recorded = {events, payloads, spans: [], links: [], accounting: [{call_id: 'k1', status: 'settled', cost_usd: 0.01}], terminals: [{terminal: 0, data: Buffer.from('$ claude\n3\n')}]};
  return {row, line: () => runLine(row, [{row: attempt, recorded}], ['c1'])};
}

const RUNS = [run('r1', 'alice', 'p', '2026-11-01T00:00:00Z'), run('r2', 'bob', 'p', '2026-11-02T00:00:00Z'), run('r3', 'alice', 'q', '2026-11-03T00:00:00Z')];
const CHATS = [{id: 's1', workspace_id: 'w', user_id: 'alice', user_name: 'ALICE', user_github: 'alice', plugin_id: 'p', title: 'Sum', created_at: '2026-11-04T00:00:00Z'}];

/** The repository: what each filter matches, as its SQL does (READABLE is enforced there; here the route's choice of member is what is tested). */
function ctxFor({admins = []} = {}) {
  const seen = [];
  const matches = (row, {member, plugin, since, until}) => (member === null || row.user_id === member) && (plugin === null || row.plugin_id === plugin)
    && (since === null || row.created_at >= since) && (until === null || row.created_at < until);
  const ctx = makeCtx({
    roles: {isAdmin: async id => admins.includes(id)},
    traceExport: {
      runIds: async (caller, filter) => { seen.push(filter); return RUNS.filter(({row}) => matches(row, filter)).map(({row}) => row.run_id); },
      runLine: async (caller, id) => RUNS.find(({row}) => row.run_id === id).line(),
      chats: async (caller, filter) => CHATS.filter(chat => matches(chat, filter)),
      chatLine: async chat => chatLine(chat, [{prompt: 'Add one and two', answer: '3', messages: {steps: []}}], [{model: 'm', input_tokens: 5}]),
    },
  });
  return {ctx, seen};
}

async function exportAs(userId, query, options) {
  const {ctx, seen} = ctxFor(options);
  const reply = await invoke(route, {path: PATH, query, ctx, auth: {userId}});
  const lines = reply.res.written ? reply.res.writes.join('').split('\n').filter(Boolean).map(line => JSON.parse(line)) : null;
  return {...reply, lines, seen};
}

describe('GET /api/traces/export', () => {
  it('answers outside any workspace', () => {
    assert.equal(isGlobalApiPath(PATH), true);
  });

  it('gives a member their own runs and chats, one JSON line each, with every model call\'s request and response bodies', async () => {
    const {lines, seen, res} = await exportAs('alice', {});
    assert.equal(res.written.status, 200);
    assert.match(res.written.headers['Content-Type'], /application\/x-ndjson/);
    assert.equal(seen[0].member, 'alice');
    assert.deepEqual(lines.map(line => line.run_id ?? line.session_id), ['r1', 'r3', 's1']);
    const [first] = lines;
    assert.equal(first.type, 'run');
    assert.equal(first.kind, 'session');
    assert.equal(first.harness.name, 'claude');
    assert.deepEqual(first.member, {id: 'alice', name: 'ALICE', github: 'alice'});
    assert.equal(first.score.value, 1);
    const [attempt] = first.attempts;
    assert.deepEqual(attempt.outcome, {status: 'answered', reason: null});
    const [call] = attempt.model_calls;
    assert.deepEqual(call.request.body.messages, [{role: 'user', content: 'Add one and two'}]);
    assert.equal(call.response.body, STREAM);
    assert.equal(call.response_text, 'It is 3.');
    assert.equal(call.url, 'https://openrouter.ai/api/v1/messages');
    assert.deepEqual(call.usage, {input: 5, output: 3});
    assert.deepEqual(attempt.events.filter(event => event.kind.startsWith('process.')).map(event => event.data), [{argv: ['claude', '-p', 'Add one and two']}, {exit_code: 0}]);
    assert.deepEqual(attempt.accounting, [{call_id: 'k1', status: 'settled', cost_usd: 0.01}]);
    assert.deepEqual(attempt.terminals, [{terminal: 0, text: '$ claude\n3\n'}]);
    assert.equal(lines[2].type, 'chat');
    assert.deepEqual(lines[2].turns[0].messages, {steps: []});
  });

  it('refuses another member\'s traces, or everyone\'s, to a member who is not an administrator', async () => {
    for (const member of ['bob', 'all']) {
      const {status, payload, lines} = await exportAs('alice', {member});
      assert.equal(status, 403);
      assert.match(payload.error, /administrators/);
      assert.equal(lines, null);
    }
  });

  it('gives an administrator every member\'s with member=all, or one member\'s', async () => {
    const all = await exportAs('admin', {member: 'all'}, {admins: ['admin']});
    assert.equal(all.seen[0].member, null);
    assert.deepEqual(all.lines.map(line => line.member.id), ['alice', 'bob', 'alice', 'alice']);
    const bob = await exportAs('admin', {member: 'bob'}, {admins: ['admin']});
    assert.deepEqual(bob.lines.map(line => line.run_id), ['r2']);
  });

  it('filters by plugin and by since and until', async () => {
    const {lines, seen} = await exportAs('admin', {member: 'all', plugin: 'p', since: '2026-11-02', until: '2026-11-04'}, {admins: ['admin']});
    assert.deepEqual(seen[0], {member: null, plugin: 'p', since: '2026-11-02T00:00:00.000Z', until: '2026-11-04T00:00:00.000Z'});
    assert.deepEqual(lines.map(line => line.run_id), ['r2']);
    const bad = await exportAs('alice', {since: 'yesterday-ish'});
    assert.equal(bad.status, 400);
  });

  it('refuses a caller who is not signed in', async () => {
    const {ctx} = ctxFor();
    const {status} = await invoke(route, {path: PATH, ctx, auth: null});
    assert.equal(status, 401);
  });
});

describe('response text', () => {
  it('is assembled from a chat completions stream and a responses stream as NanoAgent assembles it', () => {
    const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    assert.equal(streamText('chat_completions', `${sse([{choices: [{index: 0, delta: {content: 'a'}}]}, {choices: [{index: 0, delta: {content: 'b'}}]}])}data: [DONE]\n\n`), 'ab');
    assert.equal(streamText('responses', sse([{type: 'response.output_text.delta', delta: 'x'}, {type: 'response.completed', response: {}}])), 'x');
  });
});
