import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load the REAL route module the way the
// sibling add-item guard test does, so this case exercises the shipped POST
// create-list handler instead of a reimplementation.
const require = createRequire(import.meta.url);
const readingListRoutes = require('../server/routes/bookmarks-reading-lists.js');

// Pin the rate-limit gate of POST /api/reading-lists (create a list). The gate is
// the handler's first statement, BEFORE the try block, so it precedes every IO
// helper (readBody, then loadJSON and saveJSON inside the try). Mocking those
// three as tripwires that count contact and throw, then asserting each stayed at
// 0 calls, is the never-reached proof that the 429 short-circuits before the try.
//
// The create endpoint keys the gate on `reading-lists:` with a limit of 30; the
// sibling add-item endpoint (POST /api/reading-lists/:id/items) keys on
// `rl-items:` with a limit of 60. Pinning the exact key and limit here guards
// against a future edit that swaps one endpoint's gate for the other's.

describe('POST /api/reading-lists create rate-limit gate (current behavior)', () => {
  it('returns 429 before any IO when the rate limit is exceeded', async () => {
    const pathname = '/api/reading-lists';
    const url = new URL(`http://localhost${pathname}`);
    const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
    const res = { writableEnded: false };

    let captured = null;
    let readBodyCount = 0;
    let loadJSONCount = 0;
    let saveJSONCount = 0;
    let rateLimitKey = null;
    let rateLimitMax = null;

    const ctx = {
      json(_res, status, body) {
        captured = { status, body };
        res.writableEnded = true;
        return captured;
      },
      // The gate returns false here, so the 429 fires before the try block.
      rateLimit: (key, max) => { rateLimitKey = key; rateLimitMax = max; return false; },
      // Tripwires: once the gate fails, the create handler must touch no IO. Each
      // counts contact and throws. The load-bearing never-reached proof is the
      // count===0 assertion below; a fall-through bumps a counter off 0. The throw
      // is only a backstop: the handler's own try/catch swallows it into a generic
      // 400, which the 429 deepEqual also rejects, just less specifically.
      readBody: async () => { readBodyCount += 1; throw new Error('readBody must not run: the 429 gate precedes the try'); },
      loadJSON: () => { loadJSONCount += 1; throw new Error('loadJSON must not run: the 429 gate precedes the try'); },
      saveJSON: () => { saveJSONCount += 1; throw new Error('saveJSON must not run: the 429 gate precedes the try'); },
    };

    await readingListRoutes(req, res, url, pathname, ctx);

    // The exact golden response: status 429 with the shared rate-limit message.
    assert.deepEqual(captured, {
      status: 429,
      body: { error: 'Too many requests. Try again in a minute.' },
    });
    // The gate recorded the create endpoint's key and limit, not the sibling's.
    assert.equal(rateLimitKey, 'reading-lists:127.0.0.1');
    assert.equal(rateLimitMax, 30);
    // Never-reached proof: no IO helper ran before the early 429 return.
    assert.equal(readBodyCount, 0);
    assert.equal(loadJSONCount, 0);
    assert.equal(saveJSONCount, 0);
  });
});
