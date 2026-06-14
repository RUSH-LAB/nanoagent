import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// feeds.js is CommonJS; load the REAL route module the way the sibling
// next-feeds-importurl-preget-guards test does. This pins the CURRENT behavior of
// the OUTER catch on POST /api/import-url (handler at feeds.js line 214): the
// fixed 400 {error: 'Import failed'} body it returns whenever the request body
// cannot be read or destructured. `await readBody(req)` is the FIRST statement in
// the try, so the catch precedes every validation rung, all filesystem IO, and
// the https.get network call that comes after the existence check. No source file
// is edited; the test only reads feeds.js through require.
const require = createRequire(import.meta.url);
const feedsRoutes = require('../server/routes/feeds.js');

const PROJECT_ROOT = '/tmp/next-importurl-badbody-test';

// Build a ctx member that must never run on the catch path: it counts its calls
// and throws. A non-zero counter (asserted below) would prove the catch let the
// request reach IO it must not, and the throw keeps a stray call from silently
// completing into a different (still 400) outcome.
function tripwire(counters, name) {
  return () => {
    counters[name] += 1;
    throw new Error(`${name} must not run on the import-url catch path`);
  };
}

// Drive a single POST /api/import-url request over a fully mocked ctx, mirroring
// the ctx shape the sibling feeds route tests use. `readBody` is supplied per case
// so each catch trigger (a rejected promise, or a resolved null whose destructure
// throws) is exercised directly. `rateLimit` always allows the request through so
// control reaches the try. Every filesystem and JSON helper is a tripwire, so the
// returned counters prove the catch fired before any IO or network. No real clock,
// filesystem, or network is touched.
async function invoke({ readBody }) {
  const pathname = '/api/import-url';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };

  let captured = null;
  const fsCalls = { existsSync: 0, mkdirSync: 0, writeFileSync: 0 };
  const helperCalls = { loadJSON: 0, saveJSON: 0, sanitizeText: 0, isValidFilePath: 0 };

  const ctx = {
    json(_res, status, body) { captured = { status, body }; res.writableEnded = true; return captured; },
    rateLimit: () => true,
    readBody,
    fs: {
      existsSync: tripwire(fsCalls, 'existsSync'),
      mkdirSync: tripwire(fsCalls, 'mkdirSync'),
      writeFileSync: tripwire(fsCalls, 'writeFileSync'),
    },
    loadJSON: tripwire(helperCalls, 'loadJSON'),
    saveJSON: tripwire(helperCalls, 'saveJSON'),
    sanitizeText: tripwire(helperCalls, 'sanitizeText'),
    isValidFilePath: tripwire(helperCalls, 'isValidFilePath'),
    path,
    PROJECT_ROOT,
  };

  await feedsRoutes(req, res, url, pathname, ctx);
  return { captured, fsCalls, helperCalls };
}

describe('POST /api/import-url badbody outer catch', () => {
  // Trigger A (readBody rejects): the awaited body read is the first statement in
  // the try, so a rejection unwinds straight into the catch, which returns the
  // fixed 400 body. No validation rung, filesystem call, or network request runs.
  it('returns 400 Import failed when readBody rejects', async () => {
    const { captured, fsCalls, helperCalls } = await invoke({
      readBody: async () => { throw new Error('bad json'); },
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Import failed' } });
    assert.deepEqual(fsCalls, { existsSync: 0, mkdirSync: 0, writeFileSync: 0 });
    assert.deepEqual(helperCalls, { loadJSON: 0, saveJSON: 0, sanitizeText: 0, isValidFilePath: 0 });
  });

  // Trigger B (readBody resolves null): destructuring `const {url, ...} = body`
  // throws a TypeError on null, which the catch turns into the same fixed 400.
  // The body is `Import failed`, NOT `Missing or invalid url`, which proves the
  // catch beats the first validation rung; the untouched fs counters confirm the
  // path never reached the existence check or the network beyond it.
  it('returns 400 Import failed when readBody resolves null, beating the validation ladder', async () => {
    const { captured, fsCalls, helperCalls } = await invoke({
      readBody: async () => null,
    });
    assert.deepEqual(captured, { status: 400, body: { error: 'Import failed' } });
    assert.deepEqual(fsCalls, { existsSync: 0, mkdirSync: 0, writeFileSync: 0 });
    assert.deepEqual(helperCalls, { loadJSON: 0, saveJSON: 0, sanitizeText: 0, isValidFilePath: 0 });
  });
});
