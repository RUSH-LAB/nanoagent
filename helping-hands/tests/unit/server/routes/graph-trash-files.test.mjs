/**
 * server/routes/graph-trash-files.js: the wiki-link graph, backlinks, the trash
 * bin, folder create/delete, file move, file info, and the single-file and
 * bundle export renderers.
 *
 * Consolidated from the twenty-six per-branch suites that used to cover this
 * module.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, PROJECT_ROOT, CONTENT_DIR, TEST_ORG_ID, key} from '../../_harness.mjs';

const routes = loadRoute('graph-trash-files');
// Fixtures live in the workspace's own tree, and the paths a request carries
// are relative to it: `books/math/x.md`, never `content/mochi/books/math/x.md`.
const at = rel => path.join(CONTENT_DIR, rel);
// The trash is one tree per server, not per organization root, so it is joined
// under the repo root rather than under the content root.
const WORKSPACE_CONTEXT = Object.freeze({
  userId: 'test-user', workspaceId: TEST_ORG_ID, membershipId: 'member-1', role: 'owner',
});
const scopedInvoke = options => invoke(routes, {...options, requestContext: WORKSPACE_CONTEXT});
const documentScope = {workspaceId: TEST_ORG_ID, userId: 'test-user'};

const fm = (fields, body = '') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;

function fsCtx(files, over = {}) {
  const base = mockFs(files);
  const counts = {read: 0, readdir: 0, stat: 0};
  const fs = {
    ...base,
    readFileSync: p => { counts.read++; return base.readFileSync(p); },
    readdirSync: (p, o) => { counts.readdir++; return base.readdirSync(p, o); },
    statSync: p => { counts.stat++; return base.statSync(p); },
  };
  const ctx = makeCtx({fs, ...over});
  if (!over.documents) {
    for (const [fullPath, markdown] of Object.entries(files)) {
      if (!fullPath.startsWith(`${CONTENT_DIR}${path.sep}`)) continue;
      const relative = path.relative(CONTENT_DIR, fullPath).replace(/\\/g, '/');
      ctx.documents.create(documentScope, {path: relative, markdown: String(markdown)});
    }
  }
  return {ctx, counts};
}

// ── Graph ─────────────────────────────────────────────────────────────────

describe('GET /api/graph', () => {
  const TREE = {
    [at('books/math/algebra.md')]: fm({title: 'Algebra'}, 'links [[books/math/calculus]] and [[calculus]] and [[nowhere]]'),
    [at('books/math/calculus.md')]: '# Calculus Heading\n\nno front matter',
    // "math" is a substring of books/math/algebra but is neither its suffix nor
    // its "/"-prefixed suffix, so the endsWith fallback must not resolve it.
    [at('posts/blog/hello.md')]: 'plain body [[math]] and [[nothing-here]]',
    [at('guide/index.md')]: fm({title: 'Guide'}, 'aliased [[algebra|see algebra]]'),
    [at('_draft.md')]: '[[algebra]]',
    [at('.hidden.md')]: '[[algebra]]',
    [at('notes.txt')]: '[[algebra]]',
  };

  it('builds route-like ids, titles and categories for every node', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await scopedInvoke({path: '/api/graph', ctx});
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.payload.nodes.map(n => [n.id, n]));
    // books/X and posts/X take X as the category; a single-segment path takes ''.
    assert.deepEqual(byId['books/math/algebra'], {id: 'books/math/algebra', path: 'books/math/algebra.md', title: 'Algebra', category: 'math'});
    assert.deepEqual(byId['posts/blog/hello'], {id: 'posts/blog/hello', path: 'posts/blog/hello.md', title: 'hello', category: 'blog'});
    // A trailing /index is stripped from the id.
    assert.equal(byId['guide'].id, 'guide');
    assert.equal(byId['guide'].category, 'guide');
    // No front-matter title, so the first heading wins over the filename.
    assert.equal(byId['books/math/calculus'].title, 'Calculus Heading');
    // Dot files, underscore files and non-markdown are skipped.
    assert.deepEqual(r.payload.nodes.map(n => n.id).sort(), ['books/math/algebra', 'books/math/calculus', 'guide', 'posts/blog/hello']);
  });

  it('resolves edges by own key first, then by last-segment suffix, dropping the rest', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await scopedInvoke({path: '/api/graph', ctx});
    const edges = r.payload.edges.filter(e => e.source === 'books/math/algebra');
    // The full id resolves directly; the bare last segment resolves through the
    // suffix fallback; "nowhere" matches nothing and is dropped.
    assert.deepEqual(edges, [
      {source: 'books/math/algebra', target: 'books/math/calculus'},
      {source: 'books/math/algebra', target: 'books/math/calculus'},
    ]);
  });

  it('does not resolve a target that is merely a substring of a node id', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await scopedInvoke({path: '/api/graph', ctx});
    assert.deepEqual(r.payload.edges.filter(e => e.source === 'posts/blog/hello'), []);
  });

  it('captures only the target of an aliased link, stopping at the pipe', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await scopedInvoke({path: '/api/graph', ctx});
    assert.deepEqual(r.payload.edges.filter(e => e.source === 'guide'), [{source: 'guide', target: 'books/math/algebra'}]);
  });

  // The nodeMap lookup is an own-key check, so a link naming an inherited
  // Object member must not resolve to Object.prototype.
  for (const target of ['constructor', 'toString', 'hasOwnProperty']) {
    it(`drops a wiki link naming the inherited member ${JSON.stringify(target)}`, async () => {
      const {ctx} = fsCtx({[at('a.md')]: `[[${target}]]`});
      const r = await scopedInvoke({path: '/api/graph', ctx});
      assert.deepEqual(r.payload.edges, []);
    });
  }

  it('memoizes the whole scan under "graph-data" with a 60000 ms TTL', async () => {
    let seen;
    const {ctx} = fsCtx(TREE, {cached: (key, ttl, fn) => { seen = [key, ttl]; return fn(); }});
    await scopedInvoke({path: '/api/graph', ctx});
    assert.deepEqual(seen, [key('graph-data:test-user'), 60000]);
  });

  it('serves an identical payload from cache without re-scanning', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const first = await scopedInvoke({path: '/api/graph', ctx});
    const walks = counts.readdir;
    const second = await scopedInvoke({path: '/api/graph', ctx});
    assert.equal(counts.readdir, walks, 'the second request re-uses the memo');
    assert.deepEqual(second.payload, first.payload);
  });

  it('returns identical results across two cold requests, so no lastIndex leaks', async () => {
    const first = await scopedInvoke({path: '/api/graph', ctx: fsCtx(TREE).ctx});
    const second = await scopedInvoke({path: '/api/graph', ctx: fsCtx(TREE).ctx});
    assert.deepEqual(second.payload, first.payload);
  });

  // Unusually for this codebase the catch binds the error and composes its
  // message into the reply, so both seams surface the underlying text.
  const SEAMS = [
    {name: 'the memo call throws', over: {cached() { throw new Error('cache unavailable'); }}, message: 'cache unavailable'},
    {name: 'the database scan throws', over: {cached: (_k, _t, fn) => fn(), documents: {snapshot() { throw new Error('content unavailable'); }}}, message: 'content unavailable'},
  ];
  for (const {name, over, message} of SEAMS) {
    it(`returns 500 carrying the error message when ${name}`, async () => {
      const {ctx} = fsCtx(TREE, over);
      const r = await scopedInvoke({path: '/api/graph', ctx});
      assert.deepEqual(r.replies, [{status: 500, payload: {error: `Graph generation failed: ${message}`}, opts: undefined}]);
      assert.equal(r.replies.some(x => x.payload && 'nodes' in x.payload), false);
    });
  }
});

// ── Trash ─────────────────────────────────────────────────────────────────

describe('DELETE /api/trash/empty', () => {
  it('returns a zero count when no database documents are deleted', async () => {
    const ctx = makeCtx();
    const r = await scopedInvoke({method: 'DELETE', path: '/api/trash/empty', ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, deleted: 0}]);
  });

  it('purges only this workspace soft-deleted document rows', async () => {
    const ctx = makeCtx();
    ctx.documents.create(documentScope, {path: 'a.md', markdown: 'a'});
    ctx.documents.create({workspaceId: 'other', userId: 'test-user'}, {path: 'b.md', markdown: 'b'});
    ctx.documents.remove(documentScope, 'a.md');
    ctx.documents.remove({workspaceId: 'other', userId: 'test-user'}, 'b.md');
    const r = await scopedInvoke({method: 'DELETE', path: '/api/trash/empty', ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, deleted: 1}]);
    assert.equal(ctx.documents.emptyTrash({workspaceId: 'other', userId: 'test-user'}), 1);
  });

  it('returns 500 when the database purge throws', async () => {
    const ctx = makeCtx({documents: {emptyTrash() { throw new Error('database unavailable'); }}});
    const r = await scopedInvoke({method: 'DELETE', path: '/api/trash/empty', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Failed to empty trash'}]);
  });
});

// ── Backlinks ─────────────────────────────────────────────────────────────

describe('GET /api/backlinks', () => {
  const TREE = {
    [at('docs/math/algebra.md')]: fm({title: 'Algebra'}, 'self [[algebra]]'),
    [at('bare.md')]: '# Bare\n\nlinks [[algebra]]',
    [at('full.md')]: '# Full\n\nlinks [[docs/math/algebra]]',
    [at('nodocs.md')]: '# NoDocs\n\nlinks [[math/algebra]]',
    [at('cited.md')]: '# Cited\n\ncites [@algebra]',
    [at('near.md')]: '# Near\n\nlinks [[algebraic]]',
    [at('other.md')]: '# Other\n\nlinks [[other/topic]]',
  };
  // The target arrives already relative to the content root, so the handler
  // derives its link forms from it as-is rather than stripping a prefix.
  const TARGET = 'docs/math/algebra.md';

  it('matches all three link forms plus the citation, excluding self and near misses', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await scopedInvoke({path: '/api/backlinks', query: {path: TARGET}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.backlinks.map(b => [b.sourcePath, b.linkType]).sort(), [
      ['bare.md', 'wikilink'],
      ['cited.md', 'citation'],
      ['full.md', 'wikilink'],
      ['nodocs.md', 'wikilink'],
    ]);
  });

  it('takes the source title from front matter, then the first heading', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await scopedInvoke({path: '/api/backlinks', query: {path: TARGET}, ctx});
    const byPath = Object.fromEntries(r.payload.backlinks.map(b => [b.sourcePath, b.sourceTitle]));
    assert.equal(byPath['bare.md'], 'Bare');
  });

  it('returns 400 when the path param is missing, before any memo call', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await scopedInvoke({path: '/api/backlinks', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing path param'}]);
    assert.deepEqual(ctx.calls.cached, []);
  });

  it('memoizes per target path with a 60000 ms TTL', async () => {
    let seen;
    const {ctx} = fsCtx(TREE, {cached: (key, ttl, fn) => { seen = [key, ttl]; return fn(); }});
    await scopedInvoke({path: '/api/backlinks', query: {path: TARGET}, ctx});
    assert.deepEqual(seen, [key(`backlinks:test-user:${TARGET}`), 60000]);
  });

  it('returns identical results back to back', async () => {
    const first = await scopedInvoke({path: '/api/backlinks', query: {path: TARGET}, ctx: fsCtx(TREE).ctx});
    const second = await scopedInvoke({path: '/api/backlinks', query: {path: TARGET}, ctx: fsCtx(TREE).ctx});
    assert.deepEqual(second.payload, first.payload);
  });

  const SEAMS = [
    {name: 'the memo call throws', over: {cached() { throw new Error('boom'); }}},
    {name: 'the scan throws', over: {cached: (_k, _t, fn) => fn(), documents: {list() { throw new Error('boom'); }}}},
  ];
  for (const {name, over} of SEAMS) {
    it(`returns 500 when ${name}`, async () => {
      const {ctx} = fsCtx(TREE, over);
      const r = await scopedInvoke({path: '/api/backlinks', query: {path: TARGET}, ctx});
      assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Backlinks scan failed'}, opts: undefined}]);
    });
  }
});

// ── Folders and moves ─────────────────────────────────────────────────────

describe('rate-limit gates on the mutation handlers', () => {
  const GATES = [
    {method: 'POST', path: '/api/folder', key: 'create-folder:', limit: 20},
    {method: 'DELETE', path: '/api/folder', key: 'del-folder:', limit: 10},
  ];
  for (const {method, path: p, key, limit} of GATES) {
    it(`${method} ${p} returns 429 with key "${key}" and limit ${limit}, before readBody`, async () => {
      let reads = 0;
      const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
      const r = await invoke(routes, {method, path: p, ctx});
      assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
      assert.deepEqual(ctx.calls.rateLimit, [{key: key + '127.0.0.1', maxPerMinute: limit}]);
      assert.equal(reads, 0);
    });
  }
});

describe('virtual document folders', () => {
  it('validates a folder path without creating anything on disk', async () => {
    const ctx = makeCtx();
    const bad = await scopedInvoke({method: 'POST', path: '/api/folder', body: {path: '../elsewhere/x'}, ctx});
    assert.deepEqual([bad.status, bad.payload], [400, {error: 'Invalid path'}]);
    const created = await scopedInvoke({method: 'POST', path: '/api/folder', body: {path: 'fresh'}, ctx});
    assert.deepEqual([created.status, created.payload], [201, {success: true, path: 'fresh', virtual: true}]);
  });

  it('deletes an empty implicit folder and refuses one containing documents', async () => {
    const ctx = makeCtx();
    const empty = await scopedInvoke({method: 'DELETE', path: '/api/folder', body: {path: 'empty'}, ctx});
    assert.deepEqual([empty.status, empty.payload], [200, {success: true, virtual: true}]);
    ctx.documents.create(documentScope, {path: 'full/a.md', markdown: 'a'});
    const full = await scopedInvoke({method: 'DELETE', path: '/api/folder', body: {path: 'full'}, ctx});
    assert.deepEqual([full.status, full.payload], [400, {error: 'Directory is not empty'}]);
  });

  it('refuses deleting the virtual root', async () => {
    const response = await scopedInvoke({method: 'DELETE', path: '/api/folder', body: {path: '.'}, ctx: makeCtx()});
    assert.deepEqual([response.status, response.payload], [400, {error: 'Cannot delete the root content directory'}]);
  });
});

// ── File info ─────────────────────────────────────────────────────────────

// ── Single-file export ────────────────────────────────────────────────────

describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/folder', error: 'Invalid request'},
  ];
  for (const {method, path: p, error} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns its fixed 400 when ${label}, with no filesystem effect`, async () => {
        const base = mockFs({});
        let writes = 0;
        const fs = new Proxy(base, {
          get(t, prop) {
            if (['mkdirSync', 'writeFileSync', 'renameSync', 'rmSync', 'rmdirSync'].includes(prop)) {
              return () => { writes++; };
            }
            return t[prop];
          },
        });
        const r = await invoke(routes, {method, path: p, ctx: makeCtx({fs, readBody})});
        assert.deepEqual([r.status, r.payload], [400, {error}]);
        assert.equal(writes, 0);
      });
    }
  }
});
