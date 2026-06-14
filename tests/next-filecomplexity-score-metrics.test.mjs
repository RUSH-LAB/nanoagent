import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Characterization test for GET /api/file/complexity in
// server/routes/content-analysis-b.js. The sibling cache suite
// (tests/next-content-b-filemicro-cache.test.mjs) pins the cache mechanics plus
// only payload.metrics.wordCount and payload.metrics.headings, so the top-level
// complexityScore (both arms of the avgSentenceLength term and the
// vocabularyRichness term, plus every Math.min cap) and nine of the eleven
// metrics fields are otherwise unpinned. This suite drives the REAL module via
// createRequire with a pass-through cached() (the exact pre-cache code path) and
// a mocked ctx.fs.readFileSync keyed by absolute path, then asserts the FULL
// payload against goldens captured from the live handler. It changes no source.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub that returns one file's content keyed by absolute path. The
// handler reads exactly one file (fs.readFileSync(path.join(PROJECT_ROOT,
// filePath))) and never walks a directory, so only readFileSync is needed. A
// present-but-empty entry still resolves (Map.has is true for ''), which lets the
// empty-content edge reach the 200 path instead of the 404.
function makeCountingFs(absFileMap) {
  const counts = { readFileSync: 0 };
  const fs = {
    readFileSync(fp) {
      counts.readFileSync++;
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return { fs, counts };
}

// A memoizing cached(key, ttl, fn) backed by a real Map, mirroring the server.js
// helper: compute and store on a miss, return the stored value on a hit. Used to
// prove the cache wrapper alters none of the pinned field values.
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

// A non-memoizing pass-through cached: it always runs fn(), reproducing the exact
// pre-cache computation. This is the path the golden assertions drive.
function passThroughCached() {
  const calls = [];
  const cached = (key, ttl, fn) => { calls.push({ key, ttl }); return fn(); };
  return { cached, calls };
}

// Invoke a GET handler with a mocked ctx and capture the response handed to
// json(res, status, payload). isValidFilePath defaults to accepting the path so
// the happy path reaches the file read.
async function invoke(pathname, filePath, { fs, cached, isValidFilePath = () => true }) {
  const url = new URL(`http://localhost${pathname}?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    isValidFilePath,
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// Run /api/file/complexity over one in-memory file through the pass-through
// cached(), i.e. the exact pre-cache computation the golden pins.
async function complexity(filePath, content) {
  const abs = path.join(PROJECT_ROOT, filePath);
  return invoke('/api/file/complexity', filePath, { ...makeCountingFs(new Map([[abs, content]])), ...passThroughCached() });
}

// ── fixtures (hand-crafted to exercise every branch and cap) ──

// HIGH: no sentence punctuation so the whole file is one sentence, making
// avgSentenceLength = wordCount (91, above 20 -> the 15 arm). Nearly every token
// is unique so vocabularyRichness is 0.97 (above 0.6 -> the 15 arm). Seven ATX
// headings (depths one through six) saturate headings times 3 at 20 and set
// maxHeadingDepth to 6; three fenced blocks saturate codeBlocks times 5 at 15;
// three $$ pairs saturate mathBlocks times 5 at 15; five [@ citations saturate
// citations times 2 at 10; two [[ wiki links plus three ]( markdown links
// saturate links times 2 at 10. The summed score reaches the outer cap of 100.
const HIGH_REL = 'content/cx-high.md';
const HIGH_SAMPLE = [
  '# Alpha bravo charlie delta echo foxtrot golf',
  '## Hotel india juliet kilo lima mike november',
  '### Oscar papa quebec romeo sierra tango uniform',
  '#### Victor whiskey xray yankee zulu apple banana',
  '##### Cherry mango papaya guava lychee durian fig',
  '###### Grape melon olive peach plum berry kiwi',
  '# Citrus walnut almond cashew pecan hazel chestnut',
  '',
  'Citing [@anchovy2020] then [@basil2021] plus [@cumin2022] with [@dill2023] and [@elder2024]',
  '',
  'Linking [[wikiAardvark]] also [[wikiBadger]] beyond [caribou](urlCaribou) next [dingo](urlDingo) finally [emu](urlEmu)',
  '',
  '$$equationAlpha$$ $$equationBeta$$ $$equationGamma$$',
  '',
  '```js',
  'const snippetUnoUnique',
  '```',
  '',
  '```py',
  'def snippetDosUnique',
  '```',
  '',
  '```rb',
  'puts snippetTresUnique',
  '```',
].join('\n') + '\n';

// LOW: short sentences (avgSentenceLength 5, at or below 20 -> the linear times
// 0.75 arm) and heavy repetition (vocabularyRichness 0.2, at or below 0.6 -> the
// linear times 25 arm) with no headings, code, math, citations, links, or lists.
const LOW_REL = 'content/cx-low.md';
const LOW_SAMPLE = 'data data data data data. data data data data data. data data data data info.\n';

// EMPTY: no content at all, so words.length is 0 (vocabularyRichness takes its
// zero arm) and sentences.length is 0 (avgSentenceLength takes its zero arm).
// Every metric collapses to 0 and the score is 0.
const EMPTY_REL = 'content/cx-empty.md';
const EMPTY_SAMPLE = '';

// NOSENT: three words but no segment longer than three trimmed characters, so
// sentences.length is 0 (avgSentenceLength takes its zero arm) WHILE words.length
// is 3 (vocabularyRichness still computes, here 1). This isolates the no-sentence
// edge from the no-words edge.
const NOSENT_REL = 'content/cx-nosent.md';
const NOSENT_SAMPLE = 'Hi. Yo. Ok.\n';

// MIXED: pins the list counters and the backslash-bracket math arm that HIGH does
// not. Three bullet lines (-, *, +) plus two ordered lines (1., 2.) give lists 5;
// one \[ display-math opening gives mathBlocks 1 with no $$ pair; one level-two
// heading gives maxHeadingDepth 2. avgSentenceLength 9.7 is the linear arm while
// vocabularyRichness 0.9 is the high arm.
const MIXED_REL = 'content/cx-mixed.md';
const MIXED_SAMPLE = [
  '## Mixed Heading',
  '',
  '- bullet alpha',
  '* bullet beta',
  '+ bullet gamma',
  '',
  '1. numbered one',
  '2. numbered two',
  '',
  'Prose with display math \\[ x = y \\] inline here.',
].join('\n') + '\n';

// ── goldens (captured from the live handler over the fixtures above) ──

const GOLD_HIGH = {
  path: HIGH_REL,
  complexityScore: 100,
  metrics: { wordCount: 91, uniqueWords: 88, vocabularyRichness: 0.97, avgSentenceLength: 91, headings: 7, maxHeadingDepth: 6, codeBlocks: 3, mathBlocks: 3, citations: 5, links: 5, lists: 0 },
};

const GOLD_LOW = {
  path: LOW_REL,
  complexityScore: 9,
  metrics: { wordCount: 15, uniqueWords: 3, vocabularyRichness: 0.2, avgSentenceLength: 5, headings: 0, maxHeadingDepth: 0, codeBlocks: 0, mathBlocks: 0, citations: 0, links: 0, lists: 0 },
};

const GOLD_EMPTY = {
  path: EMPTY_REL,
  complexityScore: 0,
  metrics: { wordCount: 0, uniqueWords: 0, vocabularyRichness: 0, avgSentenceLength: 0, headings: 0, maxHeadingDepth: 0, codeBlocks: 0, mathBlocks: 0, citations: 0, links: 0, lists: 0 },
};

const GOLD_NOSENT = {
  path: NOSENT_REL,
  complexityScore: 15,
  metrics: { wordCount: 3, uniqueWords: 3, vocabularyRichness: 1, avgSentenceLength: 0, headings: 0, maxHeadingDepth: 0, codeBlocks: 0, mathBlocks: 0, citations: 0, links: 0, lists: 0 },
};

const GOLD_MIXED = {
  path: MIXED_REL,
  complexityScore: 30,
  metrics: { wordCount: 29, uniqueWords: 26, vocabularyRichness: 0.9, avgSentenceLength: 9.7, headings: 1, maxHeadingDepth: 2, codeBlocks: 0, mathBlocks: 1, citations: 0, links: 0, lists: 5 },
};

describe('GET /api/file/complexity score + metrics (characterization)', () => {
  it('pins the high-complexity fixture: both high arms and every saturated cap', async () => {
    const r = await complexity(HIGH_REL, HIGH_SAMPLE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, GOLD_HIGH);

    // The avgSentenceLength term takes its "above 20" arm and the
    // vocabularyRichness term takes its "above 0.6" arm.
    assert.ok(r.payload.metrics.avgSentenceLength > 20, 'avgSentenceLength drives the 15 arm');
    assert.ok(r.payload.metrics.vocabularyRichness > 0.6, 'vocabularyRichness drives the 15 arm');

    // Each capped term's raw value meets or exceeds its Math.min ceiling, so the
    // cap (not the linear term) decides the contribution.
    assert.ok(r.payload.metrics.headings * 3 >= 20, 'headings term saturates at 20');
    assert.ok(r.payload.metrics.codeBlocks * 5 >= 15, 'codeBlocks term saturates at 15');
    assert.ok(r.payload.metrics.mathBlocks * 5 >= 15, 'mathBlocks term saturates at 15');
    assert.ok(r.payload.metrics.citations * 2 >= 10, 'citations term saturates at 10');
    assert.ok(r.payload.metrics.links * 2 >= 10, 'links term saturates at 10');
    assert.equal(r.payload.complexityScore, 100, 'summed score reaches the outer cap of 100');
  });

  it('returns an identical payload through the memoizing cache wrapper', async () => {
    const abs = path.join(PROJECT_ROOT, HIGH_REL);
    const viaCache = await invoke('/api/file/complexity', HIGH_REL, { ...makeCountingFs(new Map([[abs, HIGH_SAMPLE]])), ...makeCached() });
    const viaPre = await invoke('/api/file/complexity', HIGH_REL, { ...makeCountingFs(new Map([[abs, HIGH_SAMPLE]])), ...passThroughCached() });
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, GOLD_HIGH);
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
  });

  it('pins the low-complexity fixture: both linear arms and no features', async () => {
    const r = await complexity(LOW_REL, LOW_SAMPLE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, GOLD_LOW);

    // The avgSentenceLength term takes its linear "times 0.75" arm and the
    // vocabularyRichness term takes its linear "times 25" arm.
    assert.ok(r.payload.metrics.avgSentenceLength > 0 && r.payload.metrics.avgSentenceLength <= 20, 'avgSentenceLength drives the linear arm');
    assert.ok(r.payload.metrics.vocabularyRichness > 0 && r.payload.metrics.vocabularyRichness <= 0.6, 'vocabularyRichness drives the linear arm');
    assert.equal(r.payload.metrics.headings, 0);
    assert.equal(r.payload.metrics.maxHeadingDepth, 0, 'no headings means Math.max(0) is 0');
    assert.equal(r.payload.complexityScore, 9);
  });

  it('pins the empty fixture: the no-words and no-sentences zero arms', async () => {
    const r = await complexity(EMPTY_REL, EMPTY_SAMPLE);
    assert.equal(r.status, 200, 'present-but-empty content still resolves to 200, not 404');
    assert.deepEqual(r.payload, GOLD_EMPTY);

    assert.equal(r.payload.metrics.wordCount, 0, 'no words');
    assert.equal(r.payload.metrics.vocabularyRichness, 0, 'vocabularyRichness takes its zero arm when wordCount is 0');
    assert.equal(r.payload.metrics.avgSentenceLength, 0, 'avgSentenceLength takes its zero arm when there are no sentences');
    assert.equal(r.payload.complexityScore, 0);
  });

  it('pins the no-sentence fixture: the avgSentenceLength zero arm with words present', async () => {
    const r = await complexity(NOSENT_REL, NOSENT_SAMPLE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, GOLD_NOSENT);

    // Words exist, so vocabularyRichness computes, but every split segment is too
    // short to count as a sentence, so avgSentenceLength still takes its zero arm.
    assert.ok(r.payload.metrics.wordCount > 0, 'words are present');
    assert.equal(r.payload.metrics.avgSentenceLength, 0, 'no qualifying sentence even with words present');
    assert.equal(r.payload.complexityScore, 15, 'the whole score comes from the vocabularyRichness term');
  });

  it('pins the mixed fixture: list counters, the backslash-bracket math arm, and a mid-depth heading', async () => {
    const r = await complexity(MIXED_REL, MIXED_SAMPLE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, GOLD_MIXED);

    // Three bullet lines plus two ordered lines give lists 5; one \[ display-math
    // opening with no $$ pair gives mathBlocks 1; one ## heading gives depth 2.
    assert.equal(r.payload.metrics.lists, 5, 'three bullet lines plus two ordered lines');
    assert.equal(r.payload.metrics.mathBlocks, 1, 'the backslash-bracket opening counts without any $$ pair');
    assert.equal(r.payload.metrics.maxHeadingDepth, 2);
    assert.ok(r.payload.metrics.avgSentenceLength > 0 && r.payload.metrics.avgSentenceLength <= 20, 'linear avgSentenceLength arm');
    assert.ok(r.payload.metrics.vocabularyRichness > 0.6, 'high vocabularyRichness arm');
  });

  it('keeps the four metric ternary arms covered across the fixtures', () => {
    // A static cross-check on the captured goldens, which the per-fixture tests
    // above independently bind to live handler output via deepEqual. It maps which
    // fixture covers which arm so a future edit that drifts a fixture off its
    // intended branch fails loudly here. avgSentenceLength: above 20 (HIGH) and
    // the linear arm (LOW); the zero arm (EMPTY, NOSENT). vocabularyRichness:
    // above 0.6 (HIGH) and the linear arm (LOW); the zero arm (EMPTY).
    assert.ok(GOLD_HIGH.metrics.avgSentenceLength > 20);
    assert.ok(GOLD_LOW.metrics.avgSentenceLength > 0 && GOLD_LOW.metrics.avgSentenceLength <= 20);
    assert.equal(GOLD_EMPTY.metrics.avgSentenceLength, 0);
    assert.equal(GOLD_NOSENT.metrics.avgSentenceLength, 0);
    assert.ok(GOLD_HIGH.metrics.vocabularyRichness > 0.6);
    assert.ok(GOLD_LOW.metrics.vocabularyRichness > 0 && GOLD_LOW.metrics.vocabularyRichness <= 0.6);
    assert.equal(GOLD_EMPTY.metrics.vocabularyRichness, 0);
  });
});
