import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');
const yaml = require('js-yaml');
const { numericParam } = routes;

// Invoke a references route handler with a minimal mocked ctx and capture the
// response that the handler hands to `json(res, status, payload)`.
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

  // ── by-author call site: numericParam(raw, 50, 200) ──
  it('returns the default for absent values (null / empty string)', () => {
    assert.equal(numericParam(null, 50, 200), 50);
    assert.equal(numericParam('', 50, 200), 50);
  });

  it('passes valid numeric values through unchanged', () => {
    assert.equal(numericParam('10', 50, 200), 10);
    assert.equal(numericParam('0', 50, 200), 0);
  });

  it('clamps valid numeric values above the cap to 200', () => {
    assert.equal(numericParam('500', 50, 200), 200);
    assert.equal(numericParam('200', 50, 200), 200);
  });

  it('returns the default for non-numeric values and never yields NaN', () => {
    assert.equal(numericParam('abc', 50, 200), 50);
    assert.ok(!Number.isNaN(numericParam('abc', 50, 200)), 'limit guard never NaN');
  });

  // ── search call site: numericParam(raw, 20, 100) ──
  it('honors the search call-site defaults and cap', () => {
    assert.equal(numericParam(null, 20, 100), 20);
    assert.equal(numericParam('', 20, 100), 20);
    assert.equal(numericParam('abc', 20, 100), 20);
    assert.equal(numericParam('5', 20, 100), 5);
    assert.equal(numericParam('500', 20, 100), 100);
  });
});

// A fixed in-memory references.yaml: 250 entries, each with a distinct author
// and a shared title word ("neural"). 250 distinct authors makes the by-author
// default (50), clamp (200), and the broken NaN path (slice(0, NaN) === empty)
// all distinguishable; 250 entries all matching the same query makes the search
// default (20), clamp (100), and the broken NaN path (unbounded page) all
// distinguishable. The handlers read the file straight from `fs`, so mock `fs`.
const PROJECT_ROOT = '/proj';
const REF_COUNT = 250;
const refs = {};
for (let i = 0; i < REF_COUNT; i++) {
  refs[`ref${i}`] = {
    title: `Neural Study ${i}`,
    author: [`Author ${i}`],
    year: 2000 + (i % 25),
    venue: `Venue ${i % 10}`,
  };
}
const refsYaml = yaml.dump(refs);
const ctx = {
  fs: { readFileSync: () => refsYaml },
  path,
  PROJECT_ROOT,
};

describe('GET /api/references/by-author limit guard', () => {
  const call = search => invoke({ pathname: '/api/references/by-author', search, ctx });

  it('absent limit returns the default-sized page (50)', async () => {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalAuthors, REF_COUNT);
    assert.equal(r.payload.authors.length, 50, 'default limit is 50');
  });

  it('valid limit is honored', async () => {
    const r = await call('?limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.authors.length, 10);
  });

  it('over-cap limit clamps to 200', async () => {
    const r = await call('?limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.authors.length, 200);
  });

  it('non-numeric limit yields the default-bounded page, not an empty one', async () => {
    const r = await call('?limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.authors.length, 50, 'guarded to default 50, not slice(0, NaN) === []');
    assert.notEqual(r.payload.authors.length, 0, 'page is not collapsed to empty');
  });
});

describe('GET /api/references/search limit guard', () => {
  // Every fixture entry matches the query "neural", so the page size is bounded
  // only by the limit.
  const call = search => invoke({ pathname: '/api/references/search', search: `?q=neural${search}`, ctx });

  it('absent limit returns the default-sized page (20)', async () => {
    const r = await call('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.length, 20, 'default limit is 20');
  });

  it('valid limit is honored', async () => {
    const r = await call('&limit=10');
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.length, 10);
  });

  it('over-cap limit clamps to 100', async () => {
    const r = await call('&limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.length, 100);
  });

  it('non-numeric limit yields the default-bounded page, not an unbounded one', async () => {
    const r = await call('&limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.length, 20, 'guarded to default 20, not the full unbounded match set');
    assert.notEqual(r.payload.results.length, 0, 'page is not collapsed to empty');
  });
});
