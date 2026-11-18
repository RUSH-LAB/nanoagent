import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {terminalSession} = require('../../../src/server/benchmark/terminal-sessions.js');
const route = loadRoute('benchmark');
const CONTEXT = {userId: 'me', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const S = 1e9;

const call = (id, start, end, usage = {input: 100, output: 10}) => ({
  call_id: id, status: 'ok', model: 'm', start_ns: String(start * S), end_ns: String(end * S), usage, request_sha256: 'a'.repeat(64), response_sha256: 'b'.repeat(64),
});
let pid = 0;
const process = (argv, start, end, parent = null) => ({
  span_id: `p:${++pid}`, parent_id: parent?.span_id ?? 'process-tree', argv, start_ns: String(start * S), end_ns: end === null ? null : String(end * S), exit_code: 0,
});
const SHELL = ['python', '/harness/shell.py'];
const BASH = ['bash', '--rcfile', '/harness/bashrc', '-i'];
const CLAUDE = ['/opt/rush/clis/k/harness/node_modules/@anthropic-ai/claude-code-linux-x64/claude'];
const CODEX = ['node', '/opt/rush/clis/k/harness/node_modules/@openai/codex/bin/codex.js'];
const row = (fields = {}) => ({
  attempt_id: ATTEMPT, state: 'final', finalized_at: '2026-11-18T01:00:00Z', elapsed_ms: 60000, harness_name: 'shell', task_id: 'sum',
  created_at: '2026-11-18T00:00:00Z', calls: [], processes: [], costs: {}, ...fields,
});
const usageOf = session => Object.fromEntries(session.harnesses.map(({harness, usage}) => [harness, usage]));

describe('a Harness tab session on the Dashboard', () => {
  it('gives each model call of a Terminal session to the agent whose process made it, by what was run, and its figures to that agent', () => {
    const shell = process(SHELL, 0, null);
    const bash = process(BASH, 1, null, shell);
    const claude = process(CLAUDE, 5, 20, bash);
    const session = terminalSession(row({
      calls: [call('c1', 10, 12), call('c2', 30, 33), call('c3', 50, 51, null), call('c4', 70, 71)],
      processes: [shell, bash, claude, process(['rg', 'TODO'], 9, 11, claude), process(CODEX, 25, 40, bash), process(['/usr/bin/aider'], 45, 55, bash)],
      costs: {c1: 0.01, c2: 0.02},
    }));
    assert.equal(session.title, 'claude, codex, aider, unknown');
    assert.deepEqual(session.calls.map(one => [one.agent, one.startS, one.durationS]), [['claude', 10, 2], ['codex', 30, 3], ['aider', 50, 1], ['unknown', 70, 1]]);
    const usage = usageOf(session);
    assert.deepEqual(usage.claude, {
      durationS: {sum: 0, count: 0}, modelS: {sum: 2, count: 1}, toolsS: {sum: 0, count: 0},
      inputTokens: {sum: 100, count: 1}, outputTokens: {sum: 10, count: 1}, cost: {sum: 0.01, count: 1},
    });
    assert.deepEqual([usage.aider.inputTokens, usage.aider.cost], [{sum: 0, count: 0}, {sum: 0, count: 0}]);
  });

  it('names a session by its one agent, which takes its latency, and leaves a call two agents could have made unknown', () => {
    const wrapper = process(['sh', '/harness/bin/claude', '-p', 'hi'], 5, null);
    const one = terminalSession(row({calls: [call('c1', 10, 12)], processes: [wrapper, process(['python', '/harness/rush.py', 'cli', 'claude'], 6, 7, wrapper)], costs: {c1: 0.01}}));
    assert.deepEqual([one.title, usageOf(one).claude.durationS], ['claude', {sum: 60, count: 1}]);
    const both = terminalSession(row({calls: [call('c1', 10, 12)], processes: [process(CLAUDE, 5, null), process(CODEX, 6, null)]}));
    assert.deepEqual([both.title, both.calls[0].agent], ['unknown', 'unknown']);
    const codex = terminalSession(row({harness_name: 'codex', calls: [call('c1', 10, 12)]}));
    assert.deepEqual([codex.harness, codex.title, terminalSession(row({harness_name: 'mine'})).harness], ['Codex', 'Codex', 'mine']);
  });

  it('names a session with no model calls by its main command, or shell', () => {
    const bash = process(BASH, 0, null);
    const ran = terminalSession(row({processes: [bash, process(['ls'], 1, 2, bash), process(['/usr/bin/python3', 'train.py'], 3, 40, bash)]}));
    assert.deepEqual([ran.title, ran.harnesses.map(one => one.harness)], ['python3', ['python3']]);
    assert.equal(terminalSession(row({processes: [bash]})).title, 'shell');
  });

  it('knows nothing of a running session\'s calls, and knows a finished one with none made none', () => {
    const running = usageOf(terminalSession(row({state: 'leased', finalized_at: null, elapsed_ms: null})));
    assert.deepEqual([running.shell.cost, running.shell.durationS], [{sum: 0, count: 0}, {sum: 0, count: 0}]);
    assert.deepEqual(usageOf(terminalSession(row())).shell.cost, {sum: 0, count: 1});
  });
});

describe('the Dashboard\'s Harness session routes', () => {
  const ctxWith = () => {
    const calls = [];
    const ctx = makeCtx({benchmark: {service: {}, repository: {
      terminalRows: async (context, options) => { calls.push(options); return [row({calls: [call('c1', 10, 12)], processes: [process(CLAUDE, 5, 20)]})]; },
      terminalTranscripts: async () => [{terminal: 0, data: Buffer.from('$ ls\r\n')}],
    }}});
    return {ctx, calls};
  };

  it('lists the member\'s sessions on the plugin without their calls, reading only the processes that name their agents', async () => {
    const {ctx, calls} = ctxWith();
    const {status, payload} = await invoke(route, {method: 'GET', path: '/api/benchmark/terminal-sessions', query: {plugin_id: 'p'}, requestContext: CONTEXT, ctx});
    assert.equal(status, 200);
    assert.deepEqual(calls, [{pluginId: 'p', atCalls: true}]);
    assert.deepEqual([payload.sessions[0].harness, 'calls' in payload.sessions[0]], ['claude', false]);
  });

  it('replays one: its terminals, model calls and commands', async () => {
    const {ctx, calls} = ctxWith();
    const {status, payload} = await invoke(route, {method: 'GET', path: `/api/benchmark/attempts/${ATTEMPT}/recording`, requestContext: CONTEXT, ctx});
    assert.equal(status, 200);
    assert.deepEqual(calls, [{attemptId: ATTEMPT}]);
    assert.deepEqual(payload.terminals, [{terminal: 0, data: Buffer.from('$ ls\r\n').toString('base64')}]);
    assert.deepEqual([payload.session.calls[0].agent, payload.session.commands[0].durationS], ['claude', 15]);
  });
});
