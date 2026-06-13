import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS, so load the REAL module via createRequire (the
// same way the sibling per-key cache suite next-content-b-ref-caches.test.mjs does)
// and reuse its ctx-mocking shape. These tests pin GET /api/content-update-suggestions:
// the priority-scoring scan that walks content/ and reports files worth revisiting.
// Everything is driven over a mocked ctx with an in-memory fs, so there is no real
// filesystem, network, or git, and every asserted field is a deterministic function
// of the fixture content.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const EP = '/api/content-update-suggestions';
const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`. It synthesizes
// the directory tree so readdirSync({withFileTypes:true}) and readFileSync serve the
// fixture, and readdirSync of a directory that was never declared throws ENOENT (the
// hook the 500 path relies on).
//
// Gotcha pinned here: the handler calls fs.statSync(fp) for every scanned file (the
// stat value is never read, it is only computed). The sibling makeCountingFs supplies
// only readdirSync and readFileSync, so a verbatim copy would leave statSync undefined,
// the call would throw, the per-file inner catch would swallow it, and EVERY file would
// be silently skipped, leaving suggestions permanently empty. This stub therefore adds
// a non-throwing statSync that returns a plain object, which keeps the scan alive.
function makeCountingFs(fileMap) {
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

  const counts = { readdirSync: 0, readFileSync: 0, statSync: 0 };
  const fs = {
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
    // Required: the handler stats every file. The return value is never inspected, so
    // any non-throwing object keeps the per-file try block from bailing out.
    statSync() { counts.statSync++; return {}; },
  };
  return { fs, counts };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js
// helper: run fn and store on a miss, return the stored value on a hit, store nothing
// when fn throws (so a 500 stays uncached). Every call records its key and ttl so a
// test can pin the exact arguments the handler passes.
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

// Build a fresh ctx bundle for one fixture: the in-memory fs plus a memoizing cached
// and its observable store/calls.
function harness(fileMap) {
  const { fs, counts } = makeCountingFs(fileMap);
  const { cached, store, calls } = makeCached();
  return { fs, counts, cached, store, calls };
}

// Invoke the GET handler with a mocked ctx and capture the response handed to
// json(res, status, payload).
async function invoke(pathname, { fs, cached }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// Build a body of exactly n whitespace-separated words. Word count is
// content.split(/\s+/).filter(Boolean).length, so n single-space-joined tokens
// contribute exactly n to the count, letting fixtures land precisely above or below
// the 100 / 500 / 1000 word thresholds.
const words = n => Array(n).fill('word').join(' ');

describe('GET /api/content-update-suggestions (cached("update-suggestions", 120000))', () => {
  // Each scoring rule fires with its exact reason string and priority increment. Every
  // fixture below is complete and healthy in every OTHER dimension, so exactly one rule
  // trips and the reason/priority can be pinned in isolation.

  it('flags very short content with "Very short content (< 100 words)" and priority += 3', async () => {
    // Full frontmatter (title + tags) and only 11 words, so only the word-count rule fires.
    const res = await invoke(EP, harness({ 'content/short.md': '---\ntitle: Short Doc\ntags: [a]\n---\nA few words here.' }));
    assert.equal(res.status, 200);
    assert.equal(res.payload.suggestions.length, 1);
    const item = res.payload.suggestions[0];
    assert.deepEqual(item.reasons, ['Very short content (< 100 words)']);
    assert.equal(item.priority, 3);
    assert.equal(item.wordCount, 11);
    assert.equal(item.title, 'Short Doc');
    assert.equal(item.path, 'content/short.md');
  });

  it('flags a file with no frontmatter with "Missing frontmatter" and priority += 2', async () => {
    // 120 words and no frontmatter block, so only the missing-frontmatter rule fires
    // (the missing-title branch is an else of this one and the no-tags rule needs a
    // frontmatter block, so neither can fire here).
    const res = await invoke(EP, harness({ 'content/nofm.md': words(120) }));
    assert.equal(res.status, 200);
    assert.equal(res.payload.suggestions.length, 1);
    const item = res.payload.suggestions[0];
    assert.deepEqual(item.reasons, ['Missing frontmatter']);
    assert.equal(item.priority, 2);
    assert.equal(item.wordCount, 120);
  });

  it('flags frontmatter without a title with "Missing title in frontmatter" and priority += 2', async () => {
    // Frontmatter is present (so missing-frontmatter cannot fire) and carries tags (so
    // no-tags cannot fire) but no title line, so only the missing-title branch fires.
    const res = await invoke(EP, harness({ 'content/notitle.md': '---\ntags: [x]\n---\n' + words(120) }));
    assert.equal(res.status, 200);
    const item = res.payload.suggestions[0];
    assert.deepEqual(item.reasons, ['Missing title in frontmatter']);
    assert.equal(item.priority, 2);
    // No title line, so the title falls back to the filename without its extension.
    assert.equal(item.title, 'notitle');
  });

  it('flags frontmatter without tags with "No tags defined" and priority += 1', async () => {
    // Frontmatter present with a title (so the frontmatter and title rules stay quiet)
    // but no tags line, so only the no-tags rule fires.
    const res = await invoke(EP, harness({ 'content/notags.md': '---\ntitle: Doc4\n---\n' + words(120) }));
    assert.equal(res.status, 200);
    const item = res.payload.suggestions[0];
    assert.deepEqual(item.reasons, ['No tags defined']);
    assert.equal(item.priority, 1);
    assert.equal(item.title, 'Doc4');
  });

  it('flags long content with few headings with "Long content with few headings" and priority += 2', async () => {
    // 606 words (over 500, under 1000) with zero headings and full frontmatter, so only
    // the long-with-few-headings rule fires (the long-with-no-images rule needs over 1000).
    const res = await invoke(EP, harness({ 'content/long5.md': '---\ntitle: Doc5\ntags: [y]\n---\n' + words(600) }));
    assert.equal(res.status, 200);
    const item = res.payload.suggestions[0];
    assert.deepEqual(item.reasons, ['Long content with few headings']);
    assert.equal(item.priority, 2);
    assert.equal(item.wordCount, 606);
  });

  it('flags long content with no images with "Long content with no images" and priority += 1', async () => {
    // 1110 words (over 1000) with two headings (so the few-headings rule stays quiet)
    // and no image markup, so only the long-with-no-images rule fires.
    const res = await invoke(EP, harness({ 'content/long6.md': '---\ntitle: Doc6\ntags: [z]\n---\n## H1\n## H2\n' + words(1100) }));
    assert.equal(res.status, 200);
    const item = res.payload.suggestions[0];
    assert.deepEqual(item.reasons, ['Long content with no images']);
    assert.equal(item.priority, 1);
    assert.equal(item.wordCount, 1110);
  });

  it('accumulates priority across every tripped rule (short and no frontmatter sums to 5)', async () => {
    // Three words and no frontmatter trips both the word-count rule (+3) and the
    // missing-frontmatter rule (+2), pushed in that source order, summing to 5.
    const res = await invoke(EP, harness({ 'content/tiny.md': 'tiny note here' }));
    assert.equal(res.status, 200);
    const item = res.payload.suggestions[0];
    assert.deepEqual(item.reasons, ['Very short content (< 100 words)', 'Missing frontmatter']);
    assert.equal(item.priority, 5);
  });

  it('excludes a healthy complete file (reasons.length === 0 is filtered out)', async () => {
    // 130 words, frontmatter with both title and tags, two headings, and under the long
    // thresholds, so no rule fires and the file never enters the suggestions list.
    const healthy = '---\ntitle: Healthy\ntags: [ok]\n---\n## A\n## B\n' + words(120);
    const res = await invoke(EP, harness({ 'content/healthy.md': healthy }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, { suggestions: [], total: 0 });
  });

  it('returns {suggestions, total} with total === length and the documented item shape', async () => {
    const res = await invoke(EP, harness({ 'content/note.md': 'A short note here.' }));
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.payload), ['suggestions', 'total']);
    assert.equal(res.payload.total, res.payload.suggestions.length);
    assert.equal(res.payload.total, 1);
    const item = res.payload.suggestions[0];
    // Exact key set and order, so a refactor cannot quietly add, drop, or reorder fields.
    assert.deepEqual(Object.keys(item), ['path', 'title', 'reasons', 'priority', 'wordCount']);
    // path is relative to PROJECT_ROOT, not absolute.
    assert.equal(item.path, 'content/note.md');
    assert.equal(item.title, 'note');
    assert.equal(item.wordCount, 4);
  });

  it('sorts suggestions by priority descending', async () => {
    // Declared in a non-sorted discovery order to prove the handler sorts the result
    // rather than echoing traversal order. The three priorities are distinct (1, 2, 5),
    // so the expected order does not depend on sort stability.
    const res = await invoke(EP, harness({
      'content/p1.md': '---\ntitle: Doc1\n---\n' + words(120), // no tags => priority 1
      'content/p5.md': 'tiny', // short + no frontmatter => priority 5
      'content/p2.md': words(120), // no frontmatter => priority 2
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload.suggestions.map(s => s.priority), [5, 2, 1]);
    assert.deepEqual(res.payload.suggestions.map(s => s.path), ['content/p5.md', 'content/p2.md', 'content/p1.md']);
  });

  it('extracts the frontmatter title, else falls back to the filename without extension', async () => {
    const res = await invoke(EP, harness({
      'content/my-doc.md': '---\ntitle: My Great Doc\ntags: [t]\n---\ntiny',
      'content/untitled.mdx': 'tiny',
    }));
    assert.equal(res.status, 200);
    const byPath = Object.fromEntries(res.payload.suggestions.map(s => [s.path, s.title]));
    assert.equal(byPath['content/my-doc.md'], 'My Great Doc');
    // No frontmatter, so the .mdx extension is stripped from the filename.
    assert.equal(byPath['content/untitled.mdx'], 'untitled');
  });

  it('recurses into subdirectories and skips dot, underscore, and non-markdown entries', async () => {
    // deep.md sits under a nested directory and must be discovered by the recursion.
    // The other four entries would each trip a rule if scanned, so their absence from
    // the result proves the skip rules: a dot-prefixed file, an underscore-prefixed
    // file, a non-markdown file, and a file under an underscore-prefixed directory
    // (the directory is skipped before recursion).
    const res = await invoke(EP, harness({
      'content/nested/deep.md': 'tiny',
      'content/.hidden.md': 'tiny',
      'content/_draft.md': 'tiny',
      'content/notes.txt': 'tiny',
      'content/_private/secret.md': 'tiny',
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload.suggestions.map(s => s.path), ['content/nested/deep.md']);
  });

  it('returns 500 {error: "Suggestions failed"} when the scan throws, and caches nothing', async () => {
    // With no content/ directory declared, readdirSync of the content root throws, the
    // throw escapes the cached closure (so nothing is stored) and the outer catch sends
    // the 500 envelope.
    const ctx = harness({});
    const res = await invoke(EP, ctx);
    assert.deepEqual(res, { status: 500, payload: { error: 'Suggestions failed' } });
    assert.equal(ctx.store.size, 0);
  });

  it('memoizes the scan under cache key "update-suggestions" with a 120000 ms TTL', async () => {
    const ctx = harness({ 'content/tiny.md': 'tiny' });
    await invoke(EP, ctx);
    assert.ok(ctx.calls.length >= 1, 'the handler routes through cached()');
    assert.equal(ctx.calls[0].key, 'update-suggestions');
    assert.equal(ctx.calls[0].ttl, 120000);
  });
});
