import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {CLI_PATTERNS, terminalSession} = require('../../../src/server/benchmark/terminal-sessions.js');
const route = loadRoute('benchmark');
const CONTEXT = {userId: 'me', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const S = 1e9;

const call = (id, start, end, usage = {input: 100, output: 10}) => ({
  call_id: id, status: 'ok', model: 'm', start_ns: String(start * S), end_ns: String(end * S), usage, request_sha256: 'a'.repeat(64), response_sha256: 'b'.repeat(64),
});
const process = (argv, start, end) => ({argv, start_ns: String(start * S), end_ns: end === null ? null : String(end * S), exit_code: 0});
const CLAUDE = ['/opt/rush/clis/k/harness/node_modules/@anthropic-ai/claude-code-linux-x64/claude'];
const CODEX = ['node', '/opt/rush/clis/k/harness/node_modules/@openai/codex/bin/codex.js'];
const row = (fields = {}) => ({
  attempt_id: ATTEMPT, state: 'final', finalized_at: '2026-11-18T01:00:00Z', elapsed_ms: 60000, harness_name: 'shell', task_id: 'sum',
  created_at: '2026-11-18T00:00:00Z', calls: [], processes: [], costs: {}, ...fields,
});
const usageOf = session => Object.fromEntries(session.harnesses.map(({harness, usage}) => [harness, usage]));

describe('a Harness tab session on the Dashboard', () => {
  it('gives each model call of a Terminal session to the CLI whose process ran it, and its figures to that CLI', () => {
    const session = terminalSession(row({
      calls: [call('c1', 10, 12), call('c2', 30, 33), call('c3', 50, 51, null)],
      processes: [process(CLAUDE, 5, 20), process(CODEX, 25, 40)],
      costs: {c1: 0.01, c2: 0.02},
    }));
    assert.equal(session.harness, 'Terminal (several)');
    assert.deepEqual(session.calls.map(one => [one.agent, one.startS, one.durationS]), [['Claude Code', 5, 2], ['Codex', 25, 3], ['Terminal', 45, 1]]);
    const usage = usageOf(session);
    assert.deepEqual(usage['Claude Code'], {
      durationS: {sum: 0, count: 0}, modelS: {sum: 2, count: 1}, toolsS: {sum: 0, count: 0},
      inputTokens: {sum: 100, count: 1}, outputTokens: {sum: 10, count: 1}, cost: {sum: 0.01, count: 1},
    });
    assert.deepEqual([usage.Terminal.inputTokens, usage.Terminal.cost], [{sum: 0, count: 0}, {sum: 0, count: 0}]);
  });

  it('names a session by its one harness, which takes its latency, and leaves a call two CLIs could have made to the Terminal', () => {
    const one = terminalSession(row({calls: [call('c1', 10, 12)], processes: [process(CLAUDE, 5, null)], costs: {c1: 0.01}}));
    assert.deepEqual([one.harness, usageOf(one)['Claude Code'].durationS], ['Claude Code', {sum: 60, count: 1}]);
    const both = terminalSession(row({calls: [call('c1', 10, 12)], processes: [process(CLAUDE, 5, null), process(CODEX, 6, null)]}));
    assert.deepEqual([both.harness, both.calls[0].agent], ['Terminal', 'Terminal']);
    const codex = terminalSession(row({harness_name: 'codex', calls: [call('c1', 10, 12)]}));
    assert.deepEqual([codex.harness, codex.title, terminalSession(row({harness_name: 'mine'})).harness], ['Codex', 'Codex', 'mine']);
  });

  it('knows nothing of a running session\'s calls, and knows a finished one with none made none', () => {
    const running = usageOf(terminalSession(row({state: 'leased', finalized_at: null, elapsed_ms: null})));
    assert.deepEqual([running.Terminal.cost, running.Terminal.durationS], [{sum: 0, count: 0}, {sum: 0, count: 0}]);
    assert.deepEqual(usageOf(terminalSession(row())).Terminal.cost, {sum: 0, count: 1});
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

  it('lists the member\'s sessions on the plugin without their calls, reading only their CLIs\' processes', async () => {
    const {ctx, calls} = ctxWith();
    const {status, payload} = await invoke(route, {method: 'GET', path: '/api/benchmark/terminal-sessions', query: {plugin_id: 'p'}, requestContext: CONTEXT, ctx});
    assert.equal(status, 200);
    assert.deepEqual(calls, [{pluginId: 'p', patterns: CLI_PATTERNS}]);
    assert.deepEqual([payload.sessions[0].harness, 'calls' in payload.sessions[0]], ['Claude Code', false]);
  });

  it('replays one: its terminals, model calls and commands', async () => {
    const {ctx, calls} = ctxWith();
    const {status, payload} = await invoke(route, {method: 'GET', path: `/api/benchmark/attempts/${ATTEMPT}/recording`, requestContext: CONTEXT, ctx});
    assert.equal(status, 200);
    assert.deepEqual(calls, [{attemptId: ATTEMPT}]);
    assert.deepEqual(payload.terminals, [{terminal: 0, data: Buffer.from('$ ls\r\n').toString('base64')}]);
    assert.deepEqual([payload.session.calls[0].agent, payload.session.commands[0].durationS], ['Claude Code', 15]);
  });
});
