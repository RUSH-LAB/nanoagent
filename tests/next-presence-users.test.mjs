import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { makePresenceStore } = require('../server/server-utils.js');

// ─── cleanStalePresence: const-users hoist ──────────────────────────────────────
//
// cleanStalePresence binds `presenceStore[filePath]` once per outer iteration into
// `const users` and routes the inner reads (Object.keys, .lastSeen test, the inner
// delete, and the empty check) through it, while the file-level
// `delete presenceStore[filePath]` still targets the parent. These tests register
// users across several file paths with a mix of stale and fresh lastSeen, trigger
// cleanup through the store's public clean() API, and assert that the per-user
// deletes, the kept entries, and the parent-key removal all stay correct.

describe('makePresenceStore cleanStalePresence across multiple files', () => {
  const STALE = 40000; // older than the 30s threshold
  const FRESH = 0;     // current, well within the threshold

  it('removes stale users, keeps fresh users, and drops all-stale file keys', () => {
    const { store, clean } = makePresenceStore();
    const now = Date.now();

    // File whose users are all stale: the whole key should be removed.
    store['content/all-stale.md'] = {
      a1: { userId: 'a1', userName: 'A1', cursor: 0, lastSeen: now - STALE },
      a2: { userId: 'a2', userName: 'A2', cursor: 0, lastSeen: now - 35000 },
    };
    // File with a mix: stale user removed, fresh user kept, key retained.
    store['content/mixed.md'] = {
      m_stale: { userId: 'm_stale', userName: 'MStale', cursor: 0, lastSeen: now - STALE },
      m_fresh: { userId: 'm_fresh', userName: 'MFresh', cursor: 0, lastSeen: now - FRESH },
    };
    // File whose users are all fresh: key and every user retained.
    store['content/all-fresh.md'] = {
      f1: { userId: 'f1', userName: 'F1', cursor: 0, lastSeen: now - FRESH },
      f2: { userId: 'f2', userName: 'F2', cursor: 3, lastSeen: now - 1000 },
    };

    clean();

    // All-stale file: parent key gone.
    assert.equal(store['content/all-stale.md'], undefined);

    // Mixed file: key kept, stale user removed, fresh user kept.
    assert.ok(store['content/mixed.md']);
    assert.equal(store['content/mixed.md'].m_stale, undefined);
    assert.ok(store['content/mixed.md'].m_fresh);
    assert.equal(store['content/mixed.md'].m_fresh.userName, 'MFresh');
    assert.deepEqual(Object.keys(store['content/mixed.md']), ['m_fresh']);

    // All-fresh file: key kept with both users intact.
    assert.ok(store['content/all-fresh.md']);
    assert.deepEqual(Object.keys(store['content/all-fresh.md']).sort(), ['f1', 'f2']);
    assert.equal(store['content/all-fresh.md'].f2.cursor, 3);
  });

  it('removes only the stale users from each surviving file', () => {
    const { store, clean } = makePresenceStore();
    const now = Date.now();

    store['content/one.md'] = {
      keep1: { userId: 'keep1', userName: 'K1', cursor: 0, lastSeen: now },
      drop1: { userId: 'drop1', userName: 'D1', cursor: 0, lastSeen: now - STALE },
    };
    store['content/two.md'] = {
      drop2: { userId: 'drop2', userName: 'D2', cursor: 0, lastSeen: now - STALE },
      keep2: { userId: 'keep2', userName: 'K2', cursor: 0, lastSeen: now - 5000 },
    };

    clean();

    assert.deepEqual(Object.keys(store['content/one.md']), ['keep1']);
    assert.deepEqual(Object.keys(store['content/two.md']), ['keep2']);
  });

  it('leaves an empty store untouched', () => {
    const { store, clean } = makePresenceStore();
    clean();
    assert.deepEqual(Object.keys(store), []);
  });
});
