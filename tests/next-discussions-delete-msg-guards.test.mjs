import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// discussions.js is CommonJS; load the REAL route module the way the sibling
// server route tests do, so these cases exercise the shipped DELETE message
// handler (DELETE /api/discussions/:channelId/messages) instead of a
// reimplementation. The happy-path delete and the plain `Message not found`
// 404 are already covered by tests/next-discussions-msgs-cache.test.mjs, so
// this file pins the guard ladder those leave uncovered, keyed on the
// handler-unique `disc-delete` rate-limit path plus the `Missing messageId`
// and `No messages in channel` branches only this handler exercises.
const require = createRequire(import.meta.url);
const discussionsRoutes = require('../server/routes/discussions.js');

const PATH = '/api/discussions/general/messages';

// A fresh store per test so no case pollutes another through shared mutable
// state. The 'general' channel exists and holds two messages.
function makeData() {
  return {
    channels: { general: { name: 'General', topic: 'Chat' } },
    messages: {
      general: [
        { id: 'm0', author: 'alice', text: 'first' },
        { id: 'm1', author: 'bob', text: 'second' },
      ],
    },
  };
}

// Drive the DELETE /api/discussions/:channelId/messages handler with a minimal
// mocked ctx. `body` is what the handler receives from `await readBody(req)`.
// The recorders capture the response payload, the persisted document, the
// rate-limit arguments, and how many times loadJSON / readBody / saveJSON ran,
// so each negative branch is pinned both by its status and by the IO it did NOT
// perform. loadJSON is stubbed to an in-memory `data`, matching the existing
// next-discussions-*.test.mjs harness.
async function invoke({
  method = 'DELETE',
  pathname = PATH,
  body = {},
  data = makeData(),
  rateLimitOk = true,
  readBodyThrows = false,
} = {}) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let saved = null;
  let saveCount = 0;
  let loadCount = 0;
  let readBodyCount = 0;
  let rateLimitArgs = null;
  const ctx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    loadJSON: () => { loadCount += 1; return data; },
    saveJSON: (_file, d) => { saved = d; saveCount += 1; },
    rateLimit: (key, limit) => { rateLimitArgs = { key, limit }; return rateLimitOk; },
    readBody: async () => {
      readBodyCount += 1;
      if (readBodyThrows) throw new Error('readBody failed');
      return body;
    },
    DISCUSSIONS_FILE: '/tmp/discussions-delete-msg-guards-test.json',
  };
  await discussionsRoutes(req, res, url, pathname, ctx);
  return { captured, saved, saveCount, loadCount, readBodyCount, rateLimitArgs };
}

describe('DELETE /api/discussions/:channelId/messages delete guards (current behavior)', () => {
  it('returns 429 with the disc-delete key and limit 20 and does zero IO when rate limited', async () => {
    const { captured, saveCount, loadCount, readBodyCount, rateLimitArgs } = await invoke({
      body: { messageId: 'm0' },
      rateLimitOk: false,
    });
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.error, 'Too many requests. Try again in a minute.');
    // The rate-limit guard returns before the try block: nothing loads, reads, or saves.
    assert.equal(loadCount, 0);
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
    // This handler is uniquely keyed on disc-delete scoped to the socket address, limit 20.
    assert.equal(rateLimitArgs.key, 'disc-delete:127.0.0.1');
    assert.equal(rateLimitArgs.limit, 20);
  });

  it('returns 400 Invalid channel id before any IO for a malformed channel segment', async () => {
    // `%` matches the [^/]+ route segment, and decodeURIComponent('%') throws.
    const { captured, saveCount, loadCount, readBodyCount } = await invoke({
      pathname: '/api/discussions/%/messages',
      body: { messageId: 'm0' },
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid channel id');
    // The decode failure precedes both loadJSON and readBody.
    assert.equal(loadCount, 0);
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 404 Channel not found after loadJSON but before readBody when channels is absent', async () => {
    const { captured, saveCount, loadCount, readBodyCount } = await invoke({
      body: { messageId: 'm0' },
      data: { messages: {} },
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Channel not found');
    // loadJSON ran once; the channel guard then short-circuits before readBody.
    assert.equal(loadCount, 1);
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 404 Channel not found when the channel id is not an own key', async () => {
    const { captured, saveCount, loadCount, readBodyCount } = await invoke({
      pathname: '/api/discussions/ghost/messages',
      body: { messageId: 'm0' },
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Channel not found');
    assert.equal(loadCount, 1);
    assert.equal(readBodyCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 Missing messageId for an omitted or empty-string messageId', async () => {
    for (const body of [{}, { messageId: '' }]) {
      const { captured, saveCount, readBodyCount } = await invoke({ body });
      assert.equal(captured.status, 400);
      assert.equal(captured.payload.error, 'Missing messageId');
      // readBody ran (the channel guard passed), but nothing is persisted.
      assert.equal(readBodyCount, 1);
      assert.equal(saveCount, 0);
    }
  });

  it('returns 400 Missing messageId for falsy non-string messageId 0 and null (no type check)', async () => {
    // The DELETE guard is `!messageId`, not a type check, so falsy non-strings
    // fall into Missing messageId rather than any type error.
    for (const body of [{ messageId: 0 }, { messageId: null }]) {
      const { captured, saveCount, readBodyCount } = await invoke({ body });
      assert.equal(captured.status, 400);
      assert.equal(captured.payload.error, 'Missing messageId');
      assert.equal(readBodyCount, 1);
      assert.equal(saveCount, 0);
    }
  });

  it('returns 404 No messages in channel when data.messages is absent', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({
      body: { messageId: 'm0' },
      data: { channels: { general: { name: 'General' } } },
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'No messages in channel');
    // readBody ran and the messageId guard passed, yet nothing is persisted.
    assert.equal(readBodyCount, 1);
    assert.equal(saveCount, 0);
  });

  it('returns 404 No messages in channel when the channel has no message array', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({
      body: { messageId: 'm0' },
      data: { channels: { general: { name: 'General' } }, messages: { other: [] } },
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'No messages in channel');
    // readBody ran and the messageId guard passed before the missing-array guard.
    assert.equal(readBodyCount, 1);
    assert.equal(saveCount, 0);
  });

  it('treats a truthy non-string messageId (42) as valid and returns 404 Message not found', async () => {
    // 42 is truthy so it passes the !messageId guard, then misses on strict id
    // equality against the string ids, so the handler reports Message not found.
    const { captured, saveCount, readBodyCount } = await invoke({
      body: { messageId: 42 },
    });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'Message not found');
    assert.equal(readBodyCount, 1);
    assert.equal(saveCount, 0);
  });

  it('returns 400 Invalid request when readBody throws inside the try (outer catch)', async () => {
    const { captured, saveCount, readBodyCount } = await invoke({ readBodyThrows: true });
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.error, 'Invalid request');
    // readBody was reached (the channel is present) and threw; nothing persists.
    assert.equal(readBodyCount, 1);
    assert.equal(saveCount, 0);
  });

  it('returns 200 success, saves once, removes the matching message, and preserves siblings', async () => {
    const { captured, saved, saveCount } = await invoke({ body: { messageId: 'm0' } });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(saveCount, 1);
    // The matching message is gone and the sibling remains, in order.
    assert.equal(saved.messages.general.length, 1);
    assert.equal(saved.messages.general.find(m => m.id === 'm0'), undefined);
    assert.equal(saved.messages.general[0].id, 'm1');
  });
});
