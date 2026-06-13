import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module the way the sibling route
// tests do (see tests/next-templates-custom-delete-guards.test.mjs), so these
// cases exercise the shipped DELETE /api/flashcards handler rather than a
// reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
// The delete handler reads and persists this single file. loadJSON answers only
// for this injected path and counts its calls, so a stray read on the reject path
// surfaces as a non-zero count, and any other path throws.
const FLASHCARDS_FILE = path.join(PROJECT_ROOT, 'data', 'flashcards.json');

// Drive the real DELETE /api/flashcards handler over a mocked ctx. readBody counts
// its calls and returns the supplied body; loadJSON and saveJSON are tripwires that
// record every call so the missing-cardId reject path can assert both stayed at
// zero (the `if (!cardId)` guard returns before either runs, and before any clock
// or random source is touched). json captures the (status, body) the handler hands
// back. No real filesystem, network, clock, or random source is touched on this
// path. The DELETE arm is not rate limited and sanitizes nothing, so ctx carries no
// rateLimit or sanitizeText stub.
async function runRoute({ body = {} } = {}) {
  const saved = [];
  let readBodyCount = 0;
  let loadCount = 0;
  let captured = null;
  const ctx = {
    readBody: async () => {
      readBodyCount += 1;
      return body;
    },
    loadJSON: (fp) => {
      loadCount += 1;
      if (fp !== FLASHCARDS_FILE) throw new Error(`unexpected loadJSON path: ${fp}`);
      return {};
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    path,
    PROJECT_ROOT,
    FLASHCARDS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/flashcards';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, loadCount };
}

describe('DELETE /api/flashcards missing-cardId guard', () => {
  it('a body with no cardId returns 400 Missing cardId before loadJSON, and never loads or saves', async () => {
    // After readBody the handler destructures { userId, cardId } and guards
    // `if (!cardId)` before the loadJSON read, so a body without cardId is rejected
    // with no store access.
    const { captured, saved, readBodyCount, loadCount } = await runRoute({ body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing cardId' });
    assert.equal(readBodyCount, 1);
    assert.equal(loadCount, 0);
    assert.equal(saved.length, 0);
  });

  it('a falsy cardId (empty string) trips the same guard and never loads or saves', async () => {
    // An empty-string cardId is falsy, so it trips the same `if (!cardId)` guard as
    // a missing cardId even with a userId present: 400 Missing cardId, no load, no
    // save.
    const { captured, saved, loadCount } = await runRoute({ body: { userId: 'alice', cardId: '' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing cardId' });
    assert.equal(loadCount, 0);
    assert.equal(saved.length, 0);
  });

  it('a null cardId also trips the guard and never loads or saves', async () => {
    // null is another falsy value, so it reinforces the same `!cardId` guard: the
    // handler bails before any store access without inspecting the rest of the body.
    const { captured, saved, loadCount } = await runRoute({ body: { cardId: null } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing cardId' });
    assert.equal(loadCount, 0);
    assert.equal(saved.length, 0);
  });
});
