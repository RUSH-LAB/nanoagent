import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the sibling route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'server', 'routes', 'content-analysis-b.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`. Both handlers
// under test only touch readdirSync (the recursive content walk with
// {withFileTypes:true}) and readFileSync (page reads), so the stub mirrors the
// sibling graphexport / xref suites and ignores the options argument.
function makeFs(fileMap) {
  const dirs = new Map();         // absDir  -> Map<name, isDir>
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

// Drive GET /api/graph/export and capture the DOT body streamed through res.end.
async function invokeGraphExport(fs) {
  const url = new URL('http://localhost/api/graph/export');
  const req = { method: 'GET' };
  const captured = { status: null, headers: null, body: null };
  const res = {
    writableEnded: false,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; return this; },
    end(body) { captured.body = body; this.writableEnded = true; return this; },
  };
  const ctx = {
    fs, path, PROJECT_ROOT, ALLOWED_EXTS, CORS_ORIGIN: '*',
    cached: (_key, _ttl, fn) => fn(),
    json(_res, status, payload) { captured.status = status; captured.body = payload; res.writableEnded = true; },
  };
  await routes(req, res, url, '/api/graph/export', ctx);
  return captured;
}

// Drive GET /api/content-xref-matrix and capture the json(res, status, payload) call.
async function invokeXref(fs) {
  const url = new URL('http://localhost/api/content-xref-matrix');
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs, path, PROJECT_ROOT, ALLOWED_EXTS,
    cached: (_key, _ttl, fn) => fn(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; },
  };
  await routes(req, res, url, '/api/content-xref-matrix', ctx);
  return captured;
}

// A nested content tree so each scanner walks several files across multiple
// directory levels and computes a content-relative id for each:
//   content/overview.md          -> "overview"          (top level)
//   content/math/index.md        -> "math"              ("/index" collapsed)
//   content/math/linear.md       -> "math/linear"       (one level deep)
//   content/math/calc/limits.mdx -> "math/calc/limits"  (two levels deep, .mdx)
// The deep ids are the regression signal: they keep the leading directory path but
// drop the "content/" prefix, which only holds when the relative base is the
// in-scope contentDir (path.join(PROJECT_ROOT, 'content')) and not PROJECT_ROOT.
const FIXTURE = {
  'content/overview.md':
    '---\ntitle: Overview\n---\nStart at [[math]] then read [[math/linear]].\n',
  'content/math/index.md':
    '---\ntitle: Math\n---\nBack to [[overview]].\n',
  'content/math/linear.md':
    '---\ntitle: Linear Algebra\n---\nBuilds on [[math/calc/limits|Limits]].\n',
  'content/math/calc/limits.mdx':
    '---\ntitle: Limits\n---\nDeeply nested, links [[overview]] and cites [@cauchy1821].\n',
};

describe('GET /api/graph/export node ids are content-relative (contentDir base)', () => {
  it('emits the expected DOT with deep ids stripped of the content/ prefix', async () => {
    const r = await invokeGraphExport(makeFs(FIXTURE));
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8');
    const EXPECTED_DOT =
      'digraph KnowledgeGraph {\n' +
      '  rankdir=LR;\n' +
      '  node [shape=box, style=rounded];\n' +
      '  "overview";\n' +
      '  "math";\n' +
      '  "math/linear";\n' +
      '  "math/calc/limits";\n' +
      '  "overview" -> "math";\n' +
      '  "overview" -> "math/linear";\n' +
      '  "math" -> "overview";\n' +
      '  "math/linear" -> "math/calc/limits";\n' +
      '  "math/calc/limits" -> "overview";\n' +
      '}\n';
    assert.equal(r.body, EXPECTED_DOT);
  });

  it('keeps every node id content-relative (no content/ prefix survives)', async () => {
    const r = await invokeGraphExport(makeFs(FIXTURE));
    assert.ok(r.body.includes('"math/calc/limits";'), 'deep id retains its directory path');
    assert.ok(!r.body.includes('"content/'), 'no node id keeps the content/ prefix');
  });
});

describe('GET /api/content-xref-matrix page ids are content-relative (contentDir base)', () => {
  it('returns page rows whose ids are the content-relative paths', async () => {
    const r = await invokeXref(makeFs(FIXTURE));
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.pages, [
      { id: 'overview', title: 'Overview' },
      { id: 'math', title: 'Math' },
      { id: 'math/linear', title: 'Linear Algebra' },
      { id: 'math/calc/limits', title: 'Limits' },
    ]);
    assert.equal(r.payload.totalPages, 4);
    const ids = r.payload.pages.map(p => p.id);
    assert.ok(ids.includes('math/calc/limits'), 'deep id retains its directory path');
    assert.ok(!ids.some(id => id.startsWith('content/')), 'no page id keeps the content/ prefix');
  });

  it('records wiki and citation links keyed by the content-relative ids', async () => {
    const r = await invokeXref(makeFs(FIXTURE));
    assert.deepEqual(r.payload.links, [
      { from: 'overview', to: 'math', type: 'wiki' },
      { from: 'overview', to: 'math/linear', type: 'wiki' },
      { from: 'math', to: 'overview', type: 'wiki' },
      { from: 'math/linear', to: 'math/calc/limits', type: 'wiki' },
      { from: 'math/calc/limits', to: 'overview', type: 'wiki' },
      { from: 'math/calc/limits', to: 'cauchy1821', type: 'citation' },
    ]);
    assert.equal(r.payload.totalLinks, 6);
  });
});

// Pin the refactor itself: both scanners reuse the in-scope `contentDir` instead of
// recomputing path.join(PROJECT_ROOT, 'content') per file. The behavior tests above
// cannot distinguish the two forms (they are byte-identical), so this source-shape
// guard is what locks the change in place alongside verify.sh.
describe('source shape: both scanners reuse contentDir for the per-file id', () => {
  const SRC = readFileSync(SRC_PATH, 'utf-8');
  const countOf = (hay, needle) => hay.split(needle).length - 1;

  it('has zero recomputed path.relative(path.join(PROJECT_ROOT, "content"), fp)', () => {
    assert.equal(countOf(SRC, "path.relative(path.join(PROJECT_ROOT, 'content'), fp)"), 0);
  });

  it('has exactly two path.relative(contentDir, fp)', () => {
    assert.equal(countOf(SRC, 'path.relative(contentDir, fp)'), 2);
  });
});
