/**
 * A workspace's push channel (GET /fs/events, src/server/fs/events.js): one
 * EventSource per workspace, shared by everything on the page that follows it.
 *
 * Each connection, the first and every reconnection, starts with `ready`,
 * `{stream, cursor}`, which names the stream and where its feed starts; what
 * was missed meanwhile is read from /changes.
 * Then come `changes` batches, `{cursor, structural, changes}`, each change
 * `{seq, nodeId, op, kind, path, fromPath, rev}`, and `update`, a live
 * Markdown file's merged Yjs update `{nodeId, update, rev}`, for the files the
 * stream follows (liveDocument.js).
 */
import API_BASE from './api.js';

const channels = new Map();

/**
 * Follow `workspaceId`'s channel with `handlers` named by event (`ready`,
 * `changes`, `update`, and `closed` when the server refused the stream, which
 * is not retried). `stream()` is the connected stream's id, or null, and
 * `cursor()` where the changes it has handed on end, or null before `ready`.
 */
export function subscribeWorkspace(workspaceId, handlers) {
  let channel = channels.get(workspaceId);
  if (!channel) {
    const source = new EventSource(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/fs/events`, {
      withCredentials: true,
    });
    channel = {source, stream: null, cursor: null, handlers: new Set()};
    const current = channel;
    const each = (name, data) => { for (const handler of [...current.handlers]) handler[name]?.(data); };
    source.addEventListener('ready', event => {
      const ready = JSON.parse(event.data);
      current.stream = ready.stream;
      current.cursor = ready.cursor;
      each('ready', ready);
    });
    source.addEventListener('changes', event => {
      const batch = JSON.parse(event.data);
      current.cursor = batch.cursor;
      each('changes', batch);
    });
    source.addEventListener('update', event => each('update', JSON.parse(event.data)));
    source.addEventListener('error', () => {
      current.stream = null;
      if (source.readyState !== EventSource.CLOSED) return;
      if (channels.get(workspaceId) === current) channels.delete(workspaceId);
      each('closed');
    });
    channels.set(workspaceId, channel);
  }
  const joined = channel;
  joined.handlers.add(handlers);
  return {
    stream: () => joined.stream,
    cursor: () => joined.cursor,
    close() {
      joined.handlers.delete(handlers);
      if (joined.handlers.size) return;
      joined.source.close();
      if (channels.get(workspaceId) === joined) channels.delete(workspaceId);
    },
  };
}

/**
 * Every change to `workspaceId` the caller may see, each once and in feed
 * order across reconnections. `changes(list)` gets each batch; after a
 * reconnection it first gets what was missed, which `missed(since, until)`
 * reads from the change feed while the new connection's batches wait. When
 * that read fails, `failed(error)` is told and following goes on from the new
 * connection. Returns a function that stops.
 */
export function followWorkspaceChanges(workspaceId, {changes, missed, failed}, subscribe = subscribeWorkspace) {
  // Everything up to `followed` has been handed on; a reconnection's feed starts at `target`.
  let followed = null;
  let target = 0;
  let reading = false;
  let held = [];
  let stopped = false;
  const follow = (list, cursor) => {
    const fresh = list.filter(change => change.seq > followed);
    followed = Math.max(followed, cursor);
    if (fresh.length) changes(fresh);
  };
  const catchUp = () => {
    reading = true;
    const until = target;
    const release = () => {
      const later = held;
      held = [];
      reading = false;
      return later;
    };
    missed(followed, until).then(list => {
      if (stopped) return;
      const later = release();
      follow([...list, ...later.flatMap(batch => batch.changes)], Math.max(until, ...later.map(batch => batch.cursor)));
    }, error => {
      if (stopped) return;
      followed = until;
      failed(error);
      for (const batch of release()) follow(batch.changes, batch.cursor);
    }).then(() => { if (!stopped && target > followed) catchUp(); });
  };
  const channel = subscribe(workspaceId, {
    ready({cursor}) {
      if (followed === null) {
        followed = cursor;
        return;
      }
      target = Math.max(target, cursor);
      if (!reading && target > followed) catchUp();
    },
    changes(batch) {
      if (reading) held.push(batch);
      else follow(batch.changes, batch.cursor);
    },
  });
  // A channel already connected sends no `ready` until it reconnects; it is followed from where it is.
  followed = channel.cursor();
  return () => {
    stopped = true;
    channel.close();
  };
}
