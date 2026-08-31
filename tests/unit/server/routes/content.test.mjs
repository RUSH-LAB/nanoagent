/**
 * server/routes/content.js: pages served from the database, compiled per
 * request, against the caller's session.
 *
 * The endpoint exists because the build cannot do these three things: show a
 * workspace created a minute ago its own pages, refuse a private one to
 * somebody who may not read it, and stay the same size as workspaces are added.
 * The first and third are properties of the architecture; the second is what
 * these cases are mostly about, because it is the one a bug can quietly undo.
 *
 * The compiler is the real one, the site's own remark and rehype chain. A stub
 * would let a handler pass while rendering something the site would not
 * recognise, and the whole claim being made here is that a page rendered at
 * request time is the same page.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke, TEST_IDENTITY} from '../../_harness.mjs';

const routes = loadRoute('content');
const asUser = userId => ({...TEST_IDENTITY, userId});
const ada = asUser('ada');
const bob = asUser('bob');

/** A ctx holding these documents, created as `auth`. */
function withDocs(docs, auth = ada) {
  const ctx = makeCtx();
  for (const doc of docs) ctx.documents.create(ctx.scopeFor({auth}), doc);
  return ctx;
}

const at = (ctx, path, auth = ada, over = {}) =>
  invoke(routes, {path: '/api/content', query: {path}, ctx, auth, ...over});

describe('GET /api/content/tree', () => {
  it('lists what the caller may see, without the bodies', async () => {
    const ctx = withDocs([
      {path: 'books/a.md', markdown: '---\ntitle: A\n---\nbody'},
      {path: 'books/b.md', markdown: 'body'},
    ]);
    const r = await invoke(routes, {path: '/api/content/tree', ctx, auth: ada});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.documents.map(d => d.path), ['books/a.md', 'books/b.md']);
    assert.equal(r.payload.documents[0].title, 'A');
    assert.equal('markdown' in r.payload.documents[0], false, 'a tree renders no bodies');
  });

  it('leaves another member\'s private page out of the tree', async () => {
    const ctx = withDocs([
      {path: 'books/shared.md', markdown: 'ours'},
      {path: 'drafts/mine.md', markdown: 'mine', visibility: 'private'},
    ]);
    const hers = await invoke(routes, {path: '/api/content/tree', ctx, auth: ada});
    const his = await invoke(routes, {path: '/api/content/tree', ctx, auth: bob});
    assert.deepEqual(hers.payload.documents.map(d => d.path), ['books/shared.md', 'drafts/mine.md']);
    assert.deepEqual(his.payload.documents.map(d => d.path), ['books/shared.md']);
  });

  it('shows one workspace nothing of another\'s', async () => {
    const ctx = withDocs([{path: 'books/a.md', markdown: 'lab'}], {...ada, orgId: 'lab'});
    const r = await invoke(routes, {path: '/api/content/tree', ctx, auth: {...ada, orgId: 'course'}});
    assert.deepEqual(r.payload.documents, []);
  });
});

describe('GET /api/content', () => {
  it('compiles the document with the site\'s own plugin chain', async () => {
    const ctx = withDocs([{
      path: 'books/math.md',
      markdown: '---\ntitle: Math\n---\n# Heading\n\nInline $x^2$ and <Theorem>t</Theorem>.\n',
    }]);
    const r = await at(ctx, 'books/math.md');
    assert.equal(r.status, 200);
    assert.equal(r.payload.document.title, 'Math');
    // KaTeX ran, so the math is markup rather than a dollar sign; and the
    // component survived compilation rather than being escaped into text.
    assert.match(r.payload.code, /katex/, 'rehype-katex ran');
    assert.match(r.payload.code, /Theorem/, 'the component is still a component');
    assert.match(r.payload.code, /"use strict"/, 'a function body, not a module');
  });

  it('returns the markdown too, which is what the editor wants', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: '# source'}]);
    assert.equal((await at(ctx, 'a.md')).payload.markdown, '# source');
  });

  it('answers 404 for a document that is not there', async () => {
    const r = await at(makeCtx(), 'nope.md');
    assert.deepEqual([r.status, r.payload], [404, {error: 'Document not found'}]);
  });

  // The same answer for absent and forbidden. Telling them apart tells an
  // outsider which private pages exist, which is most of what one is hiding.
  it('answers 404, not 403, for a page the caller may not read', async () => {
    const ctx = withDocs([{path: 'drafts/mine.md', markdown: 'mine', visibility: 'private'}]);
    const r = await at(ctx, 'drafts/mine.md', bob);
    assert.deepEqual([r.status, r.payload], [404, {error: 'Document not found'}]);
  });

  it('rejects a path that climbs out of the workspace', async () => {
    const r = await at(makeCtx(), '../../etc/passwd');
    assert.equal(r.status, 400);
  });

  it('requires a path', async () => {
    const r = await invoke(routes, {path: '/api/content', ctx: makeCtx(), auth: ada});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing path'}]);
  });

  // A page whose MDX does not parse should say so. The build's answer to this
  // is to fail the whole site; per request it is one page reporting one error.
  it('reports a document whose MDX does not compile, with the reason', async () => {
    const ctx = withDocs([{path: 'broken.md', markdown: '<Unclosed>\n'}]);
    const r = await at(ctx, 'broken.md');
    assert.equal(r.status, 422);
    assert.equal(r.payload.code, 'mdx-error');
    assert.match(r.payload.error, /Unclosed/, 'and names what is wrong');
  });
});

describe('POST /api/content', () => {
  it('creates a document and serves it back', async () => {
    const ctx = makeCtx();
    const made = await invoke(routes, {
      method: 'POST', path: '/api/content', body: {path: 'new.md', markdown: '# fresh'}, ctx, auth: ada,
    });
    assert.equal(made.status, 201);
    assert.equal((await at(ctx, 'new.md')).payload.markdown, '# fresh');
  });

  it('refuses a path that is taken, saying which', async () => {
    const ctx = withDocs([{path: 'taken.md', markdown: 'x'}]);
    const r = await invoke(routes, {
      method: 'POST', path: '/api/content', body: {path: 'taken.md'}, ctx, auth: ada,
    });
    assert.equal(r.status, 409);
    assert.equal(r.payload.code, 'path-taken');
  });

  it('refuses before reading the body when the caller is over the limit', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/content', ctx, auth: ada});
    assert.equal(r.status, 429);
    assert.equal(reads, 0);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'content:127.0.0.1', maxPerMinute: 60}]);
  });
});

describe('PUT /api/content', () => {
  it('saves, and the next read is the new body', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: 'before'}]);
    const saved = await invoke(routes, {
      method: 'PUT', path: '/api/content', body: {path: 'a.md', markdown: 'after'}, ctx, auth: ada,
    });
    assert.equal(saved.status, 200);
    assert.equal((await at(ctx, 'a.md')).payload.markdown, 'after');
  });

  it('recompiles rather than serving what it compiled before', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: '# one'}]);
    const before = (await at(ctx, 'a.md')).payload.code;
    await invoke(routes, {
      method: 'PUT', path: '/api/content', body: {path: 'a.md', markdown: '# two'}, ctx, auth: ada,
    });
    const after = (await at(ctx, 'a.md')).payload.code;
    assert.notEqual(before, after, 'a save is a new compilation');
    assert.match(after, /two/);
  });

  it('cannot save a page the caller may not read', async () => {
    const ctx = withDocs([{path: 'drafts/mine.md', markdown: 'mine', visibility: 'private'}]);
    const r = await invoke(routes, {
      method: 'PUT', path: '/api/content', body: {path: 'drafts/mine.md', markdown: 'yours'}, ctx, auth: bob,
    });
    assert.equal(r.status, 404);
    assert.equal((await at(ctx, 'drafts/mine.md', ada)).payload.markdown, 'mine', 'untouched');
  });

  it('requires the body to be a string', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: 'x'}]);
    const r = await invoke(routes, {
      method: 'PUT', path: '/api/content', body: {path: 'a.md', markdown: 7}, ctx, auth: ada,
    });
    assert.deepEqual([r.status, r.payload], [400, {error: 'markdown must be a string'}]);
  });
});

describe('DELETE and move', () => {
  it('deletes, and the path is free again', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: 'x'}]);
    const gone = await invoke(routes, {method: 'DELETE', path: '/api/content', body: {path: 'a.md'}, ctx, auth: ada});
    assert.deepEqual([gone.status, gone.payload], [200, {success: true}]);
    assert.equal((await at(ctx, 'a.md')).status, 404);

    const remade = await invoke(routes, {
      method: 'POST', path: '/api/content', body: {path: 'a.md', markdown: 'again'}, ctx, auth: ada,
    });
    assert.equal(remade.status, 201);
  });

  it('cannot delete a page the caller may not read', async () => {
    const ctx = withDocs([{path: 'drafts/mine.md', markdown: 'mine', visibility: 'private'}]);
    const r = await invoke(routes, {
      method: 'DELETE', path: '/api/content', body: {path: 'drafts/mine.md'}, ctx, auth: bob,
    });
    assert.equal(r.status, 404);
    assert.ok(await at(ctx, 'drafts/mine.md', ada), 'still there');
  });

  it('moves a document to a free path', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: 'x'}]);
    const moved = await invoke(routes, {
      method: 'POST', path: '/api/content/move', body: {from: 'a.md', to: 'books/b.md'}, ctx, auth: ada,
    });
    assert.equal(moved.status, 200);
    assert.equal((await at(ctx, 'books/b.md')).payload.markdown, 'x');
    assert.equal((await at(ctx, 'a.md')).status, 404);
  });

  it('refuses a move onto a path that is taken', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: 'x'}, {path: 'b.md', markdown: 'y'}]);
    const r = await invoke(routes, {
      method: 'POST', path: '/api/content/move', body: {from: 'a.md', to: 'b.md'}, ctx, auth: ada,
    });
    assert.equal(r.status, 409);
  });
});

describe('PUT /api/content/visibility', () => {
  it('lets the author publish a draft to the workspace', async () => {
    const ctx = withDocs([{path: 'd.md', markdown: 'draft', visibility: 'private'}]);
    assert.equal((await at(ctx, 'd.md', bob)).status, 404, 'hidden to start with');

    const changed = await invoke(routes, {
      method: 'PUT', path: '/api/content/visibility', body: {path: 'd.md', visibility: 'org'}, ctx, auth: ada,
    });
    assert.deepEqual([changed.status, changed.payload], [200, {success: true, visibility: 'org'}]);
    assert.equal((await at(ctx, 'd.md', bob)).status, 200, 'and then it is not');
  });

  it('lets nobody else change it', async () => {
    const ctx = withDocs([{path: 'ours.md', markdown: 'x'}]);
    const r = await invoke(routes, {
      method: 'PUT', path: '/api/content/visibility', body: {path: 'ours.md', visibility: 'private'}, ctx, auth: bob,
    });
    assert.equal(r.status, 403);
    assert.equal(r.payload.code, 'not-author');
  });
});

describe('GET /api/content/versions', () => {
  it('lists what each save replaced, newest first, without the bodies', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: 'one'}]);
    for (const markdown of ['two', 'three']) {
      await invoke(routes, {method: 'PUT', path: '/api/content', body: {path: 'a.md', markdown}, ctx, auth: ada});
    }
    const r = await invoke(routes, {path: '/api/content/versions', query: {path: 'a.md'}, ctx, auth: ada});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.versions.map(v => v.seq), [2, 1]);
    assert.equal('markdown' in r.payload.versions[0], false);
  });

  it('serves one past version by its sequence', async () => {
    const ctx = withDocs([{path: 'a.md', markdown: 'one'}]);
    await invoke(routes, {method: 'PUT', path: '/api/content', body: {path: 'a.md', markdown: 'two'}, ctx, auth: ada});
    const r = await invoke(routes, {path: '/api/content/versions', query: {path: 'a.md', seq: '1'}, ctx, auth: ada});
    assert.equal(r.payload.version.markdown, 'one');
  });

  it('is not a way to read a page the caller may not read', async () => {
    const ctx = withDocs([{path: 'd.md', markdown: 'one', visibility: 'private'}]);
    await invoke(routes, {method: 'PUT', path: '/api/content', body: {path: 'd.md', markdown: 'two'}, ctx, auth: ada});
    const r = await invoke(routes, {path: '/api/content/versions', query: {path: 'd.md'}, ctx, auth: bob});
    assert.equal(r.status, 404);
  });
});
