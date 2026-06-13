import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load the real module the way the sibling route
// tests do (see tests/next-templates-custom-create-guards.test.mjs), so these
// cases exercise the shipped DELETE /api/templates/custom handler rather than a
// reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
// The delete handler reads and persists this single file. The mocked loadJSON
// answers only for this path, so any stray read surfaces as a thrown error
// instead of silently passing.
const TEMPLATES_FILE = path.join(PROJECT_ROOT, 'data', 'custom-templates.json');

// Drive the real DELETE /api/templates/custom handler over a mocked ctx. readBody
// counts its calls and returns the supplied body (or rejects when throwOnRead is
// set, to reach the catch arm); loadJSON returns a fresh clone of the seed
// document per call so the handler's splice cannot bleed back into the seed;
// saveJSON records every persist; json captures the (status, body) the handler
// hands back. No real filesystem, network, or git is ever touched. Unlike the
// sibling POST create handler, the DELETE arm is not rate limited and sanitizes
// nothing, so ctx carries no rateLimit or sanitizeText stub.
async function runRoute({
  method = 'DELETE',
  body = {},
  doc = {},
  throwOnRead = false,
} = {}) {
  const saved = [];
  let readBodyCount = 0;
  let loadCount = 0;
  let captured = null;
  const ctx = {
    readBody: async () => {
      readBodyCount += 1;
      if (throwOnRead) throw new Error('unreadable body');
      return body;
    },
    loadJSON: (fp) => {
      if (fp === TEMPLATES_FILE) {
        loadCount += 1;
        return structuredClone(doc);
      }
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/templates/custom';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount, loadCount };
}

describe('DELETE /api/templates/custom guards', () => {
  it('a missing or empty id returns 400 Missing id and never loads or saves', async () => {
    // The handler reads the body, then guards `if (!id)` before touching the
    // store, so a missing id loads nothing and saves nothing.
    const missing = await runRoute({ body: {} });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing id' });
    assert.equal(missing.readBodyCount, 1);
    assert.equal(missing.loadCount, 0);
    assert.equal(missing.saved.length, 0);

    // An empty string id is falsy, so it trips the same guard as a missing id.
    const empty = await runRoute({ body: { id: '' } });
    assert.equal(empty.captured.status, 400);
    assert.deepEqual(empty.captured.body, { error: 'Missing id' });
    assert.equal(empty.loadCount, 0);
    assert.equal(empty.saved.length, 0);
  });

  it('a store with no items key returns 404 Template not found and never saves', async () => {
    // loadJSON yields `{}`, so `if (!templates.items)` fires before any lookup
    // and the request is rejected without a persist.
    const { captured, saved, loadCount } = await runRoute({
      doc: {},
      body: { id: 'my-template' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Template not found' });
    assert.equal(loadCount, 1);
    assert.equal(saved.length, 0);
  });

  it('an id absent from a populated items array returns 404 Template not found and never saves', async () => {
    // items exist but none match, so findIndex returns -1 and the handler bails
    // before splicing or saving.
    const { captured, saved } = await runRoute({
      doc: { items: [{ id: 'other' }] },
      body: { id: 'missing' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Template not found' });
    assert.equal(saved.length, 0);
  });

  it('a matching id returns 200, saves once, and splices out only the matched template', async () => {
    const { captured, saved } = await runRoute({
      doc: { items: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
      ] },
      body: { id: 'b' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });

    // The handler persists exactly once, to the templates file, with the matched
    // template removed and the siblings left in their original order.
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, TEMPLATES_FILE);
    assert.deepEqual(saved[0].data.items, [
      { id: 'a', name: 'A' },
      { id: 'c', name: 'C' },
    ]);
  });

  it('a body that fails to read falls into the catch and returns 400 Invalid request without saving', async () => {
    // readBody rejecting reaches the single catch arm shared by the handler, so
    // the store is never loaded or persisted.
    const { captured, saved, loadCount } = await runRoute({ throwOnRead: true });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid request' });
    assert.equal(loadCount, 0);
    assert.equal(saved.length, 0);
  });
});
