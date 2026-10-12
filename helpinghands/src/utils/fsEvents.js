/**
 * A workspace's push channel (GET /fs/events, src/server/fs/events.js): one
 * EventSource per workspace, shared by everything on the page that follows it.
 *
 * Each connection, the first and every reconnection, starts with `ready`,
 * which names the stream; what was missed meanwhile is read from /changes.
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
 * is not retried). `stream()` is the connected stream's id, or null.
 */
export function subscribeWorkspace(workspaceId, handlers) {
  let channel = channels.get(workspaceId);
  if (!channel) {
    const source = new EventSource(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/fs/events`, {
      withCredentials: true,
    });
    channel = {source, stream: null, handlers: new Set()};
    const current = channel;
    const each = (name, data) => { for (const handler of [...current.handlers]) handler[name]?.(data); };
    source.addEventListener('ready', event => {
      current.stream = JSON.parse(event.data).stream;
      each('ready');
    });
    source.addEventListener('changes', event => each('changes', JSON.parse(event.data)));
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
    close() {
      joined.handlers.delete(handlers);
      if (joined.handlers.size) return;
      joined.source.close();
      if (channels.get(workspaceId) === joined) channels.delete(workspaceId);
    },
  };
}
