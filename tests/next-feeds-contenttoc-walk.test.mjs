import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the real module the way the sibling server route
// tests do (see tests/next-feeds-schedule-write-guards.test.mjs and
// tests/next-content-a-filemicro-cache.test.mjs), so these cases exercise the
// shipped GET /api/content-toc handler in server/routes/feeds.js rather than a
// reimplementation. This is an add-only characterization test: it pins the
// current, correct behavior of the recursive content table of contents walk and
// edits no source file.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

const PROJECT_ROOT = '/virtual';
// The directory the handler walks: path.join(PROJECT_ROOT, 'content'). The whole
// virtual tree is rooted here so the first readdirSync resolves, and every node
// path equals path.relative(PROJECT_ROOT, fullPath).
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');

// ── cached helpers (mirroring tests/next-content-a-filemicro-cache.test.mjs) ──

// A non-memoizing pass-through cached: it always runs fn(), reproducing the exact
// pre-cache code path. Used for the walk cases and the 500 path. Every call is
// recorded so a test can pin the key and the TTL the handler passes.
function passThroughCached() {
  const calls = [];
  const cached = (key, ttl, fn) => { calls.push({ key, ttl }); return fn(); };
  return { cached, calls };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js
// helper: run fn and store on a miss, return the stored value untouched on a hit.
// Used for the cache-hit case so a second GET provably reuses the stored toc.
function makeCached() {
  const store = new Map();
  const calls = [];
  const cached = (key, ttl, fn) => {
    calls.push({ key, ttl });
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return { cached, store, calls };
}

// ── in-memory filesystem ──

// Mark a tree node as a subdirectory. Any other value in a tree spec is a file
// whose string value is its content (including each _category_.json file).
function dir(children) { return { __dir: children }; }

// Build a pure in-memory fs from a nested tree rooted at rootPath. readdirSync
// returns Dirent-like {name, isDirectory()} objects in declaration order, so a
// test can seed entries out of order and assert the handler sorts them itself.
// existsSync and readFileSync are keyed by absolute path. An unregistered
// directory throws like ENOENT, which drives the 500 path. readdirSync calls are
// counted so the cache-hit case can prove the second GET performs no fresh walk.
// The real filesystem is never touched.
function makeFs(rootPath, rootChildren) {
  const dirs = new Map();
  const files = new Map();
  const counts = { readdirSync: 0 };
  (function walk(dirPath, children) {
    const entries = [];
    for (const name of Object.keys(children)) {
      const value = children[name];
      const full = path.join(dirPath, name);
      if (value && typeof value === 'object' && value.__dir) {
        entries.push({ name, isDirectory: () => true });
        walk(full, value.__dir);
      } else {
        entries.push({ name, isDirectory: () => false });
        files.set(full, value);
      }
    }
    dirs.set(dirPath, entries);
  })(rootPath, rootChildren);

  const fs = {
    readdirSync(dirPath) {
      counts.readdirSync++;
      if (!dirs.has(dirPath)) {
        const e = new Error(`ENOENT: missing directory ${dirPath}`);
        e.code = 'ENOENT';
        throw e;
      }
      // The handler sorts the result in place, so return a copy and keep the
      // registered declaration order intact for any later readdir of the dir.
      return dirs.get(dirPath).slice();
    },
    existsSync(p) { return files.has(p) || dirs.has(p); },
    readFileSync(p) {
      if (!files.has(p)) {
        const e = new Error(`ENOENT: missing file ${p}`);
        e.code = 'ENOENT';
        throw e;
      }
      return files.get(p);
    },
  };
  return { fs, dirs, files, counts };
}

// Drive the real GET /api/content-toc handler over a mocked ctx. fs and cached
// are supplied per case; path is the real node:path; ALLOWED_EXTS matches the
// server default; json captures the (status, payload) the handler hands back. No
// real filesystem, network, or git is touched.
async function invoke({ fs, cached }) {
  const pathname = '/api/content-toc';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await feedsRoutes(req, res, url, pathname, ctx);
  return captured;
}

describe('GET /api/content-toc (recursive content table of contents in routes/feeds.js)', () => {
  it('routes through cached("content-toc", 30000) and returns 200 {toc} on success', async () => {
    const { fs } = makeFs(CONTENT_DIR, { 'intro.md': '' });
    const { cached, calls } = makeCached();
    const r = await invoke({ fs, cached });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.payload), ['toc']);
    assert.ok(Array.isArray(r.payload.toc));
    assert.equal(calls.length, 1, 'cached is called exactly once');
    assert.equal(calls[0].key, 'content-toc');
    assert.equal(calls[0].ttl, 30000);
  });

  it('emits a directory node {type,name,title,children,path} defaulting title to the dir name', async () => {
    const { fs } = makeFs(CONTENT_DIR, { 'guides': dir({ 'a.md': '' }) });
    const { cached } = passThroughCached();
    const r = await invoke({ fs, cached });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.toc, [
      {
        type: 'directory',
        name: 'guides',
        title: 'guides',
        children: [
          { type: 'file', name: 'a.md', title: 'a', path: 'content/guides/a.md' },
        ],
        path: 'content/guides',
      },
    ]);
  });

  it('overrides a directory title with a truthy _category_.json label', async () => {
    const { fs } = makeFs(CONTENT_DIR, {
      'guides': dir({ '_category_.json': '{"label":"Guided Tours"}', 'a.md': '' }),
    });
    const { cached } = passThroughCached();
    const r = await invoke({ fs, cached });
    assert.equal(r.status, 200);
    assert.equal(r.payload.toc.length, 1);
    const node = r.payload.toc[0];
    assert.equal(node.type, 'directory');
    assert.equal(node.name, 'guides');
    assert.equal(node.title, 'Guided Tours');
    // The _category_.json file itself starts with _ so it yields no child node.
    assert.deepEqual(node.children.map((c) => c.name), ['a.md']);
  });

  it('falls back to the dir name when _category_.json is malformed or lacks a truthy label', async () => {
    // Malformed JSON: JSON.parse throws, the inner catch swallows it, title stays the name.
    const malformed = makeFs(CONTENT_DIR, {
      'broken': dir({ '_category_.json': 'this is { not json', 'a.md': '' }),
    });
    const r1 = await invoke({ fs: malformed.fs, cached: passThroughCached().cached });
    assert.equal(r1.payload.toc[0].title, 'broken');

    // Valid JSON but no label key: cat.label is falsy, so title stays the name.
    const noLabel = makeFs(CONTENT_DIR, {
      'plain': dir({ '_category_.json': '{"position":1}', 'a.md': '' }),
    });
    const r2 = await invoke({ fs: noLabel.fs, cached: passThroughCached().cached });
    assert.equal(r2.payload.toc[0].title, 'plain');
  });

  it('reads a file node title from a leading frontmatter title: line', async () => {
    const { fs } = makeFs(CONTENT_DIR, {
      'post.md': '---\ntitle: Hello World\n---\n\n# Body\n',
    });
    const r = await invoke({ fs, cached: passThroughCached().cached });
    assert.deepEqual(r.payload.toc, [
      { type: 'file', name: 'post.md', title: 'Hello World', path: 'content/post.md' },
    ]);
  });

  it('falls back to the filename without its .md or .mdx extension when there is no frontmatter title', async () => {
    const { fs } = makeFs(CONTENT_DIR, {
      'guide.mdx': 'plain text\n',
      'plain.md': '# Heading only\n',
    });
    const r = await invoke({ fs, cached: passThroughCached().cached });
    assert.deepEqual(r.payload.toc, [
      { type: 'file', name: 'guide.mdx', title: 'guide', path: 'content/guide.mdx' },
      { type: 'file', name: 'plain.md', title: 'plain', path: 'content/plain.md' },
    ]);
  });

  it('skips dot and underscore entries, including a top-level _category_.json file', async () => {
    const { fs } = makeFs(CONTENT_DIR, {
      '.hidden': '',
      '_draft.md': 'secret\n',
      '_category_.json': '{"label":"ignored"}',
      'visible.md': 'shown\n',
    });
    const r = await invoke({ fs, cached: passThroughCached().cached });
    assert.deepEqual(r.payload.toc.map((n) => n.name), ['visible.md']);
  });

  it('ignores a file whose extension is not in ALLOWED_EXTS', async () => {
    const { fs } = makeFs(CONTENT_DIR, {
      'image.png': 'binary',
      'doc.md': 'real\n',
    });
    const r = await invoke({ fs, cached: passThroughCached().cached });
    assert.deepEqual(r.payload.toc.map((n) => n.name), ['doc.md']);
  });

  it('orders sibling entries by name.localeCompare even when readdir returns them unsorted', async () => {
    const { fs } = makeFs(CONTENT_DIR, {
      'zebra.md': '',
      'apple.md': '',
      'mango.md': '',
    });
    const r = await invoke({ fs, cached: passThroughCached().cached });
    assert.deepEqual(r.payload.toc.map((n) => n.name), ['apple.md', 'mango.md', 'zebra.md']);
  });

  it('recurses so a nested file appears under its parent directory children', async () => {
    const { fs } = makeFs(CONTENT_DIR, {
      'parent': dir({
        'child.md': '',
        'sub': dir({ 'leaf.md': '' }),
      }),
    });
    const r = await invoke({ fs, cached: passThroughCached().cached });
    assert.equal(r.payload.toc.length, 1);
    const parent = r.payload.toc[0];
    assert.equal(parent.type, 'directory');
    assert.equal(parent.name, 'parent');
    assert.equal(parent.path, 'content/parent');
    // child.md (a file) sorts before sub (a directory) by localeCompare.
    assert.deepEqual(parent.children.map((c) => c.name), ['child.md', 'sub']);
    const sub = parent.children.find((c) => c.name === 'sub');
    assert.equal(sub.type, 'directory');
    assert.deepEqual(sub.children, [
      { type: 'file', name: 'leaf.md', title: 'leaf', path: 'content/parent/sub/leaf.md' },
    ]);
  });

  it('returns 500 {error: "TOC generation failed"} when readdirSync throws', async () => {
    // An fs whose readdirSync always throws: the first walk of the content dir
    // throws, the error propagates out of the cached fn, and the outer catch
    // returns the 500 envelope. Pass-through cached runs fn, so the walk genuinely
    // executes and throws.
    const throwingFs = {
      readdirSync() { throw new Error('boom'); },
      existsSync() { return false; },
      readFileSync() { throw new Error('boom'); },
    };
    const { cached, calls } = passThroughCached();
    const r = await invoke({ fs: throwingFs, cached });
    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'TOC generation failed' });
    assert.ok(calls.length >= 1, 'the handler reaches cached() inside the try');
  });

  it('serves a second GET from the stored toc without a fresh readdirSync walk', async () => {
    const { fs, counts } = makeFs(CONTENT_DIR, {
      'a.md': '',
      'b.md': '',
    });
    const { cached, store } = makeCached();

    const first = await invoke({ fs, cached });
    assert.equal(first.status, 200);
    const readsAfterFirst = counts.readdirSync;
    assert.ok(readsAfterFirst >= 1, 'the first GET walks the content dir');
    assert.equal(store.size, 1, 'one cache entry for the content-toc key');
    assert.ok(store.has('content-toc'));

    const second = await invoke({ fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    assert.equal(second.payload.toc, first.payload.toc, 'the repeat returns the stored toc reference');
    assert.equal(counts.readdirSync, readsAfterFirst, 'the cached repeat performs no new readdirSync');
  });
});
