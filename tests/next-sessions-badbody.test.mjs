import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the REAL route module the way the sibling
// POST /api/sessions tests do. This pins the handler's OUTER try/catch: the
// FIXED 400 {error: 'Invalid request'} it returns before any store IO. The
// outer try opens with `const body = await readBody(req)` immediately followed
// by `const {userId, ...} = body`, and there is no rate-limit guard before it,
// so the catch is reachable two ways — readBody throwing, or readBody resolving
// a value the destructure cannot read. That catch is unpinned today: the
// sibling guards test tests/next-feeds-sessions-post-validation-guards.test.mjs
// only ever resolves readBody to a valid object, so the catch never executes.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Drive POST /api/sessions through the outer catch and capture the response
// handed to json(res, status, payload). readBody is supplied per case so it can
// reject or resolve a non-object. loadJSON and saveJSON are ZERO-CALL
// tripwires: the handler's first store IO is loadJSON(SESSIONS_FILE), which runs
// only AFTER the body destructure and every field guard, so an outer-catch hit
// must never reach them. Each bumps a counter and throws on contact, so any
// accidental IO both fails the test loudly and surfaces a non-zero count. The
// success path's clock and randomness live past the destructure as well, so the
// error path the test exercises stays fully deterministic.
async function invokePost({ readBody }) {
  const pathname = '/api/sessions';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-sessions-badbody-test',
    readBody,
    loadJSON: () => { loadCalls += 1; throw new Error('loadJSON must not run on the outer-catch path'); },
    saveJSON: () => { saveCalls += 1; throw new Error('saveJSON must not run on the outer-catch path'); },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, body: payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await feedsRoutes(req, res, url, pathname, ctx);
  return { captured, loadCalls, saveCalls };
}

describe('POST /api/sessions outer-catch 400 badbody golden', () => {
  // Trigger 1: readBody rejects. The first statement in the outer try throws, so
  // control jumps straight to the catch before the destructure, any field guard,
  // and any store IO — the 0 IO counters prove the catch fires pre-IO.
  it('returns a fixed 400 when readBody rejects, touching no store IO', async () => {
    const { captured, loadCalls, saveCalls } = await invokePost({
      readBody: async () => { throw new Error('malformed body'); },
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  // Trigger 2: readBody resolves null. The destructure `const {userId, ...} =
  // body` throws a TypeError on null, landing in the SAME outer catch and
  // returning the SAME fixed 400. This also pins PRECEDENCE: the outer catch
  // beats the first inner validation guard ({error: 'Missing or invalid
  // userId'}), which never runs because the destructure throws before it.
  it('returns the same fixed 400 when readBody resolves null, before any guard or IO', async () => {
    const { captured, loadCalls, saveCalls } = await invokePost({
      readBody: async () => null,
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});
