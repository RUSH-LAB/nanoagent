import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// analysis-admin.js is CommonJS; load the real module the way the sibling
// tests/next-lint-hoist-regexes.test.mjs does, so these guards run against the
// production POST /api/lint handler (analysis-admin.js lines 522 to 626) rather
// than a copy.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// A documentation-range remote address (RFC 5737 TEST-NET-3) so the rate-limit
// key is a fixed, recognizably synthetic value.
const REMOTE = '203.0.113.7';

// Build a fresh ctx for one request. The POST /api/lint handler reads `content`
// from readBody and performs pure string analysis with no store IO, network,
// clock, or randomness, so every guard branch below is fully deterministic.
// Recorders:
//   rateLimit(key, limit):      records every call, returns the configured verdict
//   readBody(req):              counts calls, returns `body` (or throws if asked)
//   json(res, status, payload): captures what the handler sends
function makeCtx({ rateLimitOk = true, body = {}, readBodyThrows = false } = {}) {
  const ctx = {
    calls: { rateLimit: [], readBody: 0 },
    captured: null,
    rateLimit(key, limit) {
      ctx.calls.rateLimit.push({ key, limit });
      return rateLimitOk;
    },
    async readBody() {
      ctx.calls.readBody += 1;
      if (readBodyThrows) throw new Error('readBody failed');
      return body;
    },
    json(res, status, payload) {
      res.writableEnded = true;
      ctx.captured = { status, payload };
      return ctx.captured;
    },
  };
  return ctx;
}

// Drive the real handler for POST /api/lint and return whatever it sent via json.
async function postLint(ctx) {
  const url = new URL('http://localhost/api/lint');
  const req = { method: 'POST', socket: { remoteAddress: REMOTE } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/lint', ctx);
  return ctx.captured;
}

describe('POST /api/lint input-validation guards', () => {
  it('returns 429 and never reads the body when the rate limit is exceeded', async () => {
    const ctx = makeCtx({ rateLimitOk: false });
    const { status, payload } = await postLint(ctx);

    assert.equal(status, 429);
    assert.deepEqual(payload, { error: 'Too many requests. Try again in a minute.' });

    // The rate-limit guard short-circuits before the body is ever read.
    assert.equal(ctx.calls.readBody, 0);

    // Keyed per remote address inside the lint namespace, with a limit of 60.
    assert.equal(ctx.calls.rateLimit.length, 1);
    assert.equal(ctx.calls.rateLimit[0].key, `lint:${REMOTE}`);
    assert.ok(ctx.calls.rateLimit[0].key.startsWith('lint:'));
    assert.equal(ctx.calls.rateLimit[0].limit, 60);
  });

  it('returns 400 "Content must be a string" for non-string content', async () => {
    const cases = [
      { label: 'number', body: { content: 42 } },
      { label: 'null', body: { content: null } },
      { label: 'undefined (field absent)', body: {} },
      { label: 'object', body: { content: { md: 'hi' } } },
    ];

    for (const { label, body } of cases) {
      const ctx = makeCtx({ body });
      const { status, payload } = await postLint(ctx);

      assert.equal(status, 400, label);
      assert.deepEqual(payload, { error: 'Content must be a string' }, label);

      // The body is read first, then the type guard fires.
      assert.equal(ctx.calls.readBody, 1, label);
      assert.equal(ctx.calls.rateLimit[0].key, `lint:${REMOTE}`, label);
      assert.equal(ctx.calls.rateLimit[0].limit, 60, label);
    }
  });

  it('returns 400 "Content must be 50000 characters or fewer" past the length cap', async () => {
    // 50001 characters trips the over-length guard.
    const over = makeCtx({ body: { content: 'a'.repeat(50001) } });
    const overRes = await postLint(over);
    assert.equal(overRes.status, 400);
    assert.deepEqual(overRes.payload, { error: 'Content must be 50000 characters or fewer' });

    // Exactly 50000 characters is allowed (the guard is a strict greater-than) and
    // reaches the analysis pass; an all-newline body produces no issues.
    const atCap = makeCtx({ body: { content: '\n'.repeat(50000) } });
    const atCapRes = await postLint(atCap);
    assert.equal(atCapRes.status, 200);
    assert.deepEqual(atCapRes.payload, { issues: [] });
  });

  it('returns 400 "Invalid request" when readBody throws', async () => {
    const ctx = makeCtx({ readBodyThrows: true });
    const { status, payload } = await postLint(ctx);

    assert.equal(status, 400);
    assert.deepEqual(payload, { error: 'Invalid request' });

    // The throw happens inside the try, after the rate-limit guard has passed.
    assert.equal(ctx.calls.rateLimit.length, 1);
    assert.equal(ctx.calls.readBody, 1);
  });

  it('passes the guard ladder and returns 200 {issues} for valid string content', async () => {
    const ctx = makeCtx({ body: { content: '# Title\n\nSome clean prose with no problems.' } });
    const { status, payload } = await postLint(ctx);

    assert.equal(status, 200);
    assert.deepEqual(payload, { issues: [] });

    // Valid input still consults the rate limiter once under the lint key.
    assert.equal(ctx.calls.rateLimit[0].key, `lint:${REMOTE}`);
    assert.equal(ctx.calls.rateLimit[0].limit, 60);
    assert.equal(ctx.calls.readBody, 1);
  });
});
