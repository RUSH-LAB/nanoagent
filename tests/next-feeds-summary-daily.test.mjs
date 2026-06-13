import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the REAL route module the way the other server
// route tests do, so these cases exercise the shipped GET /api/summary/daily
// handler instead of a reimplementation. No export is added to the source.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Sentinel file-path constants. The handler only uses these as keys handed to
// loadJSON, so any unique strings work; loadJSON dispatches store[f] on them.
const COMMENTS_FILE = 'COMMENTS_FILE';
const DISCUSSIONS_FILE = 'DISCUSSIONS_FILE';
const STREAKS_FILE = 'STREAKS_FILE';
// Sentinel root. Kept absolute so real node:path join/relative behave naturally.
const PROJECT_ROOT = '/project-root';
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');

// CLOCK: the handler reads `today` from the real global clock once per call. We
// do NOT monkey-patch Date; instead we read the same wall-clock day here and
// stamp every mock mtime / createdAt relative to it, so assertions stay exact.
// (Negligible UTC-midnight boundary caveat accepted.)
const today = new Date().toISOString().slice(0, 10);
const todayISO = today + 'T00:00:00.000Z';
const onToday = new Date(today + 'T12:00:00.000Z'); // mtime whose date === today
const offToday = new Date('2000-01-01T12:00:00.000Z'); // clearly not today

// Build a fake fs from an in-memory tree: { [dirPath]: [{name, dir?, mtime?}] }.
// readdirSync returns {name, isDirectory()} Dirent-likes; statSync returns
// {mtime}. No real filesystem is touched. (Per the GOAL we mock fs in-memory
// rather than copying the real-tmpdir setup in next-feeds-cache-scan.test.mjs.)
function makeFs(tree) {
  const statMap = {};
  for (const [dir, entries] of Object.entries(tree)) {
    for (const e of entries) {
      if (!e.dir) statMap[path.join(dir, e.name)] = e.mtime;
    }
  }
  return {
    readdirSync(dir) {
      const entries = tree[dir] || [];
      return entries.map(e => ({ name: e.name, isDirectory: () => Boolean(e.dir) }));
    },
    statSync(fp) {
      return { mtime: statMap[fp] };
    },
  };
}

// Drive the GET /api/summary/daily handler with a fully mocked ctx. The route
// has no request guards and is network-free: it reads three flat-file stores via
// loadJSON and walks content/ via the injected fs. A capturing json() records
// {status, payload} and marks the response ended, mirroring the sibling tests.
async function invoke({ stores = {}, fs } = {}) {
  const pathname = '/api/summary/daily';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    COMMENTS_FILE,
    DISCUSSIONS_FILE,
    STREAKS_FILE,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    path,
    fs,
    loadJSON: (f) => stores[f],
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await feedsRoutes(req, res, url, pathname, ctx);
  return { captured, res };
}

describe('GET /api/summary/daily (current behavior)', () => {
  it('returns the 200 daily-summary shape over a representative mix', async () => {
    const stores = {
      [COMMENTS_FILE]: {
        'docs/a': [
          { createdAt: today + 'T08:00:00.000Z' }, // today -> counted
          { createdAt: '2000-01-01T00:00:00.000Z' }, // old -> not counted
          { text: 'no timestamp' }, // missing createdAt -> not counted
        ],
        'docs/b': [{ createdAt: today + 'T23:00:00.000Z' }], // today -> counted
        notAnArray: { ignored: true }, // non-array page -> skipped
      },
      [DISCUSSIONS_FILE]: {
        messages: {
          t1: [
            { createdAt: today + 'T09:00:00.000Z' }, // today -> counted
            { createdAt: '1999-01-01T00:00:00.000Z' }, // old -> not counted
          ],
          t2: [{ createdAt: today + 'T10:00:00.000Z' }], // today -> counted
          t3: 'not-an-array', // non-array thread -> skipped
        },
      },
      [STREAKS_FILE]: {
        default: {
          dailyLog: [
            { date: '2000-01-01', words: 999 },
            { date: today, words: 1234 },
          ],
        },
      },
    };
    const fs = makeFs({
      [CONTENT_DIR]: [
        { name: 'today1.md', mtime: onToday }, // counted
        { name: 'old.md', mtime: offToday }, // not today -> not counted
        { name: 'today2.mdx', mtime: onToday }, // counted (.mdx allowed)
        { name: 'sub', dir: true }, // recursed
        { name: '.hidden.md', mtime: onToday }, // dot-file -> skipped
        { name: 'image.png', mtime: onToday }, // non-allowed ext -> skipped
      ],
      [path.join(CONTENT_DIR, 'sub')]: [
        { name: 'nested-today.md', mtime: onToday }, // counted
        { name: 'nested-old.md', mtime: offToday }, // not counted
      ],
    });

    const { captured, res } = await invoke({ stores, fs });
    assert.equal(res.writableEnded, true);
    assert.equal(captured.status, 200);
    // Depth-first walk order, with the cap not yet reached.
    const expectedFiles = [
      path.relative(PROJECT_ROOT, path.join(CONTENT_DIR, 'today1.md')),
      path.relative(PROJECT_ROOT, path.join(CONTENT_DIR, 'today2.mdx')),
      path.relative(PROJECT_ROOT, path.join(CONTENT_DIR, 'sub', 'nested-today.md')),
    ];
    assert.deepEqual(captured.payload, {
      date: today,
      filesModifiedToday: 3,
      modifiedFiles: expectedFiles,
      commentsToday: 2,
      messagesToday: 2,
      wordsWrittenToday: 1234,
    });
  });

  it('returns zeros and an empty modifiedFiles for empty stores and empty content', async () => {
    const stores = {
      [COMMENTS_FILE]: {},
      [DISCUSSIONS_FILE]: {}, // .messages absent -> falls back to {}
      [STREAKS_FILE]: {}, // no 'default' -> wordsWrittenToday 0
    };
    const fs = makeFs({ [CONTENT_DIR]: [] });

    const { captured } = await invoke({ stores, fs });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, {
      date: today,
      filesModifiedToday: 0,
      modifiedFiles: [],
      commentsToday: 0,
      messagesToday: 0,
      wordsWrittenToday: 0,
    });
  });

  it('skips dot-files, dot-directories, and non-Markdown files in the content walk', async () => {
    const stores = {
      [COMMENTS_FILE]: {},
      [DISCUSSIONS_FILE]: {},
      [STREAKS_FILE]: {},
    };
    // Every skipped entry is stamped with today's mtime, so only the dot/ext
    // rules (not the date) can explain their absence from the result.
    const fs = makeFs({
      [CONTENT_DIR]: [
        { name: 'keep.md', mtime: onToday }, // the only one that should count
        { name: '.hidden.md', mtime: onToday }, // dot-file -> skipped
        { name: 'notes.txt', mtime: onToday }, // non-allowed ext -> skipped
        { name: 'photo.PNG', mtime: onToday }, // non-allowed ext -> skipped
        { name: '.git', dir: true, mtime: onToday }, // dot-dir -> not recursed
      ],
      // Contents of the dot-dir: would count if it were ever recursed into.
      [path.join(CONTENT_DIR, '.git')]: [{ name: 'secret.md', mtime: onToday }],
    });

    const { captured } = await invoke({ stores, fs });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.filesModifiedToday, 1);
    assert.deepEqual(captured.payload.modifiedFiles, [
      path.relative(PROJECT_ROOT, path.join(CONTENT_DIR, 'keep.md')),
    ]);
  });

  it('caps modifiedFiles at 20 while filesModifiedToday counts every match', async () => {
    const entries = [];
    for (let i = 0; i < 25; i++) {
      entries.push({ name: `f${String(i).padStart(2, '0')}.md`, mtime: onToday });
    }
    const stores = {
      [COMMENTS_FILE]: {},
      [DISCUSSIONS_FILE]: {},
      [STREAKS_FILE]: {},
    };
    const fs = makeFs({ [CONTENT_DIR]: entries });

    const { captured } = await invoke({ stores, fs });
    assert.equal(captured.status, 200);
    // Full count is uncapped; the returned list is sliced to the first 20.
    assert.equal(captured.payload.filesModifiedToday, 25);
    assert.equal(captured.payload.modifiedFiles.length, 20);
    const expectedFirst20 = entries
      .slice(0, 20)
      .map(e => path.relative(PROJECT_ROOT, path.join(CONTENT_DIR, e.name)));
    assert.deepEqual(captured.payload.modifiedFiles, expectedFirst20);
  });

  it('excludes non-array buckets, missing-createdAt and off-day entries, and a default streak with no today log', async () => {
    const stores = {
      [COMMENTS_FILE]: {
        page1: [
          { createdAt: '1990-01-01T00:00:00.000Z' }, // off-day
          { note: 'no createdAt' }, // missing createdAt
        ],
        page2: 'not-an-array', // non-array bucket -> skipped, no throw
      },
      [DISCUSSIONS_FILE]: {
        messages: {
          a: [{ createdAt: '1990-01-01T00:00:00.000Z' }], // off-day
          b: { not: 'an array' }, // non-array thread -> skipped, no throw
        },
      },
      [STREAKS_FILE]: {
        default: { dailyLog: [{ date: '1990-01-01', words: 7 }] }, // no today entry
      },
    };
    const fs = makeFs({ [CONTENT_DIR]: [] });

    const { captured } = await invoke({ stores, fs });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.commentsToday, 0);
    assert.equal(captured.payload.messagesToday, 0);
    assert.equal(captured.payload.wordsWrittenToday, 0);
  });

  it('counts comments and messages whose createdAt equals the start-of-day cutoff (inclusive >=)', async () => {
    // The cutoff is a lexicographic string compare: createdAt >= today + 'T00:00:00.000Z'.
    // An entry exactly at the cutoff must be included, so this drives the handler with
    // createdAt === todayISO and confirms it is counted.
    const stores = {
      [COMMENTS_FILE]: { page: [{ createdAt: todayISO }] }, // exactly at cutoff -> counted
      [DISCUSSIONS_FILE]: { messages: { t: [{ createdAt: todayISO }] } }, // exactly at cutoff -> counted
      [STREAKS_FILE]: {},
    };
    const fs = makeFs({ [CONTENT_DIR]: [] });

    const { captured } = await invoke({ stores, fs });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.commentsToday, 1);
    assert.equal(captured.payload.messagesToday, 1);
  });

  it('returns exactly {error: "Summary failed"} with status 500 when readdirSync throws', async () => {
    const stores = {
      [COMMENTS_FILE]: {},
      [DISCUSSIONS_FILE]: {},
      [STREAKS_FILE]: {},
    };
    const fs = {
      readdirSync() { throw new Error('boom'); },
      statSync() { return { mtime: onToday }; },
    };

    const { captured, res } = await invoke({ stores, fs });
    assert.equal(res.writableEnded, true);
    assert.equal(captured.status, 500);
    assert.deepEqual(captured.payload, { error: 'Summary failed' });
  });
});
