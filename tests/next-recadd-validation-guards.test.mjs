import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// Characterization coverage for the input validation, rate limit, and outer
// catch branches of POST /api/recommendations/add in
// server/routes/research-tools.js. The two existing suites for this handler
// (tests/next-recadd-invalidate-stats.test.mjs and
// tests/next-recadd-titleslug.test.mjs) send only valid bodies with rateLimit
// returning true, so they exercise just the 201 happy path and the single
// "Missing or invalid title" rejection. Every other guard, the 429 throttle,
// and the outer catch had zero assertions before this file.
//
// research-tools.js is CommonJS; load the REAL module via createRequire the way
// the sibling suites do, and reuse their mocked ctx shape. Each guard returns
// before the https block and the file write, so the targeted branches are fully
// deterministic and network free: they are asserted over a mocked ctx with an
// in-memory bibliography read and a capturing write, so no network and no real
// filesystem are touched.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/research-tools.js');
const yaml = require('js-yaml');

const PROJECT_ROOT = '/proj';

// Invoke the recommendations/add handler with a mocked ctx. `events` records
// every side effect in order: 'read' for each readFileSync, 'write' for each
// writeFileSync, and 'invalidate:<tag>' for each invalidateCache, so a test can
// pin the exact I/O a path performs, including no I/O at all on a rejected
// request. `readBodyCount` proves whether the body was read; `rateLimitCalls`
// captures the limiter key and ceiling. readFileSync returns the YAML for
// `existingRefs`, or `rawExistingYaml` verbatim when supplied (to feed a
// malformed bibliography). writeFileSync is captured in memory and never hits
// disk. `rateLimited` flips the limiter to false.
async function invoke({ body, existingRefs = {}, rawExistingYaml, rateLimited = false, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/recommendations/add';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };

  let captured = null;
  let readBodyCount = 0;
  const events = [];
  const invalidateCalls = [];
  const writes = [];
  const rateLimitCalls = [];
  const existingYaml = rawExistingYaml !== undefined ? rawExistingYaml : yaml.dump(existingRefs, { lineWidth: -1 });

  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    readBody: async () => { readBodyCount += 1; return body; },
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return !rateLimited; },
    sanitizeText: s => s,
    invalidateCache(tag) { invalidateCalls.push(tag); events.push(`invalidate:${tag}`); },
    fs: {
      readFileSync: () => { events.push('read'); return existingYaml; },
      writeFileSync: (file, data) => { events.push('write'); writes.push({ file, data }); },
    },
    path,
    PROJECT_ROOT,
  };

  await routes(req, res, url, pathname, fullCtx);
  return { captured, events, invalidateCalls, writes, rateLimitCalls, readBodyCount };
}

// Drive the handler with `body` and assert it is rejected at the validation
// stage: a 400 carrying exactly `error`, with the body read once but no file
// read, no write, and no cache invalidation. Each guard returns before the
// bibliography read, so a rejected request performs no I/O whatsoever.
async function assertValidationRejected(body, error) {
  const { captured, events, invalidateCalls, writes, readBodyCount } = await invoke({ body });
  assert.equal(captured.status, 400);
  assert.deepEqual(captured.payload, { error });
  assert.equal(readBodyCount, 1, 'the body is read inside the try before the guard rejects');
  assert.deepEqual(events, [], 'a rejected guard performs no file I/O and no invalidation');
  assert.equal(writes.length, 0);
  assert.deepEqual(invalidateCalls, []);
}

describe('POST /api/recommendations/add input validation guards (characterization)', () => {
  it('rejects a title longer than 500 characters', async () => {
    await assertValidationRejected({ title: 'a'.repeat(501) }, 'Title must be 500 characters or fewer');
  });

  it('rejects authors that are not an array', async () => {
    // A common client mistake is sending a single author string instead of a list.
    await assertValidationRejected({ title: 'Valid Title', authors: 'Jane Doe' }, 'authors must be an array');
  });

  it('rejects an authors array with more than 50 entries', async () => {
    const authors = Array.from({ length: 51 }, (_, i) => `Author ${i}`);
    await assertValidationRejected({ title: 'Valid Title', authors }, 'authors exceeds maximum length of 50');
  });

  it('rejects a year that is neither a number nor a string', async () => {
    // A boolean is defined yet neither a number nor a string, so it trips the
    // year type guard.
    await assertValidationRejected({ title: 'Valid Title', year: true }, 'year must be a number or string');
  });

  it('rejects a venue that is not a string', async () => {
    await assertValidationRejected({ title: 'Valid Title', venue: 123 }, 'venue must be a string');
  });

  it('rejects a venue string longer than 500 characters', async () => {
    await assertValidationRejected({ title: 'Valid Title', venue: 'v'.repeat(501) }, 'Venue must be 500 characters or fewer');
  });

  it('rejects a url that is not a string', async () => {
    await assertValidationRejected({ title: 'Valid Title', url: 123 }, 'url must be a string');
  });

  it('rejects a url string longer than 2000 characters', async () => {
    await assertValidationRejected({ title: 'Valid Title', url: 'u'.repeat(2001) }, 'URL must be 2000 characters or fewer');
  });

  it('rejects an arxivId that is not a string', async () => {
    await assertValidationRejected({ title: 'Valid Title', arxivId: 123 }, 'arxivId must be a string');
  });

  it('rejects an arxivId string longer than 200 characters', async () => {
    await assertValidationRejected({ title: 'Valid Title', arxivId: 'x'.repeat(201) }, 'arxivId must be 200 characters or fewer');
  });
});

describe('POST /api/recommendations/add rate limiting', () => {
  it('returns 429 keyed on add-rec with ceiling 20 and never reads the body', async () => {
    const { captured, events, rateLimitCalls, readBodyCount, writes, invalidateCalls } = await invoke({
      body: { title: 'Valid Title' },
      rateLimited: true,
    });

    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The limiter is consulted with this route's own key and ceiling, before the
    // try block, so a throttled request never reads the body or touches a file.
    assert.deepEqual(rateLimitCalls, [{ key: 'add-rec:127.0.0.1', limit: 20 }]);
    assert.equal(readBodyCount, 0, 'the limiter returns before the try block, so the body is never read');
    assert.deepEqual(events, []);
    assert.equal(writes.length, 0);
    assert.deepEqual(invalidateCalls, []);
  });
});

describe('POST /api/recommendations/add outer catch', () => {
  it('returns a 400 with the "Invalid request:" prefix when the stored bibliography cannot be parsed', async () => {
    // A valid body passes every guard and reaches the bibliography read; an
    // unparseable references.yaml makes yaml.load throw, and the throw bubbles to
    // the outer catch as a 400 prefixed with "Invalid request:".
    const { captured, events, writes, invalidateCalls, readBodyCount } = await invoke({
      body: { title: 'A Valid Paper', authors: ['Jane Doe'], year: 2024 },
      rawExistingYaml: '{ unterminated',
    });

    assert.equal(captured.status, 400);
    assert.ok(
      captured.payload.error.startsWith('Invalid request: '),
      `expected an "Invalid request:" prefix, got ${JSON.stringify(captured.payload.error)}`,
    );
    // The read is recorded before the parse throws; nothing is written and the
    // cache is left intact.
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, ['read'], 'the read happens, then yaml.load throws into the outer catch');
    assert.equal(writes.length, 0);
    assert.deepEqual(invalidateCalls, []);
  });
});

describe('POST /api/recommendations/add happy path (baseline)', () => {
  it('returns 201, writes once, then invalidates stats for a fully valid body', async () => {
    // Proves the body shape the rejection tests start from is genuinely valid, so
    // each guard test isolates exactly the one offending field.
    const { captured, events, invalidateCalls, writes } = await invoke({
      body: { title: 'A Brand New Paper', authors: ['Jane Doe'], year: 2024 },
    });

    assert.equal(captured.status, 201);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.key, 'doe2024');
    // Reads the bibliography, writes it once, then invalidates the stats cache
    // AFTER the write, mirroring the invalidate-stats sibling suite.
    assert.deepEqual(events, ['read', 'write', 'invalidate:stats']);
    assert.deepEqual(invalidateCalls, ['stats']);
    assert.equal(writes.length, 1);
  });
});
