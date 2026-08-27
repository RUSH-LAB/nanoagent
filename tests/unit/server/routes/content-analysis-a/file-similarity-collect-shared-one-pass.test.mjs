import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

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
    // so this fs-backed test still exercises the real one-pass sharedWords collect.
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

describe('GET /api/file/similarity (collect sharedWords in one pass)', () => {
  // The fold gathers the shared words while counting the intersection, so set1
  // is walked once. `sharedWords` must stay byte identical to the old
  // `[...set1].filter(...).slice(0, 20)`: same members, same order (set1's
  // insertion order, which is file1's first-seen word order), same 20-item cap.

  it('partial overlap: sharedWords follows file1 order, not file2 order', async () => {
    // set1 insertion order: alpha, bravo, charlie, delta, echo.
    // set2 insertion order: charlie, alpha, foxtrot, golf. The shared words are
    // alpha and charlie; in set1's order that is [alpha, charlie]. A loop over
    // set2 would yield [charlie, alpha], so this pins the ordering.
    const r = await similarity(
      { 'f1.md': 'alpha bravo charlie delta echo', 'f2.md': 'charlie alpha foxtrot golf' },
      'f1.md',
      'f2.md',
    );
    assert.equal(r.status, 200);
    // intersection {alpha, charlie} = 2; union = 5 + 4 - 2 = 7; 2 / 7 = 0.286.
    assert.equal(r.payload.similarity, 0.286);
    assert.deepEqual(r.payload.sharedWords, ['alpha', 'charlie']);
    assert.equal(r.payload.sharedCount, 2);
    assert.equal(r.payload.uniqueToFile1, 3);
    assert.equal(r.payload.uniqueToFile2, 2);
  });

  it('caps sharedWords at 20 while sharedCount keeps the full intersection', async () => {
    // 25 shared terms plus 2 file1-only and 1 file2-only word. file2 lists the
    // shared terms in reverse, so the 20-item slice proves the output keeps
    // set1's order (terma..termt) rather than file2's reversed order.
    const shared = Array.from({ length: 25 }, (_, i) => 'term' + String.fromCharCode(97 + i));
    const file1 = shared.join(' ') + ' uniqone uniqtwo';
    const file2 = [...shared].reverse().join(' ') + ' otherword';
    const r = await similarity({ 'f1.md': file1, 'f2.md': file2 }, 'f1.md', 'f2.md');
    assert.equal(r.status, 200);
    // set1 = 27 (25 shared + 2 unique), set2 = 26 (25 shared + 1 unique).
    // intersection = 25; union = 27 + 26 - 25 = 28; 25 / 28 = 0.893.
    assert.equal(r.payload.similarity, 0.893);
    assert.equal(r.payload.sharedWords.length, 20);
    assert.deepEqual(r.payload.sharedWords, shared.slice(0, 20));
    assert.equal(r.payload.sharedCount, 25);
    assert.equal(r.payload.uniqueToFile1, 2);
    assert.equal(r.payload.uniqueToFile2, 1);
  });

  it('no overlap: empty sharedWords and a zero shared count', async () => {
    const r = await similarity(
      { 'f1.md': 'alpha bravo charlie', 'f2.md': 'delta echo foxtrot' },
      'f1.md',
      'f2.md',
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.similarity, 0);
    assert.deepEqual(r.payload.sharedWords, []);
    assert.equal(r.payload.sharedCount, 0);
    assert.equal(r.payload.uniqueToFile1, 3);
    assert.equal(r.payload.uniqueToFile2, 3);
  });
});
