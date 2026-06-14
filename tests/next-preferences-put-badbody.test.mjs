import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load the real shipping module the way the
// sibling server route tests do (see tests/next-studyplan-post-guards.test.mjs),
// so this pins the live PUT /api/preferences handler rather than a copy.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PREFS_PATHNAME = '/api/preferences';
const REMOTE_ADDR = '203.0.113.7';

// Drive the real PUT /api/preferences handler (study-knowledge.js lines 753 to
// 781) over a minimal mocked ctx, exercising ONLY its outer catch. The handler
// shape is:
//
//   if (!rateLimit(`prefs:${req.socket.remoteAddress}`, 30)) return 429;  // gate, before the try
//   try {
//     const body = await readBody(req);          // first statement in the try
//     const {userId, preferences} = body;        // throws if body is null
//     ... validation guards (first is 'Missing or invalid userId') ...
//     const prefs = loadJSON(PREFS_FILE);        // first store IO, only after the destructure
//     ... saveJSON(PREFS_FILE, prefs) ...
//     return json(res, 200, ...);
//   } catch {
//     return json(res, 400, {error: 'Invalid request'});
//   }
//
// Any throw raised before that first loadJSON lands in the fixed 400 outer catch
// with zero store IO. This file pins both pre-IO throw sources:
//
//   1. readBody rejects: the catch fires before the destructure even runs.
//   2. readBody resolves null: the `const {userId, preferences} = null`
//      destructure throws into the SAME catch, so the response is the fixed 400,
//      NOT the inner 'Missing or invalid userId' guard. That pins the precedence
//      of the outer catch over the first inner validation guard.
//
// loadJSON and saveJSON are zero-call tripwires: each increments a counter AND
// throws on contact. The counter===0 assertions are what actually prove the 400
// came from the pre-IO path, because a store call that threw would land in the
// same catch and return an identical 400. rateLimit returns true (its gate sits
// before the try) and is recorded so each case confirms it entered THIS handler
// through the prefs: rate-limit key.
async function runPreferencesPut({ readBody: readBodyImpl, remoteAddress = REMOTE_ADDR }) {
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

  const url = new URL(`http://localhost${PREFS_PATHNAME}`);
  const req = { method: 'PUT', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, PREFS_PATHNAME, ctx);
  return { captured, calls };
}

describe('PUT /api/preferences outer-catch 400 badbody golden', () => {
  it('returns the fixed 400 {error: "Invalid request"} when readBody rejects, before any store IO', async () => {
    const { captured, calls } = await runPreferencesPut({
      readBody: async () => { throw new Error('readBody boom'); },
    });

    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });

    // Entered this handler via its own prefs: gate (before the try), awaited
    // readBody once, then the catch fired before the first loadJSON: zero IO.
    assert.deepEqual(calls.rateLimit, [{ key: `prefs:${REMOTE_ADDR}`, limit: 30 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('returns the same fixed 400 {error: "Invalid request"} when readBody resolves null, beating the inner userId guard, before any store IO', async () => {
    const { captured, calls } = await runPreferencesPut({
      readBody: async () => null,
    });

    // The destructure of null throws into the outer catch, so the body is the
    // fixed 'Invalid request', never the first inner guard's message.
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notDeepEqual(captured.body, { error: 'Missing or invalid userId' });

    assert.deepEqual(calls.rateLimit, [{ key: `prefs:${REMOTE_ADDR}`, limit: 30 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });
});
