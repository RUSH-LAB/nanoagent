import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load the REAL route module the way the sibling
// POST /api/annotations badbody test (tests/next-annotations-badbody.test.mjs)
// does. This pins the DELETE /api/annotations handler's OUTER try/catch: the
// fixed 400 {error: 'Invalid request'} it returns before any store IO. Unlike
// the POST sibling, this DELETE handler has NO rate-limit gate, so the try is
// entered unconditionally. The try opens with `const body = await readBody(req)`
// immediately followed by `const {page, id} = body`, so the catch is reachable
// two ways: readBody throwing, or readBody resolving a value the destructure
// cannot read. That catch is unpinned today: the covering not-found branches
// test (tests/next-annotations-delete-notfound-branches.test.mjs) only ever
// resolves readBody to a valid object, so the fixed-400 catch body never runs.
const require = createRequire(import.meta.url);
const analysisAdminRoutes = require('../server/routes/analysis-admin.js');

// The first inner validation guard inside the try. The outer catch must beat it
// whenever the destructure itself throws, so the body returned on the null case
// is the fixed 'Invalid request', never this message.
const MISSING_PAGE_OR_ID = 'Missing page or id';

// Drive DELETE /api/annotations through the outer catch and capture the response
// handed to json(res, status, payload). readBody is supplied per case so it can
// reject or resolve a non-object, and is wrapped to record each entry. rateLimit
// is a recording stub that must stay untouched: this handler has no limiter, so
// the try is entered with no gate ahead of it. loadJSON and saveJSON are
// zero-call tripwires: the handler's first store IO is loadJSON(ANNOTATIONS_FILE),
// which runs only AFTER the body destructure and the first field guard, so an
// outer-catch hit must never reach them. Each records its call and throws on
// contact, so any accidental IO both fails the test loudly and leaves a non-zero
// count. The error path touches no clock, randomness, or network, so it stays
// fully deterministic.
async function invokeDelete({ readBody }) {
  const pathname = '/api/annotations';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const calls = { rateLimit: [], readBody: [], loadJSON: [], saveJSON: [] };
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp/next-annotations-delete-badbody-test',
    ANNOTATIONS_FILE: '/tmp/next-annotations-delete-badbody-test/annotations.json',
    readBody: async (r) => { calls.readBody.push(r); return readBody(r); },
    rateLimit: (key, limit) => { calls.rateLimit.push({ key, limit }); return true; },
    loadJSON: () => { calls.loadJSON.push(true); throw new Error('loadJSON must not run on the outer-catch path'); },
    saveJSON: () => { calls.saveJSON.push(true); throw new Error('saveJSON must not run on the outer-catch path'); },
    json(_res, status, payload) {
      captured = { status, body: payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await analysisAdminRoutes(req, res, url, pathname, ctx);
  return { captured, calls };
}

describe('DELETE /api/annotations outer-catch 400 badbody golden', () => {
  // Trigger 1: readBody rejects. The first statement in the outer try throws, so
  // control jumps straight to the catch before the destructure, the first field
  // guard, and any store IO. The zero IO counters prove the catch fires pre-IO,
  // and the single readBody entry proves the try ran exactly once. rateLimit
  // stays at 0 because this handler has no limiter gate.
  it('returns a fixed 400 when readBody rejects, touching no store IO', async () => {
    const { captured, calls } = await invokeDelete({
      readBody: async () => { throw new Error('malformed body'); },
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.equal(calls.loadJSON.length, 0);
    assert.equal(calls.saveJSON.length, 0);
    assert.equal(calls.readBody.length, 1);
    assert.equal(calls.rateLimit.length, 0);
  });

  // Trigger 2: readBody resolves null. The destructure `const {page, id} = body`
  // throws a TypeError on null, landing in the SAME outer catch and returning the
  // SAME fixed 400. This also pins precedence: the outer catch beats the first
  // inner validation guard (MISSING_PAGE_OR_ID), which never runs because the
  // destructure throws before it.
  it('returns the same fixed 400 when readBody resolves null, before any guard or IO', async () => {
    const { captured, calls } = await invokeDelete({
      readBody: async () => null,
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notEqual(captured.body.error, MISSING_PAGE_OR_ID);
    assert.equal(calls.loadJSON.length, 0);
    assert.equal(calls.saveJSON.length, 0);
    assert.equal(calls.readBody.length, 1);
    assert.equal(calls.rateLimit.length, 0);
  });
});
