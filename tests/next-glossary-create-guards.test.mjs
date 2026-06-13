import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module the way the sibling
// server route tests do, so these cases exercise the shipped POST /api/glossary
// handler rather than a reimplementation.
const require = createRequire(import.meta.url);
const studyRoutes = require('../server/routes/study-knowledge.js');

// WHY THESE BRANCHES ARE FULLY DETERMINISTIC
// ──────────────────────────────────────────────────────────────────────────
// POST /api/glossary first runs a rate-limit check and then four input guards
// before it touches the data store. The 429 throttle returns before readBody is
// even called, and each of the four 400 guards returns before
// loadJSON(GLOSSARY_FILE) and before the success-path entry construction, which
// is the only place the generated timestamp, the random id, and saveJSON are
// reached. So every branch pinned here is deterministic: no clock, no
// randomness, and no filesystem is involved. The existing
// tests/next-glossary-termlower-hoist.test.mjs already covers the 409 duplicate
// path and the 200 insert path, so this file fills the 429 throttle and the four
// 400 validation branches, which had zero assertions before.

// Drive the real POST /api/glossary handler with a minimal mocked ctx and
// capture the response handed to json(res, status, payload). loadJSON and
// saveJSON each count their calls so a rejected request can assert it neither
// read nor persisted anything. sanitizeText is identity, though no rejected
// branch reaches it. The rateLimitOk knob toggles the throttle, the same pattern
// tests/next-reviews-workflow-guards.test.mjs uses.
async function invoke({ body, store, rateLimitOk = true }) {
  const pathname = '/api/glossary';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store === undefined ? {} : store;
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    path,
    GLOSSARY_FILE: '/tmp/glossary-create-guards.json',
    rateLimit: () => rateLimitOk,
    readBody: async () => body,
    loadJSON: () => { loadCalls++; return data; },
    saveJSON: () => { saveCalls++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, saveCalls };
}

// A term and definition that pass every guard, used where a case needs all
// fields except the one under test to be acceptable so the asserted guard is
// unambiguously the one that trips.
const VALID_TERM = 'Gradient';
const VALID_DEFINITION = 'The vector of partial derivatives of a scalar function.';

describe('POST /api/glossary create guards (429 throttle and the four 400 input guards)', () => {
  it('a rate-limited POST returns 429 and never reads or writes', async () => {
    // The throttle returns before readBody, so even an otherwise valid body is
    // rejected and the store is never touched.
    const { captured, loadCalls, saveCalls } = await invoke({
      rateLimitOk: false,
      body: { term: VALID_TERM, definition: VALID_DEFINITION },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('a missing or empty term returns 400 (Missing or invalid term) and never reads or writes', async () => {
    // `!term` catches both an absent term and an empty string.
    for (const body of [{ definition: VALID_DEFINITION }, { term: '', definition: VALID_DEFINITION }]) {
      const { captured, loadCalls, saveCalls } = await invoke({ body });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing or invalid term' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('a non-string term returns 400 (Missing or invalid term) and never reads or writes', async () => {
    // `typeof term !== 'string'` catches a number, an object, or an array.
    for (const term of [42, { name: 'x' }, ['x']]) {
      const { captured, loadCalls, saveCalls } = await invoke({
        body: { term, definition: VALID_DEFINITION },
      });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing or invalid term' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('a term longer than 200 characters returns 400 (Term must be 200 characters or fewer) and never reads or writes', async () => {
    // 201 characters is the first length the guard rejects; the definition is
    // valid so the term length is unambiguously what trips the 400.
    const { captured, loadCalls, saveCalls } = await invoke({
      body: { term: 'a'.repeat(201), definition: VALID_DEFINITION },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Term must be 200 characters or fewer' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('a missing or empty definition returns 400 (Missing or invalid definition) and never reads or writes', async () => {
    // The term is valid, so this isolates the definition presence guard from the
    // term guards that run before it.
    for (const body of [{ term: VALID_TERM }, { term: VALID_TERM, definition: '' }]) {
      const { captured, loadCalls, saveCalls } = await invoke({ body });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing or invalid definition' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('a non-string definition returns 400 (Missing or invalid definition) and never reads or writes', async () => {
    // A valid term clears the term guards, so a non-string definition trips the
    // definition presence guard.
    for (const definition of [42, { text: 'x' }, ['x']]) {
      const { captured, loadCalls, saveCalls } = await invoke({
        body: { term: VALID_TERM, definition },
      });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing or invalid definition' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    }
  });

  it('a definition longer than 5000 characters returns 400 (Definition must be 5000 characters or fewer) and never reads or writes', async () => {
    // 5001 characters is the first length the guard rejects; the term is valid so
    // the definition length is unambiguously what trips the 400.
    const { captured, loadCalls, saveCalls } = await invoke({
      body: { term: VALID_TERM, definition: 'd'.repeat(5001) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Definition must be 5000 characters or fewer' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});
