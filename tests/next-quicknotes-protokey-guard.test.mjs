import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Invoke the quicknotes GET handler with a minimal mocked ctx and capture the
// response handed to json(res, status, payload). loadJSON returns the supplied
// store verbatim: a plain object literal, so inherited keys like constructor and
// toString resolve to truthy values exactly as they would on the real loadJSON
// result. fs.existsSync is stubbed false so the blog-note branch stays empty and
// the payload is exactly the JSON-backed notes; the read path never writes.
async function invoke({ userId, data }) {
  const query = userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`;
  const pathname = '/api/quicknotes';
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    fs: { existsSync: () => false },
    loadJSON: () => data,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return captured;
}

// One real user with two notes that straddle a sort boundary. The literal
// defines no own constructor, toString, or __proto__ key, so each resolves to
// its inherited Object.prototype member when read without the Object.hasOwn
// guard. The old `(data[userId] || []).sort(...)` form then runs .sort on that
// inherited function value, which has no .sort method and throws an unhandled
// TypeError, hanging the request until the socket times out (a remote DoS).
const QUICKNOTES = {
  alice: [
    { id: 'qn_old', text: 'older note', updatedAt: '2024-01-01T00:00:00Z' },
    { id: 'qn_new', text: 'newer note', updatedAt: '2024-06-01T00:00:00Z' },
  ],
};

const PROTO_KEYS = ['constructor', 'toString', '__proto__'];

describe('GET /api/quicknotes own-property userId guard', () => {
  for (const userId of PROTO_KEYS) {
    it(`treats the inherited key "${userId}" as an empty user`, async () => {
      const r = await invoke({ userId, data: QUICKNOTES });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, []);
    });
  }

  it('returns the stored notes, newest first, for a real own-key user', async () => {
    const r = await invoke({ userId: 'alice', data: QUICKNOTES });
    assert.equal(r.status, 200);
    // .sort() reorders the backing array in place, so assert against literals
    // (not QUICKNOTES.alice indices) to pin the newest-first ordering.
    assert.deepEqual(r.payload, [
      { id: 'qn_new', text: 'newer note', updatedAt: '2024-06-01T00:00:00Z' },
      { id: 'qn_old', text: 'older note', updatedAt: '2024-01-01T00:00:00Z' },
    ]);
  });

  it('returns an empty list for an absent ordinary userId', async () => {
    const r = await invoke({ userId: 'nobody', data: QUICKNOTES });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, []);
  });
});
