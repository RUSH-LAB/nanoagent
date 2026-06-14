import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it via createRequire the way the sibling suites do
// (next-suggesttags-freq.test.mjs, next-filetools-suggesttags-cache.test.mjs) and reuse their
// ctx-mocking shape. These tests pin the UNCOVERED hyphenated multi-word branch of GET
// /api/file/suggest-tags: for each corpus tag, after the (already covered) frequency push,
// the handler computes `hyphenated = tagLower.replace(/-/g, ' ').split(' ')` and, when that
// has more than one part AND every part appears in the body frequency map, pushes
// {tag, confidence: 0.7}. The three existing suites only use single-word, non-hyphenated
// corpus tags, so that branch and the literal 0.7 never execute. Every golden below was
// captured from the REAL handler (a throwaway pass-through probe), then spliced in and
// asserted via full-payload deepEqual; the structural assertions alongside each keep the
// goldens non-vacuous.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from a `${rel-from-PROJECT_ROOT}: content` map, copied from the
// sibling suggest-tags suites. The handler touches readFileSync (the request file, then each
// corpus file during the all-tags-set scan) and readdirSync (the recursive content walk with
// {withFileTypes:true}). A missing path throws ENOENT exactly like the real fs.
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

// Pass-through cached(key, ttl, fn): always run fn(), so BOTH the outer suggesttags: payload
// cache and the inner all-tags-set corpus cache exercise their real code over the mocked fs.
const passThrough = (_key, _ttl, fn) => fn();

// Invoke the GET /api/file/suggest-tags handler with a mocked ctx and capture the response
// handed to json(res, status, payload). isValidFilePath accepts the path so the happy path
// reaches the file read and the suggestion fold.
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

// ── Fixture 1: the headline hyphenated branch in isolation ──
// The only corpus tag is the request file's own tag `deep-learning`. The body carries the two
// parts SPACE separated (never the hyphenated token), so freq['deep-learning'] is undefined and
// the frequency branch cannot fire; only the hyphenated branch can. Each part clears the bar:
// `deep` (length 4) and `learning` (length 8) are both longer than 3 and not stop words, and
// each appears in the body, so hyphenated.every(...) is true and the 0.7 push fires.
const DL_REL = 'content/dl.md';
const DL = '---\ntitle: Deep Learning\ntags: [deep-learning]\n---\ndeep learning models for deep learning tasks\n';
const DL_EXPECTED = {
  suggestions: [
    { tag: 'deep-learning', confidence: 0.7 },
  ],
  topKeywords: ['deep', 'learning', 'models', 'tasks'],
};

// ── Fixture 2: the every() gate (negative control) plus selectivity ──
// Three corpus tags share one body. `deep-learning` fires (both parts present), proving the
// gate is selective rather than blanket-off. `ai-models` cannot fire: its part `ai` is length 2,
// so the body word filter (length > 3) drops it and freq['ai'] is undefined. `graph-theory`
// cannot fire: `theory` never appears in the body, so freq['theory'] is undefined. In both
// negatives hyphenated.every(...) short-circuits to false and no 0.7 push happens.
const GATE_REL = 'content/gate.md';
const GATE = '---\ntitle: Gate\ntags: [deep-learning, ai-models, graph-theory]\n---\ndeep learning with deep models and learning graph again graph\n';
const GATE_EXPECTED = {
  suggestions: [
    { tag: 'deep-learning', confidence: 0.7 },
  ],
  topKeywords: ['deep', 'learning', 'graph', 'models', 'again'],
};

// ── Fixture 3: both branches fire for one tag, so the Map dedup decides the winner ──
// The body carries the hyphenated token `deep-learning` twice (freq['deep-learning'] === 2, so
// the frequency branch pushes confidence Math.min(2/5, 1) === 0.4) AND the parts `deep` and
// `learning` once each (so the hyphenated branch then pushes 0.7). The frequency push happens
// first and the hyphenated push second, so the Map keyed by tag keeps the later 0.7 entry.
const BOTH_REL = 'content/both.md';
const BOTH = '---\ntitle: Both\ntags: [deep-learning]\n---\ndeep-learning deep-learning deep learning\n';
const BOTH_EXPECTED = {
  suggestions: [
    { tag: 'deep-learning', confidence: 0.7 },
  ],
  topKeywords: ['deep-learning', 'deep', 'learning'],
};

// ── Fixture 4: confidence-descending sort, the slice(0, 10) cap, and recursion ──
// Twelve corpus tags qualify: two via the frequency branch above 0.7 (transformer freq 5 -> 1,
// attention freq 4 -> 0.8), eight via the hyphenated branch (each 0.7), and two via the
// frequency branch below 0.7 (embedding freq 3 -> 0.6, gradient freq 2 -> 0.4). After the
// confidence-descending sort the two sub-0.7 tags land at indexes 10 and 11, so slice(0, 10)
// drops them. Two of the eight hyphenated tags live in a subdirectory file, so the golden also
// pins that the scan recurses into content/sub/.
const MANY_REL = 'content/many.md';
const MANY = '---\ntitle: Many\ntags: [transformer, attention, embedding, gradient, deep-learning, machine-learning, neural-networks, computer-vision, natural-language, random-forest]\n---\ntransformer transformer transformer transformer transformer attention attention attention attention embedding embedding embedding gradient gradient deep learning machine neural networks computer vision natural language random forest linear algebra reinforcement\n';
const EXTRA = '---\ntitle: Extra\ntags: [linear-algebra, reinforcement-learning]\n---\nextra corpus file\n';
const MANY_MAP = {
  [MANY_REL]: MANY,
  'content/sub/extra.md': EXTRA,
};
const MANY_EXPECTED = {
  suggestions: [
    { tag: 'transformer', confidence: 1 },
    { tag: 'attention', confidence: 0.8 },
    { tag: 'deep-learning', confidence: 0.7 },
    { tag: 'machine-learning', confidence: 0.7 },
    { tag: 'neural-networks', confidence: 0.7 },
    { tag: 'computer-vision', confidence: 0.7 },
    { tag: 'natural-language', confidence: 0.7 },
    { tag: 'random-forest', confidence: 0.7 },
    { tag: 'linear-algebra', confidence: 0.7 },
    { tag: 'reinforcement-learning', confidence: 0.7 },
  ],
  topKeywords: ['transformer', 'attention', 'embedding', 'gradient', 'deep'],
};

// ── Fixture 5: the corpus scan skips entries whose name starts with "." or "_" ──
// The request file main.md contributes the single tag deep-learning (its parts appear in the
// body). Two more files, _hidden.md and .dot.md, declare the hyphenated tags vision-language and
// forest-algebra whose parts ALSO appear in the body, so each WOULD push 0.7 if it were scanned.
// Because their names start with "_" and ".", the scan skips them and neither tag reaches the
// set, so the only suggestion is deep-learning. The skip is what keeps them out, so dropping it
// would let both tags appear and break this golden.
const SKIP_REL = 'content/main.md';
const SKIP_MAIN = '---\ntitle: Main\ntags: [deep-learning]\n---\ndeep learning vision language forest algebra\n';
const SKIP_MAP = {
  [SKIP_REL]: SKIP_MAIN,
  'content/_hidden.md': '---\ntitle: Hidden\ntags: [vision-language]\n---\nhidden body\n',
  'content/.dot.md': '---\ntitle: Dot\ntags: [forest-algebra]\n---\ndot body\n',
};
const SKIP_EXPECTED = {
  suggestions: [
    { tag: 'deep-learning', confidence: 0.7 },
  ],
  topKeywords: ['deep', 'learning', 'vision', 'language', 'forest'],
};

describe('GET /api/file/suggest-tags hyphenated multi-word branch (confidence 0.7)', () => {
  it('pushes {tag, 0.7} when a hyphenated tag has every part in the body frequency map', async () => {
    const r = await invoke(DL_REL, { fs: makeFs({ [DL_REL]: DL }), cached: passThrough });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, DL_EXPECTED);
    // Non-vacuous: the 0.7 push actually fired. The frequency branch is impossible here because
    // freq['deep-learning'] is undefined (the body never holds the hyphenated token).
    assert.ok(
      r.payload.suggestions.some(s => s.tag === 'deep-learning' && s.confidence === 0.7),
      'the hyphenated branch must push {deep-learning, 0.7}',
    );
  });

  it('enforces the every() gate: no 0.7 push when a part is too short or missing', async () => {
    const r = await invoke(GATE_REL, { fs: makeFs({ [GATE_REL]: GATE }), cached: passThrough });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, GATE_EXPECTED);
    const tags = r.payload.suggestions.map(s => s.tag);
    // The gate is selective, not blanket-off: a fully satisfied tag still fires.
    assert.ok(tags.includes('deep-learning'), 'a hyphenated tag with both parts present still fires');
    // ai-models: the part "ai" is length 2, dropped by the length > 3 filter, so every() is false.
    assert.ok(!tags.includes('ai-models'), 'a part of length 3 or less blocks the 0.7 push');
    // graph-theory: "theory" never appears in the body, so freq['theory'] is undefined.
    assert.ok(!tags.includes('graph-theory'), 'a part missing from the body blocks the 0.7 push');
  });

  it('dedup keeps the LAST push: a both-branches tag resolves to 0.7, not its frequency confidence', async () => {
    const r = await invoke(BOTH_REL, { fs: makeFs({ [BOTH_REL]: BOTH }), cached: passThrough });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, BOTH_EXPECTED);
    // deep-learning qualifies twice: the frequency branch pushes 0.4 first, then the hyphenated
    // branch pushes 0.7. The Map keyed by tag keeps the later push, so 0.7 wins and one entry
    // survives.
    const dl = r.payload.suggestions.filter(s => s.tag === 'deep-learning');
    assert.equal(dl.length, 1, 'the two pushes for deep-learning collapse to a single entry');
    assert.equal(dl[0].confidence, 0.7, 'the later hyphenated push wins over the 0.4 frequency push');
  });

  it('sorts by confidence descending, caps at 10, and recurses into subdirectories', async () => {
    const r = await invoke(MANY_REL, { fs: makeFs(MANY_MAP), cached: passThrough });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, MANY_EXPECTED);
    const s = r.payload.suggestions;
    const tags = s.map(x => x.tag);
    // Twelve tags qualify; slice(0, 10) caps the returned list.
    assert.equal(s.length, 10, 'slice(0, 10) caps the suggestions list');
    // The list is sorted by confidence descending.
    for (let i = 1; i < s.length; i++) {
      assert.ok(s[i - 1].confidence >= s[i].confidence, 'confidence is non-increasing');
    }
    assert.equal(s[0].confidence, 1, 'transformer (freq 5) clamps to 1 and leads');
    assert.equal(s[1].confidence, 0.8, 'attention (freq 4) is next');
    assert.equal(s.filter(x => x.confidence === 0.7).length, 8, 'eight hyphenated tags each push 0.7');
    // embedding (0.6) and gradient (0.4) sort to indexes 10 and 11, so the cap drops them.
    assert.ok(!tags.includes('embedding'), 'the 0.6 tag is cut by slice(0, 10)');
    assert.ok(!tags.includes('gradient'), 'the 0.4 tag is cut by slice(0, 10)');
    // The recursive scan descends into content/sub/ and collects its hyphenated tags.
    assert.ok(
      tags.includes('linear-algebra') && tags.includes('reinforcement-learning'),
      'the scan recurses into the subdirectory and collects its tags',
    );
  });

  it('skips corpus entries whose name starts with "." or "_"', async () => {
    const r = await invoke(SKIP_REL, { fs: makeFs(SKIP_MAP), cached: passThrough });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, SKIP_EXPECTED);
    const tags = r.payload.suggestions.map(s => s.tag);
    // The request file's own tag still fires, so the fixture is not trivially empty.
    assert.ok(tags.includes('deep-learning'), 'the request file tag still fires');
    // Both skipped files declare a tag whose parts are in the body, so the skip is the only
    // reason they are absent. This keeps the negative non-vacuous.
    assert.ok(!tags.includes('vision-language'), 'content/_hidden.md is skipped (underscore prefix)');
    assert.ok(!tags.includes('forest-algebra'), 'content/.dot.md is skipped (dot prefix)');
  });
});
