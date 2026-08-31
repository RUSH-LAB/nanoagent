import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

import {runCommand} from '../../../../../../src/components/CommandBar/commandRuntime.js';

/** A context that records what a command said and did, in the order it did it. */
function makeCtx() {
  const log = {notes: [], fails: [], navigated: []};
  return {
    log,
    ctx: {
      session: {id: 's1', target: null},
      commands: [],
      navigate: (href) => log.navigated.push(href),
      note: (text) => log.notes.push(text),
      fail: (text) => log.fails.push(text),
    },
  };
}

describe('runCommand', () => {
  it('does nothing at all when there is no command', async () => {
    const {ctx, log} = makeCtx();
    await runCommand(null, 'anything', ctx);
    assert.deepEqual(log, {notes: [], fails: [], navigated: []});
  });

  it('says where it is going before going there', async () => {
    const {ctx, log} = makeCtx();
    await runCommand({name: 'people', title: 'People', href: '/people'}, '', ctx);
    assert.deepEqual(log.notes, ['opening People']);
    assert.deepEqual(log.navigated, ['/people']);
  });

  it('hands a verb the context and the raw argument line', async () => {
    const {ctx} = makeCtx();
    const seen = [];
    await runCommand({name: 'topic', run: (c, argLine) => seen.push([c, argLine])}, 'a  b', ctx);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], ctx);
    assert.equal(seen[0][1], 'a  b');
  });

  it('gives a verb an empty line rather than undefined when there are no arguments', async () => {
    const {ctx} = makeCtx();
    let seen = null;
    await runCommand({name: 'who', run: (_c, argLine) => { seen = argLine; }}, undefined, ctx);
    assert.equal(seen, '');
  });

  it('waits for an async verb to finish', async () => {
    const {ctx, log} = makeCtx();
    await runCommand({
      name: 'join',
      run: async (c) => {
        await Promise.resolve();
        c.note('joined #design');
      },
    }, '', ctx);
    assert.deepEqual(log.notes, ['joined #design']);
  });

  it('reports a throw into the pane instead of into React', async () => {
    const {ctx, log} = makeCtx();
    await runCommand({name: 'kick', run: () => { throw new Error('Only the owner can do that'); }}, '', ctx);
    assert.deepEqual(log.fails, ['Only the owner can do that']);
  });

  it('reports a rejected promise the same way', async () => {
    const {ctx, log} = makeCtx();
    await runCommand({name: 'leave', run: async () => { throw new Error('Channel not found'); }}, '', ctx);
    assert.deepEqual(log.fails, ['Channel not found']);
  });

  it('names the command when a failure carries no sentence', async () => {
    const {ctx, log} = makeCtx();
    await runCommand({name: 'add', run: () => { throw new Error(''); }}, '', ctx);
    assert.deepEqual(log.fails, ['/add failed']);
  });

  it('refuses a registry entry that is neither a place nor a verb', async () => {
    const {ctx, log} = makeCtx();
    await runCommand({name: 'ghost'}, '', ctx);
    assert.deepEqual(log.fails, ['/ghost has nothing to do']);
  });
});
