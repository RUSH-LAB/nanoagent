import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the REAL shipped route module the way the
// sibling route tests do, so these cases exercise the actual DELETE /api/flashcards
// handler rather than a reimplementation. The harness shape mirrors
// tests/next-flashcards-delete-missing-cardid-guard.test.mjs (the DELETE driver)
// and the body-null outer-catch pattern of
// tests/next-flashcards-create-body.test.mjs.
//
// This file adds no export and edits no source: it only drives the existing
// handler (server/routes/study-knowledge.js, handler lines 141-157, outer catch
// line 154) over a fully mocked ctx and pins the fixed badbody 400 for both
// pre-IO throw triggers.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
// The handler reads and persists this single file, but only after the cardId
// guard. On the badbody path it is never reached; it is supplied only so the ctx
// mirrors the real shape.
const FLASHCARDS_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');

// Drive the real DELETE /api/flashcards handler over a minimal mocked ctx. The
// shipped handler body is:
//
//   try {
//     const body = await readBody(req);        // (1) can reject
//     const {userId, cardId} = body;           // (2) throws when body is null
//     if (!cardId) return json(res, 400, {error: 'Missing cardId'});
//     const data = loadJSON(FLASHCARDS_FILE);  // first store touch
//     ... saveJSON(FLASHCARDS_FILE, data) ...
//   } catch { return json(res, 400, {error: 'Invalid request'}); }
//
// Any throw raised before that first store touch lands in the fixed outer catch.
// readBody is supplied per case (it either rejects or resolves a value) and its
// calls are recorded. loadJSON and saveJSON are 0-call tripwires: each records its
// call AND throws on contact, so a regression that reached the store would throw
// INTO the same catch and produce the identical 400. That is why the recorded call
// counts, not the response body, are the never-reached proof. (The real loadJSON
// returns {} on a missing or broken file rather than throwing, so it is not itself
// a throw trigger; this tripwire throws only as a test instrument to make an
// unexpected store touch impossible to miss.) rateLimit is a recorder asserted
// never called, documenting that this DELETE arm has no rate-limit gate: its try is
// the handler's first statement. No real filesystem, network, clock, or random
// source is touched on this path, so every case is deterministic.
async function runRoute(readBodyImpl) {
  const calls = { readBody: [], loadJSON: [], saveJSON: [], rateLimit: [] };
  let captured = null;
  const res = { writableEnded: false };
  const ctx = {
    readBody: async (...args) => {
      calls.readBody.push(args);
      return readBodyImpl();
    },
    loadJSON: (...args) => {
      calls.loadJSON.push(args);
      throw new Error('loadJSON tripwire: the store must not be read on the badbody path');
    },
    saveJSON: (...args) => {
      calls.saveJSON.push(args);
      throw new Error('saveJSON tripwire: the store must not be written on the badbody path');
    },
    rateLimit: (...args) => {
      calls.rateLimit.push(args);
      return true;
    },
    path,
    PROJECT_ROOT,
    FLASHCARDS_FILE,
    json: (_res, status, body) => {
      captured = { status, body };
      res.writableEnded = true;
    },
  };
  const pathname = '/api/flashcards';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, calls };
}

// The single fixed response every pre-IO throw collapses to.
const BADBODY = { status: 400, body: { error: 'Invalid request' } };

describe('DELETE /api/flashcards outer-catch badbody 400', () => {
  it('readBody rejecting lands in the outer catch as 400 Invalid request, before any store IO', async () => {
    const { captured, calls } = await runRoute(() => {
      throw new Error('socket aborted mid-body');
    });
    // The await rejects, so control jumps straight to the fixed outer catch.
    assert.deepEqual(captured, BADBODY);
    // readBody was reached exactly once; neither store tripwire fired.
    assert.equal(calls.readBody.length, 1);
    assert.equal(calls.loadJSON.length, 0);
    assert.equal(calls.saveJSON.length, 0);
    // This DELETE arm has no rate-limit gate.
    assert.equal(calls.rateLimit.length, 0);
  });

  it('readBody resolving null throws on destructure, and the 400 BEATS the Missing cardId guard', async () => {
    const { captured, calls } = await runRoute(() => null);
    // `const {userId, cardId} = body;` throws on a null body before `if (!cardId)`
    // can run, so the answer is the outer-catch 'Invalid request', proving the
    // catch takes precedence over the first inner guard.
    assert.deepEqual(captured, BADBODY);
    assert.notDeepEqual(captured.body, { error: 'Missing cardId' });
    assert.equal(calls.readBody.length, 1);
    assert.equal(calls.loadJSON.length, 0);
    assert.equal(calls.saveJSON.length, 0);
    assert.equal(calls.rateLimit.length, 0);
  });

  it('readBody resolving undefined trips the same destructure throw to the same 400', async () => {
    // undefined is the other non-object body that fails to destructure; it shares
    // the null case's path and reinforces that the outer catch, not a typed guard,
    // is what answers a bad body.
    const { captured, calls } = await runRoute(() => undefined);
    assert.deepEqual(captured, BADBODY);
    assert.equal(calls.readBody.length, 1);
    assert.equal(calls.loadJSON.length, 0);
    assert.equal(calls.saveJSON.length, 0);
    assert.equal(calls.rateLimit.length, 0);
  });
});
