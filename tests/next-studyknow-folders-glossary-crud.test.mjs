import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// study-knowledge.js is CommonJS; load the real module the way the sibling
// server route tests do (next-pins-crud-guards.test.mjs), so these cases
// exercise the shipped handlers rather than a reimplementation.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

// These four store-CRUD handlers live in routes/study-knowledge.js and each
// reads or writes a data file the handler pulls from ctx. The mocked loadJSON
// below answers only for the file the requested pathname uses, so any stray read
// surfaces as a thrown error instead of silently passing.
const BOOKMARKS_FILE = '/proj/data/bookmarks.json';
const GLOSSARY_FILE = '/proj/data/glossary.json';

// Drive a real handler over a mocked ctx. rateLimit returns a fixed boolean,
// readBody returns the supplied body, loadJSON returns the supplied store by
// reference (keyed to the file the pathname uses), saveJSON records every
// persist call, and json captures the (status, body) the handler hands back.
// sanitizeText is identity so asserted text equals the input verbatim. No real
// filesystem, network, or git is ever touched.
async function run({ method, pathname, query = '', body = {}, doc = {}, rateLimitOk = true }) {
  const saved = [];
  let captured = null;
  const fileForPath = pathname === '/api/bookmarks/folders' ? BOOKMARKS_FILE : GLOSSARY_FILE;
  const ctx = {
    rateLimit: () => rateLimitOk,
    readBody: async () => body,
    loadJSON: (fp) => {
      if (fp === fileForPath) return doc;
      throw new Error(`unexpected loadJSON path: ${fp}`);
    },
    saveJSON: (fp, data) => { saved.push({ fp, data }); },
    sanitizeText: (s) => s,
    BOOKMARKS_FILE,
    GLOSSARY_FILE,
    json: (_res, status, b) => { captured = { status, body: b }; },
  };
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, pathname, ctx);
  return { captured, saved };
}

describe('GET /api/bookmarks/folders', () => {
  it('a populated store echoes the stored folders array', async () => {
    const folders = [
      { id: 'reading-list', name: 'Reading List', createdAt: '2020-01-01T00:00:00.000Z' },
      { id: 'to-cite', name: 'To Cite', createdAt: '2020-01-02T00:00:00.000Z' },
    ];
    const { captured, saved } = await run({
      method: 'GET',
      pathname: '/api/bookmarks/folders',
      doc: { folders },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { folders });
    assert.equal(saved.length, 0);
  });

  it('a store with no folders key returns {folders: []} via the || [] fallback', async () => {
    const { captured, saved } = await run({
      method: 'GET',
      pathname: '/api/bookmarks/folders',
      doc: {},
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { folders: [] });
    assert.equal(saved.length, 0);
  });
});

describe('POST /api/bookmarks/folders guards', () => {
  it('a rate-limited POST returns 429 and never saves', async () => {
    const { captured, saved } = await run({
      method: 'POST',
      pathname: '/api/bookmarks/folders',
      rateLimitOk: false,
      body: { name: 'Anything' },
    });
    assert.equal(captured.status, 429);
    assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
    assert.equal(saved.length, 0);
  });

  it('a missing, empty, or non-string name returns 400 Missing name and never saves', async () => {
    const missing = await run({ method: 'POST', pathname: '/api/bookmarks/folders', body: {} });
    assert.equal(missing.captured.status, 400);
    assert.deepEqual(missing.captured.body, { error: 'Missing name' });
    assert.equal(missing.saved.length, 0);

    // An empty string is falsy, so it trips the same guard as a missing name.
    const empty = await run({ method: 'POST', pathname: '/api/bookmarks/folders', body: { name: '' } });
    assert.equal(empty.captured.status, 400);
    assert.deepEqual(empty.captured.body, { error: 'Missing name' });
    assert.equal(empty.saved.length, 0);

    // A non-string name (here a number) trips the typeof check.
    const nonString = await run({ method: 'POST', pathname: '/api/bookmarks/folders', body: { name: 42 } });
    assert.equal(nonString.captured.status, 400);
    assert.deepEqual(nonString.captured.body, { error: 'Missing name' });
    assert.equal(nonString.saved.length, 0);
  });

  it('a name longer than 200 characters returns 400 and never saves', async () => {
    const { captured, saved } = await run({
      method: 'POST',
      pathname: '/api/bookmarks/folders',
      body: { name: 'n'.repeat(201) },
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Name must be 200 characters or fewer' });
    assert.equal(saved.length, 0);
  });

  it('a duplicate folder slug returns 409 Folder already exists and never saves', async () => {
    // The stored folder has id "reading-list". The incoming name "Reading List"
    // normalizes to that same slug (lowercased, spaces become dashes), so the id
    // collides and the handler rejects it before any write.
    const { captured, saved } = await run({
      method: 'POST',
      pathname: '/api/bookmarks/folders',
      doc: { folders: [{ id: 'reading-list', name: 'Reading List' }] },
      body: { name: 'Reading List' },
    });
    assert.equal(captured.status, 409);
    assert.deepEqual(captured.body, { error: 'Folder already exists' });
    assert.equal(saved.length, 0);
  });

  it('a valid new folder returns 200, saves once, and pins the computed slug id', async () => {
    // An empty doc also exercises the lazy `if (!data.folders) data.folders = []`
    // initialization before the push. The name carries spaces, an uppercase
    // letter, and trailing punctuation to pin the slug regex: it lowercases,
    // collapses each run of non-alphanumerics to a single dash, then strips any
    // leading or trailing dash.
    const { captured, saved } = await run({
      method: 'POST',
      pathname: '/api/bookmarks/folders',
      doc: {},
      body: { name: 'Deep Learning!' },
    });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    const folder = captured.body.folder;
    assert.equal(folder.id, 'deep-learning');
    // sanitizeText is identity here, so the stored name is the input verbatim.
    assert.equal(folder.name, 'Deep Learning!');
    // createdAt is a clock value, so assert only that it is a string.
    assert.equal(typeof folder.createdAt, 'string');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, BOOKMARKS_FILE);
    assert.deepEqual(saved[0].data.folders, [folder]);
  });
});

describe('GET /api/glossary', () => {
  it('an unfiltered list returns all terms sorted by localeCompare with a total', async () => {
    const { captured, saved } = await run({
      method: 'GET',
      pathname: '/api/glossary',
      doc: {
        terms: [
          { id: 't1', term: 'gamma', definition: 'the third' },
          { id: 't2', term: 'alpha', definition: 'the first' },
          { id: 't3', term: 'beta', definition: 'the second' },
        ],
      },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body.terms.map(t => t.term), ['alpha', 'beta', 'gamma']);
    assert.equal(captured.body.total, 3);
    assert.equal(saved.length, 0);
  });

  it('a ?q= query narrows the set to terms matching the term or the definition', async () => {
    const doc = {
      terms: [
        { id: 't1', term: 'alpha', definition: 'def-a' },
        { id: 't2', term: 'beta', definition: 'def-b' },
        { id: 't3', term: 'gamma', definition: 'def-g' },
      ],
    };
    // A term-side match: only "beta" contains the substring "bet".
    const byTerm = await run({ method: 'GET', pathname: '/api/glossary', query: '?q=bet', doc });
    assert.equal(byTerm.captured.status, 200);
    assert.deepEqual(byTerm.captured.body.terms.map(t => t.term), ['beta']);
    assert.equal(byTerm.captured.body.total, 1);

    // A definition-side match: only "gamma" has "def-g" in its definition.
    const byDef = await run({ method: 'GET', pathname: '/api/glossary', query: '?q=def-g', doc });
    assert.equal(byDef.captured.status, 200);
    assert.deepEqual(byDef.captured.body.terms.map(t => t.term), ['gamma']);
    assert.equal(byDef.captured.body.total, 1);
  });

  it('a store with no terms key returns {terms: [], total: 0}', async () => {
    const { captured, saved } = await run({ method: 'GET', pathname: '/api/glossary', doc: {} });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { terms: [], total: 0 });
    assert.equal(saved.length, 0);
  });
});

describe('DELETE /api/glossary', () => {
  it('a missing id returns 400 Missing id and never saves', async () => {
    const { captured, saved } = await run({ method: 'DELETE', pathname: '/api/glossary', body: {} });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Missing id' });
    assert.equal(saved.length, 0);
  });

  it('returns 404 Term not found when the store has no terms key', async () => {
    const { captured, saved } = await run({
      method: 'DELETE',
      pathname: '/api/glossary',
      doc: {},
      body: { id: 'gl_anything' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Term not found' });
    assert.equal(saved.length, 0);
  });

  it('returns 404 Term not found when the id is not present in the list', async () => {
    const { captured, saved } = await run({
      method: 'DELETE',
      pathname: '/api/glossary',
      doc: { terms: [{ id: 'gl_a' }, { id: 'gl_b' }] },
      body: { id: 'gl_missing' },
    });
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'Term not found' });
    assert.equal(saved.length, 0);
  });

  it('a present id returns 200, splices the matching term, and saves once', async () => {
    const { captured, saved } = await run({
      method: 'DELETE',
      pathname: '/api/glossary',
      doc: { terms: [{ id: 'keep1' }, { id: 'drop' }, { id: 'keep2' }] },
      body: { id: 'drop' },
    });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { success: true });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].fp, GLOSSARY_FILE);
    assert.deepEqual(saved[0].data.terms.map(t => t.id), ['keep1', 'keep2']);
  });
});
