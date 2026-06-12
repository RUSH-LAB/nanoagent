import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the sibling per-key cache suites do
// (next-recommendv2-cache, next-trajectory-cache) and reuse their ctx-mocking
// shape. GET /api/file/slides now wraps its single-file read in
// cached('slides:' + filePath, 30000, fn); these tests drive that wrap directly
// with a counting fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/feeds.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub keyed by absolute path, counting how often the handler
// touches disk. The slides handler reads exactly one file with readFileSync
// (path.join(PROJECT_ROOT, filePath)); the counter lets a test prove a cache hit
// performs no fresh read while a distinct path reads again. A missing file throws
// ENOENT so the 404 path can be exercised.
function makeCountingFs(fileMap) {
  const fileContents = new Map();
  for (const [rel, content] of Object.entries(fileMap)) {
    fileContents.set(path.join(PROJECT_ROOT, rel), content);
  }
  const counts = { readFileSync: 0 };
  const fs = {
    readFileSync(fp) {
      counts.readFileSync++;
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return { fs, counts };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js
// helper: run fn and store on a miss, return the stored value untouched on a hit;
// fn() throwing stores nothing, so an error response stays uncached. Every call is
// recorded in `calls` so a test can pin the exact key and TTL the handler passes.
function makeCached() {
  const store = new Map();
  const calls = [];
  const cached = (key, ttl, fn) => {
    calls.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return { cached, store, calls };
}

// Invoke the file-slides handler with a mocked ctx and capture the response handed
// to `json(res, status, payload)`.
async function invoke({ search = '', ctx = {} }) {
  const pathname = '/api/file/slides';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

// deck.md uses the literal `\n---\n` slide separator: the frontmatter regex is
// lazy, so it consumes only the leading fence and the body splits into two slides.
// talk.md uses `## ` headings: the split's `(?=\n## )` lookahead keeps each
// heading with its body, so the opening line plus two sections give three slides.
// The two fixtures exercise both split branches and key two distinct cache entries.
const FIXTURE = {
  'content/deck.md': '---\ntitle: My Deck\n---\nSlide one body\n---\nSlide two body\n',
  'content/talk.md': '---\ntitle: Talk\n---\nOpening line\n\n## First\n\nbody one\n\n## Second\n\nbody two\n',
};

// The proven pre-cache output for path=content/deck.md. Field order matches the
// handler's returned literal ({title, slides, totalSlides}) and each slide
// ({index, content}), so a JSON.stringify comparison pins serialization, not just
// structural equality.
const EXPECTED_DECK = {
  title: 'My Deck',
  slides: [
    { index: 0, content: 'Slide one body' },
    { index: 1, content: 'Slide two body' },
  ],
  totalSlides: 2,
};

// path=content/talk.md splits on the `## ` headings, so the payload differs from
// EXPECTED_DECK in title, slide count, and bodies. A distinct payload proves the
// second path is keyed and computed independently.
const EXPECTED_TALK = {
  title: 'Talk',
  slides: [
    { index: 0, content: 'Opening line' },
    { index: 1, content: '## First\n\nbody one' },
    { index: 2, content: '## Second\n\nbody two' },
  ],
  totalSlides: 3,
};

describe('GET /api/file/slides (read cached via cached("slides:" + filePath))', () => {
  it('returns the expected payload, byte-identical, on the first call and reads the file', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    const res = await invoke({ search: '?path=content/deck.md', ctx });
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_DECK);
    // Byte-identity: same fields, same order, same serialization as before caching.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_DECK));
    assert.equal(counts.readFileSync, 1, 'the first call reads the file once');
  });

  it('serves a repeat request for the same path from cache with no second readFileSync', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    const first = await invoke({ search: '?path=content/deck.md', ctx });
    assert.equal(first.status, 200);
    assert.equal(counts.readFileSync, 1, 'the first call hits the filesystem');

    const second = await invoke({ search: '?path=content/deck.md', ctx });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    assert.equal(counts.readFileSync, 1, 'cached repeat must not readFileSync again');
    assert.equal(store.size, 1, 'one cache entry for the single path');
    assert.ok(store.has('slides:content/deck.md'), 'cache key is "slides:" + filePath');
  });

  it('keys each distinct path separately and reads again for a new path', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    const deck = await invoke({ search: '?path=content/deck.md', ctx });
    assert.equal(deck.status, 200);
    assert.equal(counts.readFileSync, 1);

    const talk = await invoke({ search: '?path=content/talk.md', ctx });
    assert.equal(talk.status, 200);
    assert.deepEqual(talk.payload, EXPECTED_TALK);
    assert.notDeepEqual(talk.payload, deck.payload);
    assert.equal(counts.readFileSync, 2, 'a new path misses the cache and reads again');
    assert.equal(store.size, 2, 'each path gets its own cache entry');
    assert.ok(store.has('slides:content/deck.md') && store.has('slides:content/talk.md'));
  });

  it('pins the cache key prefix and the 30000 ms TTL the handler passes', async () => {
    const { fs } = makeCountingFs(FIXTURE);
    const { cached, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    await invoke({ search: '?path=content/deck.md', ctx });
    assert.ok(calls.length >= 1, 'the handler routes through cached()');
    assert.equal(calls[0].key, 'slides:content/deck.md');
    assert.equal(calls[0].ttl, 30000);
  });

  it('returns 400 for an invalid path before the cache and never reads', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => false, cached };

    const res = await invoke({ search: '?path=../secret', ctx });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid path' });
    assert.equal(calls.length, 0, 'the invalid-path guard returns before cached() is reached');
    assert.equal(store.size, 0, 'the 400 path is never cached');
    assert.equal(counts.readFileSync, 0, 'no read on an invalid path');
  });

  it('does not cache a 404 for a missing file (the error path stays outside the cache)', async () => {
    const { fs, counts } = makeCountingFs(FIXTURE);
    const { cached, store, calls } = makeCached();
    const ctx = { fs, path, PROJECT_ROOT, isValidFilePath: () => true, cached };

    const res = await invoke({ search: '?path=content/missing.md', ctx });
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'File not found' });
    // The try/catch sits OUTSIDE the cached closure, and fs.readFileSync on the
    // absent file throws inside fn(); the real server.js cached() runs fn() before
    // it stores, so the throw leaves nothing cached. This pins the
    // error-stays-uncached invariant.
    assert.ok(calls.length >= 1, 'the handler reaches cached() since the path passed isValidFilePath');
    assert.equal(store.size, 0, 'the 404 is never cached');
    assert.equal(counts.readFileSync, 1, 'the single read is attempted and throws');
  });
});
