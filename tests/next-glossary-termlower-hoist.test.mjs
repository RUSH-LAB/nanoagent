import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const SPECIFIER = '../server/routes/study-knowledge.js';
const studyRoutes = require(SPECIFIER);

// WHY THIS HOIST IS BEHAVIOR-PRESERVING
// ──────────────────────────────────────────────────────────────────────────
// The POST /api/glossary duplicate check used to re-lowercase the incoming
// `term` on every iteration of the `.some()` scan:
//     data.terms.some(t => t.term.toLowerCase() === term.toLowerCase())
// `term` is bound once from the request body and is never reassigned before the
// check, and String.prototype.toLowerCase() is a pure, locale-independent
// function, so `term.toLowerCase()` returns the identical string on every
// iteration. Hoisting it into `const termLower = term.toLowerCase()` once and
// comparing `t.term.toLowerCase() === termLower` yields the same boolean for
// every entry, so the 409 duplicate response, the 200 insert path, and the
// empty-`data.terms` path are all unchanged. The per-entry `t.term.toLowerCase()`
// genuinely varies per `t` and is preserved as-is. These tests drive the REAL
// handler to pin that behavior and read the source to pin the hoisted form.

// Drive the real POST /api/glossary handler with a minimal mocked ctx and
// capture the response handed to json(res, status, payload). loadJSON returns
// the supplied store by reference, so the handler's in-place data.terms.push is
// observable through `data` after the call; saveJSON records its calls and the
// object it was handed without touching disk. sanitizeText is identity so the
// persisted entry carries the input term/definition verbatim.
async function invoke({ body, store }) {
  const pathname = '/api/glossary';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store === undefined ? {} : store;
  let captured = null;
  let saveCalls = 0;
  let savedData = null;
  const ctx = {
    path,
    GLOSSARY_FILE: '/tmp/glossary-termlower-hoist.json',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => data,
    saveJSON: (_file, d) => { saveCalls++; savedData = d; },
    sanitizeText: (s) => s,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyRoutes(req, res, url, pathname, ctx);
  return { captured, data, saveCalls, savedData };
}

// A store with one existing term whose canonical casing is "Vector". A fresh
// copy per call so an in-place push in one test never leaks into the next.
const withVector = () => ({
  terms: [{ id: 'gl_seed', term: 'Vector', definition: 'A quantity with magnitude and direction.' }],
});

describe('POST /api/glossary case-insensitive duplicate check (termLower hoisted once)', () => {
  // The incoming term is lowercased once and compared against each entry's own
  // lowercased term, so any casing of an existing term is rejected with 409 and
  // never writes.
  for (const incoming of ['vector', 'VECTOR', 'Vector', 'VeCtOr']) {
    it(`rejects "${incoming}" as a duplicate of "Vector" (409, no write)`, async () => {
      const { captured, data, saveCalls } = await invoke({
        body: { term: incoming, definition: 'A different definition.' },
        store: withVector(),
      });
      assert.equal(captured.status, 409);
      assert.deepEqual(captured.payload, { error: 'Term already exists' });
      assert.equal(saveCalls, 0);
      // The store is untouched: the seed term is still the only entry.
      assert.equal(data.terms.length, 1);
      assert.equal(data.terms[0].term, 'Vector');
    });
  }

  it('adds a genuinely new term (200, success, write with the entry appended)', async () => {
    const { captured, data, saveCalls, savedData } = await invoke({
      body: { term: 'Matrix', definition: 'A rectangular array of numbers.' },
      store: withVector(),
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.ok(captured.payload.entry, 'a 200 carries the created entry');
    assert.equal(captured.payload.entry.term, 'Matrix');
    assert.equal(captured.payload.entry.definition, 'A rectangular array of numbers.');
    assert.ok(captured.payload.entry.id, 'the entry has an id');
    assert.equal(saveCalls, 1);
    // The new entry is appended after the seed, and saveJSON receives that array.
    assert.equal(data.terms.length, 2);
    assert.equal(data.terms[1].term, 'Matrix');
    assert.strictEqual(savedData, data);
  });

  it('adds the term when data.terms is absent (200, terms initialized)', async () => {
    // loadJSON returns {} (no terms key): `if (!data.terms) data.terms = []`
    // initializes it, the `.some()` over [] is false, and the term is added.
    const { captured, data, saveCalls } = await invoke({
      body: { term: 'Tensor', definition: 'A generalization of vectors and matrices.' },
      store: {},
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(captured.payload.entry.term, 'Tensor');
    assert.equal(saveCalls, 1);
    assert.equal(data.terms.length, 1);
    assert.equal(data.terms[0].term, 'Tensor');
  });

  it('adds the term when data.terms is an empty array (200)', async () => {
    const { captured, data, saveCalls } = await invoke({
      body: { term: 'Scalar', definition: 'A single number.' },
      store: { terms: [] },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.payload.success, true);
    assert.equal(saveCalls, 1);
    assert.equal(data.terms.length, 1);
    assert.equal(data.terms[0].term, 'Scalar');
  });
});

describe('POST /api/glossary handler source (the invariant term is lowercased once)', () => {
  // Read the on-disk source and isolate the POST /api/glossary handler block so
  // the assertions cannot be satisfied by another handler. The block runs from
  // the POST guard up to the DELETE guard for the same path.
  const SRC = fs.readFileSync(new URL(SPECIFIER, import.meta.url), 'utf8');
  const start = SRC.indexOf("req.method === 'POST' && pathname === '/api/glossary'");
  const end = SRC.indexOf("req.method === 'DELETE' && pathname === '/api/glossary'", start);
  const block = SRC.slice(start, end);

  it('locates the POST and DELETE glossary handler markers', () => {
    assert.notEqual(start, -1, 'POST /api/glossary handler not found');
    assert.notEqual(end, -1, 'DELETE /api/glossary handler not found');
    assert.ok(end > start, 'the DELETE handler should follow the POST handler');
  });

  it('hoists the incoming term into `const termLower = term.toLowerCase()` once', () => {
    assert.ok(
      block.includes('const termLower = term.toLowerCase()'),
      'expected the hoisted `const termLower = term.toLowerCase()` in the POST handler',
    );
  });

  it('no longer re-lowercases the incoming term inside the .some() scan', () => {
    assert.ok(
      !block.includes('=== term.toLowerCase()'),
      'the per-iteration `=== term.toLowerCase()` dup check must be gone (use termLower)',
    );
  });

  it('preserves the per-entry comparison against the cached termLower', () => {
    assert.ok(
      block.includes('t.term.toLowerCase() === termLower'),
      'the per-entry side must still lowercase each entry and compare against termLower',
    );
  });
});
