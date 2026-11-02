import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {VERBS} from '../../../../../../src/components/CommandBar/verbs.js';
import {runCommand} from '../../../../../../src/components/CommandBar/commandRuntime.js';
import {AI, callsTo, makeCtx, spoke} from './_fakeCtx.mjs';

const verb = name => VERBS.find(command => command.name === name);
const run = async (name, argLine, options) => {
  const made = makeCtx(options);
  await runCommand(verb(name), argLine, made.ctx);
  return made;
};

describe('agent runtime commands', () => {
  it('exposes only /model', () => {
    assert.deepEqual(VERBS.map(command => command.name), ['model']);
  });

  it('offers the chat models it may switch to, the current one first', () => {
    const {ctx} = makeCtx({chatItem: {id: 'chat-1', agentId: 'mochi', modelChoice: {key: 'openrouter/org/smart', choice: {provider: 'openrouter', model: 'org/smart'}}}});
    assert.deepEqual(verb('model').options(ctx).map(option => [option.value, option.current]), [['openrouter/org/smart', true], ['openrouter/org/fast', false]]);
  });

  it('shows the model a chat runs on: its own choice, else the member\'s, else the default', async () => {
    assert.match((await run('model', '')).log.notes[0], /model: Fast \(openrouter\)/);
    // The member's own model is one their server serves.
    const served = {key: 'vllm/org/served', choice: {provider: 'vllm', model: 'org/served'}, label: 'Served', provider: 'vllm', providerName: 'vLLM', model: 'org/served', uses: ['chat', 'inline', 'apps'], available: true};
    const mine = {...AI, models: [...AI.models, served], settings: {...AI.settings, model: {provider: 'vllm', model: 'org/served'}}};
    assert.match((await run('model', '', {ai: mine})).log.notes[0], /model: Served \(vLLM\)/);
    const own = {id: 'chat-1', agentId: 'mochi', modelChoice: {key: 'openrouter/org/smart', choice: {provider: 'openrouter', model: 'org/smart'}}};
    assert.match((await run('model', '', {chatItem: own})).log.notes[0], /model: Smart/);
  });

  it('switches this chat\'s model by name, key or model id', async () => {
    for (const name of ['openrouter/org/smart', 'Smart', 'org/smart']) {
      const switched = await run('model', name);
      assert.deepEqual(callsTo(switched.log, 'setChatModel'), [
        ['setChatModel', 'chat-1', {key: 'openrouter/org/smart', choice: {provider: 'openrouter', model: 'org/smart'}}],
      ]);
      assert.deepEqual(switched.log.notes, ['model: Smart (openrouter)']);
    }
  });

  it('refuses unknown, unavailable, and non-chat models, and panes without an open agent chat', async () => {
    assert.match((await run('model', 'missing')).log.fails[0], /no model matches missing/);
    assert.match((await run('model', 'org/apps')).log.fails[0], /no model matches/);
    const off = await run('model', 'off');
    assert.deepEqual(off.log.fails, ['/model off: unavailable: Needs your OpenRouter key: add it under API keys']);
    assert.deepEqual(callsTo(off.log, 'setChatModel'), []);
    const closed = await run('model', '', {target: null});
    assert.deepEqual(closed.log.fails, ['/model needs an open agent chat']);
  });

  it('always answers and keeps command ids unique', async () => {
    for (const command of VERBS) {
      const made = await run(command.name, '');
      assert.ok(spoke(made.log).length > 0, `/${command.name} said nothing`);
    }
    assert.equal(VERBS.length, new Set(VERBS.map(command => command.id)).size);
  });
});
