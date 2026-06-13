import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the sibling route tests do
// (mirrors tests/next-citations-cache.test.mjs, same module). The module requires
// '../server-utils' and './references' at load time, so run from the repo root.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// ── Fixtures ──────────────────────────────────────────────────────────────
// Plain strings are files; nested objects are directories. Every tree carries a
// dotfile, an underscore prefixed entry, and a non ALLOWED_EXTS file so the three
// handlers' skip paths are exercised: those entries must never be read and must
// never contribute to a payload.

// link-density: alpha carries frontmatter (title override branch); gamma has the
// highest density and forces a fractional round; beta has zero links so it lands
// in leastLinked. The dotfile, underscore file, and .txt all carry wiki links
// that would change the ranking if the skips ever broke.
const LD_TREE = {
  content: {
    'alpha.md': '---\ntitle: Alpha Post\n---\nsee [link](url) here',
    sub: { 'gamma.md': '[[x]] [[y]] hi' },
    'beta.md': 'just plain words no links',
    'skip.txt': 'wrong ext [[a]] [[b]]',
    '.hidden.md': 'hidden [[a]]',
    '_draft.md': 'underscore [[a]]',
  },
};

// outline: names chosen so localeCompare interleaves a file, a directory (with a
// nested file at depth 1), then a file (apple < mango < zebra). apple uses a
// frontmatter title; zebra has six headings at levels 1 to 4 plus one level 5
// line that must NOT match, pinning both the level cap and the topHeadings slice.
const OL_TREE = {
  content: {
    'apple.md': '---\ntitle: Apple Doc\n---\n# Intro\nSome text\n## Details',
    mango: { 'inner.md': '# Inner Heading\ncontent' },
    'zebra.md': '# One\n## Two\n### Three\n#### Four\n# Five\n## Six\n##### NotCounted\nbody',
    '.hidden.md': '# Hidden',
    '_draft.md': '# Draft',
    'note.txt': '# Not Markdown',
  },
};

// topics: a.md and b.md both rank "elephant" as their top word, so they group
// under one primary topic; c.md's primary topic "penguin" is a singleton and is
// dropped by the pages.length >= 2 filter. a.md mixes in a length 7 stop word
// ("between") and a length 4 non stop word ("lion"); both must be filtered so
// "elephant" stays the primary topic, pinning the stop-word and length screens.
const TP_TREE = {
  content: {
    'a.md': 'between between between between lion lion lion lion elephant elephant elephant giraffe giraffe dolphin',
    'b.md': 'elephant elephant elephant dolphin dolphin giraffe',
    'c.md': 'penguin penguin walrus narwhal',
    'skip.txt': 'elephant elephant elephant',
    '.hidden.md': 'elephant elephant elephant',
    '_draft.md': 'elephant elephant elephant',
  },
};

// ── Expected payloads (verified against the live module) ────────────────────
// link-density density = round(totalLinks / words * 1000 * 10) / 10. gamma:
// round(2/3*10000)/10 = 666.7; alpha: round(1/8*10000)/10 = 125; beta: 0. avg =
// round((666.7+125+0)/3*10)/10 = 263.9. Pages sort by linksPerKWords descending.
const LD_EXPECTED = {
  avgLinksPerKWords: 263.9,
  mostLinked: [
    { path: 'content/sub/gamma.md', title: 'gamma', words: 3, totalLinks: 2, wikiLinks: 2, mdLinks: 0, citations: 0, linksPerKWords: 666.7 },
    { path: 'content/alpha.md', title: 'Alpha Post', words: 8, totalLinks: 1, wikiLinks: 0, mdLinks: 1, citations: 0, linksPerKWords: 125 },
    { path: 'content/beta.md', title: 'beta', words: 5, totalLinks: 0, wikiLinks: 0, mdLinks: 0, citations: 0, linksPerKWords: 0 },
  ],
  leastLinked: [
    { path: 'content/beta.md', title: 'beta', words: 5, totalLinks: 0, wikiLinks: 0, mdLinks: 0, citations: 0, linksPerKWords: 0 },
  ],
  total: 3,
};

const OL_EXPECTED = {
  outline: [
    { type: 'file', title: 'Apple Doc', path: 'content/apple.md', depth: 0, headingCount: 2, topHeadings: [{ level: 1, text: 'Intro' }, { level: 2, text: 'Details' }] },
    { type: 'directory', name: 'mango', depth: 0 },
    { type: 'file', title: 'inner', path: 'content/mango/inner.md', depth: 1, headingCount: 1, topHeadings: [{ level: 1, text: 'Inner Heading' }] },
    { type: 'file', title: 'zebra', path: 'content/zebra.md', depth: 0, headingCount: 6, topHeadings: [{ level: 1, text: 'One' }, { level: 2, text: 'Two' }, { level: 3, text: 'Three' }, { level: 4, text: 'Four' }, { level: 1, text: 'Five' }] },
  ],
  totalEntries: 4,
};

const TP_EXPECTED = {
  topics: [
    { topic: 'elephant', pageCount: 2, pages: [{ path: 'content/a.md', title: 'a' }, { path: 'content/b.md', title: 'b' }] },
  ],
  totalTopics: 1,
};

// ── Harness ─────────────────────────────────────────────────────────────────
// A tree entry equal to this sentinel is a file that exists in its directory
// listing but throws when read, modelling a single unreadable file mid-walk.
const UNREADABLE = { unreadable: true };

// Build an in-memory fs over a tree keyed by absolute path. readdirSync and
// readFileSync are counted so a test can prove the second request is served from
// cache with no repeat directory walk. readdirSync ignores its options argument,
// matching how the handlers pass {withFileTypes: true}.
function makeFs(tree, root) {
  const dirs = new Map();
  const files = new Map();
  const unreadable = new Set();
  (function walk(node, dirPath) {
    const entries = [];
    for (const [name, val] of Object.entries(node)) {
      const fp = path.join(dirPath, name);
      if (typeof val === 'string') { entries.push({ name, dir: false }); files.set(fp, val); }
      else if (val === UNREADABLE) { entries.push({ name, dir: false }); unreadable.add(fp); }
      else { entries.push({ name, dir: true }); walk(val, fp); }
    }
    dirs.set(dirPath, entries);
  })(tree, root);

  const counts = { readdir: 0, read: 0 };
  const fsMock = {
    readdirSync(dir) {
      counts.readdir++;
      const entries = dirs.get(dir);
      if (!entries) throw new Error(`ENOENT readdir ${dir}`);
      return entries.map(e => ({ name: e.name, isDirectory: () => e.dir }));
    },
    readFileSync(fp) {
      counts.read++;
      if (unreadable.has(fp)) throw new Error(`EACCES read ${fp}`);
      if (files.has(fp)) return files.get(fp);
      throw new Error(`ENOENT read ${fp}`);
    },
  };
  return { fsMock, counts };
}

// A memoizing cached(key, ttl, fn) mirroring server.js's TTL cache minus the
// expiry. It records every {key, ttl} call so a test can pin the cache key and
// TTL, and stores nothing when fn throws (a 500 caches nothing). Back-to-back
// calls hit the permanent memo, making the cache-short-circuit assertion
// independent of wall-clock time.
function makeCached() {
  const store = new Map();
  const calls = [];
  function cached(key, ttl, fn) {
    calls.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  }
  cached.calls = calls;
  cached.store = store;
  return cached;
}

// Invoke a content-analysis-a GET handler with a mocked ctx, capturing the
// json(res, status, payload) response. Fully in process: no network, no server,
// no real filesystem, no clock, no randomness.
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
  return jsonResp;
}

const baseCtx = (fsMock) => ({ fs: fsMock, path, PROJECT_ROOT, ALLOWED_EXTS, cached: makeCached() });

// An empty tree (no content directory) makes the top-level readdir throw, which
// is the only way to reach the 500 branch: a single unreadable file mid-walk is
// swallowed by each handler's per-file try/catch.
const NO_CONTENT_TREE = {};

describe('GET /api/stats/link-density: cached link-density scan', () => {
  it('returns 200 with density rounding, descending sort, and the zero-link leastLinked subset', async () => {
    const { fsMock } = makeFs(LD_TREE, PROJECT_ROOT);
    const r = await invoke('/api/stats/link-density', baseCtx(fsMock));

    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, LD_EXPECTED);
    // mostLinked is sorted by linksPerKWords descending.
    const ranks = r.payload.mostLinked.map(p => p.linksPerKWords);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
    // leastLinked is exactly the totalLinks === 0 subset.
    assert.deepEqual(r.payload.leastLinked, r.payload.mostLinked.filter(p => p.totalLinks === 0));
  });

  it('serves a deeply equal payload from cache on the second call, pinning key link-density and TTL 60000', async () => {
    const { fsMock, counts } = makeFs(LD_TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const first = await invoke('/api/stats/link-density', ctx);
    const readdirAfterFirst = counts.readdir;
    const readAfterFirst = counts.read;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');

    const second = await invoke('/api/stats/link-density', ctx);

    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload, LD_EXPECTED);
    assert.equal(counts.readdir, readdirAfterFirst, 'second request is served from cache: no repeat readdirSync');
    assert.equal(counts.read, readAfterFirst, 'second request reads no files: served from cache');
    assert.deepEqual(ctx.cached.calls, [{ key: 'link-density', ttl: 60000 }, { key: 'link-density', ttl: 60000 }]);
  });

  it('returns 500 "Link density analysis failed" when content is absent, caching nothing', async () => {
    const { fsMock } = makeFs(NO_CONTENT_TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const r = await invoke('/api/stats/link-density', ctx);

    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Link density analysis failed' });
    assert.equal(ctx.cached.store.size, 0, 'a failed scan caches nothing');
    assert.deepEqual(ctx.cached.calls, [{ key: 'link-density', ttl: 60000 }]);
  });

  it('swallows a single unreadable allowed-ext file mid-walk and still returns 200 for the rest', async () => {
    // bad.md is listed in the directory but throws on read; the per-file
    // try/catch drops it while the readable sibling still produces a page.
    const { fsMock, counts } = makeFs({
      content: { 'gamma.md': '[[x]] [[y]] hi', 'bad.md': UNREADABLE },
    }, PROJECT_ROOT);

    const r = await invoke('/api/stats/link-density', baseCtx(fsMock));

    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      avgLinksPerKWords: 666.7,
      mostLinked: [{ path: 'content/gamma.md', title: 'gamma', words: 3, totalLinks: 2, wikiLinks: 2, mdLinks: 0, citations: 0, linksPerKWords: 666.7 }],
      leastLinked: [],
      total: 1,
    });
    assert.ok(!r.payload.mostLinked.some(p => p.path.endsWith('bad.md')), 'the unreadable file contributes no page');
    assert.equal(counts.read, 2, 'the walk attempted both files: the throw on bad.md was swallowed, not skipped');
  });
});

describe('GET /api/content-outline: cached knowledge-base outline', () => {
  it('returns 200 with localeCompare ordering, levels 1 to 4 only, and topHeadings sliced to five', async () => {
    const { fsMock } = makeFs(OL_TREE, PROJECT_ROOT);
    const r = await invoke('/api/content-outline', baseCtx(fsMock));

    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, OL_EXPECTED);
    // Interleaving from the a.name.localeCompare sort: apple file, mango dir, its
    // depth-1 child, then zebra file.
    assert.deepEqual(r.payload.outline.map(e => e.type), ['file', 'directory', 'file', 'file']);
    // zebra has six matching headings but topHeadings keeps only the first five,
    // and the level 5 line never matched.
    const zebra = r.payload.outline.find(e => e.title === 'zebra');
    assert.equal(zebra.headingCount, 6);
    assert.equal(zebra.topHeadings.length, 5);
    assert.ok(zebra.topHeadings.every(h => h.level >= 1 && h.level <= 4));
  });

  it('serves a deeply equal payload from cache on the second call, pinning key kb-outline and TTL 60000', async () => {
    const { fsMock, counts } = makeFs(OL_TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const first = await invoke('/api/content-outline', ctx);
    const readdirAfterFirst = counts.readdir;
    const readAfterFirst = counts.read;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');

    const second = await invoke('/api/content-outline', ctx);

    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload, OL_EXPECTED);
    assert.equal(counts.readdir, readdirAfterFirst, 'second request is served from cache: no repeat readdirSync');
    assert.equal(counts.read, readAfterFirst, 'second request reads no files: served from cache');
    // The route is /api/content-outline but the cache key is kb-outline.
    assert.deepEqual(ctx.cached.calls, [{ key: 'kb-outline', ttl: 60000 }, { key: 'kb-outline', ttl: 60000 }]);
  });

  it('returns 500 "Outline failed" when content is absent, caching nothing', async () => {
    const { fsMock } = makeFs(NO_CONTENT_TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const r = await invoke('/api/content-outline', ctx);

    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Outline failed' });
    assert.equal(ctx.cached.store.size, 0, 'a failed scan caches nothing');
    assert.deepEqual(ctx.cached.calls, [{ key: 'kb-outline', ttl: 60000 }]);
  });
});

describe('GET /api/content-topics: cached topic grouping', () => {
  it('returns 200 grouping a shared primary topic and dropping singleton topics below the pages.length >= 2 threshold', async () => {
    const { fsMock } = makeFs(TP_TREE, PROJECT_ROOT);
    const r = await invoke('/api/content-topics', baseCtx(fsMock));

    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, TP_EXPECTED);
    // Only the elephant group (two pages) survives; penguin is a singleton.
    assert.deepEqual(r.payload.topics.map(t => t.topic), ['elephant']);
    assert.equal(r.payload.topics[0].pageCount, 2);
  });

  it('serves a deeply equal payload from cache on the second call, pinning key content-topics and TTL 120000', async () => {
    const { fsMock, counts } = makeFs(TP_TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const first = await invoke('/api/content-topics', ctx);
    const readdirAfterFirst = counts.readdir;
    const readAfterFirst = counts.read;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');

    const second = await invoke('/api/content-topics', ctx);

    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload, TP_EXPECTED);
    assert.equal(counts.readdir, readdirAfterFirst, 'second request is served from cache: no repeat readdirSync');
    assert.equal(counts.read, readAfterFirst, 'second request reads no files: served from cache');
    assert.deepEqual(ctx.cached.calls, [{ key: 'content-topics', ttl: 120000 }, { key: 'content-topics', ttl: 120000 }]);
  });

  it('returns 500 "Topic modeling failed" when content is absent, caching nothing', async () => {
    const { fsMock } = makeFs(NO_CONTENT_TREE, PROJECT_ROOT);
    const ctx = baseCtx(fsMock);

    const r = await invoke('/api/content-topics', ctx);

    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Topic modeling failed' });
    assert.equal(ctx.cached.store.size, 0, 'a failed scan caches nothing');
    assert.deepEqual(ctx.cached.calls, [{ key: 'content-topics', ttl: 120000 }]);
  });
});
