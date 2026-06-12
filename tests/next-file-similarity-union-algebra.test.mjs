import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';

// Build a minimal ctx whose fs.readFileSync only answers for the files in the
// provided map (keyed by the joined absolute path). An unmapped read throws
// ENOENT, so the handler's catch branch is exercised honestly rather than
// silently returning stale content.
function makeCtx(files) {
  return {
    fs: {
      readFileSync(fp) {
        if (Object.prototype.hasOwnProperty.call(files, fp)) return files[fp];
        const e = new Error(`ENOENT: ${fp}`);
        e.code = 'ENOENT';
        throw e;
      },
    },
    path,
    PROJECT_ROOT,
    isValidFilePath: p => typeof p === 'string' && p.length > 0,
    // /api/file/similarity now wraps its two reads and Jaccard math in
    // cached('similarity:' + path1 + ':' + path2, 30000, fn); supply a pass-through
    // so this fs-backed test still exercises the real union-by-set-algebra path.
    cached: (_k, _t, fn) => fn(),
  };
}

// Invoke the content-analysis-a route handler with a mocked ctx and capture the
// response the handler hands to json(res, status, payload).
async function invoke({ pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
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
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

// Drive GET /api/file/similarity for two named files whose contents come from
// `contents` (name → text). Files land under PROJECT_ROOT via path.join.
async function similarity(contents, name1, name2) {
  const files = {};
  for (const [name, text] of Object.entries(contents)) {
    files[path.join(PROJECT_ROOT, name)] = text;
  }
  const search = `?path1=${encodeURIComponent(name1)}&path2=${encodeURIComponent(name2)}`;
  return invoke({ pathname: '/api/file/similarity', search, ctx: makeCtx(files) });
}

describe('GET /api/file/similarity (union via set algebra)', () => {
  // The refactor replaces `new Set([...set1, ...set2]).size` with the identity
  // |A ∪ B| = |A| + |B| - |A ∩ B|. The handler never returns the union
  // directly, but the response pins it: union === sharedCount + uniqueToFile1 +
  // uniqueToFile2. Every case below checks that the union the handler used
  // matches the true set union and that jaccard = shared / union (rounded).
  const expectedUnion = p => p.sharedCount + p.uniqueToFile1 + p.uniqueToFile2;
  const expectedJaccard = p => {
    const u = expectedUnion(p);
    return u > 0 ? Math.round((p.sharedCount / u) * 1000) / 1000 : 0;
  };

  it('full overlap: identical word sets give jaccard 1 and zero unique counts', async () => {
    const r = await similarity(
      { 'f1.md': 'apple banana cherry', 'f2.md': 'apple banana cherry' },
      'f1.md',
      'f2.md',
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.similarity, 1);
    assert.equal(r.payload.sharedCount, 3);
    assert.equal(r.payload.uniqueToFile1, 0);
    assert.equal(r.payload.uniqueToFile2, 0);
    assert.deepEqual(r.payload.sharedWords, ['apple', 'banana', 'cherry']);
    // union = 3 + 3 - 3 = 3
    assert.equal(expectedUnion(r.payload), 3);
    assert.equal(r.payload.similarity, expectedJaccard(r.payload));
  });

  it('no overlap: disjoint word sets give jaccard 0 and all words unique', async () => {
    const r = await similarity(
      { 'f1.md': 'apple banana cherry', 'f2.md': 'delta mango peach' },
      'f1.md',
      'f2.md',
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.similarity, 0);
    assert.equal(r.payload.sharedCount, 0);
    assert.equal(r.payload.uniqueToFile1, 3);
    assert.equal(r.payload.uniqueToFile2, 3);
    assert.deepEqual(r.payload.sharedWords, []);
    // union = 3 + 3 - 0 = 6, the full disjoint total
    assert.equal(expectedUnion(r.payload), 6);
    assert.equal(r.payload.similarity, expectedJaccard(r.payload));
  });

  it('partial overlap: jaccard and counts follow |A| + |B| - |A ∩ B|', async () => {
    const r = await similarity(
      { 'f1.md': 'apple banana cherry delta', 'f2.md': 'cherry delta mango peach' },
      'f1.md',
      'f2.md',
    );
    assert.equal(r.status, 200);
    // intersection {cherry, delta} = 2; union = 4 + 4 - 2 = 6; 2 / 6 = 0.333
    assert.equal(r.payload.similarity, 0.333);
    assert.equal(r.payload.sharedCount, 2);
    assert.equal(r.payload.uniqueToFile1, 2);
    assert.equal(r.payload.uniqueToFile2, 2);
    assert.deepEqual(r.payload.sharedWords, ['cherry', 'delta']);
    assert.equal(expectedUnion(r.payload), 6);
    assert.equal(r.payload.similarity, expectedJaccard(r.payload));
  });

  it('duplicate words within a file collapse to set semantics before the algebra', async () => {
    // Repeats must not inflate the sizes: set1 = {apple, banana, cherry},
    // set2 = {cherry, banana, delta}. intersection = 2, union = 3 + 3 - 2 = 4.
    const r = await similarity(
      { 'f1.md': 'apple apple banana cherry cherry', 'f2.md': 'cherry banana banana delta' },
      'f1.md',
      'f2.md',
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.similarity, 0.5);
    assert.equal(r.payload.sharedCount, 2);
    assert.equal(r.payload.uniqueToFile1, 1);
    assert.equal(r.payload.uniqueToFile2, 1);
    assert.deepEqual(r.payload.sharedWords, ['banana', 'cherry']);
    assert.equal(expectedUnion(r.payload), 4);
    assert.equal(r.payload.similarity, expectedJaccard(r.payload));
  });

  it('rejects a missing path with 400 before reading any file', async () => {
    const r = await invoke({
      pathname: '/api/file/similarity',
      search: '?path2=f2.md',
      ctx: makeCtx({}),
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid paths' });
  });

  it('returns 404 when a file cannot be read', async () => {
    const r = await invoke({
      pathname: '/api/file/similarity',
      search: '?path1=missing.md&path2=also-missing.md',
      ctx: makeCtx({}),
    });
    assert.equal(r.status, 404);
    assert.deepEqual(r.payload, { error: 'File not found' });
  });
});
