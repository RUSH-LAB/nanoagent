import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {VERBS} from '../../../../../../src/components/CommandBar/verbs.js';
import {runCommand} from '../../../../../../src/components/CommandBar/commandRuntime.js';
import {callsTo, makeCtx, spoke} from './_fakeCtx.mjs';

const verb = name => VERBS.find(command => command.name === name);
const run = async (name, argLine, options) => {
  const made = makeCtx(options);
  await runCommand(verb(name), argLine, made.ctx);
  return made;
};

describe('agent runtime commands', () => {
  it('exposes only /harness and /model', () => {
    assert.deepEqual(VERBS.map(command => command.name), ['harness', 'model']);
  });

  it('builds picker rows with the current choice first and availability visible', () => {
    const {ctx} = makeCtx();
    assert.deepEqual(verb('harness').options(ctx).map(option => ({
      value: option.value, current: option.current, available: option.available,
    })), [
      {value: 'nanoagent', current: true, available: true},
      {value: 'hermes', current: false, available: true},
      {value: 'pi', current: false, available: false},
    ]);
    assert.deepEqual(verb('model').options(ctx).map(option => option.name), ['fast', 'smart']);
  });

  it('shows and switches the harness while preserving the current model', async () => {
    const shown = await run('harness', '');
    assert.match(shown.log.notes[0], /harness: NanoAgent/);
    assert.match(shown.log.notes[0], /Hermes Agent/);

    const switched = await run('harness', 'hermes');
    assert.deepEqual(callsTo(switched.log, 'setChatProfile'), [
      ['setChatProfile', 'chat-1', 'hermes-fast'],
    ]);
    assert.deepEqual(switched.log.notes, ['harness: Hermes Agent · model: fast']);
  });

  it('accepts NanoAgent as the public name of the native harness', async () => {
    const made = makeCtx({chatItem: {
      id: 'chat-1', agentId: 'mochi', profileId: 'hermes-smart',
    }});
    await runCommand(verb('harness'), 'NanoAgent', made.ctx);
    assert.deepEqual(callsTo(made.log, 'setChatProfile'), [
      ['setChatProfile', 'chat-1', 'native-smart'],
    ]);
  });

  it('refuses an unavailable or unknown harness', async () => {
    const unavailable = await run('harness', 'pi');
    assert.deepEqual(unavailable.log.fails, [
      '/harness pi: unavailable: PI runner is not installed',
    ]);
    assert.deepEqual(callsTo(unavailable.log, 'setChatProfile'), []);

    const unknown = await run('harness', 'other');
    assert.match(unknown.log.fails[0], /choose one of/);
  });

  it('shows and switches models within the current harness', async () => {
    const shown = await run('model', '');
    assert.match(shown.log.notes[0], /model: fast/);
    assert.match(shown.log.notes[0], /smart/);

    const switched = await run('model', 'smart');
    assert.deepEqual(callsTo(switched.log, 'setChatProfile'), [
      ['setChatProfile', 'chat-1', 'native-smart'],
    ]);
    assert.deepEqual(switched.log.notes, ['model: smart · harness: NanoAgent']);
  });

  it('refuses unknown models and panes without an open agent chat', async () => {
    const unknown = await run('model', 'missing');
    assert.match(unknown.log.fails[0], /choose one of fast, smart/);

    for (const name of ['harness', 'model']) {
      const closed = await run(name, '', {target: null});
      assert.deepEqual(closed.log.fails, [`/${name} needs an open agent chat`]);
    }
  });

  it('always answers and keeps command ids unique', async () => {
    for (const command of VERBS) {
      const made = await run(command.name, '');
      assert.ok(spoke(made.log).length > 0, `/${command.name} said nothing`);
    }
    assert.equal(VERBS.length, new Set(VERBS.map(command => command.id)).size);
  });
});
