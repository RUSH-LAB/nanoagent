import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { newStore } from '../../../_harness.mjs';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');


// A representative own-key whiteboard record, shaped like what the POST handler
// persists. Built fresh per call so a mutating DELETE test can't bleed into another.
function sampleBoard(id) {
  return { id, elements: [{ type: 'note', x: 0, y: 0, w: 160, h: 100, text: 'hi', color: '#fef3c7' }], updatedAt: '2026-01-01T00:00:00.000Z' };
}

// GET /api/whiteboard?id=<id> against an in-memory store. The handler reads only
// loadJSON, WHITEBOARDS_FILE, and json from ctx for this path. loadJSON returns the
// supplied store verbatim (a plain object literal), so inherited names like toString,
// valueOf, and hasOwnProperty resolve to truthy inherited functions exactly as they
// would on the real loadJSON result. `Object` is never injected into ctx, so the
// own-property guard exercises the real global Object.hasOwn.
async function getWhiteboard(store, id) {
  const url = new URL(`http://localhost/api/whiteboard?id=${encodeURIComponent(id)}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, caller: 'test-user' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    ...newStore().seed('whiteboards', store).ctxFields,
    rateLimit: () => true,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/whiteboard', ctx);
  return captured;
}

// DELETE /api/whiteboard?id=<id> against an in-memory store, capturing the json()
// response and the saveJSON call count. The handler reads rateLimit, loadJSON,
// saveJSON, WHITEBOARDS_FILE, and json from ctx.
async function deleteWhiteboard(store, id) {
  const url = new URL(`http://localhost/api/whiteboard?id=${encodeURIComponent(id)}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' }, caller: 'test-user' };
  const res = { writableEnded: false };
  let captured = null;
  const scoped = newStore().seed('whiteboards', store);
  const ctx = {
    ...scoped.ctxFields,
    rateLimit: () => true,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/whiteboard', ctx);
  // The write count the saveJSON recorder used to give, from the store itself.
  return { captured, saveCalls: scoped.calls.writes.length, store: scoped };
}

// Inherited Object.prototype member names. On a plain object literal each resolves
// to a truthy inherited function, so the pre-fix bare `whiteboards[id]` truthiness
// test passed for them. The own-property guard (Object.hasOwn) rejects them.
const INHERITED = ['toString', 'valueOf', 'hasOwnProperty'];

describe('GET /api/whiteboard own-property id guard', () => {
  // Anti-tautology: against the reverted `const wb = whiteboards[id]; if (!wb)` form
  // each inherited name yields a truthy inherited function, so the 404 is skipped and
  // the handler returns 200 leaking that function as `whiteboard`. The own-property
  // guard returns 404 for the same input.
  for (const id of INHERITED) {
    it(`returns 404 for the inherited id "${id}" (no inherited-member leak)`, async () => {
      const store = { 'board-1': sampleBoard('board-1') };
      const r = await getWhiteboard(store, id);
      assert.equal(r.status, 404);
      assert.deepEqual(r.payload, { error: 'Whiteboard not found' });
    });
  }

  it('returns 200 with the record for a real own-key whiteboard', async () => {
    const store = { 'board-1': sampleBoard('board-1') };
    const r = await getWhiteboard(store, 'board-1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { whiteboard: store['board-1'] });
  });

  it('returns 404 for a missing own-key id', async () => {
    const store = { 'board-1': sampleBoard('board-1') };
    const r = await getWhiteboard(store, 'board-2');
    assert.equal(r.status, 404);
    assert.deepEqual(r.payload, { error: 'Whiteboard not found' });
  });
});

describe('DELETE /api/whiteboard: an id nobody has', () => {
  // These began as an own-property guard: the store was a plain object, so
  // `if (!whiteboards[id])` was truthy for every inherited member name, and
  // deleting by one of those names ran `delete` and saveJSON on a key that was
  // never there. The store has no prototype chain to walk, so what is asserted
  // is the property the guard was protecting: an id nobody has removes nothing.
  for (const id of [...INHERITED, 'board-2']) {
    it(`returns 404 for the id "${id}" and removes nothing`, async () => {
      const seeded = { 'board-1': sampleBoard('board-1') };
      const { captured, store } = await deleteWhiteboard(seeded, id);
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Whiteboard not found' });
      assert.deepEqual(Object.keys(store.read('whiteboards')), ['board-1']);
    });
  }

  it('returns 200 and removes a real whiteboard, leaving its siblings', async () => {
    const seeded = { 'board-1': sampleBoard('board-1'), 'board-2': sampleBoard('board-2') };
    const { captured, store } = await deleteWhiteboard(seeded, 'board-1');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.deepEqual(Object.keys(store.read('whiteboards')), ['board-2']);
  });
});
