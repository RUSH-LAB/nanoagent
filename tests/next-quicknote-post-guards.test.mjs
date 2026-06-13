import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load the real module via createRequire the way the
// sibling guard suites do (e.g. next-misctools-readingprogress-post-guards.test.mjs)
// so these cases exercise the shipped POST /api/quicknote handler in
// server/routes/misc-tools.js (lines 1182 to 1253) rather than a reimplementation.
// The handler runs over a fully mocked ctx: no real filesystem, network, clock, or
// randomness is touched, except where a stub deliberately stands in for one.
//
// This is an add-only characterization test. Every branch pinned below is a guard
// that rejects BEFORE the handler reaches its clock read (the `new Date()` at line
// 1194) and the filesystem write, so the handler never touches fs, sanitizeText, or
// the slug code. Pinning the CURRENT, correct guard behavior keeps a future refactor
// from silently changing a status code, an error message, or the order the guards
// run in. No source file is edited.
//
// Out of scope by design: the title-length guard (line 1196) and everything after it
// sit AFTER the clock read, so they are not pinned here. A text of exactly
// MAX_TEXT_LENGTH characters would clear the length guard and reach the clock, so
// only an over-length text is asserted on that branch.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/misc-tools.js');

// Mirrors the real MAX_TEXT_LENGTH exported from server/server-utils.js (line 9),
// which the live server spreads into ctx. The handler reads the limit from ctx, so
// the test supplies the same value to characterize the shipped 10000-character cap.
const MAX_TEXT_LENGTH = 10000;

// Drive POST /api/quicknote over a mocked ctx. rateLimit records each call (key and
// limit) and returns the per-call toggle; readBody returns the supplied body and
// counts its calls (or throws when asked, standing in for a malformed body); the fs
// recorder counts existsSync/writeFileSync so a stray store touch on a guard branch
// becomes visible; sanitizeText is the identity (guard branches never reach it); json
// captures the (status, body) handed back. The counters let each guard branch prove
// the body and the filesystem were reached exactly as expected, and that the 429
// rejects before the body is ever read.
async function runQuickNote({
  body = {},
  rateLimitOk = true,
  throwOnReadBody = false,
  remoteAddress = '127.0.0.1',
} = {}) {
  const rateLimitCalls = [];
  let readBodyCount = 0;
  let fsExistsCount = 0;
  let fsWriteCount = 0;
  let captured = null;
  const ctx = {
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return rateLimitOk; },
    readBody: async () => {
      readBodyCount++;
      if (throwOnReadBody) throw new Error('readBody failed');
      return body;
    },
    sanitizeText: (s) => s,
    MAX_TEXT_LENGTH,
    fs: {
      existsSync: () => { fsExistsCount++; return false; },
      mkdirSync: () => {},
      writeFileSync: () => { fsWriteCount++; },
    },
    path,
    PROJECT_ROOT: '/proj',
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const pathname = '/api/quicknote';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { captured, rateLimitCalls, readBodyCount, fsExistsCount, fsWriteCount };
}

describe('POST /api/quicknote guards in routes/misc-tools.js', () => {
  it('a rate-limited request returns 429, never reads the body or touches the filesystem, and uses the quicknote key with limit 20', async () => {
    const r = await runQuickNote({ rateLimitOk: false, body: { text: 'hello' } });
    assert.equal(r.captured.status, 429);
    assert.deepEqual(r.captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(r.readBodyCount, 0, 'the rate-limit guard returns before readBody');
    assert.equal(r.fsExistsCount, 0);
    assert.equal(r.fsWriteCount, 0);
    // Pin the per-handler rate-limit identity. The quicknote: key with limit 20
    // distinguishes this POST handler from the other POST handlers in this module,
    // and from the plural quicknotes handler in study-knowledge.js, that share the
    // 429 string but throttle under their own keys and limits.
    assert.equal(r.rateLimitCalls.length, 1);
    assert.deepEqual(r.rateLimitCalls[0], { key: 'quicknote:127.0.0.1', limit: 20 });
  });

  it('an absent text is falsy, returning 400 Missing or empty text, reading the body once, never touching the filesystem', async () => {
    // An empty object destructures to an undefined text, which is falsy, so the
    // first arm of the guard rejects it. The body is read inside the try before any
    // field is validated.
    const r = await runQuickNote({ body: {} });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing or empty text' });
    assert.equal(r.readBodyCount, 1, 'the body is read before text is validated');
    assert.equal(r.fsExistsCount, 0);
    assert.equal(r.fsWriteCount, 0);
  });

  it('a non-string text (42) trips the typeof arm, returning 400 Missing or empty text, never touching the filesystem', async () => {
    // 42 is truthy so it clears the falsy arm, but typeof 42 !== 'string' trips the
    // second arm of the same guard; a numeric text is never accepted.
    const r = await runQuickNote({ body: { text: 42 } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing or empty text' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.fsExistsCount, 0);
    assert.equal(r.fsWriteCount, 0);
  });

  it('a whitespace-only text trips the trim arm, returning 400 Missing or empty text, never touching the filesystem', async () => {
    // A whitespace string is truthy and a string, so it clears the first two arms,
    // but text.trim().length === 0 trips the third arm of the guard.
    const r = await runQuickNote({ body: { text: '   \t\n  ' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Missing or empty text' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.fsExistsCount, 0);
    assert.equal(r.fsWriteCount, 0);
  });

  it('a text one character over MAX_TEXT_LENGTH clears the empty guard but trips the length guard, returning 400 Text too long, never touching the filesystem', async () => {
    // 'a'.repeat(MAX_TEXT_LENGTH + 1) is a non-empty, non-whitespace string, so it
    // clears the first guard; its length exceeds MAX_TEXT_LENGTH, so the length
    // guard rejects it before the clock read and the file write.
    const r = await runQuickNote({ body: { text: 'a'.repeat(MAX_TEXT_LENGTH + 1) } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Text too long' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.fsExistsCount, 0);
    assert.equal(r.fsWriteCount, 0);
  });

  it('an outer throw (readBody fails) returns 400 Invalid request, reads the body once, never touching the filesystem', async () => {
    // readBody runs inside the try with no inner parse guard, so its rejection lands
    // on the outer catch as a 400 Invalid request, not a validation 400.
    const r = await runQuickNote({ throwOnReadBody: true, body: { text: 'hello' } });
    assert.equal(r.captured.status, 400);
    assert.deepEqual(r.captured.body, { error: 'Invalid request' });
    assert.equal(r.readBodyCount, 1);
    assert.equal(r.fsExistsCount, 0);
    assert.equal(r.fsWriteCount, 0);
  });
});
