import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

// A small but realistic references.yaml: two entries, mirroring the shape the
// real bibliography uses (key -> { title, year, ... }).
const REFS_YAML =
  'smith2020:\n' +
  '  title: A Paper\n' +
  '  year: 2020\n' +
  'jones2019:\n' +
  '  title: Another Paper\n' +
  '  year: 2019\n';
const REFS_PARSED = {
  smith2020: { title: 'A Paper', year: 2020 },
  jones2019: { title: 'Another Paper', year: 2019 },
};

// A fake fs whose statSync/readFileSync are counted and whose mtimeMs, size, and
// file contents are mutable, so a test can simulate an unchanged file (cache hit),
// a touched file (mtime or size change -> re-read), or an unreadable file. Only
// the two methods loadReferencesCached needs are implemented, plus readdirSync
// (returning []) so content-walking handlers like /api/content-summary run without
// touching real disk.
function makeFs(yamlText = REFS_YAML, { mtimeMs = 1000, size = yamlText.length } = {}) {
  const state = { mtimeMs, size, text: yamlText, failStat: false, failRead: false };
  const counts = { stat: 0, read: 0 };
  const fsMock = {
    statSync() {
      counts.stat++;
      if (state.failStat) throw new Error('ENOENT: no such file');
      return { mtimeMs: state.mtimeMs, size: state.size };
    },
    readFileSync() {
      counts.read++;
      if (state.failRead) throw new Error('EACCES: permission denied');
      return state.text;
    },
    readdirSync() { return []; },
  };
  return { fsMock, counts, state };
}

// Invoke a content-analysis-a route handler with a mocked ctx, capturing both
// response styles the module uses: json(res, status, payload) and the raw
// writeHead/end pair (the export endpoint streams a downloadable file). Fully
// in-process: no network, no server.
async function invoke(pathname, ctx, search = '') {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  let head = null;
  let body = null;
  let jsonResp = null;
  const res = {
    writableEnded: false,
    writeHead(status, headers) { head = { status, headers }; return this; },
    end(payload) { body = payload; this.writableEnded = true; return this; },
  };
  const fullCtx = {
    json(_res, status, payload) { jsonResp = { status, payload }; res.writableEnded = true; return jsonResp; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { head, body, json: jsonResp };
}

// A memoizing cached(key, ttl, fn): /api/content-summary now wraps its scan in
// cached('content-summary', ...), so the ctx must supply the helper the live
// server provides. Each test issues at most one summary request, so a permanent
// per-key memo (TTL ignored) is sufficient; the freshness assertions below only
// drive export-json/random, which never touch the cache.
function makeCached() {
  const store = new Map();
  return function cached(key, _ttlMs, fn) {
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  };
}

const baseCtx = (fsMock) => ({ fs: fsMock, path, PROJECT_ROOT: '/fake/root', CORS_ORIGIN: '*', cached: makeCached() });

// The references memo is module-scope state that survives across requests (that is
// the whole point of the change), so each test starts from a cold cache.
beforeEach(() => { routes._clearReferencesCache(); });

describe('references.yaml memo: parses once for an unchanged file', () => {
  it('two successive export-json requests parse the YAML once and return matching data', async () => {
    const { fsMock, counts } = makeFs();
    const ctx = baseCtx(fsMock);

    const r1 = await invoke('/api/references/export-json', ctx);
    const r2 = await invoke('/api/references/export-json', ctx);

    assert.equal(r1.head.status, 200);
    assert.equal(r2.head.status, 200);
    assert.deepEqual(JSON.parse(r1.body), REFS_PARSED, 'first response is the parsed bibliography');
    assert.deepEqual(JSON.parse(r2.body), JSON.parse(r1.body), 'second response matches the first');
    assert.equal(counts.read, 1, 'YAML read+parsed exactly once across the two unchanged requests');
    assert.equal(counts.stat, 2, 'each request still stats the file to check freshness');
  });

  it('shares the memo across different references-consuming handlers', async () => {
    // export-json primes the cache; references/random then serves from it without a
    // second read, proving the memo is shared module state rather than per-handler.
    const { fsMock, counts } = makeFs();
    const ctx = baseCtx(fsMock);

    await invoke('/api/references/export-json', ctx);
    const rand = await invoke('/api/references/random', ctx);

    assert.equal(rand.json.status, 200);
    assert.ok(['smith2020', 'jones2019'].includes(rand.json.payload.key), 'random key is one of the entries');
    assert.equal(counts.read, 1, 'the second handler reused the cached parse');
  });

  it('serves the Object.keys(...).length count sites from the same cache', async () => {
    // /api/content-summary counts references via Object.keys(loadReferencesCached()).
    // readdirSync returns [] so the content walk is a no-op and only the bibliography
    // read is exercised.
    const { fsMock, counts } = makeFs();
    const ctx = baseCtx(fsMock);

    await invoke('/api/references/export-json', ctx); // prime
    const summary = await invoke('/api/content-summary', ctx);

    assert.equal(summary.json.status, 200);
    assert.equal(summary.json.payload.references, 2, 'count reflects the two cached entries');
    assert.equal(counts.read, 1, 'the count site reused the cached parse');
  });
});

describe('references.yaml memo: re-reads when the file changes on disk', () => {
  it('re-parses after mtimeMs changes (freshness preserved)', async () => {
    const { fsMock, counts, state } = makeFs();
    const ctx = baseCtx(fsMock);

    await invoke('/api/references/export-json', ctx);
    await invoke('/api/references/export-json', ctx);
    assert.equal(counts.read, 1, 'cached while unchanged');

    state.mtimeMs = 2000; // a writer touched the file
    const r = await invoke('/api/references/export-json', ctx);

    assert.equal(counts.read, 2, 're-read after the mtime changed');
    assert.equal(r.head.status, 200);
    assert.deepEqual(JSON.parse(r.body), REFS_PARSED);
  });

  it('re-parses when only the size changes (same mtime, same-millisecond rewrite)', async () => {
    const { fsMock, counts, state } = makeFs();
    const ctx = baseCtx(fsMock);

    await invoke('/api/references/export-json', ctx);
    assert.equal(counts.read, 1);

    state.size += 17; // size differs even though mtimeMs is unchanged
    await invoke('/api/references/export-json', ctx);

    assert.equal(counts.read, 2, 'size is part of the cache key, so the stale entry is dropped');
  });

  it('returns the new contents after the file is rewritten', async () => {
    const { fsMock, counts, state } = makeFs();
    const ctx = baseCtx(fsMock);

    const before = await invoke('/api/references/export-json', ctx);
    assert.deepEqual(JSON.parse(before.body), REFS_PARSED);

    state.text = 'lee2021:\n  title: Fresh Paper\n  year: 2021\n';
    state.mtimeMs = 3000;
    state.size = state.text.length;
    const after = await invoke('/api/references/export-json', ctx);

    assert.equal(counts.read, 2);
    assert.deepEqual(JSON.parse(after.body), { lee2021: { title: 'Fresh Paper', year: 2021 } });
  });
});

describe('references.yaml memo: error fallback', () => {
  it('falls back to {} when the file cannot be read, without poisoning the cache', async () => {
    // The loader swallows stat/read failures and returns {}, mirroring
    // server/data-store.js's loadJSON contract. export-json therefore streams an
    // empty object instead of throwing; the {} is never cached, so the next
    // successful stat re-reads the real data.
    const { fsMock, counts, state } = makeFs();
    const ctx = baseCtx(fsMock);

    state.failRead = true;
    const failed = await invoke('/api/references/export-json', ctx);
    assert.equal(failed.head.status, 200);
    assert.deepEqual(JSON.parse(failed.body), {}, 'unreadable bibliography exports as empty');
    assert.equal(counts.read, 1, 'the failed read was attempted');

    state.failRead = false;
    const ok = await invoke('/api/references/export-json', ctx);
    assert.deepEqual(JSON.parse(ok.body), REFS_PARSED, 'recovers once the file is readable again');
    assert.equal(counts.read, 2, 'the {} fallback was not cached');
  });
});
