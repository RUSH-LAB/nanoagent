import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real shipped module the way the
// sibling server route tests do, so these cases exercise the actual
// POST /api/flashcards create handler rather than a reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/tmp';
// The create handler loads and saves through this path. The mocked loadJSON
// below answers only for it, so any unexpected store path surfaces as a thrown
// error instead of silently passing.
const FLASHCARDS_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');

// Drive the real POST /api/flashcards handler over a minimal mocked ctx and
// capture the (status, payload) handed to json(res, status, payload). The
// counters record whether the body was read and whether the store was touched,
// so each case can pin exactly where the handler short-circuits. sanitizeText is
// identity, but the success path that would use it (with the id built from
// Date.now and Math.random, then saveJSON) is never reached by these throttle
// and reject cases, which keeps every asserted path deterministic: no real
// network, clock, randomness, or filesystem.
async function invoke({ body, rateLimitOk = true, store = {} }) {
  const pathname = '/api/flashcards';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let readBodyCalls = 0;
  let loadCalls = 0;
  let saveCalls = 0;
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    FLASHCARDS_FILE,
    rateLimit: () => rateLimitOk,
    readBody: async () => { readBodyCalls++; return body; },
    loadJSON: (fp) => {
      loadCalls++;
      if (fp === FLASHCARDS_FILE) return store;
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: () => { saveCalls++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, store, readBodyCalls, loadCalls, saveCalls };
}

// Every validation reject returns its 400 above the loadJSON(FLASHCARDS_FILE)
// read, so the body is read exactly once and the store is never loaded or saved.
// The success path (id via Date.now and Math.random, then saveJSON) stays
// unreached on each reject.
function assertReject(result, error) {
  assert.equal(result.captured.status, 400);
  assert.deepEqual(result.captured.payload, { error });
  assert.equal(result.readBodyCalls, 1);
  assert.equal(result.loadCalls, 0);
  assert.equal(result.saveCalls, 0);
}

// A body that passes every guard. Cases override one field to isolate a single
// later guard while keeping the earlier guards satisfied.
const VALID = { front: 'Q', back: 'A' };

describe('POST /api/flashcards rate-limit guard', () => {
  it('returns 429 before the body is read and never touches the store', async () => {
    const { captured, readBodyCalls, loadCalls, saveCalls } = await invoke({
      rateLimitOk: false,
      body: { ...VALID },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The throttle returns above the try block, so even readBody is skipped.
    assert.equal(readBodyCalls, 0);
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});

describe('POST /api/flashcards front guards', () => {
  it('rejects a missing front with 400 and no store access', async () => {
    const result = await invoke({ body: { back: 'A' } });
    assertReject(result, 'Missing or invalid front');
  });

  it('rejects a non-string front with 400 and no store access', async () => {
    const result = await invoke({ body: { front: 123, back: 'A' } });
    assertReject(result, 'Missing or invalid front');
  });

  it('rejects a front longer than 5000 characters with 400 and no store access', async () => {
    const result = await invoke({ body: { front: 'a'.repeat(5001), back: 'A' } });
    assertReject(result, 'front must be 5000 characters or fewer');
  });
});

describe('POST /api/flashcards back guards', () => {
  it('rejects a missing back with 400 and no store access', async () => {
    const result = await invoke({ body: { front: 'Q' } });
    assertReject(result, 'Missing or invalid back');
  });

  it('rejects a non-string back with 400 and no store access', async () => {
    const result = await invoke({ body: { front: 'Q', back: 123 } });
    assertReject(result, 'Missing or invalid back');
  });

  it('rejects a back longer than 5000 characters with 400 and no store access', async () => {
    const result = await invoke({ body: { front: 'Q', back: 'a'.repeat(5001) } });
    assertReject(result, 'back must be 5000 characters or fewer');
  });
});

describe('POST /api/flashcards userId guards', () => {
  it('rejects a non-string userId with 400 and no store access', async () => {
    const result = await invoke({ body: { ...VALID, userId: 123 } });
    assertReject(result, 'userId must be a string');
  });

  it('rejects a userId longer than 200 characters with 400 and no store access', async () => {
    const result = await invoke({ body: { ...VALID, userId: 'u'.repeat(201) } });
    assertReject(result, 'userId must be 200 characters or fewer');
  });
});

describe('POST /api/flashcards tags guard', () => {
  it('rejects tags that are not an array with 400 and no store access', async () => {
    const result = await invoke({ body: { ...VALID, tags: 'physics' } });
    assertReject(result, 'tags must be an array of strings');
  });

  it('rejects a tags array holding a non-string with 400 and no store access', async () => {
    const result = await invoke({ body: { ...VALID, tags: ['ok', 7] } });
    assertReject(result, 'tags must be an array of strings');
  });
});

describe('POST /api/flashcards sourcePath guards', () => {
  it('rejects a non-string sourcePath with 400 and no store access', async () => {
    const result = await invoke({ body: { ...VALID, sourcePath: 123 } });
    assertReject(result, 'sourcePath must be a string');
  });

  it('rejects a sourcePath longer than 500 characters with 400 and no store access', async () => {
    const result = await invoke({ body: { ...VALID, sourcePath: 's'.repeat(501) } });
    assertReject(result, 'sourcePath must be 500 characters or fewer');
  });
});

describe('POST /api/flashcards malformed body', () => {
  it('maps a body that cannot be destructured to a 400 Invalid request with no store access', async () => {
    // A null body makes the `const {front, back, ...} = body` destructure throw a
    // TypeError that the handler's surrounding try/catch turns into this generic
    // 400. The body was read once, and the throw happens above the loadJSON read,
    // so the store is never loaded or saved.
    const result = await invoke({ body: null });
    assertReject(result, 'Invalid request');
  });
});
