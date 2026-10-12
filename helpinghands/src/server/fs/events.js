'use strict';

/**
 * Each workspace's push channel: the streams behind GET /api/fs/events
 * (routes/fs.js), one per open browser.
 *
 * The file system calls `changed(workspaceId)` after every transaction that
 * logged a change (fs/store.js). Each of the workspace's streams then waits
 * BATCH_MS, so a burst (a folder moved, an agent run written back) arrives as
 * one batch, and reads the change feed after its cursor as its own member:
 * row-level security decides what a stream is told, as it does for /changes.
 * A batch is structural when it creates, deletes, moves, restores or changes
 * the access of anything, and content-only when every change is a write.
 *
 * The same stream carries live Markdown editing (fs/crdt.js): it follows the
 * files its browser has open live and receives their merged Yjs updates. One
 * process holds the streams; a deployment with several would relay through
 * PostgreSQL LISTEN/NOTIFY instead.
 */
const crypto = require('crypto');
const {FsError} = require('./store');

const BATCH_MS = 300;

/** What a stream is told about one change: `rev` is the node's revision after it. */
const eventOf = change => ({
  seq: change.seq, nodeId: change.nodeId, op: change.op, kind: change.kind, path: change.path,
  fromPath: change.fromPath, rev: change.seq,
});

function createFsHub({fs, batchMs = BATCH_MS}) {
  const workspaces = new Map();
  const streamsOf = workspaceId => workspaces.get(workspaceId)?.values() ?? [];

  function owned(scope, id) {
    const stream = workspaces.get(scope.workspaceId)?.get(id);
    if (stream && stream.scope.userId !== scope.userId) throw new FsError(404, 'no-stream', 'No such event stream');
    return stream ?? null;
  }

  async function deliver(stream) {
    stream.timer = null;
    if (stream.reading) {
      stream.again = true;
      return;
    }
    stream.reading = true;
    const changes = [];
    try {
      for (;;) {
        const page = await fs.changes(stream.scope, {since: stream.cursor});
        changes.push(...page.changes);
        stream.cursor = page.cursor;
        if (!page.more) break;
      }
    } catch (error) {
      // The browser reconnects and reads what it missed from /changes.
      console.error('[fs] Could not read the change feed for an event stream:', error);
      stream.close();
      return;
    } finally {
      stream.reading = false;
    }
    if (changes.length) {
      stream.send('changes', {
        cursor: stream.cursor, structural: changes.some(change => change.op !== 'write'), changes: changes.map(eventOf),
      });
    }
    if (stream.again && !stream.stopped) {
      stream.again = false;
      schedule(stream);
    }
  }

  function schedule(stream) {
    stream.timer ??= setTimeout(() => deliver(stream), batchMs);
  }

  return Object.freeze({
    /**
     * Open a stream for `scope` whose change feed starts after `cursor`.
     * `send(event, data)` writes to it; `close()` ends it.
     */
    listen(scope, cursor, send, close) {
      const stream = {
        id: crypto.randomUUID(), scope, cursor, send, close, follows: new Set(),
        timer: null, reading: false, again: false, stopped: false,
      };
      if (!workspaces.has(scope.workspaceId)) workspaces.set(scope.workspaceId, new Map());
      workspaces.get(scope.workspaceId).set(stream.id, stream);
      return {
        id: stream.id,
        stop() {
          stream.stopped = true;
          clearTimeout(stream.timer);
          const streams = workspaces.get(scope.workspaceId);
          streams?.delete(stream.id);
          if (!streams?.size) workspaces.delete(scope.workspaceId);
        },
      };
    },

    /** Something in the workspace changed: each of its streams reads the feed shortly. */
    changed(workspaceId) {
      for (const stream of streamsOf(workspaceId)) schedule(stream);
    },

    /** Send the caller's stream `id` the live updates of the node `nodeId`. */
    follow(scope, id, nodeId) {
      const stream = owned(scope, id);
      if (!stream) throw new FsError(404, 'no-stream', 'No such event stream');
      stream.follows.add(nodeId);
    },

    /** Stop sending `nodeId`'s updates to the caller's stream `id`; nothing to stop once the stream is gone. */
    unfollow(scope, id, nodeId) {
      owned(scope, id)?.follows.delete(nodeId);
    },

    followed: (workspaceId, nodeId) => [...streamsOf(workspaceId)].some(stream => stream.follows.has(nodeId)),

    /**
     * Send `update` to every stream following the node, its sender's included:
     * applying one twice changes nothing. `rev` is the file revision it brings
     * the document to.
     */
    broadcast(workspaceId, nodeId, update, rev) {
      if (!update || update.length <= 2) return;
      const data = {nodeId, update: Buffer.from(update).toString('base64'), rev};
      for (const stream of streamsOf(workspaceId)) {
        if (stream.follows.has(nodeId)) stream.send('update', data);
      }
    },
  });
}

module.exports = {BATCH_MS, createFsHub};
