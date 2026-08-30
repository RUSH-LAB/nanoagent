/**
 * server/routes/analysis-admin.js: the writing-streak tracker, bulk file
 * operations, the recent-files list, annotations, duplicate and orphan
 * detection, markdown linting (single document and corpus-wide), the tag
 * index, the citation network and reference timeline, the word cloud, and the
 * dashboard.
 *
 * Consolidated from the thirty-three per-branch suites that used to cover this
 * module.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT, TEST_IDENTITY} from '../../_harness.mjs';

const routes = loadRoute('analysis-admin');
const {STREAKS_FILE, ANNOTATIONS_FILE, ANALYTICS_FILE, COMMENTS_FILE} = FILES;
const at = rel => path.join(PROJECT_ROOT, rel);
const BIB = at('content/bibliography/references.yaml');
const TRASH_DIR = at('var/trash');

const INHERITED_KEYS = ['toString', 'valueOf', 'hasOwnProperty'];

// The signed-in caller the harness supplies unless a case overrides it. Both
// streak handlers key the store on this, never on anything in the request.
const UID = TEST_IDENTITY.userId;
const asUser = userId => ({...TEST_IDENTITY, userId});

const fm = (fields, body = '') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;

function fsCtx(files, over = {}) {
  const base = mockFs(files);
  const counts = {read: 0, readdir: 0, write: 0, rename: 0};
  const fs = {
    ...base,
    readFileSync: p => { counts.read++; return base.readFileSync(p); },
    readdirSync: (p, o) => { counts.readdir++; return base.readdirSync(p, o); },
    writeFileSync: (p, d) => { counts.write++; return base.writeFileSync(p, d); },
    renameSync: (a, b) => { counts.rename++; return base.renameSync(a, b); },
  };
  return {ctx: makeCtx({fs, ...over}), counts, fs};
}

function bib(entries) {
  return Object.entries(entries).map(([key, e]) => {
    const lines = [`${key}:`];
    for (const [k, v] of Object.entries(e)) {
      if (Array.isArray(v)) { lines.push(`  ${k}:`); for (const item of v) lines.push(`    - ${item}`); }
      else lines.push(`  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
    }
    return lines.join('\n');
  }).join('\n') + '\n';
}

/** A YYYY-MM-DD date `n` days before today. */
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ── Writing streak ────────────────────────────────────────────────────────

describe('GET /api/streak', () => {
  const streak = async (dailyLog, auth) => {
    const store = {[STREAKS_FILE]: {[UID]: {dailyLog}, alice: {dailyLog: []}}};
    const r = await invoke(routes, {path: '/api/streak', ctx: makeCtx({store}), ...(auth ? {auth} : {})});
    return r.payload;
  };

  it('returns an all-zero payload for an empty log', async () => {
    assert.deepEqual(await streak([]), {currentStreak: 0, longestStreak: 0, totalWords: 0, dailyLog: []});
  });

  it('treats a user with no stored log as an empty log', async () => {
    const out = await streak([{date: daysAgo(0), words: 100}], asUser('nobody'));
    assert.deepEqual(out, {currentStreak: 0, longestStreak: 0, totalWords: 0, dailyLog: []});
  });

  it('reads the signed-in user, ignoring a userId in the query string', async () => {
    const store = {[STREAKS_FILE]: {[UID]: {dailyLog: [{date: daysAgo(0), words: 100}]}, alice: {dailyLog: []}}};
    const r = await invoke(routes, {path: '/api/streak', query: {userId: 'alice'}, ctx: makeCtx({store})});
    assert.equal(r.payload.currentStreak, 1);
  });

  it('sorts the log ascending and totals every entry, qualifying or not', async () => {
    const out = await streak([{date: daysAgo(1), words: 10}, {date: daysAgo(3), words: 20}]);
    assert.deepEqual(out.dailyLog.map(e => e.date), [daysAgo(3), daysAgo(1)]);
    assert.equal(out.totalWords, 30);
  });

  // A day qualifies at 50 words or more; the run extends only on directly
  // adjacent qualifying days.
  const LONGEST = [
    {name: 'a consecutive run', log: [3, 2, 1, 0].map(d => ({date: daysAgo(d), words: 100})), longest: 4},
    {name: 'isolated qualifying days', log: [6, 4, 2].map(d => ({date: daysAgo(d), words: 100})), longest: 1},
    {name: 'the longest sub-run before a gap', log: [{date: daysAgo(9), words: 100}, {date: daysAgo(8), words: 100}, {date: daysAgo(7), words: 100}, {date: daysAgo(3), words: 100}], longest: 3},
    // A duplicate date is a zero-day gap, which restarts the run.
    {name: 'duplicate dates as a broken run', log: [{date: daysAgo(3), words: 100}, {date: daysAgo(3), words: 100}], longest: 1},
    {name: 'a sub-50-word day resetting the run', log: [{date: daysAgo(5), words: 100}, {date: daysAgo(4), words: 10}, {date: daysAgo(3), words: 100}, {date: daysAgo(2), words: 100}], longest: 2},
  ];
  for (const {name, log, longest} of LONGEST) {
    it(`computes the longest streak over ${name}`, async () => {
      assert.equal((await streak(log)).longestStreak, longest);
    });
  }

  const CURRENT = [
    {name: 'a run ending today', log: [2, 1, 0].map(d => ({date: daysAgo(d), words: 100})), current: 3},
    {name: 'a run ending yesterday', log: [2, 1].map(d => ({date: daysAgo(d), words: 100})), current: 2},
    {name: 'a stale latest entry', log: [{date: daysAgo(5), words: 100}], current: 0},
    {name: 'a gap before today', log: [{date: daysAgo(5), words: 100}, {date: daysAgo(0), words: 100}], current: 1},
    {name: 'a sub-50-word day today', log: [{date: daysAgo(1), words: 100}, {date: daysAgo(0), words: 10}], current: 0},
  ];
  for (const {name, log, current} of CURRENT) {
    it(`computes the current streak with ${name}`, async () => {
      assert.equal((await streak(log)).currentStreak, current);
    });
  }

  it('can report a current streak shorter than the longest run', async () => {
    const log = [
      ...[10, 9, 8, 7].map(d => ({date: daysAgo(d), words: 100})),
      ...[1, 0].map(d => ({date: daysAgo(d), words: 100})),
    ];
    const out = await streak(log);
    assert.deepEqual([out.currentStreak, out.longestStreak], [2, 4]);
  });
});

describe('POST /api/streak', () => {
  it('returns 429 before reading the body or the store', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/streak', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'streak:127.0.0.1', maxPerMinute: 30}]);
    assert.deepEqual([reads, ctx.calls.loadJSON.length], [0, 0]);
  });

  // The userId type, length, and prototype-key guards that used to live here
  // went away with `body.userId`: the store key is now the session subject,
  // which server/auth.js validates once. What the body still supplies, and so
  // what still needs guarding, is wordsWritten.
  const GUARDS = [
    {name: 'a negative wordsWritten', body: {wordsWritten: -1}, error: 'wordsWritten must be non-negative'},
    {name: 'a wordsWritten above the maximum', body: {wordsWritten: 1000001}, error: 'wordsWritten exceeds maximum'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} before touching the store`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/streak', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('records today under the signed-in user', async () => {
    const ctx = makeCtx();
    const today = new Date().toISOString().slice(0, 10);
    const r = await invoke(routes, {method: 'POST', path: '/api/streak', body: {wordsWritten: 500}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, date: today, words: 500}]);
    assert.deepEqual(ctx.store[STREAKS_FILE][UID].dailyLog, [{date: today, words: 500}]);
  });

  it('ignores a userId in the body and still writes to the session bucket', async () => {
    const ctx = makeCtx();
    const today = new Date().toISOString().slice(0, 10);
    await invoke(routes, {method: 'POST', path: '/api/streak', body: {userId: 'alice', wordsWritten: 500}, ctx});
    assert.deepEqual(Object.keys(ctx.store[STREAKS_FILE]), [UID]);
    assert.deepEqual(ctx.store[STREAKS_FILE][UID].dailyLog, [{date: today, words: 500}]);
  });

  it('overwrites today rather than appending a second entry', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ctx = makeCtx({store: {[STREAKS_FILE]: {[UID]: {dailyLog: [{date: today, words: 100}]}}}});
    await invoke(routes, {method: 'POST', path: '/api/streak', body: {wordsWritten: 900}, ctx});
    assert.deepEqual(ctx.store[STREAKS_FILE][UID].dailyLog, [{date: today, words: 900}]);
  });

  it('defaults a non-numeric or infinite wordsWritten to zero', async () => {
    for (const wordsWritten of ['many', Infinity, NaN]) {
      const r = await invoke(routes, {method: 'POST', path: '/api/streak', body: {wordsWritten}});
      assert.equal(r.payload.words, 0, String(wordsWritten));
    }
  });

  // An inherited key is a legal userId, so the bucket init must be an own-key
  // check or the record would land on Object.prototype.
  for (const userId of INHERITED_KEYS) {
    it(`records under the inherited userId ${JSON.stringify(userId)} as an own key`, async () => {
      const ctx = makeCtx();
      const auth = asUser(userId);
      const r = await invoke(routes, {method: 'POST', path: '/api/streak', body: {wordsWritten: 100}, ctx, auth});
      assert.equal(r.status, 200);
      assert.ok(Object.hasOwn(ctx.store[STREAKS_FILE], userId));
      const read = await invoke(routes, {path: '/api/streak', ctx: makeCtx({store: ctx.store}), auth});
      assert.equal(read.payload.totalWords, 100);
    });
  }
});

// ── Bulk file operations ──────────────────────────────────────────────────

describe('GET /api/files/recent', () => {
  // mockFs stamps increasing mtimes, so the last declared file is newest.
  const TREE = Object.fromEntries([
    ...Array.from({length: 5}, (_, i) => [at(`content/f${i}.md`), fm({title: `T${i}`}, `body ${i}`)]),
    [at('content/.hidden.md'), 'x'],
  ]);

  it('lists the most recently modified first', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/files/recent', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.files.map(f => f.name), ['f4.md', 'f3.md', 'f2.md', 'f1.md', 'f0.md']);
    assert.equal(r.payload.files.some(f => f.name === '.hidden.md'), false);
  });

  const LIMITS = [
    {name: 'absent, giving the default of 10', query: {}, want: 5},
    {name: 'valid', query: {limit: '3'}, want: 3},
    {name: 'larger than the file count', query: {limit: '99'}, want: 5},
    {name: 'non-numeric, falling back to the default', query: {limit: 'abc'}, want: 5},
    // Without the floor, slice(0, -2) would count from the end and return the
    // first three of five rather than nothing.
    {name: 'negative, clamped to an empty page', query: {limit: '-2'}, want: 0},
  ];
  for (const {name, query, want} of LIMITS) {
    it(`handles a limit that is ${name}`, async () => {
      const {ctx} = fsCtx(TREE);
      const r = await invoke(routes, {path: '/api/files/recent', query, ctx});
      assert.equal(r.payload.files.length, want);
    });
  }

  it('caps the page at the fifty-entry slice bound', async () => {
    const many = Object.fromEntries(Array.from({length: 60}, (_, i) => [at(`content/p${i}.md`), 'x']));
    const {ctx} = fsCtx(many);
    const r = await invoke(routes, {path: '/api/files/recent', query: {limit: '999'}, ctx});
    assert.equal(r.payload.files.length, 50);
  });

  const STATS = [
    {name: 'includeStats=true carries the extra fields', query: {includeStats: 'true'}, extra: true},
    {name: 'omitting the param leaves them absent', query: {}, extra: false},
    // Only the exact string "true" enables them.
    {name: 'includeStats=1 does not enable them', query: {includeStats: '1'}, extra: false},
  ];
  for (const {name, query, extra} of STATS) {
    it(name, async () => {
      const {ctx} = fsCtx(TREE);
      const r = await invoke(routes, {path: '/api/files/recent', query, ctx});
      const [file] = r.payload.files;
      assert.deepEqual(Object.keys(file).sort(), extra ? ['mtime', 'name', 'path', 'readingTimeMin', 'title', 'wordCount'] : ['mtime', 'name', 'path']);
    });
  }

  it('caches per includeStats flag and slices the cached list per limit', async () => {
    let seen;
    const {ctx, counts} = fsCtx(TREE, {cached: (k, t, fn) => { seen ??= [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/files/recent', ctx});
    assert.deepEqual(seen, ['files-recent:plain', 30000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/files/recent', query: {limit: '2'}, ctx});
    assert.equal(counts.readdir, after, 'a different limit slices the cached list');
    await invoke(routes, {path: '/api/files/recent', query: {includeStats: 'true'}, ctx});
    assert.ok(counts.readdir > after, 'the other flag is a distinct entry');
  });

  it('returns 500 without caching when the walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/files/recent', ctx});
    assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Failed to list recent files'}, opts: undefined}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

