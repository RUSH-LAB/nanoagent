import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');
const { numericParam } = routes;

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

describe('numericParam helper', () => {
  it('is exported alongside the route handler', () => {
    assert.equal(typeof routes, 'function', 'default export is the route handler');
    assert.equal(typeof numericParam, 'function', 'numericParam is exported');
  });

  // ── content-similar call site: numericParam(raw, 5, 20) ──
  it('returns the default for absent values (null / empty string)', () => {
    assert.equal(numericParam(null, 5, 20), 5);
    assert.equal(numericParam('', 5, 20), 5);
  });

  it('passes valid numeric values through unchanged', () => {
    assert.equal(numericParam('8', 5, 20), 8);
    assert.equal(numericParam('0', 5, 20), 0);
  });

  it('clamps valid numeric values above the cap', () => {
    assert.equal(numericParam('50', 5, 20), 20);
  });

  it('returns the default for non-numeric values and never yields NaN', () => {
    assert.equal(numericParam('abc', 5, 20), 5);
    assert.ok(!Number.isNaN(numericParam('abc', 5, 20)), 'limit guard never NaN');
  });
});

describe('GET /api/content-similar limit guard', () => {
  // A fixed in-memory content tree: one source file plus 25 candidate pages
  // that each share every source keyword (overlap 8 > 2), so the default (5),
  // the clamp (20), and the broken NaN path (slice(0, NaN) === empty) are all
  // distinguishable. The handler reads the tree straight from `fs`, so mock
  // `fs` rather than `cached()`.
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
    // /api/content-similar now wraps its candidate scan in cached(key, ttl, fn);
    // inject a pass-through so the handler still runs the fs-backed walk here, which
    // keeps the limit-guard cases (default / clamp / NaN) exercising the real scan.
    cached: (_k, _t, fn) => fn(),
  };
  const callSimilar = search =>
    invoke({ pathname: '/api/content-similar', search: `?path=${SOURCE_REL}${search}`, ctx });

  it('absent limit returns the default-sized list (5)', async () => {
    const r = await callSimilar('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.similar.length, 5);
    assert.equal(r.payload.total, PAGE_COUNT);
  });

  it('valid limit is honored', async () => {
    const r = await callSimilar('&limit=8');
    assert.equal(r.status, 200);
    assert.equal(r.payload.similar.length, 8);
  });

  it('valid limit above the cap clamps to 20', async () => {
    const r = await callSimilar('&limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.similar.length, 20);
  });

  it('non-numeric limit yields the default-bounded list, not an empty one', async () => {
    const r = await callSimilar('&limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.similar.length, 5, 'guarded to default, not slice(0, NaN) === []');
    assert.notEqual(r.payload.similar.length, 0, 'list is not collapsed to empty');
  });
});
