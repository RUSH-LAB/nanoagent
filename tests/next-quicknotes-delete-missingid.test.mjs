import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// Drive the DELETE /api/quicknotes handler in process with a minimal mocked ctx
// and capture the response handed to json(res, status, payload). loadJSON is a
// call counter that returns the supplied store verbatim, so a test can prove the
// early `Missing id` guard short-circuits before any store read. saveJSON is a
// tripwire counter that must stay at 0 on every guard arm, since no delete
// persists on a 400 or 404. This edits no source.
async function invokeDelete({ body, store }) {
  const pathname = '/api/quicknotes';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'DELETE', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store || {};
  let captured = null;
  let loadCalls = 0;
  let saveCalls = 0;
  const ctx = {
    path,
    PROJECT_ROOT: '/tmp',
    readBody: async () => body,
    loadJSON: () => { loadCalls++; return data; },
    saveJSON: () => { saveCalls++; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, data, loadCalls, saveCalls };
}

describe('DELETE /api/quicknotes missing-id and present-user absent-note guards', () => {
  // The early `if (!id)` guard returns 400 before the handler resolves `uid`,
  // joins the QUICKNOTES_FILE path, or reads the store. The own-property suite
  // always sends a valid id, so this rung is otherwise uncovered. Every falsy id
  // must short-circuit with loadJSON and saveJSON both untouched.
  const FALSY_IDS = [
    { label: 'an omitted id', body: { userId: 'alice' } },
    { label: 'an empty-string id', body: { userId: 'alice', id: '' } },
    { label: 'a null id', body: { userId: 'alice', id: null } },
  ];
  for (const { label, body } of FALSY_IDS) {
    it(`returns 400 Missing id for ${label}, before any store read`, async () => {
      const { captured, loadCalls, saveCalls } = await invokeDelete({ body });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Missing id' });
      assert.equal(loadCalls, 0);
      assert.equal(saveCalls, 0);
    });
  }

  // Present-user absent-note arm: the resolved user key exists in the store
  // (Object.hasOwn is true), but findIndex returns -1 because the requested id is
  // not in that user's list, so the handler returns 404 without saving. The
  // own-property suite only exercises the absent-user 404 and the delete success
  // path, so this idx === -1 arm is otherwise uncovered.
  it('returns 404 Note not found when the user key exists but the id is absent', async () => {
    const store = { alice: [{ id: 'qn_other' }] };
    const { captured, data, loadCalls, saveCalls } = await invokeDelete({
      body: { userId: 'alice', id: 'qn_missing' }, store,
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Note not found' });
    assert.equal(loadCalls, 1);
    assert.equal(saveCalls, 0);
    // No splice ran, so the user's existing note list is left intact.
    assert.deepEqual(data.alice, [{ id: 'qn_other' }]);
  });

  // The same absent-note arm under the default user the handler resolves from a
  // missing userId. Proves the present-key idx === -1 path is independent of an
  // explicit userId.
  it('returns 404 Note not found for the default user when the id is absent', async () => {
    const store = { default: [{ id: 'qn_kept' }] };
    const { captured, data, loadCalls, saveCalls } = await invokeDelete({
      body: { id: 'qn_missing' }, store,
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Note not found' });
    assert.equal(loadCalls, 1);
    assert.equal(saveCalls, 0);
    assert.deepEqual(data.default, [{ id: 'qn_kept' }]);
  });
});
