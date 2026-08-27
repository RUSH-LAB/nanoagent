import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the REAL route module via createRequire the way
// the sibling batch-export tests do (next-batchexport-parse-all-fail-500.test.mjs
// shares this driver and ctx harness). This is an ADD-ONLY characterization test
// that pins the CURRENT behavior of GET /api/export/batch and touches no source.
const require = createRequire(import.meta.url);
const miscRoutes = require('../../../../../server/routes/misc-tools.js');
// Reuse the production isValidDir so the first guard is pinned against the real
// contract. The handler reads isValidDir from ctx, and 'content/foo' satisfies it.
const { isValidDir } = require('../../../../../server/server-utils.js');

const PROJECT_ROOT = '/fake/root';

// An fs whose 404 directory gate PASSES (existsSync true, statSync isDirectory
// true) but whose readdirSync THROWS. readdirSync runs inside walkDirBatch
// (misc-tools.js:973), which the handler invokes at line 983, OUTSIDE the
// per-file inner try/catch and BEFORE any res.writeHead(200) stream (line 1156).
// So the throw escapes walkDirBatch into the handler's OUTER catch (line 1162),
// which returns 500 {error: 'Batch export failed', detail: err.message}. The
// readFileSync stub records calls but must never run, proving the throw happened
// during the directory walk rather than the later per-file read loop. This pins a
// DIFFERENT seam from the inner :1036 'Failed to parse any files' branch covered
// by next-batchexport-parse-all-fail-500.test.mjs (where readdirSync succeeds and
// readFileSync throws).
function makeReaddirThrowsFs() {
  const calls = { readdirSync: 0, readFileSync: 0 };
  const fs = {
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
    readdirSync: () => { calls.readdirSync++; throw new Error('readdirSync boom'); },
    readFileSync: () => { calls.readFileSync++; return ''; },
  };
  return { fs, calls };
}

describe('GET /api/export/batch outer-catch 500 "Batch export failed" when readdirSync throws (pins current behavior)', () => {
  it('maps a directory-walk throw to 500 {error, detail} before any bytes stream', async () => {
    const { fs, calls } = makeReaddirThrowsFs();

    // res records whether the success stream ever started: writeHead flips
    // headersSent, end flips writableEnded. On the outer-catch path neither the
    // 200 writeHead nor res.end runs; the capturing json ends the response.
    const replies = [];
    const res = {
      writableEnded: false,
      headersSent: false,
      writeHead() { this.headersSent = true; return this; },
      end() { this.writableEnded = true; return this; },
    };
    const ctx = {
      path,
      PROJECT_ROOT,
      CORS_ORIGIN: '*',
      isValidDir,
      fs,
      json(_res, status, body) { replies.push({ status, body }); _res.writableEnded = true; },
    };
    // format defaults to html and dir=content/foo passes the real isValidDir, so
    // execution reaches the outer try and the throwing directory walk.
    const url = new URL('http://localhost/api/export/batch?dir=content/foo');
    const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };

    await miscRoutes(req, res, url, '/api/export/batch', ctx);

    // Golden: the outer catch carries the thrown message verbatim in detail.
    assert.deepStrictEqual(replies[0], {
      status: 500,
      body: { error: 'Batch export failed', detail: 'readdirSync boom' },
    });
    assert.equal(replies.length, 1);

    // Provenance and never-streamed proof: the directory walk threw, no file was
    // read, no headers were written, and the success 200 never fired.
    assert.ok(calls.readdirSync >= 1, 'readdirSync ran: the directory walk was entered');
    assert.equal(calls.readFileSync, 0, 'readFileSync never ran: the throw preceded the per-file loop');
    assert.equal(res.headersSent, false, 'no writeHead means nothing was streamed');
    assert.equal(res.writableEnded, true, 'the 500 reply ended the response');
    assert.ok(!replies.some((r) => r.status === 200), 'the success stream never fired');
  });
});
