import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// research-tools.js is CommonJS; load it the way the other server tests do.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');

// Fixture for GET /api/search, crafted so the BM25 ranking is non-trivial and
// both snippet branches fire. Read order is alphabetical (a, b, c, d) but BM25
// ranks a-focused > c-split > b-buried, swapping b and c:
//   • a-focused — tf 2+2 in a tiny doc, exact "alpha beta" phrase  → branch 1
//   • c-split   — both tokens but never contiguous, long enough to truncate → branch 2
//   • b-buried  — one "alpha beta" phrase buried in padding         → branch 1 (both ellipses)
//   • d-none    — neither token, so never a candidate (but still indexed)
const FIXTURE = {
  'a-focused.md': 'alpha beta alpha beta gamma',
  'b-buried.md': 'intro heading line\n' + 'lorem ipsum '.repeat(20) + 'alpha beta ' + 'lorem ipsum '.repeat(20),
  'c-split.md': 'beta opens this note and then provides plenty of padding words here so that the firstLines snippet has to be truncated well before the alpha keyword finally shows up near the very end',
  'd-none.md': 'completely unrelated content about zeta and theta only',
};

// Golden captured from the pre-change handler (which stored a per-doc `_lower`
// copy). Dropping `_lower` and recomputing `_content.toLowerCase()` on demand for
// the snippet must leave this byte-identical: order, scores, snippets, paths, names.
const GOLDEN = [
  {
    path: 'content/a-focused.md',
    name: 'a-focused.md',
    snippet: 'alpha beta alpha beta gamma',
    score: 1.4005070859789865,
  },
  {
    path: 'content/c-split.md',
    name: 'c-split.md',
    snippet: 'beta opens this note and then provides plenty of padding words here so that the firstLines snippet h...',
    score: 0.7109078380520949,
  },
  {
    path: 'content/b-buried.md',
    name: 'b-buried.md',
    snippet: '...m lorem ipsum lorem ipsum lorem ipsum lorem ipsum alpha beta lorem ipsum lorem ipsum lorem ipsum lorem ipsum l...',
    score: 0.41523588230147923,
  },
];

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-lower-dup-'));
  const contentDir = path.join(root, 'content');
  fs.mkdirSync(contentDir);
  for (const [name, body] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(contentDir, name), body, 'utf-8');
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Drive the real GET /api/search handler over the fixture with a fresh cache
// store (memoize-only; the production `cached` adds TTL/eviction we don't need
// here). Returns the captured json() response plus the cache for inspection.
async function runSearch(query) {
  const cache = {};
  const cached = (key, _ttlMs, fn) => {
    if (cache[key]) return cache[key].data;
    const data = fn();
    cache[key] = { data, time: Date.now() };
    return data;
  };
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cache, cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL(`http://localhost/api/search?q=${encodeURIComponent(query)}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await researchTools(req, res, url, '/api/search', ctx);
  return { captured, cache };
}

describe('GET /api/search drops the duplicate _lower index copy', () => {
  it('returns results byte-identical to the pre-change golden (order, scores, snippets, paths, names)', async () => {
    const { captured } = await runSearch('alpha beta');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload.results, GOLDEN);
  });

  it('ranks by descending BM25 score with a non-trivial order (focused > split > buried)', async () => {
    const { captured } = await runSearch('alpha beta');
    const results = captured.payload.results;
    assert.deepEqual(results.map(r => r.name), ['a-focused.md', 'c-split.md', 'b-buried.md']);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score > results[i].score, 'scores strictly descending');
    }
  });

  it('exercises both snippet branches: phrase-centered match and firstLines fallback', async () => {
    const { captured } = await runSearch('alpha beta');
    const snippetByName = Object.fromEntries(captured.payload.results.map(r => [r.name, r.snippet]));
    // Branch 1 — exact phrase present, snippet centered on the occurrence.
    assert.ok(snippetByName['a-focused.md'].includes('alpha beta'));
    assert.ok(snippetByName['b-buried.md'].startsWith('...'));
    assert.ok(snippetByName['b-buried.md'].endsWith('...'));
    assert.ok(snippetByName['b-buried.md'].includes('alpha beta'));
    // Branch 2 — tokens matched individually but not contiguous, so the opening
    // (firstLines) is shown and the phrase never appears in the snippet.
    assert.ok(!snippetByName['c-split.md'].includes('alpha beta'));
    assert.ok(snippetByName['c-split.md'].endsWith('...'));
  });

  it('caches an index whose docs carry no _lower key but keep _content, tf, and length', async () => {
    const { cache } = await runSearch('alpha beta');
    const entry = cache['search:index'];
    assert.ok(entry, 'the index is cached under search:index');
    const docs = entry.data.docs;
    assert.equal(docs.length, 4, 'all four fixture docs are indexed');
    for (const doc of docs) {
      assert.ok(!('_lower' in doc), `${doc.name} must not carry a _lower copy`);
      assert.ok('_content' in doc, `${doc.name} keeps _content`);
      assert.ok('tf' in doc, `${doc.name} keeps tf`);
      assert.ok('length' in doc, `${doc.name} keeps length`);
    }
  });
});
