import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling next-references-*.test.mjs suites do, then drive ONLY the OUTER catch
// of POST /api/file/draft over a fully mocked ctx (no real fs, network,
// subprocess, git, clock, or randomness).
//
// The handler opens an outer `try` whose first statement is
//   const body = await readBody(req);
// immediately followed by
//   const {path: filePath, draft} = body;
// and its outer `catch` returns a FIXED 400, json(res, 400, {error: 'Invalid
// request'}), BEFORE any filesystem IO: the first IO, fs.readFileSync, runs only
// after the destructure and the non-IO isValidFilePath guard. The sibling guards
// suite (next-references-yeardist-filedraft.test.mjs) only ever RESOLVES readBody
// to a valid object, so this outer catch is otherwise 0-hit. These add-only
// characterization tests pin both catch triggers; no source file is edited.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');
const { isValidFilePath } = require('../server/server-utils.js');

const PROJECT_ROOT = '/proj';

// Drive the draft-toggle handler so its outer catch fires before any IO. The fs
// readFileSync/writeFileSync are ZERO-CALL tripwires: each bumps a counter and
// throws on contact, so the counter assertions prove the catch fired pre-IO (and
// any stray call would surface as a thrown error). isValidFilePath wraps the REAL
// guard behind a counter so we can prove the destructure throws BEFORE the first
// inner guard runs (precedence). rateLimit returns true so the handler reaches
// the try (the file-draft: limiter sits BEFORE it). `readBody` is supplied per
// case to select the catch trigger.
async function invokeDraftBadBody(readBody) {
  const pathname = '/api/file/draft';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  let readBodyCount = 0;
  let reads = 0;
  let writes = 0;
  let isValidFilePathCalls = 0;
  const ctx = {
    json(_res, status, body) { captured = { status, body }; res.writableEnded = true; return captured; },
    readBody: async (...args) => { readBodyCount += 1; return readBody(...args); },
    rateLimit: () => true,
    isValidFilePath: (p) => { isValidFilePathCalls += 1; return isValidFilePath(p); },
    fs: {
      readFileSync: () => { reads += 1; throw new Error('fs.readFileSync must not run on the outer-catch path'); },
      writeFileSync: () => { writes += 1; throw new Error('fs.writeFileSync must not run on the outer-catch path'); },
    },
    path,
    PROJECT_ROOT,
  };
  await routes(req, res, url, pathname, ctx);
  return { captured, readBodyCount, reads, writes, isValidFilePathCalls };
}

// ── POST /api/file/draft: outer-catch 400 (badbody) ──

describe('POST /api/file/draft outer-catch 400 badbody characterization', () => {
  it('returns the fixed 400 Invalid request when readBody rejects, before any IO', async () => {
    const { captured, readBodyCount, reads, writes, isValidFilePathCalls } =
      await invokeDraftBadBody(async () => { throw new Error('stream aborted'); });
    // The try's first statement throws, so the outer catch returns the fixed 400.
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    // readBody was entered (inside the try) but no filesystem IO was attempted.
    assert.equal(readBodyCount, 1);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    // The path guard sits after the read and destructure, so it never runs.
    assert.equal(isValidFilePathCalls, 0);
  });

  it('returns the same fixed 400 when readBody resolves null, the null destructure throwing into the SAME catch and beating the Invalid path guard', async () => {
    const { captured, readBodyCount, reads, writes, isValidFilePathCalls } =
      await invokeDraftBadBody(async () => null);
    // `const {path: filePath, draft} = null` throws a TypeError into the outer
    // catch, yielding the identical fixed 400, NOT the inner {error: 'Invalid
    // path'}: the outer catch beats the first inner guard (precedence).
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.equal(readBodyCount, 1);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    // isValidFilePath is never reached, so the Invalid path branch never runs.
    assert.equal(isValidFilePathCalls, 0);
  });
});
