import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load the REAL route module the way the sibling
// server route tests do (see tests/next-discussions-delete-msg-guards.test.mjs),
// so these cases exercise the shipped DELETE channel handler
// (DELETE /api/discussions/:channelId, matched by CHANNEL_RE) instead of a
// reimplementation. The happy-path 200 channel delete is already pinned by
// tests/next-discussions-route-regex-hoist.test.mjs, so this file pins only the
// guard ladder that case leaves uncovered. This delete-channel handler is
// distinct from the delete-message handler (matched by CHANNEL_MESSAGES_RE,
// keyed disc-delete); it is identified here by its unique disc-del-ch
// rate-limit key.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

// A single-segment path so CHANNEL_RE matches and the request reaches the
// delete-channel handler rather than the delete-message handler, which needs a
// trailing /messages segment.
const PATH = '/api/discussions/general';

// A fresh store per test so no case pollutes another through shared mutable
// state. The 'general' channel exists and holds one message.
function makeData() {
  return {
    channels: { general: { name: 'General', topic: 'Chat' } },
    messages: { general: [{ id: 'm0', author: 'alice', text: 'first' }] },
  };
}

// Drive the DELETE /api/discussions/:channelId handler with a minimal mocked
// ctx. This handler reads no request body and this file pins only guard
// branches, so the recorders track the response payload, the rate-limit
// arguments, and how many times loadJSON / saveJSON ran, pinning each negative
// branch both by its status and by the IO it did NOT perform (every guard ends
// with saveCount 0, so no case inspects a persisted document). loadJSON is
// stubbed to an in-memory `data`, matching the existing
// next-discussions-*.test.mjs harness.
async function invoke({
  method = 'DELETE',
  pathname = PATH,
  data = makeData(),
  rateLimitOk = true,
  loadThrows = false,
} = {}) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saveCount = 0;
  let loadCount = 0;
  let rateLimitArgs = null;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: () => {
      loadCount += 1;
      if (loadThrows) throw new Error('loadJSON failed');
      return data;
    },
    saveJSON: () => { saveCount += 1; },
    rateLimit: (key, limit) => { rateLimitArgs = { key, limit }; return rateLimitOk; },
    DISCUSSIONS_FILE: '/tmp/discussions-deletechannel-guards-test.json',
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, saveCount, loadCount, rateLimitArgs };
}

describe('DELETE /api/discussions/:channelId delete-channel guards (current behavior)', () => {
  it('returns 429 with the disc-del-ch key and limit 10 and does zero IO when rate limited', async () => {
    const { captured, saveCount, loadCount, rateLimitArgs } = await invoke({ rateLimitOk: false });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    // The rate-limit guard returns before the try block: nothing loads or saves.
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
    // This handler is uniquely keyed on disc-del-ch scoped to the socket address, limit 10.
    assert.equal(rateLimitArgs.key, 'disc-del-ch:127.0.0.1');
    assert.equal(rateLimitArgs.limit, 10);
  });

  it('returns 400 Invalid channel id before any IO for a malformed channel segment', async () => {
    // `%` matches the [^/]+ route segment, and decodeURIComponent('%') throws.
    const { captured, saveCount, loadCount } = await invoke({ pathname: '/api/discussions/%' });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid channel id');
    // The decode failure is pure and precedes loadJSON.
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 404 Channel not found after loadJSON when channels is absent', async () => {
    const { captured, saveCount, loadCount } = await invoke({ data: { messages: {} } });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Channel not found');
    // loadJSON ran once; the channel guard short-circuits before any save.
    assert.equal(loadCount, 1);
    assert.equal(saveCount, 0);
  });

  it('returns 404 Channel not found when the channel id is not an own key', async () => {
    const { captured, saveCount, loadCount } = await invoke({ pathname: '/api/discussions/ghost' });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Channel not found');
    assert.equal(loadCount, 1);
    assert.equal(saveCount, 0);
  });

  it('returns 400 Invalid request from the outer catch when loadJSON throws', async () => {
    // loadJSON is used here as a convenient in-try throw vector to reach the
    // outer catch (the branch the GOAL asks this file to pin). The shipped
    // loadJSON returns {} on a read or parse failure rather than throwing, so in
    // production saveJSON is the operation that can land in this catch; the 400
    // Invalid request branch itself is real regardless of which call throws.
    const { captured, saveCount, loadCount } = await invoke({ loadThrows: true });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid request');
    // loadJSON was reached (the channel segment decoded) and threw; nothing persists.
    assert.equal(loadCount, 1);
    assert.equal(saveCount, 0);
  });
});
