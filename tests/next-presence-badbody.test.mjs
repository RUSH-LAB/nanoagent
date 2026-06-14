import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analytics-users.js is CommonJS; load the REAL route module the way the sibling
// badbody test does (see tests/next-pageview-badbody.test.mjs and mirror its
// structure), so these cases exercise the shipped POST /api/presence handler
// rather than a reimplementation.
//
// The presence guards suite only ever RESOLVES readBody to a valid object, so the
// handler's OUTER catch stays 0-hit. This file pins that catch. The try opens with
// `const body = await readBody(req)` and then `const {filePath: presencePath,
// userId, userName, cursor} = body`, and a single catch returns a FIXED 400
// {error: 'Invalid request'} before any side effect. This handler has NO
// loadJSON/saveJSON: its first side effect is writing the in-memory presenceStore,
// and sanitizeText + cleanStalePresence run only later on the success path. Two
// inputs reach the catch:
//   1. readBody REJECTS: the awaited rejection lands directly in the catch.
//   2. readBody RESOLVES null: the `const {filePath: presencePath, userId,
//      userName, cursor} = body` destructure throws a TypeError into the SAME
//      catch. That destructure runs before the first inner guard ('Missing
//      filePath or userId'), so the fixed 400 proves the outer catch wins over
//      that guard rather than the 'Missing filePath or userId' 400 winning.
// Both return before presenceStore is touched and before sanitizeText,
// cleanStalePresence, and Date.now() run, so the cases are deterministic and this
// file edits no source.
const require = createRequire(import.meta.url);
const analyticsUsersRoutes = require('../server/routes/analytics-users.js');

const PATH = '/api/presence';

// Drive the POST /api/presence handler with a minimal mocked ctx. `readBody` is
// supplied per case so each call decides whether the await rejects or resolves;
// the ctx wrapper counts the call so we can assert control reached the try. The
// json capturer records {status, body} for an exact deepEqual; rateLimit returns
// true and records its args so we can confirm the presence rate-limit guard (which
// sits BEFORE the try) ran first. presenceStore is an injected empty object we
// assert stays untouched. sanitizeText and cleanStalePresence are zero-call
// tripwires that count a hit and throw on contact: they live only on the success
// path after every guard, so a counter above zero would prove a guard fell through
// past the catch. Both calls sit inside the try, so a throw would be swallowed by
// the same outer catch and still surface the 400 golden; that is why the call
// COUNTERS, not the golden body, are the authoritative tripwire. presenceStore
// staying {} is a separate proof: both error triggers throw before the
// `presenceStore[presencePath] = {}` assignment, so the store is never reached.
async function invoke({ readBody, remoteAddress = '127.0.0.1' } = {}) {
  const url = new URL(`http://localhost${PATH}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  let captured = null;
  let readBodyCount = 0;
  let sanitizeTextCount = 0;
  let cleanStalePresenceCount = 0;
  let rateLimitArgs = null;
  const presenceStore = {};
  const ctx = {
    json(_res, status, payload) {
      captured = { status, body: payload };
      res.writableEnded = true;
      return captured;
    },
    rateLimit: (key, limit) => { rateLimitArgs = { key, limit }; return true; },
    readBody: (...args) => { readBodyCount += 1; return readBody(...args); },
    sanitizeText: () => { sanitizeTextCount += 1; throw new Error('sanitizeText must not run on the catch path'); },
    cleanStalePresence: () => { cleanStalePresenceCount += 1; throw new Error('cleanStalePresence must not run on the catch path'); },
    presenceStore,
  };
  await analyticsUsersRoutes(req, res, url, PATH, ctx);
  return { captured, readBodyCount, sanitizeTextCount, cleanStalePresenceCount, rateLimitArgs, presenceStore };
}

describe('POST /api/presence outer catch returns a fixed 400 (current behavior)', () => {
  it('returns 400 Invalid request when readBody rejects, before any side effect', async () => {
    // The first statement in the try is `await readBody(req)`; a rejected promise
    // lands straight in the outer catch, which returns the fixed 400 and writes
    // nothing.
    const { captured, readBodyCount, sanitizeTextCount, cleanStalePresenceCount, rateLimitArgs, presenceStore } = await invoke({
      readBody: async () => { throw new Error('boom: malformed body'); },
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    // The rate-limit guard cleared and readBody was awaited (so control entered the
    // try), yet no success-path side effect ran before the catch returned.
    assert.deepEqual(rateLimitArgs, { key: 'presence:127.0.0.1', limit: 120 });
    assert.equal(readBodyCount, 1);
    assert.equal(sanitizeTextCount, 0);
    assert.equal(cleanStalePresenceCount, 0);
    assert.deepEqual(presenceStore, {});
  });

  it('returns 400 Invalid request when readBody resolves null, ahead of the Missing filePath or userId guard', async () => {
    // readBody resolving null makes `const {filePath: presencePath, userId,
    // userName, cursor} = body` throw a TypeError that the SAME outer catch
    // handles. The fixed 400, not the inner 'Missing filePath or userId' 400,
    // proves the catch wins over the first validation guard, and nothing is written.
    const { captured, readBodyCount, sanitizeTextCount, cleanStalePresenceCount, rateLimitArgs, presenceStore } = await invoke({
      readBody: async () => null,
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    // Precedence: the outer catch beats the first inner guard, so the body is the
    // fixed 'Invalid request', never the 'Missing filePath or userId' 400.
    assert.notDeepEqual(captured.body, { error: 'Missing filePath or userId' });
    assert.deepEqual(rateLimitArgs, { key: 'presence:127.0.0.1', limit: 120 });
    assert.equal(readBodyCount, 1);
    assert.equal(sanitizeTextCount, 0);
    assert.equal(cleanStalePresenceCount, 0);
    assert.deepEqual(presenceStore, {});
  });
});
