import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';

// Minimal fs stub. The GET /api/suggest handler only touches readFileSync
// (references.yaml + each content page) and existsSync (the content dir guard),
// so the stub serves a flat map of absolute path to content and treats a path as
// an existing directory when any fixture file lives beneath it.
function makeFs(fileMap) {
  const files = new Map(Object.entries(fileMap));
  return {
    existsSync(p) {
      if (files.has(p)) return true;
      for (const k of files.keys()) if (k.startsWith(p + '/')) return true;
      return false;
    },
    readFileSync(p) {
      if (files.has(p)) return files.get(p);
      const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Fixture pinning the suggestion output. The query carries one stop word ("the")
// alongside three real keywords, plus decoy entries whose only overlap is "the".
// With the stop-word filter live, "the" never becomes a keyword, so the decoys
// score zero and stay out; the real keywords match and rank by relevance.
const REFS_YAML = [
  'transformer2017:',
  '  title: "Attention Is All You Need"',
  '  author:',
  '    - Ashish Vaswani',
  'thedecoy:',
  '  title: "The The The"',
  '  author:',
  '    - The Author',
  'cooking:',
  '  title: "Quantum Cooking"',
  '  author:',
  '    - Some One',
  '',
].join('\n');

const FILE_MAP = {
  [path.join(PROJECT_ROOT, 'content', 'bibliography', 'references.yaml')]: REFS_YAML,
  [path.join(PROJECT_ROOT, 'content', 'transformers.md')]:
    '---\ntitle: Transformer Models\n---\n# Transformer Models\n## Attention Mechanism\nBody text.\n',
  [path.join(PROJECT_ROOT, 'content', 'attention-notes.md')]:
    '---\ntitle: Attention Notes\n---\n# Attention Notes\nSome content.\n',
  [path.join(PROJECT_ROOT, 'content', 'the-decoy.md')]:
    '---\ntitle: The The The\n---\n# The The The\n',
  [path.join(PROJECT_ROOT, 'content', 'cooking.md')]:
    '---\ntitle: Quantum Cooking\n---\n# Recipes\n',
};

// flatFiles returns {name, path} entries with path relative to PROJECT_ROOT; the
// handler joins each onto PROJECT_ROOT before reading. The non-markdown entry is
// here to confirm the handler's .md/.mdx filter skips it (the stub would throw on
// a read since it is absent from FILE_MAP).
const FLAT_FILES = [
  { name: 'transformers.md', path: 'content/transformers.md' },
  { name: 'attention-notes.md', path: 'content/attention-notes.md' },
  { name: 'the-decoy.md', path: 'content/the-decoy.md' },
  { name: 'cooking.md', path: 'content/cooking.md' },
  { name: 'readme.txt', path: 'content/readme.txt' },
];

const ctx = {
  fs: makeFs(FILE_MAP),
  path,
  PROJECT_ROOT,
  flatFiles: () => FLAT_FILES,
};

// Invoke the misc-tools route handler with a mocked ctx and capture the response
// it hands to json(res, status, payload).
async function invoke({ search = '' } = {}) {
  const pathname = '/api/suggest';
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

const callSuggest = (text, extra = '') =>
  invoke({ search: `?text=${encodeURIComponent(text)}${extra}` });

describe('GET /api/suggest (SUGGEST_STOP_WORDS hoisted to module scope)', () => {
  it('keeps real keywords, drops the stop word, and ranks by relevance', async () => {
    const r = await callSuggest('the transformer attention mechanism');
    assert.equal(r.status, 200);

    // transformer2017 matches on "transformer" (in its key) and "attention" (in
    // its title) for a relevance of 2; the decoy and cooking entries match none.
    assert.deepEqual(r.payload.references, [
      { key: 'transformer2017', title: 'Attention Is All You Need', relevance: 2 },
    ]);

    // transformers.md matches all three keywords (relevance 3) and leads;
    // attention-notes.md matches one (relevance 1) and follows. The ordering pins
    // the relevance sort, and the readme.txt entry confirms the .md/.mdx filter.
    assert.deepEqual(r.payload.pages, [
      { path: 'content/transformers.md', title: 'Transformer Models', relevance: 3 },
      { path: 'content/attention-notes.md', title: 'Attention Notes', relevance: 1 },
    ]);
  });

  it('filters the stop word so "the"-only entries never surface', async () => {
    const r = await callSuggest('the transformer attention mechanism');
    const refKeys = r.payload.references.map(x => x.key);
    const pagePaths = r.payload.pages.map(x => x.path);
    // Were "the" treated as a keyword, both decoys would score and appear; their
    // absence proves the hoisted SUGGEST_STOP_WORDS set is still applied.
    assert.ok(!refKeys.includes('thedecoy'), 'a "the"-only reference is excluded');
    assert.ok(!pagePaths.includes('content/the-decoy.md'), 'a "the"-only page is excluded');
  });

  it('returns no suggestions when every word is a stop word', async () => {
    // "the", "and", "but", "for" are all in the stop-word set, so no keyword
    // survives and the handler returns empty lists even though fixtures contain
    // those words. Drop the filter and "the" would match the decoys.
    const r = await callSuggest('the and but for');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { references: [], pages: [] });
  });

  it('returns empty lists for blank text', async () => {
    const r = await invoke({ search: '' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { references: [], pages: [] });
  });

  it('honors the limit query parameter', async () => {
    const r = await callSuggest('the transformer attention mechanism', '&limit=1');
    assert.equal(r.status, 200);
    // Two pages qualify, but limit=1 keeps only the top-ranked one.
    assert.deepEqual(r.payload.pages, [
      { path: 'content/transformers.md', title: 'Transformer Models', relevance: 3 },
    ]);
    assert.equal(r.payload.references.length, 1);
  });
});
