import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the real module the way the sibling
// route tests do (mirrors tests/next-contentc-status-gaps.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/stats.js');

// Add-only characterization suite for GET /api/stats/readability in
// content-analysis-c.js, the last untested route in that module. The handler
// wraps a recursive content scan in cached('readability-trends', 120000, fn),
// reading the filesystem only through ctx.fs, so an in-memory mock fs plus a
// memoizing cached pins its behavior end to end with no real filesystem,
// network, git, clock, or randomness. Every Flesch-Kincaid grade asserted below
// was captured by running this exact handler over these exact fixtures (not
// eyeballed); the literals freeze the CURRENT, correct behavior so a later
// refactor cannot silently change the formula, rounding, bucketing, or sort.
// The suite edits no source.

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs over a plain-object tree (copied from the sibling harness),
// exposing only what the handler uses: readdirSync (returning withFileTypes
// Dirent-likes) and readFileSync. It records the full path list of every readdir
// and every file read, so the cache-hit test can prove the second request never
// re-walks the tree and the skip-rule tests can prove a dot/underscore/non-md
// entry is never recursed into or read. Directory listing order is fixed (object
// insertion order), keeping the scan deterministic without depending on a
// platform-defined fs ordering.
function buildMockFs(rootPath, tree) {
  const dirEntries = new Map(); // fullPath -> [{ name, isDir }]
  const fileContent = new Map(); // fullPath -> string
  (function walk(prefix, node) {
    const entries = [];
    for (const [name, value] of Object.entries(node)) {
      const full = path.join(prefix, name);
      if (typeof value === 'string') {
        fileContent.set(full, value);
        entries.push({ name, isDir: false });
      } else {
        entries.push({ name, isDir: true });
        walk(full, value);
      }
    }
    dirEntries.set(prefix, entries);
  })(rootPath, tree);

  const readPaths = [];
  const readdirPaths = [];
  return {
    readPaths,
    readdirPaths,
    get readdirCalls() { return readdirPaths.length; },
    get readCalls() { return readPaths.length; },
    readdirSync(dir) {
      readdirPaths.push(dir);
      const entries = dirEntries.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return entries.map(({ name, isDir }) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      readPaths.push(fp);
      if (fileContent.has(fp)) return fileContent.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A memoizing cached(key, ttl, fn): runs fn once per key, then serves the stored
// value, modelling the real server cache on a within-TTL hit. It also records
// each (key, ttl) pair so a test can pin that the handler asks for exactly
// cached('readability-trends', 120000). ttl is irrelevant to back-to-back calls,
// so the memoization itself intentionally ignores it.
function buildMemoizingCached() {
  const store = new Map();
  const calls = [];
  const cached = (key, ttl, fn) => {
    calls.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const value = fn();
    store.set(key, value);
    return value;
  };
  cached.calls = calls;
  return cached;
}

// An fs whose every operation throws, used to drive the handler's outer
// try/catch 500 path: the root content walk's readdirSync throws first, the throw
// escapes the cached fn, and it surfaces as a 500.
const throwingFs = {
  readdirSync() { throw new Error('disk failure'); },
  readFileSync() { throw new Error('disk failure'); },
};

// Drive the real GET handler with the minimal ctx it reads, returning the
// captured json() response. fs and cached are supplied by the caller so a pair of
// calls can share one mock fs and one cache (the cache short-circuit test).
async function runHandler(pathname, { fs, cached }) {
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost' + pathname);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── readability fixtures ──────────────────────────────────────────────────
// A content/ tree exercising every branch of the scan. Insertion order is the
// scan order, so the result is deterministic.
//   overview.md          plain body directly in content/  -> bucket 'root'
//   blog/alpha.md        frontmatter stripped before count -> bucket 'blog'
//   blog/beta.md         fenced code + HTML stripped       -> bucket 'blog'
//   blog/deep/gamma.md   nested one level deeper           -> bucket 'blog' (first-level ancestor)
//   blog/tiny.md         only 2 words after strip          -> READ but excluded (< 10 words)
//   blog/notes.txt       disallowed extension              -> never read
//   blog/.hidden/        dot-prefixed directory            -> never recursed
//   blog/_drafts/        underscore-prefixed directory     -> never recursed
//   blog/_ignore.md      underscore-prefixed file          -> never read
//   blog/.dotfile.md     dot-prefixed file                 -> never read
//   docs/delta.md        plain body                        -> bucket 'docs'
//   docs/epsilon.md      two sentences                     -> bucket 'docs'
const READ_TREE = {
  content: {
    'overview.md': 'This is a short overview of the project. It explains the goals and the plan in plain words.',
    blog: {
      'alpha.md': '---\ntitle: Alpha Post\ndate: 2020-01-01\n---\nAlpha introduces the system architecture and describes how the main components communicate with each other reliably.',
      'beta.md': 'Beta covers the data pipeline.\n```js\nconst x = 1;\nfunction noise() { return many fake words here to inflate the count badly; }\n```\nThe pipeline reads files and writes <strong>aggregated</strong> results to disk.',
      deep: {
        'gamma.md': 'Gamma explores nested directory handling within the content tree and verifies recursive scanning works as intended here.',
      },
      'tiny.md': '---\ntitle: Tiny\ndraft: true\n---\nToo short.',
      'notes.txt': 'This text file has plenty of words but a disallowed extension so it must never be read or counted at all.',
      '.hidden': {
        'secret.md': 'Hidden directory file with many words that must never ever appear in any directory bucket or be read.',
      },
      _drafts: {
        'wip.md': 'Work in progress underscore directory file that must never be read or counted in the readability output.',
      },
      '_ignore.md': 'Underscore prefixed file directly in blog that must never be read or counted at all by the scan.',
      '.dotfile.md': 'Dot prefixed file directly in blog that must never be read or counted at all by the scan here.',
    },
    docs: {
      'delta.md': 'Delta documents the configuration options and shows several examples that help new users get started quickly today.',
      'epsilon.md': 'Epsilon summarizes the troubleshooting steps. Each step lists a symptom, a likely cause, and a recommended fix.',
    },
  },
};

// Golden payload for READ_TREE, captured by running this handler over the tree
// above. The blog bucket carries three files (alpha, beta, and the nested gamma);
// docs carries two; root carries the single top-level file. directories is sorted
// by avgGrade ascending: blog has the lowest single-file minGrade (7.8) yet sorts
// last because its AVERAGE (11.6) is the highest, which is what the sort keys on.
const EXPECTED_READABILITY = {
  overallAvgGrade: 9.7,
  totalFiles: 6,
  directories: [
    { directory: 'root', avgGrade: 2.3, fileCount: 1, minGrade: 2.3, maxGrade: 2.3 },
    { directory: 'docs', avgGrade: 10.6, fileCount: 2, minGrade: 7.9, maxGrade: 13.3 },
    { directory: 'blog', avgGrade: 11.6, fileCount: 3, minGrade: 7.8, maxGrade: 14.3 },
  ],
};

// Paths that the skip rules must keep the scan from ever touching.
const NEVER_READ = [
  path.join(PROJECT_ROOT, 'content', 'blog', 'notes.txt'),       // disallowed extension
  path.join(PROJECT_ROOT, 'content', 'blog', '.hidden', 'secret.md'), // inside a dot directory
  path.join(PROJECT_ROOT, 'content', 'blog', '_drafts', 'wip.md'),    // inside an underscore directory
  path.join(PROJECT_ROOT, 'content', 'blog', '_ignore.md'),      // underscore-prefixed file
  path.join(PROJECT_ROOT, 'content', 'blog', '.dotfile.md'),     // dot-prefixed file
];
const NEVER_RECURSED = [
  path.join(PROJECT_ROOT, 'content', 'blog', '.hidden'),
  path.join(PROJECT_ROOT, 'content', 'blog', '_drafts'),
];
const TINY_PATH = path.join(PROJECT_ROOT, 'content', 'blog', 'tiny.md');

// A single-file tree whose body is ten one-syllable words split across three very
// short sentences. Its captured grade is negative, pinning that the handler does
// NOT floor a low Flesch-Kincaid grade at zero.
const NEG_TREE = {
  content: {
    simple: {
      'plain.md': 'Cats run fast. Dogs play here. We go now too.',
    },
  },
};
const EXPECTED_NEG = {
  overallAvgGrade: -2.5,
  totalFiles: 1,
  directories: [
    { directory: 'simple', avgGrade: -2.5, fileCount: 1, minGrade: -2.5, maxGrade: -2.5 },
  ],
};

describe('GET /api/stats/readability (cached per-directory readability trends walk)', () => {
  it('returns the exact readability payload for a seeded multi-directory tree', async () => {
    const fs = buildMockFs(PROJECT_ROOT, READ_TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/stats/readability', { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload, EXPECTED_READABILITY);
  });

  it('sorts directories by avgGrade ascending, not by minGrade', async () => {
    const fs = buildMockFs(PROJECT_ROOT, READ_TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/stats/readability', { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload.directories.map(d => d.directory), ['root', 'docs', 'blog']);
    const avgs = payload.directories.map(d => d.avgGrade);
    for (let i = 1; i < avgs.length; i++) {
      assert.ok(avgs[i - 1] <= avgs[i], 'avgGrade is non-decreasing');
    }
    // blog's lowest single file (minGrade 7.8) is lower than docs's (7.9), yet blog
    // sorts AFTER docs, so the order is keyed on avgGrade and not on minGrade.
    const blog = payload.directories.find(d => d.directory === 'blog');
    const docs = payload.directories.find(d => d.directory === 'docs');
    assert.ok(blog.minGrade < docs.minGrade, 'blog has the lower per-file minimum');
    assert.ok(blog.avgGrade > docs.avgGrade, 'yet blog has the higher average');
    assert.ok(
      payload.directories.indexOf(docs) < payload.directories.indexOf(blog),
      'so docs precedes blog despite blog owning the lower minimum',
    );
  });

  it('buckets a root-level file under "root", a subdirectory by its name, and a nested file under its first-level ancestor', async () => {
    const fs = buildMockFs(PROJECT_ROOT, READ_TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/stats/readability', { fs, cached });

    assert.equal(status, 200);
    const names = payload.directories.map(d => d.directory).sort();
    assert.deepEqual(names, ['blog', 'docs', 'root']);
    // The nested blog/deep/gamma.md never spawns its own "deep" bucket.
    assert.ok(!payload.directories.some(d => d.directory === 'deep'), 'no second-level "deep" bucket');
    // overview.md sits directly in content/, so it buckets under "root" alone.
    const root = payload.directories.find(d => d.directory === 'root');
    assert.equal(root.fileCount, 1);
    // blog owns alpha + beta + the nested deep/gamma = three files.
    const blog = payload.directories.find(d => d.directory === 'blog');
    assert.equal(blog.fileCount, 3);
  });

  it('never reads dot/underscore/non-md entries and never recurses dot/underscore directories', async () => {
    const fs = buildMockFs(PROJECT_ROOT, READ_TREE);
    const cached = buildMemoizingCached();

    await runHandler('/api/stats/readability', { fs, cached });

    for (const p of NEVER_READ) {
      assert.ok(!fs.readPaths.includes(p), `skipped entry must never be read: ${p}`);
    }
    for (const d of NEVER_RECURSED) {
      assert.ok(!fs.readdirPaths.includes(d), `dot/underscore directory must never be recursed: ${d}`);
    }
  });

  it('reads an under-10-word file but excludes it from the counts', async () => {
    const fs = buildMockFs(PROJECT_ROOT, READ_TREE);
    const cached = buildMemoizingCached();

    const { payload } = await runHandler('/api/stats/readability', { fs, cached });

    // tiny.md IS opened (it passes the extension and dot/underscore gates)...
    assert.ok(fs.readPaths.includes(TINY_PATH), 'tiny.md is read');
    // ...but it has only two words after frontmatter stripping, so it is not counted:
    // blog stays at three files and the overall total stays at six.
    const blog = payload.directories.find(d => d.directory === 'blog');
    assert.equal(blog.fileCount, 3);
    assert.equal(payload.totalFiles, 6);
  });

  it('computes per-directory min/max/avg and the overall aggregates across multiple directories', async () => {
    const fs = buildMockFs(PROJECT_ROOT, READ_TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/stats/readability', { fs, cached });

    assert.equal(status, 200);
    // docs aggregates its two files; the min and max come from different files.
    assert.deepEqual(
      payload.directories.find(d => d.directory === 'docs'),
      { directory: 'docs', avgGrade: 10.6, fileCount: 2, minGrade: 7.9, maxGrade: 13.3 },
    );
    // blog aggregates its three files (including the nested one).
    assert.deepEqual(
      payload.directories.find(d => d.directory === 'blog'),
      { directory: 'blog', avgGrade: 11.6, fileCount: 3, minGrade: 7.8, maxGrade: 14.3 },
    );
    // The top-level mean is over all six counted files, not a mean of directory means.
    assert.equal(payload.overallAvgGrade, 9.7);
    assert.equal(payload.totalFiles, 6);
  });

  it('does not floor a low Flesch-Kincaid grade at zero (negative grade is preserved)', async () => {
    const fs = buildMockFs(PROJECT_ROOT, NEG_TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/stats/readability', { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload, EXPECTED_NEG);
    assert.ok(payload.overallAvgGrade < 0, 'a simple short text yields a negative grade');
  });

  it('returns the zeroed empty shape for an empty content directory', async () => {
    const fs = buildMockFs(PROJECT_ROOT, { content: {} });
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/stats/readability', { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload, { overallAvgGrade: 0, totalFiles: 0, directories: [] });
  });

  it('serves a deeply equal payload from the readability-trends cache and does not re-walk on a second call', async () => {
    const fs = buildMockFs(PROJECT_ROOT, READ_TREE);
    const cached = buildMemoizingCached();

    const first = await runHandler('/api/stats/readability', { fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, EXPECTED_READABILITY);
    const readdirAfterFirst = fs.readdirCalls;
    const readAfterFirst = fs.readCalls;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');
    assert.ok(readAfterFirst > 0, 'the first request reads files');

    const second = await runHandler('/api/stats/readability', { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    // The 'readability-trends' cache short-circuits the scan: no further fs access.
    assert.equal(fs.readdirCalls, readdirAfterFirst, 'second request runs no further readdirSync');
    assert.equal(fs.readCalls, readAfterFirst, 'second request reads no further files');
    // The handler asks the cache for exactly ('readability-trends', 120000) each call.
    assert.equal(cached.calls.length, 2);
    assert.deepEqual(cached.calls[0], { key: 'readability-trends', ttl: 120000 });
    assert.deepEqual(cached.calls[1], { key: 'readability-trends', ttl: 120000 });
  });

  it('returns 500 Readability trends failed when the content walk throws', async () => {
    // A fresh (cold) cache, so the throwing walk actually runs: the throw escapes
    // the cached fn and surfaces through the handler's outer catch as a 500. A warm
    // 'readability-trends' entry would instead serve its stored value.
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/stats/readability', { fs: throwingFs, cached });

    assert.equal(status, 500);
    assert.deepEqual(payload, { error: 'Readability trends failed' });
  });
});
