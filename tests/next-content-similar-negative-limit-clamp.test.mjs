import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the sibling guard suite
// (next-content-similar-limit-guard.test.mjs) does and reuse its ctx-mocking shape.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

// Invoke a content-analysis-b route handler with a minimal mocked ctx and
// capture the response that the handler hands to `json(res, status, payload)`.
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
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/content-similar negative-limit clamp', () => {
  // A fixed in-memory content tree: one source file plus 25 candidate pages
  // that each share every source keyword (overlap 8 > 2). With 25 matches the
  // default (5), the cap clamp (20), and the negative case are all
  // distinguishable: a bare `slice(0, -3)` would keep the first 22 matches
  // (dropping the tail), whereas the clamped `slice(0, 0)` yields an empty list.
  // The handler reads the tree straight from `fs`, so mock `fs`.
  const PROJECT_ROOT = '/proj';
  const KEYWORDS = 'alpha bravo charlie delta elephant foxtrot guitar hotel';
  const SOURCE_REL = 'content/source.md';
  const PAGE_COUNT = 25;

  const fileContents = new Map();
  fileContents.set(path.join(PROJECT_ROOT, SOURCE_REL), KEYWORDS);
  const dirEntries = [{ name: 'source.md', isDirectory: () => false }];
  for (let i = 0; i < PAGE_COUNT; i++) {
    fileContents.set(path.join(PROJECT_ROOT, 'content', `page-${i}.md`), KEYWORDS);
    dirEntries.push({ name: `page-${i}.md`, isDirectory: () => false });
  }

  const fs = {
    readFileSync(p) {
      if (fileContents.has(p)) return fileContents.get(p);
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
    readdirSync(dir) {
      if (dir === path.join(PROJECT_ROOT, 'content')) return dirEntries;
      return [];
    },
  };

  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    isValidFilePath: () => true,
  };
  const callSimilar = search =>
    invoke({ pathname: '/api/content-similar', search: `?path=${SOURCE_REL}${search}`, ctx });

  it('negative limit yields an empty list, not a count-from-the-end tail', async () => {
    const r = await callSimilar('&limit=-3');
    assert.equal(r.status, 200);
    // Math.max(numericParam(...), 0) clamps the negative limit to 0, so
    // candidates.slice(0, 0) === []. Without the clamp, slice(0, -3) would keep
    // the first 22 matches and report a 22-entry `similar` array here instead.
    assert.deepEqual(r.payload.similar, []);
    assert.equal(r.payload.similar.length, 0);
    // `total` still reports the true candidate count, unaffected by the clamp.
    assert.equal(r.payload.total, PAGE_COUNT);
  });

  it('a small negative limit does not over-return the tail', async () => {
    const r = await callSimilar('&limit=-1');
    assert.equal(r.status, 200);
    // slice(0, -1) would keep 24 matches; the clamp collapses it to none.
    assert.equal(r.payload.similar.length, 0);
    assert.notEqual(r.payload.similar.length, PAGE_COUNT - 1, 'not the dropped-tail list');
    assert.equal(r.payload.total, PAGE_COUNT);
  });

  it('absent limit returns the default-sized list (5)', async () => {
    const r = await callSimilar('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.similar.length, 5);
    assert.equal(r.payload.total, PAGE_COUNT);
  });

  it('valid positive limit is honored unchanged', async () => {
    const r = await callSimilar('&limit=8');
    assert.equal(r.status, 200);
    assert.equal(r.payload.similar.length, 8);
    assert.equal(r.payload.total, PAGE_COUNT);
  });

  it('limit above the cap clamps to 20', async () => {
    const r = await callSimilar('&limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.similar.length, 20);
    assert.equal(r.payload.total, PAGE_COUNT);
  });

  it('zero limit returns an empty list (Math.max(0, 0) === 0)', async () => {
    const r = await callSimilar('&limit=0');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.similar, []);
    assert.equal(r.payload.total, PAGE_COUNT);
  });
});
