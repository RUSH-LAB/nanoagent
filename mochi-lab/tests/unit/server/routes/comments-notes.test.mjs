/**
 * server/routes/comments-notes.js: keyed notes.
 *
 * Consolidated from the seventeen per-branch suites that used to cover this
 * module. The store is a key-keyed object, so most cases here are about the
 * own-property and proto-key guards that keep a request-controlled key from
 * reaching Object.prototype.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, TEST_IDENTITY} from '../../_harness.mjs';

const routes = loadRoute('comments-notes');

/**
 * Write notes into one account's collection, as PUT /api/notes would leave
 * them. The store behind ctx, so the handler reads exactly what is seeded.
 */
const seedNotes = (ctx, entries, auth = TEST_IDENTITY) => {
  const scope = ctx.scopeFor({auth});
  const notes = ctx.scoped.collection('notes');
  for (const [key, value] of Object.entries(entries)) notes.put(scope, key, value);
  return ctx;
};

/** One account's notes, as the store holds them. */
const storedNotes = (ctx, auth = TEST_IDENTITY) =>
  ctx.scoped.collection('notes').entries(ctx.scopeFor({auth}));

/** The three keys the module refuses as a store key (its frozen PROTO_KEYS). */
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
/** Keys that resolve to a truthy INHERITED value but are not own keys. */
const INHERITED_KEYS = ['constructor', 'toString', 'valueOf'];

// ── Notes ─────────────────────────────────────────────────────────────────

describe('GET /api/notes', () => {
  const NOTES = {a: {content: 'one', title: 'A'}, b: {content: 'two', title: 'B'}};

  it('returns the whole store when no key is given', async () => {
    const r = await invoke(routes, {path: '/api/notes', ctx: seedNotes(makeCtx(), NOTES)});
    assert.deepEqual([r.status, r.payload], [200, {notes: NOTES}]);
  });

  it('returns an empty object for an empty store', async () => {
    const r = await invoke(routes, {path: '/api/notes'});
    assert.deepEqual([r.status, r.payload], [200, {notes: {}}]);
  });

  it('treats an empty-string key as absent and takes the list-all branch', async () => {
    const r = await invoke(routes, {path: '/api/notes', query: {key: ''}, ctx: seedNotes(makeCtx(), NOTES)});
    assert.deepEqual(r.payload, {notes: NOTES});
  });

  it('returns the note for a real key', async () => {
    const r = await invoke(routes, {path: '/api/notes', query: {key: 'a'}, ctx: seedNotes(makeCtx(), NOTES)});
    assert.deepEqual([r.status, r.payload], [200, {note: NOTES.a}]);
  });

  for (const key of [...INHERITED_KEYS, 'absent']) {
    it(`returns a null note for the non-own key ${JSON.stringify(key)}`, async () => {
      const r = await invoke(routes, {path: '/api/notes', query: {key}, ctx: seedNotes(makeCtx(), NOTES)});
      assert.deepEqual([r.status, r.payload], [200, {note: null}]);
    });
  }
});

describe('PUT /api/notes', () => {
  const GUARDS = [
    {name: 'a missing key', body: {content: 'c'}, error: 'Missing or invalid key'},
    {name: 'a non-string key', body: {key: 7, content: 'c'}, error: 'Missing or invalid key'},
    {name: 'a key over 200 chars', body: {key: 'k'.repeat(201), content: 'c'}, error: 'Key must be 200 characters or fewer'},
    {name: 'a missing content', body: {key: 'k'}, error: 'Content must be a string'},
    {name: 'a non-string content', body: {key: 'k', content: 7}, error: 'Content must be a string'},
    {name: 'content over 50000 chars', body: {key: 'k', content: 'c'.repeat(50001)}, error: 'Content must be 50000 characters or fewer'},
    {name: 'a numeric title', body: {key: 'k', content: 'c', title: 7}, error: 'title must be a string'},
    {name: 'an object title', body: {key: 'k', content: 'c', title: {}}, error: 'title must be a string'},
    {name: 'a title over 500 chars', body: {key: 'k', content: 'c', title: 't'.repeat(501)}, error: 'Title must be 500 characters or fewer'},
    ...PROTO_KEYS.map(key => ({name: `the proto key ${JSON.stringify(key)}`, body: {key, content: 'c'}, error: 'Invalid key'})),
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'PUT', path: '/api/notes', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  // Each cap is inclusive, so the exact boundary must pass the guard.
  const BOUNDARIES = [
    {name: 'a key of exactly 200 characters', body: {key: 'k'.repeat(200), content: 'c'}},
    {name: 'content of exactly 50000 characters', body: {key: 'k', content: 'c'.repeat(50000)}},
    {name: 'a title of exactly 500 characters', body: {key: 'k', content: 'c', title: 't'.repeat(500)}},
  ];
  for (const {name, body} of BOUNDARIES) {
    it(`accepts ${name}`, async () => {
      const r = await invoke(routes, {method: 'PUT', path: '/api/notes', body});
      assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    });
  }

  it('defaults an omitted title to the key', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'PUT', path: '/api/notes', body: {key: 'k', content: 'body'}, ctx});
    const saved = storedNotes(ctx).k;
    assert.equal(saved.title, 'k');
    assert.equal(saved.content, 'body');
    assert.ok(saved.updatedAt);
  });

  it('stores an explicit title', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'PUT', path: '/api/notes', body: {key: 'k', content: 'body', title: 'My Note'}, ctx});
    assert.equal(storedNotes(ctx).k.title, 'My Note');
  });
});

describe('DELETE /api/notes', () => {
  const GUARDS = [
    {name: 'a missing key', body: {}, error: 'Missing or invalid key'},
    {name: 'a numeric key', body: {key: 7}, error: 'Missing or invalid key'},
    ...PROTO_KEYS.map(key => ({name: `the proto key ${JSON.stringify(key)}`, body: {key}, error: 'Invalid key'})),
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without loading or saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'DELETE', path: '/api/notes', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.loadJSON, []);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  for (const key of ['toString', 'valueOf', 'absent']) {
    it(`returns 404 rather than a false success for the non-own key ${JSON.stringify(key)}`, async () => {
      const ctx = seedNotes(makeCtx(), {real: {content: 'c'}});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/notes', body: {key}, ctx});
      assert.deepEqual([r.status, r.payload], [404, {error: 'Note not found'}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }
});

describe('notes round trip', () => {
  it('saves, reads back, then deletes a note', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'PUT', path: '/api/notes', body: {key: 'k', content: 'body', title: 'T'}, ctx});
    const read = await invoke(routes, {path: '/api/notes', query: {key: 'k'}, ctx});
    assert.equal(read.payload.note.content, 'body');
    const del = await invoke(routes, {method: 'DELETE', path: '/api/notes', body: {key: 'k'}, ctx});
    assert.deepEqual([del.status, del.payload], [200, {success: true}]);
    assert.deepEqual(Object.keys(storedNotes(ctx)), []);
  });
});

// Each body-reading handler wraps the read and the destructure of its result in
// one try. A rejecting readBody and a null body drive that catch two ways; the
// null case also pins precedence over the first validation guard.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'PUT', path: '/api/notes', error: 'Failed to save note: request body must be JSON with "key" (string) and "content" (string) fields'},
    {method: 'DELETE', path: '/api/notes', error: 'Failed to delete note: request body must be JSON with "key" (string) identifying the note to delete'},
  ];
  for (const {method, path: p, error} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns its fixed 400 when ${label}, touching no store`, async () => {
        const ctx = makeCtx({readBody});
        const r = await invoke(routes, {method, path: p, ctx});
        assert.deepEqual([r.status, r.payload], [400, {error}]);
        assert.deepEqual(ctx.calls.loadJSON, []);
        assert.deepEqual(ctx.calls.saveJSON, []);
      });
    }
  }
});
