import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load it via createRequire the way the sibling
// ctx-injection suite (next-recadd-invalidate-stats) does, and reuse its
// ctx-mocking shape. This drives POST /api/references/import-bibtex directly with
// a recording invalidateCache, an in-memory bibliography read, and a capturing
// write, so there is no network and no real filesystem is touched. The real
// parseBibtex / parseBibtexAuthors / mapBibtexEntryType / sanitizeText helpers are
// imported from server-utils so the add and skip accounting is exercised for real
// rather than reimplemented here.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/research-tools.js');
const yaml = require('js-yaml');
const {
  parseBibtex,
  parseBibtexAuthors,
  mapBibtexEntryType,
  sanitizeText,
} = require('../server/server-utils.js');

const PROJECT_ROOT = '/proj';
const BIB_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// Invoke the import-bibtex handler with a mocked ctx. `events` records every side
// effect in order: 'read' for each readFileSync, 'write' for each writeFileSync,
// and 'invalidate:<tag>' for each invalidateCache. A test can therefore pin the
// exact I/O a path performs, including no I/O at all on a rejected request.
// readFileSync returns the YAML for `existingRefs`, or `rawExistingYaml` verbatim
// when supplied (to feed a malformed bibliography). writeFileSync is captured in
// memory and never hits disk. `rateLimited` flips the limiter.
async function invoke({ body, existingRefs = {}, rawExistingYaml, rateLimited = false }) {
  const pathname = '/api/references/import-bibtex';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };

  let captured = null;
  const events = [];
  const invalidateCalls = [];
  const writes = [];
  const existingYaml = rawExistingYaml !== undefined ? rawExistingYaml : yaml.dump(existingRefs, { lineWidth: -1 });

  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    readBody: async () => body,
    rateLimit: () => !rateLimited,
    sanitizeText,
    parseBibtex,
    parseBibtexAuthors,
    mapBibtexEntryType,
    invalidateCache(tag) { invalidateCalls.push(tag); events.push(`invalidate:${tag}`); },
    fs: {
      readFileSync: () => { events.push('read'); return existingYaml; },
      writeFileSync: (file, data) => { events.push('write'); writes.push({ file, data }); },
    },
    path,
    PROJECT_ROOT,
  };

  await routes(req, res, url, pathname, fullCtx);
  return { captured, events, invalidateCalls, writes };
}

// Read back the bibliography object handed to the single captured write, after
// asserting there was exactly one write and that it targeted references.yaml.
function savedRefs(writes) {
  assert.equal(writes.length, 1, 'expected exactly one writeFileSync');
  assert.equal(writes[0].file, BIB_PATH, 'write must target bibliography/references.yaml');
  return yaml.load(writes[0].data);
}

describe('POST /api/references/import-bibtex characterization', () => {
  it('returns 429 with the rate-limit error and touches nothing when throttled', async () => {
    const { captured, events } = await invoke({
      body: { bibtex: '@article{a2020, title={T}}' },
      rateLimited: true,
    });

    assert.equal(captured.status, 429);
    assert.deepEqual(captured.payload, { error: 'Too many requests. Try again in a minute.' });
    // The throttled request returns before any file read, write, or invalidation.
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing bibtex string when the body has no bibtex field', async () => {
    const { captured, events } = await invoke({ body: {} });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing bibtex string' });
    // Validation rejects before any file I/O (no read and no write).
    assert.deepEqual(events, []);
  });

  it('returns 400 Missing bibtex string when bibtex is a number, not a string', async () => {
    const { captured, events } = await invoke({ body: { bibtex: 123 } });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing bibtex string' });
    assert.deepEqual(events, []);
  });

  it('returns 400 when the BibTeX input is larger than 500KB', async () => {
    const tooBig = 'x'.repeat(500001);
    const { captured, events } = await invoke({ body: { bibtex: tooBig } });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'BibTeX input too large (max 500KB)' });
    // The size guard rejects before parsing or reading the bibliography.
    assert.deepEqual(events, []);
  });

  it('adds a new article entry, writes once, and invalidates stats after the write', async () => {
    const bibtex = [
      '@article{doe2021,',
      '  title = {A Great Paper},',
      '  author = {John Doe and Jane Smith},',
      '  year = {2021},',
      '  journal = {Journal of Testing}',
      '}',
    ].join('\n');

    const { captured, events, writes } = await invoke({ body: { bibtex } });

    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { added: 1, skipped: 0, errors: [] });

    // Reads the bibliography, writes it once, then invalidates the stats cache
    // AFTER the write so a write that throws never leaves a fresh cache behind.
    assert.deepEqual(events, ['read', 'write', 'invalidate:stats']);

    const refs = savedRefs(writes);
    assert.deepEqual(refs.doe2021, {
      type: 'article',
      title: 'A Great Paper',
      author: ['John Doe', 'Jane Smith'],
      year: 2021,
      venue: 'Journal of Testing',
    });
  });

  it('maps the entry type to inproceedings and takes the venue from booktitle', async () => {
    const bibtex = [
      '@inproceedings{lee2019,',
      '  title = {Conference Paper},',
      '  author = {Lee, Sang and Kim, Min},',
      '  year = {2019},',
      '  booktitle = {Proceedings of Testing}',
      '}',
    ].join('\n');

    const { captured, events, writes } = await invoke({ body: { bibtex } });

    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { added: 1, skipped: 0, errors: [] });
    assert.deepEqual(events, ['read', 'write', 'invalidate:stats']);

    const refs = savedRefs(writes);
    // "Last, First" author syntax is reordered to "First Last"; the type is mapped
    // and the venue is sourced from booktitle for proceedings.
    assert.deepEqual(refs.lee2019, {
      type: 'inproceedings',
      title: 'Conference Paper',
      author: ['Sang Lee', 'Min Kim'],
      year: 2019,
      venue: 'Proceedings of Testing',
    });
  });

  it('skips an entry whose key already exists while still adding the new one', async () => {
    const existingRefs = {
      doe2021: { type: 'article', title: 'Already Here', author: ['Old Author'], year: 2000 },
    };
    const bibtex = [
      '@article{doe2021,',
      '  title = {Duplicate Key Different Title},',
      '  author = {John Doe},',
      '  year = {2021}',
      '}',
      '@article{smith2022,',
      '  title = {Brand New Work},',
      '  author = {Jane Smith},',
      '  year = {2022}',
      '}',
    ].join('\n');

    const { captured, events, writes } = await invoke({ body: { bibtex }, existingRefs });

    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { added: 1, skipped: 1, errors: [] });
    assert.deepEqual(events, ['read', 'write', 'invalidate:stats']);

    const refs = savedRefs(writes);
    // The pre-existing entry is preserved untouched, not overwritten by the
    // duplicate-key import row.
    assert.deepEqual(refs.doe2021, existingRefs.doe2021);
    // A new entry with no journal or booktitle carries no venue field.
    assert.deepEqual(refs.smith2022, {
      type: 'article',
      title: 'Brand New Work',
      author: ['Jane Smith'],
      year: 2022,
    });
  });

  it('adds nothing and performs no write or invalidation when every entry is a duplicate', async () => {
    const existingRefs = {
      doe2021: { type: 'article', title: 'Already Here', author: ['Old Author'], year: 2000 },
    };
    const bibtex = [
      '@article{doe2021,',
      '  title = {Same Key},',
      '  author = {John Doe},',
      '  year = {2021}',
      '}',
    ].join('\n');

    const { captured, events } = await invoke({ body: { bibtex }, existingRefs });

    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { added: 0, skipped: 1, errors: [] });
    // A fully duplicate batch reads the bibliography but, with nothing new to
    // store, performs no write and no cache invalidation.
    assert.deepEqual(events, ['read']);
  });

  it('still imports a new entry when the existing bibliography is malformed YAML', async () => {
    const bibtex = [
      '@article{novel2023,',
      '  title = {Resilient Import},',
      '  author = {Sam Park},',
      '  year = {2023}',
      '}',
    ].join('\n');

    // A corrupt references.yaml makes the YAML parse throw; the handler swallows
    // it, falls back to an empty set, and still imports the new entry.
    const { captured, events, writes } = await invoke({ body: { bibtex }, rawExistingYaml: '{ unterminated' });

    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { added: 1, skipped: 0, errors: [] });
    assert.deepEqual(events, ['read', 'write', 'invalidate:stats']);

    const refs = savedRefs(writes);
    // The unparseable prior content is dropped; only the freshly imported entry
    // remains.
    assert.deepEqual(Object.keys(refs), ['novel2023']);
    assert.deepEqual(refs.novel2023, {
      type: 'article',
      title: 'Resilient Import',
      author: ['Sam Park'],
      year: 2023,
    });
  });
});
