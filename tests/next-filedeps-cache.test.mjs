import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub (same shape as next-filedeps-hoist-regexes.test.mjs) plus a
// readdirSync call counter, so a test can prove a cached request skips the
// recursive incoming-link directory walk entirely.
function makeFs(fileMap) {
  const dirs = new Map();          // absDir -> Map<name, isDir>
  const fileContents = new Map();  // absFile -> content
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
    fileContents.set(cur, content);
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
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return fs;
}

// A memoizing cached() mirroring the production server.js helper: the first call
// for a key runs fn() and stores its result; later calls for the same key return
// the stored value without re-running fn(). TTL is irrelevant within one test, so
// it is ignored. fn() throwing (a missing source file) never stores anything, so
// error responses stay uncached, exactly like the real helper.
function makeCache() {
  const store = new Map();
  return (key, _ttlMs, fn) => {
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  };
}

// Drive GET /api/file/dependencies with a shared fs + cached across calls, so a
// repeat request can be observed hitting the cache. Returns the captured json().
async function getDependencies(fs, cached, filePath, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    isValidFilePath,
    cached,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/file/dependencies?path=${encodeURIComponent(filePath)}`);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/dependencies', ctx);
  return captured;
}

// Source mixes all three outgoing link kinds the handler extracts: two wiki links
// (the second carries an alias that must be stripped), two citation markers (one
// a multi-key group), and two root-relative markdown links.
const SOURCE = `---
title: Dependency Source
---

See [[graph-theory]] and [[linear-algebra|algebra]] for background.
This builds on [@knuth1997] and combines [@smith2020; @jones2019].
Read the [intro guide](/docs/intro) and the [API reference](/api/reference).
`;

// Links back to the source, so it is the sole incoming edge for dep-source.
const REFERS_TO_SOURCE = `---
title: Refers To Source
---

This page links back to [[dep-source]] in its body.
`;

// A second standalone source with its own distinct outgoing link and no incoming
// edges, used to prove a different path is a separate cache entry that re-scans.
const OTHER = `---
title: Other Source
---

This page only points at [[graph-theory]] and nothing else.
`;

const FIXTURE = {
  'content/dep-source.md': SOURCE,
  'content/refers-to-source.md': REFERS_TO_SOURCE,
  'content/other.md': OTHER,
};

const EXPECTED_SOURCE = {
  path: 'content/dep-source.md',
  outgoing: [
    { type: 'wiki', target: 'graph-theory' },
    { type: 'wiki', target: 'linear-algebra' },
    { type: 'citation', target: 'knuth1997' },
    { type: 'citation', target: 'smith2020' },
    { type: 'citation', target: 'jones2019' },
    { type: 'link', target: 'docs/intro' },
    { type: 'link', target: 'api/reference' },
  ],
  incoming: [
    { type: 'wiki', source: 'content/refers-to-source.md' },
  ],
  outgoingCount: 7,
  incomingCount: 1,
};

const EXPECTED_OTHER = {
  path: 'content/other.md',
  outgoing: [
    { type: 'wiki', target: 'graph-theory' },
  ],
  incoming: [],
  outgoingCount: 1,
  incomingCount: 0,
};

describe('GET /api/file/dependencies (result cached via cached("filedeps:" + path))', () => {
  it('returns the correct dependencies payload on the first (uncached) request', async () => {
    const fs = makeFs(FIXTURE);
    const res = await getDependencies(fs, makeCache(), 'content/dep-source.md');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, EXPECTED_SOURCE);
    assert.ok(fs.readdirCount > 0, 'first request should scan the content tree');
  });

  it('serves a repeat request for the same path from cache without re-scanning', async () => {
    const fs = makeFs(FIXTURE);
    const cached = makeCache();
    const first = await getDependencies(fs, cached, 'content/dep-source.md');
    const countAfterFirst = fs.readdirCount;
    assert.equal(first.status, 200);
    assert.ok(countAfterFirst > 0, 'first request should scan the content tree');

    const second = await getDependencies(fs, cached, 'content/dep-source.md');
    assert.equal(second.status, 200);
    // Same payload, and served from cache: readdirSync must not run again.
    assert.deepEqual(second.body, EXPECTED_SOURCE);
    assert.deepEqual(second.body, first.body);
    assert.equal(fs.readdirCount, countAfterFirst, 'cached repeat must not call readdirSync again');
  });

  it('treats a different path as a distinct cache entry that scans again', async () => {
    const fs = makeFs(FIXTURE);
    const cached = makeCache();
    await getDependencies(fs, cached, 'content/dep-source.md');
    const countAfterFirst = fs.readdirCount;

    const other = await getDependencies(fs, cached, 'content/other.md');
    assert.equal(other.status, 200);
    assert.deepEqual(other.body, EXPECTED_OTHER);
    assert.ok(fs.readdirCount > countAfterFirst, 'a new path must scan the content tree again');
  });

  it('returns 404 for a missing source file and does not cache the error', async () => {
    const fs = makeFs(FIXTURE);
    const cached = makeCache();
    const first = await getDependencies(fs, cached, 'content/missing.md');
    assert.equal(first.status, 404);
    assert.deepEqual(first.body, { error: 'File not found' });
    // The error threw inside cached() before anything was stored, so a repeat
    // request re-attempts the read and still 404s rather than serving a cached error.
    const second = await getDependencies(fs, cached, 'content/missing.md');
    assert.equal(second.status, 404);
    assert.deepEqual(second.body, { error: 'File not found' });
  });
});
