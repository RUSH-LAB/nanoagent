import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling add-guards suite does, and reuse its ctx-mocking shape. This drives
// POST /api/references/enrich (the apply-enriched-data handler) directly over a
// mocked ctx with recorders, so there is no network and no real filesystem is
// touched. The whole enrich endpoint was previously uncovered.
//
// Every case here exercises the guard ladder and rejects BEFORE fs.writeFileSync.
// The first four guards (rate limit, missing or invalid key, key too long,
// missing fields object) also reject before fs.readFileSync, so they are fully
// hermetic. The fifth (reference not found) reads the bibliography, finds the key
// absent, and returns 404 without writing. This is the POST enrich handler in
// references.js; it is NOT the GET enrich handler above it (which shells out to
// curl), and it does NOT use loadReferencesCached: it does a raw require('js-yaml')
// plus fs.readFileSync and yaml.load, so the 404 read is deterministic from the
// stubbed YAML string the real js-yaml parses.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');
const { sanitizeText } = require('../server/server-utils.js');

const PROJECT_ROOT = '/proj';

// Invoke the POST enrich handler with a mocked ctx. `events` records every side
// effect in order: 'read' for each readFileSync and 'write' for each
// writeFileSync, so a test can pin the exact I/O a path performs, including no
// I/O at all on a rejected request. Because a write pushes a 'write' event, an
// empty `events` array proves neither a read nor a write happened. `readBodyCount`
// proves whether the body was read; `rateLimitCalls` captures the limiter key and
// ceiling. readFileSync returns `bibYaml` verbatim (a YAML string the real
// js-yaml parses), and writeFileSync is captured in memory and never hits disk.
// `rateLimited` flips the limiter to its throttled state.
async function invoke({ body, bibYaml = '{}', rateLimited = false, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/references/enrich';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };

  let captured = null;
  let readBodyCount = 0;
  const events = [];
  const writes = [];
  const rateLimitCalls = [];

  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    readBody: async () => { readBodyCount += 1; return body; },
    rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return !rateLimited; },
    sanitizeText,
    fs: {
      readFileSync: () => { events.push('read'); return bibYaml; },
      writeFileSync: (file, data) => { events.push('write'); writes.push({ file, data }); },
    },
    path,
    PROJECT_ROOT,
  };

  await routes(req, res, url, pathname, ctx);
  return { captured, events, writes, rateLimitCalls, readBodyCount };
}

describe('POST /api/references/enrich guard ladder characterization', () => {
  it('returns 429 with the rate-limit error and touches nothing when throttled', async () => {
    const { captured, events, writes, readBodyCount, rateLimitCalls } = await invoke({
      body: { key: 'doe2021', fields: { title: 'T' } },
      rateLimited: true,
    });

    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The limiter is consulted with this route's own key and ceiling, before the
    // try block, so the body is never read and no file is touched.
    assert.deepEqual(rateLimitCalls, [{ key: 'enrich-ref:127.0.0.1', limit: 10 }]);
    assert.equal(readBodyCount, 0);
    assert.deepEqual(events, []);
    assert.equal(writes.length, 0);
  });

  it('returns 400 Missing or invalid key when the key is omitted', async () => {
    const { captured, events, readBodyCount, rateLimitCalls } = await invoke({
      body: { fields: { title: 'T' } },
    });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid key' });
    // The limiter passed, the body was read inside the try, then validation
    // rejected before any file I/O.
    assert.deepEqual(rateLimitCalls, [{ key: 'enrich-ref:127.0.0.1', limit: 10 }]);
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing or invalid key when the key is not a string', async () => {
    // A numeric key trips the typeof half of the guard rather than the falsy half.
    const { captured, events, readBodyCount } = await invoke({
      body: { key: 123, fields: { title: 'T' } },
    });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing or invalid key' });
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, []);
  });

  it('returns 400 Key too long when the key exceeds 200 characters', async () => {
    const { captured, events, readBodyCount } = await invoke({
      body: { key: 'k'.repeat(201), fields: { title: 'T' } },
    });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Key too long' });
    // 200 is the boundary; length 201 trips the guard, and the read never happens.
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing fields object when fields is omitted', async () => {
    const { captured, events, readBodyCount } = await invoke({
      body: { key: 'doe2021' },
    });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing fields object' });
    assert.equal(readBodyCount, 1);
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing fields object when fields is a non-object', async () => {
    const { captured, events } = await invoke({
      body: { key: 'doe2021', fields: 'x' },
    });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing fields object' });
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing fields object when fields is an array', async () => {
    // Arrays are typeof 'object', so the explicit Array.isArray check is what
    // rejects them here.
    const { captured, events } = await invoke({
      body: { key: 'doe2021', fields: ['title'] },
    });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing fields object' });
    assert.deepEqual(events, []);
  });

  it('returns 404 with the templated message, reading the bibliography but never writing, when the key is absent', async () => {
    // A valid key and a valid fields object pass every pre-read guard, so the
    // handler reads and parses the bibliography. The stubbed YAML holds a
    // different key, so the lookup misses and the handler returns 404 without
    // writing anything back.
    const { captured, events, writes, readBodyCount } = await invoke({
      body: { key: 'ghost2023', fields: { title: 'A New Title' } },
      bibYaml: 'other: {}\n',
    });

    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Reference "ghost2023" not found' });
    // The read is recorded; nothing is written.
    assert.deepEqual(events, ['read']);
    assert.equal(writes.length, 0);
    assert.equal(readBodyCount, 1);
  });
});
