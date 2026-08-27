import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the REAL route module the way the sibling
// route test does (next-batchexport-md-re-hoist.test.mjs uses the same driver).
const require = createRequire(import.meta.url);
const miscRoutes = require('../../../../../server/routes/misc-tools.js');
// Use the production isValidDir so the first guard is pinned against the real
// contract rather than an approximation of it.
const { isValidDir } = require('../../../../../server/server-utils.js');

const PROJECT_ROOT = '/fake/root';
const EXPORT_DIR = 'content/batch-sample';

// A Dirent-like entry for the readdirSync(d, {withFileTypes: true}) the handler
// uses while walking the directory tree.
function dirent(name, kind) {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
  };
}

// An fs spy whose every method throws and bumps a counter. The two early guards
// (isValidDir and the format check) run BEFORE the try block and before any fs
// access, so a guard that fires must leave reads at 0; were it to touch fs the
// throw would also surface uncaught and fail the test loudly.
function makeNoTouchFs() {
  const counter = { reads: 0 };
  const trap = (name) => () => {
    counter.reads++;
    throw new Error(`fs.${name} must not run for a guard that returns before fs access`);
  };
  return {
    counter,
    fs: {
      existsSync: trap('existsSync'),
      statSync: trap('statSync'),
      readdirSync: trap('readdirSync'),
      readFileSync: trap('readFileSync'),
    },
  };
}

// An in-memory fs for the post-guard paths. `dirs` maps an absolute directory
// path to its Dirent list (a key marks that path as a directory); `files` lists
// absolute paths that exist but are NOT directories. readFileSync is never
// reached on the guard paths under test, so it throws if it ever runs.
function makeTreeFs({ dirs = {}, files = [] } = {}) {
  const dirSet = new Set(Object.keys(dirs));
  const fileSet = new Set(files);
  return {
    existsSync: (p) => dirSet.has(p) || fileSet.has(p),
    statSync: (p) => ({ isDirectory: () => dirSet.has(p) }),
    readdirSync: (d) => dirs[d] || [],
    readFileSync: () => { throw new Error('readFileSync should not run on a guard path'); },
  };
}

// Drive GET /api/export/batch through a mocked ctx (no network, no real fs).
// Returns the {status, body} captured by the json() recorder.
async function runBatch({ dir, format, fs }) {
  let captured = null;
  const res = {
    writableEnded: false,
    writeHead() { return res; },
    end(body) { captured = body; res.writableEnded = true; return res; },
  };
  const ctx = {
    path,
    PROJECT_ROOT,
    CORS_ORIGIN: '*',
    isValidDir,
    fs,
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
  };
  const params = new URLSearchParams();
  if (dir !== undefined) params.set('dir', dir);
  if (format !== undefined) params.set('format', format);
  const url = new URL(`http://localhost/api/export/batch?${params.toString()}`);
  await miscRoutes({ method: 'GET' }, res, url, '/api/export/batch', ctx);
  return captured;
}

describe('GET /api/export/batch guard branches (pins current behavior)', () => {
  it('returns 400 for a directory that fails isValidDir, with no fs read', async () => {
    // A path traversal, a sibling-of-content path, and the empty string all fail
    // the isValidDir guard and must short-circuit before any filesystem access.
    for (const badDir of ['../etc', 'var/data/secrets', '']) {
      const { fs, counter } = makeNoTouchFs();
      const out = await runBatch({ dir: badDir, format: 'html', fs });
      assert.deepEqual(
        out,
        { status: 400, body: { error: 'Invalid directory. Must start with content/' } },
        `dir=${JSON.stringify(badDir)}`,
      );
      assert.equal(counter.reads, 0, `no fs access for dir=${JSON.stringify(badDir)}`);
    }
  });

  it('returns 400 when the dir param is absent (isValidDir rejects null)', async () => {
    const { fs, counter } = makeNoTouchFs();
    const out = await runBatch({ format: 'html', fs });
    assert.deepEqual(out, { status: 400, body: { error: 'Invalid directory. Must start with content/' } });
    assert.equal(counter.reads, 0);
  });

  it('returns 400 for a format other than html, with no fs read', async () => {
    // dir is valid here; the unsupported format is what trips the guard. Both pdf
    // and md are rejected because only html is currently supported.
    for (const format of ['pdf', 'md']) {
      const { fs, counter } = makeNoTouchFs();
      const out = await runBatch({ dir: EXPORT_DIR, format, fs });
      assert.deepEqual(
        out,
        { status: 400, body: { error: 'Only html format is currently supported' } },
        `format=${format}`,
      );
      assert.equal(counter.reads, 0, `no fs access for format=${format}`);
    }
  });

  it('treats an absent format as html (the format guard is not tripped)', async () => {
    // format defaults to html when the param is missing, so the handler proceeds
    // past the format guard and reaches the fs checks; an empty directory then
    // yields the no-markdown 404 rather than a format error.
    const fullDir = path.join(PROJECT_ROOT, EXPORT_DIR);
    const fs = makeTreeFs({ dirs: { [fullDir]: [] } });
    const out = await runBatch({ dir: EXPORT_DIR, fs });
    assert.deepEqual(out, { status: 404, body: { error: 'No markdown files found in directory' } });
  });

  it('returns 404 when the directory does not exist', async () => {
    const fs = makeTreeFs({}); // nothing exists, so existsSync(fullDir) is false
    const out = await runBatch({ dir: EXPORT_DIR, format: 'html', fs });
    assert.deepEqual(out, { status: 404, body: { error: 'Directory not found' } });
  });

  it('returns 404 when the path exists but is not a directory', async () => {
    // Covers the second operand of the guard: existsSync is true but
    // statSync(...).isDirectory() is false.
    const fullDir = path.join(PROJECT_ROOT, EXPORT_DIR);
    const fs = makeTreeFs({ files: [fullDir] });
    const out = await runBatch({ dir: EXPORT_DIR, format: 'html', fs });
    assert.deepEqual(out, { status: 404, body: { error: 'Directory not found' } });
  });

  it('returns 404 when the directory exists but holds no markdown files', async () => {
    const fullDir = path.join(PROJECT_ROOT, EXPORT_DIR);
    const fs = makeTreeFs({ dirs: { [fullDir]: [] } });
    const out = await runBatch({ dir: EXPORT_DIR, format: 'html', fs });
    assert.deepEqual(out, { status: 404, body: { error: 'No markdown files found in directory' } });
  });

  it('returns 404 when only non-markdown files exist, including in subdirectories', async () => {
    // Exercises the recursive walk and the .md filter: a .txt file plus a nested
    // subdirectory holding a .rst file still resolve to zero markdown files.
    const fullDir = path.join(PROJECT_ROOT, EXPORT_DIR);
    const subDir = path.join(fullDir, 'sub');
    const fs = makeTreeFs({
      dirs: {
        [fullDir]: [dirent('notes.txt', 'file'), dirent('sub', 'dir')],
        [subDir]: [dirent('readme.rst', 'file')],
      },
    });
    const out = await runBatch({ dir: EXPORT_DIR, format: 'html', fs });
    assert.deepEqual(out, { status: 404, body: { error: 'No markdown files found in directory' } });
  });
});
