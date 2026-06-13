import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling guard suites do (next-misctools-create-write-guards.test.mjs and
// next-snapshots-restore-guards.test.mjs) so these cases exercise the shipped
// GET /api/snapshots list handler in server/routes/misc-tools.js rather than a
// reimplementation. The handler runs over a fully mocked ctx: no real
// filesystem, network, clock, or randomness is ever touched.
//
// This is an add-only characterization test. It pins the CURRENT behavior of the
// list-snapshots-for-a-file handler (the GET sibling of the POST create, POST
// restore, and DELETE handlers at /api/snapshots) so a future refactor cannot
// silently change it. No source file is edited.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The handler loads the snapshot store at this path, mirroring server.js
// (path.join(PROJECT_ROOT, 'data', 'snapshots.json')). The mocked loadJSON
// answers only for this exact path, so a stray read surfaces as a thrown error
// instead of silently passing; the same constant is handed to the handler
// through ctx, so the handler and the mock agree on the store path.
const SNAPSHOTS_FILE = path.join(PROJECT_ROOT, 'data', 'snapshots.json');

// Drive GET /api/snapshots over a mocked ctx. The handler reads the requested
// path from url.searchParams.get('path'), validates it, loads the store, and
// projects each entry. isValidFilePath records the exact value it receives and
// returns the per-call toggle, so a rejected path proves both what the handler
// extracts and that the store is never loaded. loadJSON returns a fresh deep
// copy of `store` keyed on SNAPSHOTS_FILE, a faithful stand-in for a fresh disk
// read. rateLimit, readBody, and saveJSON are recorders that should stay at zero
// on every branch: the list handler neither throttles, reads a body, nor
// persists. json captures the (status, body) handed back.
//
// When `pathParam` is omitted, no `path` query is set, so the real handler hands
// url.searchParams.get('path') === null to isValidFilePath; the shipped
// isValidFilePath returns false for a falsy path (server/server-utils.js), so
// the false toggle in that case mirrors production.
async function runSnapshotsList({
  pathParam,
  store = {},
  validPath = true,
} = {}) {
  const saved = [];
  const validatedPaths = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let loadJSONCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return true; },
    readBody: async () => { readBodyCount++; return {}; },
    isValidFilePath: (fp) => { validatedPaths.push(fp); return validPath; },
    loadJSON: (fp) => {
      loadJSONCount++;
      if (fp === SNAPSHOTS_FILE) return JSON.parse(JSON.stringify(store));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    SNAPSHOTS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/snapshots';
  const url = new URL(`http://localhost${pathname}`);
  if (pathParam !== undefined) url.searchParams.set('path', pathParam);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, validatedPaths, readBodyCount, loadJSONCount, rateLimitCalls };
}

describe('GET /api/snapshots (list) path validation in routes/misc-tools.js', () => {
  it('a path rejected by isValidFilePath returns 400 Invalid path before the store is loaded, with no rate limit, body read, or save', async () => {
    // isValidFilePath receives the raw query value and, on false, the handler
    // returns at line 495 before loadJSON; the list handler also never throttles,
    // reads a body, or persists, distinguishing it from the create/restore/delete
    // siblings at this path.
    const r = await runSnapshotsList({ validPath: false, pathParam: '../etc/passwd' });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid path' });
    assert.deepEqual(r.validatedPaths, ['../etc/passwd'], 'the query path is handed to isValidFilePath verbatim');
    assert.equal(r.loadJSONCount, 0, 'the store is not loaded once the path is rejected');
    assert.equal(r.rateLimitCalls.length, 0);
    assert.equal(r.readBodyCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a missing ?path query hands null to isValidFilePath and returns 400 Invalid path, never loading the store', async () => {
    // With no `path` query, url.searchParams.get('path') is null; the shipped
    // isValidFilePath returns false for a falsy path, so the request short
    // circuits with 400 before the store is read.
    const r = await runSnapshotsList({ validPath: false });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid path' });
    assert.deepEqual(r.validatedPaths, [null], 'a missing query param reaches the validator as null');
    assert.equal(r.loadJSONCount, 0);
  });
});

describe('GET /api/snapshots (list) projection in routes/misc-tools.js', () => {
  it('projects each stored entry to exactly {id, name, createdAt}, dropping content and any other field, in stored order, keyed on the requested path', async () => {
    // The requested key holds two entries carrying content plus assorted extra
    // fields; a sibling key proves the lookup is keyed on the requested path. The
    // projection keeps only id, name, and createdAt and preserves array order.
    const store = {
      'content/a.md': [
        { id: 's1', name: 'first draft', createdAt: '2026-01-01T00:00:00.000Z', content: 'BODY ONE', extra: 1, updatedAt: 'x' },
        { id: 's2', name: 'second draft', createdAt: '2026-02-02T00:00:00.000Z', content: 'BODY TWO', size: 99 },
      ],
      'content/other.md': [
        { id: 'z9', name: 'unrelated', createdAt: '2026-03-03T00:00:00.000Z', content: 'OTHER' },
      ],
    };
    const r = await runSnapshotsList({ validPath: true, pathParam: 'content/a.md', store });
    assert.equal(r.captured.status, 200);
    assert.deepEqual(Object.keys(r.captured.body), ['snapshots'], 'the 200 body is exactly {snapshots: [...]}');
    assert.equal(r.captured.body.snapshots.length, 2);
    // Each entry is projected to exactly the three fields; content and the extras
    // never surface, and the three projected values round-trip in order.
    assert.deepEqual(r.captured.body.snapshots, [
      { id: 's1', name: 'first draft', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 's2', name: 'second draft', createdAt: '2026-02-02T00:00:00.000Z' },
    ]);
    for (const entry of r.captured.body.snapshots) {
      assert.deepEqual(Object.keys(entry).sort(), ['createdAt', 'id', 'name']);
      assert.equal(Object.hasOwn(entry, 'content'), false, 'the stored content is stripped from each returned entry');
    }
    // The list handler reads the store exactly once and never throttles, reads a
    // body, or persists.
    assert.equal(r.loadJSONCount, 1);
    assert.deepEqual(r.validatedPaths, ['content/a.md']);
    assert.equal(r.rateLimitCalls.length, 0);
    assert.equal(r.readBodyCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('copies the projected field values verbatim, so falsy name and createdAt strings are preserved rather than dropped', async () => {
    // The projection is a plain field copy, not a truthy filter: an empty-string
    // name and createdAt survive as '' while content is still stripped.
    const store = { 'content/a.md': [{ id: 's1', name: '', createdAt: '', content: 'BODY' }] };
    const r = await runSnapshotsList({ validPath: true, pathParam: 'content/a.md', store });
    assert.equal(r.captured.status, 200);
    assert.deepEqual(r.captured.body.snapshots, [{ id: 's1', name: '', createdAt: '' }]);
    assert.equal(Object.hasOwn(r.captured.body.snapshots[0], 'content'), false);
    assert.equal(r.loadJSONCount, 1);
  });
});

describe('GET /api/snapshots (list) empty fallback in routes/misc-tools.js', () => {
  it('a valid path absent from the store returns 200 {snapshots: []} via the || [] fallback, loading the store once', async () => {
    // The requested key is absent (a sibling key is present to prove the lookup is
    // keyed on the requested path, not on an empty store), so snapshots[filePath]
    // is undefined and `|| []` yields an empty list with a 200.
    const store = { 'content/other.md': [{ id: 'z9', name: 'unrelated', createdAt: '2026-03-03T00:00:00.000Z', content: 'OTHER' }] };
    const r = await runSnapshotsList({ validPath: true, pathParam: 'content/a.md', store });
    assert.equal(r.captured.status, 200);
    assert.deepEqual(r.captured.body, { snapshots: [] });
    assert.equal(r.loadJSONCount, 1);
    assert.deepEqual(r.validatedPaths, ['content/a.md']);
    assert.equal(r.saved.length, 0);
  });
});
