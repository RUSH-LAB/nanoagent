import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load the real module the way the sibling route
// tests do (next-filetools-version-post-guards.test.mjs), so these cases
// exercise the shipped GET /api/file/version handler rather than a
// reimplementation. This is an add-only characterization test: it pins the
// current behavior of the SINGULAR version lookup and edits no source file.
// The POST /api/file/version handler and the plural GET /api/file/versions list
// are covered by other suites; this file pins only the singular GET, which they
// never touch.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';
// The handler reads the version store from this path (path.join(PROJECT_ROOT,
// 'data', 'versions.json')). The mocked loadJSON answers only for this path, so
// any stray read surfaces as a thrown error instead of passing quietly.
const VERSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'versions.json');
const FILE_PATH = 'content/docs/intro.md';

// Drive the real GET /api/file/version handler over a fully mocked ctx (no real
// filesystem, network, or clock). The singular handler reads only path and id
// from the query, validates the path, loads the version map, finds the entry by
// id, and returns the full stored object. A loadJSON counter proves the store is
// loaded only once both guards pass, so the negative cases (guard short-circuit)
// are observable rather than merely the positive ones.
async function runRoute({
  query = {},
  validPath = true,
  versions = {},
} = {}) {
  let loadJSONCount = 0;
  let captured = null;

  const res = { writableEnded: false };
  const ctx = {
    isValidFilePath: () => validPath,
    loadJSON: (fp) => {
      loadJSONCount += 1;
      if (fp === VERSIONS_FILE) return versions;
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; res.writableEnded = true; },
  };

  const pathname = '/api/file/version';
  const url = new URL(`http://localhost${pathname}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await fileToolsRoutes(req, res, url, pathname, ctx);
  return { captured, loadJSONCount };
}

describe('GET /api/file/version guards', () => {
  it('an invalid path returns 400 Invalid params and never loads the store', async () => {
    const { captured, loadJSONCount } = await runRoute({
      query: { path: FILE_PATH, id: 'ver_1' },
      validPath: false,
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid params' });
    assert.equal(loadJSONCount, 0, 'the param guard runs before the store is loaded');
  });

  it('a valid path with no id query parameter returns 400 Invalid params and never loads the store', async () => {
    // versionId is url.searchParams.get('id'), which is null when the parameter
    // is absent, so the `!versionId` half of the guard trips even on a valid path.
    const { captured, loadJSONCount } = await runRoute({
      query: { path: FILE_PATH },
      validPath: true,
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid params' });
    assert.equal(loadJSONCount, 0, 'the missing id trips the same guard before any load');
  });

  it('a valid path whose array lacks the requested id returns 404 Version not found', async () => {
    const { captured, loadJSONCount } = await runRoute({
      query: { path: FILE_PATH, id: 'ver_missing' },
      versions: { [FILE_PATH]: [{ id: 'ver_other', content: 'x' }] },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Version not found' });
    assert.equal(loadJSONCount, 1, 'the store is loaded once for the lookup, then find returns undefined');
  });

  it('a path with no entry in the store returns 404 via the empty-array fallback', async () => {
    // The store has no key for FILE_PATH, so `versions[filePath] || []` falls
    // back to an empty array and find returns undefined.
    const { captured, loadJSONCount } = await runRoute({
      query: { path: FILE_PATH, id: 'ver_1' },
      versions: {},
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Version not found' });
    assert.equal(loadJSONCount, 1, 'the store is still loaded before the fallback yields 404');
  });
});

describe('GET /api/file/version success', () => {
  it('returns 200 with the full stored object, including content, when the id matches', async () => {
    const stored = {
      id: 'ver_1',
      label: 'My snapshot',
      content: 'the full document body',
      createdAt: '2020-01-01T00:00:00.000Z',
      wordCount: 4,
    };
    const { captured } = await runRoute({
      query: { path: FILE_PATH, id: 'ver_1' },
      versions: { [FILE_PATH]: [stored] },
    });
    assert.equal(captured.status, 200);
    // The singular handler returns the FULL stored object, unlike the plural
    // GET /api/file/versions list, which projects each entry down to
    // id/label/createdAt/wordCount. The round-tripped content field is what
    // distinguishes this response from that projection.
    assert.deepEqual(captured.body, { version: stored });
    assert.equal('content' in captured.body.version, true);
    assert.equal(captured.body.version.content, 'the full document body');
  });

  it('selects the entry whose id matches, not merely the first in the array', async () => {
    const wanted = { id: 'ver_b', label: 'second', content: 'b body', wordCount: 2 };
    const { captured } = await runRoute({
      query: { path: FILE_PATH, id: 'ver_b' },
      versions: {
        [FILE_PATH]: [
          { id: 'ver_a', label: 'first', content: 'a body', wordCount: 2 },
          wanted,
        ],
      },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { version: wanted });
  });
});
