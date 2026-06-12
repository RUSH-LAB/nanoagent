import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const referencesRoutes = require('../server/routes/references.js');
const { loadReferencesCached, _resetReferencesCache } = referencesRoutes;

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

// The cache is module scope; start every case from a clean slate.
beforeEach(() => {
  _resetReferencesCache();
});

describe('loadReferencesCached: memoized references.yaml loader', () => {
  it('is exported as a function alongside the route handler', () => {
    assert.equal(typeof referencesRoutes, 'function');
    assert.equal(typeof loadReferencesCached, 'function');
    assert.equal(typeof _resetReferencesCache, 'function');
  });

  it('parses once across two unchanged-stat calls and returns one shared instance', () => {
    const state = freshState({ text: 'a:\n  title: Alpha\n' });
    const fs = countingFs(state);

    const first = loadReferencesCached(fs, path, PROJECT_ROOT);
    const second = loadReferencesCached(fs, path, PROJECT_ROOT);

    assert.deepEqual(first, { a: { title: 'Alpha' } });
    assert.deepEqual(second, first, 'cache hit returns matching data');
    assert.equal(second, first, 'cache hit returns the same shared object, not a copy');
    assert.equal(state.readPaths.length, 1, 'YAML parsed exactly once');
    assert.deepEqual(state.readEncodings, ['utf8'], 'the file is read as utf8 text');
    assert.equal(state.statPaths.length, 2, 'stat checked on every call');
    assert.deepEqual(
      [...state.statPaths, ...state.readPaths],
      [REFS_PATH, REFS_PATH, REFS_PATH],
      'only references.yaml is ever touched',
    );
  });

  it('re-parses and reflects fresh data after mtimeMs changes', () => {
    const state = freshState({ text: 'a:\n  title: Old\n' });
    const fs = countingFs(state);

    const before = loadReferencesCached(fs, path, PROJECT_ROOT);
    assert.equal(before.a.title, 'Old');

    state.mtimeMs = 2000;
    state.text = 'a:\n  title: New\n';
    const after = loadReferencesCached(fs, path, PROJECT_ROOT);

    assert.equal(after.a.title, 'New', 'freshness preserved after an mtime bump');
    assert.equal(state.readPaths.length, 2, 're-read once the file changed');
  });

  it('re-parses when only the size changes within the same mtime', () => {
    const state = freshState({ text: 'a:\n  title: One\n' });
    const fs = countingFs(state);

    loadReferencesCached(fs, path, PROJECT_ROOT);
    state.size = 999; // same mtimeMs, different size (a same-millisecond rewrite)
    state.text = 'a:\n  title: Two\n';
    const after = loadReferencesCached(fs, path, PROJECT_ROOT);

    assert.equal(after.a.title, 'Two');
    assert.equal(state.readPaths.length, 2, 'a size delta alone invalidates the cache');
  });

  it('returns {} and does not cache a corrupt parse', () => {
    const state = freshState({ text: 'a: [unterminated\n  ::: :\n' });
    const fs = countingFs(state);

    assert.deepEqual(loadReferencesCached(fs, path, PROJECT_ROOT), {}, 'parse error falls back to {}');

    // The {} fallback must not be cached: a later valid read at the same stat re-parses.
    state.text = 'a:\n  title: Recovered\n';
    assert.deepEqual(loadReferencesCached(fs, path, PROJECT_ROOT), { a: { title: 'Recovered' } });
    assert.equal(state.readPaths.length, 2);
  });

  it('treats an empty file as {}', () => {
    const fs = countingFs(freshState({ text: '   \n' }));
    assert.deepEqual(loadReferencesCached(fs, path, PROJECT_ROOT), {});
  });

  it('returns {} when the file is missing (stat and read both throw)', () => {
    const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const missingFs = { statSync: enoent, readFileSync: enoent };
    assert.deepEqual(loadReferencesCached(missingFs, path, PROJECT_ROOT), {});
  });

  it('degrades to an uncached direct read when the fs exposes no statSync', () => {
    // The other references route tests build a ctx.fs with only readFileSync.
    // statSync then throws, so the loader skips the cache and reads on every call
    // rather than returning {}, preserving the original inline behavior.
    let reads = 0;
    let text = 'a:\n  title: First\n';
    const statlessFs = { readFileSync() { reads++; return text; } };

    assert.deepEqual(loadReferencesCached(statlessFs, path, PROJECT_ROOT), { a: { title: 'First' } });
    text = 'a:\n  title: Second\n';
    assert.deepEqual(loadReferencesCached(statlessFs, path, PROJECT_ROOT), { a: { title: 'Second' } });
    assert.equal(reads, 2, 'without statSync there is no cache key, so each call re-reads');
  });
});

describe('GET /api/references/by-venue serves through the shared cache', () => {
  function makeCtx(state) {
    return { path, PROJECT_ROOT, fs: countingFs(state) };
  }

  async function byVenue(ctx) {
    const url = new URL('http://localhost/api/references/by-venue');
    let captured = null;
    const fullCtx = {
      json(_res, status, body) { captured = { status, body }; return captured; },
      ...ctx,
    };
    await referencesRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/by-venue', fullCtx);
    return captured;
  }

  it('parses the YAML once for two successive GETs, then re-parses after a write', async () => {
    const state = freshState({
      size: 120,
      text: 'paperA:\n  title: First\n  venue: ICML\npaperB:\n  title: Second\n  venue: ICML\n',
    });
    const ctx = makeCtx(state);

    const r1 = await byVenue(ctx);
    const r2 = await byVenue(ctx);

    assert.equal(r1.status, 200);
    assert.equal(r1.body.totalVenues, 1);
    assert.equal(r1.body.venues[0].venue, 'ICML');
    assert.equal(r1.body.venues[0].count, 2);
    assert.deepEqual(r2.body, r1.body, 'the second GET returns matching data');
    assert.equal(state.readPaths.length, 1, 'YAML parsed exactly once for two GETs');
    assert.equal(state.statPaths.length, 2, 'each GET still stats for freshness');

    // Simulate a writer touching the file: both mtime and size change.
    state.mtimeMs = 5000;
    state.size = 200;
    state.text += 'paperC:\n  title: Third\n  venue: NeurIPS\n';
    const r3 = await byVenue(ctx);

    assert.equal(r3.status, 200);
    assert.equal(r3.body.totalVenues, 2, 're-parse reflects the new venue');
    assert.ok(r3.body.venues.some((v) => v.venue === 'NeurIPS'), 'fresh data after the change');
    assert.equal(state.readPaths.length, 2, 're-read exactly once after the change');
    assert.notDeepEqual(r3.body, r1.body);
  });
});

// The loader maps a stat, read, or parse failure to {} (mirroring loadJSON in
// server/data-store.js). This is a deliberate change from the original inline
// reads, which let a missing or corrupt file throw up to each handler's catch
// and return a 500. Pin that contract at the handler level: aggregation
// endpoints return 200 with empty data and key-lookup endpoints return 404.
describe('GET references handlers when references.yaml is missing or corrupt', () => {
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

  async function invoke(pathname, search, fs) {
    const url = new URL(`http://localhost${pathname}${search}`);
    let captured = null;
    const ctx = {
      path,
      PROJECT_ROOT,
      fs,
      json(_res, status, body) { captured = { status, body }; return captured; },
    };
    await referencesRoutes({ method: 'GET' }, { writableEnded: false }, url, pathname, ctx);
    return captured;
  }

  it('by-venue returns 200 with an empty grouping when the file is missing', async () => {
    const r = await invoke('/api/references/by-venue', '', { statSync: enoent, readFileSync: enoent });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { venues: [], totalVenues: 0 });
  });

  it('by-venue returns 200 with an empty grouping when the YAML is corrupt', async () => {
    const corruptFs = countingFs(freshState({ text: 'a: [unterminated\n  ::: :\n' }));
    const r = await invoke('/api/references/by-venue', '', corruptFs);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { venues: [], totalVenues: 0 });
  });

  it('format (a key-lookup endpoint) returns 404 when the file is missing', async () => {
    const r = await invoke('/api/references/format', '?key=anything', { statSync: enoent, readFileSync: enoent });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'Reference not found' });
  });
});
