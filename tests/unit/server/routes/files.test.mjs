/**
 * server/routes/files.js: file read/write/create/delete/rename, listing,
 * search, content stats, image upload, and git history.
 *
 * Consolidated from the eleven per-branch suites that used to cover this
 * module. Each case drives the real handler through the shared harness, so no
 * server boots and no real file is touched.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, PROJECT_ROOT} from '../../_harness.mjs';

const routes = loadRoute('files');
const at = rel => path.join(PROJECT_ROOT, rel);

/** An fs whose every method counts the call and throws, proving a branch reaches no IO. */
function tripwireFs() {
  const calls = {n: 0, names: []};
  const fs = new Proxy({}, {
    get: (_t, prop) => () => {
      calls.n++;
      calls.names.push(String(prop));
      throw new Error(`fs.${String(prop)} must not run on this path`);
    },
  });
  return {fs, calls};
}

/** An fs whose existsSync answers a predicate and whose mutations only count. */
function countingFs(existsSync, throwOn = null) {
  const calls = {existsSync: 0, mkdirSync: 0, writeFileSync: 0, renameSync: 0};
  const args = {};
  const step = name => (...a) => {
    calls[name]++;
    args[name] = a;
    if (throwOn === name) throw new Error(`${name} failed`);
  };
  return {
    calls,
    args,
    fs: {
      existsSync(p) { calls.existsSync++; return existsSync(p); },
      mkdirSync: step('mkdirSync'),
      writeFileSync: step('writeFileSync'),
      renameSync: step('renameSync'),
    },
  };
}

describe('GET /api/file (read)', () => {
  it('rejects an invalid path without reading', async () => {
    const {fs, calls} = tripwireFs();
    const r = await invoke(routes, {path: '/api/file', query: {path: '../bad'}, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
    assert.equal(calls.n, 0);
  });

  it('returns the content, read as utf-8 from the path joined under PROJECT_ROOT', async () => {
    let read;
    const fs = {readFileSync: (p, enc) => { read = [p, enc]; return 'file body text'; }};
    const r = await invoke(routes, {path: '/api/file', query: {path: 'content/ok.md'}, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [200, {content: 'file body text'}]);
    assert.deepEqual(read, [at('content/ok.md'), 'utf-8']);
  });

  it('returns 404 when the read throws', async () => {
    const fs = {readFileSync() { throw new Error('ENOENT'); }};
    const r = await invoke(routes, {path: '/api/file', query: {path: 'content/missing.md'}, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'File not found'}]);
  });
});

describe('GET /api/files (list)', () => {
  it('rejects an invalid directory without walking', async () => {
    let walks = 0;
    const ctx = makeCtx({isValidDir: () => false, walkDir: () => { walks++; return []; }});
    const r = await invoke(routes, {path: '/api/files', query: {dir: '../bad'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid directory'}]);
    assert.equal(walks, 0);
  });

  it('walks the directory joined under PROJECT_ROOT and returns the list', async () => {
    let walkArg;
    const files = [{name: 'a.md', path: 'content/a.md'}, {name: 'b.md', path: 'content/b.md'}];
    const ctx = makeCtx({isValidDir: () => true, walkDir: p => { walkArg = p; return files; }});
    const r = await invoke(routes, {path: '/api/files', query: {dir: 'content'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {files}]);
    assert.equal(walkArg, at('content'));
  });

  it('returns an empty list for an empty directory', async () => {
    const ctx = makeCtx({isValidDir: () => true, walkDir: () => []});
    const r = await invoke(routes, {path: '/api/files', query: {dir: 'content'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {files: []}]);
  });

  it('returns 404 when the walk throws', async () => {
    const ctx = makeCtx({isValidDir: () => true, walkDir() { throw new Error('ENOENT'); }});
    const r = await invoke(routes, {path: '/api/files', query: {dir: 'content'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Directory not found'}]);
  });
});

// The three mutation handlers open with a per-route rate-limit gate as their
// first statement, before any body read, query parse, validation or IO.
describe('rate-limit gates on /api/file', () => {
  const GATES = [
    {method: 'POST', key: 'file-create:', limit: 30},
    {method: 'DELETE', key: 'file-delete:', limit: 30},
    {method: 'PUT', key: 'file-write:', limit: 60},
  ];
  for (const {method, key, limit} of GATES) {
    it(`${method} returns 429 with key "${key}" and limit ${limit}, before any body read or IO`, async () => {
      const {fs, calls} = tripwireFs();
      let bodyReads = 0;
      const ctx = makeCtx({
        fs,
        rateLimitAllow: false,
        readBody: async () => { bodyReads++; throw new Error('readBody reached past the gate'); },
        isValidFilePath() { throw new Error('isValidFilePath reached past the gate'); },
        invalidateCache() { throw new Error('invalidateCache reached past the gate'); },
      });
      const r = await invoke(routes, {method, path: '/api/file', ctx});
      assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
      assert.deepEqual(ctx.calls.rateLimit, [{key: key + '127.0.0.1', maxPerMinute: limit}]);
      assert.equal(bodyReads, 0);
      assert.equal(calls.n, 0);
    });
  }
});

// PUT and POST share the same body contract and the same three content guards,
// differing only in the existence branch and the outer-catch wording.
describe('PUT and POST /api/file body guards', () => {
  const SHARED = [
    {name: 'invalid path', body: {path: '../bad', content: 'x'}, status: 400, error: 'Invalid path'},
    {name: 'non-string content', body: {path: 'content/ok.md', content: 123}, status: 400, error: 'Content must be a string'},
    {name: 'content over 50000 chars', body: {path: 'content/ok.md', content: 'a'.repeat(50001)}, status: 400, error: 'Content must be 50000 characters or fewer'},
  ];
  for (const method of ['PUT', 'POST']) {
    for (const {name, body, status, error} of SHARED) {
      it(`${method} rejects ${name} without writing`, async () => {
        const {fs, calls} = countingFs(() => method === 'PUT');
        const r = await invoke(routes, {method, path: '/api/file', body, ctx: makeCtx({fs})});
        assert.deepEqual([r.status, r.payload], [status, {error}]);
        assert.equal(calls.writeFileSync, 0);
      });
    }
  }

  it('accepts exactly 50000 characters, clearing the length guard', async () => {
    // Exactly 50000 clears `length > 50000`, so PUT proceeds to the existence
    // check; existsSync false surfaces as the 404, proving the boundary passed.
    const {fs, calls} = countingFs(() => false);
    const body = {path: 'content/ok.md', content: 'a'.repeat(50000)};
    const r = await invoke(routes, {method: 'PUT', path: '/api/file', body, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'File not found'}]);
    assert.equal(calls.writeFileSync, 0);
  });
});

describe('PUT /api/file (write)', () => {
  it('returns 404 when the target does not exist and never writes', async () => {
    const {fs, calls} = countingFs(() => false);
    const body = {path: 'content/missing.md', content: 'hello'};
    const r = await invoke(routes, {method: 'PUT', path: '/api/file', body, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'File not found'}]);
    assert.equal(calls.writeFileSync, 0);
  });

  it('writes once and invalidates only the search cache', async () => {
    const {fs, calls, args} = countingFs(() => true);
    const ctx = makeCtx({fs});
    const body = {path: 'content/ok.md', content: 'new body text'};
    const r = await invoke(routes, {method: 'PUT', path: '/api/file', body, ctx});
    // No `path` field, unlike the POST create reply.
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.equal(calls.writeFileSync, 1);
    assert.deepEqual(args.writeFileSync, [at('content/ok.md'), 'new body text', 'utf-8']);
    assert.deepEqual(ctx.calls.invalidateCache, ['search']);
  });
});

describe('POST /api/file (create)', () => {
  it('returns 409 when the target already exists and never writes', async () => {
    const {fs, calls} = countingFs(() => true);
    const body = {path: 'content/exists.md', content: 'x'};
    const r = await invoke(routes, {method: 'POST', path: '/api/file', body, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [409, {error: 'File already exists'}]);
    assert.equal(calls.writeFileSync, 0);
  });

  it('creates the file and invalidates both the stats and search caches', async () => {
    const {fs, calls} = countingFs(() => false);
    const ctx = makeCtx({fs});
    const body = {path: 'content/new.md', content: 'hello'};
    const r = await invoke(routes, {method: 'POST', path: '/api/file', body, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, path: 'content/new.md'}]);
    assert.equal(calls.writeFileSync, 1);
    assert.deepEqual(ctx.calls.invalidateCache, ['stats', 'search']);
  });
});

describe('DELETE /api/file (move to trash)', () => {
  it('rejects an invalid path', async () => {
    const {fs, calls} = countingFs(() => true);
    const r = await invoke(routes, {method: 'DELETE', path: '/api/file', query: {path: '../bad'}, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 404 when the file is missing, attempting no move', async () => {
    const {fs, calls} = countingFs(() => false);
    const ctx = makeCtx({fs});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/file', query: {path: 'content/missing.md'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'File not found'}]);
    assert.deepEqual([calls.mkdirSync, calls.renameSync], [0, 0]);
    assert.deepEqual(ctx.calls.invalidateCache, []);
  });

  it('moves the file to trash and invalidates the search cache', async () => {
    const {fs, calls} = countingFs(() => true);
    const ctx = makeCtx({fs});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/file', query: {path: 'content/old.md'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.success, true);
    assert.match(r.payload.trashPath, /^var\/trash\/content\/.*_old\.md$/);
    assert.equal(calls.renameSync, 1);
    assert.deepEqual(ctx.calls.invalidateCache, ['search']);
  });

  // The catch has no error binding, so both mutation seams yield one fixed body
  // with no err.message leak, and the success projection never fires.
  const TRASH_500 = {error: 'Failed to move file to trash: the file may be locked or the trash directory is not writable'};
  for (const seam of ['mkdirSync', 'renameSync']) {
    it(`returns the same 500 when fs.${seam} throws`, async () => {
      const {fs, calls} = countingFs(() => true, seam);
      const ctx = makeCtx({fs});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/file', query: {path: 'content/note.md'}, ctx});
      assert.deepEqual(r.replies, [{status: 500, payload: TRASH_500, opts: undefined}]);
      assert.equal(calls.renameSync, seam === 'mkdirSync' ? 0 : 1);
      assert.deepEqual(ctx.calls.invalidateCache, []);
    });
  }
});

describe('POST /api/file/rename', () => {
  it('rejects an invalid path', async () => {
    const {fs, calls} = countingFs(() => true);
    const body = {oldPath: '../bad', newPath: 'content/new.md'};
    const r = await invoke(routes, {method: 'POST', path: '/api/file/rename', body, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 404 when the source is missing', async () => {
    const {fs, calls} = countingFs(() => false);
    const body = {oldPath: 'content/old.md', newPath: 'content/new.md'};
    const r = await invoke(routes, {method: 'POST', path: '/api/file/rename', body, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Source not found'}]);
    assert.equal(calls.renameSync, 0);
  });

  it('returns 409 when the target already exists', async () => {
    const {fs, calls} = countingFs(() => true);
    const body = {oldPath: 'content/old.md', newPath: 'content/new.md'};
    const r = await invoke(routes, {method: 'POST', path: '/api/file/rename', body, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Target already exists'}]);
    assert.equal(calls.renameSync, 0);
  });

  it('renames and invalidates the search cache', async () => {
    const {fs, calls} = countingFs(p => p === at('content/old.md'));
    const ctx = makeCtx({fs});
    const body = {oldPath: 'content/old.md', newPath: 'content/new.md'};
    const r = await invoke(routes, {method: 'POST', path: '/api/file/rename', body, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, path: 'content/new.md'}]);
    assert.equal(calls.renameSync, 1);
    assert.deepEqual(ctx.calls.invalidateCache, ['search']);
  });
});

// Each of the three body-reading handlers wraps `await readBody(req)` and the
// destructure of its result in one try, whose catch returns a fixed 400 built
// before any IO. A rejecting readBody and a null body drive that catch two
// independent ways; the null case also pins precedence, since destructuring
// null throws before the inner Invalid path guard can run.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/file', error: 'Failed to create file: request body must be JSON with "path" (string) and "content" (string) fields'},
    {method: 'PUT', path: '/api/file', error: 'Failed to update file: request body must be JSON with "path" (string) and "content" (string) fields'},
    {method: 'POST', path: '/api/file/rename', error: 'Failed to rename file: request body must be JSON with "oldPath" (string) and "newPath" (string) fields'},
  ];
  for (const {method, path: p, error} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns its fixed 400 when ${label}, before any fs IO`, async () => {
        const {fs, calls} = tripwireFs();
        const r = await invoke(routes, {method, path: p, ctx: makeCtx({fs, readBody})});
        assert.deepEqual([r.status, r.payload], [400, {error}]);
        assert.equal(calls.n, 0);
      });
    }
  }
});

describe('GET /api/files/search', () => {
  // alpha carries a front-matter title; beta has none, so its title falls back
  // to the filename minus extension. beta's later `---` fence is not
  // front-matter, which pins the FRONTMATTER_RE `^` anchor: a regex matching a
  // fence anywhere would wrongly surface "Not The Real Title".
  const FILES = [
    {name: 'alpha-note.md', path: 'content/alpha-note.md'},
    {name: 'beta-note.md', path: 'content/beta-note.md'},
    {name: 'gamma-doc.md', path: 'content/sub/gamma-doc.md'},
  ];
  const CONTENTS = {
    [at('content/alpha-note.md')]: '---\ntitle: Alpha Title\n---\n\nBody text for alpha.\n',
    [at('content/beta-note.md')]: 'Intro paragraph.\n---\ntitle: Not The Real Title\n---\nMore body.\n',
    [at('content/sub/gamma-doc.md')]: '---\ntitle: Gamma Title\n---\n\nBody text for gamma.\n',
  };

  function searchCtx(over = {}) {
    const counts = {flatFiles: 0};
    const ctx = makeCtx({
      flatFiles: () => { counts.flatFiles++; return FILES; },
      fs: mockFs(CONTENTS),
      ...over,
    });
    return {ctx, counts};
  }

  it('surfaces the front-matter title, falling back to the filename', async () => {
    const {ctx} = searchCtx();
    const r = await invoke(routes, {path: '/api/files/search', query: {q: 'note'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      files: [
        {name: 'alpha-note.md', path: 'content/alpha-note.md', title: 'Alpha Title'},
        {name: 'beta-note.md', path: 'content/beta-note.md', title: 'beta-note'},
      ],
    });
  });

  it('walks once and serves a different query from the cached list', async () => {
    const {ctx, counts} = searchCtx();
    await invoke(routes, {path: '/api/files/search', query: {q: 'note'}, ctx});
    assert.equal(counts.flatFiles, 1);
    const second = await invoke(routes, {path: '/api/files/search', query: {q: 'gamma'}, ctx});
    assert.equal(counts.flatFiles, 1, 'the repeat search reuses the cached list');
    assert.deepEqual(second.replies.at(-1).payload.files, [
      {name: 'gamma-doc.md', path: 'content/sub/gamma-doc.md', title: 'Gamma Title'},
    ]);
    assert.deepEqual(ctx.calls.cached, ['search:list', 'search:list']);
  });

  it('returns the full cached list verbatim for an empty query', async () => {
    const {ctx, counts} = searchCtx();
    const r = await invoke(routes, {path: '/api/files/search', query: {q: ''}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {files: FILES}]);
    assert.equal(counts.flatFiles, 1);
  });

  it('passes the cache key "search:list" with a 30000 ms TTL', async () => {
    let seen;
    const {ctx} = searchCtx({cached: (key, ttl, fn) => { seen = [key, ttl]; return fn(); }});
    await invoke(routes, {path: '/api/files/search', query: {q: 'note'}, ctx});
    assert.deepEqual(seen, ['search:list', 30000]);
  });

  it('returns 500 and caches nothing when the walk throws', async () => {
    // cached() runs fn before it stores, so a throwing walk leaves the key
    // unset and the next search retries rather than serving an error.
    const {ctx} = searchCtx({flatFiles() { throw new Error('ENOENT'); }});
    const r = await invoke(routes, {path: '/api/files/search', query: {q: 'note'}, ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Search failed'}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });

  it('exports SEARCH_TITLE_RE as one shared, stateless instance', async () => {
    const {SEARCH_TITLE_RE} = routes;
    const CANONICAL = /^title:\s*["']?(.+?)["']?\s*$/m;
    assert.ok(SEARCH_TITLE_RE instanceof RegExp);
    assert.equal(SEARCH_TITLE_RE.source, CANONICAL.source);
    assert.equal(SEARCH_TITLE_RE.flags, 'm');
    // No /g and no /y, so it carries no lastIndex between requests.
    assert.equal(SEARCH_TITLE_RE.global, false);
    assert.equal(SEARCH_TITLE_RE.sticky, false);
    assert.strictEqual(loadRoute('files').SEARCH_TITLE_RE, SEARCH_TITLE_RE);

    // The module-scope regexes therefore give identical back-to-back results.
    const first = await invoke(routes, {path: '/api/files/search', query: {q: 'note'}, ctx: searchCtx().ctx});
    const second = await invoke(routes, {path: '/api/files/search', query: {q: 'note'}, ctx: searchCtx().ctx});
    assert.deepEqual(second.payload, first.payload);
  });
});

describe('GET /api/stats', () => {
  it('memoizes the scan under "content-stats" and sends a 30 s cacheControl', async () => {
    const STATS = {totalFiles: 7, totalWords: 1234, references: 5, byDirectory: {}};
    const ctx = makeCtx({cached: () => STATS});
    const r = await invoke(routes, {path: '/api/stats', ctx});
    assert.deepEqual(r.replies, [{status: 200, payload: STATS, opts: {cacheControl: 'public, max-age=30'}}]);
  });

  // The whole scan runs inside one try whose first failable step is the memo
  // call, so a throw from the memo layer and a throw from inside the closure
  // both land in the same catch.
  const SUCCESS_KEYS = ['totalFiles', 'totalWords', 'references', 'byDirectory'];
  const SEAMS = [
    {
      name: 'the cached() memo call itself throws (the closure never runs)',
      over: {cached() { throw new Error('cache layer unavailable'); }, fs: {readdirSync() { throw new Error('unreached'); }}},
      walked: false,
    },
    {
      name: 'the scan closure throws on its first readdirSync',
      over: {cached: (_k, _t, fn) => fn(), fs: {readdirSync() { throw new Error('content dir unreadable'); }}},
      walked: true,
    },
  ];
  for (const {name, over, walked} of SEAMS) {
    it(`returns 500 Stats failed when ${name}`, async () => {
      let readdirCalls = 0;
      const fs = {readdirSync: (...a) => { readdirCalls++; return over.fs.readdirSync(...a); }, readFileSync: () => ''};
      const ctx = makeCtx({...over, fs});
      const r = await invoke(routes, {path: '/api/stats', ctx});
      assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Stats failed'}, opts: undefined}]);
      assert.equal(readdirCalls > 0, walked);
      for (const key of SUCCESS_KEYS) {
        assert.equal(r.replies.some(x => x.payload && key in x.payload), false, `no reply carries "${key}"`);
      }
    });
  }
});

describe('POST /api/upload', () => {
  it('writes the image and invalidates the search cache', async () => {
    const {fs} = countingFs(() => false);
    const ctx = makeCtx({fs});
    const r = await invoke(routes, {method: 'POST', path: '/api/upload', query: {name: 'pic.png'}, body: 'bytes', ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.url, '/img/uploads/pic.png');
    assert.deepEqual(ctx.calls.invalidateCache, ['search']);
  });

  const REJECTS = [
    {name: 'a missing file name', query: {}, error: 'Missing file name'},
    {name: 'a non-image extension', query: {name: 'notes.md'}, error: 'Invalid image type'},
    {name: 'a directory escaping the root', query: {name: 'pic.png', dir: '../outside'}, error: 'Invalid directory'},
  ];
  for (const {name, query, error} of REJECTS) {
    it(`rejects ${name}`, async () => {
      const {fs, calls} = countingFs(() => false);
      const r = await invoke(routes, {method: 'POST', path: '/api/upload', query, body: 'bytes', ctx: makeCtx({fs})});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(calls.writeFileSync, 0);
    });
  }
});

describe('GET /api/history', () => {
  // The handler asks git for unit-separator delimited fields and splits on the
  // same byte, so the canned log uses it too.
  const SEP = '\x1f';
  const RAW_LOG =
    `abc1234${SEP}Ada Lovelace${SEP}2026-01-01 09:00:00 +0000${SEP}First commit\n` +
    '\n' +
    `def5678${SEP}Grace Hopper${SEP}2026-01-02 10:30:00 +0000${SEP}Fix${SEP}rejoined subject\n` +
    `bad99${SEP}too${SEP}few\n`;

  it('parses commits in order, skipping blank and short rows and rejoining a separator in the subject', async () => {
    let gitArgs;
    const ctx = makeCtx({execFileSync: (cmd, args) => { gitArgs = args; return RAW_LOG; }});
    const r = await invoke(routes, {path: '/api/history', query: {path: 'content/post.md'}, ctx});
    assert.equal(r.status, 200);
    assert.ok(gitArgs.includes(`--format=%h${SEP}%an${SEP}%ai${SEP}%s`));
    assert.deepEqual(r.payload.commits, [
      {hash: 'abc1234', author: 'Ada Lovelace', date: '2026-01-01 09:00:00 +0000', message: 'First commit'},
      {hash: 'def5678', author: 'Grace Hopper', date: '2026-01-02 10:30:00 +0000', message: `Fix${SEP}rejoined subject`},
    ]);
  });

  it('returns an empty list when git fails', async () => {
    const ctx = makeCtx({execFileSync() { throw new Error('git unavailable'); }});
    const r = await invoke(routes, {path: '/api/history', query: {path: 'content/post.md'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {commits: []}]);
  });
});

describe('GET /api/history/diff', () => {
  const GUARD = 'Missing or invalid query parameters: "path" must be a valid file path and "hash" must be a 4-40 character hex string';

  function diffCtx(over = {}) {
    const calls = {exec: 0, args: null};
    const ctx = makeCtx({
      execFileSync: (cmd, args, opts) => { calls.exec++; calls.args = args; calls.opts = opts; return 'patch text\n'; },
      ...over,
    });
    return {ctx, calls};
  }

  const REJECTED = [
    {name: 'an invalid path', query: {path: 'content/post.md', hash: 'abc1234'}, over: {isValidFilePath: () => false}},
    {name: 'a missing hash', query: {path: 'content/post.md'}},
    ...['abc', 'xyzxyz', 'gggggggg', 'a'.repeat(41)].map(hash => ({
      name: `the non-hex or out-of-range hash ${JSON.stringify(hash)}`,
      query: {path: 'content/post.md', hash},
    })),
  ];
  for (const {name, query, over} of REJECTED) {
    it(`returns 400 before running git for ${name}`, async () => {
      const {ctx, calls} = diffCtx(over);
      const r = await invoke(routes, {path: '/api/history/diff', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: GUARD}]);
      assert.equal(calls.exec, 0);
    });
  }

  // The hex check is case-insensitive and spans 4 to 40 characters.
  for (const hash of ['abcd', 'a'.repeat(40), 'ABCDEF']) {
    it(`accepts the boundary-valid hash ${JSON.stringify(hash)}`, async () => {
      const {ctx, calls} = diffCtx();
      const r = await invoke(routes, {path: '/api/history/diff', query: {path: 'content/post.md', hash}, ctx});
      assert.equal(r.status, 200);
      assert.equal(calls.exec, 1);
      assert.deepEqual(calls.args, ['diff', `${hash}~1..${hash}`, '--', 'content/post.md']);
    });
  }

  it('returns the diff text with the expected git invocation', async () => {
    const {ctx, calls} = diffCtx();
    const r = await invoke(routes, {path: '/api/history/diff', query: {path: 'content/post.md', hash: 'abc1234'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {diff: 'patch text\n'}]);
    assert.deepEqual(calls.opts, {cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000});
  });

  it('returns 200 with an empty diff when git throws', async () => {
    const {ctx, calls} = diffCtx({execFileSync() { throw new Error('git unavailable'); }});
    const r = await invoke(routes, {path: '/api/history/diff', query: {path: 'content/post.md', hash: 'abc1234'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {diff: ''}]);
    assert.equal(calls.exec, 0, 'the counting wrapper is replaced by the throwing stub');
  });
});
