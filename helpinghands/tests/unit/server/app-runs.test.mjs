/**
 * server/app-runs.js: a plugin run outlives its page and this process. These
 * are the runs a RUSH started since finds in PostgreSQL: taken up again where
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

/** Runs as a RUSH started since sees them: `rows` already in PostgreSQL, none of them this process's. */
function restarted(rows = [{id: 'run-1'}], stream = null) {
  const ctx = makeCtx();
  const sessions = fakeSessions();
  for (const row of rows) {
    sessions.rows.set(row.id, {
      workspaceId: 'lab', userId: 'test-user', sessionId: SESSION, pluginId: 'echo', prompt: 'save it',
      install: 'a'.repeat(64), ran: true, ...row,
    });
  }
  const released = [];
  const asked = [];
  const ai = {
    stream: async request => {
      asked.push(request);
      if (stream) return stream(request);
      request.onDelta('Saved');
      return {text: 'Saved it.'};
    },
  };
  const runs = createAppRuns({
    sessions,
    runners: {aiFor: async () => ai, release: (userId, id) => released.push([userId, id])},
    aiMeter: ctx.aiMeter,
  });
  return {runs, sessions, released, asked, usage: ctx.calls.aiUsage};
}

describe('plugin runs a restarted RUSH finds', () => {
  it('takes up a run the member\'s computer still holds, from its first frame, and ends it', async () => {
    const {runs, sessions, released, asked, usage} = restarted();
    const events = [];
    // A page opened before the computer was back follows the run once it is taken up.
    runs.subscribe(SESSION, event => events.push(event), () => events.push('end'));
    await runs.adopt('test-user', ['run-1']);
    await until(() => events.includes('end'));
    // On the member's files for the plugin in its workspace, which their computer keeps.
    assert.deepEqual(asked.map(({run, workspace, files, install, app}) => ({run, workspace, files, install, app})), [
      {run: {id: 'run-1', resume: true}, workspace: 'run-1', files: {workspace: 'lab', plugin: 'echo'}, install: 'a'.repeat(64), app: 'echo'},
    ]);
    assert.deepEqual(events, ['delta', 'done', 'end']);
    assert.deepEqual(sessions.turns.map(({prompt, answer, error}) => ({prompt, answer, error})), [{prompt: 'save it', answer: 'Saved it.', error: null}]);
    assert.equal(sessions.rows.size, 0);
    assert.deepEqual(released, [['test-user', 'run-1']]);
    assert.equal(usage[0].sessionId, SESSION);
  });

  it('keeps a run\'s graph and trajectory with its turn, sending the page the graph only', async () => {
    const graph = {nodes: [], edges: []};
    const trajectory = {schema_version: 'ATIF-v1.8', steps: []};
    const {runs, sessions} = restarted(undefined, request => {
      request.onEvent({type: 'graph.completed', graph});
      request.onEvent({type: 'trajectory.completed', trajectory});
      return {text: 'Saved it.'};
    });
    const events = [];
    runs.subscribe(SESSION, (event, data) => events.push([event, data?.type]), () => events.push('end'));
    await runs.adopt('test-user', ['run-1']);
    await until(() => events.includes('end'));
    assert.deepEqual(sessions.turns.map(turn => [turn.graph, turn.trajectory]), [[graph, trajectory]]);
    assert.deepEqual(events.filter(event => event[0] === 'agent').map(event => event[1]), ['graph.completed']);
  });

  it('records as interrupted a run the computer does not hold any more', async () => {
    const {runs, sessions, asked, usage} = restarted();
    const events = [];
    runs.subscribe(SESSION, (event, data) => events.push([event, data.error]), () => events.push('end'));
    await runs.adopt('test-user', []);
    const reason = 'RUSH Lab stopped while answering, so this message was not answered. Send it again.';
    assert.deepEqual(events, [['error', reason], 'end']);
    assert.deepEqual(asked, []);
    assert.deepEqual(sessions.turns.map(({answer, error}) => ({answer, error})), [{answer: '', error: reason}]);
    // It got far enough to cost something.
    assert.equal(usage[0].ran, true);
  });

  it('lets go of a run the computer holds that RUSH has no record of', async () => {
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
