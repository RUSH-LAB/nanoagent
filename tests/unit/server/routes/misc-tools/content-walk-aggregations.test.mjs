import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module the way the sibling route tests
// do (mirrors tests/next-statsdir-cache.test.mjs and
// tests/next-whiteboard-write-ownprop-guard.test.mjs).
const require = createRequire(import.meta.url);
// This suite spans two modules since /api/stats/* moved to its own. Dispatch
// through both, stopping once one has replied, exactly as server/index.js does.
const misc_tools_routes = require('../../../../../server/routes/misc-tools.js');
const stats_routes = require('../../../../../server/routes/stats.js');
const routes = async (req, res, url, pathname, ctx) => {
  await misc_tools_routes(req, res, url, pathname, ctx);
  if (!res.writableEnded) await stats_routes(req, res, url, pathname, ctx);
};

// These three GET handlers each wrap a recursive content walk in
// cached(key, ttl, fn) and touch the filesystem only through ctx.fs. A mocked fs
// plus a pass-through cached pins their behavior over a controlled in-memory tree
// with no real filesystem, network, or git:
//   GET /api/content-freshness   age scoring and freshness buckets
//   GET /api/content-duplicates  case-insensitive title grouping
//   GET /api/stats/timeline      month bucketing from a frontmatter date or mtime
// This is an ADD-ONLY characterization test: it pins the current, correct behavior
// so a future refactor cannot silently change it. No source file is touched.

const PROJECT_ROOT = '/virtual-root';
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');
const ALLOWED_EXTS = ['.md', '.mdx'];
const DAY = 86400000;

// Wrap file content with an explicit stat so a fixture can drive statSync
// (freshness reads mtimeMs and mtime; the timeline fallback reads mtime). A plain
// string leaf is shorthand for a file whose stat is never inspected.
function file(content, stat) {
  return { __file: true, content, stat: stat || {} };
}

// Build a mock fs from a nested tree rooted at rootPath, mirroring the in-memory
// tree builder in tests/next-statsdir-cache.test.mjs and extending it with
// statSync. A leaf is a file when it is a string or a file() wrapper; any other
// object is a directory. Listing order follows object insertion order, keeping the
// walk deterministic without depending on a platform fs ordering.
function buildMockFs(rootPath, tree) {
  const dirEntries = new Map();  // fullPath -> [{ name, isDir }]
  const fileContent = new Map(); // fullPath -> string
  const fileStat = new Map();    // fullPath -> { mtimeMs, mtime }
  (function walk(prefix, node) {
    const entries = [];
    for (const [name, value] of Object.entries(node)) {
      const full = path.join(prefix, name);
      if (typeof value === 'string') {
        fileContent.set(full, value);
        fileStat.set(full, {});
        entries.push({ name, isDir: false });
      } else if (value && value.__file) {
        fileContent.set(full, value.content);
        fileStat.set(full, value.stat);
        entries.push({ name, isDir: false });
      } else {
        entries.push({ name, isDir: true });
        walk(full, value);
      }
    }
    dirEntries.set(prefix, entries);
  })(rootPath, tree);

  return {
    readdirSync(dir) {
      const entries = dirEntries.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return entries.map(({ name, isDir }) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContent.has(fp)) return fileContent.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    statSync(fp) {
      if (fileStat.has(fp)) return fileStat.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// An fs whose very first readdirSync (the content root) throws. The throw escapes
// the per-file try/catch each handler wraps a single file in and reaches the outer
// catch, exercising the 500 path. A single bad file alone would be swallowed.
const throwingFs = {
  readdirSync() { throw new Error('boom'); },
  readFileSync() { throw new Error('boom'); },
  statSync() { throw new Error('boom'); },
};

// A pass-through cached(key, ttl, fn) that runs fn every call, so each request is
// exercised end to end. TTL caching is not asserted here; the dedicated cache test
// below records {key, ttl} instead.
const passThroughCached = (_key, _ttl, fn) => fn();

// Drive one GET handler and return the captured { status, payload }. fs and cached
// are supplied so a test can use a fixture fs or a recording cached.
async function runHandler(pathname, { fs, cached = passThroughCached }) {
  let captured = null;
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const ctx = {
    fs, path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; res.writableEnded = true; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// One shared wall-clock reference for the age fixtures. The handler reads its own
// clock at call time, a few milliseconds later; that gap is far smaller than a day
// and every chosen age sits well inside its bucket, so the floored day difference
// still equals the chosen whole-day age. lastModified is exact because it derives
// from the same fixed mtime the test computes.
const NOW = Date.now();
function agedFile(content, ageDays) {
  const mtimeMs = NOW - ageDays * DAY;
  return file(content, { mtimeMs, mtime: new Date(mtimeMs) });
}
function isoForAge(ageDays) {
  return new Date(NOW - ageDays * DAY).toISOString();
}

describe('GET /api/content-freshness', () => {
  it('scores freshness buckets, sorts by age descending, tallies counts over all files, and skips hidden, underscore, and non-content files', async () => {
    const fs = buildMockFs(CONTENT_DIR, {
      'fresh-post.md': agedFile('---\ntitle: Fresh Post\n---\nword1 word2 word3', 3),
      'recent-note.mdx': agedFile('one two three four five', 20),
      sub: {
        'aging.md': agedFile('alpha beta', 60),
      },
      'stale.md': agedFile('---\ntitle: "Stale One"\n---\nsolo', 120),
      '_ignored.md': agedFile('underscore prefixed, skipped', 5),
      'notes.txt': agedFile('wrong extension, skipped', 5),
      '.hidden': {
        'secret.md': agedFile('inside a hidden directory, never recursed', 5),
      },
    });

    const { status, payload } = await runHandler('/api/content-freshness', { fs });

    assert.equal(status, 200);
    assert.deepEqual(payload, {
      files: [
        { path: 'content/stale.md', title: 'Stale One', ageDays: 120, wordCount: 6, lastModified: isoForAge(120), freshness: 'stale' },
        { path: 'content/sub/aging.md', title: 'aging', ageDays: 60, wordCount: 2, lastModified: isoForAge(60), freshness: 'aging' },
        { path: 'content/recent-note.mdx', title: 'recent-note', ageDays: 20, wordCount: 5, lastModified: isoForAge(20), freshness: 'recent' },
        { path: 'content/fresh-post.md', title: 'Fresh Post', ageDays: 3, wordCount: 8, lastModified: isoForAge(3), freshness: 'fresh' },
      ],
      counts: { fresh: 1, recent: 1, aging: 1, stale: 1 },
      totalFiles: 4,
    });
  });

  it('caps the files list at 50 while counts and totalFiles cover the full set', async () => {
    const tree = {};
    for (let i = 0; i < 60; i++) {
      tree[`f${i}.md`] = agedFile(`body number ${i}`, 1);
    }
    const fs = buildMockFs(CONTENT_DIR, tree);

    const { status, payload } = await runHandler('/api/content-freshness', { fs });

    assert.equal(status, 200);
    assert.equal(payload.files.length, 50);
    assert.equal(payload.totalFiles, 60);
    assert.deepEqual(payload.counts, { fresh: 60, recent: 0, aging: 0, stale: 0 });
    assert.ok(payload.files.every(f => f.freshness === 'fresh'));
  });

  it('pins the freshness bucket thresholds at the exact 7, 30, and 90 day boundaries', async () => {
    // The bucket rule is ageDays <= 7 ? fresh : <= 30 ? recent : <= 90 ? aging : stale.
    // Probing each boundary and the day past it locks the inclusive <= edges, so a
    // future <= to < flip would change a label and fail this assertion.
    const fs = buildMockFs(CONTENT_DIR, {
      'b07.md': agedFile('seven', 7),
      'b08.md': agedFile('eight', 8),
      'b30.md': agedFile('thirty', 30),
      'b31.md': agedFile('thirty one', 31),
      'b90.md': agedFile('ninety', 90),
      'b91.md': agedFile('ninety one', 91),
    });

    const { status, payload } = await runHandler('/api/content-freshness', { fs });

    assert.equal(status, 200);
    assert.deepEqual(payload.files.map(f => [f.ageDays, f.freshness]), [
      [91, 'stale'],
      [90, 'aging'],
      [31, 'aging'],
      [30, 'recent'],
      [8, 'recent'],
      [7, 'fresh'],
    ]);
    assert.deepEqual(payload.counts, { fresh: 1, recent: 2, aging: 2, stale: 1 });
    assert.equal(payload.totalFiles, 6);
  });

  it('returns 500 when the content scan throws', async () => {
    const { status, payload } = await runHandler('/api/content-freshness', { fs: throwingFs });
    assert.equal(status, 500);
    assert.deepEqual(payload, { error: 'Freshness scoring failed' });
  });
});

describe('GET /api/content-duplicates', () => {
  it('groups files whose titles match case-insensitively, keeping the first title and both paths, and excludes singletons', async () => {
    const fs = buildMockFs(CONTENT_DIR, {
      'intro.md': '---\ntitle: Getting Started\n---\nbody one',
      sub: {
        'start.md': '---\ntitle: getting started\n---\nbody two',
      },
      'unique.md': '---\ntitle: Only One\n---\nbody three',
    });

    const { status, payload } = await runHandler('/api/content-duplicates', { fs });

    assert.equal(status, 200);
    assert.deepEqual(payload, {
      duplicates: [
        { title: 'Getting Started', files: ['content/intro.md', 'content/sub/start.md'] },
      ],
      count: 1,
    });
  });

  it('derives titles from filenames when frontmatter is absent and still groups case-insensitively', async () => {
    const fs = buildMockFs(CONTENT_DIR, {
      'guide.md': 'plain body, no frontmatter',
      'GUIDE.mdx': 'another plain body, no frontmatter',
      'alone.md': 'a singleton body',
    });

    const { status, payload } = await runHandler('/api/content-duplicates', { fs });

    assert.equal(status, 200);
    assert.deepEqual(payload, {
      duplicates: [
        { title: 'guide', files: ['content/guide.md', 'content/GUIDE.mdx'] },
      ],
      count: 1,
    });
  });

  it('returns 500 when the content scan throws', async () => {
    const { status, payload } = await runHandler('/api/content-duplicates', { fs: throwingFs });
    assert.equal(status, 500);
    assert.deepEqual(payload, { error: 'Duplicate detection failed' });
  });
});

describe('GET /api/stats/timeline', () => {
  it('buckets files by frontmatter month in ascending order', async () => {
    const fs = buildMockFs(CONTENT_DIR, {
      'p1.md': '---\ndate: 2026-01-15\n---\nbody',
      'p2.md': '---\ndate: "2026-01-02"\n---\nbody',
      sub: {
        'p3.mdx': '---\ndate: 2026-02-20\n---\nbody',
      },
      'p4.md': '---\ndate: 2026-03\n---\nbody',
    });

    const { status, payload } = await runHandler('/api/stats/timeline', { fs });

    assert.equal(status, 200);
    assert.deepEqual(payload, {
      timeline: [
        { month: '2026-01', count: 2 },
        { month: '2026-02', count: 1 },
        { month: '2026-03', count: 1 },
      ],
    });
  });

  it('falls back to the file mtime month when no frontmatter date is present', async () => {
    const fs = buildMockFs(CONTENT_DIR, {
      'no-fm.md': file('plain text, no frontmatter at all', { mtime: new Date('2024-07-15T10:00:00.000Z') }),
      'fm-no-date.md': file('---\ntitle: Has Title\n---\nbody', { mtime: new Date('2024-07-20T10:00:00.000Z') }),
    });

    const { status, payload } = await runHandler('/api/stats/timeline', { fs });

    assert.equal(status, 200);
    assert.deepEqual(payload, {
      timeline: [
        { month: '2024-07', count: 2 },
      ],
    });
  });

  it('combines frontmatter-dated and mtime-fallback files into one ascending timeline', async () => {
    const fs = buildMockFs(CONTENT_DIR, {
      'dated.md': '---\ndate: 2025-05-10\n---\nbody',
      'undated.md': file('no date in this one', { mtime: new Date('2025-08-01T00:00:00.000Z') }),
    });

    const { status, payload } = await runHandler('/api/stats/timeline', { fs });

    assert.equal(status, 200);
    assert.deepEqual(payload, {
      timeline: [
        { month: '2025-05', count: 1 },
        { month: '2025-08', count: 1 },
      ],
    });
  });

  it('counts a frontmatter-dated file and an mtime-fallback file in the same month together', async () => {
    const fs = buildMockFs(CONTENT_DIR, {
      'with-date.md': '---\ndate: 2025-09-03\n---\nbody',
      'by-mtime.md': file('no frontmatter date in this one', { mtime: new Date('2025-09-28T12:00:00.000Z') }),
    });

    const { status, payload } = await runHandler('/api/stats/timeline', { fs });

    assert.equal(status, 200);
    assert.deepEqual(payload, {
      timeline: [
        { month: '2025-09', count: 2 },
      ],
    });
  });

  it('returns 500 when the content scan throws', async () => {
    const { status, payload } = await runHandler('/api/stats/timeline', { fs: throwingFs });
    assert.equal(status, 500);
    assert.deepEqual(payload, { error: 'Timeline stats failed' });
  });
});

describe('content-walk cache wrapping', () => {
  it('wraps each handler in cached() with its stable key and 60s TTL', async () => {
    const calls = [];
    const recordingCached = (key, ttl, fn) => { calls.push({ key, ttl }); return fn(); };
    const fs = buildMockFs(CONTENT_DIR, {});

    await runHandler('/api/content-freshness', { fs, cached: recordingCached });
    await runHandler('/api/content-duplicates', { fs, cached: recordingCached });
    await runHandler('/api/stats/timeline', { fs, cached: recordingCached });

    assert.deepEqual(calls, [
      { key: 'content-freshness', ttl: 60000 },
      { key: 'content-duplicates', ttl: 60000 },
      { key: 'stats:timeline', ttl: 60000 },
    ]);
  });
});
