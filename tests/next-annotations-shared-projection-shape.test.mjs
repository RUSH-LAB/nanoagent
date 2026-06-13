import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../server/routes/misc-tools.js');

// Invoke a misc-tools route handler with a minimal mocked ctx and capture the
// response the handler hands to `json(res, status, payload)`. numericParam is
// required at the module top from ../server-utils, so it is NOT a ctx field and
// is deliberately left unstubbed.
async function invoke({ method = 'GET', pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    ...ctx,
  };
  await miscToolsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

// GET /api/annotations/shared is a pure projection over a single loadJSON read:
// for every page whose value is an array it pushes `{...ann, page}`, then sorts
// the flat list DESCENDING by createdAt and returns {annotations, total}. With no
// ?limit= the default page size is 50, so slice(0, 50) is a no-op on these small
// fixtures and the whole payload can be pinned with one deepStrictEqual golden.
// The default and negative-limit clamps live in their own files
// (next-misc-tools-limit-guards and next-misc-tools-negative-limit-clamp), so
// this file owns ONLY the spread-merge shape and the sort order.
describe('GET /api/annotations/shared projection shape and sort', () => {
  const ANNOTATIONS_FILE = '/tmp/next-annotations-shared-projection.json';
  const call = annotations =>
    invoke({
      pathname: '/api/annotations/shared',
      ctx: { loadJSON: file => (file === ANNOTATIONS_FILE ? annotations : {}), ANNOTATIONS_FILE },
    });

  it('spreads each annotation with its page key and sorts descending by createdAt across pages', async () => {
    const annotations = {
      'content/alpha.md': [
        { id: 'a1', text: 'first insight', author: 'amy', createdAt: '2026-03-01T10:00:00Z' },
        { id: 'a2', text: 'third insight', author: 'amy', createdAt: '2026-01-15T08:30:00Z' },
      ],
      'content/beta.md': [
        { id: 'b1', text: 'second insight', author: 'ben', createdAt: '2026-02-20T12:00:00Z' },
        { id: 'b2', text: 'fourth insight', author: 'ben', createdAt: '2025-12-31T23:59:59Z' },
      ],
    };
    const r = await call(annotations);
    assert.equal(r.status, 200);
    // Interleaved across the two pages, in exact descending createdAt order.
    // Every original field is preserved and the source page is attached.
    assert.deepStrictEqual(r.payload, {
      annotations: [
        { id: 'a1', text: 'first insight', author: 'amy', createdAt: '2026-03-01T10:00:00Z', page: 'content/alpha.md' },
        { id: 'b1', text: 'second insight', author: 'ben', createdAt: '2026-02-20T12:00:00Z', page: 'content/beta.md' },
        { id: 'a2', text: 'third insight', author: 'amy', createdAt: '2026-01-15T08:30:00Z', page: 'content/alpha.md' },
        { id: 'b2', text: 'fourth insight', author: 'ben', createdAt: '2025-12-31T23:59:59Z', page: 'content/beta.md' },
      ],
      total: 4,
    });
  });

  it('skips pages whose value is not an array', async () => {
    const annotations = {
      'content/real.md': [
        { id: 'r1', text: 'kept', createdAt: '2026-04-10T09:00:00Z' },
      ],
      'content/object.md': { id: 'nope', text: 'an object, not an array' },
      'content/string.md': 'a bare string value',
      'content/null.md': null,
      'content/empty.md': [],
    };
    const r = await call(annotations);
    assert.equal(r.status, 200);
    // Only the single array-valued page contributes; objects, strings, null, and
    // the empty array add nothing to either the feed or the total.
    assert.deepStrictEqual(r.payload, {
      annotations: [
        { id: 'r1', text: 'kept', createdAt: '2026-04-10T09:00:00Z', page: 'content/real.md' },
      ],
      total: 1,
    });
  });

  it('sorts a createdAt-less annotation last and lets the appended page override the annotation own page field', async () => {
    const annotations = {
      'content/x.md': [
        { id: 'x1', text: 'newest', createdAt: '2026-05-01T00:00:00Z' },
        { id: 'x2', text: 'no timestamp', page: 'stale-page-field' },
      ],
      'content/y.md': [
        { id: 'y1', text: 'middle', createdAt: '2026-04-01T00:00:00Z' },
      ],
    };
    const r = await call(annotations);
    assert.equal(r.status, 200);
    // x2 has no createdAt, so (createdAt || '') sorts it to the end; its own
    // `page: 'stale-page-field'` is overridden by the appended source page because
    // the spread comes before the page key.
    assert.deepStrictEqual(r.payload, {
      annotations: [
        { id: 'x1', text: 'newest', createdAt: '2026-05-01T00:00:00Z', page: 'content/x.md' },
        { id: 'y1', text: 'middle', createdAt: '2026-04-01T00:00:00Z', page: 'content/y.md' },
        { id: 'x2', text: 'no timestamp', page: 'content/x.md' },
      ],
      total: 3,
    });
  });
});
