import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load the REAL module via createRequire the way
// the sibling style suites do (next-content-b-filemicro-cache.test.mjs and
// next-style-passive-hoist.test.mjs). This is an add-only characterization test: it
// pins the CURRENT output of GET /api/file/style and changes no source.
//
// Those two sibling suites pin ONLY style.totalSentences and
// style.passiveVoicePercentage (plus value-blind transparency/stability
// deepEquals), leaving the four DERIVED metrics a genuine 0-hit:
// avgSentenceLength, sentenceLengthVariation, vocabularyDiversity, and
// avgParagraphLength were never pinned to a concrete value for this handler. This
// suite closes that gap with full-payload goldens captured from the real handler.
//
// The goldens below were captured from the real handler (a throwaway probe that
// required this module and ran each fixture through a pass-through cached and a
// mocked fs), never hand derived: the population-variance-against-the-rounded-mean
// and the strip pipeline are easy to get subtly wrong. The full-payload
// assert.deepEqual is the authoritative pin; the extra guards make each branch's
// intent explicit and non-vacuous.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';

// The GET /api/file/style handler reads a SINGLE file by path
// (fs.readFileSync(path.join(PROJECT_ROOT, filePath))); it never walks a
// directory, so the stub only needs readFileSync keyed by absolute path. A missing
// path throws ENOENT, mirroring real fs, so the not-found branch stays reachable.
function makeFs(absFileMap) {
  return {
    readFileSync(fp) {
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Drive GET /api/file/style with a mocked ctx and capture the payload handed to
// json(res, status, payload). cached is a PASS-THROUGH (it runs fn() inline), so
// this exercises the exact pre-cache code path; the handler touches no network,
// clock, randomness, or directory walk, so every metric is fully deterministic.
async function invokeStyle(content, filePath) {
  const abs = path.join(PROJECT_ROOT, filePath);
  const fs = makeFs(new Map([[abs, content]]));
  const url = new URL(`http://localhost/api/file/style?path=${encodeURIComponent(filePath)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    isValidFilePath: () => true,
    cached: (_k, _t, fn) => fn(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/style', ctx);
  return captured;
}

// ── Fixtures: each isolates one branch of the inner transform ──

// A normal multi-sentence, multi-paragraph document. Sentence word counts differ
// widely ([14, 2, 5, 2, 13, 5]) so sentenceLengthVariation is non-trivial, and the
// repeated "the"/"The" keeps vocabularyDiversity strictly between 0 and 1. ALL four
// derived metrics are non-zero here.
const NORMAL_REL = 'content/style-normal.md';
const NORMAL = `The bright autumn morning brought a gentle cool breeze across the wide open valley. Dogs ran. The curious children watched silently. We waited.

Researchers carefully analyzed the surprising experimental results over many long late nights together. Birds sang softly at dawn.
`;
const NORMAL_GOLDEN = {
  path: 'content/style-normal.md',
  style: {
    avgSentenceLength: 6.8,
    sentenceLengthVariation: 4.9,
    passiveVoicePercentage: 0,
    vocabularyDiversity: 0.93,
    avgParagraphLength: 21,
    totalSentences: 6,
    totalParagraphs: 2,
    totalWords: 41,
  },
};

// Exactly ONE qualifying sentence (sentenceLengths.length === 1), so
// sentenceLengthVariation takes its length-not-greater-than-1 zero arm while
// avgSentenceLength stays non-zero.
const ONE_SENTENCE_REL = 'content/style-one-sentence.md';
const ONE_SENTENCE = `This is a single qualifying sentence here.
`;
const ONE_SENTENCE_GOLDEN = {
  path: 'content/style-one-sentence.md',
  style: {
    avgSentenceLength: 7,
    sentenceLengthVariation: 0,
    passiveVoicePercentage: 0,
    vocabularyDiversity: 1,
    avgParagraphLength: 8,
    totalSentences: 1,
    totalParagraphs: 1,
    totalWords: 7,
  },
};

// Every segment is 5 characters or shorter once trimmed ("Cat"/"Dog"/"Sun"), so
// the length-greater-than-5 filter drops them all: sentences.length === 0 pins
// BOTH avgSentenceLength = 0 and sentenceLengthVariation = 0.
const NO_SENTENCE_REL = 'content/style-no-sentence.md';
const NO_SENTENCE = `Cat. Dog. Sun.
`;
const NO_SENTENCE_GOLDEN = {
  path: 'content/style-no-sentence.md',
  style: {
    avgSentenceLength: 0,
    sentenceLengthVariation: 0,
    passiveVoicePercentage: 0,
    vocabularyDiversity: 1,
    avgParagraphLength: 4,
    totalSentences: 0,
    totalParagraphs: 1,
    totalWords: 3,
  },
};

// Whitespace only: after the strip pipeline nothing remains, so
// words.length === 0 pins vocabularyDiversity = 0 (and every other metric 0).
const NO_WORDS_REL = 'content/style-no-words.md';
const NO_WORDS = `

   `;
const NO_WORDS_GOLDEN = {
  path: 'content/style-no-words.md',
  style: {
    avgSentenceLength: 0,
    sentenceLengthVariation: 0,
    passiveVoicePercentage: 0,
    vocabularyDiversity: 0,
    avgParagraphLength: 0,
    totalSentences: 0,
    totalParagraphs: 0,
    totalWords: 0,
  },
};

// No block longer than 10 trimmed characters ("Coffee." and "Pillows." are 7 and
// 8), so paragraphs.length === 0 pins avgParagraphLength = 0. There are still two
// qualifying sentences, so the zero arm is reached with real content present (not
// an empty document).
const NO_PARAGRAPH_REL = 'content/style-no-paragraph.md';
const NO_PARAGRAPH = `Coffee.

Pillows.
`;
const NO_PARAGRAPH_GOLDEN = {
  path: 'content/style-no-paragraph.md',
  style: {
    avgSentenceLength: 1,
    sentenceLengthVariation: 0,
    passiveVoicePercentage: 0,
    vocabularyDiversity: 1,
    avgParagraphLength: 0,
    totalSentences: 2,
    totalParagraphs: 0,
    totalWords: 2,
  },
};

// Frontmatter, a fenced code block, and an HTML tag each carry words AND a
// full sentence that MUST be stripped before counting. Only the two visible
// sentences survive ("Real visible prose lives here plainly today." and "The word
// emphasis stays here." — the <b ...> tag is removed but its inner text remains).
// The golden pins totalSentences = 2 and totalWords = 12, far below the raw
// pre-strip counts asserted below.
const STRIP_REL = 'content/style-strip.md';
const STRIP = `---
title: Strip Fixture
summary: This frontmatter sentence must be stripped completely away.
---

Real visible prose lives here plainly today.

\`\`\`python
# This code sentence must also be stripped completely away.
ignored = "zeta eta theta iota"
\`\`\`

The word <b data-note="This attribute sentence must vanish too.">emphasis</b> stays here.
`;
const STRIP_GOLDEN = {
  path: 'content/style-strip.md',
  style: {
    avgSentenceLength: 6,
    sentenceLengthVariation: 1,
    passiveVoicePercentage: 0,
    vocabularyDiversity: 1,
    avgParagraphLength: 7,
    totalSentences: 2,
    totalParagraphs: 2,
    totalWords: 12,
  },
};

describe('GET /api/file/style derived metrics (full-payload goldens)', () => {
  it('pins all four derived metrics non-zero on a normal multi-paragraph document', async () => {
    const r = await invokeStyle(NORMAL, NORMAL_REL);
    assert.equal(r.status, 200);
    // Authoritative pin: the entire payload, path and every style field.
    assert.deepEqual(r.payload, NORMAL_GOLDEN);
    // Non-vacuous branch guards: every derived metric is genuinely non-zero, and
    // vocabularyDiversity is a proper ratio strictly inside (0, 1).
    assert.ok(r.payload.style.avgSentenceLength > 0, 'avgSentenceLength is non-zero');
    assert.ok(r.payload.style.sentenceLengthVariation > 0, 'variation is non-trivial across differing sentence lengths');
    assert.ok(r.payload.style.vocabularyDiversity > 0 && r.payload.style.vocabularyDiversity < 1, 'diversity is a ratio strictly between 0 and 1');
    assert.ok(r.payload.style.avgParagraphLength > 0, 'avgParagraphLength is non-zero');
    assert.ok(r.payload.style.totalParagraphs >= 2, 'multiple qualifying paragraphs');
  });

  it('pins sentenceLengthVariation = 0 on the single-sentence arm (avgSentenceLength still non-zero)', async () => {
    const r = await invokeStyle(ONE_SENTENCE, ONE_SENTENCE_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, ONE_SENTENCE_GOLDEN);
    // One qualifying sentence: the variance arm guards on length > 1, so it is 0,
    // yet avgSentenceLength is computed and non-zero.
    assert.equal(r.payload.style.totalSentences, 1);
    assert.equal(r.payload.style.sentenceLengthVariation, 0);
    assert.ok(r.payload.style.avgSentenceLength > 0);
  });

  it('pins avgSentenceLength = 0 and sentenceLengthVariation = 0 on the no-sentence arm', async () => {
    const r = await invokeStyle(NO_SENTENCE, NO_SENTENCE_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, NO_SENTENCE_GOLDEN);
    // Every segment is 5 characters or shorter, so the filter drops them all and
    // both sentence metrics take their zero arms.
    assert.equal(r.payload.style.totalSentences, 0);
    assert.equal(r.payload.style.avgSentenceLength, 0);
    assert.equal(r.payload.style.sentenceLengthVariation, 0);
  });

  it('pins vocabularyDiversity = 0 on the no-words arm', async () => {
    const r = await invokeStyle(NO_WORDS, NO_WORDS_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, NO_WORDS_GOLDEN);
    // Whitespace only after stripping: words.length === 0 takes the diversity zero
    // arm, and every other metric is 0 too.
    assert.equal(r.payload.style.totalWords, 0);
    assert.equal(r.payload.style.vocabularyDiversity, 0);
  });

  it('pins avgParagraphLength = 0 on the no-paragraph arm (with content still present)', async () => {
    const r = await invokeStyle(NO_PARAGRAPH, NO_PARAGRAPH_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, NO_PARAGRAPH_GOLDEN);
    // No block exceeds 10 trimmed characters, so the paragraph metric takes its
    // zero arm even though two sentences and words are present (non-vacuous: the
    // document is not empty).
    assert.equal(r.payload.style.totalParagraphs, 0);
    assert.equal(r.payload.style.avgParagraphLength, 0);
    assert.ok(r.payload.style.totalSentences > 0, 'content is present; only the paragraph filter is empty');
    assert.ok(r.payload.style.totalWords > 0);
  });

  it('strips frontmatter, fenced code, and HTML tags before counting', async () => {
    const r = await invokeStyle(STRIP, STRIP_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, STRIP_GOLDEN);
    // Non-vacuous strip proof: the raw fixture (before stripping) carries far more
    // whitespace-delimited tokens and qualifying sentences than the handler counts,
    // proving the frontmatter / code / tag content was removed and never inflated
    // totalWords or totalSentences.
    const rawTokens = STRIP.split(/\s+/).filter(Boolean).length;
    const rawSentences = STRIP.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 5).length;
    assert.ok(r.payload.style.totalWords < rawTokens, `post-strip words ${r.payload.style.totalWords} < raw tokens ${rawTokens}`);
    assert.ok(r.payload.style.totalSentences < rawSentences, `post-strip sentences ${r.payload.style.totalSentences} < raw sentences ${rawSentences}`);
    assert.equal(r.payload.style.totalSentences, 2);
    assert.equal(r.payload.style.totalWords, 12);
  });
});
