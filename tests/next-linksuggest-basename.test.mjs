import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];
const TARGET = 'content/index.md';

// In-memory fs stub built from `${rel-from-PROJECT_ROOT}: content`, the shape the
// link-suggestions walk expects: readdirSync returns {withFileTypes}-style entries
// in insertion order (so the fixture order is the walk order), and readFileSync
// serves the stored body. Mirrors the stub in next-linksuggest-hoist-wikire.test.mjs.
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
// handed to json(res, status, payload). Pass-through cache so the closure runs each
// call. Fully in-process: no network, no server.
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
    cached: (_k, _t, fn) => fn(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/link-suggestions', ctx);
  return captured;
}

// The target links to nothing, so the existing-link set is empty and the
// word-overlap filter alone decides the suggestions. Its prose carries the
// long-enough words "embeddings", "reinforcement", and "strategies".
//
// The candidates are chosen to pin the hoisted `baseName` (the extension is
// stripped ONCE, then reused for both pageName and the title fallback):
//   - Embeddings.md   mixed-case stem, NO front matter -> title keeps the cased
//                     stem ("Embeddings"), pageName is the lowercased stem
//                     ("embeddings"); both come from the SAME baseName.
//   - reinforcement-learning.md  hyphenated stem, NO front matter -> matched on
//                     its "reinforcement" segment; title falls back to the full
//                     baseName verbatim.
//   - strategies.md   HAS front matter -> the front-matter title overrides the
//                     baseName fallback, while pageName is still baseName.toLowerCase().
// unrelated.md shares no long word; diagram.png is filtered out by extension. The
// fixture order is the walk order, so suggestions appear in this order.
const FIXTURE = {
  'content/index.md': `---
title: Research Notes
---

This note discusses Embeddings and reinforcement strategies in depth.
`,
  'content/Embeddings.md': 'About embeddings and related topics.\n',
  'content/reinforcement-learning.md': 'Body about reinforcement learning, no front matter.\n',
  'content/strategies.md': '---\ntitle: Strategy Patterns\n---\n\nAbout strategies.\n',
  'content/unrelated.md': '---\ntitle: Unrelated\n---\n\nNothing overlaps here.\n',
  'content/diagram.png': 'not markdown\n',
};

// Hand-derived golden. title preserves the stem case ("Embeddings"), pageName is
// the lowercased stem ("embeddings"); the front-matter page keeps its FM title.
const EXPECTED = {
  suggestions: [
    { path: 'content/Embeddings.md', title: 'Embeddings', pageName: 'embeddings' },
    { path: 'content/reinforcement-learning.md', title: 'reinforcement-learning', pageName: 'reinforcement-learning' },
    { path: 'content/strategies.md', title: 'Strategy Patterns', pageName: 'strategies' },
  ],
  total: 3,
};

describe('GET /api/file/link-suggestions (scanLinks strips the extension once into baseName)', () => {
  it('returns the hand-derived golden suggestions payload', async () => {
    const r = await invokeLinkSuggestions(makeFs(FIXTURE), TARGET);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('derives title and pageName from the same baseName stem (case preserved vs lowercased)', async () => {
    const r = await invokeLinkSuggestions(makeFs(FIXTURE), TARGET);
    const byPath = Object.fromEntries(r.payload.suggestions.map(s => [s.path, s]));

    // Mixed-case stem, no front matter: title keeps the cased baseName, pageName is
    // the lowercased baseName. This is exactly the shared-stem reuse the hoist pins.
    assert.deepEqual(byPath['content/Embeddings.md'], {
      path: 'content/Embeddings.md', title: 'Embeddings', pageName: 'embeddings',
    });

    // Hyphenated stem, no front matter: the title fallback is the full baseName.
    assert.equal(byPath['content/reinforcement-learning.md'].title, 'reinforcement-learning');

    // Front matter present: the FM title overrides the baseName fallback, but the
    // pageName is still baseName.toLowerCase().
    assert.equal(byPath['content/strategies.md'].title, 'Strategy Patterns');
    assert.equal(byPath['content/strategies.md'].pageName, 'strategies');
  });

  it('strips the extension exactly once in source (baseName reused for pageName and title)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../server/routes/study-knowledge.js', import.meta.url)),
      'utf-8',
    );
    assert.ok(src.includes('const baseName = entry.name.replace('),
      'scanLinks declares const baseName = entry.name.replace(...)');
    assert.ok(src.includes('const pageName = baseName.toLowerCase()'),
      'pageName is derived from baseName');
    assert.ok(src.includes('let title = baseName;'),
      'the title fallback reuses baseName');
  });
});
