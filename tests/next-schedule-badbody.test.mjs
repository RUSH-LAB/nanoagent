import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the REAL route module the way the sibling
// POST /api/sessions badbody test does (tests/next-sessions-badbody.test.mjs).
// This pins the POST /api/schedule handler's OUTER try/catch: the FIXED 400
// {error: 'Invalid request'} it returns before any store IO. The outer try
// opens with `const body = await readBody(req)` immediately followed by
// `const {path: filePath, publishAt, note} = body`, and there is no rate-limit
// guard before it, so the catch is reachable two ways: readBody throwing, or
// readBody resolving a value the destructure cannot read. That catch is
// unpinned today: the covering guards test
// tests/next-feeds-schedule-write-guards.test.mjs only ever resolves readBody
// to a valid object, so the fixed-400 catch body never executes.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

// Drive POST /api/schedule through the outer catch and capture the response
// handed to json(res, status, payload). readBody is supplied per case so it can
// reject or resolve a non-object, and a counter records that the handler enters
// it exactly once. loadJSON and saveJSON are ZERO-CALL tripwires: the handler's
// first store IO is loadJSON(SCHEDULE_FILE), which runs only AFTER the body
// destructure and every field guard, so an outer-catch hit must never reach
// them. Each bumps a counter and throws on contact, so any accidental IO both
// fails the test loudly and surfaces a non-zero count. The success path's clock
// and randomness (Date.now, Math.random, new Date) live past the destructure as
// well, so the error path the test exercises stays fully deterministic.
async function invokePost({ readBody }) {
  const pathname = '/api/schedule';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  let readCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-schedule-badbody-test',
    readBody: (r) => { readCalls += 1; return readBody(r); },
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
  return { captured, loadCalls, saveCalls, readCalls };
}

describe('POST /api/schedule outer-catch 400 badbody golden', () => {
  // Trigger 1: readBody rejects. The first statement in the outer try throws, so
  // control jumps straight to the catch before the destructure, any field guard,
  // and any store IO. The 0 IO counters prove the catch fires pre-IO, and
  // readCalls === 1 proves readBody was entered exactly once.
  it('returns a fixed 400 when readBody rejects, touching no store IO', async () => {
    const { captured, loadCalls, saveCalls, readCalls } = await invokePost({
      readBody: async () => { throw new Error('malformed body'); },
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(readCalls, 1);
  });

  // Trigger 2: readBody resolves null. The destructure `const {path: filePath,
  // publishAt, note} = body` throws a TypeError on null, landing in the SAME
  // outer catch and returning the SAME fixed 400. This also pins PRECEDENCE: the
  // outer catch beats the first inner validation guard ({error: 'Missing or
  // invalid path'}), which never runs because the destructure throws before it.
  it('returns the same fixed 400 when readBody resolves null, before any guard or IO', async () => {
    const { captured, loadCalls, saveCalls, readCalls } = await invokePost({
      readBody: async () => null,
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    // Precedence: the outer catch wins, so the first inner guard body is never
    // the response the handler hands back.
    assert.notDeepEqual(captured.body, { error: 'Missing or invalid path' });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(readCalls, 1);
  });
});
