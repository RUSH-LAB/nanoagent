import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the sibling reading-path
// suite (next-content-a-readingpath-cache) does and reuse its ctx-mocking shape.
// GET /api/content-reading-path wraps its full content/ walk and depth-bounded
// BFS in cached('readingpath:' + start + ':' + depth, 60000, fn). This suite pins
// the loop-invariant hoist of Object.keys(pageTitles): the resolver now computes
// the key list once into pageTitleKeys after scan() instead of rebuilding it on
// every wiki-link resolution. We prove the payload stays byte-identical to an
// independent re-implementation of the PRE-hoist algorithm (one that rebuilds
// Object.keys(pageTitles) on each lookup), driving the real handler in-process
// with a stub fs and a memoizing cached, no network and no server.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`. The handler
// walks directories with readdirSync({withFileTypes}) and reads each candidate
// with readFileSync. Entries are returned in insertion order, so for a flat tree
// (every file directly under content/) the order pageTitles is populated equals
// the order the files appear in `fileMap`. That is what makes the independent
// reference below faithful without copying the handler's scan().
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

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server/index.js
// helper: run fn and store on a miss, return the stored value on a hit. A fresh
// ctx per call gives every assertion its own empty cache, so no result is ever
// served a stale cached() value (the alternative the GOAL allows is a distinct
// start/depth per assertion; an isolated cache is simpler and just as safe).
function makeCached() {
  const store = new Map();
  const cached = (key, ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return cached;
}

// Invoke the content-reading-path handler with a fresh mocked ctx and capture the
// response handed to json(res, status, payload). Fully in-process: no network and
// no server is started. A new fs and cache are built per call so each assertion is
// deterministic and independent of cache state.
async function invoke(fileMap, search) {
  const pathname = '/api/content-reading-path';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: makeFs(fileMap),
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    isValidFilePath: () => true,
    cached: makeCached(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// Independent reference: a from-scratch re-implementation of the PRE-hoist reading
// path algorithm. It parses the fixture into pageTitles/pageLinks in the fixture's
// own key order (which equals the handler's scan order for a flat content/ tree)
// using the same frontmatter-title and wiki-link shapes the route specifies, then
// resolves every link by rebuilding Object.keys(pageTitles) on each lookup, exactly
// as the code did before the hoist. The hoisted handler must return a byte-identical
// result, which is the behavior-preservation claim under test.
function referenceReadingPath(fileMap, startPath, maxDepth) {
  const pageTitles = {};
  const pageLinks = {};
  for (const [rel, content] of Object.entries(fileMap)) {
    let title = rel.split('/').pop().replace(/\.(mdx?|md)$/, '');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (fm) { const tm = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m); if (tm) title = tm[1]; }
    pageTitles[rel] = title;
    const links = [];
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    while ((m = re.exec(content)) !== null) links.push(m[1].trim());
    pageLinks[rel] = links;
  }
  const visited = new Set();
  const readingPath = [];
  function walk(filePath, depth) {
    if (depth > maxDepth || visited.has(filePath)) return;
    visited.add(filePath);
    readingPath.push({ path: filePath, title: pageTitles[filePath] || filePath, depth });
    for (const link of (pageLinks[filePath] || [])) {
      const resolved = Object.keys(pageTitles).find(p => p.endsWith(link + '.md') || p.endsWith(link + '.mdx') || p.includes('/' + link + '.'));
      if (resolved && !visited.has(resolved)) walk(resolved, depth + 1);
    }
  }
  walk(startPath, 0);
  return { startPath, readingPath, totalPages: readingPath.length, maxDepthReached: Math.max(0, ...readingPath.map(p => p.depth)) };
}

// A flat content/ tree that exercises every branch of the resolver:
//   start -> hub -> {guide -> deep, loop-a <-> loop-b}
// - guide.md and extra-guide.md BOTH satisfy endsWith('guide.md'), so [[guide]] is
//   ambiguous; guide.md appears first in key order and must win every time.
// - loop-a.md and loop-b.md link to each other, so the visited dedup must stop the
//   cycle (each appears exactly once, no infinite recursion).
// - deep.md sits one hop past guide, so a maxDepth cut-off drops it (and loop-b).
const FIXTURE = {
  'content/start.md': '---\ntitle: Start\n---\nbegin at the [[hub]]\n',
  'content/hub.md': '---\ntitle: Hub\n---\nread the [[guide]] and also [[loop-a]]\n',
  'content/guide.md': '---\ntitle: Guide\n---\ncontinue to [[deep]] material\n',
  'content/extra-guide.md': '---\ntitle: Extra Guide\n---\na decoy ending in guide; see [[deep]]\n',
  'content/deep.md': '---\ntitle: Deep\n---\nyou have arrived, no links here\n',
  'content/loop-a.md': '---\ntitle: Loop A\n---\nover to [[loop-b]]\n',
  'content/loop-b.md': '---\ntitle: Loop B\n---\nback to [[loop-a]]\n',
};

// Hand-traced pre-hoist output for start=content/start.md at the default depth (3).
// Field order matches the handler's returned literal
// ({startPath, readingPath, totalPages, maxDepthReached}) and each step
// ({path, title, depth}), so the JSON.stringify check below pins serialization, not
// just structural equality. The walk is start(0) -> hub(1) -> guide(2) -> deep(3),
// then back up to hub's second link loop-a(2) -> loop-b(3); loop-b's [[loop-a]] is
// already visited and is skipped.
const EXPECTED_START_D3 = {
  startPath: 'content/start.md',
  readingPath: [
    { path: 'content/start.md', title: 'Start', depth: 0 },
    { path: 'content/hub.md', title: 'Hub', depth: 1 },
    { path: 'content/guide.md', title: 'Guide', depth: 2 },
    { path: 'content/deep.md', title: 'Deep', depth: 3 },
    { path: 'content/loop-a.md', title: 'Loop A', depth: 2 },
    { path: 'content/loop-b.md', title: 'Loop B', depth: 3 },
  ],
  totalPages: 6,
  maxDepthReached: 3,
};

describe('GET /api/content-reading-path hoists Object.keys(pageTitles) into pageTitleKeys (behavior-preserving)', () => {
  it('returns the hand-traced payload byte-identically and deep-equals the independent reference (depth 3)', async () => {
    const res = await invoke(FIXTURE, '?start=content/start.md');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_START_D3);
    // Byte-identity: same fields, same order, same serialization as the literal.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_START_D3));
    // And it matches a fresh re-computation of the pre-hoist algorithm.
    assert.deepEqual(res.payload, referenceReadingPath(FIXTURE, 'content/start.md', 3));
  });

  it('resolves the ambiguous [[guide]] suffix to the first key (guide.md), never the later decoy (extra-guide.md)', async () => {
    const res = await invoke(FIXTURE, '?start=content/start.md');
    assert.equal(res.status, 200);
    const paths = res.payload.readingPath.map(p => p.path);
    // guide.md and extra-guide.md both endsWith('guide.md'); first-in-key-order wins.
    assert.ok(paths.includes('content/guide.md'), 'the first matching key (guide.md) is chosen');
    assert.ok(!paths.includes('content/extra-guide.md'), 'the later ambiguous key (extra-guide.md) is never chosen');
    // The reference (fresh Object.keys each lookup) makes the same first-match choice.
    const refPaths = referenceReadingPath(FIXTURE, 'content/start.md', 3).readingPath.map(p => p.path);
    assert.deepEqual(paths, refPaths);
  });

  it('honors the maxDepth cut-off and deep-equals the reference at depth 2', async () => {
    const res = await invoke(FIXTURE, '?start=content/start.md&depth=2');
    assert.equal(res.status, 200);
    const paths = res.payload.readingPath.map(p => p.path);
    // deep (would be depth 3) and loop-b (would be depth 3) are cut off at depth 2.
    assert.ok(!paths.includes('content/deep.md'), 'deep.md is beyond maxDepth 2');
    assert.ok(!paths.includes('content/loop-b.md'), 'loop-b.md is beyond maxDepth 2');
    assert.equal(res.payload.maxDepthReached, 2);
    assert.deepEqual(res.payload, referenceReadingPath(FIXTURE, 'content/start.md', 2));
  });

  it('breaks the loop-a <-> loop-b cycle via the visited dedup (each page visited once)', async () => {
    const res = await invoke(FIXTURE, '?start=content/loop-a.md');
    assert.equal(res.status, 200);
    const paths = res.payload.readingPath.map(p => p.path);
    assert.deepEqual(paths, ['content/loop-a.md', 'content/loop-b.md']);
    assert.equal(paths.filter(p => p === 'content/loop-a.md').length, 1, 'loop-a is visited exactly once');
    assert.equal(paths.filter(p => p === 'content/loop-b.md').length, 1, 'loop-b is visited exactly once');
    assert.deepEqual(res.payload, referenceReadingPath(FIXTURE, 'content/loop-a.md', 3));
  });

  it('a link that resolves to nothing leaves the path unchanged (pageTitleKeys.find returns undefined)', async () => {
    // solo.md links to [[ghost]], which no key satisfies, so .find returns undefined
    // and the start node is the whole path, exactly as before the hoist.
    const noMatch = { 'content/solo.md': '---\ntitle: Solo\n---\npoints at [[ghost]] which has no page\n' };
    const res = await invoke(noMatch, '?start=content/solo.md');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, {
      startPath: 'content/solo.md',
      readingPath: [{ path: 'content/solo.md', title: 'Solo', depth: 0 }],
      totalPages: 1,
      maxDepthReached: 0,
    });
    assert.deepEqual(res.payload, referenceReadingPath(noMatch, 'content/solo.md', 3));
  });

  it('the reading-path handler source computes the key list once and keeps no per-resolution rebuild', () => {
    const src = readFileSync(new URL('../../../../../server/routes/content-analysis-a.js', import.meta.url), 'utf-8');
    // Slice the handler block between its route guard and the next handler's guard
    // (both ASCII string literals, so the slice does not depend on box-drawing
    // comment markers). The assertions then target only this handler.
    const startIdx = src.indexOf("'/api/content-reading-path'");
    const endIdx = src.indexOf("'/api/references/export-json'");
    assert.ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, 'handler block anchors present and ordered');
    const block = src.slice(startIdx, endIdx);
    assert.ok(block.includes('const pageTitleKeys = Object.keys(pageTitles)'), 'the key list is hoisted once into pageTitleKeys');
    assert.ok(block.includes('pageTitleKeys.find('), 'the resolver reuses the hoisted pageTitleKeys');
    assert.ok(!block.includes('Object.keys(pageTitles).find('), 'no per-resolution Object.keys(pageTitles).find rebuild remains');
  });
});
