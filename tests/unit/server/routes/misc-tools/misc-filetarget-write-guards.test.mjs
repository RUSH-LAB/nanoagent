import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling write-guard suite does (next-pins-crud-guards.test.mjs) so these cases
// exercise the shipped POST /api/file/target handler rather than a
// reimplementation. The handler runs over a fully mocked ctx: no real
// filesystem, network, or git is ever touched.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/misc-tools.js');

const PROJECT_ROOT = '/proj';
// The handler reads and persists the per-file word-count targets to this path,
// mirroring server/index.js (path.join(PROJECT_ROOT, 'var', 'data', 'targets.json')). The
// mocked loadJSON answers only for this exact path, so a stray read surfaces as a
// thrown error instead of silently passing; the same constant is handed to the
// handler through ctx, so the guard and the handler agree on the target path.
const TARGETS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'targets.json');

// Drive POST /api/file/target over a mocked ctx. rateLimit and isValidFilePath
// are per-call toggles; readBody returns the supplied body and counts its own
// calls so a rate-limited request can prove the body was never read; loadJSON
// returns a fresh deep copy of `doc`, a faithful stand-in for a fresh disk read
// that also decouples the recorded saved document from the input seed; saveJSON
// records every persist call; json captures the (status, body) handed back.
async function runRoute({ body = {}, doc = {}, rateLimitOk = true, validPath = true } = {}) {
  const saved = [];
  let readBodyCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: () => rateLimitOk,
    readBody: async () => { readBodyCount++; return body; },
    isValidFilePath: () => validPath,
    loadJSON: (fp) => {
      if (fp === TARGETS_FILE) return JSON.parse(JSON.stringify(doc));
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    path,
    PROJECT_ROOT,
    TARGETS_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/file/target';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, saved, readBodyCount };
}

describe('POST /api/file/target rate limit', () => {
  it('a rate-limited POST returns 429, never reads the body, and never saves', async () => {
    const { captured, saved, readBodyCount } = await runRoute({
      rateLimitOk: false,
      body: { path: 'content/a.md', targetWords: 50 },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(saved.length, 0);
  });
});

describe('POST /api/file/target path validation', () => {
  it('a missing path returns 400 Missing or invalid path and never saves', async () => {
    const { captured, saved } = await runRoute({ body: { targetWords: 50 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing or invalid path' });
    assert.equal(saved.length, 0);
  });

  it('an empty-string path returns 400 Missing or invalid path and never saves', async () => {
    // '' is falsy, so it trips the same guard as a missing path.
    const { captured, saved } = await runRoute({ body: { path: '', targetWords: 50 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing or invalid path' });
    assert.equal(saved.length, 0);
  });

  it('a non-string path returns 400 Missing or invalid path and never saves', async () => {
    // A number trips the typeof filePath check, not the falsy check.
    const { captured, saved } = await runRoute({ body: { path: 42, targetWords: 50 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing or invalid path' });
    assert.equal(saved.length, 0);
  });

  it('a path rejected by isValidFilePath returns 400 Invalid file path and never saves', async () => {
    // A non-empty string path that the validator rejects reaches the dedicated
    // Invalid file path branch, just past the missing/invalid path guard.
    const { captured, saved } = await runRoute({
      validPath: false,
      body: { path: '../etc/passwd', targetWords: 50 },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid file path' });
    assert.equal(saved.length, 0);
  });
});

describe('POST /api/file/target targetWords validation', () => {
  it('an undefined targetWords returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({ body: { path: 'content/a.md' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'targetWords must be a positive number' });
    assert.equal(saved.length, 0);
  });

  it('a non-number targetWords (numeric string) returns 400 and never saves', async () => {
    // The string "100" trips the typeof targetWords check; a numeric-looking
    // string is not coerced to a number.
    const { captured, saved } = await runRoute({ body: { path: 'content/a.md', targetWords: '100' } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'targetWords must be a positive number' });
    assert.equal(saved.length, 0);
  });

  it('a zero targetWords returns 400 and never saves', async () => {
    // 0 is a number but the targetWords <= 0 check rejects it.
    const { captured, saved } = await runRoute({ body: { path: 'content/a.md', targetWords: 0 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'targetWords must be a positive number' });
    assert.equal(saved.length, 0);
  });

  it('a negative targetWords returns 400 and never saves', async () => {
    const { captured, saved } = await runRoute({ body: { path: 'content/a.md', targetWords: -5 } });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'targetWords must be a positive number' });
    assert.equal(saved.length, 0);
  });
});

describe('POST /api/file/target success and persistence', () => {
  it('a valid request returns 200, saves once, and persists targetWords for the path', async () => {
    const { captured, saved } = await runRoute({ body: { path: 'content/a.md', targetWords: 50 } });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true, path: 'content/a.md', targetWords: 50 });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, TARGETS_FILE);
    assert.equal(saved[0].data['content/a.md'], 50);
    assert.deepEqual(saved[0].data, { 'content/a.md': 50 });
  });

  it('preserves an existing sibling target and overwrites the same path on a second write', async () => {
    // Seed an existing sibling target, then write a new path: both keys persist.
    const first = await runRoute({
      doc: { 'content/other.md': 10 },
      body: { path: 'content/a.md', targetWords: 50 },
    });
    assert.equal(first.captured.status, 200);
    assert.equal(first.saved.length, 1);
    assert.deepEqual(first.saved[0].data, { 'content/other.md': 10, 'content/a.md': 50 });

    // A second write to the same path overwrites its value while the sibling is
    // untouched. Seed from the document the first write persisted; loadJSON
    // deep-copies it, so the earlier recorded save is not mutated by this call.
    const second = await runRoute({
      doc: first.saved[0].data,
      body: { path: 'content/a.md', targetWords: 80 },
    });
    assert.equal(second.captured.status, 200);
    assert.equal(second.saved.length, 1);
    assert.deepEqual(second.saved[0].data, { 'content/other.md': 10, 'content/a.md': 80 });
    // The first write's recorded document is untouched by the second request,
    // confirming the deep-copy seed isolates each call.
    assert.deepEqual(first.saved[0].data, { 'content/other.md': 10, 'content/a.md': 50 });
  });
});
