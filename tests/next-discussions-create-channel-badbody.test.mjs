import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// discussions.js is CommonJS; load the REAL route module the way the sibling
// server route tests do, so these cases exercise the shipped handler instead of
// a reimplementation.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// Characterize the OUTER catch on the POST /api/discussions create-channel
// handler. After the rate-limit gate it runs:
//   try { const body = await readBody(req); const {name, topic, linkedPage} = body; ... }
//   catch { return json(res, 400, {error: 'Invalid request'}); }
// The catch returns a FIXED string (not err.message) and fires BEFORE the
// loadJSON / saveJSON store IO. The only other test driving this endpoint
// (next-discussions-create-channel-guards) uses a readBody that always resolves
// and never throws, so the catch path is unpinned. There is no clock or random
// on the error path, so the contract below is fully deterministic.
//
// loadJSON / saveJSON are tripwires: reaching them would mean the catch did NOT
// win. They record their call counts (and throw, in case execution ever slips
// past) and every case asserts both stayed at zero, proving the catch is
// pre-IO. sanitizeText, DISCUSSIONS_FILE, path, and PROJECT_ROOT round out the
// documented ctx shape (mirroring the sibling guards test) but are never reached
// on the catch path. A fresh ctx is built per call, so no case pollutes another.
async function invokeCreate(readBody) {
  const pathname = '/api/discussions';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCount = 0;
  let saveCount = 0;
  const ctx = {
    json(_res, status, body) {
      captured = { status, body };
      res.writableEnded = true;
      return captured;
    },
    rateLimit: () => true,
    readBody,
    loadJSON: () => { loadCount += 1; throw new Error('loadJSON must not run on the badbody catch path'); },
    saveJSON: () => { saveCount += 1; throw new Error('saveJSON must not run on the badbody catch path'); },
    sanitizeText: (s) => s,
    path,
    PROJECT_ROOT: '/tmp/discussions-create-channel-badbody-root',
    DISCUSSIONS_FILE: '/tmp/discussions-create-channel-badbody-test.json',
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, loadCount, saveCount };
}

describe('POST /api/discussions create-channel badbody catch (current behavior)', () => {
  it('returns the fixed 400 when readBody rejects, before any store IO', async () => {
    // `await readBody(req)` throws straight into the outer catch.
    const { captured, loadCount, saveCount } = await invokeCreate(async () => {
      throw new Error('readBody failed');
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns the fixed 400 when readBody resolves null, with the catch beating the validation ladder', async () => {
    // body === null makes `const {name, topic, linkedPage} = body` throw on the
    // null destructure, so the catch fires BEFORE the first validation guard
    // ('Missing or invalid channel name') can run and before any store IO.
    const { captured, loadCount, saveCount } = await invokeCreate(async () => null);
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });
});
