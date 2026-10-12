import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

const {followWorkspaceChanges} = await import('../../../src/utils/fsEvents.js');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A push channel the test drives: `handlers` are what followWorkspaceChanges subscribed. */
function fakeChannel() {
  const channel = {handlers: null, closed: false};
  channel.subscribe = (workspaceId, handlers) => {
    assert.equal(workspaceId, 'lab');
    channel.handlers = handlers;
    return {stream: () => null, cursor: () => channel.cursor ?? null, close: () => { channel.closed = true; }};
  };
  return channel;
}

const change = seq => ({seq, op: 'write', path: `f${seq}.md`});

describe('followWorkspaceChanges', () => {
  it('hands on each batch, and after a reconnection what was missed first, while newer batches wait', async () => {
    const channel = fakeChannel();
    const seen = [];
    const reads = [];
    let finish = null;
    const stop = followWorkspaceChanges('lab', {
      changes: list => seen.push(list.map(item => item.seq)),
      missed: (since, until) => {
        reads.push([since, until]);
        return new Promise(resolve => { finish = resolve; });
      },
      failed: error => assert.fail(error),
    }, channel.subscribe);
    channel.handlers.ready({stream: 's1', cursor: 2});
    channel.handlers.changes({cursor: 3, changes: [change(3)]});
    channel.handlers.ready({stream: 's2', cursor: 6});
    channel.handlers.changes({cursor: 7, changes: [change(7)]});
    assert.deepEqual(reads, [[3, 6]]);
    assert.deepEqual(seen, [[3]]);
    finish([change(4), change(6)]);
    await settle();
    assert.deepEqual(seen, [[3], [4, 6, 7]]);
    channel.handlers.changes({cursor: 8, changes: [change(8)]});
    assert.deepEqual(seen, [[3], [4, 6, 7], [8]]);
    stop();
    assert.equal(channel.closed, true);
  });

  it('reports a failed catch-up and goes on from the new connection', async () => {
    const channel = fakeChannel();
    const seen = [];
    const failures = [];
    followWorkspaceChanges('lab', {
      changes: list => seen.push(list.map(item => item.seq)),
      missed: () => Promise.reject(new Error('offline')),
      failed: error => failures.push(error.message),
    }, channel.subscribe);
    channel.handlers.ready({stream: 's1', cursor: 1});
    channel.handlers.ready({stream: 's2', cursor: 5});
    channel.handlers.changes({cursor: 6, changes: [change(6)]});
    await settle();
    assert.deepEqual(failures, ['offline']);
    assert.deepEqual(seen, [[6]]);
  });

  it('follows a channel that was already connected from where it is, and catches up after its reconnection', async () => {
    const channel = fakeChannel();
    channel.cursor = 4;
    const reads = [];
    followWorkspaceChanges('lab', {
      changes: () => {},
      missed: async (since, until) => { reads.push([since, until]); return []; },
      failed: error => assert.fail(error),
    }, channel.subscribe);
    channel.handlers.ready({stream: 's2', cursor: 9});
    await settle();
    assert.deepEqual(reads, [[4, 9]]);
  });
});
