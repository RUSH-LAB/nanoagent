import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const SPECIFIER = '../server/routes/study-knowledge.js';
const studyRoutes = require(SPECIFIER);

// WHAT THIS PINS
// ════════════════════════════════════════════════════════════════════════════
// The SUCCESS (200) path of POST /api/glossary in server/routes/study-knowledge.js
// builds the persisted entry (handler at line 381; entry literal at lines 397-404;
// the 200 return at line 407). Two of its computed fields had zero coverage: the
// only other test that reaches this path, tests/next-glossary-termlower-hoist.test.mjs,
// asserts just term, definition, and id presence. Here we pin the remaining two:
//
//   relatedTerms: Array.isArray(relatedTerms) ? relatedTerms.slice(0, 10).map(t => sanitizeText(t)) : []
//   references:   Array.isArray(references)   ? references.slice(0, 10).map(r => sanitizeText(String(r))) : []
//
// The distinguishing branch: references coerces each element with String(r)
// BEFORE sanitizeText, while relatedTerms does not. So a non-string element
// becomes its stringified form in references but the empty string in
// relatedTerms, because the real sanitizeText returns '' for any non-string.
//
// This is an ADD-ONLY characterization test: no source file is touched. The
// goldens below were captured from the REAL handler (a throwaway probe) and are
// asserted with assert.deepEqual; the clock and random fields (id, createdAt)
// are stripped first because their values are not reproducible.

// Test double for ctx.sanitizeText. The real util (server/server-utils.js) is:
//   sanitizeText(str) => (typeof str !== 'string' ? '' : str.slice(0, 10000))
// We tag the string branch with an "S:" prefix so the handler's per-element
// .map(sanitizeText) is OBSERVABLE in the golden. An identity double (as the
// sibling hoist test uses) could not tell a mapped element from an untouched one.
// We faithfully preserve the real falsy contract, a non-string in gives '' out,
// because that is exactly the branch that separates relatedTerms from references.
// The real slice is omitted: every fixture string here is far shorter than the
// 10000-char cap, so the real util would return it unchanged; the double matches
// the real output on these inputs up to the intentional "S:" tag.
const sanitizeText = (s) => (typeof s === 'string' ? `S:${s}` : '');

// Drive the real POST /api/glossary handler with a minimal mocked ctx and capture
// the (status, payload) handed to json(res, ...). loadJSON returns the supplied
// store by reference so the handler's in-place data.terms.push is observable;
// saveJSON records calls without touching disk. This mirrors the ctx harness of
// tests/next-glossary-termlower-hoist.test.mjs, carrying only the fields the
// POST /api/glossary block reads.
async function invoke({ body, store } = {}) {
  const pathname = '/api/glossary';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  const data = store === undefined ? {} : store;
  let captured = null;
  let saveCalls = 0;
  let savedData = null;
  const ctx = {
    GLOSSARY_FILE: '/tmp/glossary-entry-fields.json',
    rateLimit: () => true,
    readBody: async () => body,
    loadJSON: () => data,
    saveJSON: (_file, d) => { saveCalls++; savedData = d; },
    sanitizeText,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await studyRoutes(req, res, url, pathname, ctx);
  return { captured, data, saveCalls, savedData };
}

// Drive a 200 create and return the persisted entry, asserting the path really is
// the success path so no field assertion downstream is vacuous.
async function createEntry(body, store) {
  const { captured, saveCalls } = await invoke({ body, store });
  assert.equal(captured.status, 200, `expected a 200 create, got ${captured.status}`);
  assert.equal(captured.payload.success, true);
  assert.equal(saveCalls, 1, 'a successful create writes exactly once');
  return captured.payload.entry;
}

describe('POST /api/glossary pins entry.relatedTerms (slice(0,10).map(sanitizeText), no String coercion)', () => {
  it('keeps exactly the first 10 of more than 10 strings, each sanitizeText-mapped', async () => {
    const input = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const entry = await createEntry({ term: 'A', definition: 'd', relatedTerms: input });
    // First 10 only, each carrying the "S:" tag that proves the map ran.
    assert.deepEqual(
      entry.relatedTerms,
      ['S:t0', 'S:t1', 'S:t2', 'S:t3', 'S:t4', 'S:t5', 'S:t6', 'S:t7', 'S:t8', 'S:t9'],
    );
    assert.equal(entry.relatedTerms.length, 10, 'the 11th and 12th inputs are dropped by the slice(0,10)');
  });

  it('does NOT String-coerce a non-string element: it sanitizes to "" (falsy contract)', async () => {
    // The same number becomes its stringified form in references below, but here
    // sanitizeText(42) === '' with no coercion. This pins the divergence.
    const entry = await createEntry({ term: 'A', definition: 'd', relatedTerms: ['ok', 42, 'two'] });
    assert.deepEqual(entry.relatedTerms, ['S:ok', '', 'S:two']);
  });

  it('is [] when relatedTerms is absent from the body', async () => {
    const entry = await createEntry({ term: 'A', definition: 'd' });
    assert.deepEqual(entry.relatedTerms, []);
  });

  it('is [] for every non-array relatedTerms value', async () => {
    for (const notArray of ['nope', 42, { 0: 'x', length: 1 }, null]) {
      const entry = await createEntry({ term: 'A', definition: 'd', relatedTerms: notArray });
      assert.deepEqual(entry.relatedTerms, [], `relatedTerms=${JSON.stringify(notArray)} should yield []`);
    }
  });
});

describe('POST /api/glossary pins entry.references (slice(0,10).map(r => sanitizeText(String(r))))', () => {
  it('keeps exactly the first 10 of more than 10 elements, each String-coerced then sanitizeText-mapped', async () => {
    // 12 elements with a number at index 9 (inside the kept window) so the String
    // coercion is observable: 42 becomes '42' becomes 'S:42'.
    const input = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 42, 'r10', 'r11'];
    const entry = await createEntry({ term: 'A', definition: 'd', references: input });
    assert.deepEqual(
      entry.references,
      ['S:r0', 'S:r1', 'S:r2', 'S:r3', 'S:r4', 'S:r5', 'S:r6', 'S:r7', 'S:r8', 'S:42'],
    );
    assert.equal(entry.references.length, 10, 'the 11th and 12th inputs are dropped by the slice(0,10)');
    assert.equal(entry.references[9], 'S:42', 'the non-string element is stringified before sanitize');
  });

  it('is [] when references is absent from the body', async () => {
    const entry = await createEntry({ term: 'A', definition: 'd' });
    assert.deepEqual(entry.references, []);
  });

  it('is [] for every non-array references value', async () => {
    for (const notArray of [123, 'ref', { 0: 'x', length: 1 }, null]) {
      const entry = await createEntry({ term: 'A', definition: 'd', references: notArray });
      assert.deepEqual(entry.references, [], `references=${JSON.stringify(notArray)} should yield []`);
    }
  });
});

describe('POST /api/glossary pins the relatedTerms vs references coercion difference', () => {
  it('stringifies a non-string in references but empties it in relatedTerms', async () => {
    const entry = await createEntry({
      term: 'A',
      definition: 'd',
      relatedTerms: ['keep', 7],
      references: ['keep', 7],
    });
    assert.deepEqual(entry.relatedTerms, ['S:keep', ''], 'sanitizeText(7) === ""');
    assert.deepEqual(entry.references, ['S:keep', 'S:7'], 'sanitizeText(String(7)) === "S:7"');
  });
});

describe('POST /api/glossary success entry golden (id and createdAt stripped)', () => {
  it('matches the captured golden for the whole computed entry', async () => {
    const entry = await createEntry({
      term: 'Matrix',
      definition: 'A rectangular array of numbers.',
      relatedTerms: ['Vector', 'Tensor'],
      references: ['ref1', 7],
    });

    // The clock and random fields are present and well-formed, but their values
    // are not pinned: id is the generated gl_ identifier and createdAt is an ISO
    // timestamp. Round-tripping createdAt is clock-independent.
    assert.match(entry.id, /^gl_/, 'id is the gl_-prefixed generated identifier');
    assert.equal(typeof entry.createdAt, 'string');
    assert.equal(
      new Date(entry.createdAt).toISOString(),
      entry.createdAt,
      'createdAt is a round-trippable ISO timestamp',
    );

    const { id, createdAt, ...deterministic } = entry;
    assert.deepEqual(deterministic, {
      term: 'S:Matrix',
      definition: 'S:A rectangular array of numbers.',
      relatedTerms: ['S:Vector', 'S:Tensor'],
      references: ['S:ref1', 'S:7'],
    });
  });
});

describe('POST /api/glossary control: 409 duplicate and term/definition sanitize', () => {
  it('rejects a case-insensitive duplicate with 409 and never writes', async () => {
    const store = { terms: [{ id: 'gl_seed', term: 'Vector', definition: 'seed definition' }] };
    const { captured, saveCalls } = await invoke({
      body: { term: 'vector', definition: 'a different definition' },
      store,
    });
    assert.equal(captured.status, 409);
    assert.deepEqual(captured.payload, { error: 'Term already exists' });
    assert.equal(saveCalls, 0, 'a duplicate must not write');
  });

  it('sanitizes term and definition on the success path', async () => {
    const entry = await createEntry({ term: 'Eigenvalue', definition: 'A scalar factor.' });
    assert.equal(entry.term, 'S:Eigenvalue');
    assert.equal(entry.definition, 'S:A scalar factor.');
  });
});
