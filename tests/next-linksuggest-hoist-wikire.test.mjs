import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];
const TARGET = 'content/index.md';

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// GET /api/file/link-suggestions only touches readFileSync (the target page read
// plus a read of each candidate page that clears the word-overlap filter) and
// readdirSync (the recursive content walk with {withFileTypes:true}); the stub
// returns entries shaped the way the walk expects and ignores the encoding arg.
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

// Drive GET /api/file/link-suggestions with a mocked ctx and capture the response
// handed to json(res, status, payload). Fully in-process: no network, no server.
async function invokeLinkSuggestions(fs, filePath, { isValidFilePath = () => true } = {}) {
  const url = new URL(`http://localhost/api/file/link-suggestions?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    isValidFilePath,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/link-suggestions', ctx);
  return captured;
}

// The target already links to [[Transformers]] and [[Attention]] and also uses
// "transformers", "attention", "embeddings" and "reinforcement" as long-enough
// prose words. The word-overlap filter on its own would surface transformers.md
// and attention.md too, but the existing-link set (built by the hoisted wiki
// regex) must exclude both, leaving only embeddings.md and the hyphenated
// reinforcement-learning.md (matched on its "reinforcement" segment). unrelated.md
// shares no word, and diagram.png is filtered out by extension.
const FIXTURE = {
  'content/index.md': `---
title: Research Notes
---

This note already references [[Transformers]] and [[Attention]].

It also discusses embeddings and reinforcement strategies in depth.
`,
  'content/transformers.md': '---\ntitle: Transformers\n---\n\nAbout transformers.\n',
  'content/attention.md': '---\ntitle: Attention\n---\n\nAbout attention.\n',
  'content/embeddings.md': '---\ntitle: Embeddings Explained\n---\n\nAbout embeddings.\n',
  'content/reinforcement-learning.md': 'Body about reinforcement learning, no front matter.\n',
  'content/unrelated.md': '---\ntitle: Unrelated\n---\n\nNothing overlaps here.\n',
  'content/diagram.png': 'not markdown\n',
};

// Suggestions follow the content/ walk order. Titles come from front matter when
// present (embeddings.md) and fall back to the filename stem otherwise
// (reinforcement-learning.md).
const EXPECTED = {
  suggestions: [
    { path: 'content/embeddings.md', title: 'Embeddings Explained', pageName: 'embeddings' },
    { path: 'content/reinforcement-learning.md', title: 'reinforcement-learning', pageName: 'reinforcement-learning' },
  ],
  total: 2,
};

describe('GET /api/file/link-suggestions (LINKSUGGEST_WIKI_RE hoisted to module scope)', () => {
  it('extracts existing wiki links and suggests only unlinked, word-overlapping pages', async () => {
    const r = await invokeLinkSuggestions(makeFs(FIXTURE), TARGET);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
    // The pages the target already links to are excluded even though their names
    // appear in the prose, which pins the existing-link extraction.
    const names = r.payload.suggestions.map(s => s.pageName);
    assert.ok(!names.includes('transformers'));
    assert.ok(!names.includes('attention'));
  });

  it('returns identical suggestions on a second back-to-back request', async () => {
    // LINKSUGGEST_WIKI_RE is module scope and shared across requests, so two
    // identical requests must yield the same suggestions, both matching EXPECTED.
    const fs = makeFs(FIXTURE);
    const first = await invokeLinkSuggestions(fs, TARGET);
    const second = await invokeLinkSuggestions(fs, TARGET);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, EXPECTED);
    assert.deepEqual(second.payload, first.payload);
  });

  it('stays correct when LINKSUGGEST_WIKI_RE carries a stale lastIndex (the per-request reset is load-bearing)', async () => {
    // The handler resets LINKSUGGEST_WIKI_RE.lastIndex to 0 before its exec loop.
    // Pre-seed a large lastIndex to simulate state leaking in from a prior request,
    // then confirm the suggestions are still correct. Without the reset the first
    // exec would start past the content, return null at once, and the existing-link
    // set would be empty, so transformers.md and attention.md would wrongly surface
    // as suggestions. This proves the reset, not the loop's drain-to-null, is what
    // guarantees correctness against a leaked lastIndex.
    assert.ok(routes.LINKSUGGEST_WIKI_RE instanceof RegExp, 'handler regex is exported for this guard');
    routes.LINKSUGGEST_WIKI_RE.lastIndex = 100000;
    const r = await invokeLinkSuggestions(makeFs(FIXTURE), TARGET);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('rejects an invalid path with 400 without reading the filesystem', async () => {
    const r = await invokeLinkSuggestions(makeFs(FIXTURE), '../secret', { isValidFilePath: () => false });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid path' });
  });
});
