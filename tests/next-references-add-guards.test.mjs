import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling import-bibtex suite does, and reuse its ctx-mocking shape. This drives
// POST /api/references (the add-entry handler) directly with a recording
// invalidateCache, an in-memory bibliography read, and a capturing write, so
// there is no network and no real filesystem is touched. The real sanitizeText
// helper is imported from server-utils so the field sanitization runs for real
// rather than being reimplemented here. This is the add-entry route in
// references.js; it is NOT POST /api/references/import-bibtex (research-tools.js)
// and NOT POST /api/recommendations/add, which only shares the "Key already
// exists" wording. This handler does a raw require('js-yaml') plus
// fs.readFileSync / yaml.load / yaml.dump and does NOT use loadReferencesCached,
// so a malformed read becomes a 400 here rather than the {} fallback the cached
// GET handlers give.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');
const yaml = require('js-yaml');
const { sanitizeText } = require('../server/server-utils.js');

const PROJECT_ROOT = '/proj';
const BIB_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// Invoke the add-entry handler with a mocked ctx. `events` records every side
// effect in order: 'read' for each readFileSync, 'write' for each writeFileSync,
// and 'invalidate:<tag>' for each invalidateCache, so a test can pin the exact
// I/O a path performs, including no I/O at all on a rejected request.
// `readBodyCount` proves whether the body was read; `rateLimitCalls` captures the
// limiter key and ceiling. readFileSync returns the YAML for `existingRefs`, or
// `rawExistingYaml` verbatim when supplied (to feed a malformed bibliography).
// writeFileSync is captured in memory and never hits disk. `rateLimited` flips
// the limiter.
async function invoke({ body, existingRefs = {}, rawExistingYaml, rateLimited = false, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/references';
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
    sanitizeText,
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

// Read back the bibliography object handed to the single captured write, after
// asserting there was exactly one write and that it targeted references.yaml.
function savedRefs(writes) {
  assert.equal(writes.length, 1, 'expected exactly one writeFileSync');
  assert.equal(writes[0].file, BIB_PATH, 'write must target bibliography/references.yaml');
  return yaml.load(writes[0].data);
}

describe('POST /api/references add-entry characterization', () => {
  it('returns 429 with the rate-limit error and touches nothing when throttled', async () => {
    const { captured, events, readBodyCount, rateLimitCalls } = await invoke({
      body: { key: 'doe2021', entry: { title: 'T' } },
      rateLimited: true,
    });

    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The limiter is consulted with this route's own key and ceiling, before the
    // try block, so the body is never read and no file is touched.
    assert.deepEqual(rateLimitCalls, [{ key: 'add-ref:127.0.0.1', limit: 20 }]);
    assert.equal(readBodyCount, 0);
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing key or entry when the key is omitted', async () => {
    const { captured, events, readBodyCount } = await invoke({ body: { entry: { title: 'T' } } });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing key or entry' });
    // The body is read inside the try, but validation rejects before any file I/O.
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing key or entry when entry is null (the !entry guard fires first)', async () => {
    // typeof null is 'object', so only the leading !entry guard rejects null;
    // the later typeof-object check is never reached for this input.
    const { captured, events } = await invoke({ body: { key: 'doe2021', entry: null } });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing key or entry' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Invalid key when the key is not a string', async () => {
    const { captured, events } = await invoke({ body: { key: 123, entry: { title: 'T' } } });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Invalid key' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Invalid key when the key exceeds 200 characters', async () => {
    const { captured, events } = await invoke({ body: { key: 'k'.repeat(201), entry: { title: 'T' } } });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Invalid key' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Invalid entry when entry is a non-object', async () => {
    const { captured, events } = await invoke({ body: { key: 'doe2021', entry: 'x' } });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Invalid entry' });
    assert.deepEqual(events, []);
  });

  it('returns 409 Key already exists and reads but never writes when the key is present', async () => {
    const existingRefs = {
      doe2021: { type: 'article', title: 'Already Here', author: ['Old Author'], year: 2000 },
    };
    const { captured, events, writes, invalidateCalls } = await invoke({
      body: { key: 'doe2021', entry: { title: 'New Title' } },
      existingRefs,
    });

    assert.equal(captured.status, 409);
    assert.deepEqual(captured.payload, { error: 'Key already exists' });
    // The handler reads the bibliography to detect the clash, then returns
    // without a write or a cache invalidation.
    assert.deepEqual(events, ['read']);
    assert.equal(writes.length, 0);
    assert.deepEqual(invalidateCalls, []);
  });

  it('returns 409 for a __proto__ key against an empty bibliography and writes nothing', async () => {
    // refs['__proto__'] resolves to Object.prototype (truthy) even on a fresh
    // object, so the existence guard short-circuits to 409 and no prototype
    // pollution write can occur.
    const { captured, events, writes, invalidateCalls } = await invoke({
      body: { key: '__proto__', entry: { title: 'Polluted' } },
      existingRefs: {},
    });

    assert.equal(captured.status, 409);
    assert.deepEqual(captured.payload, { error: 'Key already exists' });
    assert.deepEqual(events, ['read']);
    assert.equal(writes.length, 0);
    assert.deepEqual(invalidateCalls, []);
  });

  it('adds a valid new entry: read, write, then invalidate stats, persisting the sanitized entry', async () => {
    const existingRefs = {
      sibling2019: { type: 'article', title: 'Existing Sibling', author: ['Pat Lee'], year: 2019 },
    };
    const entry = { type: 'article', title: 'A Great Paper', author: ['John Doe', 'Jane Smith'], year: 2024 };
    const { captured, events, invalidateCalls, writes } = await invoke({
      body: { key: 'new2024', entry },
      existingRefs,
    });

    assert.equal(captured.status, 201);
    assert.deepEqual(captured.payload, { success: true });
    // Reads the bibliography, writes it once, then invalidates the stats cache
    // AFTER the write so a write that throws never leaves a fresh cache behind.
    assert.deepEqual(events, ['read', 'write', 'invalidate:stats']);
    assert.deepEqual(invalidateCalls, ['stats']);

    const refs = savedRefs(writes);
    // The new entry is persisted with its sanitized fields, and the pre-existing
    // sibling is preserved untouched.
    assert.deepEqual(refs.new2024, entry);
    assert.deepEqual(refs.sibling2019, existingRefs.sibling2019);
  });

  it('slices string fields to 5000 chars and array fields to 50 elements (each string to 500)', async () => {
    const longTitle = 'a'.repeat(5001);
    const longAuthor = 'b'.repeat(600);
    const authors = [longAuthor, ...Array.from({ length: 59 }, (_, i) => `Author ${i}`)];
    const { captured, events, writes } = await invoke({
      body: { key: 'big2024', entry: { title: longTitle, author: authors, year: 2024 } },
    });

    assert.equal(captured.status, 201);
    assert.deepEqual(events, ['read', 'write', 'invalidate:stats']);

    const refs = savedRefs(writes);
    // String field capped at 5000 characters.
    assert.equal(refs.big2024.title.length, 5000);
    assert.equal(refs.big2024.title, 'a'.repeat(5000));
    // Array capped at 50 elements, and each string element capped at 500 chars.
    assert.equal(refs.big2024.author.length, 50);
    assert.equal(refs.big2024.author[0].length, 500);
    assert.equal(refs.big2024.author[0], 'b'.repeat(500));
    // A short element passes through unchanged.
    assert.equal(refs.big2024.author[1], 'Author 0');
    // The year (a number) is preserved as is.
    assert.equal(refs.big2024.year, 2024);
  });

  it('returns 400 Invalid request and writes nothing when the existing references.yaml is malformed', async () => {
    // A corrupt references.yaml makes yaml.load throw. Unlike import-bibtex, the
    // add-entry handler does NOT fall back to an empty object: the throw bubbles
    // to the outer catch and becomes a 400 with no write and no invalidation.
    const { captured, events, writes, invalidateCalls } = await invoke({
      body: { key: 'novel2023', entry: { title: 'Resilient?' } },
      rawExistingYaml: '{ unterminated',
    });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Invalid request' });
    // The read happens (and is recorded) before the parse throws; nothing is
    // written and the cache is left intact.
    assert.deepEqual(events, ['read']);
    assert.equal(writes.length, 0);
    assert.deepEqual(invalidateCalls, []);
  });
});
