/**
 * server/routes/comments-notes.js: per-page comments and keyed notes.
 *
 * Consolidated from the seventeen per-branch suites that used to cover this
 * module. Both stores are page/key keyed objects, so most cases here are about
 * the own-property and proto-key guards that keep a request-controlled key from
 * reaching Object.prototype.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, FILES} from '../../_harness.mjs';

const routes = loadRoute('comments-notes');
const {COMMENTS_FILE, NOTES_FILE, USERS_FILE} = FILES;

/** The three keys the module refuses as a store key (its frozen PROTO_KEYS). */
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
/** Keys that resolve to a truthy INHERITED value but are not own keys. */
const INHERITED_KEYS = ['constructor', 'toString', 'valueOf'];

const comment = (id, over = {}) => ({id, author: 'A', text: 't', parentId: null, userId: null, createdAt: '2026-01-01T00:00:00.000Z', ...over});

// ── Comments: list ────────────────────────────────────────────────────────

describe('GET /api/comments', () => {
  it('returns 400 when the page param is missing', async () => {
    const r = await invoke(routes, {path: '/api/comments'});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing page param'}]);
  });

  it('returns the page comments and the untruncated total', async () => {
    const store = {[COMMENTS_FILE]: {'/docs/a': [comment('c1'), comment('c2')]}};
    const r = await invoke(routes, {path: '/api/comments', query: {page: '/docs/a'}, ctx: makeCtx({store})});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.comments.map(c => c.id), ['c1', 'c2']);
    assert.equal(r.payload.total, 2);
  });

  it('applies limit and offset without changing total', async () => {
    const store = {[COMMENTS_FILE]: {'/p': [comment('c1'), comment('c2'), comment('c3')]}};
    const r = await invoke(routes, {path: '/api/comments', query: {page: '/p', limit: '1', offset: '1'}, ctx: makeCtx({store})});
    assert.deepEqual(r.payload.comments.map(c => c.id), ['c2']);
    assert.equal(r.payload.total, 3);
  });

  // A request-controlled page such as `constructor` resolves to a truthy
  // inherited value, so without the own-key guard `all.slice` would throw and
  // hang the request until the socket timeout.
  for (const page of [...INHERITED_KEYS, '/absent']) {
    it(`returns the empty default for the non-own page ${JSON.stringify(page)}`, async () => {
      const store = {[COMMENTS_FILE]: {'/real': [comment('c1')]}};
      const r = await invoke(routes, {path: '/api/comments', query: {page}, ctx: makeCtx({store})});
      assert.deepEqual([r.status, r.payload], [200, {comments: [], total: 0}]);
    });
  }

  // parseInt yields NaN for a present-but-non-numeric value, which would
  // otherwise collapse the slice to an empty page; each param falls back
  // independently, then the existing clamps apply.
  const PAGINATION = [
    {name: 'no limit or offset', query: {}, ids: ['c1', 'c2', 'c3']},
    {name: 'a non-numeric limit and offset', query: {limit: 'abc', offset: 'xyz'}, ids: ['c1', 'c2', 'c3']},
    {name: 'only the limit non-numeric', query: {limit: 'abc', offset: '1'}, ids: ['c2', 'c3']},
    {name: 'only the offset non-numeric', query: {limit: '2', offset: 'xyz'}, ids: ['c1', 'c2']},
    {name: 'a numeric prefix, keeping parseInt semantics', query: {limit: '2abc'}, ids: ['c1', 'c2']},
    {name: 'a large limit clamped to 500', query: {limit: '9999'}, ids: ['c1', 'c2', 'c3']},
    {name: 'limit=-1 clamped to 0, dropping nothing off the end', query: {limit: '-1'}, ids: []},
    {name: 'a very negative limit clamped to 0', query: {limit: '-50'}, ids: []},
    {name: 'a negative limit with an offset, with no slice wraparound', query: {limit: '-3', offset: '1'}, ids: []},
    {name: 'a negative offset clamped to 0', query: {offset: '-5'}, ids: ['c1', 'c2', 'c3']},
    {name: 'a valid limit and offset, unchanged', query: {limit: '2', offset: '1'}, ids: ['c2', 'c3']},
  ];
  for (const {name, query, ids} of PAGINATION) {
    it(`handles ${name}`, async () => {
      const store = {[COMMENTS_FILE]: {'/p': [comment('c1'), comment('c2'), comment('c3')]}};
      const r = await invoke(routes, {path: '/api/comments', query: {page: '/p', ...query}, ctx: makeCtx({store})});
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload.comments.map(c => c.id), ids);
      assert.equal(r.payload.total, 3);
    });
  }
});

// ── Comments: create ──────────────────────────────────────────────────────

describe('POST /api/comments', () => {
  it('returns 429 without reading the body or saving', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/comments', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.equal(reads, 0);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  const GUARDS = [
    {name: 'page omitted', body: {text: 't'}, error: 'Missing or invalid page'},
    {name: 'page non-string', body: {page: 7, text: 't'}, error: 'Missing or invalid page'},
    {name: 'page over 500 chars', body: {page: 'p'.repeat(501), text: 't'}, error: 'Page must be 500 characters or fewer'},
    {name: 'text omitted', body: {page: '/p'}, error: 'Missing or invalid text'},
    {name: 'text non-string', body: {page: '/p', text: 7}, error: 'Missing or invalid text'},
    {name: 'text over 5000 chars', body: {page: '/p', text: 't'.repeat(5001)}, error: 'Text must be 5000 characters or fewer'},
    {name: 'author non-string', body: {page: '/p', text: 't', author: 7}, error: 'author must be a string'},
    {name: 'author over 100 chars', body: {page: '/p', text: 't', author: 'a'.repeat(101)}, error: 'Author must be 100 characters or fewer'},
    {name: 'parentId non-string', body: {page: '/p', text: 't', parentId: 7}, error: 'parentId must be a string'},
    {name: 'parentId over 200 chars', body: {page: '/p', text: 't', parentId: 'p'.repeat(201)}, error: 'parentId must be 200 characters or fewer'},
    {name: 'userId non-string', body: {page: '/p', text: 't', userId: 7}, error: 'userId must be a string'},
    {name: 'userId over 200 chars', body: {page: '/p', text: 't', userId: 'u'.repeat(201)}, error: 'userId must be 200 characters or fewer'},
    ...PROTO_KEYS.map(page => ({name: `the proto page ${JSON.stringify(page)}`, body: {page, text: 't'}, error: 'Invalid page'})),
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/comments', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('stores a fully populated comment and persists it', async () => {
    const ctx = makeCtx();
    const body = {page: '/p', text: 'hello', author: 'Ada', parentId: 'c_parent', userId: 'u1'};
    const r = await invoke(routes, {method: 'POST', path: '/api/comments', body, ctx});
    assert.equal(r.status, 200);
    // id and createdAt are clock and random derived, so pin the key set and the
    // stable fields rather than their values.
    assert.deepEqual(Object.keys(r.payload.comment).sort(), ['author', 'createdAt', 'id', 'parentId', 'text', 'userId']);
    const {id, createdAt, ...stable} = r.payload.comment;
    assert.deepEqual(stable, {author: 'Ada', text: 'hello', parentId: 'c_parent', userId: 'u1'});
    assert.match(id, /^c_\d+_[a-z0-9]+$/);
    assert.deepEqual(ctx.store[COMMENTS_FILE]['/p'], [r.payload.comment]);
  });

  // author falls back through `sanitizeText(author) || 'Anonymous'` and the two
  // id fields through `x ? sanitizeText(x) : null`, so omitted and empty-string
  // take the same arm.
  for (const [label, extra] of [['omitted', {}], ['empty strings', {author: '', parentId: '', userId: ''}]]) {
    it(`applies the default arms when the optional fields are ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/comments', body: {page: '/p', text: 't', ...extra}});
      const {id, createdAt, ...stable} = r.payload.comment;
      assert.deepEqual(stable, {author: 'Anonymous', text: 't', parentId: null, userId: null});
    });
  }

  it('creates a comment under a page name that is only an inherited key', async () => {
    // `toString` is not in PROTO_KEYS, so it is a legal page; the own-key check
    // must still create a fresh array rather than reading the inherited value.
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/comments', body: {page: 'toString', text: 't'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.store[COMMENTS_FILE].toString, [r.payload.comment]);
  });
});

// ── Comments: delete ──────────────────────────────────────────────────────

describe('DELETE /api/comments', () => {
  const MISSING = [
    {name: 'page absent', body: {commentId: 'c1'}},
    {name: 'commentId absent', body: {page: '/p'}},
    {name: 'both absent', body: {}},
    {name: 'an empty-string page', body: {page: '', commentId: 'c1'}},
    {name: 'an empty-string commentId', body: {page: '/p', commentId: ''}},
  ];
  for (const {name, body} of MISSING) {
    it(`rejects ${name} before reading the store`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'DELETE', path: '/api/comments', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing page or commentId'}]);
      assert.deepEqual(ctx.calls.loadJSON, []);
    });
  }

  for (const page of [...INHERITED_KEYS, '/absent']) {
    it(`returns 404 for the non-own page ${JSON.stringify(page)}`, async () => {
      const store = {[COMMENTS_FILE]: {'/real': [comment('c1')]}};
      const r = await invoke(routes, {method: 'DELETE', path: '/api/comments', body: {page, commentId: 'c1'}, ctx: makeCtx({store})});
      assert.deepEqual([r.status, r.payload], [404, {error: 'Page not found'}]);
    });
  }

  it('returns 404 when the comment id is not on the page', async () => {
    const store = {[COMMENTS_FILE]: {'/p': [comment('c1')]}};
    const r = await invoke(routes, {method: 'DELETE', path: '/api/comments', body: {page: '/p', commentId: 'nope'}, ctx: makeCtx({store})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Comment not found'}]);
  });

  it('deletes an unowned comment and removes it from the stored array', async () => {
    const store = {[COMMENTS_FILE]: {'/p': [comment('c1'), comment('c2')]}};
    const ctx = makeCtx({store});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/comments', body: {page: '/p', commentId: 'c1'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[COMMENTS_FILE]['/p'].map(c => c.id), ['c2']);
  });

  // An owned comment is deletable only by its author or an owner-role user.
  const AUTH = [
    {name: 'the author deletes their own comment', userId: 'u1', users: {}, status: 200},
    {name: 'an owner-role user deletes a comment they do not own', userId: 'admin', users: {admin: {role: 'owner'}}, status: 200},
    {name: 'a non-author, non-owner user is rejected', userId: 'u2', users: {u2: {role: 'member'}}, status: 403},
    {name: 'an unknown user is rejected', userId: 'ghost', users: {}, status: 403},
    {name: 'an omitted userId cannot bypass the check', userId: undefined, users: {}, status: 403},
  ];
  for (const {name, userId, users, status} of AUTH) {
    it(`enforces ownership: ${name}`, async () => {
      const store = {[COMMENTS_FILE]: {'/p': [comment('c1', {userId: 'u1'})]}, [USERS_FILE]: users};
      const ctx = makeCtx({store});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/comments', body: {page: '/p', commentId: 'c1', userId}, ctx});
      assert.equal(r.status, status);
      if (status === 403) {
        assert.deepEqual(r.payload, {error: 'Only the comment author or an admin can delete this comment'});
        assert.deepEqual(ctx.store[COMMENTS_FILE]['/p'].map(c => c.id), ['c1'], 'a rejected delete leaves the store untouched');
      }
    });
  }
});

// ── Notes ─────────────────────────────────────────────────────────────────

describe('GET /api/notes', () => {
  const NOTES = {a: {content: 'one', title: 'A'}, b: {content: 'two', title: 'B'}};

  it('returns the whole store when no key is given', async () => {
    const r = await invoke(routes, {path: '/api/notes', ctx: makeCtx({store: {[NOTES_FILE]: NOTES}})});
    assert.deepEqual([r.status, r.payload], [200, {notes: NOTES}]);
  });

  it('returns an empty object for an empty store', async () => {
    const r = await invoke(routes, {path: '/api/notes'});
    assert.deepEqual([r.status, r.payload], [200, {notes: {}}]);
  });

  it('treats an empty-string key as absent and takes the list-all branch', async () => {
    const r = await invoke(routes, {path: '/api/notes', query: {key: ''}, ctx: makeCtx({store: {[NOTES_FILE]: NOTES}})});
    assert.deepEqual(r.payload, {notes: NOTES});
  });

  it('returns the note for a real key', async () => {
    const r = await invoke(routes, {path: '/api/notes', query: {key: 'a'}, ctx: makeCtx({store: {[NOTES_FILE]: NOTES}})});
    assert.deepEqual([r.status, r.payload], [200, {note: NOTES.a}]);
  });

  for (const key of [...INHERITED_KEYS, 'absent']) {
    it(`returns a null note for the non-own key ${JSON.stringify(key)}`, async () => {
      const r = await invoke(routes, {path: '/api/notes', query: {key}, ctx: makeCtx({store: {[NOTES_FILE]: NOTES}})});
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
    const saved = ctx.store[NOTES_FILE].k;
    assert.equal(saved.title, 'k');
    assert.equal(saved.content, 'body');
    assert.ok(saved.updatedAt);
  });

  it('stores an explicit title', async () => {
    const ctx = makeCtx();
    await invoke(routes, {method: 'PUT', path: '/api/notes', body: {key: 'k', content: 'body', title: 'My Note'}, ctx});
    assert.equal(ctx.store[NOTES_FILE].k.title, 'My Note');
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
      const ctx = makeCtx({store: {[NOTES_FILE]: {real: {content: 'c'}}}});
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
    const read = await invoke(routes, {path: '/api/notes', query: {key: 'k'}, ctx: makeCtx({store: ctx.store})});
    assert.equal(read.payload.note.content, 'body');
    const del = await invoke(routes, {method: 'DELETE', path: '/api/notes', body: {key: 'k'}, ctx: makeCtx({store: ctx.store})});
    assert.deepEqual([del.status, del.payload], [200, {success: true}]);
    assert.deepEqual(Object.keys(ctx.store[NOTES_FILE]), []);
  });
});

// Each body-reading handler wraps the read and the destructure of its result in
// one try. A rejecting readBody and a null body drive that catch two ways; the
// null case also pins precedence over the first validation guard.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/comments', error: 'Failed to create comment: request body must be JSON with "page" (string) and "text" (string) fields'},
    {method: 'DELETE', path: '/api/comments', error: 'Invalid request'},
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
