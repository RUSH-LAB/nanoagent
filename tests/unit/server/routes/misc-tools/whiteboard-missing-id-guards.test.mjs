import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling whiteboard guard suites do (next-whiteboard-write-ownprop-guard.test.mjs
// and next-misctools-create-write-guards.test.mjs) so these cases exercise the
// shipped handler in server/routes/misc-tools.js rather than a reimplementation.
//
// This is an add-only characterization test. It pins the CURRENT behavior of the
// two missing-id guards on /api/whiteboard:
//
//   GET    with no id -> 400 {error: 'Missing id parameter. Use GET /api/whiteboards to list all.'}
//   DELETE with no id -> 400 {error: 'Missing id parameter'} (rate limiter allowing)
//
// Both reject and neither persists. No source file is edited. Every handler runs
// over a fully mocked ctx: no real filesystem, network, or clock is touched.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

const WHITEBOARDS_FILE = '/fake/whiteboards.json';

// A representative own-key whiteboard record, shaped like what the POST handler
// persists. A no-id request never keys into the store, so a populated store only
// serves to confirm it is still left unread (DELETE) and unsaved (GET).
function sampleBoard(id) {
  return { id, elements: [{ type: 'note', x: 0, y: 0, w: 160, h: 100, text: 'hi', color: '#fef3c7' }], updatedAt: '2026-01-01T00:00:00.000Z' };
}

// GET /api/whiteboard with NO id query parameter over a fully mocked ctx. The GET
// branch reads loadJSON, WHITEBOARDS_FILE, and json; it has no rate limit. loadJSON
// returns the supplied store and counts its calls; saveJSON only counts calls so a
// rejected request can be proven never to persist.
async function getWhiteboardNoId(store) {
  const url = new URL('http://localhost/api/whiteboard');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    WHITEBOARDS_FILE,
    rateLimit: () => true,
    loadJSON: (file) => { loadCalls++; return file === WHITEBOARDS_FILE ? store : {}; },
    saveJSON: () => { saveCalls++; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/whiteboard', ctx);
  return { captured, loadCalls, saveCalls };
}

// DELETE /api/whiteboard with NO id query parameter over a fully mocked ctx. The
// DELETE branch consults the rate limiter first, then the id. rateLimit records
// each call (key and limit) and returns the per-call toggle; loadJSON and saveJSON
// only count calls so the missing-id 400 can be proven to fire before either runs.
async function deleteWhiteboardNoId(store, { rateLimitOk = true } = {}) {
  const url = new URL('http://localhost/api/whiteboard');
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const rateLimitCalls = [];
  const ctx = {
    WHITEBOARDS_FILE,
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    loadJSON: (file) => { loadCalls++; return file === WHITEBOARDS_FILE ? store : {}; },
    saveJSON: () => { saveCalls++; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/whiteboard', ctx);
  return { captured, loadCalls, saveCalls, rateLimitCalls };
}

describe('GET /api/whiteboard missing-id guard in routes/misc-tools.js', () => {
  it('with no id responds 400 with the list hint and never persists', async () => {
    const store = { 'board-1': sampleBoard('board-1') };
    const { captured, loadCalls, saveCalls } = await getWhiteboardNoId(store);
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing id parameter. Use GET /api/whiteboards to list all.' });
    // The GET branch loads the store before it tests the id, so the read still
    // happens, but a missing id never writes anything back.
    assert.equal(loadCalls, 1);
    assert.equal(saveCalls, 0);
  });
});

describe('DELETE /api/whiteboard missing-id guard in routes/misc-tools.js', () => {
  it('with no id and the rate limiter allowing responds 400 before loadJSON and before any save', async () => {
    const store = { 'board-1': sampleBoard('board-1') };
    const { captured, loadCalls, saveCalls, rateLimitCalls } = await deleteWhiteboardNoId(store, { rateLimitOk: true });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing id parameter' });
    // The rate limiter is consulted first with the delete-specific key and limit,
    // and it allowed the request, so this 400 is the id guard, not the 429.
    assert.equal(rateLimitCalls.length, 1);
    assert.deepEqual(rateLimitCalls[0], { key: 'whiteboard-del:127.0.0.1', limit: 30 });
    // The missing-id 400 short-circuits before the store is read or written.
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });

  it('with no id but the rate limiter blocking responds 429 and never reaches the id check, load, or save', async () => {
    const store = { 'board-1': sampleBoard('board-1') };
    const { captured, loadCalls, saveCalls, rateLimitCalls } = await deleteWhiteboardNoId(store, { rateLimitOk: false });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The rate-limit guard precedes the id guard: when it blocks, the handler
    // returns 429 without ever loading or saving the store. That ordering is why
    // the missing-id 400 above is stated for the rate-limiter-allowing case.
    assert.equal(rateLimitCalls.length, 1);
    assert.deepEqual(rateLimitCalls[0], { key: 'whiteboard-del:127.0.0.1', limit: 30 });
    assert.equal(loadCalls, 0);
    assert.equal(saveCalls, 0);
  });
});
