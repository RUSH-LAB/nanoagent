import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub (same shape as the sibling graph-export cache suite) that
// ALSO counts its readdirSync/readFileSync calls. The /api/graph handler only
// touches readdirSync (the recursive {withFileTypes:true} content walk) and
// readFileSync (page reads), so counting both lets a test prove the second
// request is served from cache without re-walking the content tree.
function makeFs(fileMap) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const counts = { readdirSync: 0, readFileSync: 0 };
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

  return {
    _counts: counts,
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      counts.readFileSync++;
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A memoizing cached() with the same contract as server-utils makeCache(): store
// by key, return the cached value while it is within ttlMs, otherwise run fn() and
// store the result. It records its calls so a test can assert the handler passes
// the documented ('graph-data', 60000) key and TTL.
function makeMemoizingCached() {
  const store = {};
  const calls = [];
  function cached(key, ttlMs, fn) {
    calls.push({ key, ttlMs });
    const entry = store[key];
    if (entry && Date.now() - entry.time < ttlMs) return entry.data;
    const data = fn();
    store[key] = { data, time: Date.now() };
    return data;
  }
  cached._store = store;
  cached._calls = calls;
  return cached;
}

// Drive GET /api/graph against an injected fs and a shared cached, capturing the
// {nodes, edges} payload handed to json(). Passing the SAME cached into two calls
// is what lets the second request hit the cache.
async function invokeGraph(fs, cached) {
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/graph');
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await graphRoutes(req, res, url, '/api/graph', ctx);
  return captured;
}

// Fixture covering every branch the cached scan must preserve byte-for-byte:
//   • recursion into the docs/ and guides/ subdirectories;
//   • title from frontmatter      (hub → "The Hub", docs/algebra → "Algebra");
//   • title from the first heading (guides/calculus → "Calculus", no frontmatter);
//   • title from the filename      (beta → "beta", neither frontmatter nor heading);
//   • edge resolution by full node id        ([[docs/algebra]] → docs/algebra);
//   • edge resolution by last-segment fallback ([[calculus]]   → guides/calculus);
//   • aliased link whose capture stops at the pipe ([[beta|Beta Alias]] → beta);
//   • an unresolvable link that is dropped     ([[ghost]]).
const FIXTURE = {
  'content/hub.md':
    '---\ntitle: The Hub\n---\n\n' +
    'See [[docs/algebra]], [[calculus]], [[beta|Beta Alias]], and [[ghost]].\n',
  'content/beta.md': 'Plain prose with no title and no heading at all.\n',
  'content/docs/algebra.md': '---\ntitle: Algebra\n---\n\n# Algebra\n',
  'content/guides/calculus.md': '# Calculus\n\nBack to [[hub]].\n',
};

// Nodes follow walk order (content/ files first in insertion order, then the
// docs/ and guides/ subdirs); edges follow the order each match resolves. The
// alias link resolves to "beta", confirming the capture group stops at the pipe;
// the fallback link resolves to the FULL id guides/calculus; ghost is dropped.
const EXPECTED = {
  nodes: [
    { id: 'hub', path: 'hub.md', title: 'The Hub', category: '' },
    { id: 'beta', path: 'beta.md', title: 'beta', category: '' },
    { id: 'docs/algebra', path: 'docs/algebra.md', title: 'Algebra', category: 'docs' },
    { id: 'guides/calculus', path: 'guides/calculus.md', title: 'Calculus', category: 'guides' },
  ],
  edges: [
    { source: 'hub', target: 'docs/algebra' },
    { source: 'hub', target: 'guides/calculus' },
    { source: 'hub', target: 'beta' },
    { source: 'guides/calculus', target: 'hub' },
  ],
};

describe('GET /api/graph (scan + edge resolution cached under graph-data)', () => {
  it('returns the expected {nodes, edges} payload on the first request', async () => {
    const r = await invokeGraph(makeFs(FIXTURE), makeMemoizingCached());
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('serves a byte-identical payload from cache without re-scanning on a second request', async () => {
    const fs = makeFs(FIXTURE);
    const cached = makeMemoizingCached();

    const first = await invokeGraph(fs, cached);
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, EXPECTED);

    // The first request must actually walk the tree, otherwise the cache-hit
    // assertion below would pass vacuously.
    const readdirAfterFirst = fs._counts.readdirSync;
    const readFileAfterFirst = fs._counts.readFileSync;
    assert.ok(readdirAfterFirst > 0, 'first request walks the content tree');
    assert.ok(readFileAfterFirst > 0, 'first request reads page contents');

    const second = await invokeGraph(fs, cached);
    assert.equal(second.status, 200);
    // (1)/(2) The payload is byte-identical across back-to-back calls and matches the graph.
    assert.deepEqual(second.payload, EXPECTED);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
    // (3) The cache is actually used: the second request triggered no further fs walk.
    assert.equal(fs._counts.readdirSync, readdirAfterFirst, 'no repeat readdirSync on cache hit');
    assert.equal(fs._counts.readFileSync, readFileAfterFirst, 'no repeat readFileSync on cache hit');

    // Both requests went through cached() with the documented key and TTL.
    assert.deepEqual(cached._calls, [
      { key: 'graph-data', ttlMs: 60000 },
      { key: 'graph-data', ttlMs: 60000 },
    ]);
  });
});
