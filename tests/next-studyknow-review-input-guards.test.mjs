import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the REAL route module the way the sibling
// tests/next-studyknow-write-ownprop-guard.test.mjs does. This file adds no
// export and edits no source: it only drives the existing
// POST /api/flashcards/review handler over a fully mocked ctx and pins the guard
// branches the sibling never reaches (its 429 throttle and every 400 validation
// path). The sibling only ever sends a valid quality, a string cardId, and
// rateLimit() => true, so those rejected branches are exercised by no test.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Drive POST /api/flashcards/review with a minimal mocked ctx. Every helper is a
// stub, so NO real filesystem, network, clock, or randomness is touched. The
// rate-limit throttle (server/routes/study-knowledge.js line 105) and the
// validation guards (lines 109 to 114) all return BEFORE loadJSON/saveJSON
// (around line 117), so each rejected path performs zero reads and zero writes;
// the counters below pin exactly that. The `rateLimitOk` knob toggles the
// throttle, and the arguments it is called with are captured so the test can pin
// the `fc-review:` key and the throttle budget. Built like the sibling for json,
// readBody, loadJSON, saveJSON, and sanitizeText, with call-counters added.
async function invoke({ rateLimitOk = true, body, store } = {}) {
  const pathname = '/api/flashcards/review';
  const url = new URL('http://localhost/api/flashcards/review');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store || {};
  let captured = null;
  let rateLimitArgs = null;
  let readBodyCalls = 0;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    FLASHCARDS_FILE: '/tmp/study-knowledge-flashcards.json',
    MAX_TEXT_LENGTH: 100000,
    rateLimit: (...a) => { rateLimitArgs = a; return rateLimitOk; },
    readBody: async () => { readBodyCalls++; return body; },
    loadJSON: () => { loadCalls++; return data; },
    saveJSON: () => { saveCalls++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, data, rateLimitArgs, readBodyCalls, loadCalls, saveCalls };
}

// Assert a body is rejected with a 400 and the exact error payload, and that the
// guard fired BEFORE persistence: readBody ran exactly once (the body is parsed
// inside the try block) while loadJSON and saveJSON never ran, so a rejected
// request reads nothing and writes nothing.
async function assert400(body, error) {
  const r = await invoke({ body });
  assert.equal(r.captured.status, 400);
  assert.deepEqual(r.captured.payload, { error });
  assert.equal(r.readBodyCalls, 1);
  assert.equal(r.loadCalls, 0);
  assert.equal(r.saveCalls, 0);
  return r;
}

// A valid cardId so that quality and userId cases reach their own guard rather
// than tripping the earlier cardId checks.
const OK_CARD_ID = 'fc1';

describe('POST /api/flashcards/review rate-limit guard', () => {
  it('returns 429 and touches nothing when the rate limit is exceeded', async () => {
    const r = await invoke({ rateLimitOk: false, body: { cardId: OK_CARD_ID, quality: 4 } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The throttle is keyed on `fc-review:` + the remote address with a budget of
    // 120, and it runs before the body is ever read.
    assert.deepEqual(r.rateLimitArgs, ['fc-review:127.0.0.1', 120]);
    assert.equal(r.readBodyCalls, 0);
    assert.equal(r.loadCalls, 0);
    assert.equal(r.saveCalls, 0);
  });
});

describe('POST /api/flashcards/review cardId validation', () => {
  it('rejects a missing cardId with 400 Missing or invalid cardId', async () => {
    await assert400({ quality: 4 }, 'Missing or invalid cardId');
  });

  it('rejects a null cardId with 400 Missing or invalid cardId', async () => {
    await assert400({ cardId: null, quality: 4 }, 'Missing or invalid cardId');
  });

  it('rejects an empty-string cardId with 400 Missing or invalid cardId', async () => {
    await assert400({ cardId: '', quality: 4 }, 'Missing or invalid cardId');
  });

  it('rejects a non-string (number) cardId with 400 Missing or invalid cardId', async () => {
    await assert400({ cardId: 123, quality: 4 }, 'Missing or invalid cardId');
  });

  it('rejects a cardId longer than 200 chars with 400 cardId must be 200 characters or fewer', async () => {
    await assert400({ cardId: 'x'.repeat(201), quality: 4 }, 'cardId must be 200 characters or fewer');
  });
});

describe('POST /api/flashcards/review quality validation', () => {
  it('rejects a missing quality with 400 Missing or invalid quality', async () => {
    await assert400({ cardId: OK_CARD_ID }, 'Missing or invalid quality');
  });

  it('rejects a null quality with 400 Missing or invalid quality', async () => {
    await assert400({ cardId: OK_CARD_ID, quality: null }, 'Missing or invalid quality');
  });

  it('rejects a non-number (string) quality with 400 Missing or invalid quality', async () => {
    await assert400({ cardId: OK_CARD_ID, quality: '4' }, 'Missing or invalid quality');
  });

  it('rejects a NaN quality with 400 Missing or invalid quality', async () => {
    await assert400({ cardId: OK_CARD_ID, quality: NaN }, 'Missing or invalid quality');
  });

  it('rejects an Infinity quality with 400 Missing or invalid quality', async () => {
    await assert400({ cardId: OK_CARD_ID, quality: Infinity }, 'Missing or invalid quality');
  });

  it('rejects a quality below 0 with 400 quality must be between 0 and 5', async () => {
    await assert400({ cardId: OK_CARD_ID, quality: -1 }, 'quality must be between 0 and 5');
  });

  it('rejects a quality above 5 with 400 quality must be between 0 and 5', async () => {
    await assert400({ cardId: OK_CARD_ID, quality: 6 }, 'quality must be between 0 and 5');
  });
});

describe('POST /api/flashcards/review userId validation', () => {
  it('rejects a non-string (number) userId with 400 userId must be a string', async () => {
    await assert400({ cardId: OK_CARD_ID, quality: 4, userId: 123 }, 'userId must be a string');
  });

  it('rejects a userId longer than 200 chars with 400 userId must be 200 characters or fewer', async () => {
    await assert400({ cardId: OK_CARD_ID, quality: 4, userId: 'u'.repeat(201) }, 'userId must be 200 characters or fewer');
  });
});
