import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load the real module the way the sibling route
// tests do, then drive DELETE /api/annotations over a fully mocked ctx (no real
// filesystem, network, or git). This add-only characterization test pins the two
// branches of the handler that no existing test covers:
//   1. the `Missing page or id` 400 guard (`!page || !id`), which short-circuits
//      before loadJSON, so neither a load nor a save runs.
//   2. the `Annotation not found` 404 guard (`idx === -1`) when the page IS an
//      own key holding an array but no element matches the requested id.
// The happy path and the `Page not found` 404 are already pinned by
// tests/next-annotations-write-ownprop-guard.test.mjs; one case of each is kept
// here only for guard-order context.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// Invoke the route module once with a mocked ctx. `data` seeds loadJSON; the real
// loader returns a fresh deep copy on every call, so this stub returning the seed
// directly is a behavior-equivalent simplification here, since no assertion below
// depends on copy versus reference semantics (the not-found cases return before
// any splice, and the happy-path case asserts on the captured saveJSON payload).
// The recorders capture how many times loadJSON / saveJSON ran plus the file and
// payload the handler tried to persist. This DELETE handler has no rate limit, so
// rateLimit is a harmless, never called stub. The dispatcher detects a sent
// response via res.writableEnded, which json() flips.
async function invoke({ method = 'DELETE', pathname = '/api/annotations', body, data } = {}) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const annotations = data || {};
  let captured = null;
  let loadCount = 0;
  let saveCount = 0;
  let savedFile = null;
  let savedData = null;
  const ctx = {
    ANNOTATIONS_FILE: 'annotations.json',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => { loadCount++; return annotations; },
    saveJSON: (file, payload) => { saveCount++; savedFile = file; savedData = payload; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, annotations, loadCount, saveCount, savedFile, savedData };
}

describe('DELETE /api/annotations missing page or id guard (400)', () => {
  // The `!page || !id` guard runs before loadJSON, so a missing field rejects
  // with no load and no save.
  it('returns 400 Missing page or id when page is absent (id only)', async () => {
    const { captured, loadCount, saveCount } = await invoke({ body: { id: 'a1' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing page or id' });
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 Missing page or id when id is absent (page only)', async () => {
    const { captured, loadCount, saveCount } = await invoke({ body: { page: 'docs/intro.md' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing page or id' });
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 for an empty-string page (falsy, same guard)', async () => {
    const { captured, loadCount, saveCount } = await invoke({ body: { page: '', id: 'a1' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing page or id' });
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });

  it('returns 400 for an empty-string id (falsy, same guard)', async () => {
    const { captured, loadCount, saveCount } = await invoke({ body: { page: 'docs/intro.md', id: '' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing page or id' });
    assert.equal(loadCount, 0);
    assert.equal(saveCount, 0);
  });
});

describe('DELETE /api/annotations annotation-not-found guard (404)', () => {
  // The page IS an own key holding an array, but no element carries the requested
  // id, so findIndex returns -1 and the handler rejects. No splice and no save
  // run, so the seeded array is left intact.
  it('returns 404 Annotation not found when the id matches no element', async () => {
    const data = { 'docs/intro.md': [{ id: 'a1' }] };
    const { captured, loadCount, saveCount } = await invoke({ body: { page: 'docs/intro.md', id: 'missing' }, data });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Annotation not found' });
    assert.equal(loadCount, 1);
    assert.equal(saveCount, 0);
  });

  it('leaves the seeded annotations untouched on the not-found id', async () => {
    const data = { 'docs/intro.md': [{ id: 'a1' }, { id: 'a2' }] };
    const { captured, annotations, saveCount } = await invoke({ body: { page: 'docs/intro.md', id: 'nope' }, data });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Annotation not found' });
    assert.equal(saveCount, 0);
    assert.deepEqual(annotations['docs/intro.md'].map(a => a.id), ['a1', 'a2']);
  });
});

describe('DELETE /api/annotations guard-order context', () => {
  // Both behaviors below are already pinned by the sibling own-property guard
  // test; they are repeated here only to fix their order relative to the two
  // target branches above.
  it('returns 404 Page not found when the page is not an own key, without saving', async () => {
    const { captured, saveCount } = await invoke({ body: { page: 'docs/missing.md', id: 'a1' }, data: {} });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Page not found' });
    assert.equal(saveCount, 0);
  });

  it('removes an owned annotation, saves once, and preserves siblings (200)', async () => {
    const data = { 'docs/intro.md': [{ id: 'a1', text: 'first' }, { id: 'a2', text: 'second' }] };
    const { captured, savedFile, savedData, saveCount } = await invoke({ body: { page: 'docs/intro.md', id: 'a1' }, data });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { success: true });
    assert.equal(saveCount, 1);
    assert.equal(savedFile, 'annotations.json');
    assert.deepEqual(savedData['docs/intro.md'].map(a => a.id), ['a2']);
  });
});
