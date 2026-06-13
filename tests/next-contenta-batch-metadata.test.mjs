import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the REAL route module the way the
// sibling suites do (next-health-history-guards, next-files-merge-guards) and
// reuse their mocked-ctx shape. These tests pin the CURRENT behavior of the
// POST /api/files/batch-metadata handler, which is otherwise uncovered. Every
// case runs through a mocked ctx (rateLimit, readBody, isValidFilePath, fs,
// invalidateCache, json recorder), so no real filesystem, network, clock, or
// randomness is ever touched. Rejected paths assert that no file is written and
// no cache is invalidated; success paths assert the exact rebuilt file content
// plus the two cache invalidations.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';

// Drive POST /api/files/batch-metadata through a fully mocked ctx and return the
// captured json(res, status, payload) response plus every recorded side effect:
// the writes (path + content), the invalidateCache keys, the rateLimit calls,
// and how many times readBody ran. `files` maps a content-relative path to the
// string fs.readFileSync should return for it; a valid path absent from `files`
// makes readFileSync throw, mirroring a missing file (the handler turns that into
// a per-file 'Update failed'). `failWriteFor` lists paths whose writeFileSync
// throws, exercising the write side of 'Update failed'. Defaults: rateLimit
// allows the request, readBody resolves to `body`, isValidFilePath accepts every
// path.
async function invokeBatch({
  body,
  readBodyThrows = false,
  rateLimit,
  isValidFilePath = () => true,
  files = {},
  failWriteFor = [],
} = {}) {
  const pathname = '/api/files/batch-metadata';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };

  const fullFiles = {};
  for (const [rel, content] of Object.entries(files)) fullFiles[path.join(PROJECT_ROOT, rel)] = content;
  const failWriteFull = new Set(failWriteFor.map((rel) => path.join(PROJECT_ROOT, rel)));

  let captured = null;
  const writes = [];
  const reads = [];
  const invalidateCalls = [];
  const rateLimitCalls = [];
  let readBodyCalls = 0;
  const allow = rateLimit || (() => true);

  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit: (key, limit) => {
      rateLimitCalls.push({ key, limit });
      return allow(key, limit);
    },
    readBody: async () => {
      readBodyCalls++;
      if (readBodyThrows) throw new Error('bad body');
      return body;
    },
    isValidFilePath,
    fs: {
      readFileSync: (p) => {
        reads.push(p);
        if (Object.prototype.hasOwnProperty.call(fullFiles, p)) return fullFiles[p];
        throw new Error('ENOENT: ' + p);
      },
      writeFileSync: (p, content) => {
        if (failWriteFull.has(p)) throw new Error('EACCES: ' + p);
        writes.push({ path: p, content });
      },
    },
    invalidateCache: (key) => { invalidateCalls.push(key); },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };

  await routes(req, res, url, pathname, ctx);
  return { captured, writes, reads, invalidateCalls, rateLimitCalls, readBodyCalls };
}

// Shared assertion: a rejected request writes nothing and invalidates no cache.
function assertNoEffect({ writes, invalidateCalls }) {
  assert.equal(writes.length, 0, 'a rejected batch update never writes a file');
  assert.equal(invalidateCalls.length, 0, 'a rejected batch update never invalidates the cache');
}

describe('POST /api/files/batch-metadata validation guards (no write, no invalidate on any rejected path)', () => {
  it('returns 429 when rate-limited, and never reads the body or writes', async () => {
    const result = await invokeBatch({ body: { paths: ['content/a.md'] }, rateLimit: () => false });
    assert.equal(result.captured.status, 429);
    assert.deepEqual(result.captured.payload, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(result.readBodyCalls, 0, 'the body is never read on the throttled path');
    assertNoEffect(result);
  });

  it('returns 400 when paths is missing', async () => {
    const result = await invokeBatch({ body: {} });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing paths array' });
    assertNoEffect(result);
  });

  it('returns 400 when paths is an empty array', async () => {
    const result = await invokeBatch({ body: { paths: [] } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing paths array' });
    assertNoEffect(result);
  });

  it('returns 400 when addTags is not an array of strings', async () => {
    const result = await invokeBatch({ body: { paths: ['content/a.md'], addTags: ['ok', 5] } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'addTags must be an array of strings' });
    assertNoEffect(result);
  });

  it('returns 400 when removeTags is not an array of strings', async () => {
    const result = await invokeBatch({ body: { paths: ['content/a.md'], removeTags: 'nope' } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'removeTags must be an array of strings' });
    assertNoEffect(result);
  });

  it('returns 400 when an addTag exceeds 100 characters', async () => {
    const result = await invokeBatch({ body: { paths: ['content/a.md'], addTags: ['x'.repeat(101)] } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Tag names must be 100 characters or fewer' });
    assertNoEffect(result);
  });

  it('returns 400 when a removeTag exceeds 100 characters', async () => {
    const result = await invokeBatch({ body: { paths: ['content/a.md'], removeTags: ['y'.repeat(101)] } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Tag names must be 100 characters or fewer' });
    assertNoEffect(result);
  });

  it('returns 400 when setDraft is not a boolean', async () => {
    const result = await invokeBatch({ body: { paths: ['content/a.md'], setDraft: 'yes' } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'setDraft must be a boolean' });
    assertNoEffect(result);
  });

  it('returns 400 when readBody throws', async () => {
    const result = await invokeBatch({ readBodyThrows: true });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Invalid request' });
    assertNoEffect(result);
  });
});

describe('POST /api/files/batch-metadata success paths (rebuilds the file and invalidates search + tags)', () => {
  it('merges addTags into an existing tags line, de-duplicating, and pins the rate-limit key', async () => {
    const files = { 'content/post.md': '---\ntitle: Hello World\ntags: [a, b]\n---\nBody paragraph.\n' };
    const result = await invokeBatch({ body: { paths: ['content/post.md'], addTags: ['b', 'c'] }, files });
    assert.equal(result.captured.status, 200);
    assert.equal(result.captured.payload.success, true);
    assert.equal(result.captured.payload.updated, 1);
    assert.equal(result.captured.payload.errors, undefined);
    assert.equal(result.writes.length, 1);
    assert.equal(result.writes[0].path, path.join(PROJECT_ROOT, 'content/post.md'));
    assert.equal(result.writes[0].content, '---\ntitle: Hello World\ntags: [a, b, c]\n---\nBody paragraph.\n');
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
    assert.deepEqual(result.rateLimitCalls, [{ key: 'batch-meta:127.0.0.1', limit: 5 }]);
  });

  it('appends a new tags line when the frontmatter has none', async () => {
    const files = { 'content/notags.md': '---\ntitle: Solo\n---\nContent line.\n' };
    const result = await invokeBatch({ body: { paths: ['content/notags.md'], addTags: ['x', 'y'] }, files });
    assert.equal(result.captured.status, 200);
    assert.equal(result.captured.payload.updated, 1);
    assert.equal(result.writes[0].content, '---\ntitle: Solo\ntags: [x, y]\n---\nContent line.\n');
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
  });

  it('filters removeTags out of an existing tags line', async () => {
    const files = { 'content/rm.md': '---\ntitle: Rm\ntags: [keep, drop, stay]\n---\nB.\n' };
    const result = await invokeBatch({ body: { paths: ['content/rm.md'], removeTags: ['drop'] }, files });
    assert.equal(result.captured.status, 200);
    assert.equal(result.captured.payload.updated, 1);
    assert.equal(result.writes[0].content, '---\ntitle: Rm\ntags: [keep, stay]\n---\nB.\n');
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
  });

  it('rewrites an existing draft line when setDraft toggles it', async () => {
    const files = { 'content/draft.md': '---\ntitle: D\ndraft: true\n---\nB.\n' };
    const result = await invokeBatch({ body: { paths: ['content/draft.md'], setDraft: false }, files });
    assert.equal(result.captured.status, 200);
    assert.equal(result.captured.payload.updated, 1);
    assert.equal(result.writes[0].content, '---\ntitle: D\ndraft: false\n---\nB.\n');
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
  });

  it('appends a draft line when setDraft is set and none exists', async () => {
    const files = { 'content/nodraft.md': '---\ntitle: N\n---\nB.\n' };
    const result = await invokeBatch({ body: { paths: ['content/nodraft.md'], setDraft: true }, files });
    assert.equal(result.captured.status, 200);
    assert.equal(result.captured.payload.updated, 1);
    assert.equal(result.writes[0].content, '---\ntitle: N\ndraft: true\n---\nB.\n');
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
  });
});

describe('POST /api/files/batch-metadata per-file aggregation and the slice(0, 50) cap', () => {
  it('aggregates per-file errors (invalid path, missing frontmatter) alongside one update', async () => {
    const files = {
      'content/nofm.md': 'no frontmatter at all\n',
      'content/good.md': '---\ntitle: G\n---\nBody.\n',
    };
    const result = await invokeBatch({
      body: { paths: ['content/bad.md', 'content/nofm.md', 'content/good.md'], addTags: ['new'] },
      isValidFilePath: (p) => p !== 'content/bad.md',
      files,
    });
    assert.equal(result.captured.status, 200);
    assert.deepEqual(result.captured.payload, {
      success: true,
      updated: 1,
      errors: [
        { path: 'content/bad.md', error: 'Invalid path' },
        { path: 'content/nofm.md', error: 'No frontmatter' },
      ],
    });
    assert.equal(result.writes.length, 1);
    assert.equal(result.writes[0].path, path.join(PROJECT_ROOT, 'content/good.md'));
    assert.equal(result.writes[0].content, '---\ntitle: G\ntags: [new]\n---\nBody.\n');
    // The invalid path is rejected before any read, so only the two valid paths are read.
    assert.ok(!result.reads.includes(path.join(PROJECT_ROOT, 'content/bad.md')));
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
  });

  it('records a read failure as a per-file Update failed and still invalidates the cache', async () => {
    // The path is valid but absent from `files`, so readFileSync throws and the
    // handler aggregates it as 'Update failed' without writing anything.
    const result = await invokeBatch({ body: { paths: ['content/missing.md'], setDraft: true }, files: {} });
    assert.equal(result.captured.status, 200);
    assert.deepEqual(result.captured.payload, {
      success: true,
      updated: 0,
      errors: [{ path: 'content/missing.md', error: 'Update failed' }],
    });
    assert.equal(result.writes.length, 0);
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
  });

  it('records a write failure as a per-file Update failed', async () => {
    const files = { 'content/wfail.md': '---\ntitle: W\n---\nB.\n' };
    const result = await invokeBatch({
      body: { paths: ['content/wfail.md'], setDraft: true },
      files,
      failWriteFor: ['content/wfail.md'],
    });
    assert.equal(result.captured.status, 200);
    assert.deepEqual(result.captured.payload, {
      success: true,
      updated: 0,
      errors: [{ path: 'content/wfail.md', error: 'Update failed' }],
    });
    assert.equal(result.writes.length, 0);
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
  });

  it('processes only the first 50 paths (the slice(0, 50) cap)', async () => {
    const files = {};
    const paths = [];
    for (let i = 0; i < 55; i++) {
      const rel = `content/c${i}.md`;
      paths.push(rel);
      files[rel] = `---\ntitle: C${i}\n---\nBody.\n`;
    }
    const result = await invokeBatch({ body: { paths, addTags: ['z'] }, files });
    assert.equal(result.captured.status, 200);
    assert.equal(result.captured.payload.updated, 50);
    assert.equal(result.captured.payload.errors, undefined);
    assert.equal(result.writes.length, 50);
    // The 51st path (index 50) is dropped by the cap, so it is never written.
    assert.ok(!result.writes.some((w) => w.path === path.join(PROJECT_ROOT, 'content/c50.md')));
    assert.deepEqual(result.invalidateCalls, ['search', 'tags']);
  });
});
