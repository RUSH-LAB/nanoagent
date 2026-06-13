import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// server/routes/file-tools.js is CommonJS; load the real module the way the
// sibling server route tests do (next-filetools-version-post-guards.test.mjs,
// next-search-global-guard.test.mjs) so these cases exercise the shipped
// POST /api/files/info batch handler rather than a reimplementation. This is an
// add-only characterization test: it pins the current, correct behavior of the
// handler and edits no source file.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';

// A deterministic stat: a fixed numeric size and a fixed ISO mtime, so the pinned
// size/mtime fields never depend on a real file or the clock. The handler reads
// stat.size and calls stat.mtime.toISOString(), so the stub needs only those.
const FIXED_MTIME_ISO = '2020-01-01T00:00:00.000Z';
function statOf(size) {
  return { size, mtime: { toISOString: () => FIXED_MTIME_ISO } };
}

// Drive the real POST /api/files/info handler over a fully mocked ctx (no real
// filesystem, network, or git). `files` maps a relative path to a descriptor:
//   { content, size }   yields a stat of {size, mtime} and reads back content
//   { throwStat: true }  makes statSync throw (a missing file, caught per entry)
//   { throwRead: true }  lets statSync pass, then makes readFileSync throw
// isValidFilePath rejects exactly the paths listed in `invalidPaths`. statCalls
// and readCalls record which paths reached the filesystem, so the negative
// short-circuits (no stat or read for an invalid entry, body never read on a
// 429) are observable rather than assumed.
async function runRoute({
  body = { paths: [] },
  rateLimitOk = true,
  invalidPaths = new Set(),
  files = {},
  readBodyThrows = false,
} = {}) {
  let readBodyCount = 0;
  const statCalls = [];
  const readCalls = [];
  let rateLimitKey = null;
  let rateLimitLimit = null;
  let captured = null;

  const res = { writableEnded: false };
  const ctx = {
    rateLimit: (key, limit) => { rateLimitKey = key; rateLimitLimit = limit; return rateLimitOk; },
    readBody: async () => {
      readBodyCount += 1;
      if (readBodyThrows) throw new Error('socket hang up');
      return body;
    },
    isValidFilePath: (p) => !invalidPaths.has(p),
    fs: {
      statSync: (fp) => {
        const rel = path.relative(PROJECT_ROOT, fp);
        statCalls.push(rel);
        const f = files[rel];
        if (!f || f.throwStat) throw new Error('ENOENT: no such file');
        return statOf(f.size);
      },
      readFileSync: (fp) => {
        const rel = path.relative(PROJECT_ROOT, fp);
        readCalls.push(rel);
        const f = files[rel];
        if (!f || f.throwRead) throw new Error('ENOENT: no such file');
        return f.content;
      },
    },
    path,
    PROJECT_ROOT,
    json: (_res, status, b) => { captured = { status, body: b }; res.writableEnded = true; },
  };

  const pathname = '/api/files/info';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  await fileToolsRoutes(req, res, url, pathname, ctx);
  return { captured, readBodyCount, statCalls, readCalls, rateLimitKey, rateLimitLimit };
}

describe('POST /api/files/info guards', () => {
  it('a rate-limited POST returns 429 and never reads the body', async () => {
    const { captured, readBodyCount } = await runRoute({
      rateLimitOk: false,
      body: { paths: ['content/docs/intro.md'] },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(readBodyCount, 0, 'the 429 short-circuits before the body is read');
  });

  it('uses the files-info rate-limit key scoped to the caller address with a budget of 30', async () => {
    // Distinct from the POST /api/file/version key (file-version:<addr>) that the
    // sibling next-filetools-version-post-guards.test.mjs pins.
    const { rateLimitKey, rateLimitLimit } = await runRoute();
    assert.equal(rateLimitKey, 'files-info:127.0.0.1');
    assert.equal(rateLimitLimit, 30, 'the per-route request budget is 30 per minute');
  });

  it('a non-array paths (a string) returns 400 after the body was read', async () => {
    const { captured, readBodyCount } = await runRoute({ body: { paths: 'x' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'paths must be an array' });
    assert.equal(readBodyCount, 1, 'the array guard runs only after the body is read');
  });

  it('an omitted paths returns the same 400 paths must be an array', async () => {
    const { captured, readBodyCount } = await runRoute({ body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'paths must be an array' });
    assert.equal(readBodyCount, 1);
  });

  it('the outer catch maps a readBody throw to 400 Invalid request', async () => {
    const { captured } = await runRoute({ readBodyThrows: true });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid request' });
  });
});

describe('POST /api/files/info per-entry handling', () => {
  it('an invalid entry yields Invalid path with no stat or read, and a later valid entry still processes', async () => {
    const bad = 'content/bad.md';
    const good = 'content/good.md';
    const { captured, statCalls, readCalls } = await runRoute({
      body: { paths: [bad, good] },
      invalidPaths: new Set([bad]),
      files: { [good]: { content: 'hello world foo', size: 42 } },
    });
    assert.equal(captured.status, 200, 'a bad entry does not fail the whole batch');
    assert.deepEqual(captured.body.results[0], { path: bad, error: 'Invalid path' });
    assert.ok(!statCalls.includes(bad), 'the invalid entry is never stat-ed');
    assert.ok(!readCalls.includes(bad), 'the invalid entry is never read');
    // The later valid entry still produces its full computed info.
    assert.deepEqual(captured.body.results[1], {
      path: good, title: 'good', size: 42, wordCount: 3, draft: false, mtime: FIXED_MTIME_ISO,
    });
    assert.equal(captured.body.count, 2);
  });

  it('a missing file (statSync throws) yields File not found while a later good entry succeeds', async () => {
    const missing = 'content/missing.md';
    const good = 'content/good.md';
    const { captured } = await runRoute({
      body: { paths: [missing, good] },
      files: { [missing]: { throwStat: true }, [good]: { content: 'hello world foo', size: 7 } },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body.results[0], { path: missing, error: 'File not found' });
    const g = captured.body.results[1];
    assert.deepEqual(g, {
      path: good, title: 'good', size: 7, wordCount: 3, draft: false, mtime: FIXED_MTIME_ISO,
    });
  });

  it('a read failure (readFileSync throws after a good stat) also yields File not found', async () => {
    const p = 'content/unreadable.md';
    const { captured } = await runRoute({
      body: { paths: [p] },
      files: { [p]: { throwRead: true } },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body.results[0], { path: p, error: 'File not found' });
  });

  it('caps the batch at the first 50 paths', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `content/f${i}.md`);
    const files = {};
    for (const p of many) files[p] = { content: 'one two', size: 1 };
    const { captured } = await runRoute({ body: { paths: many }, files });
    assert.equal(captured.body.results.length, 50, 'only the first 50 paths are processed');
    assert.equal(captured.body.count, 50);
  });
});

describe('POST /api/files/info success shape', () => {
  it('a file with no frontmatter gets the basename title, draft false, and the stub size/mtime/wordCount', async () => {
    const p = 'content/docs/intro.md';
    const { captured } = await runRoute({
      body: { paths: [p] },
      files: { [p]: { content: 'hello world foo', size: 42 } },
    });
    const r = captured.body.results[0];
    assert.deepEqual(Object.keys(r).sort(), ['draft', 'mtime', 'path', 'size', 'title', 'wordCount']);
    assert.deepEqual(r, {
      path: p, title: 'intro', size: 42, wordCount: 3, draft: false, mtime: FIXED_MTIME_ISO,
    });
  });

  it('a frontmatter title line wins over the basename and draft true is honored', async () => {
    const p = 'content/post.mdx';
    const content = '---\ntitle: My Title\ndraft: true\n---\nbody';
    const { captured } = await runRoute({
      body: { paths: [p] },
      files: { [p]: { content, size: 100 } },
    });
    const r = captured.body.results[0];
    assert.equal(r.title, 'My Title');
    assert.equal(r.draft, true);
    assert.equal(r.size, 100);
    assert.equal(r.wordCount, 8, 'wordCount counts the whole content, frontmatter included');
    assert.equal(r.mtime, FIXED_MTIME_ISO);
  });

  it('frontmatter without a draft line keeps draft false', async () => {
    const p = 'content/note.md';
    const content = '---\ntitle: Just A Title\n---\nalpha beta';
    const { captured } = await runRoute({
      body: { paths: [p] },
      files: { [p]: { content, size: 5 } },
    });
    const r = captured.body.results[0];
    assert.equal(r.title, 'Just A Title');
    assert.equal(r.draft, false, 'draft is true only with a draft: true frontmatter line');
  });
});
