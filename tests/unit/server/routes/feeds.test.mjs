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
import {loadRoute, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT, TEST_IDENTITY} from '../../_harness.mjs';

const routes = loadRoute('feeds');
const {STREAKS_FILE} = FILES;
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'sessions.json');
const SCHEDULE_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'schedule.json');
const at = rel => path.join(PROJECT_ROOT, rel);

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

describe('GET /api/references', () => {
  const BIB = at('content/bibliography/references.yaml');

  it('serves the parsed references through the shared memo', async () => {
    const fs = mockFs({[BIB]: 'smith2020:\n  title: A Paper\n'});
    const r = await invoke(routes, {path: '/api/references', ctx: makeCtx({fs})});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.references.smith2020, {title: 'A Paper'});
  });

  // Any stat, read or parse failure yields {}, so a missing or corrupt file
  // still serves an empty map rather than a 500.
  const FALLBACKS = [
    {name: 'an empty file', files: {[BIB]: ''}},
    {name: 'corrupt YAML', files: {[BIB]: '\tnot: [valid'}},
    {name: 'a missing file', files: {}},
  ];
  for (const {name, files} of FALLBACKS) {
    it(`returns an empty map for ${name}`, async () => {
      const r = await invoke(routes, {path: '/api/references', ctx: makeCtx({fs: mockFs(files)})});
      assert.deepEqual([r.status, r.payload], [200, {references: {}}]);
    });
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────

describe('POST /api/sessions', () => {
  const OK = {startTime: '2026-01-01T09:00:00.000Z'};
  // The session is filed under the signed-in caller, so the store bucket the
  // assertions look in is the harness identity, not a body field.
  const UID = TEST_IDENTITY.userId;
  const asUser = userId => ({...TEST_IDENTITY, userId});

  // The userId guards are gone with `body.userId`; startTime and the optional
  // fields are still client-supplied and still guarded.
  const GUARDS = [
    {name: 'a missing startTime', body: {}, error: 'Missing or invalid startTime'},
    {name: 'a non-string startTime', body: {startTime: 7}, error: 'Missing or invalid startTime'},
    {name: 'a non-string endTime', body: {...OK, endTime: 7}, error: 'endTime must be a string'},
    {name: 'a non-number wordsWritten', body: {...OK, wordsWritten: 'x'}, error: 'wordsWritten must be a number'},
    {name: 'a non-array filesEdited', body: {...OK, filesEdited: 'x'}, error: 'filesEdited must be an array'},
    {name: 'a filesEdited array over 100 entries', body: {...OK, filesEdited: new Array(101).fill('f.md')}, error: 'filesEdited exceeds maximum length of 100'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name}, persisting nothing`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/sessions', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('persists a session with every optional field supplied', async () => {
    const ctx = makeCtx();
    const body = {...OK, endTime: '2026-01-01T10:30:00.000Z', wordsWritten: 500, filesEdited: ['a.md', 'b.md']};
    const r = await invoke(routes, {method: 'POST', path: '/api/sessions', body, ctx});
    assert.equal(r.status, 200);
    const {id, ...stable} = r.payload.session;
    assert.deepEqual(stable, {
      startTime: OK.startTime,
      endTime: '2026-01-01T10:30:00.000Z',
      wordsWritten: 500,
      filesEdited: ['a.md', 'b.md'],
      duration: 90,
    });
    assert.match(id, /^sess_\d+_[a-z0-9]+$/);
    assert.deepEqual(ctx.store[SESSIONS_FILE][UID], [r.payload.session]);
  });

  it('defaults an omitted endTime to now, with zero words and duration', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/sessions', body: OK});
    assert.equal(r.payload.session.wordsWritten, 0);
    assert.equal(r.payload.session.duration, 0);
    assert.deepEqual(r.payload.session.filesEdited, []);
    assert.ok(r.payload.session.endTime);
  });

  it('blanks a non-string entry in filesEdited', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/sessions', body: {...OK, filesEdited: ['a.md', 7, null]}});
    assert.deepEqual(r.payload.session.filesEdited, ['a.md', '', '']);
  });

  it('appends to an existing user without dropping prior sessions', async () => {
    const ctx = makeCtx({store: {[SESSIONS_FILE]: {[UID]: [{id: 'old'}]}}});
    await invoke(routes, {method: 'POST', path: '/api/sessions', body: OK, ctx});
    assert.deepEqual(ctx.store[SESSIONS_FILE][UID].map(s => s.id).slice(0, 1), ['old']);
    assert.equal(ctx.store[SESSIONS_FILE][UID].length, 2);
  });

  it('files the session under the caller, ignoring a userId in the body', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'POST', path: '/api/sessions', body: {...OK, userId: 'someone-else'}, ctx});
    assert.deepEqual(Object.keys(ctx.store[SESSIONS_FILE]), [UID]);
  });

  it('caps a user history at the most recent 1000 sessions', async () => {
    const existing = Array.from({length: 1000}, (_, i) => ({id: `s${i}`}));
    const ctx = makeCtx({store: {[SESSIONS_FILE]: {[UID]: existing}}});
    await invoke(routes, {method: 'POST', path: '/api/sessions', body: OK, ctx});
    const saved = ctx.store[SESSIONS_FILE][UID];
    assert.equal(saved.length, 1000);
    assert.equal(saved[0].id, 's1', 'the oldest session is dropped');
  });

  // An inherited key is a legal userId, so the bucket init must be an own-key
  // check or the record would land on Object.prototype.
  for (const userId of INHERITED_KEYS) {
    it(`stores the inherited userId ${JSON.stringify(userId)} as an own key`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/sessions', body: OK, ctx, auth: asUser(userId)});
      assert.equal(r.status, 200);
      assert.ok(Object.hasOwn(ctx.store[SESSIONS_FILE], userId));
      assert.equal(ctx.store[SESSIONS_FILE][userId].length, 1);
    });
  }
});

describe('GET /api/sessions', () => {
  const sess = (id, over = {}) => ({id, duration: 10, wordsWritten: 100, ...over});
  const five = Array.from({length: 5}, (_, i) => sess(`s${i}`));
  const UID = TEST_IDENTITY.userId;
  const asUser = userId => ({...TEST_IDENTITY, userId});

  it('returns the most recent page newest first, with summed totals', async () => {
    const ctx = makeCtx({store: {[SESSIONS_FILE]: {[UID]: five}}});
    const r = await invoke(routes, {path: '/api/sessions', query: {limit: '2'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.sessions.map(s => s.id), ['s4', 's3']);
    assert.deepEqual(r.payload.summary, {totalSessions: 2, totalMinutes: 20, totalWords: 200});
  });

  it('summarises only the limited page, not the whole history', async () => {
    const ctx = makeCtx({store: {[SESSIONS_FILE]: {[UID]: five}}});
    const r = await invoke(routes, {path: '/api/sessions', query: {limit: '1'}, ctx});
    assert.deepEqual(r.payload.summary, {totalSessions: 1, totalMinutes: 10, totalWords: 100});
  });

  it('applies the zero fallback for missing or falsy duration and wordsWritten', async () => {
    const store = {[SESSIONS_FILE]: {[UID]: [sess('a', {duration: undefined, wordsWritten: undefined}), sess('b', {duration: 0, wordsWritten: 0})]}};
    const r = await invoke(routes, {path: '/api/sessions', ctx: makeCtx({store})});
    assert.deepEqual(r.payload.summary, {totalSessions: 2, totalMinutes: 0, totalWords: 0});
  });

  it('reads the caller\'s own bucket, ignoring a userId in the query', async () => {
    const store = {[SESSIONS_FILE]: {[UID]: [sess('mine')], other: [sess('theirs')]}};
    const r = await invoke(routes, {path: '/api/sessions', query: {userId: 'other'}, ctx: makeCtx({store})});
    assert.deepEqual(r.payload.sessions.map(s => s.id), ['mine'], 'other-key data does not leak');
  });

  // A request-controlled id such as `constructor` resolves to a truthy
  // inherited value, so without the own-key guard `.slice` would throw and hang
  // the request until the socket timeout.
  for (const userId of [...INHERITED_KEYS, 'absent', 'default']) {
    it(`returns an empty page and zeroed summary for the non-own id ${JSON.stringify(userId)}`, async () => {
      const store = {[SESSIONS_FILE]: {real: [sess('s')]}};
      const r = await invoke(routes, {path: '/api/sessions', ctx: makeCtx({store}), auth: asUser(userId)});
      assert.deepEqual([r.status, r.payload], [200, {sessions: [], summary: {totalSessions: 0, totalMinutes: 0, totalWords: 0}}]);
    });
  }

  // numericParam only upper-bounds, so a negative limit would flip
  // slice(-limit) into slice(limit), skipping the first |limit| sessions and
  // over-returning instead of taking the most recent tail.
  const LIMITS = [
    {name: 'absent, giving the default page of 20', query: {}, ids: ['s4', 's3', 's2', 's1', 's0']},
    {name: 'valid', query: {limit: '3'}, ids: ['s4', 's3', 's2']},
    {name: 'above the cap, clamped to 100', query: {limit: '9999'}, ids: ['s4', 's3', 's2', 's1', 's0']},
    {name: 'non-numeric, falling back to the default', query: {limit: 'abc'}, ids: ['s4', 's3', 's2', 's1', 's0']},
    {name: 'negative, clamped to the single most recent session', query: {limit: '-1'}, ids: ['s4']},
    {name: 'very negative, clamped the same way', query: {limit: '-99'}, ids: ['s4']},
  ];
  for (const {name, query, ids} of LIMITS) {
    it(`handles a limit that is ${name}`, async () => {
      const ctx = makeCtx({store: {[SESSIONS_FILE]: {[UID]: five}}});
      const r = await invoke(routes, {path: '/api/sessions', query, ctx});
      assert.deepEqual(r.payload.sessions.map(s => s.id), ids);
    });
  }
});

// ── Content table of contents ─────────────────────────────────────────────

describe('GET /api/content-toc', () => {
  it('builds a recursive tree and routes through cached("content-toc", 30000)', async () => {
    let seen;
    const fs = mockFs({
      [at('content/guide/intro.md')]: fm({title: 'Introduction'}),
      [at('content/guide/_category_.json')]: JSON.stringify({label: 'The Guide'}),
      [at('content/top.md')]: 'no front matter\n',
    });
    const ctx = makeCtx({fs, cached: (key, ttl, fn) => { seen = [key, ttl]; return fn(); }});
    const r = await invoke(routes, {path: '/api/content-toc', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ['content-toc', 30000]);
    assert.deepEqual(r.payload.toc, [
      {
        type: 'directory',
        name: 'guide',
        // The _category_.json label overrides the bare directory name.
        title: 'The Guide',
        children: [{type: 'file', name: 'intro.md', title: 'Introduction', path: 'content/guide/intro.md'}],
        path: 'content/guide',
      },
      // No front matter, so the title falls back to the filename minus extension.
      {type: 'file', name: 'top.md', title: 'top', path: 'content/top.md'},
    ]);
  });

  const TITLE_FALLBACKS = [
    {name: 'no _category_.json', files: {}, title: 'guide'},
    {name: 'malformed JSON', files: {[at('content/guide/_category_.json')]: '{not json'}, title: 'guide'},
    {name: 'no truthy label', files: {[at('content/guide/_category_.json')]: '{"label": ""}'}, title: 'guide'},
  ];
  for (const {name, files, title} of TITLE_FALLBACKS) {
    it(`falls back to the directory name with ${name}`, async () => {
      const fs = mockFs({[at('content/guide/a.md')]: 'x', ...files});
      const r = await invoke(routes, {path: '/api/content-toc', ctx: makeCtx({fs})});
      assert.equal(r.payload.toc[0].title, title);
    });
  }

  it('skips dot and underscore entries and non-allowed extensions', async () => {
    const fs = mockFs({
      [at('content/.hidden.md')]: 'x',
      [at('content/_draft.md')]: 'x',
      [at('content/_category_.json')]: '{}',
      [at('content/notes.txt')]: 'x',
      [at('content/keep.md')]: 'x',
    });
    const r = await invoke(routes, {path: '/api/content-toc', ctx: makeCtx({fs})});
    assert.deepEqual(r.payload.toc.map(e => e.name), ['keep.md']);
  });

  it('orders siblings by name even when readdir returns them unsorted', async () => {
    const base = mockFs({[at('content/c.md')]: 'x', [at('content/a.md')]: 'x', [at('content/b.md')]: 'x'});
    const fs = {...base, readdirSync: (p, o) => base.readdirSync(p, o).reverse()};
    const r = await invoke(routes, {path: '/api/content-toc', ctx: makeCtx({fs})});
    assert.deepEqual(r.payload.toc.map(e => e.name), ['a.md', 'b.md', 'c.md']);
  });

  it('serves a repeat request from the stored tree with no second walk', async () => {
    let walks = 0;
    const base = mockFs({[at('content/a.md')]: 'x'});
    const fs = {...base, readdirSync: (p, o) => { walks++; return base.readdirSync(p, o); }};
    const ctx = makeCtx({fs});
    await invoke(routes, {path: '/api/content-toc', ctx});
    const before = walks;
    await invoke(routes, {path: '/api/content-toc', ctx});
    assert.equal(walks, before, 'the second request reuses the cached tree');
  });

  it('returns 500 when the walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('content dir unreadable'); }}});
    const r = await invoke(routes, {path: '/api/content-toc', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'TOC generation failed'}]);
  });
});

// ── Feeds ─────────────────────────────────────────────────────────────────

describe('GET /api/feed/rss and /api/feed/atom', () => {
  // mockFs stamps each file with an increasing mtime, so declaration order here
  // is oldest to newest and the feeds must reverse it.
  const CONTENT = {
    [at('content/old.md')]: fm({title: 'Oldest', date: '2020-01-01'}),
    [at('content/mid.md')]: fm({title: 'AT&T <Corp>'}),
    [at('content/new.md')]: fm({title: 'Newest'}),
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
    assert.deepEqual(seen, ['feed-items', 60000]);
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
      const many = Object.fromEntries(Array.from({length: 25}, (_, i) => [at(`content/f${i}.md`), fm({title: `T${i}`})]));
      const ctx = makeCtx({fs: mockFs(many)});
      const r = await invoke(routes, {path: p, ctx});
      const items = [...r.written.body.matchAll(/<(?:item|entry)>/g)];
      assert.equal(items.length, 20);
    });
  }

  it('skips dot and underscore entries and non-allowed extensions in the scan', async () => {
    const ctx = makeCtx({fs: mockFs({
      [at('content/.hidden.md')]: fm({title: 'Hidden'}),
      [at('content/_draft.md')]: fm({title: 'Draft'}),
      [at('content/_partials/p.md')]: fm({title: 'Partial'}),
      [at('content/notes.txt')]: 'Plain',
      [at('content/keep.md')]: fm({title: 'Keep'}),
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

describe('POST /api/import-url', () => {
  const OK = {url: 'https://example.com/a', targetPath: 'content/imported.md'};

  it('returns 429 before reading the body, keyed import-url at ceiling 5', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/import-url', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'import-url:127.0.0.1', maxPerMinute: 5}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'a missing url', body: {targetPath: 'content/a.md'}, status: 400, error: 'Missing or invalid url'},
    {name: 'a non-string url', body: {url: 7, targetPath: 'content/a.md'}, status: 400, error: 'Missing or invalid url'},
    {name: 'a missing targetPath', body: {url: 'https://x/a'}, status: 400, error: 'Missing or invalid targetPath'},
    {name: 'a non-string title', body: {...OK, title: 7}, status: 400, error: 'title must be a string'},
    {name: 'a targetPath the validator rejects', body: {...OK, targetPath: '../escape.md'}, status: 400, error: 'Invalid targetPath'},
    {name: 'a non-http scheme', body: {...OK, url: 'ftp://example.com/a'}, status: 400, error: 'URL must start with http:// or https://'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} before any network call`, async () => {
      const ctx = makeCtx({fs: mockFs()});
      const r = await invoke(routes, {method: 'POST', path: '/api/import-url', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
    });
  }

  it('returns 409 when the joined target already exists', async () => {
    const ctx = makeCtx({fs: mockFs({[at('content/imported.md')]: 'existing'})});
    const r = await invoke(routes, {method: 'POST', path: '/api/import-url', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Target file already exists'}]);
  });
});

// ── Schedule ──────────────────────────────────────────────────────────────

describe('POST /api/schedule', () => {
  const OK = {path: 'content/a.md', publishAt: '2026-06-01T00:00:00.000Z'};

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
    assert.deepEqual(stable, {path: 'content/a.md', publishAt: OK.publishAt, note: '', status: 'scheduled'});
    assert.match(id, /^sched_\d+_[a-z0-9]+$/);
    assert.equal(ctx.calls.saveJSON.length, 1);
    assert.deepEqual(ctx.store[SCHEDULE_FILE].items, [r.payload.item]);
  });

  it('stores a supplied note and appends to an existing list', async () => {
    const ctx = makeCtx({store: {[SCHEDULE_FILE]: {items: [{id: 'old'}]}}});
    const r = await invoke(routes, {method: 'POST', path: '/api/schedule', body: {...OK, note: 'ship it'}, ctx});
    assert.equal(r.payload.item.note, 'ship it');
    assert.deepEqual(ctx.store[SCHEDULE_FILE].items.map(i => i.id), ['old', r.payload.item.id]);
  });
});

describe('GET /api/schedule', () => {
  const item = (id, publishAt, status = 'scheduled') => ({id, publishAt, status});

  it('sorts by publishAt, promotes past-due items and tallies both buckets', async () => {
    const store = {[SCHEDULE_FILE]: {items: [
      item('future', '2999-01-01T00:00:00.000Z'),
      item('past', '2000-01-01T00:00:00.000Z'),
      item('done', '2000-01-01T00:00:00.000Z', 'published'),
    ]}};
    const r = await invoke(routes, {path: '/api/schedule', ctx: makeCtx({store})});
    assert.equal(r.status, 200);
    // The sort is stable, so the two items sharing a publishAt keep their
    // original relative order.
    assert.deepEqual(r.payload.items.map(i => i.id), ['past', 'done', 'future']);
    assert.equal(r.payload.items.find(i => i.id === 'past').status, 'due');
    // A non-scheduled, non-due status counts toward neither bucket.
    assert.deepEqual([r.payload.upcoming, r.payload.due], [1, 1]);
  });

  for (const [label, stored] of [['an empty items list', {items: []}], ['no items key', {}]]) {
    it(`reports zero upcoming and due for ${label}`, async () => {
      const r = await invoke(routes, {path: '/api/schedule', ctx: makeCtx({store: {[SCHEDULE_FILE]: stored}})});
      assert.deepEqual([r.status, r.payload], [200, {items: [], upcoming: 0, due: 0}]);
    });
  }
});

describe('DELETE /api/schedule', () => {
  const CASES = [
    {name: 'a missing id', body: {}, store: {items: []}, status: 400, error: 'Missing id'},
    {name: 'a schedule with no items key', body: {id: 'x'}, store: {}, status: 404, error: 'Not found'},
    {name: 'an id absent from items', body: {id: 'x'}, store: {items: [{id: 'other'}]}, status: 404, error: 'Scheduled item not found'},
  ];
  for (const {name, body, store, status, error} of CASES) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: {[SCHEDULE_FILE]: store}});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/schedule', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('removes the matching item and saves once', async () => {
    const ctx = makeCtx({store: {[SCHEDULE_FILE]: {items: [{id: 'a'}, {id: 'b'}]}}});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/schedule', body: {id: 'a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[SCHEDULE_FILE].items.map(i => i.id), ['b']);
    assert.equal(ctx.calls.saveJSON.length, 1);
  });
});

// ── Slides ────────────────────────────────────────────────────────────────

describe('GET /api/file/slides', () => {
  const SLIDES_DOC = fm({title: 'Deck'}, 'First slide\n---\nSecond slide\n\n## Third\n\nbody');

  function slidesCtx(files) {
    let reads = 0;
    const base = mockFs(files);
    const fs = {...base, readFileSync: p => { reads++; return base.readFileSync(p); }};
    return {ctx: makeCtx({fs}), reads: () => reads};
  }

  it('splits the body into indexed slides', async () => {
    const {ctx} = slidesCtx({[at('content/deck.md')]: SLIDES_DOC});
    const r = await invoke(routes, {path: '/api/file/slides', query: {path: 'content/deck.md'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.title, 'Deck');
    assert.equal(r.payload.totalSlides, 3);
    assert.deepEqual(r.payload.slides.map(s => s.index), [0, 1, 2]);
    assert.deepEqual(r.payload.slides.map(s => s.content), ['First slide', 'Second slide', '## Third\n\nbody']);
  });

  it('serves a repeat request for the same path from cache', async () => {
    const {ctx, reads} = slidesCtx({[at('content/deck.md')]: SLIDES_DOC});
    await invoke(routes, {path: '/api/file/slides', query: {path: 'content/deck.md'}, ctx});
    assert.equal(reads(), 1);
    await invoke(routes, {path: '/api/file/slides', query: {path: 'content/deck.md'}, ctx});
    assert.equal(reads(), 1, 'the second request is served from the per-path cache');
  });

  it('keys each path separately', async () => {
    const {ctx, reads} = slidesCtx({[at('content/a.md')]: 'A', [at('content/b.md')]: 'B'});
    await invoke(routes, {path: '/api/file/slides', query: {path: 'content/a.md'}, ctx});
    await invoke(routes, {path: '/api/file/slides', query: {path: 'content/b.md'}, ctx});
    assert.equal(reads(), 2);
  });

  it('passes the slides cache key prefix with a 30000 ms TTL', async () => {
    let seen;
    const ctx = makeCtx({fs: mockFs({[at('content/deck.md')]: 'x'}), cached: (key, ttl, fn) => { seen = [key, ttl]; return fn(); }});
    await invoke(routes, {path: '/api/file/slides', query: {path: 'content/deck.md'}, ctx});
    assert.deepEqual(seen, ['slides:content/deck.md', 30000]);
  });

  it('rejects an invalid path before the cache and never reads', async () => {
    const {ctx, reads} = slidesCtx({});
    const r = await invoke(routes, {path: '/api/file/slides', query: {path: '../escape.md'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
    assert.equal(reads(), 0);
  });

  it('does not cache the 404 for a missing file', async () => {
    const {ctx, reads} = slidesCtx({});
    const first = await invoke(routes, {path: '/api/file/slides', query: {path: 'content/missing.md'}, ctx});
    assert.deepEqual([first.status, first.payload], [404, {error: 'File not found'}]);
    await invoke(routes, {path: '/api/file/slides', query: {path: 'content/missing.md'}, ctx});
    assert.equal(reads(), 2, 'the error path stays outside the cache, so the next request retries');
  });

  const TITLES = [
    {name: 'no front matter, so the leading prose stays the first slide', body: 'Leading prose\n\n## Next', title: 'deck', first: 'Leading prose'},
    {name: 'front matter without a title, still stripping the block', body: fm({date: '2026-01-01'}, 'Body'), title: 'deck', first: 'Body'},
    {name: 'a front-matter title used verbatim', body: fm({title: 'Real Title'}, 'Body'), title: 'Real Title', first: 'Body'},
    {name: 'a double-quoted front-matter title with the quotes stripped', body: fm({title: '"Quoted Title"'}, 'Body'), title: 'Quoted Title', first: 'Body'},
  ];
  for (const {name, body, title, first} of TITLES) {
    it(`handles ${name}`, async () => {
      const {ctx} = slidesCtx({[at('content/deck.md')]: body});
      const r = await invoke(routes, {path: '/api/file/slides', query: {path: 'content/deck.md'}, ctx});
      assert.equal(r.payload.title, title);
      assert.equal(r.payload.slides[0].content, first);
    });
  }

  it('drops whitespace-only chunks but keeps a bare "0"', async () => {
    const {ctx} = slidesCtx({[at('content/deck.md')]: 'first\n---\n   \n---\n0\n---\n  0  '});
    const r = await invoke(routes, {path: '/api/file/slides', query: {path: 'content/deck.md'}, ctx});
    assert.deepEqual(r.payload.slides.map(s => s.content), ['first', '0', '0']);
  });
});

// ── Activity heatmap ──────────────────────────────────────────────────────

describe('GET /api/activity-heatmap', () => {
  const today = new Date().toISOString().slice(0, 10);
  const old = new Date(Date.now() - 400 * 86400000).toISOString();

  // The default and the cap are both 365 days, so content files need a recent
  // mtime to survive the post-cache window filter.
  function heatmapCtx(over = {}) {
    const base = mockFs({
      [at('content/a.md')]: 'x',
      [at('content/sub/b.md')]: 'x',
      [at('content/.hidden.md')]: 'x',
      [at('content/.hidden/c.md')]: 'x',
      [at('content/n.txt')]: 'x',
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

describe('GET /api/summary/daily', () => {
  const today = new Date().toISOString().slice(0, 10);
  const todayISO = `${today}T00:00:00.000Z`;

  it('returns the full daily shape over a representative mix', async () => {
    const store = {
      [STREAKS_FILE]: {default: {dailyLog: [{date: today, words: 750}]}},
    };
    // mockFs stamps a fixed past mtime, so no content file counts as modified today.
    const ctx = makeCtx({fs: mockFs({[at('content/a.md')]: 'x'}), store});
    const r = await invoke(routes, {path: '/api/summary/daily', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      date: today,
      filesModifiedToday: 0,
      modifiedFiles: [],
      wordsWrittenToday: 750,
    });
  });

  it('returns zeros for empty stores and empty content', async () => {
    const r = await invoke(routes, {path: '/api/summary/daily', ctx: makeCtx({fs: mockFs({[at('content/.keep')]: ''})})});
    assert.deepEqual(r.payload, {date: today, filesModifiedToday: 0, modifiedFiles: [], wordsWrittenToday: 0});
  });

  it('counts every file modified today but caps modifiedFiles at 20', async () => {
    const files = Object.fromEntries(Array.from({length: 25}, (_, i) => [at(`content/f${i}.md`), 'x']));
    const base = mockFs(files);
    const now = new Date();
    const fs = {...base, statSync: p => ({...base.statSync(p), mtime: now})};
    const r = await invoke(routes, {path: '/api/summary/daily', ctx: makeCtx({fs})});
    assert.equal(r.payload.filesModifiedToday, 25);
    assert.equal(r.payload.modifiedFiles.length, 20);
  });

  it('returns 500 when the content walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/summary/daily', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Summary failed'}]);
  });
});

// Each body-reading handler wraps the read and the destructure of its result in
// one try whose catch returns a fixed 400 ahead of the first inner guard.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/sessions', error: 'Invalid request'},
    {method: 'POST', path: '/api/import-url', error: 'Import failed'},
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
