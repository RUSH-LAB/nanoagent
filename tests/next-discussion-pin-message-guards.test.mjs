import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load it the way the sibling server route
// tests do, through createRequire, and drive the exported handler directly. This is
// an add-only characterization test: it pins the CURRENT behavior of the message pin
// and unpin guard ladders and edits no source file.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/bookmarks-reading-lists.js');

const DISCUSSIONS_FILE = '/fake/discussions.json';
// pathname.split('/')[3] resolves to "general", an own property of channels, so the
// Object.hasOwn channel guard passes and execution reaches the message ladder. The
// channel-not-found 404 and the success write are pinned by next-discussions-pin-ownprop
// and are out of scope here.
const PATHNAME = '/api/discussions/general/pin';

// A fresh discussions store built per call so a mutating pin or unpin in one case
// cannot bleed into another. One real own-key channel ("general") holding one message
// ("m0"), matching the GOAL seed.
function seed() {
  return {
    channels: { general: { name: 'General' } },
    messages: { general: [{ id: 'm0' }] },
  };
}

// A minimal ctx with recorders. Beyond capturing the json() status and payload, every
// side-effecting helper bumps a counter so each branch is pinned by the IO it performed
// AND by the IO it skipped (loadJSON, readBody, saveJSON, rateLimit). The handler reads
// only these fields plus DISCUSSIONS_FILE; the rest of the server.js ctx is irrelevant
// to the pin and unpin ladders. loadJSON returns the seeded store verbatim, or throws
// when loadThrows is set so the outer catch can be reached. Every asserted branch
// returns before saveJSON, so all cases are deterministic: no clock, randomness,
// network, or filesystem.
function makeCtx({ data, body, rateLimitResult = true, loadThrows = false }) {
  const calls = { rateLimit: [], loadJSON: 0, readBody: 0, saveJSON: 0, captured: null };
  const ctx = {
    DISCUSSIONS_FILE,
    rateLimit(key, limit) {
      calls.rateLimit.push({ key, limit });
      return rateLimitResult;
    },
    loadJSON(file) {
      calls.loadJSON++;
      if (loadThrows) throw new Error('loadJSON failed');
      return file === DISCUSSIONS_FILE ? data : {};
    },
    async readBody() {
      calls.readBody++;
      return body;
    },
    saveJSON() {
      calls.saveJSON++;
    },
    json(_res, status, payload) {
      calls.captured = { status, payload };
      return calls.captured;
    },
  };
  return { ctx, calls };
}

// POST /api/discussions/general/pin against an in-memory store.
async function runPin(opts) {
  const url = new URL(`http://localhost${PATHNAME}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const { ctx, calls } = makeCtx(opts);
  await routes(req, res, url, PATHNAME, ctx);
  return calls;
}

// DELETE /api/discussions/general/pin against an in-memory store. The unpin ladder has
// no rate limit, so makeCtx still supplies a rateLimit recorder purely to prove the
// handler never consults it.
async function runUnpin(opts) {
  const url = new URL(`http://localhost${PATHNAME}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const { ctx, calls } = makeCtx(opts);
  await routes(req, res, url, PATHNAME, ctx);
  return calls;
}

describe('POST /api/discussions/:channelId/pin message guard ladder', () => {
  it('rate limits before any IO (429, key disc-pin:<addr> limit 30, no load, read, or save)', async () => {
    const calls = await runPin({ data: seed(), body: { messageId: 'm0' }, rateLimitResult: false });
    assert.equal(calls.captured.status, 429);
    assert.deepEqual(calls.captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The 429 guard sits before the try, so it consults rateLimit and nothing else.
    assert.deepEqual(calls.rateLimit, [{ key: 'disc-pin:127.0.0.1', limit: 30 }]);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.readBody, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('rejects a body with no messageId (400 Missing messageId, no save)', async () => {
    const calls = await runPin({ data: seed(), body: {} });
    assert.equal(calls.captured.status, 400);
    assert.deepEqual(calls.captured.payload, { error: 'Missing messageId' });
    assert.equal(calls.saveJSON, 0);
  });

  it('rejects a messageId absent from the channel (404 Message not found in this channel, no save)', async () => {
    const calls = await runPin({ data: seed(), body: { messageId: 'ghost' } });
    assert.equal(calls.captured.status, 404);
    assert.deepEqual(calls.captured.payload, { error: 'Message not found in this channel' });
    assert.equal(calls.saveJSON, 0);
  });

  it('is idempotent for an already pinned message (200 already:true, no save)', async () => {
    const data = seed();
    data.channels.general.pinnedMessages = ['m0'];
    const calls = await runPin({ data, body: { messageId: 'm0' } });
    assert.equal(calls.captured.status, 200);
    assert.deepEqual(calls.captured.payload, { success: true, already: true });
    // The handler returns before the write, so the store is never persisted and the
    // pinned list is left exactly as seeded.
    assert.equal(calls.saveJSON, 0);
    assert.deepEqual(data.channels.general.pinnedMessages, ['m0']);
  });
});

describe('DELETE /api/discussions/:channelId/pin message guard ladder', () => {
  it('rejects a body with no messageId (400 Missing messageId, no rate limit, no save)', async () => {
    const calls = await runUnpin({ data: seed(), body: {} });
    assert.equal(calls.captured.status, 400);
    assert.deepEqual(calls.captured.payload, { error: 'Missing messageId' });
    // The unpin ladder has no rate limit, so rateLimit is never consulted.
    assert.deepEqual(calls.rateLimit, []);
    assert.equal(calls.saveJSON, 0);
  });

  it('rejects unpinning a message that is not pinned (404 Message is not pinned, no save)', async () => {
    const calls = await runUnpin({ data: seed(), body: { messageId: 'm0' } });
    assert.equal(calls.captured.status, 404);
    assert.deepEqual(calls.captured.payload, { error: 'Message is not pinned' });
    assert.equal(calls.saveJSON, 0);
  });

  it('maps a loadJSON failure to the outer catch (400 Invalid request, no save)', async () => {
    const calls = await runUnpin({ data: seed(), body: { messageId: 'm0' }, loadThrows: true });
    assert.equal(calls.captured.status, 400);
    assert.deepEqual(calls.captured.payload, { error: 'Invalid request' });
    // loadJSON throws before readBody and saveJSON, so neither runs.
    assert.equal(calls.readBody, 0);
    assert.equal(calls.saveJSON, 0);
  });
});
