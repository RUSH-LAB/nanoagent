import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module the way the sibling route tests
// do (tests/next-whiteboard-write-ownprop-guard.test.mjs and
// tests/next-citations-cache.test.mjs). This add-only characterization test pins
// the CURRENT, correct behavior of three network-free handlers over a fully
// mocked ctx: no real filesystem, network, subprocess, clock, or randomness.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

const WHITEBOARDS_FILE = '/fake/whiteboards.json';
const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// GET /api/whiteboards (the plural list, distinct from the singular
// /api/whiteboard covered by tests/next-whiteboard-write-ownprop-guard.test.mjs).
// The handler is not wrapped in cached and has no try/catch, so it always answers
// 200. It reads only loadJSON, WHITEBOARDS_FILE, and json from ctx, mapping
// Object.values(store) to {id, elementCount, updatedAt} where elementCount falls
// back to 0 when the elements field is missing.
async function listWhiteboards(store) {
  const url = new URL('http://localhost/api/whiteboards');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    WHITEBOARDS_FILE,
    loadJSON: (file) => (file === WHITEBOARDS_FILE ? store : {}),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/whiteboards', ctx);
  return captured;
}

describe('GET /api/whiteboards: plural list summary', () => {
  it('maps a populated store to per-record id, elementCount, and updatedAt', async () => {
    const store = {
      'board-1': { id: 'board-1', elements: [{}, {}, {}], updatedAt: '2026-01-01T00:00:00.000Z' },
      'board-2': { id: 'board-2', elements: [{}], updatedAt: '2026-02-02T00:00:00.000Z' },
    };
    const r = await listWhiteboards(store);
    assert.equal(r.status, 200);
    // Object.values preserves insertion order, so board-1 precedes board-2.
    assert.deepEqual(r.payload, {
      whiteboards: [
        { id: 'board-1', elementCount: 3, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'board-2', elementCount: 1, updatedAt: '2026-02-02T00:00:00.000Z' },
      ],
    });
  });

  it('returns an empty list for an empty store', async () => {
    const r = await listWhiteboards({});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { whiteboards: [] });
  });

  it('treats a record with no elements field as elementCount 0', async () => {
    const store = { 'board-3': { id: 'board-3', updatedAt: '2026-03-03T00:00:00.000Z' } };
    const r = await listWhiteboards(store);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      whiteboards: [{ id: 'board-3', elementCount: 0, updatedAt: '2026-03-03T00:00:00.000Z' }],
    });
  });
});

// GET /api/references/impact. Wrapped in cached('ref-impact', 60000, fn). The
// closure reads bibliography/references.yaml through the real js-yaml, walks
// GET /api/debug/routes. No I/O and not cached: the handler echoes exactly eight
// fields off ctx._routeDiagnostics. The boot-time analysis that fills
// _routeDiagnostics runs in server/index.js, so the test injects a fake object and pins
// the echo rather than exercising the analyzer.
async function debugRoutes(diagnostics) {
  const url = new URL('http://localhost/api/debug/routes');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    _routeDiagnostics: diagnostics,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/debug/routes', ctx);
  return captured;
}

describe('GET /api/debug/routes: diagnostics echo', () => {
  it('echoes exactly the eight diagnostics fields, dropping any extras', async () => {
    const diagnostics = {
      totalHandlers: 42,
      uniqueRoutes: 40,
      duplicateCount: 2,
      deadCodeLines: 7,
      startupMs: 123,
      memoryAtStartupMB: 55,
      routes: ['/api/a', '/api/b'],
      duplicates: [{ path: '/api/x', count: 2 }],
      secretInternal: 'should not be echoed',
    };
    const r = await debugRoutes(diagnostics);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      totalHandlers: 42,
      uniqueRoutes: 40,
      duplicateCount: 2,
      deadCodeLines: 7,
      startupMs: 123,
      memoryAtStartupMB: 55,
      routes: ['/api/a', '/api/b'],
      duplicates: [{ path: '/api/x', count: 2 }],
    });
    // The extra field is not part of the echoed shape.
    assert.equal(Object.hasOwn(r.payload, 'secretInternal'), false);
  });

  it('reflects a different injected object so the echo is not hardcoded', async () => {
    const diagnostics = {
      totalHandlers: 0,
      uniqueRoutes: 0,
      duplicateCount: 0,
      deadCodeLines: 0,
      startupMs: 0,
      memoryAtStartupMB: 0,
      routes: [],
      duplicates: [],
    };
    const r = await debugRoutes(diagnostics);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, diagnostics);
  });
});
