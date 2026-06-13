import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it via createRequire the way the sibling suites do
// (next-filetools-suggesttags-cache.test.mjs, next-filetools-microcache.test.mjs) and reuse
// their ctx-mocking shape. GET /api/file/suggest-tags loops over the corpus tag set and, for
// each tag whose body frequency clears the bar, pushes {tag, confidence}. The handler now
// binds `const tagFreq = freq[tagLower]` once and reuses it across the truthiness guard, the
// `>= 2` comparison, and `Math.min(tagFreq / 5, 1)`. These tests drive the real handler over
// a mocked ctx and pin the suggestions and their confidence values, so a wrong dedup (binding
// the frequency to the wrong key, or dropping the guard) would change the asserted output.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from a `${rel-from-PROJECT_ROOT}: content` map. The handler touches
// readFileSync (the source file, then each corpus file during the all-tags-set scan) and
// readdirSync (the recursive content walk with {withFileTypes:true}). A missing path throws
// ENOENT exactly like the real fs, so the closure throws and the outer catch returns 404.
function makeFs(fileMap) {
  const dirs = new Map();         // absDir -> Map<name, isDir>
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

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js helper: run
// fn and store on a miss, return the stored value untouched on a hit. The handler enters it
// twice per call (the outer suggesttags: payload, then the inner all-tags-set corpus scan).
function makeCached() {
  const store = new Map();
  return (key, ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
}

// Invoke the GET /api/file/suggest-tags handler with a mocked ctx and capture the response
// handed to json(res, status, payload). isValidFilePath defaults to accepting the path so the
// happy path reaches the file read.
async function invoke(filePath, { fs, cached, isValidFilePath = () => true }) {
  const pathname = '/api/file/suggest-tags';
  const url = new URL(`http://localhost${pathname}?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    isValidFilePath,
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── fixture ──

// One content file whose frontmatter declares five single-word tags (no hyphens, so the
// hyphenated branch never fires) at distinct body frequencies that map cleanly onto the
// confidence formula:
//   transformer x6 -> Math.min(6/5, 1) = 1     (frequency above 5 is clamped at 1)
//   networks    x4 -> Math.min(4/5, 1) = 0.8
//   neural      x2 -> Math.min(2/5, 1) = 0.4   (exactly on the `>= 2` boundary)
//   gradient    x1 -> below the `>= 2` bar, so it is omitted
//   attention   x0 -> absent from the body, so freq[attention] is undefined and omitted
// Frontmatter is stripped before the word count, so only the body drives the frequencies. The
// final list is sorted by confidence descending. Every tag word has length > 3 and none is a
// stop word, so all survive the keyword filter.
const SRC_REL = 'content/source.md';
const SRC =
  '---\n' +
  'title: Source\n' +
  'tags: [neural, networks, transformer, gradient, attention]\n' +
  '---\n' +
  'transformer transformer transformer transformer transformer transformer ' +
  'networks networks networks networks neural neural gradient\n';

const SRC_EXPECTED = {
  suggestions: [
    { tag: 'transformer', confidence: 1 },
    { tag: 'networks', confidence: 0.8 },
    { tag: 'neural', confidence: 0.4 },
  ],
  topKeywords: ['transformer', 'networks', 'neural', 'gradient'],
};

describe('GET /api/file/suggest-tags confidence from the deduped tagFreq', () => {
  it('suggests each corpus tag with body frequency >= 2 at confidence Math.min(freq/5, 1)', async () => {
    const r = await invoke(SRC_REL, { fs: makeFs({ [SRC_REL]: SRC }), cached: makeCached() });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, SRC_EXPECTED);
  });

  it('clamps the confidence at 1 once the frequency reaches 5', async () => {
    const r = await invoke(SRC_REL, { fs: makeFs({ [SRC_REL]: SRC }), cached: makeCached() });
    const transformer = r.payload.suggestions.find(s => s.tag === 'transformer');
    // transformer appears 6 times, so the raw 6/5 = 1.2 must be capped at exactly 1.
    assert.equal(transformer.confidence, 1);
  });

  it('omits a tag whose body frequency is below the >= 2 guard', async () => {
    const r = await invoke(SRC_REL, { fs: makeFs({ [SRC_REL]: SRC }), cached: makeCached() });
    const tags = r.payload.suggestions.map(s => s.tag);
    // gradient occurs once (fails `tagFreq >= 2`); attention never occurs (tagFreq is falsy).
    assert.ok(!tags.includes('gradient'), 'a frequency of 1 must not be suggested');
    assert.ok(!tags.includes('attention'), 'a tag absent from the body must not be suggested');
  });
});
