/**
 * server/routes/feeds.js: the RSS and Atom feeds, the content table of
 * contents, writing sessions, publish scheduling, URL import, slide
 * conversion, the activity heatmap and the daily summary.
 *
 * Consolidated from the twenty-six per-branch suites that used to cover this
 * module.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, PROJECT_ROOT, CONTENT_DIR, TEST_IDENTITY, key} from '../../_harness.mjs';

const routes = loadRoute('feeds');
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'sessions.json');
/** A ctx whose schedule holds these items, one row each, keyed by id. */
const withSchedule = (items = []) => {
  const ctx = makeCtx();
  const scope = ctx.scopeFor({auth: TEST_IDENTITY});
  for (const it of items) ctx.scoped.collection('schedule').put(scope, it.id, it);
  return ctx;
};

/** The workspace's schedule, as the store holds it. */
const storedSchedule = ctx =>
  ctx.scoped.collection('schedule').values(ctx.scopeFor({auth: TEST_IDENTITY}));
// Content fixtures live in the workspace's own tree, and the paths the scan
// reports are relative to it: `books/math/x.md`, never `content/mochi/...`.
const at = rel => path.join(CONTENT_DIR, rel);

const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
const INHERITED_KEYS = ['toString', 'valueOf', 'hasOwnProperty'];

/** Front matter block with the given fields. */
const fm = (fields, body = 'Body text.') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}\n`;

// ── Exported helpers ──────────────────────────────────────────────────────

describe('numericParam (re-exported)', () => {
  const {numericParam} = routes;
  const CASES = [
    {name: 'null falls back to the default', args: [null, 20, 100], want: 20},
    {name: 'an empty string falls back to the default', args: ['', 20, 100], want: 20},
    {name: 'a non-numeric value falls back rather than yielding NaN', args: ['abc', 20, 100], want: 20},
    {name: 'a valid value passes through', args: ['42', 20, 100], want: 42},
    {name: 'a value above the cap is clamped', args: ['9999', 20, 100], want: 100},
    {name: 'a leading-numeric value keeps parseInt semantics', args: ['12abc', 20, 100], want: 12},
  ];
  for (const {name, args, want} of CASES) {
    it(name, () => assert.equal(numericParam(...args), want));
  }
});

describe('escapeFeedXml (hoisted feed XML escaper)', () => {
  const {escapeFeedXml} = routes;

  it('is one stable exported function', () => {
    assert.equal(typeof escapeFeedXml, 'function');
    assert.strictEqual(loadRoute('feeds').escapeFeedXml, escapeFeedXml);
  });

  const CASES = [
    ['a & b', 'a &amp; b'],
    ['<tag>', '&lt;tag&gt;'],
    ['plain text', 'plain text'],
    ['AT&T <Corp>', 'AT&amp;T &lt;Corp&gt;'],
    // Every occurrence, not just the first.
    ['a&b&c', 'a&amp;b&amp;c'],
    // The ampersand is escaped first; running it last would turn the `&` of
    // `&lt;` into `&amp;lt;`.
    ['&<', '&amp;&lt;'],
  ];
  for (const [input, want] of CASES) {
    it(`escapes ${JSON.stringify(input)}`, () => assert.equal(escapeFeedXml(input), want));
  }
});

// ── References passthrough ────────────────────────────────────────────────

// ── Sessions ──────────────────────────────────────────────────────────────

// ── Content table of contents ─────────────────────────────────────────────

// ── Feeds ─────────────────────────────────────────────────────────────────

describe('GET /api/feed/rss and /api/feed/atom', () => {
  // mockFs stamps each file with an increasing mtime, so declaration order here
  // is oldest to newest and the feeds must reverse it.
  const CONTENT = {
    [at('old.md')]: fm({title: 'Oldest', date: '2020-01-01'}),
    [at('mid.md')]: fm({title: 'AT&T <Corp>'}),
    [at('new.md')]: fm({title: 'Newest'}),
  };

  function feedCtx() {
    let walks = 0;
    const base = mockFs(CONTENT);
    const fs = {...base, readdirSync: (p, o) => { walks++; return base.readdirSync(p, o); }};
    const ctx = makeCtx({fs});
    return {ctx, walks: () => walks};
  }

  it('walks the content tree once across an RSS request then an Atom request', async () => {
    const {ctx, walks} = feedCtx();
    await invoke(routes, {path: '/api/feed/rss', ctx});
    const after = walks();
    await invoke(routes, {path: '/api/feed/atom', ctx});
    assert.equal(walks(), after, 'both feeds share the one cached("feed-items") scan');
  });

  it('passes the feed-items cache key with a 60000 ms TTL', async () => {
    let seen;
    const ctx = makeCtx({fs: mockFs(CONTENT), cached: (key, ttl, fn) => { seen = [key, ttl]; return fn(); }});
    await invoke(routes, {path: '/api/feed/rss', ctx});
    assert.deepEqual(seen, [key('feed-items'), 60000]);
  });

  const FEEDS = [
    {name: 'RSS', path: '/api/feed/rss', contentType: 'application/rss+xml; charset=utf-8', tag: 'title'},
    {name: 'Atom', path: '/api/feed/atom', contentType: 'application/atom+xml; charset=utf-8', tag: 'title'},
  ];
  for (const {name, path: p, contentType} of FEEDS) {
    it(`${name} streams its XML with the expected headers`, async () => {
      const {ctx} = feedCtx();
      const r = await invoke(routes, {path: p, ctx});
      assert.equal(r.written.status, 200);
      assert.equal(r.written.headers['Content-Type'], contentType);
      assert.equal(r.written.headers['Cache-Control'], 'public, max-age=300');
      assert.equal(r.written.headers['Access-Control-Allow-Origin'], '*');
      assert.equal(r.res.writableEnded, true);
    });

    it(`${name} orders entries by mtime descending`, async () => {
      const {ctx} = feedCtx();
      const r = await invoke(routes, {path: p, ctx});
      const titles = [...r.written.body.matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]);
      // The first <title> is the channel/feed title, then the items.
      assert.deepEqual(titles, ['Mochi Lab', 'Newest', 'AT&amp;T &lt;Corp&gt;', 'Oldest']);
    });

    it(`${name} slices to the twenty most recent items`, async () => {
      const many = Object.fromEntries(Array.from({length: 25}, (_, i) => [at(`f${i}.md`), fm({title: `T${i}`})]));
      const ctx = makeCtx({fs: mockFs(many)});
      const r = await invoke(routes, {path: p, ctx});
      const items = [...r.written.body.matchAll(/<(?:item|entry)>/g)];
      assert.equal(items.length, 20);
    });
  }

  it('skips dot and underscore entries and non-allowed extensions in the scan', async () => {
    const ctx = makeCtx({fs: mockFs({
      [at('.hidden.md')]: fm({title: 'Hidden'}),
      [at('_draft.md')]: fm({title: 'Draft'}),
      [at('_partials/p.md')]: fm({title: 'Partial'}),
      [at('notes.txt')]: 'Plain',
      [at('keep.md')]: fm({title: 'Keep'}),
    })});
    const r = await invoke(routes, {path: '/api/feed/rss', ctx});
    const titles = [...r.written.body.matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]);
    assert.deepEqual(titles, ['Mochi Lab', 'Keep']);
  });

  it('reads the front-matter date when present and the file mtime otherwise', async () => {
    const {ctx} = feedCtx();
    const r = await invoke(routes, {path: '/api/feed/atom', ctx});
    assert.match(r.written.body, /<updated>2020-01-01T00:00:00Z<\/updated>/);
  });

  // Both feeds link to the page the site actually serves, not to the source
  // path. The `books/` and `posts/` levels are repository structure and never
  // appear in a URL, a chapter's `NN-` ordering prefix is dropped from every
  // segment, and a post is addressed by its front-matter slug when it has one.
  // These used to emit `/books/...` and `/posts/...`, which were dead links.
  describe('item links are real site URLs', () => {
    // Declared oldest to newest, so the feed reverses them: research, blog, book.
    const LINKED = {
      [at('books/programming/3-cuda/1-first.md')]: fm({title: 'Kernel'}),
      [at('posts/blog/hello.md')]: fm({title: 'Hello'}),
      [at('posts/research/swarms.md')]: fm({title: 'Swarms', slug: 'eisi'}),
    };
    const WANT = ['/research/eisi', '/blog/hello', '/programming/cuda/first'];

    it('RSS emits them in <link>', async () => {
      const ctx = makeCtx({fs: mockFs(LINKED)});
      const r = await invoke(routes, {path: '/api/feed/rss', ctx});
      const links = [...r.written.body.matchAll(/<link>([^<]*)<\/link>/g)].map(m => m[1]);
      assert.deepEqual(links, WANT);
    });

    it('Atom emits them in <link href>', async () => {
      const ctx = makeCtx({fs: mockFs(LINKED)});
      const r = await invoke(routes, {path: '/api/feed/atom', ctx});
      const links = [...r.written.body.matchAll(/<link href="([^"]*)"\/>/g)].map(m => m[1]);
      assert.deepEqual(links, WANT);
    });
  });

  // The whole build runs inside one try, so a throw from the memo layer and a
  // throw from inside the scan both land in the same catch.
  const SEAMS = [
    {name: 'the cached() memo call throws', over: {cached() { throw new Error('cache unavailable'); }}},
    {name: 'the scan throws on its first readdirSync', over: {cached: (_k, _t, fn) => fn(), fs: {readdirSync() { throw new Error('unreadable'); }}}},
  ];
  for (const {name, over} of SEAMS) {
    for (const {name: feed, path: p} of FEEDS) {
      it(`${feed} returns 500 without streaming when ${name}`, async () => {
        const ctx = makeCtx({fs: mockFs(CONTENT), ...over});
        const r = await invoke(routes, {path: p, ctx});
        assert.deepEqual([r.status, r.payload], [500, {error: `${feed} feed generation failed`}]);
        assert.equal(r.written, null, 'the streaming success path never ran');
      });
    }
  }
});

// ── Import from URL ───────────────────────────────────────────────────────

// ── Schedule ──────────────────────────────────────────────────────────────

describe('POST /api/schedule', () => {
  const OK = {path: 'a.md', publishAt: '2026-06-01T00:00:00.000Z'};

  const GUARDS = [
    {name: 'a missing path', body: {publishAt: 'x'}, error: 'Missing or invalid path'},
    {name: 'a non-string path', body: {path: 7, publishAt: 'x'}, error: 'Missing or invalid path'},
    {name: 'a missing publishAt', body: {path: 'a.md'}, error: 'Missing or invalid publishAt'},
    {name: 'a non-string publishAt', body: {path: 'a.md', publishAt: 7}, error: 'Missing or invalid publishAt'},
    {name: 'a non-string note', body: {...OK, note: 7}, error: 'note must be a string'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/schedule', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('lazily creates the items list, pushes one scheduled item and saves once', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/schedule', body: OK, ctx});
    assert.equal(r.status, 200);
    const {id, createdAt, ...stable} = r.payload.item;
    assert.deepEqual(stable, {
      path: 'a.md', publishAt: OK.publishAt, note: '', createdBy: TEST_IDENTITY.userId, status: 'scheduled',
    });
    assert.match(id, /^sched_\d+_[a-z0-9]+$/);
    assert.deepEqual(storedSchedule(ctx), [r.payload.item]);
  });

  it('stores a supplied note and appends to an existing list', async () => {
    const ctx = withSchedule([{id: 'old'}]);
    const r = await invoke(routes, {method: 'POST', path: '/api/schedule', body: {...OK, note: 'ship it'}, ctx});
    assert.equal(r.payload.item.note, 'ship it');
    assert.deepEqual(storedSchedule(ctx).map(i => i.id), ['old', r.payload.item.id]);
  });
});

describe('GET /api/schedule', () => {
  const item = (id, publishAt, status = 'scheduled') => ({id, publishAt, status});

  it('sorts by publishAt, promotes past-due items and tallies both buckets', async () => {
    const ctx = withSchedule([
      item('future', '2999-01-01T00:00:00.000Z'),
      item('past', '2000-01-01T00:00:00.000Z'),
      item('done', '2000-01-01T00:00:00.000Z', 'published'),
    ]);
    const r = await invoke(routes, {path: '/api/schedule', ctx});
    assert.equal(r.status, 200);
    // The sort is stable, so the two items sharing a publishAt keep their
    // original relative order.
    assert.deepEqual(r.payload.items.map(i => i.id), ['past', 'done', 'future']);
    assert.equal(r.payload.items.find(i => i.id === 'past').status, 'due');
    // A non-scheduled, non-due status counts toward neither bucket.
    assert.deepEqual([r.payload.upcoming, r.payload.due], [1, 1]);
  });

  it('reports zero upcoming and due for an empty schedule', async () => {
    const r = await invoke(routes, {path: '/api/schedule', ctx: withSchedule()});
    assert.deepEqual([r.status, r.payload], [200, {items: [], upcoming: 0, due: 0}]);
  });
});

describe('DELETE /api/schedule', () => {
  // The 'Not found' wording belonged to the missing-items-key branch, which a
  // row-per-item store has no equivalent of: an empty schedule and one holding
  // other people's items are the same thing to a delete by id.
  const CASES = [
    {name: 'a missing id', body: {}, items: [], status: 400, error: 'Missing id'},
    {name: 'an id against an empty schedule', body: {id: 'x'}, items: [], status: 404, error: 'Scheduled item not found'},
    {name: 'an id absent from the schedule', body: {id: 'x'}, items: [{id: 'other'}], status: 404, error: 'Scheduled item not found'},
  ];
  for (const {name, body, items, status, error} of CASES) {
    it(`rejects ${name}, removing nothing`, async () => {
      const ctx = withSchedule(items);
      const r = await invoke(routes, {method: 'DELETE', path: '/api/schedule', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(storedSchedule(ctx).map(i => i.id), items.map(i => i.id));
    });
  }

  it('removes the matching item, keeping its siblings', async () => {
    const ctx = withSchedule([{id: 'a'}, {id: 'b'}]);
    const r = await invoke(routes, {method: 'DELETE', path: '/api/schedule', body: {id: 'a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(storedSchedule(ctx).map(i => i.id), ['b']);
  });
});

// ── Slides ────────────────────────────────────────────────────────────────

// ── Activity heatmap ──────────────────────────────────────────────────────

describe('GET /api/activity-heatmap', () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 400 * 86400000).toISOString();

  // The default and the cap are both 365 days, so content files need a recent
  // mtime to survive the post-cache window filter.
  function heatmapCtx(over = {}) {
    const base = mockFs({
      [at('a.md')]: 'x',
      [at('sub/b.md')]: 'x',
      [at('.hidden.md')]: 'x',
      [at('.hidden/c.md')]: 'x',
      [at('n.txt')]: 'x',
    });
    const now = new Date();
    const fs = {...base, statSync: p => ({...base.statSync(p), mtime: now}), ...(over.fs ? {} : {})};
    return makeCtx({fs, ...over});
  }

  it('tallies content mtimes into one per-day bucket set', async () => {
    const r = await invoke(routes, {path: '/api/activity-heatmap', ctx: heatmapCtx()});
    assert.equal(r.status, 200);
    // Two markdown files (one nested) land on today. The dot-file, the
    // dot-directory and the .txt are all skipped.
    assert.deepEqual(r.payload.days, {[today]: 2});
    assert.equal(r.payload.totalDays, 1);
  });

  it('narrows the window with ?days and keeps only today\'s bucket', async () => {
    const wide = await invoke(routes, {path: '/api/activity-heatmap', query: {days: '365'}, ctx: heatmapCtx()});
    assert.deepEqual(Object.keys(wide.payload.days), [today]);
    const narrow = await invoke(routes, {path: '/api/activity-heatmap', query: {days: '1'}, ctx: heatmapCtx()});
    assert.deepEqual(Object.keys(narrow.payload.days), [today]);
  });

  it('falls back to the default window for a non-numeric days value', async () => {
    const r = await invoke(routes, {path: '/api/activity-heatmap', query: {days: 'abc'}, ctx: heatmapCtx()});
    assert.deepEqual([r.status, r.payload.days], [200, {[today]: 2}]);
  });

  const SEAMS = [
    {name: 'the cached() memo call throws', over: {cached() { throw new Error('cache unavailable'); }}},
    {name: 'the scan closure throws', over: {cached: (_k, _t, fn) => fn(), fs: {readdirSync() { throw new Error('unreadable'); }}}},
  ];
  for (const {name, over} of SEAMS) {
    it(`returns 500 Heatmap failed when ${name}`, async () => {
      const r = await invoke(routes, {path: '/api/activity-heatmap', ctx: heatmapCtx(over)});
      assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Heatmap failed'}, opts: undefined}]);
      assert.equal(r.replies.some(x => x.payload && 'days' in x.payload), false);
    });
  }
});

// ── Daily summary ─────────────────────────────────────────────────────────

// Each body-reading handler wraps the read and the destructure of its result in
// one try whose catch returns a fixed 400 ahead of the first inner guard.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/schedule', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/schedule', error: 'Invalid request'},
  ];
  for (const {method, path: p, error} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns its fixed 400 when ${label}, touching no store`, async () => {
        const ctx = makeCtx({readBody, fs: mockFs()});
        const r = await invoke(routes, {method, path: p, ctx});
        assert.deepEqual([r.status, r.payload], [400, {error}]);
        assert.deepEqual(ctx.calls.saveJSON, []);
      });
    }
  }
});
