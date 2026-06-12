import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Invoke GET /api/annotations with a minimal mocked ctx and capture the response
// handed to json(res, status, payload). loadJSON returns the supplied annotations
// map verbatim: a plain object literal, so inherited keys like constructor and
// toString resolve to truthy values exactly as they would on the real loadJSON
// result. The read path never writes, so saveJSON is unneeded.
async function invoke({ page, annotations }) {
  const pathname = '/api/annotations';
  const query = page === undefined ? '' : `?page=${encodeURIComponent(page)}`;
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    ANNOTATIONS_FILE: 'annotations.json',
    loadJSON: () => annotations,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// One real page with two annotations. The literal defines no own constructor,
// toString, or __proto__ key, so each resolves to its inherited Object.prototype
// member when read without the Object.hasOwn guard.
const ANNOTATIONS = {
  'guide/intro': [
    { id: 'ann_1', text: 'first', note: '', startOffset: 0, endOffset: 5 },
    { id: 'ann_2', text: 'second', note: 'a note', startOffset: 6, endOffset: 12 },
  ],
};

describe('GET /api/annotations own-property page guard', () => {
  // constructor and toString resolve to truthy inherited values on a plain
  // object. Without the Object.hasOwn guard the `|| []` fallback is skipped and
  // the inherited function/object value drops out of JSON.stringify, so the body
  // serializes to a malformed `{}` instead of `{annotations: []}`.
  for (const page of ['__proto__', 'constructor', 'toString']) {
    it(`returns the empty default for the inherited key "${page}"`, async () => {
      const r = await invoke({ page, annotations: ANNOTATIONS });
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, { annotations: [] });
    });
  }

  it('returns the stored annotations for a real own-key page', async () => {
    const r = await invoke({ page: 'guide/intro', annotations: ANNOTATIONS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { annotations: ANNOTATIONS['guide/intro'] });
  });

  it('returns the empty default for an absent ordinary page', async () => {
    const r = await invoke({ page: 'no/such/page', annotations: ANNOTATIONS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { annotations: [] });
  });

  it('returns 400 when page is missing', async () => {
    const r = await invoke({ annotations: ANNOTATIONS });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Missing page parameter' });
  });
});
