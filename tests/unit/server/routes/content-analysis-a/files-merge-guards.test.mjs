import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Module-name note: the GOAL and verify.sh refer to
// `server/routes/content-analysis-c.js`, but the POST /api/files/merge handler
// and every guard branch asserted below actually live in
// `server/routes/content-analysis-a.js`. We load the REAL module that contains
// the handler (the same one the sibling next-health-history-guards suite loads),
// so these tests exercise the genuine guards instead of a reimplementation. The
// content-analysis-c.js name is recorded here to document that GOAL discrepancy.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/fake/root';

// Drive the POST /api/files/merge handler through a mocked ctx and capture the
// json(res, status, payload) response plus counters that prove no filesystem
// write or cache invalidation happened. Every guard branch returns before the
// handler reads or writes any file, so the mocked ctx never touches the real
// filesystem. Defaults: rateLimit allows the request, readBody resolves to
// `body` (unless readBodyThrows is set), and isValidFilePath accepts every path.
// fs.readFileSync throws so any case that wrongly falls through to the success
// path surfaces as a failure instead of passing silently; fs.writeFileSync and
// invalidateCache only bump counters, so nothing is ever persisted.
async function invokeMerge({
  body,
  readBodyThrows = false,
  rateLimit = () => true,
  isValidFilePath = () => true,
} = {}) {
  const pathname = '/api/files/merge';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let writeCount = 0;
  let invalidateCount = 0;
  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit,
    isValidFilePath,
    readBody: async () => {
      if (readBodyThrows) throw new Error('readBody failed');
      return body;
    },
    fs: {
      readFileSync: () => { throw new Error('no real read in guard tests'); },
      writeFileSync: () => { writeCount++; },
    },
    invalidateCache: () => { invalidateCount++; },
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, writeCount, invalidateCount };
}

// Shared assertion: a rejected merge writes nothing and invalidates no cache.
function assertNoWrite({ writeCount, invalidateCount }) {
  assert.equal(writeCount, 0, 'a rejected merge never writes the target file');
  assert.equal(invalidateCount, 0, 'a rejected merge never invalidates the cache');
}

describe('POST /api/files/merge guard branches (no write on any rejected path)', () => {
  it('returns 429 when the request is rate-limited and never writes', async () => {
    // The rate-limit guard returns before the try block, so neither readBody nor
    // any fs call is reached on this path.
    const result = await invokeMerge({
      body: { sourcePath: 'content/a.md', targetPath: 'content/b.md' },
      rateLimit: () => false,
    });
    assert.equal(result.captured.status, 429);
    assert.deepEqual(result.captured.payload, { error: 'Too many requests.' });
    assertNoWrite(result);
  });

  it('returns 400 when sourcePath is missing', async () => {
    const result = await invokeMerge({ body: { targetPath: 'content/b.md' } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing or invalid sourcePath' });
    assertNoWrite(result);
  });

  it('returns 400 when sourcePath is not a string', async () => {
    const result = await invokeMerge({ body: { sourcePath: 42, targetPath: 'content/b.md' } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing or invalid sourcePath' });
    assertNoWrite(result);
  });

  it('returns 400 when targetPath is missing (valid string sourcePath)', async () => {
    const result = await invokeMerge({ body: { sourcePath: 'content/a.md' } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing or invalid targetPath' });
    assertNoWrite(result);
  });

  it('returns 400 when targetPath is not a string (valid string sourcePath)', async () => {
    const result = await invokeMerge({ body: { sourcePath: 'content/a.md', targetPath: 7 } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Missing or invalid targetPath' });
    assertNoWrite(result);
  });

  it('returns 400 when isValidFilePath rejects the source path', async () => {
    const result = await invokeMerge({
      body: { sourcePath: 'content/a.md', targetPath: 'content/b.md' },
      isValidFilePath: (p) => p !== 'content/a.md',
    });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Invalid paths' });
    assertNoWrite(result);
  });

  it('returns 400 when isValidFilePath rejects the target path', async () => {
    const result = await invokeMerge({
      body: { sourcePath: 'content/a.md', targetPath: 'content/b.md' },
      isValidFilePath: (p) => p === 'content/a.md',
    });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Invalid paths' });
    assertNoWrite(result);
  });

  it('returns 400 when sourcePath equals targetPath', async () => {
    const result = await invokeMerge({ body: { sourcePath: 'content/same.md', targetPath: 'content/same.md' } });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Source and target paths must be different' });
    assertNoWrite(result);
  });

  it('returns 400 when separator is present but not a string', async () => {
    const result = await invokeMerge({
      body: { sourcePath: 'content/a.md', targetPath: 'content/b.md', separator: 123 },
    });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'separator must be a string' });
    assertNoWrite(result);
  });

  it('returns 400 when separator is longer than 500 characters', async () => {
    const result = await invokeMerge({
      body: { sourcePath: 'content/a.md', targetPath: 'content/b.md', separator: 'x'.repeat(501) },
    });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'separator must be 500 characters or fewer' });
    assertNoWrite(result);
  });

  it('accepts a separator of exactly 500 characters (the boundary is inclusive)', async () => {
    // A 500 character separator passes both separator guards, so execution falls
    // through to the file read. The mocked fs.readFileSync throws, so the handler
    // returns its catch-path 'Merge failed' rather than the separator-length
    // error. This pins the inclusive 500 boundary without touching the real
    // filesystem, and the target is still never written.
    const result = await invokeMerge({
      body: { sourcePath: 'content/a.md', targetPath: 'content/b.md', separator: 'x'.repeat(500) },
    });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Merge failed' });
    assertNoWrite(result);
  });

  it('returns 400 when readBody throws', async () => {
    const result = await invokeMerge({ readBodyThrows: true });
    assert.equal(result.captured.status, 400);
    assert.deepEqual(result.captured.payload, { error: 'Merge failed' });
    assertNoWrite(result);
  });
});
