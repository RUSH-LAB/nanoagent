import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
const READING_LISTS_FILE = '/proj/data/reading-lists.json';

// Fixed-length text so every doc item produces a deterministic word count. The
// handler counts words with `text.split(/\s+/).filter(Boolean).length`, so the
// trailing space from repeat() drops out and the count is exactly DOC_WORDS.
const DOC_WORDS = 8000;
const DOC_TEXT = 'word '.repeat(DOC_WORDS);

// Reading time mirrors the handler: Math.max(5, Math.ceil(wordCount / 200)). Doc
// items read DOC_TEXT; non-doc items never touch the filesystem, so their word
// count stays 0 and they floor at the 5 minute minimum.
const readingTime = (wordCount) => Math.max(5, Math.ceil(wordCount / 200));
const DOC_MINUTES = readingTime(DOC_WORDS); // 40
const NON_DOC_MINUTES = readingTime(0);     // 5

// A list mixing `type: 'doc'` paths with a non-doc item, so the folded
// accumulator is exercised across both branches of the word-count map.
const MIXED_LIST = {
  id: 'mixed',
  name: 'Mixed Reading List',
  items: [
    { type: 'doc', path: 'content/intro.md', title: 'Intro' },
    { type: 'link', url: 'https://example.test', title: 'External' },
    { type: 'doc', path: 'content/deep.md', title: 'Deep Dive' },
  ],
};

// Independent hand computation of the grand total, summed from the per-item
// formula rather than from the handler, so it cross-checks the dropped reduce.
const EXPECTED_TOTAL = MIXED_LIST.items.reduce(
  (sum, item) => sum + (item.type === 'doc' ? DOC_MINUTES : NON_DOC_MINUTES),
  0,
);

// Drive the real POST /api/study-plan handler over a mocked ctx and capture the
// response it hands to json(res, status, body). loadJSON answers only for the
// reading-lists file so any stray read surfaces as an error; fs.readFileSync
// returns the fixed text for every doc path.
async function runStudyPlan({ listId, hoursPerWeek, lists }) {
  let captured = null;
  const ctx = {
    rateLimit: () => true,
    readBody: async () => ({ listId, hoursPerWeek }),
    loadJSON: (fp) => {
      if (fp === READING_LISTS_FILE) return { lists };
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    fs: { readFileSync: () => DOC_TEXT },
    isValidFilePath: () => true,
    path,
    PROJECT_ROOT,
    READING_LISTS_FILE,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const pathname = '/api/study-plan';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return captured;
}

describe('POST /api/study-plan folds totalMinutes into the weeks loop', () => {
  it('totalReadingMinutes equals the hand-computed per-item sum', async () => {
    const r = await runStudyPlan({ listId: 'mixed', hoursPerWeek: 1, lists: [MIXED_LIST] });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.totalReadingMinutes, EXPECTED_TOTAL); // 40 + 5 + 40 = 85
    assert.equal(r.body.plan.totalItems, MIXED_LIST.items.length);
  });

  it('estimatedWeeks matches the weeks length and the per-week minutes re-sum to the total', async () => {
    const r = await runStudyPlan({ listId: 'mixed', hoursPerWeek: 1, lists: [MIXED_LIST] });
    const { plan } = r.body;
    // hoursPerWeek 1 caps each week at 60 minutes, so the three items (40, 5, 40)
    // split across two weeks: [40 + 5] then [40].
    assert.equal(plan.estimatedWeeks, 2);
    assert.equal(plan.estimatedWeeks, plan.weeks.length);
    const weekSum = plan.weeks.reduce((sum, w) => sum + w.totalMinutes, 0);
    assert.equal(weekSum, plan.totalReadingMinutes);
  });

  it('an empty or missing item list still yields a coherent zero-minute plan', async () => {
    const empty = await runStudyPlan({
      listId: 'empty',
      hoursPerWeek: 10,
      lists: [{ id: 'empty', name: 'Empty', items: [] }],
    });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.plan.totalReadingMinutes, 0);
    assert.equal(empty.body.plan.totalItems, 0);
    assert.equal(empty.body.plan.estimatedWeeks, 0);
    assert.deepEqual(empty.body.plan.weeks, []);

    // A list with no items array at all behaves the same way.
    const missing = await runStudyPlan({
      listId: 'noitems',
      hoursPerWeek: 10,
      lists: [{ id: 'noitems', name: 'No Items' }],
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.plan.totalReadingMinutes, 0);
  });
});
