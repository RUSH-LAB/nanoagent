import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Add-only characterization test for three content-walk GET handlers in
// server/routes/analysis-admin.js: /api/content-lint, /api/content-wordcloud,
// and /api/tags. Each wraps a recursive scan of the content tree in
// cached(key, ttl, fn) and reads the filesystem only through ctx.fs, so an
// in-memory fs plus a memoizing cached() pins their behavior end to end with no
// real filesystem, network, git, clock, or randomness. It pins the CURRENT,
// correct behavior so a future refactor cannot silently change it, and it edits
// no source file.
//
// Mirrors tests/next-filesrecent-cache.test.mjs (same module, same in-memory fs
// plus memoizing cached pattern). The real module is loaded with
// createRequire(import.meta.url) exactly as the sibling server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub with a readdirSync counter so a test can prove a cached
// repeat skips the recursive walk. readdirSync ignores the {withFileTypes:true}
// option and returns dirent-likes ({name, isDirectory()}), matching how the
// handlers consume it. These three handlers never call statSync, so it is
// omitted. fileMap maps a content-relative path to its string contents.
function makeFs(fileMap) {
  const dirs = new Map();   // absDir -> Map<name, isDir>
  const files = new Map();  // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const [rel, content] of Object.entries(fileMap)) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    files.set(cur, content);
  }

  const fs = {
    readdirCount: 0,
    readdirSync(dir) {
      fs.readdirCount++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (files.has(fp)) return files.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return fs;
}

// Memoizing cached() mirroring the production server.js helper: the first call
// for a key runs fn() and stores the result; later calls return the stored value
// without re-running fn(). It records every {key, ttl} so a test can pin the
// cache key and TTL, and it stores nothing when fn() throws so an error response
// stays uncached, exactly like the real helper.
function makeCache() {
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

// An fs whose top-level readdirSync always throws, so the content walk fails at
// the root. The per-file try/catch inside each handler only swallows a single
// unreadable file, so a root-level throw is what reaches the handler catch and
// produces the 500.
function makeThrowingFs() {
  const fs = {
    readdirCount: 0,
    readdirSync() { fs.readdirCount++; const e = new Error('readdir failed'); e.code = 'EACCES'; throw e; },
    readFileSync() { throw new Error('unexpected read'); },
  };
  return fs;
}

// Drive one GET route with a shared fs + cached, returning the captured json()
// payload. ctx carries only the fields these three handlers read.
async function callRoute(fs, cached, pathname) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── /api/content-lint fixtures ──
// Five files that each trigger one issue category, one clean file with no issues,
// plus skip-rule decoys (a dotfile, an underscore file, a non-allowed extension,
// and an underscore directory) whose would-be "Missing frontmatter" issues must
// never surface. The decoys carry no frontmatter, so any leak would change the
// totals. multi.md pins the in-file issue ORDER: the frontmatter/title check runs
// first (line 1), then the empty-heading scan, then the unclosed-fence error.
const LINT_FIXTURE = {
  'content/missing-fm.md': 'no frontmatter here\njust text\n',
  'content/missing-title.md': '---\nauthor: Someone\n---\ncontent body\n',
  'content/empty-heading.md': '---\ntitle: EH\n---\n##\ntext after\n',
  'content/unclosed.md': '---\ntitle: UC\n---\nintro\n```js\ncode line one\n#\n',
  'content/multi.md': '---\nauthor: NoTitle\n---\n#\nintro\n```text\ncode\n',
  'content/good.md': '---\ntitle: Good\n---\n# Real Heading\nsome text\n',
  'content/.hidden.md': 'hidden no frontmatter\n',
  'content/_draft.md': 'draft no frontmatter\n',
  'content/notes.txt': 'txt no frontmatter\n',
  'content/_private/inside.md': 'inside no frontmatter\n',
};

const EXPECTED_LINT = {
  files: [
    { path: 'content/missing-fm.md', issues: [{ line: 1, severity: 'warning', message: 'Missing frontmatter' }] },
    { path: 'content/missing-title.md', issues: [{ line: 1, severity: 'warning', message: 'Missing title' }] },
    { path: 'content/empty-heading.md', issues: [{ line: 4, severity: 'warning', message: 'Empty heading' }] },
    { path: 'content/unclosed.md', issues: [{ line: 8, severity: 'error', message: 'Unclosed code block' }] },
    { path: 'content/multi.md', issues: [
      { line: 1, severity: 'warning', message: 'Missing title' },
      { line: 4, severity: 'warning', message: 'Empty heading' },
      { line: 8, severity: 'error', message: 'Unclosed code block' },
    ] },
  ],
  totalIssues: 7,
  severityCounts: { error: 2, warning: 5, info: 0 },
};

// A single file whose only headings sit inside a properly closed code fence. The
// fence lines toggle the inCode flag and are themselves skipped, the headings
// inside are not linted, and the closed fence leaves no unclosed-block error, so
// the report is empty.
const LINT_FENCE_ONLY = {
  'content/fence.md': '---\ntitle: F\n---\nbefore\n```js\n#\n###\n```\nafter\n',
};

describe('GET /api/content-lint (recursive lint walk cached as cached("content-lint", 60000, fn))', () => {
  it('pins every issue kind, the in-file order, totals, severity tallies, and skip rules', async () => {
    const fs = makeFs(LINT_FIXTURE);
    const r = await callRoute(fs, makeCache(), '/api/content-lint');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED_LINT);
    assert.ok(fs.readdirCount > 0, 'first request should walk the content tree');
  });

  it('does not lint headings or fence lines inside a closed code block', async () => {
    const fs = makeFs(LINT_FENCE_ONLY);
    const r = await callRoute(fs, makeCache(), '/api/content-lint');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { files: [], totalIssues: 0, severityCounts: { error: 0, warning: 0, info: 0 } });
  });

  it('caches under key content-lint with a 60000 ms TTL and serves a repeat without re-walking', async () => {
    const fs = makeFs(LINT_FIXTURE);
    const cached = makeCache();
    const first = await callRoute(fs, cached, '/api/content-lint');
    const countAfterFirst = fs.readdirCount;
    assert.equal(first.status, 200);
    assert.ok(countAfterFirst > 0, 'first request should walk the content tree');
    assert.deepEqual(cached.calls[0], { key: 'content-lint', ttl: 60000 });

    const second = await callRoute(fs, cached, '/api/content-lint');
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(fs.readdirCount, countAfterFirst, 'cached repeat must not call readdirSync again');
  });

  it('returns 500 Content lint failed when the top-level content walk throws, caching nothing', async () => {
    const fs = makeThrowingFs();
    const cached = makeCache();
    const r = await callRoute(fs, cached, '/api/content-lint');
    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Content lint failed' });
    assert.equal(cached.store.has('content-lint'), false, 'a thrown walk must not store a cache entry');
  });
});

// ── /api/content-wordcloud fixtures ──
// wc1.md exercises frontmatter stripping (its title words never count), fenced
// code stripping (the codeword tokens vanish), the length filter (cat and dog at
// three letters drop), and the stoplist filter (the and function drop). wc2.mdx
// in a nested directory proves the recursive walk and cross-file accumulation.
// The decoys (dotfile, underscore file, non-allowed extension, underscore
// directory) would each shift the counts if scanned, so excluding them is pinned
// by the exact frequencies.
const WC_FIXTURE = {
  'content/wc1.md': '---\ntitle: Title Should Be Stripped\n---\nalpha alpha alpha alpha alpha alpha beta beta beta beta\n```text\ncodeword codeword codeword\n```\ncat dog the function\n',
  'content/sub/wc2.mdx': '---\ntitle: Nested File\n---\ngamma gamma gamma delta\n',
  'content/.hidden.md': '---\ntitle: H\n---\nalpha alpha alpha alpha alpha alpha alpha alpha alpha alpha\n',
  'content/_draft.md': '---\ntitle: D\n---\nbeta beta beta beta beta beta beta beta\n',
  'content/notes.txt': 'gamma gamma gamma gamma gamma\n',
  'content/_archive/old.md': '---\ntitle: O\n---\ndelta delta delta delta delta delta\n',
};

// Counts 6/4/3/1 give a clean descending order and pin the weight rounding: the
// top word is exactly 1, 4/6 rounds to 0.67, 3/6 is 0.5, and 1/6 rounds to 0.17.
const EXPECTED_WC = {
  words: [
    { word: 'alpha', count: 6, weight: 1 },
    { word: 'beta', count: 4, weight: 0.67 },
    { word: 'gamma', count: 3, weight: 0.5 },
    { word: 'delta', count: 1, weight: 0.17 },
  ],
  total: 4,
};

// Only short words and stopwords, so no token survives the length-plus-stoplist
// filter. The word list is empty and maxCount falls back to 1.
const WC_EMPTY_FIXTURE = {
  'content/only-short.md': '---\ntitle: T\n---\nthe cat is on a mat and so\n',
};

describe('GET /api/content-wordcloud (top-100 frequency walk cached as cached("wordcloud", 60000, fn))', () => {
  it('pins the length plus stoplist filter, descending counts, and weight rounding with a top weight of 1', async () => {
    const fs = makeFs(WC_FIXTURE);
    const r = await callRoute(fs, makeCache(), '/api/content-wordcloud');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED_WC);
    assert.ok(fs.readdirCount > 0, 'first request should walk the content tree');
  });

  it('returns an empty list with total 0 when no token passes the filter', async () => {
    const fs = makeFs(WC_EMPTY_FIXTURE);
    const r = await callRoute(fs, makeCache(), '/api/content-wordcloud');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { words: [], total: 0 });
  });

  it('caches under key wordcloud with a 60000 ms TTL and serves a repeat without re-walking', async () => {
    const fs = makeFs(WC_FIXTURE);
    const cached = makeCache();
    const first = await callRoute(fs, cached, '/api/content-wordcloud');
    const countAfterFirst = fs.readdirCount;
    assert.equal(first.status, 200);
    assert.ok(countAfterFirst > 0, 'first request should walk the content tree');
    assert.deepEqual(cached.calls[0], { key: 'wordcloud', ttl: 60000 });

    const second = await callRoute(fs, cached, '/api/content-wordcloud');
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(fs.readdirCount, countAfterFirst, 'cached repeat must not call readdirSync again');
  });

  it('returns 500 Word cloud failed when the top-level content walk throws, caching nothing', async () => {
    const fs = makeThrowingFs();
    const cached = makeCache();
    const r = await callRoute(fs, cached, '/api/content-wordcloud');
    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Word cloud failed' });
    assert.equal(cached.store.has('wordcloud'), false, 'a thrown walk must not store a cache entry');
  });
});

// ── /api/tags fixtures ──
// Only the inline single-line array form `tags: [a, b]` is parsed. a.md, b.mdx
// (nested), c.md (quoted entries), and d.md drive counts foo=4, bar=3, baz=2,
// qux=1. c.md pins quote stripping: 'foo' and "bar" fold into the unquoted foo
// and bar buckets. no-tags.md and multiline-tags.md contribute nothing, and the
// decoys (dotfile, underscore file, non-allowed extension, underscore directory)
// each carry a shouldskip tag that must never appear.
const TAGS_FIXTURE = {
  'content/a.md': '---\ntitle: A\ntags: [foo, bar, baz, qux]\n---\nbody\n',
  'content/sub/b.mdx': '---\ntags: [foo, bar, baz]\n---\nnested body\n',
  'content/c.md': '---\ntitle: C\ntags: [\'foo\', "bar"]\n---\nquoted tags\n',
  'content/d.md': '---\ntags: [foo]\n---\nsingle tag\n',
  'content/no-tags.md': '---\ntitle: NoTags\nauthor: x\n---\nno tags here\n',
  'content/multiline-tags.md': '---\ntitle: ML\ntags:\n  - alpha\n  - beta\n---\nmultiline ignored\n',
  'content/.hidden.md': '---\ntags: [shouldskip]\n---\n',
  'content/_draft.md': '---\ntags: [shouldskip]\n---\n',
  'content/notes.txt': '---\ntags: [shouldskip]\n---\n',
  'content/_skipdir/inside.md': '---\ntags: [shouldskip]\n---\n',
};

const EXPECTED_TAGS = [
  { tag: 'foo', count: 4 },
  { tag: 'bar', count: 3 },
  { tag: 'baz', count: 2 },
  { tag: 'qux', count: 1 },
];

// A frontmatter block whose tags use a multi-line YAML list, which the inline
// array regex never matches, so the tag set stays empty.
const TAGS_MULTILINE_ONLY = {
  'content/post.md': '---\ntitle: ML\ntags:\n  - alpha\n  - beta\n---\nbody\n',
};

describe('GET /api/tags (inline tag-array walk cached as cached("all-tags", 30000, fn))', () => {
  it('pins inline-array parsing with quote stripping and the descending count sort', async () => {
    const fs = makeFs(TAGS_FIXTURE);
    const r = await callRoute(fs, makeCache(), '/api/tags');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { tags: EXPECTED_TAGS });
    assert.ok(fs.readdirCount > 0, 'first request should walk the content tree');
  });

  it('ignores a multi-line YAML tag list, matching only the inline array form', async () => {
    const fs = makeFs(TAGS_MULTILINE_ONLY);
    const r = await callRoute(fs, makeCache(), '/api/tags');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { tags: [] });
  });

  it('caches under key all-tags with a 30000 ms TTL and serves a repeat without re-walking', async () => {
    const fs = makeFs(TAGS_FIXTURE);
    const cached = makeCache();
    const first = await callRoute(fs, cached, '/api/tags');
    const countAfterFirst = fs.readdirCount;
    assert.equal(first.status, 200);
    assert.ok(countAfterFirst > 0, 'first request should walk the content tree');
    assert.deepEqual(cached.calls[0], { key: 'all-tags', ttl: 30000 });

    const second = await callRoute(fs, cached, '/api/tags');
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(fs.readdirCount, countAfterFirst, 'cached repeat must not call readdirSync again');
  });

  it('returns 500 Failed to list tags when the top-level content walk throws, caching nothing', async () => {
    const fs = makeThrowingFs();
    const cached = makeCache();
    const r = await callRoute(fs, cached, '/api/tags');
    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Failed to list tags' });
    assert.equal(cached.store.has('all-tags'), false, 'a thrown walk must not store a cache entry');
  });
});
