import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// bookmarks-reading-lists.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/bookmarks-reading-lists.js');

const DISCUSSIONS_FILE = '/fake/discussions.json';

// Inherited Object.prototype member names. On a plain object literal each resolves to
// a truthy inherited function, so the pre-fix `!data.channels[channelId]` truthiness
// test treated them as existing channels. The own-property guard (Object.hasOwn) rejects
// every inherited name; `constructor` is included for breadth alongside the representative
// trio. (`__proto__` is left out only because Object.prototype.__proto__ is null, which
// would make the pinnedMessages pollution deref below throw.)
const INHERITED = ['toString', 'valueOf', 'hasOwnProperty', 'constructor'];

// A fresh discussions store with one real own-key channel, built per call so a
// mutating pin or unpin cannot bleed into another test. `channels` and `messages` are
// plain object literals, so inherited names resolve to truthy inherited functions
// exactly as they would on the real loadJSON result. `Object` is never injected into
// ctx, so the guard exercises the real global Object.hasOwn.
function sampleStore() {
  return {
    channels: { general: { name: 'General', topic: 'Chat', pinnedMessages: [] } },
    messages: { general: [{ id: 'm0', author: 'alice', text: 'hello world' }] },
  };
}

// Build a minimal ctx for the pin/unpin handlers and capture the json() response plus
// the saveJSON call count. The handlers read rateLimit, loadJSON, readBody, saveJSON,
// DISCUSSIONS_FILE, and json from ctx; loadJSON returns the supplied store verbatim.
function makeCtx(store, messageId, counters) {
  return {
    DISCUSSIONS_FILE,
    rateLimit: () => true,
    loadJSON: (file) => (file === DISCUSSIONS_FILE ? store : {}),
    readBody: async () => ({ messageId }),
    saveJSON: () => { counters.saveCalls++; },
    json(_res, status, payload) {
      counters.captured = { status, payload };
      return counters.captured;
    },
  };
}

// POST /api/discussions/:channelId/pin against an in-memory store.
async function pin(store, channelId, messageId) {
  const pathname = `/api/discussions/${encodeURIComponent(channelId)}/pin`;
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const counters = { captured: null, saveCalls: 0 };
  await routes(req, res, url, pathname, makeCtx(store, messageId, counters));
  return counters;
}

// DELETE /api/discussions/:channelId/pin against an in-memory store. DELETE has no
// rate limit; the unused rateLimit stub is harmless.
async function unpin(store, channelId, messageId) {
  const pathname = `/api/discussions/${encodeURIComponent(channelId)}/pin`;
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const counters = { captured: null, saveCalls: 0 };
  await routes(req, res, url, pathname, makeCtx(store, messageId, counters));
  return counters;
}

describe('POST /api/discussions/:channelId/pin own-property channel guard', () => {
  // Anti-tautology: against the reverted `!data.channels[channelId]` truthy form, an
  // inherited name like `toString` resolves to the truthy `Object.prototype.toString`,
  // so the existence check passes (the 404 is skipped) and execution falls through to
  // the message lookup `(data.messages || {})[channelId]`, which is also the inherited
  // function, so `.find` throws and the catch returns 400, never the clean 404. The
  // own-property guard short-circuits to a 404 with no save and no prototype mutation.
  for (const channelId of INHERITED) {
    it(`returns 404 for the inherited channel "${channelId}" without saving or polluting`, async () => {
      const store = sampleStore();
      const { captured, saveCalls } = await pin(store, channelId, 'm0');
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Channel not found' });
      assert.equal(saveCalls, 0);
      // The status, payload, and saveCalls assertions above are what distinguish the
      // own-property guard from the reverted truthy form (which falls through to a 400).
      // These pollution checks are belt and suspenders: they catch a differently broken
      // fix that would write a pinnedMessages array onto an inherited function object or
      // Object.prototype itself.
      assert.equal(Object.hasOwn(Object.prototype[channelId], 'pinnedMessages'), false);
      assert.equal(Object.hasOwn(Object.prototype, 'pinnedMessages'), false);
      // The real channel was left untouched.
      assert.deepEqual(store.channels.general.pinnedMessages, []);
    });
  }

  it('pins a message in a real own-key channel (200, saves once)', async () => {
    const store = sampleStore();
    const { captured, saveCalls } = await pin(store, 'general', 'm0');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls, 1);
    assert.deepEqual(store.channels.general.pinnedMessages, ['m0']);
  });
});

describe('DELETE /api/discussions/:channelId/pin own-property channel guard', () => {
  // Anti-tautology: against the reverted truthy form, an inherited channelId like
  // `toString` skips the 404, then `data.channels[channelId].pinnedMessages || []`
  // is [] (the inherited function has no pinnedMessages), so indexOf is -1 and the
  // handler returns 404 with `Message is not pinned`, NOT `Channel not found`.
  // Asserting the error string distinguishes the own-property guard from the old form.
  for (const channelId of INHERITED) {
    it(`returns 404 "Channel not found" for the inherited channel "${channelId}" without saving`, async () => {
      const store = sampleStore();
      const { captured, saveCalls } = await unpin(store, channelId, 'm0');
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Channel not found' });
      assert.equal(saveCalls, 0);
      assert.equal(Object.hasOwn(Object.prototype[channelId], 'pinnedMessages'), false);
    });
  }

  it('unpins a message from a real own-key channel (200, saves once)', async () => {
    const store = sampleStore();
    store.channels.general.pinnedMessages = ['m0'];
    const { captured, saveCalls } = await unpin(store, 'general', 'm0');
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCalls, 1);
    assert.deepEqual(store.channels.general.pinnedMessages, []);
  });
});
