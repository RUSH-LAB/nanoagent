import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load the real module the way the sibling server
// route tests do (next-pins-crud-guards.test.mjs, next-search-global-guard.test.mjs),
// so these cases exercise the shipped POST /api/file/version handler rather than a
// reimplementation. This is an add-only characterization test: it pins the current,
// correct behavior of the handler and edits no source file.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';
// The handler persists named versions to this file (path.join(PROJECT_ROOT,
// 'data', 'versions.json')). The mocked loadJSON below answers only for this
// path, so any stray read surfaces as a thrown error instead of passing quietly.
const VERSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'versions.json');
const FILE_PATH = 'content/docs/intro.md';
const DEFAULT_CONTENT = 'hello world foo'; // three words, so wordCount is 3

// Drive the real POST /api/file/version handler over a fully mocked ctx (no real
// filesystem, network, or git). rateLimit/readBody/loadJSON/saveJSON/json mirror
// the write-guard harness in next-pins-crud-guards.test.mjs; isValidFilePath and
// the fs stub follow next-search-global-guard.test.mjs. Counters prove the
// negative cases (body never read, file never read) rather than only the positive
// ones, and `saved` records every persist so save counts are observable.
async function runRoute({
  body = { path: FILE_PATH },
  doc = {},
  rateLimitOk = true,
  validPath = true,
  fileContent = DEFAULT_CONTENT,
  readThrows = false,
} = {}) {
  const saved = [];
  let readBodyCount = 0;
  let readFileCount = 0;
  let rateLimitKey = null;
  let captured = null;

  const res = { writableEnded: false };
  const ctx = {
    rateLimit: (key) => { rateLimitKey = key; return rateLimitOk; },
    readBody: async () => { readBodyCount += 1; return body; },
    loadJSON: (fp) => {
      if (fp === VERSIONS_FILE) return doc;
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    isValidFilePath: () => validPath,
    sanitizeText: (s) => s, // identity, so the stored label is observable verbatim
    fs: {
      readFileSync: () => {
        readFileCount += 1;
        if (readThrows) throw new Error('ENOENT: no such file');
        return fileContent;
      },
    },
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; res.writableEnded = true; },
  };

  const pathname = '/api/file/version';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  await fileToolsRoutes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, readFileCount, rateLimitKey };
}

describe('POST /api/file/version guards', () => {
  it('a rate-limited POST returns 429, never reads the body, and never saves', async () => {
    const { captured, saved, readBodyCount } = await runRoute({ rateLimitOk: false });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(readBodyCount, 0, 'the 429 short-circuits before the body is read');
    assert.equal(saved.length, 0);
  });

  it('uses the file-version rate-limit key scoped to the caller address', async () => {
    const { rateLimitKey } = await runRoute();
    assert.equal(rateLimitKey, 'file-version:127.0.0.1');
  });

  it('an invalid path returns 400 Invalid path, never reads the file, and never saves', async () => {
    const { captured, saved, readFileCount } = await runRoute({ validPath: false });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid path' });
    assert.equal(readFileCount, 0, 'the path guard runs before any fs.readFileSync');
    assert.equal(saved.length, 0);
  });

  it('a string label longer than 500 characters returns 400 and never saves', async () => {
    const { captured, saved, readFileCount } = await runRoute({
      body: { path: FILE_PATH, label: 'x'.repeat(501) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Label must be 500 characters or fewer' });
    assert.equal(readFileCount, 0, 'the label guard runs before any fs.readFileSync');
    assert.equal(saved.length, 0);
  });

  it('a valid path whose readFileSync throws returns 400 Invalid request and never saves', async () => {
    const { captured, saved, readFileCount } = await runRoute({ readThrows: true });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid request' });
    assert.equal(readFileCount, 1, 'the read was attempted and threw into the outer catch');
    assert.equal(saved.length, 0);
  });

  it('a non-string label skips the length guard and proceeds to a 200', async () => {
    // The guard is `typeof label === 'string' && label.length > 500`, so a
    // non-string label (here a number) never trips it and the request succeeds.
    const { captured, saved } = await runRoute({
      body: { path: FILE_PATH, label: 12345 },
    });
    assert.equal(captured.status, 200);
    assert.equal(saved.length, 1);
    assert.equal(captured.body.version.label, 12345);
  });
});

describe('POST /api/file/version success', () => {
  it('a valid request (label omitted) returns 200 with the curated version subset and saves once', async () => {
    const { captured, saved } = await runRoute({ doc: {} });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, VERSIONS_FILE);

    const v = captured.body.version;
    // The response carries only the curated subset; content is stored but not echoed.
    assert.deepEqual(Object.keys(v).sort(), ['createdAt', 'id', 'label', 'wordCount']);
    assert.equal('content' in v, false);
    // Deterministic fields: the omitted label defaults through the identity
    // sanitizeText, and 'hello world foo' is three words.
    assert.equal(v.label, 'Untitled version');
    assert.equal(v.wordCount, 3);
    // The id and createdAt are generated, so assert presence and type only.
    assert.equal(typeof v.id, 'string');
    assert.equal(typeof v.createdAt, 'string');
  });

  it('persists exactly one new version that, unlike the response, carries the content', async () => {
    const { captured, saved } = await runRoute({ doc: {} });
    const stored = saved[0].data[FILE_PATH];
    assert.equal(stored.length, 1, 'the path array grew by exactly one entry');
    assert.equal(stored[0].id, captured.body.version.id, 'the stored id matches the response id');
    assert.equal(stored[0].content, DEFAULT_CONTENT, 'the stored version keeps the content');
  });

  it('echoes a provided short label through the identity sanitizeText', async () => {
    const { captured } = await runRoute({
      body: { path: FILE_PATH, label: 'My snapshot' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.version.label, 'My snapshot');
  });

  it('caps the stored history at 50 versions, dropping the oldest', async () => {
    const seeded = Array.from({ length: 50 }, (_, i) => ({
      id: `seed_${i}`, label: `v${i}`, content: 'x',
      createdAt: '2020-01-01T00:00:00.000Z', wordCount: 1,
    }));
    const { captured, saved } = await runRoute({
      doc: { [FILE_PATH]: seeded },
    });
    const stored = saved[0].data[FILE_PATH];
    assert.equal(stored.length, 50, 'the array stays capped at 50 after the push');
    assert.equal(stored[0].id, 'seed_1', 'the oldest entry (seed_0) was dropped');
    assert.equal(stored[49].id, captured.body.version.id, 'the newest entry is last');
  });
});
