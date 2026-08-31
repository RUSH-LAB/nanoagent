import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { newStore } from '../../../_harness.mjs';
import { key } from '../../../_harness.mjs';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling snapshot-delete suite does (next-snapshots-delete-guards.test.mjs) so
// these cases exercise the shipped POST /api/snapshots/restore handler rather
// than a reimplementation. The handler runs over a fully mocked ctx: no real
// filesystem, network, or git is ever touched.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The handler loads the snapshot store at this path, mirroring server/index.js
// (path.join(PROJECT_ROOT, 'var', 'data', 'snapshots.json')). The mocked loadJSON
// answers only for this exact path, so a stray read surfaces as a thrown error
// instead of silently passing; the same constant is handed to the handler
// through ctx, so the guard and the handler agree on the store path.
const SNAPSHOTS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'snapshots.json');
// The path a restore request carries is relative to the caller's own content
// root, which the session resolves to one organization's tree under content/.
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content', 'mochi');

// Drive POST /api/snapshots/restore over a mocked ctx. rateLimit records every
// call (key and limit) and returns the per-call toggle, so a rate-limited
// request can prove both the key shape and that the body was never read.
// isValidFilePath is a per-call toggle; readBody returns the supplied body and
// counts its own calls; fs.existsSync returns the fileExists toggle and records
// the probed path; loadJSON returns a fresh deep copy of `store`, a faithful
// stand-in for a fresh disk read. fs.writeFileSync, invalidateCache, and saveJSON
// each record their calls, so the negative branches can assert zero side effects
// and the success branch can prove the file is written while the store is never
// persisted. json captures the (status, body) handed back.
async function runRoute({
  body = {},
  store = {},
  rateLimitOk = true,
  validPath = true,
  fileExists = true,
  throwOnReadBody = false,
} = {}) {
  const writes = [];
  const invalidations = [];
  const existsChecks = [];
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let captured = null;
  const scoped = newStore().seed('snapshots', store);
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    isValidFilePath: () => validPath,
    ...scoped.ctxFields,
    fs: {
      existsSync: (fp) => { existsChecks.push(fp); return fileExists; },
      writeFileSync: (fp, data, enc) => { writes.push({ fp, data, enc }); },
    },
    invalidateCache: (key) => { invalidations.push(key); },
    cacheKey: (_orgId, name) => key(name),
    path,
    PROJECT_ROOT,
    contentRootFor: () => CONTENT_DIR,
    SNAPSHOTS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/snapshots/restore';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return {
    captured, writes, invalidations, existsChecks, readBodyCount, rateLimitCalls,
    // The store's own tallies, standing in for the loadJSON and saveJSON
    // call counts these cases used to assert on.
    get loadJSONCount() { return scoped.calls.reads; },
    get saved() { return scoped.calls.writes; },
    store: scoped,
  };
}

describe('POST /api/snapshots/restore rate limit', () => {
  it('a rate-limited restore returns 429, never reads the body, never loads, never writes, never invalidates, and uses the snapshots-restore key with limit 30', async () => {
    const { captured, writes, invalidations, readBodyCount, loadJSONCount, rateLimitCalls } = await runRoute({
      rateLimitOk: false,
      body: { path: 'a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(loadJSONCount, 0);
    assert.equal(writes.length, 0);
    assert.equal(invalidations.length, 0);
    // Pin the per-handler rate-limit identity: the key is scoped to the socket
    // address with a limit of 30. This snapshots-restore key is unique to this
    // handler, distinguishing it from the snapshots create and snapshots-delete
    // handlers that share the same 429 and 400 strings.
    assert.equal(rateLimitCalls.length, 1);
    assert.deepEqual(rateLimitCalls[0], { key: 'snapshots-restore:127.0.0.1', limit: 30 });
  });
});

describe('POST /api/snapshots/restore path validation', () => {
  it('a path rejected by isValidFilePath returns 400 Invalid path, reads the body, never loads, never writes, never invalidates', async () => {
    // The body is read first; only then is the extracted path validated, so a
    // rejected path reaches the dedicated Invalid path branch before the store is
    // ever loaded or the file is touched.
    const { captured, writes, invalidations, existsChecks, readBodyCount, loadJSONCount } = await runRoute({
      validPath: false,
      body: { path: '../etc/passwd', snapshotId: 's1' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid path' });
    assert.equal(readBodyCount, 1, 'the body is read before the path is validated');
    assert.equal(loadJSONCount, 0, 'the store is not loaded once the path is rejected');
    assert.equal(writes.length, 0);
    assert.equal(invalidations.length, 0);
    assert.equal(existsChecks.length, 0, 'the path guard precedes the file-existence probe, which is never reached');
  });
});

describe('POST /api/snapshots/restore snapshotId validation', () => {
  it('a missing snapshotId returns 400 snapshotId is required, reads the body, never loads, never writes', async () => {
    const { captured, writes, invalidations, existsChecks, readBodyCount, loadJSONCount } = await runRoute({ body: { path: 'a.md' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'snapshotId is required' });
    assert.equal(readBodyCount, 1, 'the body is read before snapshotId is validated');
    assert.equal(loadJSONCount, 0);
    assert.equal(writes.length, 0);
    assert.equal(invalidations.length, 0);
    assert.equal(existsChecks.length, 0, 'the snapshotId guard precedes the file-existence probe, which is never reached');
  });

  it('a non-string snapshotId (42) returns 400 snapshotId is required, reads the body, never loads, never writes', async () => {
    // 42 is truthy so it clears the falsy check, but typeof 42 !== 'string'
    // trips the dedicated type guard. A numeric snapshotId is never coerced.
    const { captured, writes, invalidations, existsChecks, readBodyCount, loadJSONCount } = await runRoute({ body: { path: 'a.md', snapshotId: 42 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'snapshotId is required' });
    assert.equal(readBodyCount, 1, 'the body is read before snapshotId is validated');
    assert.equal(loadJSONCount, 0);
    assert.equal(writes.length, 0);
    assert.equal(invalidations.length, 0);
    assert.equal(existsChecks.length, 0, 'the snapshotId guard precedes the file-existence probe, which is never reached');
  });
});

describe('POST /api/snapshots/restore file existence', () => {
  it('a target file absent on disk returns 404 File not found before the store is loaded, never writes, never invalidates', async () => {
    // The existence check precedes the store load, so a missing file short
    // circuits with loadJSON uncalled. The probed path is the content-root join
    // of the requested path.
    const { captured, writes, invalidations, loadJSONCount, existsChecks } = await runRoute({
      fileExists: false,
      body: { path: 'a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'File not found' });
    assert.equal(loadJSONCount, 0, 'the existence check runs before the store load');
    assert.equal(writes.length, 0);
    assert.equal(invalidations.length, 0);
    assert.deepEqual(existsChecks, [path.join(CONTENT_DIR, 'a.md')]);
  });
});

describe('POST /api/snapshots/restore snapshot lookup', () => {
  it('a present file whose key is absent from the store returns 404 Snapshot not found, loads once, never writes', async () => {
    // snapshots[filePath] is undefined, so `|| []` yields an empty list and
    // .find returns undefined. A sibling key is present to show the lookup is
    // keyed on the requested path, not on an empty store.
    const { captured, writes, invalidations, loadJSONCount } = await runRoute({
      store: { 'other.md': [{ id: 'x1', name: 'other', content: 'X' }] },
      body: { path: 'a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Snapshot not found' });
    assert.equal(loadJSONCount, 1);
    assert.equal(writes.length, 0);
    assert.equal(invalidations.length, 0);
  });

  it('a present file whose key holds no matching id returns 404 Snapshot not found, loads once, never writes', async () => {
    const { captured, writes, invalidations, loadJSONCount } = await runRoute({
      store: { 'a.md': [{ id: 's1', name: 'one', content: 'A' }, { id: 's2', name: 'two', content: 'B' }] },
      body: { path: 'a.md', snapshotId: 'nope' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Snapshot not found' });
    assert.equal(loadJSONCount, 1);
    assert.equal(writes.length, 0);
    assert.equal(invalidations.length, 0);
  });
});

describe('POST /api/snapshots/restore success', () => {
  it('a matching snapshot is written back to the file and the search cache is invalidated, returning only the snapshot id and name', async () => {
    // Two snapshots are seeded and the second is restored, so the case proves
    // the lookup matches by id (not array position) and that the file receives
    // the matched snapshot content, not the first entry. The response echoes the
    // id and name only; the content never leaks back to the caller.
    const store = {
      'a.md': [
        { id: 's1', name: 'first draft', content: 'FIRST BODY', createdAt: '2024-01-01T00:00:00.000Z' },
        { id: 's2', name: 'second draft', content: 'SECOND BODY', createdAt: '2024-02-02T00:00:00.000Z' },
      ],
    };
    const { captured, writes, invalidations, saved, loadJSONCount } = await runRoute({
      store,
      body: { path: 'a.md', snapshotId: 's2' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, restored: { id: 's2', name: 'second draft' } });
    // The restored payload carries no content or createdAt field; only id and name surface.
    assert.equal(Object.hasOwn(captured.body.restored, 'content'), false);
    assert.equal(Object.hasOwn(captured.body.restored, 'createdAt'), false);
    // The file is written exactly once with the matched snapshot content and utf-8 encoding.
    assert.equal(loadJSONCount, 1);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { fp: path.join(CONTENT_DIR, 'a.md'), data: 'SECOND BODY', enc: 'utf-8' });
    // The search cache is invalidated exactly once with the workspace's 'search' key.
    assert.deepEqual(invalidations, [key('search')]);
    // Restore writes the file but never persists the snapshot store, unlike the
    // create and delete handlers that call saveJSON.
    assert.equal(saved.length, 0);
    // The handler only reads the store, so the caller's seed is left intact.
    assert.deepEqual(store['a.md'].map((s) => s.id), ['s1', 's2']);
  });
});

describe('POST /api/snapshots/restore outer catch', () => {
  it('an outer throw (readBody fails) returns 400 Invalid request, never loads, never writes, never invalidates', async () => {
    const { captured, writes, invalidations, loadJSONCount, readBodyCount, rateLimitCalls } = await runRoute({
      throwOnReadBody: true,
      body: { path: 'a.md', snapshotId: 's1' },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid request' });
    assert.equal(loadJSONCount, 0);
    assert.equal(writes.length, 0);
    assert.equal(invalidations.length, 0);
    // The rate-limit guard passed and the body read was attempted before the throw.
    assert.equal(rateLimitCalls.length, 1);
    assert.equal(readBodyCount, 1);
  });
});
