import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub with a readdirSync counter, so a test can prove a cached
// request skips the recursive content walk entirely. Each entry carries an mtime
// (for statSync) and content (for the includeStats path). readdirSync ignores the
// {withFileTypes: true} option and always returns dirent-like objects, matching
// how the handler consumes it.
function makeFs(fileMap) {
  const dirs = new Map();          // absDir -> Map<name, isDir>
  const fileContents = new Map();  // absFile -> content
  const fileMtimes = new Map();    // absFile -> mtimeMs
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const [rel, info] of Object.entries(fileMap)) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    fileContents.set(cur, info.content);
    fileMtimes.set(cur, info.mtime);
  }

  const fs = {
    readdirCount: 0,
    readdirSync(dir) {
      fs.readdirCount++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    statSync(fp) {
      if (fileMtimes.has(fp)) return { mtimeMs: fileMtimes.get(fp) };
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return fs;
}

// A memoizing cached() mirroring the production server.js helper: the first call
// for a key runs fn() and stores its result; later calls for the same key return
// the stored value without re-running fn(). TTL is irrelevant within one test, so
// it is ignored. fn() throwing never stores anything, so error responses stay
// uncached, exactly like the real helper.
function makeCache() {
  const store = new Map();
  return (key, _ttlMs, fn) => {
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  };
}

// Drive GET /api/files/recent with a shared fs + cached across calls, so a repeat
// request can be observed hitting the cache. Returns the captured json() payload.
async function getRecent(fs, cached, search = '') {
  const url = new URL(`http://localhost/api/files/recent${search}`);
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
  await routes(req, res, url, '/api/files/recent', ctx);
  return captured;
}

// Three allowed files at descending mtimes (one nested, to exercise the recursive
// walk) plus a non-markdown file that must be ignored. notes.txt carries the
// highest mtime, so excluding it by extension also proves the sort never surfaces
// it first. Word counts split on /\s+/ over the whole file, matching the handler.
const FIXTURE = {
  'content/alpha.md': { content: '---\ntitle: Alpha Title\n---\none two three four five\n', mtime: 300 },
  'content/sub/beta.mdx': { content: '---\ntitle: Beta Title\n---\nalpha beta gamma delta\n', mtime: 200 },
  'content/gamma.md': { content: '---\ntitle: Gamma Title\n---\nsolo\n', mtime: 100 },
  'content/notes.txt': { content: 'ignored because the extension is not allowed\n', mtime: 999 },
};

// Most-recent-first, base fields only (no includeStats).
const EXPECTED_PLAIN = [
  { name: 'alpha.md', path: 'content/alpha.md', mtime: 300 },
  { name: 'beta.mdx', path: 'content/sub/beta.mdx', mtime: 200 },
  { name: 'gamma.md', path: 'content/gamma.md', mtime: 100 },
];

// Same order, now with the includeStats fields (wordCount over the whole file,
// readingTimeMin = ceil(wordCount / 200), title from the frontmatter title line).
const EXPECTED_STATS = [
  { name: 'alpha.md', path: 'content/alpha.md', mtime: 300, wordCount: 10, readingTimeMin: 1, title: 'Alpha Title' },
  { name: 'beta.mdx', path: 'content/sub/beta.mdx', mtime: 200, wordCount: 9, readingTimeMin: 1, title: 'Beta Title' },
  { name: 'gamma.md', path: 'content/gamma.md', mtime: 100, wordCount: 6, readingTimeMin: 1, title: 'Gamma Title' },
];

describe('GET /api/files/recent (walk cached via cached("files-recent:" + flag))', () => {
  it('returns the most-recent-first list on the first (uncached) call', async () => {
    const fs = makeFs(FIXTURE);
    const r = await getRecent(fs, makeCache(), '');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.files, EXPECTED_PLAIN);
    assert.ok(fs.readdirCount > 0, 'first request should walk the content tree');
  });

  it('serves a repeat request for the same includeStats from cache without re-walking', async () => {
    const fs = makeFs(FIXTURE);
    const cached = makeCache();
    const first = await getRecent(fs, cached, '');
    const countAfterFirst = fs.readdirCount;
    assert.equal(first.status, 200);
    assert.ok(countAfterFirst > 0, 'first request should walk the content tree');

    const second = await getRecent(fs, cached, '');
    assert.equal(second.status, 200);
    // Same payload, served from cache: readdirSync must not run again.
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload.files, EXPECTED_PLAIN);
    assert.equal(fs.readdirCount, countAfterFirst, 'cached repeat must not call readdirSync again');
  });

  it('treats a different includeStats value as a distinct cache entry that walks again', async () => {
    const fs = makeFs(FIXTURE);
    const cached = makeCache();
    const plain = await getRecent(fs, cached, '');
    const countAfterPlain = fs.readdirCount;
    assert.deepEqual(plain.payload.files, EXPECTED_PLAIN);

    const stats = await getRecent(fs, cached, '?includeStats=true');
    assert.equal(stats.status, 200);
    assert.deepEqual(stats.payload.files, EXPECTED_STATS);
    assert.ok(fs.readdirCount > countAfterPlain, 'a different includeStats key must walk the tree again');

    // ...and the stats entry is itself cached on a repeat call.
    const countAfterStats = fs.readdirCount;
    const statsAgain = await getRecent(fs, cached, '?includeStats=true');
    assert.deepEqual(statsAgain.payload.files, EXPECTED_STATS);
    assert.equal(fs.readdirCount, countAfterStats, 'repeat stats request must hit the cache');
  });

  it('slices the cached list for different limits without re-walking', async () => {
    const fs = makeFs(FIXTURE);
    const cached = makeCache();
    const all = await getRecent(fs, cached, '');
    const countAfterFirst = fs.readdirCount;
    assert.deepEqual(all.payload.files, EXPECTED_PLAIN);

    const one = await getRecent(fs, cached, '?limit=1');
    assert.equal(one.status, 200);
    assert.equal(one.payload.files.length, 1);
    assert.deepEqual(one.payload.files, EXPECTED_PLAIN.slice(0, 1));
    assert.equal(fs.readdirCount, countAfterFirst, 'limit slicing must reuse the cached list, not re-walk');

    const two = await getRecent(fs, cached, '?limit=2');
    assert.equal(two.status, 200);
    assert.deepEqual(two.payload.files, EXPECTED_PLAIN.slice(0, 2));
    assert.equal(fs.readdirCount, countAfterFirst, 'a second limit also reuses the cache, not re-walk');
  });
});
