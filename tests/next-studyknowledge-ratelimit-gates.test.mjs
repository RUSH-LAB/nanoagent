import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load the real shipping module the way the
// sibling badbody route suites do (tests/next-quicknotes-badbody.test.mjs and
// tests/next-preferences-put-badbody.test.mjs), so this pins the live handlers
// rather than a copy.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const REMOTE_ADDR = '203.0.113.7';

// Both POST /api/quicknotes (study-knowledge.js line 652) and PUT
// /api/preferences (line 754) open with the same per-route rate-limit gate as
// the FIRST statement of the route block, BEFORE the try:
//
//   if (!rateLimit(`<prefix>:${req.socket.remoteAddress}`, 30))
//     return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
//
// so a false from rateLimit short-circuits to a fixed 429 before readBody,
// loadJSON, or saveJSON ever run. The sibling badbody suites mock rateLimit to
// return true and assert the inner 400 golden; they record the gate CALL but
// never reach this 429 branch. This add-only suite mirrors their ctx shape and
// flips rateLimit to return false, pinning the 429 branch and its (key, limit)
// for both handlers. It changes no source and touches no clock, randomness, or
// network on the asserted path, so it stays fully deterministic.
//
// readBody, loadJSON, and saveJSON are zero-call tripwires: each increments a
// counter AND throws on contact. The counter===0 assertions are what actually
// prove the 429 came from the pre-IO gate, since a body read or store call that
// threw would land in the handler's outer catch and surface an identical-status
// response from a different path. rateLimit is recorded so each case confirms it
// entered THIS handler through its own prefixed rate-limit key.
async function driveGate({ method, pathname, remoteAddress = REMOTE_ADDR }) {
  const calls = { rateLimit: [], readBody: 0, loadJSON: 0, saveJSON: 0 };
  let captured = null;

  const ctx = {
    rateLimit: (key, limit) => {
      calls.rateLimit.push({ key, limit });
      return false;
    },
    readBody: async () => {
      calls.readBody += 1;
      throw new Error('readBody must not run on the 429 rate-limit gate path');
    },
    loadJSON: (fp) => {
      calls.loadJSON += 1;
      throw new Error(`loadJSON must not run on the 429 rate-limit gate path (called with ${fp})`);
    },
    saveJSON: (fp) => {
      calls.saveJSON += 1;
      throw new Error(`saveJSON must not run on the 429 rate-limit gate path (called with ${fp})`);
    },
    json: (_res, status, body) => {
      captured = { status, body };
      return captured;
    },
  };

  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, calls };
}

// One gate assertion: the fixed 429 payload, the gate called exactly once with
// the prefixed caller address and limit 30, and zero body reads or store IO.
async function assertGated({ method, pathname, keyPrefix }) {
  const { captured, calls } = await driveGate({ method, pathname });

  assert.deepEqual(captured, {
    status: 429,
    body: { error: 'Too many requests. Try again in a minute.' },
  });
  assert.deepEqual(calls.rateLimit, [{ key: `${keyPrefix}${REMOTE_ADDR}`, limit: 30 }]);
  assert.equal(calls.readBody, 0);
  assert.equal(calls.loadJSON, 0);
  assert.equal(calls.saveJSON, 0);
}

describe('study-knowledge.js POST /api/quicknotes + PUT /api/preferences — 429 rate-limit gates', () => {
  it('POST /api/quicknotes returns the fixed 429 with key "quicknotes:" and limit 30, before any IO', async () => {
    await assertGated({ method: 'POST', pathname: '/api/quicknotes', keyPrefix: 'quicknotes:' });
  });

  it('PUT /api/preferences returns the fixed 429 with key "prefs:" and limit 30, before any IO', async () => {
    await assertGated({ method: 'PUT', pathname: '/api/preferences', keyPrefix: 'prefs:' });
  });
});
