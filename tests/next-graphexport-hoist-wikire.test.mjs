import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// The /api/graph/export handler only touches readdirSync (the recursive content
// walk with {withFileTypes:true}) and readFileSync (page reads); the stub returns
// entries shaped the way the walk expects and ignores the encoding/options arg.
function makeFs(fileMap) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
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
    readdirSync(dir) {
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Drive GET /api/graph/export with a mocked ctx. The handler streams its DOT body
// through res.writeHead/res.end rather than json(), so the stub res captures both;
// json() is also wired so the format-guard branch can be observed.
async function invokeGraphExport(fs, { format, corsOrigin = '*' } = {}) {
  const search = format === undefined ? '' : `?format=${encodeURIComponent(format)}`;
  const url = new URL(`http://localhost/api/graph/export${search}`);
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
    CORS_ORIGIN: corsOrigin,
    // The handler now wraps its scan in cached(key, ttl, fn). A pass-through that
    // always runs fn() preserves this suite's behavior exactly (every call re-scans),
    // so the alias/orphan/stale-lastIndex assertions below still exercise the walk.
    cached: (_key, _ttlMs, fn) => fn(),
    json(_res, status, payload) { captured.json = { status, payload }; res.writableEnded = true; },
  };
  await routes(req, res, url, '/api/graph/export', ctx);
  return captured;
}

// A small content tree exercising the cases the DOT walk distinguishes:
//   - intro.md emits two wiki links, the second carrying an alias whose tail the
//     capture group drops, so the edge target is the page id, not the alias.
//   - orphan.md holds only an UNTERMINATED `[[` with no closing `]]`, so the
//     alias-aware GRAPH_WIKI_RE emits no edge and orphan stays a bare node. The
//     looser xref pattern `/\[\[([^\]|]+)/g` would wrongly emit an edge here, so
//     this pins the chosen pattern rather than just "any [[ matcher".
//   - topics/index.md collapses to the `topics` id (the trailing /index is stripped).
//   - topics/deep.md links back to intro from the very end of a long body, so its
//     match lands at a high offset.
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
// follow the order each match is encountered. orphan carries no edge (its `[[`
// never closes); the alias link resolves to "linear-algebra", confirming the
// capture group stops at the pipe.
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

describe('GET /api/graph/export (GRAPH_WIKI_RE hoisted to module scope)', () => {
  it('renders the expected DOT graph, stripping aliases and ignoring unterminated links', async () => {
    const r = await invokeGraphExport(makeFs(FIXTURE));
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(r.body, EXPECTED_DOT);
    // The alias tail of [[linear-algebra|algebra]] is dropped: the edge points at
    // the page id, and the bare alias "algebra" is neither an edge target nor a
    // node of its own.
    assert.ok(r.body.includes('"intro" -> "linear-algebra";'));
    assert.ok(!r.body.includes('-> "algebra"'));
    assert.ok(!r.body.includes('  "algebra";'));
    // GRAPH_WIKI_RE requires the closing `]]`, so orphan's unterminated `[[`
    // yields no edge. The xref pattern lacks that requirement and would leak a
    // bogus edge, so this assertion fails if the wrong pattern is wired in.
    assert.ok(!r.body.includes('unterminated-link'));
  });

  it('returns identical DOT on a second back-to-back request', async () => {
    const fs = makeFs(FIXTURE);
    const first = await invokeGraphExport(fs);
    const second = await invokeGraphExport(fs);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // GRAPH_WIKI_RE is module scope and shared across requests, so two identical
    // requests must yield byte-identical DOT, both matching the expected graph.
    assert.equal(second.body, EXPECTED_DOT);
    assert.equal(second.body, first.body);
  });

  it('stays complete when GRAPH_WIKI_RE carries a stale lastIndex (per-file reset is load-bearing)', async () => {
    // The handler resets GRAPH_WIKI_RE.lastIndex to 0 before each file's exec loop.
    // Pre-seed a large lastIndex to simulate state leaking in from a prior request,
    // then confirm the full graph still renders. Without the reset the first file
    // scanned (intro) would start its scan past its own content, exec would return
    // null at once, and intro's two edges would silently vanish; this proves the
    // reset, not the loop's natural drain-to-null, is what guarantees correctness
    // against a leaked lastIndex.
    assert.ok(routes.GRAPH_WIKI_RE instanceof RegExp, 'handler regex is exported for this guard');
    routes.GRAPH_WIKI_RE.lastIndex = 100000;
    const r = await invokeGraphExport(makeFs(FIXTURE));
    assert.equal(r.status, 200);
    assert.equal(r.body, EXPECTED_DOT);
  });

  it('rejects non-DOT formats with 400 without writing a body', async () => {
    const r = await invokeGraphExport(makeFs(FIXTURE), { format: 'json' });
    assert.equal(r.body, null);
    assert.deepEqual(r.json, { status: 400, payload: { error: 'Only DOT format supported' } });
  });
});
