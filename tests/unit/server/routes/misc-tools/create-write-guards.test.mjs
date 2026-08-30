import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling guard suites do (next-snapshots-delete-guards.test.mjs and
// next-whiteboard-write-ownprop-guard.test.mjs) so these cases exercise the
// shipped mutating handlers in server/routes/misc-tools.js rather than a
// reimplementation. Every handler runs over a fully mocked ctx: no real
// filesystem, network, clock, or randomness is touched, except where a stub
// deliberately stands in for one.
//
// This is an add-only characterization test. It pins the CURRENT, correct
// behavior of two create handlers (POST /api/snapshots, POST /api/whiteboard)
// so a future refactor cannot silently change them. No source file is edited.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// Data-file constants handed to each handler through ctx. The mocked loadJSON
// answers only for the matching path, so a stray read surfaces as a thrown error
// instead of silently passing; the handler and the mock agree on each store path.
const SNAPSHOTS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'snapshots.json');
const WHITEBOARDS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'whiteboards.json');

// Drive POST /api/snapshots (create) over a mocked ctx. rateLimit records each
// call (key and limit) and returns the per-call toggle; readBody returns the
// supplied body and counts its calls; isValidFilePath and fs.existsSync are
// per-call toggles with counters; fs.readFileSync returns fixed content; loadJSON
// returns a fresh deep copy of `store` keyed on SNAPSHOTS_FILE; saveJSON records
// every persist; crypto.randomUUID is stubbed to a fixed id and counted;
// sanitizeText is the identity so the stored name is deterministic; json captures
// the (status, body) handed back. The counters let guard branches prove that the
// store, the clock, and the random id were never reached.
async function runSnapshotsCreate({
  body = {},
  store = {},
  rateLimitOk = true,
  validPath = true,
  fileExists = true,
  // Placeholder body for fs.readFileSync. Only the success-path cases reach the
  // read, and each overrides this with a distinctive value to assert on.
  fileContent = 'file body',
  throwOnReadBody = false,
} = {}) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let loadJSONCount = 0;
  let randomUUIDCount = 0;
  let existsSyncCount = 0;
  let readFileCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    isValidFilePath: () => validPath,
    sanitizeText: (s) => s,
    loadJSON: (fp) => {
      loadJSONCount++;
      if (fp === SNAPSHOTS_FILE) return JSON.parse(JSON.stringify(store));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    crypto: { randomUUID: () => { randomUUIDCount++; return 'uuid-1'; } },
    fs: {
      existsSync: () => { existsSyncCount++; return fileExists; },
      readFileSync: () => { readFileCount++; return fileContent; },
    },
    path,
    PROJECT_ROOT,
    SNAPSHOTS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/snapshots';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, loadJSONCount, randomUUIDCount, existsSyncCount, readFileCount, rateLimitCalls };
}

// Drive POST /api/whiteboard (create) over a mocked ctx. The success path reads
// rateLimit, readBody, sanitizeText, loadJSON, saveJSON, WHITEBOARDS_FILE, and
// json. sanitizeText is the identity so the normalized element shape is
// deterministic; loadJSON returns a fresh deep copy keyed on WHITEBOARDS_FILE.
async function runWhiteboardCreate({
  body = {},
  store = {},
  rateLimitOk = true,
  throwOnReadBody = false,
} = {}) {
  const saved = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let loadJSONCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    sanitizeText: (s) => s,
    loadJSON: (fp) => {
      loadJSONCount++;
      if (fp === WHITEBOARDS_FILE) return JSON.parse(JSON.stringify(store));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    WHITEBOARDS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/whiteboard';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, loadJSONCount, rateLimitCalls };
}

describe('POST /api/snapshots (create) in routes/misc-tools.js', () => {
  it('a rate-limited create returns 429, never reads the body, loads, saves, or reads the random id, and uses the snapshots key with limit 30', async () => {
    const r = await runSnapshotsCreate({ rateLimitOk: false, body: { path: 'content/a.md', name: 'x' } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.equal(r.randomUUIDCount, 0);
    assert.equal(r.existsSyncCount, 0);
    // Pin the per-handler rate-limit identity. The snapshots key with limit 30
    // distinguishes this create handler from the restore and delete handlers,
    // which share its 429, 400, and 404 strings but use different keys.
    assert.equal(r.rateLimitCalls.length, 1);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'snapshots:127.0.0.1', limit: 30 });
  });

  it('a path rejected by isValidFilePath returns 400 Invalid path, reads the body once, never loads, saves, or reads the random id', async () => {
    const r = await runSnapshotsCreate({ validPath: false, body: { path: '../etc/passwd', name: 'x' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid path' });
    assert.equal(r.readBodyCount, 1, 'the body is read before the path is validated');
    assert.equal(r.existsSyncCount, 0);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.equal(r.randomUUIDCount, 0);
  });

  it('a missing name with a valid path returns 400 Name is required, never checks the file, loads, saves, or reads the random id', async () => {
    const r = await runSnapshotsCreate({ validPath: true, body: { path: 'content/a.md' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Name is required' });
    assert.equal(r.readBodyCount, 1, 'the body is read before the name is validated');
    assert.equal(r.existsSyncCount, 0, 'the name guard returns before the file is checked');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.equal(r.randomUUIDCount, 0);
  });

  it('a non-string name (42) returns 400 Name is required, never checks the file, loads, or saves', async () => {
    // 42 is truthy so it clears the falsy check, but typeof 42 !== 'string' trips
    // the dedicated type guard; a numeric name is never coerced into a snapshot.
    const r = await runSnapshotsCreate({ validPath: true, body: { path: 'content/a.md', name: 42 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Name is required' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.existsSyncCount, 0);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('a valid path and name whose file is absent returns 404 File not found, checks existence once, never loads, saves, or reads the random id', async () => {
    const r = await runSnapshotsCreate({ validPath: true, fileExists: false, body: { path: 'content/a.md', name: 'x' } });
    assert.equal(r.captured.status, 404);
    assert.deepEqual(r.captured.body, { error: 'File not found' });
    assert.equal(r.existsSyncCount, 1, 'existence is checked before the store is loaded');
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.equal(r.randomUUIDCount, 0);
  });

  it('creates a snapshot: 200 with {success, snapshot:{id,name,createdAt}}, omits the file content, stores it, saves once, stubs the id, and uses the snapshots key', async () => {
    const r = await runSnapshotsCreate({
      body: { path: 'content/a.md', name: 'My Snapshot' },
      store: {},
      fileContent: 'hello world',
    });
    assert.equal(r.captured.status, 200);
    assert.equal(r.captured.body.success, true);
    assert.equal(r.captured.body.snapshot.id, 'uuid-1');
    assert.equal(r.captured.body.snapshot.name, 'My Snapshot');
    assert.equal(typeof r.captured.body.snapshot.createdAt, 'string');
    // The response echoes only id, name, and createdAt; the file content stays out
    // of the returned snapshot.
    assert.equal(Object.hasOwn(r.captured.body.snapshot, 'content'), false);
    assert.deepEqual(Object.keys(r.captured.body.snapshot).sort(), ['createdAt', 'id', 'name']);
    assert.equal(r.loadJSONCount, 1);
    assert.equal(r.existsSyncCount, 1);
    assert.equal(r.readFileCount, 1);
    assert.equal(r.randomUUIDCount, 1);
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].fp, SNAPSHOTS_FILE);
    // The stored snapshot keeps the full content for a later restore.
    const stored = r.saved[0].data['content/a.md'];
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 'uuid-1');
    assert.equal(stored[0].name, 'My Snapshot');
    assert.equal(stored[0].content, 'hello world');
    assert.equal(typeof stored[0].createdAt, 'string');
    assert.deepEqual(r.rateLimitCalls[0], { key: 'snapshots:127.0.0.1', limit: 30 });
  });

  it('caps the stored snapshot list at the last 10, dropping the oldest', async () => {
    const existing = Array.from({ length: 10 }, (_, i) => ({ id: `old-${i}`, name: `n${i}`, content: 'c', createdAt: '2026-01-01T00:00:00.000Z' }));
    const r = await runSnapshotsCreate({
      body: { path: 'content/a.md', name: 'newest' },
      store: { 'content/a.md': existing },
      fileContent: 'fresh',
    });
    assert.equal(r.captured.status, 200);
    const stored = r.saved[0].data['content/a.md'];
    assert.equal(stored.length, 10);
    // old-0 is dropped; the window keeps old-1 through old-9 followed by the new
    // snapshot at the end.
    assert.equal(stored[0].id, 'old-1');
    assert.equal(stored[9].id, 'uuid-1');
    assert.equal(stored[9].name, 'newest');
  });

  it('clamps the stored and returned snapshot name to 200 characters', async () => {
    const r = await runSnapshotsCreate({ body: { path: 'content/a.md', name: 'n'.repeat(250) }, store: {}, fileContent: 'body' });
    assert.equal(r.captured.status, 200);
    assert.equal(r.captured.body.snapshot.name.length, 200);
    assert.equal(r.saved[0].data['content/a.md'][0].name.length, 200);
  });

  it('an outer throw (readBody fails) returns 400 Invalid request, never loads, saves, or reads the random id', async () => {
    const r = await runSnapshotsCreate({ throwOnReadBody: true, body: { path: 'content/a.md', name: 'x' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid request' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.equal(r.randomUUIDCount, 0);
  });
});

describe('POST /api/whiteboard (create) in routes/misc-tools.js', () => {
  it('a rate-limited create returns 429, never reads the body, loads, or saves, and uses the whiteboard key with limit 60', async () => {
    const r = await runWhiteboardCreate({ rateLimitOk: false, body: { id: 'b1', elements: [] } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'whiteboard:127.0.0.1', limit: 60 });
  });

  it('a missing id returns 400 Missing id, never loads or saves', async () => {
    const r = await runWhiteboardCreate({ body: { elements: [] } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing id' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('non-array elements returns 400 elements must be an array, never loads or saves', async () => {
    // The id guard passes for a real string, so the dedicated array guard is the
    // branch under test here.
    const r = await runWhiteboardCreate({ body: { id: 'b1', elements: 'nope' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'elements must be an array' });
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });

  it('creates a whiteboard: 200 with the normalized element shape, numeric and hex fallbacks, a string updatedAt, and one save', async () => {
    const r = await runWhiteboardCreate({
      body: {
        id: 'board-x',
        elements: [
          { type: 'note', x: 5, y: 6, w: 200, h: 120, text: 'hi', color: '#abc' },
          {},
        ],
      },
    });
    assert.equal(r.captured.status, 200);
    assert.equal(r.captured.body.success, true);
    const wb = r.captured.body.whiteboard;
    assert.equal(wb.id, 'board-x');
    assert.equal(typeof wb.updatedAt, 'string');
    // The first element keeps its provided values; the empty element falls back to
    // x/y 0, w 160, h 100, an empty text, and the default color.
    assert.deepEqual(wb.elements, [
      { type: 'note', x: 5, y: 6, w: 200, h: 120, text: 'hi', color: '#abc' },
      { type: 'note', x: 0, y: 0, w: 160, h: 100, text: '', color: '#fef3c7' },
    ]);
    assert.equal(r.loadJSONCount, 1);
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].fp, WHITEBOARDS_FILE);
    // The persisted record is the same object that is returned, keyed by the id.
    assert.deepEqual(r.saved[0].data['board-x'], wb);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'whiteboard:127.0.0.1', limit: 60 });
  });

  it('clamps oversize inputs: id to 200 characters, element type to 50, text to 1000, and the list to 500 elements', async () => {
    const manyElements = Array.from({ length: 501 }, () => ({ type: 't'.repeat(60), x: 1, y: 1, w: 1, h: 1, text: 'z'.repeat(1100), color: '#fff' }));
    const r = await runWhiteboardCreate({ body: { id: 'x'.repeat(250), elements: manyElements } });
    assert.equal(r.captured.status, 200);
    const wb = r.captured.body.whiteboard;
    assert.equal(wb.id.length, 200);
    assert.equal(wb.elements.length, 500);
    assert.equal(wb.elements[0].type.length, 50);
    assert.equal(wb.elements[0].text.length, 1000);
    assert.equal(r.saved.length, 1);
  });

  it('an outer throw (readBody fails) returns 400 Invalid request, never loads or saves', async () => {
    const r = await runWhiteboardCreate({ throwOnReadBody: true, body: { id: 'b1', elements: [] } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid request' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.loadJSONCount, 0);
    assert.equal(r.saved.length, 0);
  });
});
