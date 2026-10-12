import * as Y from 'yjs';
import API_BASE, {apiFetch} from '@site/src/utils/api';
import {browserStore, isOffline} from '@site/src/utils/documentCache';

/**
 * A Markdown file opened for live, mergeable editing (src/server/fs/crdt.js).
 *
 * The Yjs document starts from the server's state and follows its stream of
 * merged updates. Local edits are sent in short batches; the server merges
 * them with everyone else's, so there is nothing to save and nothing to
 * conflict. Without a network the document and its unsent edits are kept in
 * this browser and sent when the server answers again, merging like any other.
 */

const SEND_DELAY_MS = 400;
const RETRY_MS = 5_000;
const FROM_SERVER = 'server';

function toBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

export async function openLiveDocument({scope, workspaceId, path, readOnly, onStatus}) {
  const root = `${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/fs`;
  const query = `path=${encodeURIComponent(path)}`;
  const key = scope ? `fslive|${scope.userId}|${scope.workspaceId}|${path}` : null;
  const store = browserStore();
  const doc = new Y.Doc();
  let pending = [];
  let timer = null;
  let closed = false;
  let source = null;

  const keep = () => (key
    ? store.set(key, {
      state: toBase64(Y.encodeStateAsUpdate(doc)),
      pending: pending.length ? toBase64(Y.mergeUpdates(pending)) : null,
    }).catch(error => console.error('[workspace] Could not keep the document on this computer:', error))
    : Promise.resolve());

  const status = state => onStatus?.({state, waiting: pending.length > 0});

  async function send() {
    timer = null;
    if (closed || !pending.length) return;
    const update = Y.mergeUpdates(pending);
    const sent = pending.length;
    status('saving');
    try {
      const response = await apiFetch(`${root}/crdt?${query}`, {
        method: 'POST', headers: {'Content-Type': 'application/octet-stream'}, body: update,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        status(`error: ${data.error || `Could not save (${response.status})`}`);
        return;
      }
      pending = pending.slice(sent);
      await keep();
      status(pending.length ? 'saving' : 'saved');
      if (pending.length) schedule();
    } catch (error) {
      if (!isOffline(error)) throw error;
      await keep();
      status('offline');
      timer = setTimeout(send, RETRY_MS);
    }
  }

  const schedule = () => {
    if (!timer) timer = setTimeout(send, SEND_DELAY_MS);
  };

  doc.on('update', (update, origin) => {
    if (origin === FROM_SERVER || readOnly) return;
    pending.push(update);
    keep();
    schedule();
  });

  async function pull() {
    const response = await apiFetch(`${root}/crdt?${query}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Could not open ${path} (${response.status})`);
    }
    Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()), FROM_SERVER);
  }

  // The server's document, or this browser's copy of it while offline.
  const kept = key ? await store.get(key) : null;
  try {
    await pull();
    // Edits made offline in an earlier visit are merged in and sent now.
    if (kept?.pending) Y.applyUpdate(doc, fromBase64(kept.pending));
    status(pending.length ? 'saving' : 'saved');
  } catch (error) {
    if (!isOffline(error) || !kept) throw error;
    Y.applyUpdate(doc, fromBase64(kept.state), FROM_SERVER);
    if (kept.pending) {
      pending = [fromBase64(kept.pending)];
      Y.applyUpdate(doc, pending[0], FROM_SERVER);
    }
    status('offline');
    timer = setTimeout(send, RETRY_MS);
  }
  await keep();

  source = new EventSource(`${root}/crdt/events?${query}`, {withCredentials: true});
  source.addEventListener('update', event => Y.applyUpdate(doc, fromBase64(event.data), FROM_SERVER));
  // A reconnected stream has missed what was merged meanwhile, so the whole
  // state is read again (applying it twice changes nothing), and edits waiting
  // to be sent go now.
  let connected = false;
  source.addEventListener('open', () => {
    if (connected) pull().catch(error => console.error(`[workspace] Could not refresh ${path}:`, error));
    connected = true;
    if (pending.length) schedule();
  });

  return {
    doc,
    text: doc.getText('markdown'),
    flush: send,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
      doc.destroy();
    },
  };
}
