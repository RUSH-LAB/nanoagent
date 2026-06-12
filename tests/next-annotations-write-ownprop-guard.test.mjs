import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Drive POST/DELETE /api/annotations with a minimal mocked ctx and capture the
// response handed to json(res, status, payload). loadJSON returns the supplied
// store verbatim (a plain object literal), so inherited names like toString and
// valueOf resolve to truthy values exactly as they would on the real loadJSON
// result; the own-property guard is what keeps them from being treated as pages.
// `Object` is never injected, so the handler uses the global Object.hasOwn.
async function invoke({ method, body, store }) {
  const pathname = '/api/annotations';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const annotations = store || {};
  let captured = null;
  let saveCalls = 0;
  const ctx = {
    ANNOTATIONS_FILE: 'annotations.json',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => annotations,
    saveJSON: () => { saveCalls++; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, annotations, saveCalls };
}

const postBody = (page) => ({ page, text: 'highlight', startOffset: 0, endOffset: 9 });

describe('POST /api/annotations own-property page guard', () => {
  // toString, valueOf, and hasOwnProperty resolve to truthy inherited functions
  // on a plain object. Before the fix the bare `if (!annotations[page])` guard
  // skipped the array init, so `.push` threw a TypeError that the try/catch
  // swallowed into a misleading 400. The own-property guard initializes the
  // array under the requested key and the write succeeds.
  for (const page of ['toString', 'valueOf', 'hasOwnProperty']) {
    it(`persists an annotation under the inherited key "${page}" (201)`, async () => {
      const { captured, annotations } = await invoke({ method: 'POST', body: postBody(page) });
      assert.equal(captured.status, 201);
      assert.ok(captured.payload.annotation);
      assert.ok(Object.hasOwn(annotations, page));
      assert.equal(annotations[page].length, 1);
      assert.equal(annotations[page][0].id, captured.payload.annotation.id);
    });
  }

  // The prototype-pollution names stay rejected by the unchanged PROTO_KEYS guard.
  for (const page of ['__proto__', 'constructor', 'prototype']) {
    it(`rejects the prototype-pollution key "${page}" with 400`, async () => {
      const { captured, saveCalls } = await invoke({ method: 'POST', body: postBody(page) });
      assert.equal(captured.status, 400);
      assert.deepEqual(captured.payload, { error: 'Invalid page' });
      assert.equal(saveCalls, 0);
    });
  }

  it('persists an annotation under a normal page (201)', async () => {
    const { captured, annotations, saveCalls } = await invoke({ method: 'POST', body: postBody('guide/intro') });
    assert.equal(captured.status, 201);
    assert.ok(captured.payload.annotation);
    assert.equal(annotations['guide/intro'].length, 1);
    assert.equal(saveCalls, 1);
  });
});

describe('DELETE /api/annotations own-property page guard', () => {
  // For an absent page whose name is an inherited member, the own-property guard
  // returns a clean 404 instead of letting `.findIndex` throw on the inherited
  // function (which the try/catch previously swallowed into a 400). No write
  // happens on the not-found path.
  for (const page of ['toString', 'valueOf']) {
    it(`returns 404 for the absent inherited key "${page}" without saving`, async () => {
      const { captured, saveCalls } = await invoke({ method: 'DELETE', body: { page, id: 'ann_missing' } });
      assert.equal(captured.status, 404);
      assert.deepEqual(captured.payload, { error: 'Page not found' });
      assert.equal(saveCalls, 0);
    });
  }

  it('removes an annotation the page owns (200)', async () => {
    const store = { 'guide/intro': [{ id: 'ann_1', text: 'first', startOffset: 0, endOffset: 5 }] };
    const { captured, annotations, saveCalls } = await invoke({
      method: 'DELETE',
      body: { page: 'guide/intro', id: 'ann_1' },
      store,
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(annotations['guide/intro'].length, 0);
    assert.equal(saveCalls, 1);
  });
});
