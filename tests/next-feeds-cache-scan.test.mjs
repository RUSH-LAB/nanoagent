import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// feeds.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// A real TTL memo standing in for ctx.cached. It runs the thunk only on a miss
// and records how many times each key's thunk actually executes, so a test can
// assert the shared 'feed-items' scan runs exactly once across two requests.
function makeCountingCache() {
  const store = {};
  const runs = {};
  function cached(key, ttlMs, fn) {
    const entry = store[key];
    if (entry && Date.now() - entry.time < ttlMs) return entry.data;
    runs[key] = (runs[key] || 0) + 1;
    const data = fn();
    store[key] = { data, time: Date.now() };
    return data;
  }
  cached.runs = runs;
  return cached;
}

// Drive a feeds GET handler with a mocked ctx and capture the XML body it
// streams through res.writeHead / res.end. The json fallback records the error
// path so a thrown handler surfaces as a failed assertion rather than silence.
async function invokeFeed(pathname, ctx) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  let status = null, headers = null, body = null, errored = null;
  const res = {
    writableEnded: false,
    writeHead(s, h) { status = s; headers = h; },
    end(b) { this.writableEnded = true; body = b; return this; },
  };
  const fullCtx = {
    json(_res, s, payload) { errored = { status: s, payload }; res.writableEnded = true; },
    ...ctx,
  };
  await feedsRoutes(req, res, url, pathname, fullCtx);
  return { status, headers, body, errored };
}

// Pull the per-item <title> values out of a feed body in document order. Both
// the RSS channel and the Atom feed carry one leading <title>Mochi Lab</title>
// ahead of the items, so the first match is dropped to leave only item titles.
function feedTitles(xml) {
  const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(m => m[1]);
  return titles.slice(1);
}

describe('RSS and Atom feeds share one cached content scan', () => {
  let tmpRoot;
  // 22 posts so the top-20 slice drops the two oldest and the surviving order
  // exercises mtime-descending sorting. Index N is stamped at BASE + N minutes,
  // so a higher index means a newer file and an earlier slot in the feed.
  const BASE = 1700000000; // fixed epoch seconds, so mtimes are wall-clock independent
  const COUNT = 22;
  const idx = n => String(n).padStart(2, '0');
  // post-19 and post-07 live in a subdirectory to prove the walk still recurses
  // and merges nested files into the same mtime-ordered list.
  const NESTED = new Set([19, 7]);
  const ctxBase = () => ({
    fs,
    path,
    PROJECT_ROOT: tmpRoot,
    ALLOWED_EXTS: ['.md', '.mdx'],
    CORS_ORIGIN: '*',
  });

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feeds-cache-scan-'));
    const contentDir = path.join(tmpRoot, 'content');
    fs.mkdirSync(path.join(contentDir, 'sub'), { recursive: true });
    for (let n = 0; n < COUNT; n++) {
      const dir = NESTED.has(n) ? path.join(contentDir, 'sub') : contentDir;
      const fp = path.join(dir, `post-${idx(n)}.md`);
      fs.writeFileSync(fp, `---\ntitle: "Post ${idx(n)}"\n---\n\nBody ${idx(n)}\n`, 'utf-8');
      const t = BASE + n * 60;
      fs.utimesSync(fp, t, t);
    }
    // Decoys the walk must skip: a dot file, an underscore file, and a
    // non-markdown file, each stamped newest so a broken filter would surface
    // them at the very top of the feed.
    const newest = BASE + COUNT * 60 + 600;
    for (const name of ['.hidden.md', '_draft.md', 'ignore.txt']) {
      const fp = path.join(contentDir, name);
      fs.writeFileSync(fp, `---\ntitle: "DECOY ${name}"\n---\n\nnope\n`, 'utf-8');
      fs.utimesSync(fp, newest, newest);
    }
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Expected top-20 titles, newest first: indices 21 down to 2.
  const expectedTop20 = Array.from({ length: 20 }, (_, i) => `Post ${idx(COUNT - 1 - i)}`);

  it('walks the content tree exactly once across an RSS request then an Atom request', async () => {
    const cached = makeCountingCache();
    const ctx = { ...ctxBase(), cached };

    const rss = await invokeFeed('/api/feed/rss', ctx);
    const atom = await invokeFeed('/api/feed/atom', ctx);

    assert.equal(rss.errored, null, 'RSS handler stayed off the error path');
    assert.equal(atom.errored, null, 'Atom handler stayed off the error path');
    assert.equal(rss.status, 200);
    assert.equal(atom.status, 200);
    assert.ok(rss.body && rss.body.includes('<rss'), 'RSS body produced');
    assert.ok(atom.body && atom.body.includes('<feed'), 'Atom body produced');

    assert.equal(cached.runs['feed-items'], 1, 'the shared scan thunk ran exactly once for both feeds');
    assert.deepEqual(Object.keys(cached.runs), ['feed-items'], 'only the feed-items scan ran');
  });

  it('orders RSS <item> elements by mtime descending, sliced to the top 20', async () => {
    const ctx = { ...ctxBase(), cached: makeCountingCache() };
    const rss = await invokeFeed('/api/feed/rss', ctx);
    assert.equal(rss.status, 200);
    assert.equal((rss.body.match(/<item>/g) || []).length, 20, 'exactly 20 items emitted');
    const titles = feedTitles(rss.body);
    assert.deepEqual(titles, expectedTop20, 'mtime descending top 20; two oldest dropped');
    assert.ok(!titles.some(t => t.startsWith('DECOY')), 'dot, underscore, and non-md files skipped');
  });

  it('orders Atom <entry> elements by mtime descending, sliced to the top 20', async () => {
    const ctx = { ...ctxBase(), cached: makeCountingCache() };
    const atom = await invokeFeed('/api/feed/atom', ctx);
    assert.equal(atom.status, 200);
    assert.equal((atom.body.match(/<entry>/g) || []).length, 20, 'exactly 20 entries emitted');
    const titles = feedTitles(atom.body);
    assert.deepEqual(titles, expectedTop20, 'mtime descending top 20; two oldest dropped');
    assert.ok(!titles.some(t => t.startsWith('DECOY')), 'dot, underscore, and non-md files skipped');
  });

  it('serves the same item ordering to both feeds from the single cached scan', async () => {
    const cached = makeCountingCache();
    const ctx = { ...ctxBase(), cached };
    const rss = await invokeFeed('/api/feed/rss', ctx);
    const atom = await invokeFeed('/api/feed/atom', ctx);
    assert.deepEqual(feedTitles(rss.body), feedTitles(atom.body), 'both feeds reflect the one scan');
    assert.equal(cached.runs['feed-items'], 1, 'still a single shared walk');
  });

  it('renders every field of the newest RSS <item> and Atom <entry> unchanged', async () => {
    const rss = await invokeFeed('/api/feed/rss', { ...ctxBase(), cached: makeCountingCache() });
    const atom = await invokeFeed('/api/feed/atom', { ...ctxBase(), cached: makeCountingCache() });
    // post-21 is the newest file and sits in the content root, so its link path
    // is /post-21; with no date frontmatter its date falls back to the mtime.
    const isoDate = new Date((BASE + (COUNT - 1) * 60) * 1000).toISOString();
    // RSS keeps the leading slash on <link> and renders <pubDate> as the RFC 1123 date.
    assert.ok(rss.body.includes('<link>/post-21</link>'), 'RSS link keeps its leading slash');
    assert.ok(rss.body.includes(`<pubDate>${new Date(isoDate).toUTCString()}</pubDate>`), 'RSS pubDate unchanged');
    // Atom renders the href link, the ISO <updated>, and the urn id over the content path.
    assert.ok(atom.body.includes('<link href="/post-21"/>'), 'Atom link href unchanged');
    assert.ok(atom.body.includes(`<updated>${isoDate}</updated>`), 'Atom updated is the ISO date');
    assert.ok(atom.body.includes('<id>urn:mochi-lab:content/post-21.md</id>'), 'Atom id over the content-relative path');
  });
});

describe('RSS and Atom feeds escape special characters in titles', () => {
  let tmpRoot;
  const ctxBase = () => ({ fs, path, PROJECT_ROOT: tmpRoot, ALLOWED_EXTS: ['.md', '.mdx'], CORS_ORIGIN: '*' });

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feeds-cache-esc-'));
    const contentDir = path.join(tmpRoot, 'content');
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'amp.md'), '---\ntitle: "A & B <tag>"\n---\n\nbody\n', 'utf-8');
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('escapes &, <, and > in both the RSS and the Atom <title>', async () => {
    const rss = await invokeFeed('/api/feed/rss', { ...ctxBase(), cached: makeCountingCache() });
    const atom = await invokeFeed('/api/feed/atom', { ...ctxBase(), cached: makeCountingCache() });
    assert.ok(rss.body.includes('<title>A &amp; B &lt;tag&gt;</title>'), 'RSS escapes the item title');
    assert.ok(atom.body.includes('<title>A &amp; B &lt;tag&gt;</title>'), 'Atom escapes the entry title');
    assert.ok(!rss.body.includes('A & B <tag>'), 'no raw unescaped title leaks through');
  });
});
