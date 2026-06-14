import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load the real shipping module the way the
// sibling rate-limit gate suite does (tests/next-studyknowledge-ratelimit-gates.test.mjs),
// so this pins the live PUT /api/research-questions handler rather than a copy.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const RQ_PATHNAME = '/api/research-questions';
const REMOTE_ADDR = '203.0.113.7';

// PUT /api/research-questions (study-knowledge.js line 518) opens with a
// per-route rate-limit gate as the FIRST statement of the route block, BEFORE
// the try:
//
//   if (!rateLimit(`rq-update:${req.socket.remoteAddress}`, 30))
//     return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
//
// so a false from rateLimit short-circuits to a fixed 429 before readBody,
// loadJSON, or saveJSON ever run. The sibling suites cover only the gate PASS
// path: next-rqput-badbody.test.mjs and next-research-questions-crud-guards.test.mjs
// both drive this handler with rateLimit returning true (recording the gate CALL
// but never reaching the 429 branch), and next-research-questions-crud-guards
// pins the POST 429, not this PUT one. This add-only suite flips rateLimit to
// return false, pinning the PUT 429 branch and its recorded (key, limit). It
// changes no source and touches no clock, randomness, or network, so it stays
// fully deterministic.
//
// readBody, loadJSON, and saveJSON are zero-call tripwires: each increments a
// counter AND throws on contact. The counter===0 assertions are what actually
// prove the 429 came from the pre-IO gate, since a body read or store call that
// threw would land in the handler's outer catch and surface a different status
// from another path. rateLimit is recorded so the case confirms it entered THIS
// handler through its own rq-update: rate-limit key.
async function driveResearchQuestionsPutGate() {
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

  const url = new URL(`http://localhost${RQ_PATHNAME}`);
  const req = { method: 'PUT', socket: { remoteAddress: REMOTE_ADDR } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, RQ_PATHNAME, ctx);
  return { captured, calls };
}

describe('study-knowledge.js PUT /api/research-questions — 429 rate-limit gate (uncovered false branch)', () => {
  it('returns the fixed 429 with key "rq-update:" and limit 30, before any body read or store IO', async () => {
    const { captured, calls } = await driveResearchQuestionsPutGate();

    // The exact 429 payload the gate hands back.
    assert.deepStrictEqual(captured, {
      status: 429,
      body: { error: 'Too many requests. Try again in a minute.' },
    });

    // Entered THIS handler through its own prefixed rate-limit key, called once
    // with limit 30.
    assert.deepStrictEqual(calls.rateLimit, [{ key: `rq-update:${REMOTE_ADDR}`, limit: 30 }]);

    // The gate returns before the try, so no body read and no store IO occurs.
    assert.strictEqual(calls.readBody, 0);
    assert.strictEqual(calls.loadJSON, 0);
    assert.strictEqual(calls.saveJSON, 0);
  });
});
