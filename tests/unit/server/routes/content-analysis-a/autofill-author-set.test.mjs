import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do.
// js-yaml is the same parser loadReferencesCached uses, so the fixture is dumped
// and parsed through it, keeping the bytes the handler sees identical to the
// object the oracle below reasons over.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');
const yaml = require('js-yaml');

const PROJECT_ROOT = '/fake/root';

// A references.yaml fixture exercising every branch of GET /api/references/autofill.
// Insertion order is meaningful: Object.entries(refs) walks it in document order,
// so the 3-item cap keeps the FIRST three matches in exactly this sequence.
//
//   src         the primary lookup: shares "Jane Doe" / "Bob Roe" with several
//               candidates in DIFFERING case, and is missing all four fields.
//   srcNoAuthor a lookup with no author list at all (empty suggestions).
//   srcHasType  a lookup that already has `type` (that field is skipped).
//   a1..a5      candidates that share an author with the sources, each carrying a
//               different mix of fields. All five carry `type`; together with
//               srcHasType that is six `type` matches for a `src` query, so `type`
//               overflows the 3-item cap, while venue/doi/url have fewer matches.
//   nomatch     carries every field but shares no author (never suggested).
//   noauthor    carries fields but has no author list (never suggested).
const REFS_OBJ = {
  src: { author: ['Jane Doe', 'Bob Roe'] },
  srcNoAuthor: { title: 'No authors here' },
  srcHasType: { author: ['Jane Doe'], type: 'article' },
  a1: { author: ['jane doe'], type: 'article', venue: 'Venue A', doi: '10.1/a', url: 'http://a' },
  nomatch: { author: ['Zoe Stranger'], type: 'misc', venue: 'Venue Z', doi: '10.9/z', url: 'http://z' },
  a2: { author: ['JANE DOE'], type: 'book', venue: 'Venue B' },
  noauthor: { type: 'dataset', venue: 'Venue N' },
  a3: { author: ['Bob ROE'], type: 'inproceedings', doi: '10.3/c' },
  a4: { author: ['Jane Doe', 'Extra X'], type: 'techreport', venue: 'Venue D', url: 'http://d' },
  a5: { author: ['jane DOE'], type: 'phdthesis' },
};
const REFS_YAML = yaml.dump(REFS_OBJ);
// Parse the fixture back through js-yaml so the oracle reasons over the exact
// object the handler builds from the same bytes.
const REFS_PARSED = yaml.load(REFS_YAML);

// Independent reference computation: the ORIGINAL pre-hoist algorithm, kept here
// verbatim as the ground truth. The handler now hoists the lowercased source
// authors into a Set, and its output must stay byte-identical to this nested
// per-comparison form for every input. (The nested `oa.toLowerCase() ===
// a.toLowerCase()` lives only here in the test, never in the route file.)
function referenceSuggestions(refs, key) {
  const entry = refs[key];
  const suggestions = {};
  const FIELDS = ['type', 'venue', 'doi', 'url'];
  for (const field of FIELDS) {
    if (entry[field]) continue;
    const authors = entry.author || [];
    if (authors.length === 0) continue;
    for (const [otherKey, otherEntry] of Object.entries(refs)) {
      if (otherKey === key || !otherEntry[field]) continue;
      const otherAuthors = otherEntry.author || [];
      if (authors.some(a => otherAuthors.some(oa => oa.toLowerCase() === a.toLowerCase()))) {
        if (!suggestions[field]) suggestions[field] = [];
        if (suggestions[field].length < 3) suggestions[field].push({ value: otherEntry[field], source: otherKey });
      }
    }
  }
  return suggestions;
}

// A minimal fs whose statSync/readFileSync return the fixture, the two calls
// loadReferencesCached makes. readdirSync is present but unused by this handler.
function makeFs(yamlText) {
  return {
    statSync() { return { mtimeMs: 1000, size: yamlText.length }; },
    readFileSync() { return yamlText; },
    readdirSync() { return []; },
  };
}

// Invoke the autofill handler with a mocked ctx, capturing the json(res, status,
// payload) response. Fully in-process: no network, no server.
async function invoke(key) {
  const search = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
  const url = new URL(`http://localhost/api/references/autofill${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  let jsonResp = null;
  const res = {
    writableEnded: false,
    writeHead() { return this; },
    end() { this.writableEnded = true; return this; },
  };
  const ctx = {
    fs: makeFs(REFS_YAML),
    path,
    PROJECT_ROOT,
    json(_res, status, payload) { jsonResp = { status, payload }; res.writableEnded = true; return jsonResp; },
  };
  await routes(req, res, url, '/api/references/autofill', ctx);
  return jsonResp;
}

// loadReferencesCached keeps a module-scope memo of references.yaml, so each test
// starts from a cold cache.
beforeEach(() => { routes._clearReferencesCache(); });

describe('GET /api/references/autofill: hoisted source-author Set', () => {
  it('matches the reference computation across multiple missing fields (case-insensitive)', async () => {
    const r = await invoke('src');
    assert.equal(r.status, 200);
    assert.equal(r.payload.key, 'src');
    assert.deepEqual(r.payload.currentEntry, REFS_PARSED.src);
    // Byte-identical to the independent oracle.
    assert.deepEqual(r.payload.suggestions, referenceSuggestions(REFS_PARSED, 'src'));
    // Every field that the source is missing drew at least one suggestion, so the
    // cross-field match really exercised all four fields, not just one.
    assert.deepEqual(Object.keys(r.payload.suggestions).sort(), ['doi', 'type', 'url', 'venue']);
  });

  it('honors the 3-item cap, keeping the first three matches in Object.entries order', async () => {
    const r = await invoke('src');
    // Six candidates carry `type` and share an author with src (srcHasType, a1,
    // a2, a3, a4, a5), but only the first three in document order survive the cap.
    assert.equal(r.payload.suggestions.type.length, 3);
    assert.deepEqual(r.payload.suggestions.type, [
      { value: 'article', source: 'srcHasType' },
      { value: 'article', source: 'a1' },
      { value: 'book', source: 'a2' },
    ]);
  });

  it('never suggests a non-matching author or an author-less candidate', async () => {
    const r = await invoke('src');
    const sources = Object.values(r.payload.suggestions).flat().map(s => s.source);
    assert.ok(!sources.includes('nomatch'), 'an entry sharing no author is never suggested');
    assert.ok(!sources.includes('noauthor'), 'an entry with no author list is never suggested');
  });

  it('returns empty suggestions for a source with no authors', async () => {
    const r = await invoke('srcNoAuthor');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.suggestions, {});
    assert.deepEqual(r.payload.suggestions, referenceSuggestions(REFS_PARSED, 'srcNoAuthor'));
    assert.equal(Object.keys(r.payload.suggestions).length, 0);
  });

  it('skips a field the source already has', async () => {
    const r = await invoke('srcHasType');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.suggestions, referenceSuggestions(REFS_PARSED, 'srcHasType'));
    // `type` is present on the source, so it is never suggested even though
    // matching candidates exist; the other missing fields still resolve.
    assert.ok(!('type' in r.payload.suggestions), 'an already-present field is skipped');
    assert.deepEqual(Object.keys(r.payload.suggestions).sort(), ['doi', 'url', 'venue']);
  });

  it('never suggests the queried key itself', async () => {
    // Self-exclusion is enforced jointly: the `otherKey === key` guard, and for the
    // same field the `!otherEntry[field]` skip together with the outer
    // `if (entry[field]) continue` (a source that has a field never searches for it,
    // and a source missing a field cannot be its own candidate for it). The hoist
    // touches none of these, so the queried key stays absent from every suggestion
    // list and the whole payload still matches the oracle.
    for (const key of ['src', 'srcHasType']) {
      const r = await invoke(key);
      assert.deepEqual(r.payload.suggestions, referenceSuggestions(REFS_PARSED, key));
      const sources = Object.values(r.payload.suggestions).flat().map(s => s.source);
      assert.ok(!sources.includes(key), `self (${key}) is never suggested`);
    }
  });

  it('validates the request and the key', async () => {
    const missing = await invoke(undefined);
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.payload, { error: 'Missing key' });

    const unknown = await invoke('does-not-exist');
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.payload, { error: 'Reference not found' });
  });
});
