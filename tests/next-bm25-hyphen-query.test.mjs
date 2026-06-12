import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// research-tools.js is CommonJS; load it the way the other server tests do.
const require = createRequire(import.meta.url);
const researchTools = require('../server/routes/research-tools.js');
const { tokenizeSearch } = researchTools;

// Fixture corpus for GET /api/search.
//   • gpt-paper.md carries the hyphenated token "GPT-4". The index tokenizer
//     (tokenizeSearch) splits on punctuation, so the indexed tokens are `gpt`
//     and `4` — never the whole `gpt-4`. A query `gpt-4` therefore only matches
//     once the candidate gate tokenizes the query the same way the index does.
//   • language-survey.md gives the clean-input queries a second match so the
//     multi-word regression locks in a non-trivial ranking.
//   • unrelated.md shares no token with any query under test.
const FIXTURE = {
  'gpt-paper.md': '# GPT-4 overview\nGPT-4 is a language model. Language modeling with GPT-4.',
  'language-survey.md': 'A survey of language model research. Language model language model.',
  'unrelated.md': 'Completely different topic about cooking recipes.',
};

// Golden result lists captured from the /api/search handler. For these clean
// queries — whose words carry no splitting character — the pre-change gate
// (whitespace split) and the post-change gate (tokenizeSearch) tokenize the
// query identically, so the results are byte-identical: same order, names,
// snippets, and scores. They guard that the fix preserves clean-input behavior.
const GOLDEN_GPT = [
  {
    path: 'content/gpt-paper.md',
    name: 'gpt-paper.md',
    snippet: '# GPT-4 overview GPT-4 is a language model. Language mo...',
    score: 1.4861049288056463,
  },
];
const GOLDEN_LANGUAGE_MODEL = [
  {
    path: 'content/language-survey.md',
    name: 'language-survey.md',
    snippet: 'A survey of language model research. Language model language model.',
    score: 1.566678764152452,
  },
  {
    path: 'content/gpt-paper.md',
    name: 'gpt-paper.md',
    snippet: '# GPT-4 overview GPT-4 is a language model. Language modeling with GPT-4.',
    score: 0.9932494632204454,
  },
];

// The pre-change candidate gate split the query on whitespace only. Kept here as
// the baseline the regression cases are measured against.
const oldWhitespaceGate = (query) => query.split(/\s+/).filter(w => w.length > 0);

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-hyphen-query-'));
  const contentDir = path.join(root, 'content');
  fs.mkdirSync(contentDir);
  for (const [name, body] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(contentDir, name), body, 'utf-8');
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Drive the real GET /api/search handler over the fixture with a fresh,
// memoize-only cache (the production `cached` adds TTL/eviction we don't need).
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
  return captured;
}

describe('GET /api/search candidate gate tokenizes hyphenated and punctuated queries', () => {
  it('matches a hyphenated query that the old whitespace gate dropped', async () => {
    const captured = await runSearch('gpt-4');
    assert.equal(captured.status, 200);
    const results = captured.payload.results;
    assert.equal(results.length, 1, 'gpt-4 now matches the GPT-4 document');
    assert.equal(results[0].name, 'gpt-paper.md');
    assert.ok(results[0].score > 0, 'the match carries a positive BM25 score');

    // Why it was dropped before: the index never holds the whole "gpt-4", and
    // the old gate kept the query word "gpt-4" whole, so nothing matched.
    const docTokens = tokenizeSearch(FIXTURE['gpt-paper.md']);
    assert.ok(docTokens.includes('gpt') && docTokens.includes('4'),
      'the index splits GPT-4 into the tokens gpt and 4');
    assert.ok(!docTokens.includes('gpt-4'),
      'no indexed token is the whole "gpt-4"');
    assert.deepEqual(oldWhitespaceGate('gpt-4'), ['gpt-4'],
      'the old gate kept "gpt-4" whole, so it matched no token');
    assert.deepEqual(tokenizeSearch('gpt-4'), ['gpt', '4'],
      'the new gate tokenizes the query into the tokens the index actually holds');
  });

  it('is behavior-preserving for a clean single-word query (byte-identical to before the change)', async () => {
    const captured = await runSearch('gpt');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload.results, GOLDEN_GPT);
    // Mechanism: a clean query tokenizes identically under both gates.
    assert.deepEqual(tokenizeSearch('gpt'), oldWhitespaceGate('gpt'));
  });

  it('is behavior-preserving for a clean multi-word query (same order, names, scores)', async () => {
    const captured = await runSearch('language model');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload.results, GOLDEN_LANGUAGE_MODEL);
    assert.deepEqual(captured.payload.results.map(r => r.name),
      ['language-survey.md', 'gpt-paper.md'], 'non-trivial ranking is preserved');
    // Mechanism: a clean multi-word query tokenizes identically under both gates.
    assert.deepEqual(tokenizeSearch('language model'), oldWhitespaceGate('language model'));
  });

  it('returns an empty list for a non-matching query', async () => {
    const captured = await runSearch('nonexistentterm');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload.results, []);
  });

  it('returns an empty list for an all-punctuation query rather than every document', async () => {
    // A query of only splitting characters tokenizes to nothing. Without a guard,
    // an empty term list makes the gate vacuously match every document; the
    // whitespace gate returned an empty list here, so the tokenized gate must too.
    assert.deepEqual(tokenizeSearch('---'), []);
    const captured = await runSearch('---');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload.results, []);
  });
});
