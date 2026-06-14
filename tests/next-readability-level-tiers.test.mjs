import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// GET /api/file/readability in server/routes/file-tools.js classifies a page into
// one of four reading levels from its Flesch-Kincaid grade:
//   grade 6 or less        => 'Easy'
//   grade over 6 up to 10  => 'Intermediate'
//   grade over 10 up to 14 => 'Advanced'
//   grade over 14          => 'Expert'
//
// The sibling tests/next-readability-hoist-regexes.test.mjs already pins the full
// payload, but only for fixtures whose grade lands on 'Intermediate'. The other
// three arms ('Easy', 'Advanced', 'Expert') were a genuine 0-hit. This file pins
// those three plus one 'Intermediate' for completeness, asserting the ENTIRE
// payload rather than only the level string.
//
// The handler has no cache wrap: it reads the page directly through ctx.fs. So
// each fixture is written to a real temp directory and read back by the real
// handler. The goldens below were captured from the real handler over these exact
// fixtures (a throwaway probe), never hand computed: the grade comes from the real
// syllable counting and sentence splitting code, so only the handler itself can
// produce these numbers. This is add-only characterization: no source is changed.

const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

// One fixture per classification arm. Each `golden` is the exact payload the real
// handler returned for `content`; deepEqual against it pins every metric, and the
// `band` predicate ties the captured grade to the ladder branch it must exercise.
const TIERS = [
  {
    tier: 'Easy',
    file: 'easy.md',
    content: `The students read short stories in class today. They wrote notes about each person and shared ideas. The teacher asked them simple questions before lunch.`,
    golden: {
      wordCount: 25,
      sentenceCount: 3,
      avgWordsPerSentence: 8.3,
      avgSyllablesPerWord: 1.4,
      fleschKincaidGrade: 4.2,
      readingLevel: 'Easy',
      readingTimeMinutes: 1,
    },
    inBand: (g) => g <= 6,
  },
  {
    tier: 'Intermediate',
    file: 'intermediate.md',
    content: `The teacher asked her pupils to compare two stories before the holiday. Each child explained which characters felt the most realistic and honest.`,
    golden: {
      wordCount: 23,
      sentenceCount: 2,
      avgWordsPerSentence: 11.5,
      avgSyllablesPerWord: 1.6,
      fleschKincaidGrade: 7.8,
      readingLevel: 'Intermediate',
      readingTimeMinutes: 1,
    },
    inBand: (g) => g > 6 && g <= 10,
  },
  {
    tier: 'Advanced',
    file: 'advanced.md',
    content: `Researchers studied how reading habits shape memory among older adults. Their findings suggested that regular mental activity helps preserve reasoning skills.`,
    golden: {
      wordCount: 21,
      sentenceCount: 2,
      avgWordsPerSentence: 10.5,
      avgSyllablesPerWord: 2,
      fleschKincaidGrade: 12.1,
      readingLevel: 'Advanced',
      readingTimeMinutes: 1,
    },
    inBand: (g) => g > 10 && g <= 14,
  },
  {
    tier: 'Expert',
    file: 'expert.md',
    content: `Modern education systems often require students to analyze complex material and develop critical thinking abilities over many years. Effective teachers encourage learners to question popular assumptions and pursue deeper understanding through patient study.`,
    golden: {
      wordCount: 33,
      sentenceCount: 2,
      avgWordsPerSentence: 16.5,
      avgSyllablesPerWord: 2.2,
      fleschKincaidGrade: 16.8,
      readingLevel: 'Expert',
      readingTimeMinutes: 1,
    },
    inBand: (g) => g > 14,
  },
];

let ROOT;

// Drive GET /api/file/readability with a ctx whose fs and path are the real Node
// modules and whose PROJECT_ROOT is the temp fixture directory, so the handler
// reads the fixture written to disk. isValidFilePath accepts every path by default
// so the assertions focus on the scoring body; json() is captured, not written.
async function getReadability(relPath, { isValidFilePath = () => true } = {}) {
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT: ROOT,
    isValidFilePath,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL(`http://localhost/api/file/readability?path=${encodeURIComponent(relPath)}`);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/readability', ctx);
  return captured;
}

describe('GET /api/file/readability reading-level tiers', () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'readability-tiers-'));
    for (const { file, content } of TIERS) {
      fs.writeFileSync(path.join(ROOT, file), content);
    }
  });

  after(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  for (const { tier, file, golden, inBand } of TIERS) {
    const article = /^[aeiou]/i.test(tier) ? 'an' : 'a';
    it(`classifies ${article} ${tier} page and pins its full payload`, async () => {
      const res = await getReadability(file);
      assert.equal(res.status, 200);
      // Full payload pinned, not just the level string.
      assert.deepEqual(res.payload, golden);
      // The two fields the goal calls out, asserted explicitly and non-vacuously.
      assert.equal(res.payload.readingLevel, tier);
      assert.equal(res.payload.fleschKincaidGrade, golden.fleschKincaidGrade);
      // The captured grade lands in the ladder band that yields this tier, which
      // is the exact classification arm this fixture is here to exercise.
      assert.ok(
        inBand(res.payload.fleschKincaidGrade),
        `grade ${res.payload.fleschKincaidGrade} should fall in the ${tier} band`,
      );
    });
  }

  it('keeps the four tiers distinct (every band is exercised by a different fixture)', () => {
    const levels = TIERS.map((t) => t.golden.readingLevel);
    assert.deepEqual(levels, ['Easy', 'Intermediate', 'Advanced', 'Expert']);
    assert.equal(new Set(levels).size, 4);
  });

  it('rejects an invalid path with 400 before reading any file', async () => {
    const res = await getReadability('../etc/passwd', { isValidFilePath: () => false });
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Invalid path' });
  });

  it('returns 404 when the page does not exist', async () => {
    // No fixture written for this name, so the real fs throws ENOENT and the
    // handler falls through to its catch/404 branch.
    const res = await getReadability('does-not-exist.md');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'File not found' });
  });
});
