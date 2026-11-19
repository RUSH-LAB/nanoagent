import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {invoke, loadRoute, makeCtx} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {terminalSession, terminalChats, memberChats} = require('../../../src/server/benchmark/terminal-sessions.js');
const route = loadRoute('benchmark');
const CONTEXT = {userId: 'me', workspaceId: 'w', membershipId: 'm', role: 'owner'};
const ATTEMPT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
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
    assert.equal(session.title, 'claude, codex, aider');
    const usage = usageOf(session);
    assert.deepEqual(Object.values(usage).map(one => one.modelS.sum), [2, 3, 1]);
    assert.deepEqual(Object.keys(usage), ['claude', 'codex', 'aider']);
    assert.deepEqual([session.usage.modelS, session.usage.durationS], [{sum: 1, count: 1}, {sum: 0, count: 0}]);
    assert.deepEqual(usage.claude, {
      durationS: {sum: 0, count: 0}, modelS: {sum: 2, count: 1}, toolsS: {sum: 0, count: 0},
      inputTokens: {sum: 100, count: 1}, outputTokens: {sum: 10, count: 1}, cost: {sum: 0.01, count: 1},
    });
    assert.deepEqual([usage.aider.inputTokens, usage.aider.cost], [{sum: 0, count: 0}, {sum: 0, count: 0}]);
  });

  it('gives a call made while agents run in two terminals to the one its client names, live, at its first model call', () => {
    const claude = process(CLAUDE, 5, null);
    const codex = process(CODEX, 8, null);
    const live = terminalChats(row({
      state: 'leased', finalized_at: null, task_id: null, processes: [claude, codex],
      calls: [{...call('c1', 6, 7), client: 'claude-cli/2.1.325 (external, cli)'}, {...call('c2', 10, 11), client: 'codex-tui/0.167.0 (Debian 12.0.0; aarch64)'}],
    }));
    assert.deepEqual(live.map(chat => [chat.agent, chat.title, chat.usage.inputTokens.sum]), [['claude', 'claude', 100], ['codex', 'codex', 100]]);
    const unnamed = terminalSession(row({calls: [{...call('c1', 10, 11), client: 'node'}], processes: [claude, codex]}));
    assert.deepEqual(unnamed.harnesses, []);  // a client no CLI is known by, with two agents running: no agent's
  });

  it('names a session by its one agent, which takes its latency, and ties a call two agents could have made to none', () => {
    const wrapper = process(['sh', '/harness/bin/claude', '-p', 'hi'], 5, null);
    const one = terminalSession(row({calls: [call('c1', 10, 12)], processes: [wrapper, process(['python', '/harness/rush.py', 'cli', 'claude'], 6, 7, wrapper)], costs: {c1: 0.01}}));
    assert.deepEqual([one.title, usageOf(one).claude.durationS], ['claude', {sum: 60, count: 1}]);
    const both = terminalSession(row({calls: [call('c1', 10, 12)], processes: [process(CLAUDE, 5, null), process(CODEX, 6, null)]}));
    assert.deepEqual([both.title, both.harnesses, both.usage.modelS, both.usage.durationS], ['claude', [], {sum: 2, count: 1}, {sum: 60, count: 1}]);
    const codex = terminalSession(row({harness_name: 'codex', calls: [call('c1', 10, 12)]}));
    const rush = terminalSession(row({harness_name: 'nanoagent', calls: [call('c1', 10, 12)]}));
    assert.deepEqual([codex.title, rush.title, terminalSession(row({harness_name: 'claude-code'})).title], ['codex', 'nanoagent', 'claude']);
  });

  it('names NanoAgent\'s model calls nanoagent, whether its chat or mgen made them', () => {
    const chat = process(['python', '-m', 'nanoagent.cli.repl.app', 'mgen_cfg=/opt/rush/clis/k/harness/nanoagent/configs/mgen.yaml'], 5, 20);
    const mgen = process(['python', '-m', 'nanoagent.cli.mgen', '--config', 'mgen.yaml', '-p', 'rain?'], 25, 40);
    const session = terminalSession(row({calls: [call('c1', 10, 12), call('c2', 30, 33)], processes: [chat, mgen]}));
    assert.deepEqual([session.title, session.harnesses.map(one => one.harness)], ['nanoagent', ['nanoagent']]);
  });

  it('gives a session no agent made a model call in no agent, titled by its main command, its calls, or no agent', () => {
    const bash = process(BASH, 0, null);
    const ran = terminalSession(row({processes: [bash, process(['ls'], 1, 2, bash), process(['/usr/bin/python3', 'train.py'], 3, 40, bash)]}));
    assert.deepEqual([ran.title, ran.harnesses], ['python3', []]);
    assert.deepEqual([terminalSession(row({processes: [bash]})).title, terminalSession(row({calls: [call('c1', 1, 2), call('c2', 3, 4)]})).title], ['no agent', '2 model calls']);
  });

  it('knows nothing of a running session\'s calls, and knows a finished one with none made none', () => {
    const running = terminalSession(row({state: 'leased', finalized_at: null, elapsed_ms: null})).usage;
    assert.deepEqual([running.cost, running.durationS], [{sum: 0, count: 0}, {sum: 0, count: 0}]);
    assert.deepEqual(terminalSession(row()).usage.cost, {sum: 0, count: 1});
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

  it('lists the chats of the member\'s sessions on the plugin, reading only the processes that name their agents', async () => {
    const {ctx, calls} = ctxWith();
    const {status, payload} = await invoke(route, {method: 'GET', path: '/api/benchmark/terminal-sessions', query: {plugin_id: 'p'}, requestContext: CONTEXT, ctx});
    assert.equal(status, 200);
    assert.deepEqual(calls, [{pluginId: 'p', atCalls: true}]);
    assert.deepEqual(payload.chats.map(chat => [chat.agent, chat.title, chat.archivedAt]), [['claude', 'claude', null]]);
  });

  it('replays one: its terminals and its figures', async () => {
    const {ctx, calls} = ctxWith();
    const {status, payload} = await invoke(route, {method: 'GET', path: `/api/benchmark/attempts/${ATTEMPT}/recording`, requestContext: CONTEXT, ctx});
    assert.equal(status, 200);
    assert.deepEqual(calls, [{attemptId: ATTEMPT}]);
    assert.deepEqual(payload.terminals, [{terminal: 0, data: Buffer.from('$ ls\r\n').toString('base64')}]);
    assert.equal(payload.session.title, 'claude');
  });

  it('archives and restores one of the member\'s chats, on the session that last held it, and no one else\'s', async () => {
    const archived = [];
    const ctx = makeCtx({benchmark: {service: {}, repository: {
      archiveChat: async (context, attemptId, chat, value) => { archived.push([attemptId, chat, value]); return attemptId === ATTEMPT; },
    }}});
    const post = (id, body) => invoke(route, {method: 'POST', path: `/api/benchmark/attempts/${id}/archive`, body, requestContext: CONTEXT, ctx});
    const chat = 'claude:aaaa';
    const answers = [
      await post(ATTEMPT, {archived: true, chat}), await post(ATTEMPT, {archived: false, chat}), await post(OTHER, {archived: true, chat}),
      await post(ATTEMPT, {chat}), await post(ATTEMPT, {archived: true}),
    ];
    assert.deepEqual(answers.map(({status, payload}) => [status, status === 200 ? payload : null]), [[200, {archived: true}], [200, {archived: false}], [404, null], [400, null], [400, null]]);
    assert.deepEqual(archived, [[ATTEMPT, chat, true], [ATTEMPT, chat, false], [OTHER, chat, true]]);
  });
});

describe('the chats of a Harness tab session on the Dashboard', () => {
  const S_NS = BigInt(1e9);
  const at = seconds => String(BigInt(seconds) * S_NS);
  const reported = (id, title, start, end, agent = 'claude') => ({
    agent, id, title, started_at: `2026-11-18T00:00:${String(start).padStart(2, '0')}Z`, ended_at: `2026-11-18T00:00:${String(end).padStart(2, '0')}Z`,
    started_ns: at(start), ended_ns: at(end),
  });
  const free = (fields = {}) => row({task_id: null, resumable: true, chats: null, archived_chats: {}, ...fields});

  it('makes two claude -p runs two chats, titled by their prompts, each with its own calls, and one ended reopens', () => {
    const bash = process(BASH, 0, null);
    const first = process([...CLAUDE, '-p', 'say ok'], 9, 13, bash);
    const second = process([...CLAUDE, '-p', 'list the files'], 19, 26, bash);
    const recorded = {calls: [call('c1', 10, 12), call('c2', 20, 22), call('c3', 23, 25)], processes: [bash, first, second], costs: {c1: 0.01, c2: 0.02, c3: 0.03}};
    // While it runs, each run of claude is a chat, named by what was typed.
    const running = terminalChats(free({...recorded, state: 'leased', finalized_at: null}));
    assert.deepEqual(running.map(chat => [chat.agent, chat.title, chat.conversation, chat.running, chat.usage.inputTokens.sum]), [
      ['claude', 'claude -p say ok', null, true, 100], ['claude', 'claude -p list the files', null, true, 200],
    ]);
    // Ended, they are the conversations the worker read from Claude Code's state.
    const ended = terminalChats(free({...recorded, chats: [reported('aaaa', 'say ok', 10, 12), reported('bbbb', 'list the files', 20, 25)]}));
    assert.deepEqual(ended.map(chat => [chat.key, chat.title, chat.conversation, chat.resumable, chat.freeForm]), [
      ['claude:aaaa', 'say ok', 'aaaa', true, true], ['claude:bbbb', 'list the files', 'bbbb', true, true],
    ]);
    assert.deepEqual(ended.map(chat => [chat.usage.cost, chat.usage.inputTokens, chat.usage.durationS]), [
      [{sum: 0.01, count: 1}, {sum: 100, count: 1}, {sum: 2, count: 1}],
      [{sum: 0.05, count: 1}, {sum: 200, count: 1}, {sum: 5, count: 1}],
    ]);
  });

  it('keeps a run of an agent whose conversations are not read a chat of its own, and a session no agent ran in holds none', () => {
    const bash = process(BASH, 0, null);
    const dsh = process(['node', '/opt/rush/clis/k/harness/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'headless', 'fix it'], 5, 9, bash);
    const chats = terminalChats(free({calls: [call('c1', 6, 7)], processes: [bash, dsh], chats: []}));
    assert.deepEqual(chats.map(chat => [chat.agent, chat.title, chat.conversation]), [['dsh', 'dsh --profile headless fix it', null]]);
    assert.deepEqual(terminalChats(free({processes: [bash, process(['ls'], 1, 2, bash)], chats: []})), []);
  });

  it('makes one conversation resumed in a later session one chat, reopened from the later one, which takes its archive', () => {
    const one = terminalChats(free({attempt_id: ATTEMPT, finalized_at: '2026-11-18T01:00:00Z', chats: [reported('aaaa', 'say ok', 10, 12)], archived_chats: {'claude:aaaa': '2026-11-18T02:00:00Z'}}));
    const later = {...reported('aaaa', 'say ok', 10, 40), ended_at: '2026-11-18T03:00:00Z'};
    const two = terminalChats(free({attempt_id: OTHER, finalized_at: '2026-11-18T03:00:00Z', chats: [later], resumable: false}));
    const [chat] = memberChats([two, one]);
    assert.deepEqual([chat.attemptId, chat.title, chat.archivedAt, chat.resumable, chat.usage.durationS], [OTHER, 'say ok', null, false, {sum: 32, count: 1}]);
  });
});
