import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

// Drive POST /api/presence over a minimal mocked ctx and capture the response
// handed to json(res, status, payload). readBody returns the body verbatim;
// rateLimit allows the request so it reaches the store write; cleanStalePresence
// is a no-op so the handler stays self-contained; sanitizeText is identity.
// `Object` is never injected into ctx, so the handler exercises the real global
// Object.hasOwn, and `presenceStore` is a plain object literal whose inherited
// members (toString/valueOf/hasOwnProperty) resolve to real truthy functions.
async function postPresence({ body, presenceStore }) {
  const pathname = '/api/presence';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    readBody: async () => body,
    rateLimit: () => true,
    cleanStalePresence: () => {},
    sanitizeText: (s) => s,
    presenceStore,
  };
  await analyticsUsersRoutes(req, res, url, pathname, ctx);
  return captured;
}

// Object.prototype member names that PROTO_KEYS does NOT screen. On a plain
// object literal each resolves to a truthy inherited function.
//
// Anti-tautology: against the reverted `if (!presenceStore[presencePath])` form
// each of these is a truthy inherited member, so the init is skipped and
// `presenceStore[key][userId] = {...}` writes the record onto that shared
// inherited function (e.g. Object.prototype.hasOwnProperty). It is never an own
// key on presenceStore, so cleanStalePresence's `Object.keys(presenceStore)`
// loop can never evict it (a memory-cap bypass plus global-state corruption).
// The own-property guard (Object.hasOwn) creates a real own key instead, so
// every assertion below flips: own key present, prototype function untouched.
const INHERITED = ['hasOwnProperty', 'toString', 'valueOf'];

describe('POST /api/presence own-property store guard', () => {
  for (const key of INHERITED) {
    it(`stores an inherited filePath "${key}" as an OWN key without polluting Object.prototype`, async () => {
      const presenceStore = {};
      const userId = `evil-${key}`;
      const proto = Object.prototype[key]; // the inherited function this key resolves to
      try {
        const r = await postPresence({ body: { filePath: key, userId, userName: 'Mallory' }, presenceStore });

        // Records presence successfully, same status as a normal path.
        assert.equal(r.status, 200);
        assert.deepEqual(r.payload, { success: true });

        // The bucket is a real OWN key. The reverted form skips the init, so the
        // key never becomes own and cleanStalePresence's Object.keys loop is blind
        // to it; here it is own and enumerable, hence evictable.
        assert.equal(Object.hasOwn(presenceStore, key), true, 'filePath bucket must be an own key on presenceStore');
        assert.ok(Object.keys(presenceStore).includes(key), 'own key is enumerable, so cleanStalePresence can evict it');
        assert.equal(presenceStore[key][userId].userName, 'Mallory', 'record stored under the own bucket');

        // Object.prototype stays clean. The reverted form writes userId onto the
        // inherited FUNCTION (Object.prototype[key]), so these two are the
        // load-bearing, distinguishing proof.
        assert.equal(proto[userId], undefined, `Object.prototype.${key} must have no userId member`);
        assert.equal(Object.hasOwn(proto, userId), false, `Object.prototype.${key} must not own a userId member`);
        // Belt-and-suspenders against a hypothetical direct Object.prototype write.
        // This one does not distinguish the bug (the buggy write lands on the
        // inherited function above, not on Object.prototype itself, so a fresh {}
        // inherits userId in neither case); the two assertions above do.
        assert.equal(({})[userId], undefined, 'a fresh object must not inherit a directly injected userId');
      } finally {
        // Defensive: if ever run against the reverted code the write lands on the
        // shared inherited function; remove it so sibling tests stay isolated.
        delete proto[userId];
        delete Object.prototype[userId];
      }
    });
  }

  it('still records a normal filePath and userId (the guard does not over-reject)', async () => {
    const presenceStore = {};
    const r = await postPresence({ body: { filePath: 'docs/intro.md', userId: 'alice', userName: 'Alice' }, presenceStore });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { success: true });
    assert.equal(Object.hasOwn(presenceStore, 'docs/intro.md'), true);
    assert.equal(presenceStore['docs/intro.md'].alice.userName, 'Alice');
    assert.equal(presenceStore['docs/intro.md'].alice.userId, 'alice');
    assert.equal(presenceStore['docs/intro.md'].alice.cursor, null);
  });
});
