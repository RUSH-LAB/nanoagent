/**
 * This browser's replica of a workspace file system, as a cloud drive keeps
 * one: the whole tree, and the contents of the text files that were opened or
 * kept on this computer (pinned). The least recently opened unpinned files are
 * evicted beyond FS_REPLICA_LIMIT.
 *
 * The replica follows the server's change feed (/fs/changes) from a cursor,
 * read whenever the workspace's push channel (fsEvents.js) connects or says
 * something changed. When anything changed it lists the tree again, fetches
 * the cached files whose revision moved, and drops the ones that are gone.
 * Saves made while the server cannot be reached wait in an outbox, each
 * naming the revision it was based on. On upload a save that the server
 * refuses as stale is kept as a conflicted copy beside the file, never
 * discarded.
 *
 * Entries are keyed by user and workspace, in the same store as the document
 * cache (documentCache.js), so signing out clears both.
 */
import API_BASE, {apiFetch} from './api.js';
import {browserStore, isOffline} from './documentCache.js';
import {subscribeWorkspace} from './fsEvents.js';

export const FS_REPLICA_LIMIT = 300;
export const FS_SYNC_EVENT = 'mochi:fs-sync';

async function fetchFs(method, path, {body, text = false} = {}) {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: {'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json'},
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  });
  if (text && response.ok) {
    return {ok: true, status: response.status, rev: Number(response.headers.get('X-Rev')), text: await response.text()};
  }
  return {ok: response.ok, status: response.status, data: await response.json().catch(() => ({}))};
}

function conflictedCopyPath(path, day, n) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const [stem, extension] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  return `${stem} (conflicted copy ${day}${n > 1 ? ` ${n}` : ''})${extension}`;
}

/** `scope` is `{userId, workspaceId}`. */
export function createFsReplica({
  store, request = fetchFs, now = Date.now, limit = FS_REPLICA_LIMIT,
  emit = detail => window.dispatchEvent(new CustomEvent(FS_SYNC_EVENT, {detail})),
}) {
  const prefix = (kind, scope) => `fs${kind}|${scope.userId}|${scope.workspaceId}|`;
  const root = scope => `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/fs`;
  const query = path => `path=${encodeURIComponent(path)}`;

  async function evict() {
    const files = (await store.entries('fsfile|'))
      .filter(([, entry]) => !entry.pinned && !entry.pending)
      .sort(([, a], [, b]) => b.openedAt - a.openedAt);
    for (const [key] of files.slice(limit)) await store.delete(key);
  }

  async function download(scope, path) {
    const fetched = await request('GET', `${root(scope)}/file?${query(path)}`, {text: true});
    if (!fetched.ok) return null;
    return {text: fetched.text, rev: fetched.rev};
  }

  async function flush(scope) {
    for (const [key, item] of await store.entries(prefix('out', scope))) {
      if (item.error) continue;
      const saved = await request('PUT', `${root(scope)}/file?${query(item.path)}&baseRev=${item.baseRev}`, {body: item.text});
      const fileKey = prefix('file', scope) + item.path;
      if (saved.ok) {
        await store.delete(key);
        const entry = await store.get(fileKey);
        await store.set(fileKey, {...entry, text: item.text, rev: saved.data.node.rev, pending: false, openedAt: entry?.openedAt ?? now()});
        emit({scope, path: item.path, uploaded: true, rev: saved.data.node.rev});
        continue;
      }
      if (saved.status === 409) {
        // The file changed after the offline edit began. Theirs keeps the
        // path; this one becomes a new file beside it.
        const day = new Date(now()).toISOString().slice(0, 10);
        for (let n = 1; ; n += 1) {
          const copy = conflictedCopyPath(item.path, day, n);
          const created = await request('PUT', `${root(scope)}/file?${query(copy)}&baseRev=0`, {body: item.text});
          if (created.ok) {
            await store.delete(key);
            await store.delete(fileKey);
            emit({scope, path: item.path, conflictedCopy: copy});
            break;
          }
          if (created.data.code !== 'exists') {
            await store.set(key, {...item, error: created.data.error || `Could not save (${created.status})`});
            emit({scope, path: item.path, error: created.data.error});
            break;
          }
        }
        continue;
      }
      await store.set(key, {...item, error: saved.data.error || `Could not save (${saved.status})`});
      emit({scope, path: item.path, error: saved.data.error});
    }
  }

  return {
    /** The tree as this browser last saw it, or null. */
    async tree(scope) {
      return (await store.get(prefix('tree', scope)))?.nodes ?? null;
    },

    async rememberTree(scope, nodes, cursor) {
      const known = await store.get(prefix('tree', scope));
      await store.set(prefix('tree', scope), {nodes, cursor: cursor ?? known?.cursor ?? 0});
    },

    /** A kept file's `{text, rev, pending}`, or null. Reading it marks it recently opened. */
    async read(scope, path) {
      const key = prefix('file', scope) + path;
      const entry = await store.get(key);
      if (!entry) return null;
      await store.set(key, {...entry, openedAt: now()});
      return {text: entry.text, rev: entry.rev, pending: Boolean(entry.pending)};
    },

    async remember(scope, path, {text, rev}) {
      const key = prefix('file', scope) + path;
      const existing = await store.get(key);
      if (existing?.pending) return;
      await store.set(key, {text, rev, openedAt: now(), pinned: Boolean(existing?.pinned)});
      await evict();
    },

    /** Keep a save the server could not receive. A later save keeps the first one's base revision. */
    async queueWrite(scope, {path, text, baseRev}) {
      const key = prefix('out', scope) + path;
      const queued = await store.get(key);
      await store.set(key, {path, text, baseRev: queued?.baseRev ?? baseRev});
      const fileKey = prefix('file', scope) + path;
      const entry = await store.get(fileKey);
      await store.set(fileKey, {...entry, text, rev: entry?.rev ?? baseRev, pending: true, openedAt: now()});
    },

    /** Keep a file on this computer, downloading it if needed, or let it be evicted. */
    async setPinned(scope, path, pinned) {
      const key = prefix('file', scope) + path;
      let entry = await store.get(key);
      if (!entry && pinned) {
        const fetched = await download(scope, path);
        if (!fetched) throw new Error(`Could not download ${path}`);
        entry = {...fetched, openedAt: now()};
      }
      if (entry) await store.set(key, {...entry, pinned});
      if (!pinned) await evict();
    },

    /** `path → {pinned, pending}` for every file this browser holds. */
    async held(scope) {
      const base = prefix('file', scope);
      return new Map((await store.entries(base)).map(([key, entry]) => [
        key.slice(base.length), {pinned: Boolean(entry.pinned), pending: Boolean(entry.pending)},
      ]));
    },

    /**
     * Upload waiting saves, then follow the change feed. Returns whether the
     * tree changed. Stops quietly while the server cannot be reached.
     */
    async refresh(scope) {
      try {
        await flush(scope);
        const known = await store.get(prefix('tree', scope));
        let cursor = known?.cursor ?? 0;
        let changed = !known;
        for (;;) {
          const page = await request('GET', `${root(scope)}/changes?since=${cursor}`);
          if (!page.ok) return false;
          if (page.data.changes.length) changed = true;
          cursor = page.data.cursor;
          if (!page.data.more) break;
        }
        if (!changed) return false;
        const listing = await request('GET', `${root(scope)}/tree`);
        if (!listing.ok) return false;
        const nodes = listing.data.nodes;
        const revs = new Map(nodes.filter(node => node.kind === 'file').map(node => [node.path, node.rev]));
        const base = prefix('file', scope);
        for (const [key, entry] of await store.entries(base)) {
          if (entry.pending) continue;
          const path = key.slice(base.length);
          if (!revs.has(path)) {
            await store.delete(key);
          } else if (revs.get(path) !== entry.rev) {
            const fetched = await download(scope, path);
            if (fetched) await store.set(key, {...entry, ...fetched});
          }
        }
        await store.set(prefix('tree', scope), {nodes, cursor});
        emit({scope, tree: true});
        return true;
      } catch (error) {
        if (!isOffline(error)) throw error;
        return false;
      }
    },
  };
}

let shared = null;

/** This browser's file system replica. */
export function fsReplica() {
  shared ??= createFsReplica({store: browserStore()});
  return shared;
}

/**
 * Keep one workspace's replica current while a page is open: it refreshes
 * when the push channel connects (catching up on what it missed) and after
 * every batch of changes. Returns a function that stops it.
 */
export function startFsSync(scope, replica = fsReplica(), subscribe = subscribeWorkspace) {
  let running = false;
  let again = false;
  // A batch that arrives during a refresh is read by one more refresh, never dropped.
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await replica.refresh(scope);
    } catch (error) {
      console.error('[workspace] Background sync failed:', error);
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      run();
    }
  };
  const channel = subscribe(scope.workspaceId, {
    ready: run,
    changes: run,
    closed: () => window.dispatchEvent(new CustomEvent(FS_SYNC_EVENT, {detail: {scope, disconnected: true}})),
  });
  if (channel.stream()) run();
  return () => channel.close();
}
