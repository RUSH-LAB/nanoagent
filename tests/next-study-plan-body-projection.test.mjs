import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the sibling server route tests
// do (see tests/next-study-plan-fold-totalminutes.test.mjs).
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
const READING_LISTS_FILE = '/proj/data/reading-lists.json';

// Independent reimplementation of the handler's per-item reading-time formula
// (study-knowledge.js line 446): Math.max(5, Math.ceil(wordCount / 200)). It is
// defined here and never imported, so every assertion that uses it cross-checks
// the handler rather than echoing its code.
const readingTime = (wordCount) => Math.max(5, Math.ceil(wordCount / 200));

// Word counts are chosen so each arm of the formula is pinned non-vacuously:
//   - LONG_DOC_WORDS / 200 = 55.05, whose ceil (56) exceeds both its floor (55)
//     and its round (55); the result therefore isolates Math.ceil and clears the
//     5 minute floor. At 56 minutes the long doc nearly fills a 60 minute week on
//     its own, so the next 5 minute item tips the running total past 60
//     (56 + 5 = 61) and opens week 2, forcing the bucket split in the explicit
//     hoursPerWeek case below.
//   - SHORT_DOC_WORDS / 200 = 0.15, whose ceil (1) is clamped up to 5 by
//     Math.max, so a doc that is genuinely read can still floor at the minimum.
const LONG_DOC_WORDS = 11010;
const SHORT_DOC_WORDS = 30;

// 'word '.repeat(n) yields exactly n words once the handler runs
// text.split(/\s+/).filter(Boolean), because the trailing space drops out.
const DOC_TEXTS = {
  'content/long.md': 'word '.repeat(LONG_DOC_WORDS),
  'content/short.md': 'word '.repeat(SHORT_DOC_WORDS),
};

// readFileSync stand-in: returns the fixed body for a known doc path and throws
// for anything else. The handler joins PROJECT_ROOT with item.path, so the lookup
// reverses that join back to the relative key.
function readDocFromMap(fullPath) {
  const rel = path.relative(PROJECT_ROOT, fullPath);
  if (Object.hasOwn(DOC_TEXTS, rel)) return DOC_TEXTS[rel];
  throw new Error(`unexpected readFileSync path: ${fullPath}`);
}

// A list mixing a long `doc`, a non-doc `link`, and a short `doc`. The long doc
// exercises the Math.ceil arm; the link exercises the non-doc wordCount 0 arm and
// the 5 minute floor; the short doc proves a genuinely read file can still floor.
const MIXED_LIST = {
  id: 'mixed',
  name: 'Mixed Reading List',
  items: [
    { type: 'doc', path: 'content/long.md', title: 'Long Doc' },
    { type: 'link', url: 'https://example.test', title: 'External Link' },
    { type: 'doc', path: 'content/short.md', title: 'Short Doc' },
  ],
};

// A single-doc list whose read throws, isolating the try/catch swallow that pins
// wordCount at 0 when a doc cannot be read.
const THROW_LIST = {
  id: 'throws',
  name: 'Throwing Doc List',
  items: [{ type: 'doc', path: 'content/missing.md', title: 'Missing' }],
};

// Full plan golden captured from the real handler (a throwaway probe) for the
// explicit hoursPerWeek = 1 case. minutesPerWeek = 60, so the 56 minute long doc
// fills week 1 and the two 5 minute items spill into week 2; the order field stays
// the global source index, so week 2 carries order 1 then 2 (never reset per week).
const MIXED_GOLDEN_PLAN = {
  listName: 'Mixed Reading List',
  totalItems: 3,
  totalReadingMinutes: 66,
  hoursPerWeek: 1,
  estimatedWeeks: 2,
  weeks: [
    {
      week: 1,
      items: [
        { type: 'doc', path: 'content/long.md', title: 'Long Doc', order: 0, readingTimeMin: 56, wordCount: 11010 },
      ],
      totalMinutes: 56,
    },
    {
      week: 2,
      items: [
        { type: 'link', url: 'https://example.test', title: 'External Link', order: 1, readingTimeMin: 5, wordCount: 0 },
        { type: 'doc', path: 'content/short.md', title: 'Short Doc', order: 2, readingTimeMin: 5, wordCount: 30 },
      ],
      totalMinutes: 10,
    },
  ],
};

// The same list with hoursPerWeek omitted: hpw falls back to 10 via `|| 10`, so
// minutesPerWeek = 600 and all 66 minutes fold into a single week.
const OMITTED_GOLDEN_PLAN = {
  listName: 'Mixed Reading List',
  totalItems: 3,
  totalReadingMinutes: 66,
  hoursPerWeek: 10,
  estimatedWeeks: 1,
  weeks: [
    {
      week: 1,
      items: [
        { type: 'doc', path: 'content/long.md', title: 'Long Doc', order: 0, readingTimeMin: 56, wordCount: 11010 },
        { type: 'link', url: 'https://example.test', title: 'External Link', order: 1, readingTimeMin: 5, wordCount: 0 },
        { type: 'doc', path: 'content/short.md', title: 'Short Doc', order: 2, readingTimeMin: 5, wordCount: 30 },
      ],
      totalMinutes: 66,
    },
  ],
};

// Drive the real POST /api/study-plan handler over a mocked ctx and capture the
// {status, body} it hands to json(res, status, body), mirroring the sibling
// tests/next-study-plan-fold-totalminutes.test.mjs. The caller supplies the exact
// request body so the omitted-hoursPerWeek case can leave the key off entirely.
async function runStudyPlan({ body, lists, readFileSync }) {
  let captured = null;
  const ctx = {
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: (fp) => {
      if (fp === READING_LISTS_FILE) return { lists };
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    fs: { readFileSync },
    isValidFilePath: () => true,
    path,
    PROJECT_ROOT,
    READING_LISTS_FILE,
    json: (_res, status, payload) => { captured = { status, body: payload }; },
  };
  const pathname = '/api/study-plan';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return captured;
}

describe('POST /api/study-plan pins the computed plan body projection', () => {
  it('arithmetic sanity: the local reading-time formula matches the chosen fixtures', () => {
    assert.equal(readingTime(LONG_DOC_WORDS), 56); // ceil(55.05) clears the 5 minute floor
    assert.equal(readingTime(SHORT_DOC_WORDS), 5); // ceil(0.15) clamped up to 5
    assert.equal(readingTime(0), 5);               // non-doc items count 0 words and floor at 5
  });

  it('deep-equals the full plan body for a mixed list with an explicit hoursPerWeek', async () => {
    const r = await runStudyPlan({
      body: { listId: 'mixed', hoursPerWeek: 1 },
      lists: [MIXED_LIST],
      readFileSync: readDocFromMap,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan, MIXED_GOLDEN_PLAN);
  });

  it('pins plan.listName as the passthrough of list.name', async () => {
    const r = await runStudyPlan({
      body: { listId: 'mixed', hoursPerWeek: 1 },
      lists: [MIXED_LIST],
      readFileSync: readDocFromMap,
    });
    assert.equal(r.body.plan.listName, 'Mixed Reading List');
    assert.equal(r.body.plan.listName, MIXED_LIST.name);
  });

  it('pins plan.hoursPerWeek to the explicit request value', async () => {
    const r = await runStudyPlan({
      body: { listId: 'mixed', hoursPerWeek: 1 },
      lists: [MIXED_LIST],
      readFileSync: readDocFromMap,
    });
    assert.equal(r.body.plan.hoursPerWeek, 1);
  });

  it('pins the per-item weeks[].items[] projection: order index, spread, wordCount, readingTimeMin', async () => {
    const r = await runStudyPlan({
      body: { listId: 'mixed', hoursPerWeek: 1 },
      lists: [MIXED_LIST],
      readFileSync: readDocFromMap,
    });
    const { weeks } = r.body.plan;

    // The long doc occupies week 1 alone; the link and short doc share week 2.
    const longDoc = weeks[0].items[0];
    const link = weeks[1].items[0];
    const shortDoc = weeks[1].items[1];

    // Each projected item is exactly {...item, order: i, readingTimeMin, wordCount}.
    assert.deepEqual(longDoc, {
      type: 'doc', path: 'content/long.md', title: 'Long Doc',
      order: 0, readingTimeMin: 56, wordCount: 11010,
    });
    assert.deepEqual(link, {
      type: 'link', url: 'https://example.test', title: 'External Link',
      order: 1, readingTimeMin: 5, wordCount: 0,
    });
    assert.deepEqual(shortDoc, {
      type: 'doc', path: 'content/short.md', title: 'Short Doc',
      order: 2, readingTimeMin: 5, wordCount: 30,
    });

    // order is the GLOBAL source index, not the position within a week: week 2
    // carries order 1 then 2 rather than resetting to 0.
    assert.deepEqual(weeks.flatMap(w => w.items.map(it => it.order)), [0, 1, 2]);

    // The spread preserves each original field: a doc keeps its path and gains no
    // url, while a link keeps its url and gains no path.
    assert.equal(longDoc.path, MIXED_LIST.items[0].path);
    assert.equal(longDoc.url, undefined);
    assert.equal(link.url, MIXED_LIST.items[1].url);
    assert.equal(link.path, undefined);
    assert.equal(shortDoc.title, MIXED_LIST.items[2].title);

    // wordCount: counted for docs, 0 for the non-doc link. readingTimeMin: the
    // Math.ceil arm for the long doc, the Math.max floor for the link and for the
    // genuinely read but short doc.
    assert.equal(longDoc.wordCount, LONG_DOC_WORDS);
    assert.equal(longDoc.readingTimeMin, readingTime(LONG_DOC_WORDS)); // 56, above the floor
    assert.equal(link.wordCount, 0);
    assert.equal(link.readingTimeMin, readingTime(0)); // floored to 5
    assert.equal(shortDoc.wordCount, SHORT_DOC_WORDS);
    assert.equal(shortDoc.readingTimeMin, readingTime(SHORT_DOC_WORDS)); // floored to 5
  });

  it('defaults hoursPerWeek to 10 when omitted, widening the week to 600 minutes', async () => {
    const r = await runStudyPlan({
      body: { listId: 'mixed' }, // hoursPerWeek omitted entirely, exercising the `|| 10` default
      lists: [MIXED_LIST],
      readFileSync: readDocFromMap,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.plan.hoursPerWeek, 10);
    // minutesPerWeek = 600, so all three items fold into one week instead of the
    // two weeks the explicit hoursPerWeek = 1 case produced.
    assert.equal(r.body.plan.estimatedWeeks, 1);
    assert.equal(r.body.plan.weeks[0].totalMinutes, 66);
    assert.deepEqual(r.body.plan, OMITTED_GOLDEN_PLAN);
  });

  it('swallows a failed doc read to wordCount 0 and floors readingTimeMin at 5', async () => {
    const r = await runStudyPlan({
      body: { listId: 'throws', hoursPerWeek: 1 },
      lists: [THROW_LIST],
      readFileSync: () => { throw new Error('ENOENT: simulated unreadable doc'); },
    });
    assert.equal(r.status, 200);
    const item = r.body.plan.weeks[0].items[0];
    assert.equal(item.wordCount, 0);
    assert.equal(item.readingTimeMin, 5);
    assert.deepEqual(item, {
      type: 'doc', path: 'content/missing.md', title: 'Missing',
      order: 0, readingTimeMin: 5, wordCount: 0,
    });
    assert.deepEqual(r.body.plan, {
      listName: 'Throwing Doc List',
      totalItems: 1,
      totalReadingMinutes: 5,
      hoursPerWeek: 1,
      estimatedWeeks: 1,
      weeks: [
        {
          week: 1,
          items: [
            { type: 'doc', path: 'content/missing.md', title: 'Missing', order: 0, readingTimeMin: 5, wordCount: 0 },
          ],
          totalMinutes: 5,
        },
      ],
    });
  });
});
