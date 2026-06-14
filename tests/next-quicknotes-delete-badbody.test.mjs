import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load the real shipping module the way the
// sibling badbody route tests do (this mirrors tests/next-quicknotes-badbody.test.mjs,
// the POST /api/quicknotes outer-catch sibling), so it pins the live DELETE
// /api/quicknotes handler rather than a copy.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const QN_PATHNAME = '/api/quicknotes';
const REMOTE_ADDR = '203.0.113.7';

// Drive the real DELETE /api/quicknotes handler (study-knowledge.js lines 680 to
// 697) over a minimal mocked ctx, exercising ONLY its outer catch. The handler
// shape is:
//
//   try {
//     const body = await readBody(req);                       // first statement in the try
//     const {userId, id} = body;                              // throws if body is null
//     if (!id) return json(res, 400, {error: 'Missing id'});  // first inner guard
//     const uid = userId || 'default';
//     const QUICKNOTES_FILE = path.join(PROJECT_ROOT, 'data', 'quicknotes.json');
//     const data = loadJSON(QUICKNOTES_FILE);                 // first store IO
//     ... findIndex / splice / saveJSON ...
//     return json(res, 200, {success: true});
//   } catch {
//     return json(res, 400, {error: 'Invalid request'});
//   }
//
// Unlike the POST sibling, this DELETE handler has NO rate-limit gate: the `try`
// is its first statement, so a working rateLimit lives in ctx yet is never
// called. Any throw raised before that first loadJSON lands in the fixed 400
// outer catch with zero store IO. This file pins both pre-IO throw sources:
//
//   1. readBody rejects: the catch fires before the destructure even runs.
//   2. readBody resolves null: the `const {userId, id} = null` destructure throws
//      into the SAME catch, so the response is the fixed 400, NOT the first inner
//      'Missing id' guard. That pins the precedence of the outer catch over the
//      first inner validation guard.
//
// loadJSON and saveJSON are zero-call tripwires: each increments a counter AND
// throws on contact. The counter===0 assertions are what actually prove the 400
// came from the pre-IO path, because a store call that threw would land in the
// same catch and return an identical 400, so the body alone cannot tell the two
// apart. (loadJSON itself returns {} on a missing or broken file rather than
// throwing, so the genuine pre-IO throw triggers are exactly readBody rejecting
// and the null-body destructure.) rateLimit records calls and is asserted never
// called, documenting the no-gate shape.
//
// Determinism: the DELETE branch has no clock or randomness on its success path,
// and the error path never reaches the store at all, so the test needs no fake
// timers or network.
async function runQuicknotesDelete({ readBody: readBodyImpl, remoteAddress = REMOTE_ADDR }) {
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
  const req = { method: 'DELETE', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, QN_PATHNAME, ctx);
  return { captured, calls };
}

describe('DELETE /api/quicknotes outer-catch 400 badbody golden', () => {
  it('returns the fixed 400 {error: "Invalid request"} when readBody rejects, before any store IO', async () => {
    const { captured, calls } = await runQuicknotesDelete({
      readBody: async () => { throw new Error('readBody boom'); },
    });

    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });

    // No rate-limit gate guards this handler, so rateLimit is never called; it
    // awaited readBody once, then the catch fired before the first loadJSON: zero IO.
    assert.deepEqual(calls.rateLimit, []);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('returns the same fixed 400 {error: "Invalid request"} when readBody resolves null, beating the inner "Missing id" guard, before any store IO', async () => {
    const { captured, calls } = await runQuicknotesDelete({
      readBody: async () => null,
    });

    // The destructure of null throws into the outer catch, so the body is the
    // fixed 'Invalid request', never the first inner 'Missing id' guard.
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notDeepEqual(captured.body, { error: 'Missing id' });

    assert.deepEqual(calls.rateLimit, []);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });
});
