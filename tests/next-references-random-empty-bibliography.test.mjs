import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the REAL module the way the sibling route
// tests do (mirrors tests/next-content-a-cache-refs.test.mjs, which already covers
// GET /api/references/random on the non-empty path). This suite pins the
// complementary empty-bibliography short-circuit: when the loaded bibliography has
// no entries, the handler returns HTTP 200 {reference: null} at the
// `if (keys.length === 0)` guard, before it ever draws a random index.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

// A minimal fake fs that satisfies the shared bibliography loader: statSync reports
// a stable mtime/size (so the loader may memoize) and readFileSync returns the
// bibliography text. An empty file ('') and an empty YAML mapping ('{}') both parse
// to an object with zero keys, which is the "no entries" state the guard short
// circuits on. Reads are counted so a test can prove the mocked file was actually
// consulted (an empty parsed file), not merely the loader's missing-file fallback.
function makeEmptyFs(yamlText) {
  const counts = { stat: 0, read: 0 };
  const fsMock = {
    statSync() { counts.stat++; return { mtimeMs: 1000, size: yamlText.length }; },
    readFileSync() { counts.read++; return yamlText; },
  };
  return { fsMock, counts };
}

// Invoke a content-analysis-a route handler with a mocked ctx, fully in process: no
// network, no real disk. The random handler responds via json(res, status, payload),
// captured here as { status, payload }.
async function invoke(pathname, ctx) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  let jsonResp = null;
  const res = {
    writableEnded: false,
    writeHead() { return this; },
    end() { this.writableEnded = true; return this; },
  };
  const fullCtx = {
    json(_res, status, payload) { jsonResp = { status, payload }; res.writableEnded = true; return jsonResp; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { json: jsonResp };
}

// The random handler reads only fs, path, and PROJECT_ROOT from ctx; json is
// supplied by invoke above.
const baseCtx = (fsMock) => ({ fs: fsMock, path, PROJECT_ROOT: '/fake/root' });

// The parsed bibliography is module-scope state shared across requests and suites,
// so reset it before each case via the exported references-route hook; otherwise a
// non-empty cache primed elsewhere would mask the empty result.
beforeEach(() => { routes._clearReferencesCache(); });

describe('GET /api/references/random: empty-bibliography short-circuit', () => {
  it('returns 200 {reference: null} when the bibliography file is empty', async () => {
    const { fsMock, counts } = makeEmptyFs(''); // a 0-byte references.yaml parses to {}
    const r = await invoke('/api/references/random', baseCtx(fsMock));

    assert.equal(r.json.status, 200);
    // Strict deep-equal: the payload is exactly {reference: null}. The non-empty
    // branch instead returns {key, ...entry}, so this exact shape (no `key` field)
    // confirms the short-circuit fired rather than a random draw.
    assert.deepEqual(r.json.payload, { reference: null });
    assert.equal(counts.read, 1, 'the mocked, empty bibliography file was actually read and parsed');
  });

  it('treats an empty YAML mapping ({}) the same as an empty file', async () => {
    const { fsMock } = makeEmptyFs('{}'); // a genuine empty mapping, not the || {} fallback
    const r = await invoke('/api/references/random', baseCtx(fsMock));

    assert.equal(r.json.status, 200);
    assert.deepEqual(r.json.payload, { reference: null });
  });

  it('yields null on every independent run (cold cache each iteration; no random index drawn)', async () => {
    // Each iteration starts from a cold memo with a fresh empty file, so every run
    // genuinely re-reads and re-parses the bibliography and re-hits the guard rather
    // than serving a cached {} after the first read. The result is null every time.
    for (let i = 0; i < 5; i++) {
      routes._clearReferencesCache();
      const { fsMock, counts } = makeEmptyFs('');
      const r = await invoke('/api/references/random', baseCtx(fsMock));
      assert.equal(r.json.status, 200);
      assert.deepEqual(r.json.payload, { reference: null }, `run ${i + 1} is the empty short-circuit`);
      assert.equal(counts.read, 1, `run ${i + 1} re-read the empty file on a cold cache`);
    }
  });

  it('short-circuits before the random index call (the guard returns even if the PRNG would throw)', async () => {
    const { fsMock } = makeEmptyFs('');
    const ctx = baseCtx(fsMock);

    // Force the PRNG to throw. If the handler ever reached the random-index line it
    // would throw, and the handler's own try/catch would surface a 500
    // {error: 'Random failed'}. A 200 {reference: null} therefore proves the
    // keys.length === 0 guard returned before any randomness was drawn.
    const realRandom = Math.random;
    Math.random = () => { throw new Error('random index must not be drawn on the empty path'); };
    try {
      const r = await invoke('/api/references/random', ctx);
      assert.equal(r.json.status, 200);
      assert.deepEqual(r.json.payload, { reference: null });
    } finally {
      Math.random = realRandom;
    }
  });
});
