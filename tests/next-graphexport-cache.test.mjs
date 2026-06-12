import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub (same shape as the sibling hoist suite) that ALSO counts its
// readdirSync/readFileSync calls. The /api/graph/export handler only touches
// readdirSync (the recursive content walk with {withFileTypes:true}) and
// readFileSync (page reads); counting both lets a test prove the second request is
// served from cache without re-walking the content tree.
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

// A memoizing cached() with the same contract as server-utils makeCache(): store by
// key, return the cached value while it is within ttlMs, otherwise run fn() and
// store the result. It records its calls so a test can assert the handler passes the
// documented ('graph-export-dot', 60000) key and TTL.
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

// Drive GET /api/graph/export against an injected fs and a shared cached, capturing
// the DOT body streamed through res.end. Passing the SAME cached into two calls is
// what lets the second request hit the cache.
async function invokeGraphExport(fs, cached) {
  const url = new URL('http://localhost/api/graph/export');
  const req = { method: 'GET' };
  const captured = { status: null, headers: null, body: null, json: null };
  const res = {
    writableEnded: false,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; return this; },
    end(body) { captured.body = body; this.writableEnded = true; return this; },
  };
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    CORS_ORIGIN: '*',
    cached,
    json(_res, status, payload) { captured.json = { status, payload }; res.writableEnded = true; },
  };
  await routes(req, res, url, '/api/graph/export', ctx);
  return captured;
}

// The same content tree the hoist suite pins (intro emits two wiki links, the second
// aliased; orphan holds an unterminated `[[`; topics/index collapses to `topics`;
// topics/deep links back from a high offset), so EXPECTED_DOT below is the proven
// handler output rather than a re-derivation.
const FIXTURE = {
  'content/intro.md': `---
title: Intro
---

Start here. See [[graph-theory]] and [[linear-algebra|algebra]] for background.
`,
  'content/graph-theory.md': `---
title: Graph Theory
---

This builds on [[intro]].
`,
  'content/orphan.md': `---
title: Orphan
---

A standalone page. This [[unterminated-link never closes, so the alias-aware
pattern that requires the trailing brackets emits no edge for it.
`,
  'content/topics/index.md': `---
title: Topics
---

An overview that points to [[graph-theory]].
`,
  'content/topics/deep.md': `---
title: Deep Dive
---

${'Filler prose carrying no links whatsoever. '.repeat(30)}
Finally it links back to [[intro]] at the very end.
`,
};

// Nodes follow walk order (content/ files first, then the topics/ subdir); edges
// follow the order each match is encountered. orphan carries no edge; the alias link
// resolves to "linear-algebra", confirming the capture group stops at the pipe.
const EXPECTED_DOT =
  'digraph KnowledgeGraph {\n' +
  '  rankdir=LR;\n' +
  '  node [shape=box, style=rounded];\n' +
  '  "intro";\n' +
  '  "graph-theory";\n' +
  '  "orphan";\n' +
  '  "topics";\n' +
  '  "topics/deep";\n' +
  '  "intro" -> "graph-theory";\n' +
  '  "intro" -> "linear-algebra";\n' +
  '  "graph-theory" -> "intro";\n' +
  '  "topics" -> "graph-theory";\n' +
  '  "topics/deep" -> "intro";\n' +
  '}\n';

describe('GET /api/graph/export (scan + DOT build cached under graph-export-dot)', () => {
  it('returns the expected DOT body on the first request', async () => {
    const r = await invokeGraphExport(makeFs(FIXTURE), makeMemoizingCached());
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(r.body, EXPECTED_DOT);
  });

  it('serves an identical body from cache without re-scanning on a second request', async () => {
    const fs = makeFs(FIXTURE);
    const cached = makeMemoizingCached();

    const first = await invokeGraphExport(fs, cached);
    assert.equal(first.status, 200);
    assert.equal(first.body, EXPECTED_DOT);

    // The first request must actually walk the tree, otherwise the cache-hit
    // assertion below would pass vacuously.
    const readdirAfterFirst = fs._counts.readdirSync;
    const readFileAfterFirst = fs._counts.readFileSync;
    assert.ok(readdirAfterFirst > 0, 'first request walks the content tree');
    assert.ok(readFileAfterFirst > 0, 'first request reads page contents');

    const second = await invokeGraphExport(fs, cached);
    assert.equal(second.status, 200);
    // (1)/(2) The body is byte-identical across back-to-back calls and matches the graph.
    assert.equal(second.body, EXPECTED_DOT);
    assert.equal(second.body, first.body);
    // (3) The cache is actually used: the second request triggered no further fs walk.
    assert.equal(fs._counts.readdirSync, readdirAfterFirst, 'no repeat readdirSync on cache hit');
    assert.equal(fs._counts.readFileSync, readFileAfterFirst, 'no repeat readFileSync on cache hit');

    // Both requests went through cached() with the documented key and TTL.
    assert.deepEqual(cached._calls, [
      { key: 'graph-export-dot', ttlMs: 60000 },
      { key: 'graph-export-dot', ttlMs: 60000 },
    ]);
  });
});
