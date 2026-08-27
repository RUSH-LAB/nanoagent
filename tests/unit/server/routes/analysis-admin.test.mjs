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
import {loadRoute, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT} from '../../_harness.mjs';

const routes = loadRoute('analysis-admin');
const {STREAKS_FILE, ANNOTATIONS_FILE, ANALYTICS_FILE, COMMENTS_FILE, DISCUSSIONS_FILE} = FILES;
const at = rel => path.join(PROJECT_ROOT, rel);
const BIB = at('content/bibliography/references.yaml');
const TRASH_DIR = at('var/trash');

const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
const INHERITED_KEYS = ['toString', 'valueOf', 'hasOwnProperty'];

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
  const streak = async (dailyLog, userId) => {
    const store = {[STREAKS_FILE]: {default: {dailyLog}, alice: {dailyLog: []}}};
    const r = await invoke(routes, {path: '/api/streak', query: userId ? {userId} : {}, ctx: makeCtx({store})});
    return r.payload;
  };

  it('returns an all-zero payload for an empty log', async () => {
    assert.deepEqual(await streak([]), {currentStreak: 0, longestStreak: 0, totalWords: 0, dailyLog: []});
  });

  it('treats an unknown user as an empty log', async () => {
    const out = await streak([{date: daysAgo(0), words: 100}], 'nobody');
    assert.deepEqual(out, {currentStreak: 0, longestStreak: 0, totalWords: 0, dailyLog: []});
  });

  it('falls back to the default user when no userId is given', async () => {
    const out = await streak([{date: daysAgo(0), words: 100}]);
    assert.equal(out.currentStreak, 1);
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

  const GUARDS = [
    {name: 'a numeric userId', body: {userId: 7}, error: 'userId must be a string'},
    {name: 'a boolean userId', body: {userId: true}, error: 'userId must be a string'},
    {name: 'an object userId', body: {userId: {}}, error: 'userId must be a string'},
    {name: 'a userId over 200 characters', body: {userId: 'u'.repeat(201)}, error: 'userId must be 200 characters or fewer'},
    {name: 'a negative wordsWritten', body: {wordsWritten: -1}, error: 'wordsWritten must be non-negative'},
    {name: 'a wordsWritten above the maximum', body: {wordsWritten: 1000001}, error: 'wordsWritten exceeds maximum'},
    ...PROTO_KEYS.map(userId => ({name: `the proto userId ${JSON.stringify(userId)}`, body: {userId}, error: 'Invalid userId'})),
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} before touching the store`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/streak', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('records today under the default user', async () => {
    const ctx = makeCtx();
    const today = new Date().toISOString().slice(0, 10);
    const r = await invoke(routes, {method: 'POST', path: '/api/streak', body: {wordsWritten: 500}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, date: today, words: 500}]);
    assert.deepEqual(ctx.store[STREAKS_FILE].default.dailyLog, [{date: today, words: 500}]);
  });

  it('overwrites today rather than appending a second entry', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ctx = makeCtx({store: {[STREAKS_FILE]: {default: {dailyLog: [{date: today, words: 100}]}}}});
    await invoke(routes, {method: 'POST', path: '/api/streak', body: {wordsWritten: 900}, ctx});
    assert.deepEqual(ctx.store[STREAKS_FILE].default.dailyLog, [{date: today, words: 900}]);
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
      const r = await invoke(routes, {method: 'POST', path: '/api/streak', body: {userId, wordsWritten: 100}, ctx});
      assert.equal(r.status, 200);
      assert.ok(Object.hasOwn(ctx.store[STREAKS_FILE], userId));
      const read = await invoke(routes, {path: '/api/streak', query: {userId}, ctx: makeCtx({store: ctx.store})});
      assert.equal(read.payload.totalWords, 100);
    });
  }
});

// ── Bulk file operations ──────────────────────────────────────────────────

describe('POST /api/files/bulk', () => {
  const TREE = {[at('content/a.md')]: 'x', [at('content/b.md')]: 'y'};

  it('returns 429 without reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/files/bulk', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'files-bulk:127.0.0.1', maxPerMinute: 10}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an absent action', body: {paths: ['content/a.md']}, error: 'Missing action or paths'},
    {name: 'a non-array paths', body: {action: 'delete', paths: 'content/a.md'}, error: 'Missing action or paths'},
    {name: 'an empty paths array', body: {action: 'delete', paths: []}, error: 'Missing action or paths'},
    {name: 'an unknown action', body: {action: 'copy', paths: ['content/a.md']}, error: 'action must be "delete" or "move"'},
    {name: 'a move with an invalid targetDir', body: {action: 'move', paths: ['content/a.md'], targetDir: 'elsewhere'}, error: 'Invalid target directory. Must start with content/'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const {ctx, counts} = fsCtx(TREE);
      const r = await invoke(routes, {method: 'POST', path: '/api/files/bulk', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(counts.rename, 0);
    });
  }

  // The targetDir guard is move-only, so a delete with a bad targetDir proceeds.
  it('skips the targetDir guard for a delete', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/files/bulk', body: {action: 'delete', paths: ['content/a.md'], targetDir: 'elsewhere'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.processed, 1);
  });

  it('moves each file to trash on a delete and clears both caches', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/files/bulk', body: {action: 'delete', paths: ['content/a.md', 'content/b.md']}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, processed: 2, errors: []}]);
    assert.equal(counts.rename, 2);
    assert.deepEqual(ctx.calls.invalidateCache, ['search', 'stats']);
    assert.equal(ctx.fs.existsSync(at('content/a.md')), false);
  });

  it('moves each file to the target directory and clears both caches', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/files/bulk', body: {action: 'move', paths: ['content/a.md'], targetDir: 'content/dest'}, ctx});
    assert.equal(r.payload.processed, 1);
    assert.equal(ctx.fs.existsSync(at('content/dest/a.md')), true);
    assert.deepEqual(ctx.calls.invalidateCache, ['search', 'stats']);
  });

  it('invalidates nothing when the whole batch fails', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/files/bulk', body: {action: 'delete', paths: ['../escape.md', 'content/gone.md']}, ctx});
    assert.equal(r.payload.processed, 0);
    assert.deepEqual(r.payload.errors.map(e => e.error), ['Invalid path', 'File not found']);
    assert.deepEqual(ctx.calls.invalidateCache, []);
  });

  // The three per-item move failure arms, each recorded rather than aborting.
  it('records each move error arm in order without abandoning the batch', async () => {
    const files = {
      [at('content/ok.md')]: 'x',
      [at('content/taken.md')]: 'y',
      [at('content/dest/taken.md')]: 'z',
      [at('content/boom.md')]: 'w',
    };
    const base = mockFs({...files, [at('content/bad.md')]: 'b'});
    const fs = {...base, renameSync: (a, b) => { if (a.endsWith('boom.md')) throw new Error('EIO'); return base.renameSync(a, b); }};
    // A validator that rejects only the resolved newPath of the first entry, so
    // that entry reaches the "Resulting path is invalid" arm.
    const isValidFilePath = q => q !== 'content/dest/bad.md' && !String(q).includes('..');
    const ctx = makeCtx({fs, isValidFilePath});
    const paths = ['content/bad.md', 'content/taken.md', 'content/boom.md', 'content/ok.md'];
    const r = await invoke(routes, {method: 'POST', path: '/api/files/bulk', body: {action: 'move', paths, targetDir: 'content/dest'}, ctx});
    assert.deepEqual(r.payload.errors, [
      {path: 'content/bad.md', error: 'Resulting path is invalid'},
      {path: 'content/taken.md', error: 'Target already exists'},
      {path: 'content/boom.md', error: 'Operation failed'},
    ]);
    assert.equal(r.payload.processed, 1, 'the healthy entry still moves');
  });
});

// ── Recent files ──────────────────────────────────────────────────────────

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

// ── Annotations ───────────────────────────────────────────────────────────

describe('GET /api/annotations', () => {
  const STORE = {[ANNOTATIONS_FILE]: {'/p': [{id: 'a1'}]}};

  it('returns 400 when the page param is missing', async () => {
    const r = await invoke(routes, {path: '/api/annotations'});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing page parameter'}]);
  });

  it('returns the stored annotations for a real page', async () => {
    const r = await invoke(routes, {path: '/api/annotations', query: {page: '/p'}, ctx: makeCtx({store: STORE})});
    assert.deepEqual([r.status, r.payload], [200, {annotations: [{id: 'a1'}]}]);
  });

  // Without the own-key guard an inherited value would serialise to a
  // malformed body rather than the empty default.
  for (const page of [...PROTO_KEYS, ...INHERITED_KEYS, '/absent']) {
    it(`returns the empty default for the non-own page ${JSON.stringify(page)}`, async () => {
      const r = await invoke(routes, {path: '/api/annotations', query: {page}, ctx: makeCtx({store: STORE})});
      assert.deepEqual([r.status, r.payload], [200, {annotations: []}]);
    });
  }
});

describe('POST /api/annotations', () => {
  const OK = {page: '/p', text: 'selected', startOffset: 10, endOffset: 20};

  it('returns 429 without reading the body or saving', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/annotations', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'annotations:127.0.0.1', maxPerMinute: 30}]);
    assert.deepEqual([reads, ctx.calls.saveJSON.length], [0, 0]);
  });

  const MISSING = 'Missing required fields: page, text, startOffset, endOffset';
  const GUARDS = [
    {name: 'an omitted page', body: {...OK, page: undefined}, error: MISSING},
    {name: 'an omitted text', body: {...OK, text: undefined}, error: MISSING},
    {name: 'an omitted startOffset', body: {...OK, startOffset: undefined}, error: MISSING},
    {name: 'an omitted endOffset', body: {...OK, endOffset: undefined}, error: MISSING},
    {name: 'a page over 500 characters', body: {...OK, page: 'p'.repeat(501)}, error: 'Page must be 500 characters or fewer'},
    {name: 'text over 5000 characters', body: {...OK, text: 't'.repeat(5001)}, error: 'Text must be 5000 characters or fewer'},
    {name: 'a note over 5000 characters', body: {...OK, note: 'n'.repeat(5001)}, error: 'Note must be 5000 characters or fewer'},
    {name: 'an author over 100 characters', body: {...OK, author: 'a'.repeat(101)}, error: 'Author must be 100 characters or fewer'},
    ...PROTO_KEYS.map(page => ({name: `the proto page ${JSON.stringify(page)}`, body: {...OK, page}, error: 'Invalid page'})),
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/annotations', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  // The presence check is `== null`, so a zero offset counts as supplied.
  it('accepts zero offsets', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/annotations', body: {...OK, startOffset: 0, endOffset: 0}});
    assert.equal(r.status, 201);
  });

  it('stores the annotation and saves once', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/annotations', body: {...OK, note: 'my note', author: 'Ada'}, ctx});
    assert.equal(r.status, 201);
    const {id, createdAt, ...stable} = r.payload.annotation;
    assert.deepEqual(stable, {text: 'selected', note: 'my note', startOffset: 10, endOffset: 20, author: 'Ada'});
    assert.match(id, /^ann_\d+_[a-z0-9]+$/);
    assert.equal(ctx.calls.saveJSON.length, 1);
  });

  it('defaults an omitted note to empty and author to Anonymous', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/annotations', body: OK});
    assert.equal(r.payload.annotation.note, '');
    assert.equal(r.payload.annotation.author, 'Anonymous');
  });

  for (const page of INHERITED_KEYS) {
    it(`stores the inherited page ${JSON.stringify(page)} as an own key`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/annotations', body: {...OK, page}, ctx});
      assert.equal(r.status, 201);
      assert.ok(Object.hasOwn(ctx.store[ANNOTATIONS_FILE], page));
    });
  }
});

describe('DELETE /api/annotations', () => {
  const withPage = () => ({[ANNOTATIONS_FILE]: {'/p': [{id: 'a1'}, {id: 'a2'}]}});

  const GUARDS = [
    {name: 'an omitted page', body: {id: 'a1'}},
    {name: 'an omitted id', body: {page: '/p'}},
    {name: 'an empty-string page', body: {page: '', id: 'a1'}},
    {name: 'an empty-string id', body: {page: '/p', id: ''}},
  ];
  for (const {name, body} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const ctx = makeCtx({store: withPage()});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/annotations', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing page or id'}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  for (const page of [...INHERITED_KEYS, '/absent']) {
    it(`returns 404 for the non-own page ${JSON.stringify(page)}`, async () => {
      const ctx = makeCtx({store: withPage()});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/annotations', body: {page, id: 'a1'}, ctx});
      assert.deepEqual([r.status, r.payload], [404, {error: 'Page not found'}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 404 for an id that matches nothing, leaving the page untouched', async () => {
    const ctx = makeCtx({store: withPage()});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/annotations', body: {page: '/p', id: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Annotation not found'}]);
    assert.deepEqual(ctx.store[ANNOTATIONS_FILE]['/p'].map(a => a.id), ['a1', 'a2']);
  });

  it('removes the matching annotation, preserving its siblings', async () => {
    const ctx = makeCtx({store: withPage()});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/annotations', body: {page: '/p', id: 'a1'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[ANNOTATIONS_FILE]['/p'].map(a => a.id), ['a2']);
    assert.equal(ctx.calls.saveJSON.length, 1);
  });
});

// ── Duplicates and orphans ────────────────────────────────────────────────

describe('GET /api/analytics/duplicates', () => {
  const w = (from, to) => Array.from({length: to - from}, (_, i) => `word${from + i}`).join(' ');
  const TREE = {
    // one and two agree on words 0-19 and diverge after, so the pair's score
    // depends on the full hundred-word fingerprint window.
    [at('content/one.md')]: `${w(0, 20)} ${w(20, 40)}`,
    [at('content/two.md')]: `${w(0, 20)} ${w(40, 60)}`,
    // three is a near-exact copy of one, so it scores higher than the pair above.
    [at('content/three.md')]: `${w(0, 20)} ${w(20, 39)} extra`,
    [at('content/short.md')]: 'too short',
    [at('content/other.md')]: Array.from({length: 40}, (_, i) => `alt${i}`).join(' '),
  };

  it('pairs files above the similarity threshold, sorted descending', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/analytics/duplicates', ctx});
    assert.equal(r.status, 200);
    const pairs = r.payload.duplicates.map(d => [d.file1, d.file2]);
    assert.deepEqual(pairs, [['content/one.md', 'content/three.md']]);
    const sims = r.payload.duplicates.map(d => d.similarity);
    assert.deepEqual(sims, [...sims].sort((a, b) => b - a));
  });

  it('orders multiple qualifying pairs by descending similarity', async () => {
    const {ctx} = fsCtx({
      [at('content/base.md')]: w(0, 40),
      [at('content/near.md')]: `${w(0, 38)} x y`,
      [at('content/mid.md')]: `${w(0, 30)} ${w(100, 110)}`,
    });
    const r = await invoke(routes, {path: '/api/analytics/duplicates', ctx});
    const sims = r.payload.duplicates.map(d => d.similarity);
    assert.ok(sims.length >= 2, 'the fixture yields more than one qualifying pair');
    assert.deepEqual(sims, [...sims].sort((a, b) => b - a));
  });

  it('excludes a pair whose similarity sits between 0.1 and the 0.5 threshold', async () => {
    const {ctx} = fsCtx({
      [at('content/a.md')]: w(0, 40),
      // Ten shared words out of a seventy-word union is about 0.14.
      [at('content/b.md')]: `${w(0, 10)} ${w(100, 140)}`,
    });
    const r = await invoke(routes, {path: '/api/analytics/duplicates', ctx});
    assert.deepEqual(r.payload.duplicates, []);
  });

  it('skips a file whose fingerprint is under five words', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: 'one two', [at('content/b.md')]: 'one two'});
    const r = await invoke(routes, {path: '/api/analytics/duplicates', ctx});
    assert.deepEqual(r.payload.duplicates, []);
  });

  it('excludes a wholly disjoint file', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/analytics/duplicates', ctx});
    assert.equal(r.payload.duplicates.some(d => d.file1 === 'content/other.md' || d.file2 === 'content/other.md'), false);
  });

  it('memoizes under "analytics:duplicates" with a 60000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx(TREE, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    const first = await invoke(routes, {path: '/api/analytics/duplicates', ctx});
    assert.deepEqual(seen, ['analytics:duplicates', 60000]);
    const after = counts.readdir;
    const second = await invoke(routes, {path: '/api/analytics/duplicates', ctx});
    assert.equal(counts.readdir, after);
    assert.deepEqual(second.payload, first.payload);
  });

  it('returns 500 without caching when the scan throws', async () => {
    const ctx = makeCtx({fs: {existsSync: () => true, readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/analytics/duplicates', ctx});
    assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Duplicate scan failed'}, opts: undefined}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

describe('GET /api/analytics/orphans', () => {
  const TREE = {
    [at('content/hub.md')]: 'links [[linked]] and [text](./mdlinked.md) and [ext](https://x) and [anchor](#a)',
    [at('content/linked.md')]: 'reachable by wiki link',
    [at('content/mdlinked.md')]: 'reachable by markdown link',
    [at('content/sidebarred.md')]: fm({sidebar_position: 1}, 'reachable via the sidebar'),
    [at('content/docs/math/algebra.md')]: 'reachable only by its docs-stripped form',
    [at('content/index.md')]: 'navigational, always skipped',
    [at('content/README.md')]: 'navigational, always skipped',
    [at('content/lonely.md')]: 'nothing links here at all',
    // [[math/algebra]] matches neither the basename nor the full docs/ path,
    // only the docs-stripped form.
    [at('content/hub2.md')]: 'links [[math/algebra]]',
  };

  it('lists only the unreachable pages, ascending by path', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/analytics/orphans', ctx});
    assert.equal(r.status, 200);
    const paths = r.payload.orphans.map(o => o.path);
    assert.ok(paths.includes('content/lonely.md'));
    for (const reachable of ['content/linked.md', 'content/mdlinked.md', 'content/sidebarred.md', 'content/docs/math/algebra.md']) {
      assert.equal(paths.includes(reachable), false, reachable);
    }
    // index and readme are navigational and skipped regardless.
    assert.equal(paths.includes('content/index.md'), false);
    assert.equal(paths.includes('content/README.md'), false);
    assert.deepEqual(paths, [...paths].sort());
  });

  // Every link target is recorded in both its original and its lower-cased
  // form, so a case-mismatched link is matched only by the lower-cased operand
  // of each reachability test.
  it('matches a case-mismatched link through the lower-cased comparisons', async () => {
    const {ctx} = fsCtx({
      [at('content/docs/Math/Algebra.md')]: 'reachable only case-insensitively',
      [at('content/MixedCase.md')]: 'reachable only case-insensitively',
      [at('content/hub.md')]: 'links [[MATH/ALGEBRA]] and [[MIXEDCASE]]',
      [at('content/lonely.md')]: 'nothing links here',
    });
    const r = await invoke(routes, {path: '/api/analytics/orphans', ctx});
    // hub.md itself is unlinked, so it is an orphan alongside lonely.md; the
    // point is that neither case-mismatched target is.
    assert.deepEqual(r.payload.orphans.map(o => o.path), ['content/hub.md', 'content/lonely.md']);
  });

  it('reports a word count for each orphan', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/analytics/orphans', ctx});
    const lonely = r.payload.orphans.find(o => o.path === 'content/lonely.md');
    assert.deepEqual([lonely.name, lonely.wordCount], ['lonely.md', 5]);
  });

  it('memoizes under "analytics:orphans" with a 60000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx(TREE, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    const first = await invoke(routes, {path: '/api/analytics/orphans', ctx});
    assert.deepEqual(seen, ['analytics:orphans', 60000]);
    const after = counts.readdir;
    const second = await invoke(routes, {path: '/api/analytics/orphans', ctx});
    assert.equal(counts.readdir, after);
    assert.deepEqual(second.payload, first.payload);
  });

  it('returns 500 without caching when the scan throws', async () => {
    const ctx = makeCtx({fs: {existsSync: () => true, readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/analytics/orphans', ctx});
    assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Orphan scan failed'}, opts: undefined}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

// ── Single-document lint ──────────────────────────────────────────────────

describe('POST /api/lint', () => {
  const lint = async (content, over = {}) => {
    const r = await invoke(routes, {method: 'POST', path: '/api/lint', body: {content}, ctx: makeCtx(over)});
    return r.payload.issues;
  };

  it('returns 429 without reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/lint', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'lint:127.0.0.1', maxPerMinute: 60}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'a non-string content', body: {content: 7}, error: 'Content must be a string'},
    {name: 'an omitted content', body: {}, error: 'Content must be a string'},
    {name: 'content over 50000 characters', body: {content: 'x'.repeat(50001)}, error: 'Content must be 50000 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/lint', body});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
    });
  }

  it('reports no issues for a clean document', async () => {
    assert.deepEqual(await lint('---\ntitle: Clean\n---\n\n# Heading\n\nBody text.\n'), []);
  });

  it('flags frontmatter with no title field', async () => {
    const issues = await lint('---\ndate: 2026-01-01\n---\n\n# H\n\ntext\n');
    assert.deepEqual(issues[0], {line: 1, column: 1, message: 'Frontmatter is missing a title field', severity: 'warning'});
  });

  it('reports a duplicate heading pointing at the first occurrence', async () => {
    const issues = await lint('# Same\n\ntext\n\n# Same\n\nmore\n');
    assert.ok(issues.some(i => i.message === 'Duplicate heading: "Same" (first at line 1)' && i.line === 5));
  });

  it('flags every relative image on a line but not absolute or http ones', async () => {
    const issues = await lint('![a](rel/one.png) and ![b](rel/two.png)\n![c](/abs.png) ![d](https://x/e.png)\n');
    const broken = issues.filter(i => i.message.startsWith('Possibly broken image reference'));
    assert.equal(broken.length, 2);
    assert.deepEqual(broken.map(i => i.line), [1, 1]);
    assert.ok(broken[0].column < broken[1].column, 'the columns are the two match offsets');
  });

  it('requires the leading bang, so a plain markdown link is not an image', async () => {
    const issues = await lint('[text](rel/one.md)\n');
    assert.equal(issues.some(i => i.message.startsWith('Possibly broken image reference')), false);
  });

  it('flags every missing-alt image on a line', async () => {
    const issues = await lint('![](/a.png) and ![](/b.png)\n');
    const alt = issues.filter(i => i.message === 'Image is missing alt text');
    assert.equal(alt.length, 2);
  });

  it('reports an unclosed code block at the opening fence', async () => {
    const issues = await lint('text\n\n```js\ncode\n');
    assert.ok(issues.some(i => i.severity === 'error' && i.line === 3 && i.message === 'Unclosed code block (odd number of ``` fences)'));
  });

  it('flags a very long line but skips URL-only, link-only and fenced lines', async () => {
    const long = 'x'.repeat(250);
    const url = `https://example.com/${'y'.repeat(230)}`;
    const link = `[t](https://example.com/${'z'.repeat(230)})`;
    const issues = await lint(`${long}\n${url}\n${link}\n\`\`\`\n${long}\n\`\`\`\n`);
    const tooLong = issues.filter(i => i.message.includes('exceeds 200 char limit'));
    assert.equal(tooLong.length, 1);
    assert.deepEqual([tooLong[0].line, tooLong[0].column], [1, 201]);
    assert.equal(tooLong[0].message, `Line is ${long.length} characters long (exceeds 200 char limit)`);
  });

  it('reports an empty section when a heading is followed straight by another', async () => {
    const issues = await lint('# One\n## Two\n\ntext\n');
    const empty = issues.filter(i => i.message.startsWith('Empty section'));
    assert.deepEqual(empty.map(i => i.line), [1]);
  });

  it('produces identical output on two back-to-back requests', async () => {
    const doc = '![a](rel/one.png) ![](rel/two.png)\n# H\n# H\n';
    assert.deepEqual(await lint(doc), await lint(doc));
  });
});

describe('exported lint regexes', () => {
  const CANONICAL = {
    LINT_FM_TITLE_RE: /^title\s*:/m,
    LINT_HEADING_RE: /^(#{1,6})\s+(.+)$/,
    LINT_HTTP_PREFIX_RE: /^https?:\/\//,
    LINT_FENCE_RE: /^```/,
    LINT_URL_ONLY_RE: /^\s*https?:\/\/\S+\s*$/,
    LINT_LINK_ONLY_RE: /^\s*\[.*\]\(https?:\/\/\S+\)\s*$/,
    LINT_HEADING_PREFIX_RE: /^#{1,6}\s+/,
  };
  for (const [name, canonical] of Object.entries(CANONICAL)) {
    it(`${name} matches its canonical literal, holds no lastIndex and is one instance`, () => {
      const re = routes[name];
      assert.equal(re.source, canonical.source, name);
      assert.equal(re.flags, canonical.flags, name);
      assert.equal(re.global, false, name);
      assert.equal(re.sticky, false, name);
      assert.strictEqual(loadRoute('analysis-admin')[name], re, name);
    });
  }

  it('keeps the image regexes internal to the module', () => {
    assert.equal(routes.LINT_IMG_RE, undefined);
    assert.equal(routes.LINT_ALT_RE, undefined);
  });
});

// ── Tags ──────────────────────────────────────────────────────────────────

describe('GET /api/tags', () => {
  it('counts inline tag arrays, stripping quotes and sorting descending', async () => {
    const {ctx} = fsCtx({
      [at('content/a.md')]: fm({tags: `['alpha', "beta"]`}, 'x'),
      [at('content/b.md')]: fm({tags: '[alpha]'}, 'x'),
      // A multi-line YAML list is not the inline array form and is ignored.
      [at('content/c.md')]: '---\ntags:\n  - gamma\n---\n\nx',
      [at('content/_skip.md')]: fm({tags: '[skipped]'}, 'x'),
    });
    const r = await invoke(routes, {path: '/api/tags', ctx});
    assert.deepEqual(r.payload.tags, [{tag: 'alpha', count: 2}, {tag: 'beta', count: 1}]);
  });

  it('memoizes under "all-tags" with a 30000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx({[at('content/a.md')]: fm({tags: '[x]'}, 'y')}, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/tags', ctx});
    assert.deepEqual(seen, ['all-tags', 30000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/tags', ctx});
    assert.equal(counts.readdir, after);
  });

  it('returns 500 without caching when the walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/tags', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Failed to list tags'}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

// ── Citation network ──────────────────────────────────────────────────────

describe('GET /api/references/network', () => {
  const REFS = {a: {title: 'A'}, b: {title: 'B'}, c: {title: 'C'}, unused: {title: 'Unused'}};

  it('counts total, cited and uncited references and ranks the most cited', async () => {
    const {ctx} = fsCtx({
      [BIB]: bib(REFS),
      [at('content/p1.md')]: 'cites [@a; @b]',
      [at('content/p2.md')]: 'cites [@a] and [@unknown]',
    });
    const r = await invoke(routes, {path: '/api/references/network', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual([r.payload.totalReferences, r.payload.citedReferences, r.payload.uncitedReferences], [4, 2, 2]);
    assert.deepEqual(r.payload.mostCited.map(m => [m.key, m.count]), [['a', 2], ['b', 1]]);
    assert.equal(r.payload.mostCited[0].title, 'A');
  });

  it('reports every reference uncited when nothing cites anything', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS), [at('content/p.md')]: 'no citations'});
    const r = await invoke(routes, {path: '/api/references/network', ctx});
    assert.deepEqual([r.payload.citedReferences, r.payload.uncitedReferences], [0, 4]);
  });

  it('reports zero uncited when every reference is cited', async () => {
    const {ctx} = fsCtx({[BIB]: bib({a: {title: 'A'}, b: {title: 'B'}}), [at('content/p.md')]: '[@a] [@b]'});
    const r = await invoke(routes, {path: '/api/references/network', ctx});
    assert.deepEqual([r.payload.totalReferences, r.payload.citedReferences, r.payload.uncitedReferences], [2, 2, 0]);
  });

  // A co-citation only counts when the pair appears together on more than one page.
  it('reports co-citations above a single co-occurrence', async () => {
    const {ctx} = fsCtx({
      [BIB]: bib(REFS),
      [at('content/p1.md')]: '[@a; @b]',
      [at('content/p2.md')]: '[@a; @b]',
      [at('content/p3.md')]: '[@a; @c]',
    });
    const r = await invoke(routes, {path: '/api/references/network', ctx});
    assert.deepEqual(r.payload.coCitations, [{papers: ['a', 'b'], coOccurrences: 2}]);
  });

  it('returns 500 for a broken or missing bibliography', async () => {
    for (const files of [{[BIB]: '\tnot: [valid'}, {}]) {
      const {ctx} = fsCtx(files);
      const r = await invoke(routes, {path: '/api/references/network', ctx});
      assert.deepEqual([r.status, r.payload], [500, {error: 'Citation network analysis failed'}]);
    }
  });

  it('returns an empty network for a valid but empty bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: '', [at('content/p.md')]: '[@a]'});
    const r = await invoke(routes, {path: '/api/references/network', ctx});
    assert.deepEqual([r.payload.totalReferences, r.payload.mostCited], [0, []]);
  });

  it('memoizes the parse across two requests', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS), [at('content/p.md')]: '[@a]'});
    await invoke(routes, {path: '/api/references/network', ctx});
    const after = counts.read;
    await invoke(routes, {path: '/api/references/network', ctx});
    assert.equal(counts.read, after);
  });
});

// ── Corpus lint ───────────────────────────────────────────────────────────

describe('GET /api/content-lint', () => {
  it('reports per-file issues with totals and severity tallies', async () => {
    const {ctx} = fsCtx({
      [at('content/nofm.md')]: 'no front matter\n',
      [at('content/notitle.md')]: fm({date: '2026-01-01'}, 'text\n'),
      [at('content/emptyheading.md')]: fm({title: 'T'}, '###\n'),
      [at('content/unclosed.md')]: fm({title: 'T'}, '```\nstill open\n'),
      [at('content/clean.md')]: fm({title: 'T'}, 'all good\n'),
      [at('content/_skip.md')]: 'no front matter\n',
    });
    const r = await invoke(routes, {path: '/api/content-lint', ctx});
    assert.equal(r.status, 200);
    const byPath = Object.fromEntries(r.payload.files.map(f => [f.path, f.issues.map(i => i.message)]));
    assert.deepEqual(byPath['content/nofm.md'], ['Missing frontmatter']);
    assert.deepEqual(byPath['content/notitle.md'], ['Missing title']);
    assert.deepEqual(byPath['content/emptyheading.md'], ['Empty heading']);
    assert.deepEqual(byPath['content/unclosed.md'], ['Unclosed code block']);
    assert.equal('content/clean.md' in byPath, false, 'a clean file is omitted entirely');
    assert.equal('content/_skip.md' in byPath, false);
    assert.equal(r.payload.totalIssues, 4);
    assert.deepEqual(r.payload.severityCounts, {error: 1, warning: 3, info: 0});
  });

  it('does not lint a heading inside a closed code block', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: fm({title: 'T'}, '```\n###\n```\n')});
    const r = await invoke(routes, {path: '/api/content-lint', ctx});
    assert.deepEqual(r.payload.files, []);
  });

  it('memoizes under "content-lint" with a 60000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx({[at('content/a.md')]: 'no fm\n'}, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/content-lint', ctx});
    assert.deepEqual(seen, ['content-lint', 60000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/content-lint', ctx});
    assert.equal(counts.readdir, after);
  });

  it('returns 500 without caching when the walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/content-lint', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Content lint failed'}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

// ── Reference timeline ────────────────────────────────────────────────────

describe('GET /api/references/timeline', () => {
  it('groups by ascending year, skipping undated entries and capping each year at five', async () => {
    const refs = {
      old: {title: 'Old', year: 2000, venue: 'V', author: ['A', 'B', 'C', 'D']},
      undated: {title: 'Undated'},
    };
    for (let i = 0; i < 7; i++) refs[`n${i}`] = {title: `N${i}`, year: 2024};
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/timeline', ctx});
    assert.deepEqual(r.payload.timeline.map(y => y.year), [2000, 2024]);
    assert.equal(r.payload.totalYears, 2);
    const [first, second] = r.payload.timeline;
    assert.deepEqual(first.papers, [{key: 'old', title: 'Old', venue: 'V', authors: ['A', 'B', 'C']}]);
    assert.equal(second.count, 7, 'count reports the full year total');
    assert.equal(second.papers.length, 5, 'while the list is capped at five');
  });

  it('memoizes under "references-timeline" with a 60000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx({[BIB]: bib({a: {title: 'A', year: 2020}})}, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/references/timeline', ctx});
    assert.deepEqual(seen, ['references-timeline', 60000]);
    const after = counts.read;
    await invoke(routes, {path: '/api/references/timeline', ctx});
    assert.equal(counts.read, after);
  });

  it('returns 500 without caching for a broken or missing bibliography', async () => {
    for (const files of [{[BIB]: '\tnot: [valid'}, {}]) {
      const {ctx} = fsCtx(files);
      const r = await invoke(routes, {path: '/api/references/timeline', ctx});
      assert.deepEqual([r.status, r.payload], [500, {error: 'Timeline failed'}]);
      assert.deepEqual(Object.keys(ctx.cache), []);
    }
  });

  it('returns an empty timeline for a valid but empty bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {path: '/api/references/timeline', ctx});
    assert.deepEqual(r.payload, {timeline: [], totalYears: 0});
  });
});

// ── Word cloud ────────────────────────────────────────────────────────────

describe('GET /api/content-wordcloud', () => {
  it('filters short and stop words, ranks descending and normalises the weight', async () => {
    const {ctx} = fsCtx({
      [at('content/a.md')]: 'quantum quantum quantum entanglement entanglement because function the and but cat',
      [at('content/_skip.md')]: 'quantum quantum quantum quantum quantum',
    });
    const r = await invoke(routes, {path: '/api/content-wordcloud', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.words, [
      {word: 'quantum', count: 3, weight: 1},
      {word: 'entanglement', count: 2, weight: 0.67},
    ]);
    // "because" and "function" are stop words longer than the four-character
    // floor, so they prove the stoplist is doing work the length filter cannot;
    // "the", "and", "but" and "cat" are dropped by the length filter alone.
    assert.equal(r.payload.total, 2);
  });

  it('returns an empty list when no token passes the filter', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: 'the and but cat dog because function'});
    const r = await invoke(routes, {path: '/api/content-wordcloud', ctx});
    assert.deepEqual(r.payload, {words: [], total: 0});
  });

  it('caps the list at one hundred entries', async () => {
    const words = Array.from({length: 120}, (_, i) => 'w' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)) + 'zz');
    const body = words.map((w, i) => Array(i + 1).fill(w).join(' ')).join(' ');
    const {ctx} = fsCtx({[at('content/a.md')]: body});
    const r = await invoke(routes, {path: '/api/content-wordcloud', ctx});
    assert.equal(r.payload.words.length, 100);
  });

  it('memoizes under "wordcloud" with a 60000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx({[at('content/a.md')]: 'quantum quantum'}, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/content-wordcloud', ctx});
    assert.deepEqual(seen, ['wordcloud', 60000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/content-wordcloud', ctx});
    assert.equal(counts.readdir, after);
  });

  it('returns 500 without caching when the walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/content-wordcloud', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Word cloud failed'}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

// ── Dashboard ─────────────────────────────────────────────────────────────

describe('GET /api/dashboard', () => {
  const TREE = {
    [at('content/a.md')]: 'one two three',
    [at('content/sub/b.md')]: 'four five',
    [at('content/.hidden.md')]: 'ignored',
    [at('content/notes.txt')]: 'ignored',
    [BIB]: bib({r1: {title: 'R1'}, r2: {title: 'R2'}}),
    [at('var/data/comments.json')]: '{}',
    [at('tests/one.test.mjs')]: "it('a', () => {}); it('b', () => {}); test('c', () => {});",
  };
  const STORE = {
    [ANALYTICS_FILE]: {counts: {'/a': 3, '/b': 4}},
    [COMMENTS_FILE]: {'/p': [{}, {}], bad: 'not-an-array'},
    [DISCUSSIONS_FILE]: {channels: {g: {}, h: {}}, messages: {g: [{}, {}, {}], bad: 'not-an-array'}},
  };
  const DIAG = {startupMs: 42, memoryAtStartupMB: 7, totalHandlers: 200, uniqueRoutes: 190, duplicateCount: 3};

  it('assembles the five deterministic sub-objects', async () => {
    const {ctx} = fsCtx(TREE, {store: STORE, _routeDiagnostics: DIAG});
    const r = await invoke(routes, {path: '/api/dashboard', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.content, {totalFiles: 2, totalWords: 5, references: 2});
    assert.deepEqual(r.payload.activity, {
      recentPageviews: 7,
      recentComments: 2,
      recentDiscussions: {channels: 2, messages: 3},
    });
    assert.deepEqual(r.payload.tests, {lastRun: null, suites: 1, totalTests: 3});
    assert.deepEqual(r.payload.endpoints, {total: 200, unique: 190});
    // cacheEntries is read inside the memo closure, before cached() stores this
    // very entry, so a cold cache reports zero.
    assert.deepEqual(r.payload.health, {integrity: 'healthy', duplicates: 3, cacheEntries: 0});
    // server and generatedAt are clock and process derived, so only their shape
    // is pinned.
    assert.deepEqual(Object.keys(r.payload.server).sort(), ['memory', 'startup', 'uptime']);
    assert.deepEqual(r.payload.server.startup.durationMs, 42);
    assert.equal(typeof r.payload.generatedAt, 'string');
  });

  it('nulls the startup diagnostics when they are absent', async () => {
    const {ctx} = fsCtx(TREE, {store: STORE, _routeDiagnostics: {}});
    const r = await invoke(routes, {path: '/api/dashboard', ctx});
    assert.deepEqual(r.payload.server.startup.durationMs, null);
    assert.deepEqual(r.payload.server.startup.memoryAtStartupMB, null);
    assert.deepEqual(r.payload.endpoints, {total: 0, unique: 0});
    assert.equal(r.payload.health.duplicates, 0);
  });

  it('reports zero references for a broken or missing bibliography, still returning 200', async () => {
    for (const bibFile of [{[BIB]: '\tnot: [valid'}, {}]) {
      const files = {...TREE};
      delete files[BIB];
      const {ctx} = fsCtx({...files, ...bibFile}, {store: STORE, _routeDiagnostics: DIAG});
      const r = await invoke(routes, {path: '/api/dashboard', ctx});
      assert.equal(r.status, 200);
      assert.equal(r.payload.content.references, 0);
    }
  });

  it('flags the integrity check when a data JSON file is corrupt', async () => {
    const {ctx} = fsCtx({...TREE, [at('var/data/broken.json')]: '{not json'}, {store: STORE, _routeDiagnostics: DIAG});
    const r = await invoke(routes, {path: '/api/dashboard', ctx});
    assert.equal(r.payload.health.integrity, 'issues');
  });

  it('flags the integrity check when the bibliography is corrupt', async () => {
    const files = {...TREE, [BIB]: '\tnot: [valid'};
    const {ctx} = fsCtx(files, {store: STORE, _routeDiagnostics: DIAG});
    const r = await invoke(routes, {path: '/api/dashboard', ctx});
    assert.equal(r.payload.health.integrity, 'issues');
  });

  it('memoizes under "api-dashboard" with a 30000 ms TTL', async () => {
    let seen;
    const {ctx} = fsCtx(TREE, {store: STORE, _routeDiagnostics: DIAG, cached: (k, t, fn) => { seen = [k, t]; return fn(); }});
    await invoke(routes, {path: '/api/dashboard', ctx});
    assert.deepEqual(seen, ['api-dashboard', 30000]);
  });

  it('returns 500 when the assembly throws', async () => {
    const ctx = makeCtx({cached() { throw new Error('boom'); }});
    const r = await invoke(routes, {path: '/api/dashboard', ctx});
    assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Dashboard failed'}, opts: undefined}]);
    assert.equal(r.replies.some(x => x.payload && 'content' in x.payload), false);
  });
});

// Each body-reading handler wraps the read in one try whose catch returns a
// fixed 400 ahead of the first inner guard.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/streak'},
    {method: 'POST', path: '/api/files/bulk'},
    {method: 'POST', path: '/api/annotations'},
    {method: 'DELETE', path: '/api/annotations'},
    {method: 'POST', path: '/api/lint'},
  ];
  for (const {method, path: p} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns 400 Invalid request when ${label}, touching no store`, async () => {
        const ctx = makeCtx({readBody, fs: mockFs()});
        const r = await invoke(routes, {method, path: p, ctx});
        assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
        assert.deepEqual(ctx.calls.saveJSON, []);
      });
    }
  }
});
