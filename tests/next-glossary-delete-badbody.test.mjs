import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load the real shipping module the way the
// sibling badbody test does (see tests/next-glossary-badbody.test.mjs), so this
// pins the live DELETE /api/glossary handler rather than a copy.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const GLOSSARY_PATHNAME = '/api/glossary';
const REMOTE_ADDR = '203.0.113.7';

// Drive the real DELETE /api/glossary handler (study-knowledge.js lines 413 to
// 428) over a minimal mocked ctx, exercising ONLY its outer catch. The handler
// shape is:
//
//   try {                                              // FIRST statement: no rate-limit gate
//     const body = await readBody(req);                // first statement in the try
//     const {id} = body;                               // throws if body is null
//     if (!id) return json(res, 400, {error: 'Missing id'});  // first inner guard
//     const data = loadJSON(GLOSSARY_FILE);            // first store IO
//     ... saveJSON(GLOSSARY_FILE, data) ...
//     return json(res, 200, {success: true});
//   } catch {
//     return json(res, 400, {error: 'Invalid request'});
//   }
//
// Any throw raised before that first loadJSON lands in the fixed 400 outer catch
// with zero store IO. Unlike the sibling POST handler, this DELETE handler has NO
// rate-limit gate: the try is its first statement. This file pins both pre-IO
// throw sources:
//
//   1. readBody rejects: the catch fires before the destructure even runs.
//   2. readBody resolves null: the `const {id} = null` destructure throws into
//      the SAME catch, so the response is the fixed 400, NOT the inner
//      'Missing id' guard. That pins the precedence of the outer catch over the
//      first inner validation guard.
//
// loadJSON and saveJSON are zero-call tripwires: each increments a counter AND
// throws on contact. The counter===0 assertions are what actually prove the 400
// came from the pre-IO path, because a store call that threw would land in the
// same catch and return an identical 400. rateLimit is recorded too; the
// length===0 assertion documents that this handler has no rate-limit gate, so it
// is never consulted. The later ctx fields (GLOSSARY_FILE, sanitizeText) sit
// past the catch point and are never reached, so they stay omitted.
async function runGlossaryDelete({ readBody: readBodyImpl, remoteAddress = REMOTE_ADDR }) {
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

  const url = new URL(`http://localhost${GLOSSARY_PATHNAME}`);
  const req = { method: 'DELETE', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, GLOSSARY_PATHNAME, ctx);
  return { captured, calls };
}

describe('DELETE /api/glossary outer-catch 400 badbody golden', () => {
  it('returns the fixed 400 {error: "Invalid request"} when readBody rejects, before any store IO and with no rate-limit gate', async () => {
    const { captured, calls } = await runGlossaryDelete({
      readBody: async () => { throw new Error('readBody boom'); },
    });

    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });

    // No rate-limit gate: the try is the handler's first statement, so rateLimit
    // is never consulted. readBody is awaited once, then the catch fires before
    // the first loadJSON, so there is zero store IO.
    assert.equal(calls.rateLimit.length, 0);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });

  it('returns the same fixed 400 {error: "Invalid request"} when readBody resolves null, beating the inner Missing id guard, before any store IO', async () => {
    const { captured, calls } = await runGlossaryDelete({
      readBody: async () => null,
    });

    // The destructure of null throws into the outer catch, so the body is the
    // fixed 'Invalid request', never the first inner guard's 'Missing id'.
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notDeepEqual(captured.body, { error: 'Missing id' });

    assert.equal(calls.rateLimit.length, 0);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.loadJSON, 0);
    assert.equal(calls.saveJSON, 0);
  });
});
