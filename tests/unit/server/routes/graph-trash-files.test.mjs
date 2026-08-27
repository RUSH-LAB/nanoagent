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

describe('trash name-parsing regexes', () => {
  const CANONICAL = {
    TRASH_NAME_RE: /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(.+)$/,
    TRASH_TIME_TAIL_RE: /(\d{2})-(\d{2})-(\d{3})Z$/,
    TRASH_TIME_MID_RE: /T(\d{2})-(\d{2})/,
  };
  for (const [name, canonical] of Object.entries(CANONICAL)) {
    it(`${name} matches its canonical literal and is one shared instance`, () => {
      const re = routes[name];
      assert.equal(re.source, canonical.source);
      assert.equal(re.flags, canonical.flags);
      assert.equal(re.global, false);
      assert.equal(re.sticky, false);
      assert.strictEqual(loadRoute('graph-trash-files')[name], re);
    });
  }
});

describe('GET /api/trash', () => {
  const trashed = (sub, stamp, name) => [path.join(TRASH_DIR, sub, `${stamp}_${name}`), 'body'];
  const TREE = Object.fromEntries([
    trashed('content', '2026-01-01T09-30-15-123Z', 'older.md'),
    trashed('content/sub', '2026-02-02T10-45-30-456Z', 'newer.md'),
    [path.join(TRASH_DIR, 'content', 'not-a-trashed-name.md'), 'body'],
  ]);

  it('parses each trashed name and sorts newest first', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/trash', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.files, [
      {
        trashPath: 'var/trash/content/sub/2026-02-02T10-45-30-456Z_newer.md',
        originalPath: 'content/sub/newer.md',
        originalName: 'newer.md',
        // The two replaces produce "HH:MM:SS:sssZ": a colon, not a dot, before
        // the milliseconds, so this is not a valid ISO 8601 timestamp.
        deletedAt: '2026-02-02T10:45:30:456Z',
      },
      {
        trashPath: 'var/trash/content/2026-01-01T09-30-15-123Z_older.md',
        originalPath: 'content/older.md',
        originalName: 'older.md',
        deletedAt: '2026-01-01T09:30:15:123Z',
      },
    ]);
  });

  it('returns an empty list when the trash directory is absent', async () => {
    const r = await invoke(routes, {path: '/api/trash', ctx: fsCtx({}).ctx});
    assert.deepEqual([r.status, r.payload], [200, {files: []}]);
  });

  it('returns identical results on a back-to-back request', async () => {
    const first = await invoke(routes, {path: '/api/trash', ctx: fsCtx(TREE).ctx});
    const second = await invoke(routes, {path: '/api/trash', ctx: fsCtx(TREE).ctx});
    assert.deepEqual(second.payload, first.payload);
  });

  const SEAMS = [
    {name: 'the first existsSync throws', fs: {existsSync() { throw new Error('boom'); }}},
    {name: 'readdirSync throws inside the walk', fs: {existsSync: () => true, readdirSync() { throw new Error('boom'); }}},
  ];
  for (const {name, fs} of SEAMS) {
    it(`returns 500 when ${name}`, async () => {
      const r = await invoke(routes, {path: '/api/trash', ctx: makeCtx({fs})});
      assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Failed to list trash'}, opts: undefined}]);
      assert.equal(r.replies.some(x => x.payload && 'files' in x.payload), false);
    });
  }
});

describe('POST /api/trash/restore', () => {
  const STAMP = '2026-01-01T09-30-15-123Z';
  const TRASHED = path.join(TRASH_DIR, 'content', `${STAMP}_note.md`);
  const REL = `var/trash/content/${STAMP}_note.md`;

  const GUARDS = [
    {name: 'a missing trashPath', body: {}, status: 400, error: 'Missing trashPath'},
    {name: 'a non-string trashPath', body: {trashPath: 7}, status: 400, error: 'Missing trashPath'},
    {name: 'a parent-traversal path', body: {trashPath: '../outside.md'}, status: 400, error: 'Invalid path'},
    {name: 'a path outside the trash root', body: {trashPath: 'content/note.md'}, status: 400, error: 'Path must be within var/trash/'},
    {name: 'an absent trashed file', body: {trashPath: 'var/trash/content/2026-01-01T09-30-15-123Z_gone.md'}, status: 404, error: 'Trashed file not found'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const {ctx} = fsCtx({[TRASHED]: 'body'});
      const r = await invoke(routes, {method: 'POST', path: '/api/trash/restore', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
    });
  }

  it('rejects a trashed name that does not match the timestamp pattern', async () => {
    const odd = path.join(TRASH_DIR, 'content', 'plain.md');
    const {ctx} = fsCtx({[odd]: 'body'});
    const r = await invoke(routes, {method: 'POST', path: '/api/trash/restore', body: {trashPath: 'var/trash/content/plain.md'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid trash file format'}]);
  });

  it('returns 409 when a file already exists at the original path', async () => {
    const {ctx} = fsCtx({[TRASHED]: 'body', [at('content/note.md')]: 'existing'});
    const r = await invoke(routes, {method: 'POST', path: '/api/trash/restore', body: {trashPath: REL}, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'A file already exists at the original path. Rename or delete it first.'}]);
  });

  it('restores the file and clears both the search and stats caches', async () => {
    const {ctx} = fsCtx({[TRASHED]: 'body'});
    const r = await invoke(routes, {method: 'POST', path: '/api/trash/restore', body: {trashPath: REL}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, restoredPath: 'content/note.md'}]);
    assert.equal(ctx.fs.existsSync(at('content/note.md')), true);
    // A restored file reappears in the tree and bumps the file count, the
    // inverse of a delete, so both caches are dropped.
    assert.deepEqual(ctx.calls.invalidateCache, ['search', 'stats']);
  });

  // The catch inspects the error: an Invalid JSON body is a 400, anything else
  // is a 500.
  for (const seam of ['mkdirSync', 'renameSync']) {
    it(`returns 500 when fs.${seam} throws`, async () => {
      const base = mockFs({[TRASHED]: 'body'});
      const fs = {...base, [seam]() { throw new Error(`${seam} failed`); }};
      const r = await invoke(routes, {method: 'POST', path: '/api/trash/restore', body: {trashPath: REL}, ctx: makeCtx({fs})});
      assert.deepEqual([r.status, r.payload], [500, {error: 'Restore failed'}]);
    });
  }

  it('returns 400 rather than 500 when the body is not valid JSON', async () => {
    const {ctx} = fsCtx({[TRASHED]: 'body'}, {readBody: async () => { throw new Error('Invalid JSON'); }});
    const r = await invoke(routes, {method: 'POST', path: '/api/trash/restore', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
  });
});

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
    {method: 'POST', path: '/api/trash/restore', key: 'trash-restore:', limit: 10},
    {method: 'POST', path: '/api/folder', key: 'create-folder:', limit: 20},
    {method: 'DELETE', path: '/api/folder', key: 'del-folder:', limit: 10},
    {method: 'POST', path: '/api/file/move', key: 'file-move:', limit: 20},
    {method: 'POST', path: '/api/export/bundle', key: 'export-bundle:', limit: 10},
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

describe('GET /api/file/info', () => {
  const DOC = fm({title: 'T', draft: 'true'}, 'Body with `x` and ```\ncode\n``` and $a+b$ and [@key] and ![alt](i.png)\n');

  it('reports size, word count, front matter, draft flag and content features', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: DOC});
    const r = await invoke(routes, {path: '/api/file/info', query: {path: 'content/a.md'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.path, 'content/a.md');
    assert.equal(r.payload.size, Buffer.byteLength(DOC));
    assert.equal(r.payload.hasFrontmatter, true);
    assert.equal(r.payload.draft, true);
    assert.equal(r.payload.hasCodeBlocks, true);
    assert.equal(r.payload.hasMath, true);
    assert.equal(r.payload.citationCount, 1);
    assert.equal(r.payload.imageCount, 1);
    assert.equal(typeof r.payload.mtime, 'string');
  });

  it('reports draft false when the front matter says anything but true', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: fm({draft: 'false'}, 'body')});
    const r = await invoke(routes, {path: '/api/file/info', query: {path: 'content/a.md'}, ctx});
    assert.equal(r.payload.draft, false);
  });

  // Language is decided by the CJK-to-Latin letter ratio: above 0.3 CJK is
  // chinese, above 0.7 Latin is english, anything else is mixed.
  const LANGUAGES = [
    {name: 'english', body: 'entirely latin prose here', want: 'english'},
    {name: 'chinese from the unified block', body: '这是一段中文内容', want: 'chinese'},
    {name: 'chinese from the extension A block', body: '\u3400\u3401\u3402\u3403', want: 'chinese'},
    {name: 'chinese from the compatibility block', body: '\uF900\uF901\uF902\uF903', want: 'chinese'},
    // Both comparisons are strict and the ratios sum to 1, so "mixed" is
    // reachable only at exactly 0.3 CJK / 0.7 Latin.
    {name: 'mixed at exactly the 0.3 / 0.7 split', body: '中文字 abcdefg', want: 'mixed'},
    {name: 'chinese once CJK passes 0.3', body: '中文 abc', want: 'chinese'},
    {name: 'mixed for a file with no letters at all', body: '12345 !!!', want: 'mixed'},
  ];
  for (const {name, body, want} of LANGUAGES) {
    it(`detects ${name}`, async () => {
      const {ctx} = fsCtx({[at('content/a.md')]: body});
      const r = await invoke(routes, {path: '/api/file/info', query: {path: 'content/a.md'}, ctx});
      assert.equal(r.payload.detectedLanguage, want);
    });
  }

  it('rejects an invalid path before any stat or read', async () => {
    const {ctx, counts} = fsCtx({[at('content/a.md')]: DOC});
    const r = await invoke(routes, {path: '/api/file/info', query: {path: '../escape.md'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
    assert.deepEqual([counts.stat, counts.read], [0, 0]);
  });

  it('returns 404 for a missing file and does not cache it', async () => {
    const {ctx, counts} = fsCtx({[at('content/a.md')]: DOC});
    const first = await invoke(routes, {path: '/api/file/info', query: {path: 'content/gone.md'}, ctx});
    assert.deepEqual([first.status, first.payload], [404, {error: 'File not found'}]);
    const afterFirst = counts.stat;
    await invoke(routes, {path: '/api/file/info', query: {path: 'content/gone.md'}, ctx});
    assert.ok(counts.stat > afterFirst, 'the error path stays outside the cache');
  });

  it('caches per path under "fileinfo:" with a 30000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx({[at('content/a.md')]: DOC, [at('content/b.md')]: 'other'}, {cached: (key, ttl, fn) => { seen ??= [key, ttl]; return fn(); }});
    await invoke(routes, {path: '/api/file/info', query: {path: 'content/a.md'}, ctx});
    assert.deepEqual(seen, ['fileinfo:content/a.md', 30000]);
  });

  it('serves a repeat request from cache and keys each path separately', async () => {
    const {ctx, counts} = fsCtx({[at('content/a.md')]: DOC, [at('content/b.md')]: 'other'});
    await invoke(routes, {path: '/api/file/info', query: {path: 'content/a.md'}, ctx});
    const afterFirst = counts.read;
    await invoke(routes, {path: '/api/file/info', query: {path: 'content/a.md'}, ctx});
    assert.equal(counts.read, afterFirst);
    await invoke(routes, {path: '/api/file/info', query: {path: 'content/b.md'}, ctx});
    assert.ok(counts.read > afterFirst);
  });

  it('returns byte-identical payloads on two cold requests', async () => {
    const mk = () => fsCtx({[at('content/a.md')]: DOC}).ctx;
    const first = await invoke(routes, {path: '/api/file/info', query: {path: 'content/a.md'}, ctx: mk()});
    const second = await invoke(routes, {path: '/api/file/info', query: {path: 'content/a.md'}, ctx: mk()});
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
  });
});

// ── Bundle export ─────────────────────────────────────────────────────────

describe('POST /api/export/bundle', () => {
  const TREE = {
    [at('content/one.md')]: fm({title: 'First & <Best>'}, '\nBody one.\n'),
    [at('content/two.md')]: 'Body two, no front matter.\n',
  };

  const GUARDS = [
    {name: 'an absent paths array', body: {}, error: 'Missing paths array'},
    {name: 'an empty paths array', body: {paths: []}, error: 'Missing paths array'},
    {name: 'a paths array over fifty entries', body: {paths: new Array(51).fill('content/one.md')}, error: 'paths exceeds maximum length of 50'},
    {name: 'a non-string element', body: {paths: ['content/one.md', 7]}, error: 'All paths must be strings'},
    {name: 'a non-string format', body: {paths: ['content/one.md'], format: 7}, error: 'format must be a string'},
    {name: 'an unsupported format', body: {paths: ['content/one.md'], format: 'pdf'}, error: 'format must be md or html'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const {ctx} = fsCtx(TREE);
      const r = await invoke(routes, {method: 'POST', path: '/api/export/bundle', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(r.written, null);
    });
  }

  it('renders markdown by default, joining sections with a rule', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/export/bundle', body: {paths: ['content/one.md', 'content/two.md']}, ctx});
    assert.equal(r.written.status, 200);
    assert.deepEqual(r.written.headers, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="bundle.md"',
      'Access-Control-Allow-Origin': '*',
    });
    assert.equal(r.written.body, '# First & <Best>\n\nBody one.\n\n---\n\n# two\n\nBody two, no front matter.');
  });

  it('renders html with the escape asymmetry the two branches apply', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {method: 'POST', path: '/api/export/bundle', body: {paths: ['content/one.md', 'content/two.md'], format: 'html'}, ctx});
    assert.equal(r.written.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(r.written.headers['Content-Disposition'], 'attachment; filename="bundle.html"');
    // The title escapes & and < but not >; the content escapes < and > but not &.
    assert.ok(r.written.body.includes('<h1>First &amp; &lt;Best></h1>'));
    assert.ok(r.written.body.includes('<hr>'), 'sections are joined by a rule');
  });

  it('skips an invalid or unreadable path without failing the bundle', async () => {
    const {ctx} = fsCtx(TREE);
    const paths = ['../escape.md', 'content/gone.md', 'content/two.md'];
    const r = await invoke(routes, {method: 'POST', path: '/api/export/bundle', body: {paths}, ctx});
    assert.equal(r.written.body, '# two\n\nBody two, no front matter.');
  });

  it('returns 400 from the outer catch when the body cannot be read', async () => {
    const {ctx} = fsCtx(TREE, {readBody: async () => { throw new Error('bad json'); }});
    const r = await invoke(routes, {method: 'POST', path: '/api/export/bundle', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Bundle export failed'}]);
  });
});

// ── Single-file export ────────────────────────────────────────────────────

describe('GET /api/file/export', () => {
  const MD = fm({title: 'My & <Doc>', authors: '[Ada Lovelace, Grace Hopper]'}, [
    '',
    '# Top heading',
    '## Second heading',
    '### Third heading',
    'Some **bold** and *italic* and `code` text.',
    '[a link](https://example.com)',
    '- one',
    '- two',
    '```js',
    'const x = 1 & 2 < 3;',
    '```',
  ].join('\n'));
  const TREE = {[at('content/doc.md')]: MD};

  const call = (query, files = TREE) => invoke(routes, {path: '/api/file/export', query, ctx: fsCtx(files).ctx});

  const REJECTED = [
    {name: 'an invalid path', query: {path: '../escape.md', format: 'md'}, error: 'Invalid path'},
    {name: 'an unknown format', query: {path: 'content/doc.md', format: 'docx'}, error: 'Invalid format. Must be md, html, pdf, latex, or slides'},
    {name: 'an omitted format', query: {path: 'content/doc.md'}, error: 'Invalid format. Must be md, html, pdf, latex, or slides'},
    // The path guard runs first, so it wins when both are invalid.
    {name: 'both invalid, reporting the path first', query: {path: '../escape.md', format: 'docx'}, error: 'Invalid path'},
  ];
  for (const {name, query, error} of REJECTED) {
    it(`rejects ${name} without writing a body`, async () => {
      const r = await call(query);
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(r.written, null);
    });
  }

  it('returns 404 for a missing file', async () => {
    const r = await call({path: 'content/gone.md', format: 'md'});
    assert.deepEqual([r.status, r.payload], [404, {error: 'File not found'}]);
  });

  it('md returns the raw content unchanged', async () => {
    const r = await call({path: 'content/doc.md', format: 'md'});
    assert.equal(r.written.body, MD, 'no render regex touches this path');
    assert.deepEqual(r.written.headers, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="doc.md"',
      'Access-Control-Allow-Origin': '*',
    });
  });

  const FORMATS = [
    {format: 'html', contentType: 'text/html; charset=utf-8', filename: 'doc.html'},
    {format: 'pdf', contentType: 'text/html; charset=utf-8', filename: 'doc-print.html'},
    {format: 'latex', contentType: 'text/plain; charset=utf-8', filename: 'doc.tex'},
    {format: 'slides', contentType: 'text/html; charset=utf-8', filename: 'doc-slides.html'},
  ];
  for (const {format, contentType, filename} of FORMATS) {
    it(`${format} sends the expected headers`, async () => {
      const r = await call({path: 'content/doc.md', format});
      assert.equal(r.written.status, 200);
      assert.equal(r.written.headers['Content-Type'], contentType);
      assert.equal(r.written.headers['Content-Disposition'], `attachment; filename="${filename}"`);
      assert.equal(r.written.headers['Access-Control-Allow-Origin'], '*');
    });

    it(`${format} renders identically on a back-to-back request`, async () => {
      const first = await call({path: 'content/doc.md', format});
      const second = await call({path: 'content/doc.md', format});
      assert.equal(second.written.body, first.written.body);
      assert.deepEqual(second.written.headers, first.written.headers);
    });
  }

  it('html renders every markdown construct and strips the front matter', async () => {
    const r = await call({path: 'content/doc.md', format: 'html'});
    const body = r.written.body;
    assert.ok(body.includes('<title>My &amp; &lt;Doc&gt;</title>'));
    assert.equal(body.includes('authors:'), false, 'the front-matter block is stripped');
    assert.ok(body.includes('<h1>Top heading</h1>'));
    assert.ok(body.includes('<h2>Second heading</h2>'));
    assert.ok(body.includes('<h3>Third heading</h3>'));
    assert.ok(body.includes('<strong>bold</strong>'));
    assert.ok(body.includes('<em>italic</em>'));
    assert.ok(body.includes('<code>code</code>'));
    assert.ok(body.includes('<a href="https://example.com">a link</a>'));
    assert.ok(body.includes('<li>one</li>\n<li>two</li>'));
    // Fenced code keeps its language class and escapes its contents.
    assert.ok(body.includes('<pre><code class="language-js">const x = 1 &amp; 2 &lt; 3;\n</code></pre>'));
  });

  it('pdf renders the print variant without a language class on the fence', async () => {
    const r = await call({path: 'content/doc.md', format: 'pdf'});
    assert.ok(r.written.body.includes('@page { size: A4; margin: 2cm; }'));
    assert.ok(r.written.body.includes('<pre><code>const x = 1 &amp; 2 &lt; 3;\n</code></pre>'));
    assert.ok(r.written.body.includes('<title>My &amp; &lt;Doc&gt;</title>'));
  });

  it('latex renders sections, authors and verbatim blocks with an escaped title', async () => {
    const r = await call({path: 'content/doc.md', format: 'latex'});
    const body = r.written.body;
    assert.ok(body.includes('\\section{Top heading}'));
    assert.ok(body.includes('\\subsection{Second heading}'));
    assert.ok(body.includes('\\subsubsection{Third heading}'));
    assert.ok(body.includes('\\textbf{bold}'));
    assert.ok(body.includes('\\textit{italic}'));
    assert.ok(body.includes('\\texttt{code}'));
    assert.ok(body.includes('\\href{https://example.com}{a link}'));
    assert.ok(body.includes('\\item one'));
    // The inline-code replace runs before the fenced-block replace, so a fenced
    // block is consumed by \texttt{...} and never reaches \begin{verbatim}.
    assert.ok(body.includes('``\\texttt{js\nconst x = 1 & 2 < 3;\n}``'));
    assert.equal(body.includes('\\begin{verbatim}'), false);
    assert.ok(body.includes('\\author{Ada Lovelace \\and Grace Hopper}'));
    // The LaTeX title escape covers & % $ # _ { } ~ ^ and backslash.
    assert.ok(body.includes('\\title{My \\& <Doc>}'));
  });

  it('latex omits the author line when the front matter has no authors', async () => {
    const files = {[at('content/doc.md')]: fm({title: 'Plain'}, '\ntext\n')};
    const r = await call({path: 'content/doc.md', format: 'latex'}, files);
    assert.equal(r.written.body.includes('\\author{'), false);
  });

  it('slides splits on level-two headings and adds a title slide', async () => {
    const files = {[at('content/doc.md')]: fm({title: 'Deck'}, '\nintro\n\n## One\n\n- a\n\n## Two\n\ntext\n')};
    const r = await call({path: 'content/doc.md', format: 'slides'}, files);
    const body = r.written.body;
    assert.ok(body.includes('<title>Deck</title>'));
    assert.ok(body.includes('id="slide-title"'));
    assert.ok(body.includes('<h2>One</h2>'));
    assert.ok(body.includes('<h2>Two</h2>'));
    assert.ok(body.includes('<ul><li>a</li>'));
    assert.equal([...body.matchAll(/class="slide" id="slide-\d+"/g)].length, 3, 'intro plus the two heading slides');
  });

  const TITLE_FALLBACKS = [
    {name: 'no front matter', content: '# Just a heading\n'},
    {name: 'front matter with no title line', content: fm({date: '2026-01-01'}, '\nbody\n')},
  ];
  for (const {name, content} of TITLE_FALLBACKS) {
    for (const format of ['html', 'pdf', 'latex', 'slides']) {
      it(`${format} falls back to the basename title with ${name}`, async () => {
        const r = await call({path: 'content/doc.md', format}, {[at('content/doc.md')]: content});
        assert.ok(r.written.body.includes(format === 'latex' ? '\\title{doc}' : '<title>doc</title>'));
      });
    }
  }
});

describe('export render regexes exported from the module', () => {
  const CANONICAL = {
    RENDER_CODE_BLOCK_RE: /```(\w*)\n([\s\S]*?)```/g,
    RENDER_H1_RE: /^# (.+)$/gm,
    RENDER_H2_RE: /^## (.+)$/gm,
    RENDER_H3_RE: /^### (.+)$/gm,
    RENDER_BOLD_RE: /\*\*(.+?)\*\*/g,
    RENDER_ITALIC_RE: /\*(.+?)\*/g,
    RENDER_INLINE_CODE_RE: /`([^`]+)`/g,
    RENDER_LINK_RE: /\[([^\]]+)\]\(([^)]+)\)/g,
    RENDER_LIST_RE: /(^- .+$(\n- .+$)*)/gm,
    RENDER_LIST_ITEM_RE: /^- (.+)$/gm,
    RENDER_PARA_RE: /^(?!<[a-z/])((?!\s*$).+)$/gm,
    RENDER_BLANK_LINES_RE: /\n{3,}/g,
    SLIDES_H2_RE: /^## (.+)$/m,
  };
  for (const [name, canonical] of Object.entries(CANONICAL)) {
    it(`${name} matches its canonical literal and is one shared instance`, () => {
      const re = routes[name];
      assert.equal(re.source, canonical.source, name);
      assert.equal(re.flags, canonical.flags, name);
      assert.strictEqual(loadRoute('graph-trash-files')[name], re, name);
    });
  }

  // SLIDES_H2_RE and RENDER_H2_RE share a source but differ in flags: the
  // slides branch needs a single replacement per slide, so merging them would
  // turn one replacement into a global one and change the rendered output.
  it('keeps the slides heading pattern non-global and distinct from RENDER_H2_RE', () => {
    assert.equal(routes.SLIDES_H2_RE.source, routes.RENDER_H2_RE.source);
    assert.equal(routes.SLIDES_H2_RE.global, false);
    assert.equal(routes.RENDER_H2_RE.global, true);
    assert.notStrictEqual(routes.SLIDES_H2_RE, routes.RENDER_H2_RE);
  });
});

// Three handlers open their try around the body read; two of them inspect the
// error to separate an unparseable body from a genuine failure.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/folder', error: 'Invalid request'},
    {method: 'POST', path: '/api/file/move', error: 'Invalid request'},
    {method: 'POST', path: '/api/export/bundle', error: 'Bundle export failed'},
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
