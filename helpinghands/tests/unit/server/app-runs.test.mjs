/**
 * server/app-runs.js: a plugin run outlives its page and this process. These
 * are the runs a Mochi started since finds in PostgreSQL: taken up again where
 * the member's computer still holds them, and otherwise recorded as
 * interrupted, never left to vanish. The computer's side is runner.test.mjs.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {makeCtx, fakeSessions, SESSION} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {createAppRuns} = require('../../../src/server/app-runs.js');
const {HOLD_MS} = require('../../../src/runner/protocol.js');

const CONTEXT = {userId: 'test-user', workspaceId: 'lab'};
const until = async test => {
  for (let i = 0; i < 200 && !test(); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(test(), 'timed out');
};

/** Runs as a Mochi started since sees them: `rows` already in PostgreSQL, none of them this process's. */
function restarted(rows = [{id: 'run-1', folder: 'folder-1', sent: {'a.md': {rev: 1, contentHash: 'x'}}}]) {
  const ctx = makeCtx();
  const sessions = fakeSessions();
  for (const row of rows) {
    sessions.rows.set(row.id, {
      workspaceId: 'lab', userId: 'test-user', sessionId: SESSION, pluginId: 'echo', prompt: 'save it',
      install: 'a'.repeat(64), runner: 'computer', ran: true, ...row,
    });
  }
  const finished = [];
  const released = [];
  const asked = [];
  const ai = {
    stream: async request => {
      asked.push(request);
      request.onDelta('Saved');
      return {text: 'Saved it.'};
    },
  };
  const runs = createAppRuns({
    sessions,
    agentSync: {prepare: async () => assert.fail('a run taken up again has its folder'), finish: async (_scope, _ai, pluginId, folder) => finished.push({pluginId, ...folder})},
    runners: {computer: () => ai, release: (userId, id) => released.push([userId, id])},
    aiMeter: ctx.aiMeter,
  });
  return {runs, sessions, finished, released, asked, usage: ctx.calls.aiUsage};
}

describe('plugin runs a restarted Mochi finds', () => {
  it('takes up a run the member\'s computer still holds, from its first frame, and ends it', async () => {
    const {runs, sessions, finished, released, asked, usage} = restarted();
    const events = [];
    // A page opened before the computer was back follows the run once it is taken up.
    runs.subscribe(SESSION, event => events.push(event), () => events.push('end'));
    await runs.adopt('test-user', ['run-1']);
    await until(() => events.includes('end'));
    assert.deepEqual(asked.map(({run, workspace, install, app}) => ({run, workspace, install, app})), [
      {run: {id: 'run-1', resume: true}, workspace: 'folder-1', install: 'a'.repeat(64), app: 'echo'},
    ]);
    assert.deepEqual(events, ['delta', 'done', 'end']);
    assert.deepEqual(finished, [{pluginId: 'echo', workspace: 'folder-1', sent: {'a.md': {rev: 1, contentHash: 'x'}}}]);
    assert.deepEqual(sessions.turns.map(({prompt, answer, error}) => ({prompt, answer, error})), [{prompt: 'save it', answer: 'Saved it.', error: null}]);
    assert.equal(sessions.rows.size, 0);
    assert.deepEqual(released, [['test-user', 'run-1']]);
    assert.equal(usage[0].sessionId, SESSION);
  });

  it('records as interrupted a run the computer does not hold any more, writing back what it did', async () => {
    const {runs, sessions, finished, asked, usage} = restarted();
    const events = [];
    runs.subscribe(SESSION, (event, data) => events.push([event, data.error]), () => events.push('end'));
    await runs.adopt('test-user', []);
    const reason = 'RUSH Lab stopped while answering, so this message was not answered. Send it again.';
    assert.deepEqual(events, [['error', reason], 'end']);
    assert.deepEqual(asked, []);
    assert.equal(finished.length, 1);
    assert.deepEqual(sessions.turns.map(({answer, error}) => ({answer, error})), [{answer: '', error: reason}]);
    // It got far enough to cost something.
    assert.equal(usage[0].ran, true);
  });

  it('lets go of a run the computer holds that Mochi has no record of', async () => {
    const {runs, released} = restarted([]);
    await runs.adopt('test-user', ['run-9']);
    assert.deepEqual(released, [['test-user', 'run-9']]);
  });

  it('records a run as interrupted once its computer has had HOLD_MS to come back', async (t) => {
    t.mock.timers.enable({apis: ['Date']});
    const {runs, sessions} = restarted();
    await runs.settle(CONTEXT);
    assert.equal(sessions.rows.size, 1, 'the computer may still come back');
    t.mock.timers.tick(HOLD_MS);
    await runs.settle(CONTEXT);
    assert.equal(sessions.rows.size, 0);
    assert.match(sessions.turns[0].error, /RUSH Lab was not back within 10 minutes/);
  });

  it('stops a run nobody has taken up yet', async () => {
    const {runs, sessions} = restarted();
    assert.equal(await runs.cancel(CONTEXT, SESSION), true);
    assert.equal(sessions.turns[0].error, 'Stopped before RUSH Lab was back.');
    assert.equal(await runs.cancel(CONTEXT, SESSION), false);
  });
});

describe('plugin runs in RUSH Lab cloud beside runs on computers', () => {
  /**
   * App runs over fake sessions whose member's computer is whatever `computer()`
   * gives now, recording which NanoAgent each run folder is prepared on and
   * written back from, by its `name`.
   */
  function runsWith(computer = () => null) {
    const ctx = makeCtx();
    const sessions = fakeSessions();
    const started = [];
    const startRun = sessions.startRun;
    sessions.startRun = async (context, pluginId, sessionId, run) => {
      started.push(run);
      return startRun(context, pluginId, sessionId, run);
    };
    const prepared = [];
    const finished = [];
    const released = [];
    const runs = createAppRuns({
      sessions,
      agentSync: {
        prepare: async (_context, on) => {
          prepared.push(on.name);
          return {workspace: `folder-${prepared.length}`, sent: {}};
        },
        finish: async (_context, on, _pluginId, folder) => finished.push({on: on.name, workspace: folder.workspace}),
      },
      runners: {computer, release: (userId, id) => released.push([userId, id])},
      aiMeter: ctx.aiMeter,
    });
    return {runs, sessions, started, prepared, finished, released, usage: ctx.calls.aiUsage};
  }

  /** A NanoAgent named for where it is, `local` when it is the member's computer's; `gate`, when given, holds each run until it resolves. */
  const nanoagent = (name, local, gate = null) => ({
    name,
    local,
    asked: [],
    async stream(request) {
      this.asked.push(request);
      if (gate) await gate;
      request.onDelta('Saved');
      return {text: 'Saved it.', cost: 0.02, model: 'deepseek/deepseek-v4-flash-0731'};
    },
  });
  const REQUEST = {input: 'save it', install: 'a'.repeat(64)};

  it('does a cloud run in RUSH Lab cloud to its end, written back and charged there, with no computer told', async () => {
    const laptop = nanoagent('laptop', true);
    const {runs, sessions, started, prepared, finished, released, usage} = runsWith(() => laptop);
    const cloud = nanoagent('cloud', false);
    const run = await runs.start(CONTEXT, {pluginId: 'echo', sessionId: SESSION, prompt: 'save it', request: REQUEST, ai: cloud});
    await run.ended;
    assert.deepEqual(started.map(one => one.runner), ['cloud']);
    assert.deepEqual(prepared, ['cloud']);
    assert.deepEqual(finished, [{on: 'cloud', workspace: 'folder-1'}]);
    assert.equal(cloud.asked.length, 1);
    assert.equal(cloud.asked[0].workspace, 'folder-1');
    assert.deepEqual(laptop.asked, []);
    assert.deepEqual(released, []);
    assert.deepEqual(sessions.turns.map(({answer, error}) => ({answer, error})), [{answer: 'Saved it.', error: null}]);
    assert.deepEqual(usage.map(({kind, local, ran, result}) => ({kind, local, ran, cost: result.cost})), [{kind: 'app', local: false, ran: true, cost: 0.02}]);
  });

  it('writes a cloud run back from RUSH Lab cloud though its member\'s computer connects mid-run', async () => {
    let connected = null;
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    const {runs, finished, released} = runsWith(() => connected);
    const cloud = nanoagent('cloud', false, gate);
    const run = await runs.start(CONTEXT, {pluginId: 'echo', sessionId: SESSION, prompt: 'save it', request: REQUEST, ai: cloud});
    await until(() => cloud.asked.length === 1);
    connected = nanoagent('laptop', true);
    open();
    await run.ended;
    assert.deepEqual(finished, [{on: 'cloud', workspace: 'folder-1'}]);
    assert.deepEqual(connected.asked, []);
    assert.deepEqual(released, []);
  });

  it('writes a computer run back from the computer as it is connected now, then lets the computer forget it', async () => {
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    const first = nanoagent('laptop, first connection', true, gate);
    let now = first;
    const {runs, started, prepared, finished, released, usage} = runsWith(() => now);
    const run = await runs.start(CONTEXT, {pluginId: 'echo', sessionId: SESSION, prompt: 'save it', request: REQUEST, ai: first});
    await until(() => first.asked.length === 1);
    // The computer reconnects mid-run: the run, held, follows it; its folder is written back over the new connection.
    now = nanoagent('laptop, second connection', true);
    open();
    await run.ended;
    assert.deepEqual(started.map(one => one.runner), ['computer']);
    assert.deepEqual(prepared, ['laptop, first connection']);
    assert.deepEqual(finished, [{on: 'laptop, second connection', workspace: 'folder-1'}]);
    assert.equal(first.asked[0].run.resume, false);
    assert.equal(released.length, 1);
    assert.equal(released[0][0], 'test-user');
    assert.deepEqual(usage.map(({local}) => local), [true]);
  });

  it('records at once a cloud run an earlier Mochi was doing as stopped by RUSH Lab cloud, writing nothing back and charging its workspace', async () => {
    const laptop = nanoagent('laptop', true);
    const {runs, sessions, finished, released, usage} = runsWith(() => laptop);
    sessions.rows.set('run-cloud', {
      id: 'run-cloud', workspaceId: 'lab', userId: 'test-user', sessionId: SESSION, pluginId: 'echo', prompt: 'save it',
      install: 'a'.repeat(64), runner: 'cloud', folder: 'folder-cloud', sent: {'a.md': {rev: 1, contentHash: 'x'}}, ran: true,
      startedAt: new Date(Date.now() - 60_000),
    });
    // The member's computer says hello holding nothing: a cloud run is no computer's to hand over.
    await runs.adopt('test-user', []);
    assert.equal(sessions.rows.size, 1);
    // Nothing holds a cloud run across a restart, so it is not given HOLD_MS to come back: the
    // member's session takes a new message as soon as they open it.
    await runs.settle(CONTEXT);
    assert.equal(sessions.rows.size, 0);
    assert.deepEqual(sessions.turns.map(({prompt, answer, error}) => ({prompt, answer, error})), [
      {prompt: 'save it', answer: '', error: 'RUSH Lab cloud stopped while answering, so this message was not answered. Send it again.'},
    ]);
    assert.deepEqual(finished, []);
    assert.deepEqual(laptop.asked, []);
    assert.deepEqual(released, []);
    assert.deepEqual(usage.map(({local, ran, result}) => ({local, ran, result})), [{local: false, ran: true, result: null}]);
  });

  it('leaves a cloud run this process started to it, until it ends, though it is not followed yet', async () => {
    const {runs, sessions, usage} = runsWith();
    // Kept a moment ago by this process's start, which follows it once it hears back.
    sessions.rows.set('run-new', {
      id: 'run-new', workspaceId: 'lab', userId: 'test-user', sessionId: SESSION, pluginId: 'echo', prompt: 'save it',
      install: 'a'.repeat(64), runner: 'cloud', folder: null, sent: null, ran: false, startedAt: new Date(),
    });
    await runs.settle(CONTEXT);
    assert.equal(sessions.rows.size, 1);
    assert.deepEqual(sessions.turns, []);
    assert.deepEqual(usage, []);
  });

  it('charges a cloud run stopped while its first tool runs, as the model answered with that call, and not one stopped before', async () => {
    const {runs, usage} = runsWith();
    // What NanoAgent streams: the run starts, the model answers with a tool call, and the run is
    // stopped while the tool runs, before the step is priced.
    const stopped = events => ({
      name: 'cloud', local: false,
      async stream(request) {
        for (const event of events) request.onEvent(event);
        throw new Error('Agent run was cancelled');
      },
    });
    const first = await runs.start(CONTEXT, {pluginId: 'echo', sessionId: SESSION, prompt: 'save it', request: REQUEST,
      ai: stopped([{type: 'run.started', runId: 'r1'}, {type: 'tool.started', runId: 'r1', call: {id: 'c1', name: 'probe'}}])});
    await first.ended;
    const second = await runs.start(CONTEXT, {pluginId: 'echo', sessionId: SESSION, prompt: 'save it', request: REQUEST,
      ai: stopped([{type: 'run.started', runId: 'r2'}])});
    await second.ended;
    assert.deepEqual(usage.map(({local, ran, result}) => ({local, ran, priced: result?.cost != null})), [
      {local: false, ran: true, priced: false},
      {local: false, ran: false, priced: false},
    ]);
  });

  it('stops a cloud run nobody is doing with the same words, when its member cancels it', async () => {
    const {runs, sessions, usage} = runsWith();
    sessions.rows.set('run-cloud', {
      id: 'run-cloud', workspaceId: 'lab', userId: 'test-user', sessionId: SESSION, pluginId: 'echo', prompt: 'save it',
      install: 'a'.repeat(64), runner: 'cloud', folder: null, sent: null, ran: false,
    });
    assert.equal(await runs.cancel(CONTEXT, SESSION), true);
    assert.match(sessions.turns[0].error, /^RUSH Lab cloud stopped while answering/);
    assert.deepEqual(usage.map(({local, ran}) => ({local, ran})), [{local: false, ran: false}]);
  });

  it('takes up the computer runs its computer holds, on that computer, and never a cloud run', async () => {
    const laptop = nanoagent('laptop', true);
    const {runs, sessions, finished} = runsWith(() => laptop);
    const row = (id, runner) => ({
      id, workspaceId: 'lab', userId: 'test-user', sessionId: `session-${id}`, pluginId: 'echo', prompt: id,
      install: 'a'.repeat(64), runner, folder: `folder-${id}`, sent: {}, ran: true,
    });
    sessions.rows.set('held', row('held', 'computer'));
    sessions.rows.set('cloudy', {...row('cloudy', 'cloud'), startedAt: new Date(Date.now() - 60_000)});
    // Even were a computer to name a cloud run, that run is not its to resume, nor to end.
    await runs.adopt('test-user', ['held', 'cloudy']);
    await until(() => sessions.turns.length === 1);
    assert.ok(sessions.rows.has('cloudy'));
    await runs.settle(CONTEXT);
    assert.equal(sessions.turns.length, 2);
    assert.deepEqual(laptop.asked.map(request => [request.run, request.workspace]), [[{id: 'held', resume: true}, 'folder-held']]);
    assert.deepEqual(finished, [{on: 'laptop', workspace: 'folder-held'}]);
    const byPrompt = Object.fromEntries(sessions.turns.map(turn => [turn.prompt, turn]));
    assert.equal(byPrompt.held.answer, 'Saved it.');
    assert.match(byPrompt.cloudy.error, /^RUSH Lab cloud stopped while answering/);
  });

  it('leaves every run alone when the computer that said hello is gone again by the time it is heard', async () => {
    const {runs, sessions, finished, released} = runsWith(() => null);
    sessions.rows.set('held', {
      id: 'held', workspaceId: 'lab', userId: 'test-user', sessionId: SESSION, pluginId: 'echo', prompt: 'save it',
      install: 'a'.repeat(64), runner: 'computer', folder: 'folder-held', sent: {}, ran: true,
    });
    await runs.adopt('test-user', ['held', 'unknown']);
    assert.equal(sessions.rows.size, 1);
    assert.deepEqual(sessions.turns, []);
    assert.deepEqual(finished, []);
    assert.deepEqual(released, []);
  });
});
