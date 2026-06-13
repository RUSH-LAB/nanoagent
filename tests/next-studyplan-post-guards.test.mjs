import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load it the way the sibling server route tests
// do (see tests/next-study-plan-fold-totalminutes.test.mjs).
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const READING_LISTS_FILE = '/proj/data/reading-lists.json';
const REMOTE_ADDR = '198.51.100.23';

// Drive the real POST /api/study-plan handler (study-knowledge.js lines 431 to
// 477) over a fully mocked ctx. Every helper the guard ladder touches is a
// recorder so each case can assert exactly how far the handler progressed:
//   calls.rateLimit : array of {key, limit} the handler passed to rateLimit
//   calls.readBody  : number of times readBody was awaited
//   calls.loadJSON  : array of file paths handed to loadJSON
//   calls.saveJSON  : number of times saveJSON was called (always 0 here; this
//                     handler is read only, so it pins that no write occurs)
// The happy path (week folding) is already pinned by the sibling, so this file
// covers only the guard ladder, which returns before the item mapping runs.
// That is why fs / isValidFilePath / PROJECT_ROOT are intentionally absent from
// ctx: no guard case reaches the code that would read them.
async function runStudyPlan(opts = {}) {
  const {
    listId,
    hoursPerWeek,
    rateLimitResult = true,
    readBodyThrows = false,
    loadJSONThrows = false,
    loadResult = { lists: [] },
    remoteAddress = REMOTE_ADDR,
  } = opts;

  const calls = { rateLimit: [], readBody: 0, loadJSON: [], saveJSON: 0 };
  let captured = null;

  const ctx = {
    rateLimit: (key, limit) => {
      calls.rateLimit.push({ key, limit });
      return rateLimitResult;
    },
    readBody: async () => {
      calls.readBody += 1;
      if (readBodyThrows) throw new Error('readBody boom');
      return { listId, hoursPerWeek };
    },
    loadJSON: (fp) => {
      calls.loadJSON.push(fp);
      if (loadJSONThrows) throw new Error('loadJSON boom');
      return loadResult;
    },
    saveJSON: () => { calls.saveJSON += 1; },
    json: (_res, status, body) => { captured = { status, body }; },
    READING_LISTS_FILE,
  };

  const pathname = '/api/study-plan';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, calls };
}

describe('POST /api/study-plan input-validation guard ladder', () => {
  it('returns 429 and skips readBody/loadJSON/saveJSON when rateLimit denies the study-plan key', async () => {
    const { captured, calls } = await runStudyPlan({ listId: 'any', rateLimitResult: false });

    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });

    // Rate limited before the try block: nothing past the gate ran.
    assert.equal(calls.rateLimit.length, 1);
    assert.deepEqual(calls.rateLimit[0], { key: `study-plan:${REMOTE_ADDR}`, limit: 30 });
    assert.equal(calls.readBody, 0);
    assert.equal(calls.loadJSON.length, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('returns 400 Missing or invalid listId for a falsy listId, before loadJSON', async () => {
    for (const listId of [undefined, '', 0, null, false]) {
      const { captured, calls } = await runStudyPlan({ listId });

      assert.equal(captured.status, 400);
      assert.deepEqual(captured.body, { error: 'Missing or invalid listId' });

      // The body was read, then the guard tripped before any reading-list load.
      assert.equal(calls.rateLimit.length, 1);
      assert.equal(calls.readBody, 1);
      assert.equal(calls.loadJSON.length, 0);
      assert.equal(calls.saveJSON, 0);
    }
  });

  it('returns 400 Missing or invalid listId for a non-string listId, before loadJSON', async () => {
    for (const listId of [123, { id: 'x' }, ['x'], true]) {
      const { captured, calls } = await runStudyPlan({ listId });

      assert.equal(captured.status, 400);
      assert.deepEqual(captured.body, { error: 'Missing or invalid listId' });

      assert.equal(calls.readBody, 1);
      assert.equal(calls.loadJSON.length, 0);
      assert.equal(calls.saveJSON, 0);
    }
  });

  it('returns 404 Reading list not found after exactly one loadJSON read and no saveJSON', async () => {
    // A populated lists array that does not contain the requested id.
    const present = await runStudyPlan({
      listId: 'missing',
      loadResult: { lists: [{ id: 'other', name: 'Other' }] },
    });
    assert.equal(present.captured.status, 404);
    assert.deepEqual(present.captured.body, { error: 'Reading list not found' });
    assert.equal(present.calls.readBody, 1);
    assert.equal(present.calls.loadJSON.length, 1);
    assert.equal(present.calls.loadJSON[0], READING_LISTS_FILE);
    assert.equal(present.calls.saveJSON, 0);

    // A store with no lists key at all takes the (data.lists || []) fallback and
    // still resolves to not found.
    const empty = await runStudyPlan({ listId: 'missing', loadResult: {} });
    assert.equal(empty.captured.status, 404);
    assert.deepEqual(empty.captured.body, { error: 'Reading list not found' });
    assert.equal(empty.calls.loadJSON.length, 1);
    assert.equal(empty.calls.saveJSON, 0);
  });

  it('returns 400 Study plan generation failed from the outer catch when readBody throws', async () => {
    const { captured, calls } = await runStudyPlan({ listId: 'ok', readBodyThrows: true });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Study plan generation failed' });

    // readBody threw inside the try, so loadJSON and saveJSON never ran.
    assert.equal(calls.rateLimit.length, 1);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON.length, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('returns 400 Study plan generation failed from the outer catch when loadJSON throws', async () => {
    const { captured, calls } = await runStudyPlan({ listId: 'ok', loadJSONThrows: true });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Study plan generation failed' });

    // A valid string listId clears the early guard, then loadJSON throws.
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON.length, 1);
    assert.equal(calls.loadJSON[0], READING_LISTS_FILE);
    assert.equal(calls.saveJSON, 0);
  });
});
