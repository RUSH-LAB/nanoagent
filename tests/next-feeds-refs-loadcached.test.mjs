import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Both route modules are CommonJS; load them the way the other route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');
const { loadReferencesCached, _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// A counting fs stub. `state` carries the current stat (mtimeMs/size) and file
// text, all mutable between calls so a test can simulate an on-disk change, plus
// the paths passed to statSync/readFileSync so an unexpected access surfaces.
function countingFs(state) {
  return {
    statSync(fp) {
      state.statPaths.push(fp);
      return { mtimeMs: state.mtimeMs, size: state.size };
    },
    readFileSync(fp, encoding) {
      state.readPaths.push(fp);
      state.readEncodings.push(encoding);
      return state.text;
    },
  };
}

function freshState(over = {}) {
  return { mtimeMs: 1000, size: 100, text: '', statPaths: [], readPaths: [], readEncodings: [], ...over };
}

// Drive GET /api/references through the feeds route with a mocked ctx and
// capture the json() response. Only fs/path/PROJECT_ROOT/json are exercised by
// this handler; the rest of the large ctx destructure resolves to undefined.
async function getReferences(fs) {
  const url = new URL('http://localhost/api/references');
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    json(_res, status, body) { captured = { status, body }; return captured; },
  };
  await feedsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references', ctx);
  return captured;
}

// The shared memo lives at references.js module scope; start every case clean.
beforeEach(() => {
  _resetReferencesCache();
});

describe('GET /api/references serves through the shared references.yaml memo', () => {
  it('parses references.yaml once across two GETs and hands back one shared object', async () => {
    const state = freshState({
      size: 120,
      text: 'paperA:\n  title: First\n  author: Ada\npaperB:\n  title: Second\n',
    });
    const fs = countingFs(state);

    const r1 = await getReferences(fs);
    const r2 = await getReferences(fs);

    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body, {
      references: { paperA: { title: 'First', author: 'Ada' }, paperB: { title: 'Second' } },
    });
    assert.deepEqual(r2.body, r1.body, 'the second GET returns matching data');
    assert.equal(r2.body.references, r1.body.references, 'cache hit hands back the same shared object, not a copy');
    assert.equal(state.readPaths.length, 1, 'references.yaml parsed exactly once for two GETs');
    assert.deepEqual(state.readEncodings, ['utf8'], 'the file is read as utf8 text');
    assert.equal(state.statPaths.length, 2, 'each GET still stats for freshness');
    assert.deepEqual(
      [...state.statPaths, ...state.readPaths],
      [REFS_PATH, REFS_PATH, REFS_PATH],
      'only references.yaml is ever touched',
    );
  });

  it('reuses the very same memo as references.js: a prior load primes the feeds GET', async () => {
    const state = freshState({ text: 'paperA:\n  title: Shared\n' });
    const fs = countingFs(state);

    // Prime references.js's module-level memo with one direct parse.
    const primed = loadReferencesCached(fs, path, PROJECT_ROOT);
    assert.equal(state.readPaths.length, 1, 'primed by exactly one direct parse');

    // The feeds GET must hit that same memo rather than re-reading the file.
    const r = await getReferences(fs);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { references: { paperA: { title: 'Shared' } } });
    assert.equal(r.body.references, primed, 'feeds serves the object references.js already parsed');
    assert.equal(state.readPaths.length, 1, 'the feeds GET reused the shared memo without re-reading');
  });

  it('reflects fresh data after the file changes on disk (no staleness)', async () => {
    const state = freshState({ text: 'paperA:\n  title: Old\n' });
    const fs = countingFs(state);

    const before = await getReferences(fs);
    assert.equal(before.body.references.paperA.title, 'Old');

    // Simulate a writer touching the file: both mtime and size change.
    state.mtimeMs = 2000;
    state.size = 200;
    state.text = 'paperA:\n  title: New\n';
    const after = await getReferences(fs);

    assert.equal(after.body.references.paperA.title, 'New', 'fresh data served after the change');
    assert.equal(state.readPaths.length, 2, 're-read exactly once after the file changed');
  });
});

// The handler kept its original contract: any stat, read, or parse failure, and
// an empty file, must still serve 200 with {references: {}}. The shared loader
// maps each of these to {}, so the outer catch never has to fire.
describe('GET /api/references preserves the empty/corrupt/missing fallback', () => {
  it('treats an empty file as {references: {}}', async () => {
    const r = await getReferences(countingFs(freshState({ text: '   \n' })));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { references: {} });
  });

  it('returns {references: {}} when the YAML is corrupt', async () => {
    const r = await getReferences(countingFs(freshState({ text: 'a: [unterminated\n  ::: :\n' })));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { references: {} });
  });

  it('returns {references: {}} when references.yaml is missing', async () => {
    const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const r = await getReferences({ statSync: enoent, readFileSync: enoent });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { references: {} });
  });
});
