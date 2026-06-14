import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load the real shipping module the way the
// sibling badbody route tests do (see tests/next-researchq-badbody.test.mjs),
// so this pins the live POST /api/quicknotes handler rather than a copy.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const QN_PATHNAME = '/api/quicknotes';
const REMOTE_ADDR = '203.0.113.7';

// Drive the real POST /api/quicknotes handler (study-knowledge.js lines 651 to
// 678) over a minimal mocked ctx, exercising ONLY its outer catch. The handler
// shape is:
//
//   if (!rateLimit(`quicknotes:${req.socket.remoteAddress}`, 30)) return 429;  // gate, before the try
//   try {
//     const body = await readBody(req);                 // first statement in the try
//     const {userId, text, color} = body;               // throws if body is null
//     ... validation guards (first is 'Missing or invalid text') ...
//     const data = loadJSON(QUICKNOTES_FILE);           // first store IO, only after the destructure
//     ... saveJSON(QUICKNOTES_FILE, data) ...
//     return json(res, 200, {success: true, note});
//   } catch {
//     return json(res, 400, {error: 'Invalid request'});
//   }
//
// Any throw raised before that first loadJSON lands in the fixed 400 outer catch
// with zero store IO. This file pins both pre-IO throw sources:
//
//   1. readBody rejects: the catch fires before the destructure even runs.
//   2. readBody resolves null: the `const {userId, text, color} = null`
//      destructure throws into the SAME catch, so the response is the fixed 400,
//      NOT the inner 'Missing or invalid text' guard. That pins the precedence
//      of the outer catch over the first inner validation guard.
//
// loadJSON and saveJSON are zero-call tripwires: each increments a counter AND
// throws on contact. The counter===0 assertions are what actually prove the 400
// came from the pre-IO path, because a store call that threw would land in the
// same catch and return an identical 400. rateLimit returns true (its gate sits
// before the try) and is recorded so each case confirms it entered THIS handler
// through the quicknotes: rate-limit key.
//
// Determinism: the success path's id stamping (clock plus randomness) and the
// note timestamps live past the destructure throw point, so the error path
// never reaches them and the test needs no fake timers.
async function runQuicknotesPost({ readBody: readBodyImpl, remoteAddress = REMOTE_ADDR }) {
  const calls = { rateLimit: [], readBody: 0, loadJSON: 0, saveJSON: 0 };
  let captured = null;

  const ctx = {
    rateLimit: (key, limit) => {
      calls.rateLimit.push({ key, limit });
      return true;
    },
    readBody: async (req) => {
      calls.readBody += 1;
      return readBodyImpl(req);
    },
    loadJSON: (fp) => {
      calls.loadJSON += 1;
      throw new Error(`loadJSON must not run on the pre-IO catch path (called with ${fp})`);
    },
    saveJSON: (fp) => {
      calls.saveJSON += 1;
      throw new Error(`saveJSON must not run on the pre-IO catch path (called with ${fp})`);
    },
    json: (_res, status, body) => {
      captured = { status, body };
      return captured;
    },
  };

  const url = new URL(`http://localhost${QN_PATHNAME}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, QN_PATHNAME, ctx);
  return { captured, calls };
}

describe('POST /api/quicknotes outer-catch 400 badbody golden', () => {
  it('returns the fixed 400 {error: "Invalid request"} when readBody rejects, before any store IO', async () => {
    const { captured, calls } = await runQuicknotesPost({
      readBody: async () => { throw new Error('readBody boom'); },
    });

    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });

    // Entered this handler via its own quicknotes: gate (before the try), awaited
    // readBody once, then the catch fired before the first loadJSON: zero IO.
    assert.deepEqual(calls.rateLimit, [{ key: `quicknotes:${REMOTE_ADDR}`, limit: 30 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('returns the same fixed 400 {error: "Invalid request"} when readBody resolves null, beating the inner text guard, before any store IO', async () => {
    const { captured, calls } = await runQuicknotesPost({
      readBody: async () => null,
    });

    // The destructure of null throws into the outer catch, so the body is the
    // fixed 'Invalid request', never the first inner guard's message.
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notDeepEqual(captured.body, { error: 'Missing or invalid text' });

    assert.deepEqual(calls.rateLimit, [{ key: `quicknotes:${REMOTE_ADDR}`, limit: 30 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });
});
