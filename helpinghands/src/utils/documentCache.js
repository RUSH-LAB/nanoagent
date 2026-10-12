/**
 * This browser's copy of the workspace documents its reader has opened.
 *
 * The server keeps every document; the browser keeps the ones you read, the
 * way a cloud drive keeps recently used files on disk. A page renders from
 * this copy at once and is then revalidated against the server. While a tab is
 * open the copy is kept current in the background: documents changed on the
 * server are fetched again, deleted ones are dropped, and the least recently
 * opened are evicted beyond DOCUMENT_CACHE_LIMIT. A document kept on this
 * computer (pinned) is never evicted.
 *
 * Saves made while the server cannot be reached wait in an outbox here and are
 * uploaded when it can. A save rejected because someone else changed the
 * document meanwhile is kept as a conflicted copy beside it, never discarded.
 *
 * Entries are keyed by user and workspace, so another account in the same
 * browser never sees them, and signing out clears them all.
 */
import API_BASE, {apiFetch} from './api.js';

export const DOCUMENT_CACHE_LIMIT = 200;
export const DOCUMENT_SYNC_EVENT = 'mochi:document-sync';
const SYNC_INTERVAL_MS = 60_000;
const DATABASE = 'mochi-documents';
const STORE = 'entries';

/** IndexedDB as a string-keyed map. */
function indexedDbStore() {
  let database = null;
  const open = () => database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, operation) => {
    const transaction = (await open()).transaction(STORE, mode);
    const result = operation(transaction.objectStore(STORE));
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(typeof result === 'function' ? result() : result?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    get: key => run('readonly', store => store.get(key)),
    set: (key, value) => run('readwrite', store => store.put(value, key)),
    delete: key => run('readwrite', store => store.delete(key)),
    clear: () => run('readwrite', store => store.clear()),
    entries: prefix => run('readonly', store => {
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
      const keys = store.getAllKeys(range);
      const values = store.getAll(range);
      return () => keys.result.map((key, index) => [key, values.result[index]]);
    }),
  };
}

/** The same interface in memory, for tests. */
export function memoryStore() {
  const map = new Map();
  return {
    get: async key => map.get(key),
    set: async (key, value) => { map.set(key, value); },
    delete: async key => { map.delete(key); },
    clear: async () => map.clear(),
    entries: async prefix => [...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)),
  };
}

async function fetchJson(method, path, body) {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method,
    ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
  });
  return {ok: response.ok, status: response.status, data: await response.json().catch(() => ({}))};
}

/** A failed fetch throws a TypeError; every answer from the server, even an error, does not. */
export const isOffline = error => error instanceof TypeError;

function conflictedCopyPath(path, day, n) {
  const dot = path.lastIndexOf('.');
  const [stem, extension] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  return `${stem} (conflicted copy ${day}${n > 1 ? ` ${n}` : ''})${extension}`;
}

/**
 * `scope` is `{userId, workspaceId}`. A view is one cached API response, keyed
 * by its URL below the workspace's documents endpoint: `?path=…` for a
 * document and `/tree…` for a listing.
 */
export function createDocumentCache({
  store, request = fetchJson, now = Date.now, limit = DOCUMENT_CACHE_LIMIT,
  emit = detail => window.dispatchEvent(new CustomEvent(DOCUMENT_SYNC_EVENT, {detail})),
}) {
  const prefix = (kind, scope) => `${kind}|${scope.userId}|${scope.workspaceId}|`;
  const documentsRoot = scope => `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/documents`;
  const isDocumentView = view => view.startsWith('?');

  async function evict() {
    const documents = (await store.entries('view|'))
      .filter(([, entry]) => isDocumentView(entry.view) && !entry.pending && !entry.pinned)
      .sort(([, a], [, b]) => b.openedAt - a.openedAt);
    for (const [key] of documents.slice(limit)) await store.delete(key);
  }

  /** Every cached view of the document at `path`, by its key. */
  async function viewsOf(scope, path) {
    return (await store.entries(prefix('view', scope)))
      .filter(([, entry]) => entry.data.document?.path === path);
  }

  async function flush(scope) {
    for (const [key, item] of await store.entries(prefix('outbox', scope))) {
      if (item.error) continue;
      const saved = await request('PUT', documentsRoot(scope), {
        path: item.path, markdown: item.markdown, baseUpdatedAt: item.baseUpdatedAt,
      });
      if (saved.ok) {
        await store.delete(key);
        for (const [viewKey, entry] of await viewsOf(scope, item.path)) {
          await store.set(viewKey, {
            ...entry,
            pending: false,
            data: {
              ...entry.data,
              document: {...entry.data.document, ...saved.data.document},
              markdown: item.markdown,
              tree: saved.data.tree,
              frontmatter: saved.data.frontmatter,
            },
          });
        }
        emit({scope, path: item.path, document: saved.data.document, uploaded: true});
        continue;
      }
      if (saved.status === 409) {
        // Someone saved this document after the offline edit began. Theirs keeps
        // the path; this one becomes a new document beside it.
        const day = new Date(now()).toISOString().slice(0, 10);
        for (let n = 1; ; n += 1) {
          const copy = conflictedCopyPath(item.path, day, n);
          const created = await request('POST', documentsRoot(scope), {path: copy, markdown: item.markdown});
          if (created.ok) {
            await store.delete(key);
            for (const [viewKey] of await viewsOf(scope, item.path)) await store.delete(viewKey);
            emit({scope, path: item.path, conflictedCopy: copy});
            break;
          }
          if (created.data.code !== 'path-taken') {
            await store.set(key, {...item, error: created.data.error || `Could not save (${created.status})`});
            emit({scope, path: item.path, error: created.data.error});
            break;
          }
        }
        continue;
      }
      // Invalid MDX, or edit rights lost while offline. Keep the text and say
      // why; queueing a new save of the document clears the error.
      await store.set(key, {...item, error: saved.data.error || `Could not save (${saved.status})`});
      emit({scope, path: item.path, error: saved.data.error});
    }
  }

  return {
    /** The cached response for `view`, or null. Reading it marks it recently opened. */
    async read(scope, view) {
      const key = prefix('view', scope) + view;
      const entry = await store.get(key);
      if (!entry) return null;
      await store.set(key, {...entry, openedAt: now()});
      return {ok: true, status: 200, data: entry.data, pending: Boolean(entry.pending)};
    },

    /** Keep a response just fetched from the server. */
    async remember(scope, view, data) {
      const key = prefix('view', scope) + view;
      // A save waiting in the outbox is newer than anything the server has.
      const existing = await store.get(key);
      if (existing?.pending) return;
      await store.set(key, {view, data, openedAt: now(), pinned: Boolean(existing?.pinned)});
      if (isDocumentView(view)) await evict();
    },

    /** `path → {pinned, pending}` for every document this browser holds. */
    async cachedPaths(scope) {
      const held = new Map();
      for (const [, entry] of await store.entries(prefix('view', scope))) {
        const path = isDocumentView(entry.view) && entry.data.document?.path;
        if (!path) continue;
        const known = held.get(path);
        held.set(path, {
          pinned: Boolean(known?.pinned || entry.pinned),
          pending: Boolean(known?.pending || entry.pending),
        });
      }
      return held;
    },

    /**
     * Keep a document on this computer, or let it be evicted again. Keeping
     * one that is not cached yet downloads it.
     */
    async setPinned(scope, path, pinned) {
      const view = `?path=${encodeURIComponent(path)}`;
      const key = prefix('view', scope) + view;
      let entry = await store.get(key);
      if (!entry && pinned) {
        const fetched = await request('GET', `${documentsRoot(scope)}${view}`);
        if (!fetched.ok) throw new Error(fetched.data.error || `Could not download ${path} (${fetched.status})`);
        entry = {view, data: fetched.data, openedAt: now()};
      }
      if (entry) await store.set(key, {...entry, pinned});
      for (const [otherKey, other] of await viewsOf(scope, path)) {
        if (otherKey !== key) await store.set(otherKey, {...other, pinned});
      }
      if (!pinned) await evict();
    },

    /** The last signed-in account's workspace list, for starting while offline. */
    rememberAccount: account => store.set('account', account),
    account: () => store.get('account'),
    forgetAccount: () => store.delete('account'),

    /**
     * Keep a save that could not reach the server, and show it in this
     * browser's copy until it is uploaded. A later save of the same document
     * replaces the text but keeps the revision the first one was based on.
     */
    async queueSave(scope, {path, markdown, baseUpdatedAt, tree, frontmatter}) {
      const key = prefix('outbox', scope) + path;
      const queued = await store.get(key);
      await store.set(key, {path, markdown, baseUpdatedAt: queued?.baseUpdatedAt ?? baseUpdatedAt});
      for (const [viewKey, entry] of await viewsOf(scope, path)) {
        await store.set(viewKey, {...entry, pending: true, data: {...entry.data, markdown, tree, frontmatter}});
      }
    },

    /**
     * Upload waiting saves, then bring the cached views up to date with the
     * server. Stops quietly while the server cannot be reached.
     */
    async refresh(scope) {
      try {
        await flush(scope);
        const manifest = await request('GET', `${documentsRoot(scope)}/tree`);
        if (!manifest.ok) return;
        const current = new Map(manifest.data.documents.map(document => [document.path, document.updatedAt]));
        const signature = JSON.stringify([...current]);
        const changed = signature !== await store.get(prefix('manifest', scope));
        for (const [key, entry] of await store.entries(prefix('view', scope))) {
          // Only document and listing views are revalidated against the manifest.
          if (entry.pending || !(isDocumentView(entry.view) || entry.view.startsWith('/'))) continue;
          const {view} = entry;
          const path = entry.data.document?.path;
          if (isDocumentView(view) ? current.get(path) === entry.data.document.updatedAt : !changed) continue;
          if (isDocumentView(view) && !current.has(path)) {
            await store.delete(key);
            continue;
          }
          const fresh = await request('GET', `${documentsRoot(scope)}${view}`);
          if (fresh.ok) {
            await store.set(key, {...entry, data: fresh.data});
            emit({scope, view, data: fresh.data});
          } else if (fresh.status === 404) {
            await store.delete(key);
          }
        }
        await store.set(prefix('manifest', scope), signature);
      } catch (error) {
        if (!isOffline(error)) throw error;
      }
    },

    clear: () => store.clear(),
  };
}

let sharedStore = null;
let shared = null;

/**
 * This browser's IndexedDB store, shared by everything it keeps for its
 * signed-in account (the document cache and the file system replica), so
 * signing out clears them together.
 */
export function browserStore() {
  sharedStore ??= indexedDbStore();
  return sharedStore;
}

/** This browser's document cache. */
export function documentCache() {
  shared ??= createDocumentCache({store: browserStore()});
  return shared;
}

/**
 * Keep one workspace's cached documents current while a page is open: on a
 * timer, when the tab regains focus, and when the network comes back.
 * Returns a function that stops it.
 */
export function startDocumentSync(scope, cache = documentCache()) {
  let running = false;
  const run = async () => {
    if (running || document.visibilityState === 'hidden') return;
    running = true;
    try {
      await cache.refresh(scope);
    } catch (error) {
      console.error('[documents] Background sync failed:', error);
    } finally {
      running = false;
    }
  };
  const timer = window.setInterval(run, SYNC_INTERVAL_MS);
  window.addEventListener('online', run);
  window.addEventListener('focus', run);
  run();
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('online', run);
    window.removeEventListener('focus', run);
  };
}
