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
import {loadRoute, makeCtx, invoke, mockFs, PROJECT_ROOT} from '../../_harness.mjs';

const routes = loadRoute('graph-trash-files');
const at = rel => path.join(PROJECT_ROOT, rel);
const TRASH_DIR = at('var/trash');

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
  return {ctx: makeCtx({fs, ...over}), counts};
}

// ── Graph ─────────────────────────────────────────────────────────────────

describe('GET /api/graph', () => {
  const TREE = {
    [at('content/books/math/algebra.md')]: fm({title: 'Algebra'}, 'links [[books/math/calculus]] and [[calculus]] and [[nowhere]]'),
    [at('content/books/math/calculus.md')]: '# Calculus Heading\n\nno front matter',
    // "math" is a substring of books/math/algebra but is neither its suffix nor
    // its "/"-prefixed suffix, so the endsWith fallback must not resolve it.
    [at('content/posts/blog/hello.md')]: 'plain body [[math]] and [[nothing-here]]',
    [at('content/guide/index.md')]: fm({title: 'Guide'}, 'aliased [[algebra|see algebra]]'),
    [at('content/_draft.md')]: '[[algebra]]',
    [at('content/.hidden.md')]: '[[algebra]]',
    [at('content/notes.txt')]: '[[algebra]]',
  };

  it('builds route-like ids, titles and categories for every node', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/graph', ctx});
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
    const r = await invoke(routes, {path: '/api/graph', ctx});
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
    const r = await invoke(routes, {path: '/api/graph', ctx});
    assert.deepEqual(r.payload.edges.filter(e => e.source === 'posts/blog/hello'), []);
  });

  it('captures only the target of an aliased link, stopping at the pipe', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/graph', ctx});
    assert.deepEqual(r.payload.edges.filter(e => e.source === 'guide'), [{source: 'guide', target: 'books/math/algebra'}]);
  });

  // The nodeMap lookup is an own-key check, so a link naming an inherited
  // Object member must not resolve to Object.prototype.
  for (const target of ['constructor', 'toString', 'hasOwnProperty']) {
    it(`drops a wiki link naming the inherited member ${JSON.stringify(target)}`, async () => {
      const {ctx} = fsCtx({[at('content/a.md')]: `[[${target}]]`});
      const r = await invoke(routes, {path: '/api/graph', ctx});
      assert.deepEqual(r.payload.edges, []);
    });
  }

  it('memoizes the whole scan under "graph-data" with a 60000 ms TTL', async () => {
    let seen;
    const {ctx} = fsCtx(TREE, {cached: (key, ttl, fn) => { seen = [key, ttl]; return fn(); }});
    await invoke(routes, {path: '/api/graph', ctx});
    assert.deepEqual(seen, ['graph-data', 60000]);
  });

  it('serves an identical payload from cache without re-scanning', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const first = await invoke(routes, {path: '/api/graph', ctx});
    const walks = counts.readdir;
    const second = await invoke(routes, {path: '/api/graph', ctx});
    assert.equal(counts.readdir, walks, 'the second request re-uses the memo');
    assert.deepEqual(second.payload, first.payload);
  });

  it('returns identical results across two cold requests, so no lastIndex leaks', async () => {
    const first = await invoke(routes, {path: '/api/graph', ctx: fsCtx(TREE).ctx});
    const second = await invoke(routes, {path: '/api/graph', ctx: fsCtx(TREE).ctx});
    assert.deepEqual(second.payload, first.payload);
  });

  // Unusually for this codebase the catch binds the error and composes its
  // message into the reply, so both seams surface the underlying text.
  const SEAMS = [
    {name: 'the memo call throws', over: {cached() { throw new Error('cache unavailable'); }}, message: 'cache unavailable'},
    {name: 'the scan closure throws', over: {cached: (_k, _t, fn) => fn(), fs: {readdirSync() { throw new Error('content dir unreadable'); }}}, message: 'content dir unreadable'},
  ];
  for (const {name, over, message} of SEAMS) {
    it(`returns 500 carrying the error message when ${name}`, async () => {
      const {ctx} = fsCtx(TREE, over);
      const r = await invoke(routes, {path: '/api/graph', ctx});
      assert.deepEqual(r.replies, [{status: 500, payload: {error: `Graph generation failed: ${message}`}, opts: undefined}]);
      assert.equal(r.replies.some(x => x.payload && 'nodes' in x.payload), false);
    });
  }
});

// ── Trash ─────────────────────────────────────────────────────────────────

describe('DELETE /api/trash/empty', () => {
  it('returns a zero count and removes nothing when the trash directory is absent', async () => {
    const {ctx} = fsCtx({});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/trash/empty', ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, deleted: 0}]);
  });

  it('counts files recursively across subdirectories and removes the tree', async () => {
    const files = {
      [path.join(TRASH_DIR, 'a.md')]: 'x',
      [path.join(TRASH_DIR, 'sub', 'b.md')]: 'x',
      [path.join(TRASH_DIR, 'sub', 'deep', 'c.md')]: 'x',
    };
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {method: 'DELETE', path: '/api/trash/empty', ctx});
    // Directories are traversed, not counted.
    assert.deepEqual([r.status, r.payload], [200, {success: true, deleted: 3}]);
    assert.equal(ctx.fs.existsSync(path.join(TRASH_DIR, 'a.md')), false);
  });

  it('returns 500 when the removal throws', async () => {
    const base = mockFs({[path.join(TRASH_DIR, 'a.md')]: 'x'});
    const fs = {...base, rmSync() { throw new Error('EACCES'); }};
    const r = await invoke(routes, {method: 'DELETE', path: '/api/trash/empty', ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Failed to empty trash'}]);
  });
});

// ── Backlinks ─────────────────────────────────────────────────────────────

describe('GET /api/backlinks', () => {
  const TREE = {
    [at('content/docs/math/algebra.md')]: fm({title: 'Algebra'}, 'self [[algebra]]'),
    [at('content/bare.md')]: '# Bare\n\nlinks [[algebra]]',
    [at('content/full.md')]: '# Full\n\nlinks [[docs/math/algebra]]',
    [at('content/nodocs.md')]: '# NoDocs\n\nlinks [[math/algebra]]',
    [at('content/cited.md')]: '# Cited\n\ncites [@algebra]',
    [at('content/near.md')]: '# Near\n\nlinks [[algebraic]]',
    [at('content/other.md')]: '# Other\n\nlinks [[other/topic]]',
  };
  const TARGET = 'content/docs/math/algebra.md';

  it('matches all three link forms plus the citation, excluding self and near misses', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/backlinks', query: {path: TARGET}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.backlinks.map(b => [b.sourcePath, b.linkType]).sort(), [
      ['content/bare.md', 'wikilink'],
      ['content/cited.md', 'citation'],
      ['content/full.md', 'wikilink'],
      ['content/nodocs.md', 'wikilink'],
    ]);
  });

  it('takes the source title from front matter, then the first heading', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/backlinks', query: {path: TARGET}, ctx});
    const byPath = Object.fromEntries(r.payload.backlinks.map(b => [b.sourcePath, b.sourceTitle]));
    assert.equal(byPath['content/bare.md'], 'Bare');
  });

  it('returns 400 when the path param is missing, before any memo call', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/backlinks', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing path param'}]);
    assert.deepEqual(ctx.calls.cached, []);
  });

  it('memoizes per target path with a 60000 ms TTL', async () => {
    let seen;
    const {ctx} = fsCtx(TREE, {cached: (key, ttl, fn) => { seen = [key, ttl]; return fn(); }});
    await invoke(routes, {path: '/api/backlinks', query: {path: TARGET}, ctx});
    assert.deepEqual(seen, [`backlinks:${TARGET}`, 60000]);
  });

  it('returns identical results back to back', async () => {
    const first = await invoke(routes, {path: '/api/backlinks', query: {path: TARGET}, ctx: fsCtx(TREE).ctx});
    const second = await invoke(routes, {path: '/api/backlinks', query: {path: TARGET}, ctx: fsCtx(TREE).ctx});
    assert.deepEqual(second.payload, first.payload);
  });

  const SEAMS = [
    {name: 'the memo call throws', over: {cached() { throw new Error('boom'); }}},
    {name: 'the scan throws', over: {cached: (_k, _t, fn) => fn(), fs: {readdirSync() { throw new Error('boom'); }}}},
  ];
  for (const {name, over} of SEAMS) {
    it(`returns 500 when ${name}`, async () => {
      const {ctx} = fsCtx(TREE, over);
      const r = await invoke(routes, {path: '/api/backlinks', query: {path: TARGET}, ctx});
      assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Backlinks scan failed'}, opts: undefined}]);
    });
  }
});

// ── Folders and moves ─────────────────────────────────────────────────────

describe('rate-limit gates on the mutation handlers', () => {
  const GATES = [
    {method: 'POST', path: '/api/folder', key: 'create-folder:', limit: 20},
    {method: 'DELETE', path: '/api/folder', key: 'del-folder:', limit: 10},
    {method: 'POST', path: '/api/file/move', key: 'file-move:', limit: 20},
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

describe('POST /api/folder (create)', () => {
  it('rejects a path outside content/ before any mkdir', async () => {
    const {ctx} = fsCtx({});
    const r = await invoke(routes, {method: 'POST', path: '/api/folder', body: {path: 'elsewhere/x'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path. Must start with content/'}]);
    assert.equal(ctx.fs.existsSync(at('elsewhere/x')), false);
  });

  it('returns 409 when the directory already exists', async () => {
    const {ctx} = fsCtx({[at('content/existing/a.md')]: 'x'});
    const r = await invoke(routes, {method: 'POST', path: '/api/folder', body: {path: 'content/existing'}, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Directory already exists'}]);
  });

  it('creates a fresh directory', async () => {
    const {ctx} = fsCtx({});
    const r = await invoke(routes, {method: 'POST', path: '/api/folder', body: {path: 'content/fresh'}, ctx});
    assert.deepEqual([r.status, r.payload], [201, {success: true, path: 'content/fresh'}]);
    assert.equal(ctx.fs.existsSync(at('content/fresh')), true);
  });
});

describe('DELETE /api/folder (delete empty)', () => {
  const GUARDS = [
    {name: 'a path outside content/', body: {path: 'elsewhere'}, files: {}, status: 400, error: 'Invalid path. Must start with content/'},
    {name: 'the root content directory', body: {path: 'content'}, files: {}, status: 400, error: 'Cannot delete the root content directory'},
    {name: 'a directory that does not exist', body: {path: 'content/gone'}, files: {}, status: 404, error: 'Directory not found'},
    {name: 'a path that is a file', body: {path: 'content/a.md'}, files: {[at('content/a.md')]: 'x'}, status: 400, error: 'Path is not a directory'},
    {name: 'a directory that is not empty', body: {path: 'content/full'}, files: {[at('content/full/a.md')]: 'x'}, status: 400, error: 'Directory is not empty'},
  ];
  for (const {name, body, files, status, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const {ctx} = fsCtx(files);
      const r = await invoke(routes, {method: 'DELETE', path: '/api/folder', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
    });
  }

  it('removes an empty directory', async () => {
    const base = mockFs({});
    base.mkdirSync(at('content/empty'));
    const r = await invoke(routes, {method: 'DELETE', path: '/api/folder', body: {path: 'content/empty'}, ctx: makeCtx({fs: base})});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.equal(base.existsSync(at('content/empty')), false);
  });

  it('returns 400 rather than 500 when the body is not valid JSON', async () => {
    const ctx = makeCtx({fs: mockFs({}), readBody: async () => { throw new Error('Invalid JSON'); }});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/folder', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
  });

  it('returns 500 when the removal itself throws', async () => {
    const base = mockFs({});
    base.mkdirSync(at('content/empty'));
    const fs = {...base, rmdirSync() { throw new Error('EACCES'); }};
    const r = await invoke(routes, {method: 'DELETE', path: '/api/folder', body: {path: 'content/empty'}, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Delete failed'}]);
  });
});

describe('POST /api/file/move', () => {
  const GUARDS = [
    {name: 'an invalid source path', body: {filePath: '../escape.md', targetDir: 'content/dest'}, status: 400, error: 'Invalid file path'},
    {name: 'a target directory outside content/', body: {filePath: 'content/a.md', targetDir: 'elsewhere'}, status: 400, error: 'Invalid target directory. Must start with content/'},
    {name: 'a missing source file', body: {filePath: 'content/gone.md', targetDir: 'content/dest'}, status: 404, error: 'Source file not found'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const {ctx} = fsCtx({[at('content/a.md')]: 'x'});
      const r = await invoke(routes, {method: 'POST', path: '/api/file/move', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
    });
  }

  it('returns 409 when a file already exists at the target', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: 'x', [at('content/dest/a.md')]: 'y'});
    const r = await invoke(routes, {method: 'POST', path: '/api/file/move', body: {filePath: 'content/a.md', targetDir: 'content/dest'}, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'A file already exists at the target location'}]);
  });

  it('moves the file and clears only the search cache', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: 'x'});
    const r = await invoke(routes, {method: 'POST', path: '/api/file/move', body: {filePath: 'content/a.md', targetDir: 'content/dest'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, newPath: 'content/dest/a.md'}]);
    assert.equal(ctx.fs.existsSync(at('content/dest/a.md')), true);
    assert.equal(ctx.fs.existsSync(at('content/a.md')), false);
    // A move changes only a path, not the file count, so the content stats stay valid.
    assert.deepEqual(ctx.calls.invalidateCache, ['search']);
  });
});

// ── File info ─────────────────────────────────────────────────────────────

// ── Single-file export ────────────────────────────────────────────────────

describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/folder', error: 'Invalid request'},
    {method: 'POST', path: '/api/file/move', error: 'Invalid request'},
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
