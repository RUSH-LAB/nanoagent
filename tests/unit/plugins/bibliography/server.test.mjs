/**
 * plugins/bibliography/server.js: the endpoints the bibliography serves, and
 * the library underneath them.
 *
 * The read endpoints (format, format-all, by-venue, by-author,
 * year-distribution, similar, search), adding and enriching entries, and the
 * multi-source metadata search. Consolidated from the twenty-six per-branch
 * suites that used to cover this, back when it was a core route module named
 * references.js that also answered for the AI assistant; that half is now
 * tests/unit/server/routes/ai.test.mjs.
 *
 * The one outbound path is stubbed rather than reached: metadata search gets a
 * fake https.get.
 */
import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {makeCtx, invoke, mockFs, PROJECT_ROOT, CONTENT_DIR, key, TEST_IDENTITY} from '../../_harness.mjs';

const require = createRequire(import.meta.url);
// A plugin's server module is loaded by path, not by loadRoute: it is not in
// src/server/routes, which is the point of the exercise.
const routes = require('../../../../plugins/bibliography/server.js');
const manifest = require('../../../../plugins/bibliography/plugin.json');
const yaml = require('js-yaml');
const {paperForStorage} = require('../../../../plugins/bibliography/lib/protocol.js');

/**
 * What the server hands this plugin, built from its own manifest so the suite
 * cannot accidentally grant a capability the plugin never asked for.
 */
const BIBLIOGRAPHY = {name: 'bibliography', requires: manifest.requires};

/** The same plugin, with canned JSON per upstream URL instead of the network. */
const sourcedBy = responder => ({
  ...BIBLIOGRAPHY,
  capabilities: {
    fetch: async target => {
      const payload = responder(String(target));
      return payload === undefined
        ? {ok: false, status: 500, json: async () => null}
        : {ok: true, status: 200, json: async () => payload};
    },
  },
});

/** The same plugin, with one method of its content capability made to fail. */
const brokenContent = over => ({
  ...BIBLIOGRAPHY,
  capabilities: api => ({content: {...api.content, ...over}}),
});
const brokenPaperRecords = over => ({
  ...BIBLIOGRAPHY,
  capabilities: api => {
    const records = api.records;
    return {records: {
      collection(name) {
        const collection = records.collection(name);
        return name === 'papers' ? {...collection, ...over} : collection;
      },
    }};
  },
});
const {numericParam} = routes;
const {loadReferences, buildCitation, _resetReferencesCache, cleanBibtexValue} =
  require('../../../../plugins/bibliography/lib/references.js');
// The plugin asks its content capability for the relative path
// 'bibliography/references.yaml', and that capability is rooted at the caller's
// own workspace rather than at the whole content tree, so the fixture lives in
// that workspace: one bibliography per organization, and no request can name
// another's.
const BIB = path.join(CONTENT_DIR, 'bibliography', 'references.yaml');

function storedPapers(ctx) {
  return ctx.scoped.collection('plugin:bibliography:papers').entries(ctx.scopeFor({auth: TEST_IDENTITY}));
}

function fsCtx(files, over = {}) {
  const base = mockFs(files);
  const counts = {read: 0, write: 0, stat: 0};
  const fs = {
    ...base,
    readFileSync: p => { counts.read++; return base.readFileSync(p); },
    writeFileSync: (p, d) => { counts.write++; return base.writeFileSync(p, d); },
    statSync: p => { counts.stat++; return base.statSync(p); },
  };
  const ctx = makeCtx({fs, ...over});
  try {
    const parsed = files[BIB] == null ? {} : (yaml.load(files[BIB]) || {});
    const papers = ctx.scoped.collection('plugin:bibliography:papers');
    for (const [citationKey, entry] of Object.entries(parsed)) {
      papers.put(ctx.scopeFor({auth: TEST_IDENTITY}), citationKey, paperForStorage(entry));
    }
  } catch { /* malformed legacy fixture means no imported database rows */ }
  return {ctx, counts, fs};
}

function bib(entries) {
  return Object.entries(entries).map(([key, e]) => {
    const lines = [`${key}:`];
    for (const [k, v] of Object.entries(e)) {
      if (Array.isArray(v)) {
        if (v.length === 0) lines.push(`  ${k}: []`);
        else { lines.push(`  ${k}:`); for (const item of v) lines.push(`    - ${JSON.stringify(item)}`); }
      } else lines.push(`  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
    }
    // An entry with no fields must serialise as an empty map, not a null value.
    if (lines.length === 1) return `${key}: {}`;
    return lines.join('\n');
  }).join('\n') + '\n';
}

// The memo is module-level state shared with every other handler that reads the
// bibliography, so clear it before each test that depends on its behaviour.
beforeEach(() => _resetReferencesCache());

// ── loadReferences ────────────────────────────────────────────────────────

describe('loadReferences', () => {
  const REFS = bib({a: {title: 'A'}});

  /**
   * A reader whose stat the test controls: the two calls the loader makes, and
   * the same two a plugin's content capability offers.
   */
  function statFs(content, {mtimeMs = 1, size = content?.length ?? 0, noStat = false} = {}) {
    const counts = {read: 0};
    return {
      counts,
      fs: {
        stat: noStat ? undefined : () => ({mtimeMs, size}),
        read() { counts.read++; if (content == null) throw new Error('ENOENT'); return content; },
      },
    };
  }

  it('is exported alongside the route handler', () => {
    assert.equal(typeof loadReferences, 'function');
  });

  it('parses once across two unchanged calls and hands back one shared instance', () => {
    const {fs, counts} = statFs(REFS);
    const first = loadReferences(fs);
    const second = loadReferences(fs);
    assert.equal(counts.read, 1);
    assert.strictEqual(second, first);
  });

  it('re-parses after mtimeMs changes', () => {
    let mtimeMs = 1;
    const counts = {read: 0};
    const fs = {stat: () => ({mtimeMs, size: 10}), read: () => { counts.read++; return bib({a: {title: `T${mtimeMs}`}}); }};
    assert.equal(loadReferences(fs).a.title, 'T1');
    mtimeMs = 2;
    assert.equal(loadReferences(fs).a.title, 'T2');
    assert.equal(counts.read, 2);
  });

  it('re-parses when only the size changes within the same mtime', () => {
    let size = 10;
    const counts = {read: 0};
    const fs = {stat: () => ({mtimeMs: 1, size}), read: () => { counts.read++; return bib({a: {title: `S${size}`}}); }};
    assert.equal(loadReferences(fs).a.title, 'S10');
    size = 20;
    assert.equal(loadReferences(fs).a.title, 'S20');
    assert.equal(counts.read, 2);
  });

  const FALLBACKS = [
    {name: 'a corrupt parse', content: '\tnot: [valid'},
    {name: 'a missing file', content: null},
  ];
  for (const {name, content} of FALLBACKS) {
    it(`returns an empty object and caches nothing for ${name}`, () => {
      const {fs, counts} = statFs(content);
      assert.deepEqual(loadReferences(fs), {});
      loadReferences(fs);
      assert.equal(counts.read, 2, 'the failure is not memoized, so the next call retries');
    });
  }

  it('treats an empty file as an empty object', () => {
    const {fs} = statFs('');
    assert.deepEqual(loadReferences(fs), {});
  });

  it('clears the memo on a failed load, so an earlier stat cannot serve stale data', () => {
    let stat = {mtimeMs: 1, size: 10};
    let content = bib({a: {title: 'First'}});
    const fs = {stat: () => stat, read: () => { if (content == null) throw new Error('ENOENT'); return content; }};
    assert.equal(loadReferences(fs).a.title, 'First');
    // The file changes and the read fails, which must drop the entry.
    stat = {mtimeMs: 2, size: 20};
    content = null;
    assert.deepEqual(loadReferences(fs), {});
    // Now the original stat reappears with different bytes. With the entry
    // dropped this re-reads; a retained entry would answer "First".
    stat = {mtimeMs: 1, size: 10};
    content = bib({a: {title: 'Second'}});
    assert.equal(loadReferences(fs).a.title, 'Second');
  });

  // The stat is best effort, so an fs without statSync falls through to a fresh
  // read every time rather than throwing.
  it('skips the cache entirely when statSync throws', () => {
    const {fs, counts} = statFs(REFS, {noStat: true});
    loadReferences(fs);
    loadReferences(fs);
    assert.equal(counts.read, 2);
  });
});

// ── buildCitation ─────────────────────────────────────────────────────────

describe('buildCitation', () => {
  it('is exported as a module-scope function', () => {
    assert.equal(typeof buildCitation, 'function');
  });

  const CASES = [
    // APA: surname first, initials, serial ampersand before the last author.
    {style: 'apa', name: 'zero authors, leaving a trailing space for an empty venue',
      parts: {authors: [], year: 2020, title: 'T', venue: ''}, want: 'Unknown (2020). T. '},
    {style: 'apa', name: 'a single author as surname plus initials',
      parts: {authors: ['Ada Lovelace'], year: 2020, title: 'T', venue: 'V'}, want: 'Lovelace, A. (2020). T. V.'},
    {style: 'apa', name: 'exactly two authors with a serial ampersand',
      parts: {authors: ['Ada Lovelace', 'Grace Hopper'], year: 2020, title: 'T', venue: 'V'}, want: 'Lovelace, A., & Hopper, G. (2020). T. V.'},
    {style: 'apa', name: 'three authors',
      parts: {authors: ['Ada Lovelace', 'Grace Hopper', 'Alan Turing'], year: 2020, title: 'T', venue: 'V'}, want: 'Lovelace, A., Hopper, G., & Turing, A. (2020). T. V.'},
    {style: 'apa', name: 'a middle name as stacked initials',
      parts: {authors: ['Ada Byron Lovelace', 'Grace Hopper'], year: 2020, title: 'T', venue: 'V'}, want: 'Lovelace, A. B., & Hopper, G. (2020). T. V.'},
    // A mononym has no remaining tokens, so the initials join is empty.
    {style: 'apa', name: 'a mononym, leaving a doubled space',
      parts: {authors: ['Aristotle'], year: 2020, title: 'T', venue: 'V'}, want: 'Aristotle,  (2020). T. V.'},

    // MLA: surname first for the lead author, et al. beyond one.
    {style: 'mla', name: 'zero authors',
      parts: {authors: [], year: 2020, title: 'T', venue: 'V'}, want: 'Unknown. "T." V, 2020.'},
    {style: 'mla', name: 'a single author with the surname first',
      parts: {authors: ['Ada Lovelace'], year: 2020, title: 'T', venue: 'V'}, want: 'Lovelace, Ada. "T." V, 2020.'},
    {style: 'mla', name: 'exactly two authors collapsing to et al.',
      parts: {authors: ['Ada Lovelace', 'Grace Hopper'], year: 2020, title: 'T', venue: 'V'}, want: 'Lovelace, Ada, et al.. "T." V, 2020.'},
    {style: 'mla', name: 'a full first and middle name for a single author',
      parts: {authors: ['Ada Byron Lovelace'], year: 2020, title: 'T', venue: 'V'}, want: 'Lovelace, Ada Byron. "T." V, 2020.'},
    {style: 'mla', name: 'no venue segment',
      parts: {authors: ['Ada Lovelace'], year: 2020, title: 'T', venue: ''}, want: 'Lovelace, Ada. "T." 2020.'},
    {style: 'mla', name: 'a mononym, giving the comma-space-period form',
      parts: {authors: ['Aristotle'], year: 2020, title: 'T', venue: 'V'}, want: 'Aristotle, . "T." V, 2020.'},

    // Chicago is the default arm for every unrecognised style.
    {style: 'chicago', name: 'zero authors, leaving a doubled space for an empty venue',
      parts: {authors: [], year: 2020, title: 'T', venue: ''}, want: 'Unknown. "T."  (2020).'},
    {style: 'chicago', name: 'a single author verbatim',
      parts: {authors: ['Ada Lovelace'], year: 2020, title: 'T', venue: 'V'}, want: 'Ada Lovelace. "T." V (2020).'},
    {style: 'chicago', name: 'many authors joined by commas',
      parts: {authors: ['Ada Lovelace', 'Grace Hopper'], year: 2020, title: 'T', venue: 'V'}, want: 'Ada Lovelace, Grace Hopper. "T." V (2020).'},
    {style: 'harvard', name: 'an unrecognised style falling through to the default',
      parts: {authors: ['Ada Lovelace'], year: 2020, title: 'T', venue: 'V'}, want: 'Ada Lovelace. "T." V (2020).'},
  ];
  for (const {style, name, parts, want} of CASES) {
    it(`${style}: formats ${name}`, () => assert.equal(buildCitation(style, parts), want));
  }
});

// ── Format and format-all ─────────────────────────────────────────────────

// ── Grouping ──────────────────────────────────────────────────────────────

// ── Year distribution ─────────────────────────────────────────────────────

// ── Similar ───────────────────────────────────────────────────────────────

// ── Search ────────────────────────────────────────────────────────────────

describe('numericParam (re-exported)', () => {
  const CASES = [
    {name: 'null falls back to the default', args: [null, 50, 200], want: 50},
    {name: 'an empty string falls back to the default', args: ['', 50, 200], want: 50},
    {name: 'a non-numeric value falls back rather than yielding NaN', args: ['abc', 50, 200], want: 50},
    {name: 'a valid value passes through', args: ['42', 50, 200], want: 42},
    {name: 'a value above the cap is clamped', args: ['9999', 50, 200], want: 200},
    {name: 'the search call-site cap applies too', args: ['9999', 20, 100], want: 100},
  ];
  for (const {name, args, want} of CASES) {
    it(name, () => assert.equal(numericParam(...args), want));
  }
});

// ── Add entry ─────────────────────────────────────────────────────────────

describe('POST /api/references', () => {
  const OK = {key: 'new2024', entry: {title: 'A New Paper', author: ['Ada Lovelace']}};

  it('returns 429 without touching anything', async () => {
    const {ctx, counts} = fsCtx({[BIB]: ''}, {rateLimitAllow: false});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'bibliography:add-ref:127.0.0.1', maxPerMinute: 20}]);
    assert.deepEqual([counts.read, counts.write], [0, 0]);
  });

  const GUARDS = [
    {name: 'an omitted entry', body: {}, error: 'Missing entry'},
    {name: 'a null entry', body: {key: 'k', entry: null}, error: 'Missing entry'},
    {name: 'a non-string key', body: {key: 7, entry: {title: 'T'}}, error: 'Invalid key'},
    {name: 'a key over 200 characters', body: {key: 'k'.repeat(201), entry: {title: 'T'}}, error: 'Invalid key'},
    {name: 'a non-object entry', body: {key: 'k', entry: 'not an object'}, error: 'Invalid entry'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without writing`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: ''});
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  it('returns 409 for an existing key, reading but not writing', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({new2024: {title: 'Existing'}})});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Key already exists'}]);
    assert.equal(counts.read, 0, 'the live duplicate check does not read legacy YAML');
    assert.equal(counts.write, 0);
  });

  it('rejects a prototype-polluting citation key', async () => {
    const {ctx, counts} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references', body: {key: '__proto__', entry: {title: 'T'}}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid key'}]);
    assert.equal(counts.write, 0);
  });

  it('writes the entry then invalidates stats', async () => {
    const {ctx, counts, fs} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references', body: OK, ctx});
    assert.equal(r.status, 201);
    assert.equal(r.payload.success, true);
    assert.equal(r.payload.key, 'new2024');
    assert.equal(r.payload.entry.schema, 'mochi.paper/2');
    assert.equal(counts.write, 0);
    // The write capability drops the server's content-derived caches; the
    // plugin never names them.
    assert.ok(ctx.calls.invalidateCache.includes(key('stats')));
    assert.ok(ctx.calls.invalidateCache.includes(key('search')));
    assert.equal(storedPapers(ctx).new2024.title, 'A New Paper');
  });

  it('slices string fields to 5000 characters and arrays to 50 entries of 500', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const entry = {title: 't'.repeat(6000), author: Array.from({length: 60}, () => 'a'.repeat(600)), year: 2024, flag: true};
    await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references', body: {key: 'k', entry}, ctx});
    const written = storedPapers(ctx);
    assert.equal(written.k.title.length, 5000);
    assert.equal(written.k.author.length, 50);
    assert.equal(written.k.author[0].length, 500);
    // Only protocol fields are retained.
    assert.equal(written.k.year, 2024);
    assert.equal(written.k.flag, undefined);
  });

  it('generates a citation key when the caller omits one', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      method: 'POST',
      path: '/api/references',
      body: {entry: {title: 'A New Paper', author: ['Ada Lovelace'], year: 2024}},
      ctx,
    });
    assert.equal(r.status, 201);
    assert.equal(r.payload.key, 'lovelace2024');
  });

  it('creates from the database even when the legacy mirror is malformed', async () => {
    const {ctx, counts} = fsCtx({[BIB]: '\tnot: [valid'});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references', body: OK, ctx});
    assert.equal(r.status, 201);
    assert.equal(r.payload.key, 'new2024');
    assert.equal(counts.write, 0);
  });
});

// ── Draft toggle ──────────────────────────────────────────────────────────

describe('GET /api/metadata/search', () => {
  /**
   * A stand-in for the network capability: canned JSON per URL, and undefined
   * for a source that is down. The plugin is handed this exactly as the server
   * hands it the real one, so the test drives the boundary rather than reaching
   * around it into node:https.
   */
  const withSources = responder => ({
    ...BIBLIOGRAPHY,
    capabilities: {
      fetch: async (target) => {
        const payload = responder(String(target));
        return payload === undefined
          ? {ok: false, status: 500, json: async () => null}
          : {ok: true, status: 200, json: async () => payload};
      },
    },
  });

  const S2 = {data: [{title: 'Attention Is All You Need', authors: [{name: 'Ashish Vaswani'}, {name: 'N. Shazeer'}], year: 2017, venue: 'NeurIPS', externalIds: {DOI: '10.1/x', ArXiv: '1706.03762'}, url: 'https://s2/x'}]};
  const CROSSREF = {message: {items: [{title: ['Attention Is All You Need'], author: [{given: 'Ashish', family: 'Vaswani'}], published: {'date-parts': [[2017]]}, 'container-title': ['NIPS'], DOI: '10.1/x', URL: 'https://cr/x'}]}};
  const DBLP = {result: {hits: {hit: [{info: {title: 'Attention Is All You Need', authors: {author: [{text: 'Ashish Vaswani'}, 'Noam Shazeer']}, year: '2017', venue: 'NIPS', doi: '10.1/x', ee: 'https://dblp/x', type: 'Conference', pages: '5998-6008', volume: '30'}}]}}};

  const respond = (over = {}) => url =>
    url.includes('semanticscholar') ? ('s2' in over ? over.s2 : S2) :
    url.includes('crossref') ? ('crossref' in over ? over.crossref : CROSSREF) :
    ('dblp' in over ? over.dblp : DBLP);

  it('returns 400 when the query is missing', async () => {
    const r = await invoke(routes, {plugin: withSources(() => undefined), path: '/api/metadata/search'});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing query'}]);
  });

  it('collects per-source results and one merged record', async () => {
    const r = await invoke(routes, {plugin: withSources(respond()), path: '/api/metadata/search', query: {q: 'attention'}});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.results.map(x => x.source), ['semanticscholar', 'crossref', 'dblp']);
    assert.equal(r.payload.merged.title, 'Attention Is All You Need');
    assert.equal(r.payload.merged.year, 2017);
    // The merge strips the source discriminator.
    assert.equal('source' in r.payload.merged, false);
    assert.equal(r.payload.paper.schema, 'mochi.paper/2');
    assert.equal(r.payload.paper.source.type, 'doi');
    assert.equal(r.payload.paper.source.provider, 'crossref');
    assert.equal(r.payload.paper.officialUrl, 'https://doi.org/10.1/x');
    assert.equal(r.payload.paper.pdfUrl, 'https://arxiv.org/pdf/1706.03762.pdf');
  });

  it('deduplicates authors across name formats, keeping the fuller spelling', async () => {
    const r = await invoke(routes, {plugin: withSources(respond()), path: '/api/metadata/search', query: {q: 'attention'}});
    assert.ok(r.payload.merged.authors.includes('Ashish Vaswani'));
    assert.equal(r.payload.merged.authors.filter(a => a.toLowerCase().includes('vaswani')).length, 1);
  });

  it('normalises a single-author DBLP hit delivered as an object', async () => {
    const single = {result: {hits: {hit: [{info: {title: 'Solo', authors: {author: {text: 'Ada Lovelace'}}, year: '2020'}}]}}};
    const r = await invoke(routes, {plugin: withSources(respond({s2: undefined, crossref: undefined, dblp: single})), path: '/api/metadata/search', query: {q: 'solo'}});
    const [rec] = r.payload.results;
    assert.deepEqual([rec.source, rec.authors], ['dblp', ['Ada Lovelace']]);
  });

  it('still merges when a source is unavailable', async () => {
    const r = await invoke(routes, {plugin: withSources(respond({crossref: undefined})), path: '/api/metadata/search', query: {q: 'attention'}});
    assert.deepEqual(r.payload.results.map(x => x.source), ['semanticscholar', 'dblp']);
    assert.equal(r.payload.merged.title, 'Attention Is All You Need');
  });

  it('stays pollution-safe against a hostile upstream key', async () => {
    const hostile = {result: {hits: {hit: [{info: {title: 'X', __proto__: {polluted: true}, authors: {author: 'A'}}}]}}};
    const r = await invoke(routes, {plugin: withSources(respond({s2: undefined, crossref: undefined, dblp: hostile})), path: '/api/metadata/search', query: {q: 'x'}});
    assert.equal(r.status, 200);
    assert.equal({}.polluted, undefined);
  });
});

// ── Enrich ────────────────────────────────────────────────────────────────

describe('GET /api/references/enrich', () => {
  const REFS = {withTitle: {title: 'A Paper'}, noTitle: {year: 2020}};

  it('returns 400 without a key, touching neither the bibliography nor curl', async () => {
    let curls = 0;
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)}, {execFileSync: () => { curls++; return '{}'; }});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/enrich', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing key param'}]);
    assert.deepEqual([counts.read, curls], [0, 0]);
  });

  it('returns a templated 404 for an unknown key, never curling', async () => {
    let curls = 0;
    const {ctx} = fsCtx({[BIB]: bib(REFS)}, {execFileSync: () => { curls++; return '{}'; }});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/enrich', query: {key: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference "nope" not found'}]);
    assert.equal(curls, 0);
  });

  it('returns 400 when the entry carries no title, never curling', async () => {
    let curls = 0;
    const {ctx} = fsCtx({[BIB]: bib(REFS)}, {execFileSync: () => { curls++; return '{}'; }});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/enrich', query: {key: 'noTitle'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Reference has no title to search for'}]);
    assert.equal(curls, 0);
  });

  it('parses each source and returns the merged record', async () => {
    const responses = {
      semanticscholar: {data: [{title: 'A Paper', authors: [{name: 'Ada Lovelace'}], year: 2020, venue: 'V', externalIds: {DOI: '10.1/x'}, citationCount: 5, referenceCount: 2, tldr: {text: 'summary'}}]},
      crossref: {message: {items: [{title: ['A Paper'], author: [{given: 'Ada', family: 'Lovelace'}], DOI: '10.1/x', publisher: 'Pub'}]}},
      dblp: {result: {hits: {hit: [{info: {title: 'A Paper', authors: {author: 'Ada Lovelace'}, year: '2020', venue: 'V'}}]}}},
    };
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const plugin = sourcedBy(url => responses[
      url.includes('semanticscholar') ? 'semanticscholar' : url.includes('crossref') ? 'crossref' : 'dblp'
    ]);
    const r = await invoke(routes, {plugin, path: '/api/references/enrich', query: {key: 'withTitle'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.key, 'withTitle');
    assert.equal(r.payload.current.title, REFS.withTitle.title);
    assert.equal(r.payload.current.schema, 'mochi.paper/2');
    assert.equal(r.payload.sources.semanticScholar.tldr, 'summary');
    assert.equal(r.payload.sources.crossref.publisher, 'Pub');
    assert.deepEqual(r.payload.sources.dblp.authors, ['Ada Lovelace']);
    assert.equal(r.payload.merged.title, 'A Paper');
  });

  it('nulls a source that returns nothing usable', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const plugin = {...BIBLIOGRAPHY, capabilities: {fetch: async () => { throw new Error('upstream unreachable'); }}};
    const r = await invoke(routes, {plugin, path: '/api/references/enrich', query: {key: 'withTitle'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.sources, {semanticScholar: null, crossref: null, dblp: null});
  });

  it('is unaffected when the retired legacy mirror is unreadable', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {plugin: brokenContent({read() { throw new Error('boom'); }}), path: '/api/references/enrich', query: {key: 'withTitle'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.current.title, 'A Paper');
  });
});

describe('POST /api/references/enrich', () => {
  const REFS = {k: {title: 'Old Title', year: 2000}};
  const OK = {key: 'k', fields: {title: 'New Title'}};

  it('returns 429 without touching anything', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)}, {rateLimitAllow: false});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/enrich', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'bibliography:enrich-ref:127.0.0.1', maxPerMinute: 10}]);
    assert.deepEqual([counts.read, counts.write], [0, 0]);
  });

  const GUARDS = [
    {name: 'an omitted key', body: {fields: {}}, status: 400, error: 'Missing or invalid key'},
    {name: 'a non-string key', body: {key: 7, fields: {}}, status: 400, error: 'Missing or invalid key'},
    {name: 'a key over 200 characters', body: {key: 'k'.repeat(201), fields: {}}, status: 400, error: 'Key too long'},
    {name: 'an omitted fields object', body: {key: 'k'}, status: 400, error: 'Missing fields object'},
    {name: 'a non-object fields', body: {key: 'k', fields: 'x'}, status: 400, error: 'Missing fields object'},
    {name: 'an array fields', body: {key: 'k', fields: []}, status: 400, error: 'Missing fields object'},
    {name: 'an unknown key', body: {key: 'nope', fields: {title: 'T'}}, status: 404, error: 'Reference "nope" not found'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without writing`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/enrich', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  it('merges only allowed, non-null fields and writes once', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
    const fields = {title: 'New Title', doi: '10.1/x', notAllowed: 'ignored', year: null, author: ['Ada Lovelace']};
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/enrich', body: {key: 'k', fields}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.entry.title, 'New Title');
    assert.equal(r.payload.entry.doi, '10.1/x');
    assert.deepEqual(r.payload.entry.author, ['Ada Lovelace']);
    assert.equal('notAllowed' in r.payload.entry, false);
    // A null value is skipped, so the existing year survives.
    assert.equal(r.payload.entry.year, 2000);
    assert.equal(counts.write, 0);
  });

  it('slices string fields to 5000 characters and arrays to 50 entries of 500', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const fields = {title: 't'.repeat(6000), author: Array.from({length: 60}, () => 'a'.repeat(600))};
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/enrich', body: {key: 'k', fields}, ctx});
    assert.equal(r.payload.entry.title.length, 5000);
    assert.equal(r.payload.entry.author.length, 50);
    assert.equal(r.payload.entry.author[0].length, 500);
  });

  for (const [label, readBody] of [
    ['readBody rejects', async () => { throw new Error('bad json'); }],
    ['readBody resolves null', async () => null],
  ]) {
    it(`returns a prefixed 400 when ${label}, before any filesystem IO`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: bib(REFS)}, {readBody});
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/enrich', ctx});
      assert.equal(r.status, 400);
      assert.ok(r.payload.error.startsWith('Invalid request: '));
      assert.deepEqual([counts.read, counts.write], [0, 0]);
    });
  }
});

// Moved here with the handler, out of the feeds route suite.
describe('GET /api/references', () => {
  it('serves normalized references from scoped database records', async () => {
    const {ctx} = fsCtx({[BIB]: 'smith2020:\n  title: A Paper\n'});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references', ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.references.smith2020.title, 'A Paper');
    assert.equal(r.payload.references.smith2020.schema, 'mochi.paper/2');
    assert.deepEqual(r.payload.references.smith2020.tags, []);
    assert.equal(r.payload.references.smith2020.source.type, 'manual');
  });

  it('serves a small sorted window for the library page', async () => {
    const {ctx} = fsCtx({[BIB]: bib({
      old: {title: 'Old systems paper', year: 2020, tags: ['systems']},
      newest: {title: 'Newest systems paper', year: 2025, tags: ['systems', 'favorite']},
      middle: {title: 'Middle learning paper', year: 2023, tags: ['ml']},
    })});
    const first = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      path: '/api/references',
      query: {limit: 1},
      ctx,
    });
    assert.deepEqual(Object.keys(first.payload.references), ['newest']);
    assert.equal(first.payload.total, 3);
    assert.equal(first.payload.libraryTotal, 3);
    assert.equal(first.payload.hasMore, true);
    assert.deepEqual(first.payload.tags, ['favorite', 'ml', 'systems']);

    const filtered = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      path: '/api/references',
      query: {limit: 40, q: 'paper', tag: 'systems'},
      ctx,
    });
    assert.deepEqual(Object.keys(filtered.payload.references), ['newest', 'old']);
    assert.equal(filtered.payload.total, 2);
    assert.equal(filtered.payload.hasMore, false);
  });

  it('serves a compact aggregate for dashboards', async () => {
    const {ctx} = fsCtx({[BIB]: bib({
      article: {title: 'Article', type: 'article', year: 2024},
      book: {title: 'Book', type: 'book', year: 2024},
      misc: {title: 'Undated'},
    })});
    const r = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      path: '/api/references',
      query: {summary: 1},
      ctx,
    });
    assert.deepEqual(r.payload, {
      total: 3,
      byType: {article: 1, book: 1, misc: 1},
      byYear: {2024: 2},
    });
  });

  it('serves one paper without transferring the whole library', async () => {
    const {ctx} = fsCtx({[BIB]: bib({
      wanted: {title: 'Wanted Paper'},
      other: {title: 'Other Paper'},
    })});
    const found = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/item/wanted', ctx});
    assert.equal(found.status, 200);
    assert.equal(found.payload.entry.title, 'Wanted Paper');
    assert.equal(found.payload.entry.key, 'wanted');

    const missing = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/item/missing', ctx});
    assert.deepEqual([missing.status, missing.payload], [404, {error: 'Reference not found'}]);
  });

  // Any stat, read or parse failure yields {}, so a missing or corrupt file
  // still serves an empty map rather than a 500.
  const FALLBACKS = [
    {name: 'an empty file', files: {[BIB]: ''}},
    {name: 'corrupt YAML', files: {[BIB]: '\tnot: [valid'}},
    {name: 'a missing file', files: {}},
  ];
  for (const {name, files} of FALLBACKS) {
    it(`returns an empty map for ${name}`, async () => {
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references', ctx: makeCtx({fs: mockFs(files)})});
      assert.deepEqual([r.status, r.payload], [200, {references: {}}]);
    });
  }
});

describe('PATCH /api/references/:key', () => {
  const REFS = {
    paper2024: {
      title: 'A Paper',
      author: ['Ada Lovelace'],
      year: 2024,
      url: 'https://example.test/paper',
    },
  };

  it('updates tags and the two paper links through the protocol', async () => {
    const {ctx, fs} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      method: 'PATCH',
      path: '/api/references/paper2024',
      body: {
        tags: ['Theory', ' theory ', 'Read next'],
        officialUrl: 'https://doi.org/10.1/paper',
        pdfUrl: 'https://example.test/paper.pdf',
      },
      ctx,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.entry.tags, ['Theory', 'Read next']);
    assert.equal(r.payload.entry.officialUrl, 'https://doi.org/10.1/paper');
    assert.equal(r.payload.entry.pdfUrl, 'https://example.test/paper.pdf');
    const saved = storedPapers(ctx);
    assert.equal(saved.paper2024.schema, 'mochi.paper/2');
    assert.deepEqual(saved.paper2024.tags, ['Theory', 'Read next']);
  });

  it('returns 404 for a missing paper', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      method: 'PATCH',
      path: '/api/references/missing',
      body: {tags: ['x']},
      ctx,
    });
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference not found'}]);
  });
});

// Moved here with the handler, out of the misc-tools suite.
// In-memory fs over a content tree keyed by absolute path; the bibliography
// lives inside it, at content/bibliography/references.yaml.
// readdirSync and readFileSync are counted so a test can prove the second request
// is served from cache. Mirrors makeFs in tests/next-citations-cache.test.mjs.
function makeFs(tree, root) {
  const dirs = new Map();
  const files = new Map();
  (function walk(node, dirPath) {
    const entries = [];
    for (const [name, val] of Object.entries(node)) {
      const fp = path.join(dirPath, name);
      if (typeof val === 'string') { entries.push({ name, dir: false }); files.set(fp, val); }
      else { entries.push({ name, dir: true }); walk(val, fp); }
    }
    dirs.set(dirPath, entries);
  })(tree, root);

  const counts = { readdir: 0, read: 0 };
  const fsMock = {
    readdirSync(dir) {
      counts.readdir++;
      const entries = dirs.get(dir);
      if (!entries) throw new Error(`ENOENT readdir ${dir}`);
      return entries.map(e => ({ name: e.name, isDirectory: () => e.dir }));
    },
    readFileSync(fp) {
      counts.read++;
      if (files.has(fp)) return files.get(fp);
      throw new Error(`ENOENT read ${fp}`);
    },
  };
  return { fsMock, counts };
}

// A memoizing cached(key, ttl, fn) that also records every (key, ttlMs) pair so a
// test can pin the exact cache key and TTL. Permanent memo (TTL ignored): the
// tests issue back-to-back calls, so the hit is deterministic without a clock.
// Mirrors makeCached in tests/next-citations-cache.test.mjs.
function makeCached() {
  const store = new Map();
  const calls = [];
  function cached(key, ttlMs, fn) {
    calls.push({ key, ttlMs });
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  }
  cached.calls = calls;
  return cached;
}

// What the impact scan treats as content, matching the server's own list.
const ALLOWED_EXTS = ['.md', '.mdx'];

// Turn an array of {key, title, year, venue} rows into the bibliography text the
// real js-yaml parses. Real YAML text, real library (per the task: feed YAML, do
// not mock js-yaml).
function impactBib(rows) {
  const lines = [];
  for (const e of rows) {
    lines.push(`${e.key}:`);
    lines.push(`  title: ${e.title}`);
    lines.push(`  year: ${e.year}`);
    lines.push(`  venue: ${e.venue}`);
  }
  lines.push('');
  return lines.join('\n');
}

function impactFixture(entries, content = {}) {
  return { content: { ...content, bibliography: { 'references.yaml': impactBib(entries) } } };
}

async function invokeImpact(fsMock, cached) {
  const url = new URL('http://localhost/api/references/impact');
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: fsMock, path, PROJECT_ROOT, ALLOWED_EXTS, cached,
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/references/impact', ctx);
  return captured;
}
// The citation matcher moved out of content-analysis-b with the reading-order
// handler that drives it. A shared /g regex carries lastIndex between calls, so
// what matters is that there is exactly one of it and the handler resets it.
describe('READING_ORDER_CITE_RE', () => {
  it('matches its canonical literal and is one shared instance', () => {
    const canonical = /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g;
    assert.equal(routes.READING_ORDER_CITE_RE.source, canonical.source);
    assert.equal(routes.READING_ORDER_CITE_RE.flags, canonical.flags);
    assert.strictEqual(
      require('../../../../plugins/bibliography/server.js').READING_ORDER_CITE_RE,
      routes.READING_ORDER_CITE_RE,
    );
  });
});

describe('GET /api/references/track', () => {
  const REFS = {plain: {title: 'Plain', venue: 'V'}, withUrl: {title: 'WithUrl', url: 'https://arxiv.org/abs/2301.12345'}};

  for (const [label, query] of [['an omitted key', {}], ['an empty key', {key: ''}]]) {
    it(`returns 400 for ${label}, touching no files`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/track', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing key param'}]);
      assert.equal(counts.read, 0);
    });
  }

  it('returns 404 for a key absent from the bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/track', query: {key: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference not found'}]);
  });

  it('reports no arXiv id for an entry with neither an id nor an arXiv url', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/track', query: {key: 'plain'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {published: false, error: 'No arXiv ID found for this reference'}]);
  });

  it('pulls the arXiv id out of the url and reports an entry still on arXiv', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    let asked = null;
    const plugin = sourcedBy(target => { asked = target; return {venue: 'ArXiv', year: 2023, externalIds: {}}; });
    const r = await invoke(routes, {plugin, path: '/api/references/track', query: {key: 'withUrl'}, ctx});
    assert.match(asked, /arXiv:2301\.12345/);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      published: false, venue: null, doi: null, journal: null, year: 2023,
      currentVenue: null, tracked: false, publishedVenue: null,
    });
  });

  it('reports an entry that has since been published in a real venue', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const plugin = sourcedBy(() => ({venue: 'NeurIPS', year: 2023, externalIds: {DOI: '10.1/x'}, journal: 'J'}));
    const r = await invoke(routes, {plugin, path: '/api/references/track', query: {key: 'withUrl'}, ctx});
    assert.deepEqual(r.payload, {
      published: true, venue: 'NeurIPS', doi: '10.1/x', journal: 'J', year: 2023,
      currentVenue: null, tracked: false, publishedVenue: null,
    });
  });

  it('returns 502 when the catalogue is unreachable', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const plugin = {...BIBLIOGRAPHY, capabilities: {fetch: async () => { throw new Error('down'); }}};
    const r = await invoke(routes, {plugin, path: '/api/references/track', query: {key: 'withUrl'}, ctx});
    assert.deepEqual([r.status, r.payload], [502, {error: 'Failed to reach Semantic Scholar API'}]);
  });

  it('memoizes the bibliography parse across two requests', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
    await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/track', query: {key: 'plain'}, ctx});
    const after = counts.read;
    await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/track', query: {key: 'plain'}, ctx});
    assert.equal(counts.read, after, 'the second lookup reuses the shared memo');
  });

  // The memo swallows a broken bibliography and returns {}, so the handler
  // re-reads on an empty result to preserve the original 500.
  const FALLBACKS = [
    {name: 'a broken parse', files: {[BIB]: '\tnot: [valid'}, status: 404, error: 'Reference not found'},
    {name: 'a missing file', files: {}, status: 404, error: 'Reference not found'},
    {name: 'an empty but valid bibliography', files: {[BIB]: ''}, status: 404, error: 'Reference not found'},
  ];
  for (const {name, files, status, error} of FALLBACKS) {
    it(`returns ${status} for ${name}`, async () => {
      const {ctx} = fsCtx(files);
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/track', query: {key: 'plain'}, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
    });
  }
});

describe('POST /api/references/track', () => {
  const REFS = {plain: {title: 'Plain', venue: 'V'}, withUrl: {title: 'WithUrl', url: 'https://arxiv.org/abs/2301.12345'}};

  it('returns 429 with the track-ref key, never reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/track', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'bibliography:track-ref:127.0.0.1', maxPerMinute: 10}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an omitted key', body: {}, status: 400, error: 'Missing or invalid key'},
    {name: 'a non-string key', body: {key: 7}, status: 400, error: 'Missing or invalid key'},
    {name: 'a key absent from the bibliography', body: {key: 'nope'}, status: 404, error: 'Reference not found'},
    {name: 'an entry with no arXiv id', body: {key: 'plain'}, status: 400, error: 'No arXiv ID found for this reference'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`rejects ${name} without writing`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/track', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  it('records the published venue against the entry the arXiv url identifies', async () => {
    const {ctx, counts, fs} = fsCtx({[BIB]: bib(REFS)});
    const plugin = sourcedBy(() => ({venue: 'NeurIPS', year: 2023, externalIds: {DOI: '10.1/x'}}));
    const r = await invoke(routes, {plugin, method: 'POST', path: '/api/references/track', body: {key: 'withUrl'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(counts.write, 0);
    const written = JSON.stringify(storedPapers(ctx));
    assert.ok(written.includes('NeurIPS'), 'the venue is written back');
  });

  it('treats an unreadable legacy mirror as an empty initial database', async () => {
    const base = mockFs({[BIB]: bib(REFS)});
    let writes = 0;
    const fs = {...base, readFileSync() { throw new Error('unreadable'); }, writeFileSync() { writes++; }};
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/track', body: {key: 'plain'}, ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference not found'}]);
    assert.equal(writes, 0);
  });
});

describe('POST /api/references/track-all', () => {
  it('returns 429 with the track-all key at limit 2, before any IO', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({a: {title: 'A'}})}, {rateLimitAllow: false});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/track-all', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'bibliography:track-all:127.0.0.1', maxPerMinute: 2}]);
    assert.equal(counts.read, 0);
  });

  it('treats an unreadable legacy mirror as an empty initial database', async () => {
    const base = mockFs({[BIB]: bib({a: {title: 'A'}})});
    let writes = 0;
    const fs = {...base, readFileSync() { throw new Error('unreadable'); }, writeFileSync() { writes++; }};
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/track-all', ctx: makeCtx({fs})});
    assert.deepEqual([r.status, r.payload], [200, {checked: 0, updated: 0, results: []}]);
    assert.equal(writes, 0);
  });

  it('checks every entry whose url carries an arXiv id, and only those', async () => {
    const {ctx} = fsCtx({[BIB]: bib({
      plain: {title: 'Plain', venue: 'V'},
      withUrl: {title: 'WithUrl', url: 'https://arxiv.org/abs/2301.12345'},
    })});
    const asked = [];
    const plugin = sourcedBy(target => { asked.push(target); return {venue: 'NeurIPS', year: 2023, externalIds: {}}; });
    const r = await invoke(routes, {plugin, method: 'POST', path: '/api/references/track-all', ctx});
    assert.equal(r.status, 200);
    assert.equal(asked.length, 1, 'the entry with no arXiv id is never asked about');
    assert.match(asked[0], /arXiv:2301\.12345/);
    assert.equal(r.payload.checked, 1);
  });

  it('reports nothing checked when no entry carries an arXiv id', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({a: {title: 'A', venue: 'V'}})});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/track-all', ctx});
    assert.deepEqual([r.status, r.payload], [200, {checked: 0, updated: 0, results: []}]);
    assert.equal(counts.write, 0);
  });
});

describe('POST /api/references/import-bibtex', () => {
  const ARTICLE = '@article{smith2020,\n  title = {A Paper},\n  author = {Ada Lovelace},\n  year = {2020},\n  journal = {Nature},\n  url = {http://x},\n  doi = {10.1/x},\n  pages = {1-10},\n  volume = {5}\n}';
  const PROCEEDINGS = '@inproceedings{jones2021,\n  title = {Another},\n  booktitle = {NeurIPS},\n  year = {2021}\n}';

  it('returns 429 without touching anything', async () => {
    const {ctx, counts} = fsCtx({[BIB]: ''}, {rateLimitAllow: false});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/import-bibtex', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual([counts.read, counts.write], [0, 0]);
  });

  const GUARDS = [
    {name: 'an omitted bibtex field', body: {}, error: 'Missing bibtex string'},
    {name: 'a non-string bibtex field', body: {bibtex: 7}, error: 'Missing bibtex string'},
    {name: 'input larger than 500KB', body: {bibtex: 'x'.repeat(500001)}, error: 'BibTeX input too large (max 500KB)'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: ''});
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/import-bibtex', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  it('adds an article, writing once and invalidating stats', async () => {
    const {ctx, counts, fs} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: ARTICLE}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {added: 1, skipped: 0, errors: []}]);
    assert.equal(counts.write, 0);
    // The write capability drops the server's content-derived caches; the
    // plugin never names them.
    assert.ok(ctx.calls.invalidateCache.includes(key('stats')));
    assert.ok(ctx.calls.invalidateCache.includes(key('search')));
    const written = JSON.stringify(storedPapers(ctx));
    for (const token of ['smith2020', 'A Paper', 'Nature', '10.1/x', '1-10']) assert.ok(written.includes(token), token);
  });

  it('maps the entry type and takes the venue from booktitle', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: PROCEEDINGS}, ctx});
    const written = JSON.stringify(storedPapers(ctx));
    assert.ok(written.includes('inproceedings'));
    assert.ok(written.includes('NeurIPS'));
  });

  it('prefers journal over booktitle when an entry carries both', async () => {
    const both = '@article{both2022,\n  title = {Both},\n  journal = {Nature},\n  booktitle = {NeurIPS}\n}';
    const {ctx} = fsCtx({[BIB]: ''});
    await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: both}, ctx});
    const written = JSON.stringify(storedPapers(ctx));
    assert.ok(written.includes('Nature'));
    assert.equal(written.includes('NeurIPS'), false);
  });

  it('skips an entry whose key already exists while still adding the new one', async () => {
    const {ctx} = fsCtx({[BIB]: bib({smith2020: {title: 'Existing'}})});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: `${ARTICLE}\n\n${PROCEEDINGS}`}, ctx});
    assert.deepEqual(r.payload, {added: 1, skipped: 1, errors: []});
  });

  it('writes nothing when every entry is a duplicate', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({smith2020: {title: 'Existing'}})});
    await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references', ctx});
    ctx.calls.invalidateCache.length = 0;
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: ARTICLE}, ctx});
    assert.deepEqual(r.payload, {added: 0, skipped: 1, errors: []});
    assert.equal(counts.write, 0);
    assert.deepEqual(ctx.calls.invalidateCache, []);
  });

  it('still imports when the existing bibliography is malformed YAML', async () => {
    const {ctx} = fsCtx({[BIB]: '\tnot: [valid'});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: ARTICLE}, ctx});
    assert.deepEqual(r.payload, {added: 1, skipped: 0, errors: []});
  });

  it('reports a per-entry error when the record write throws', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const plugin = brokenPaperRecords({put() { throw new Error('database unavailable'); }});
    const r = await invoke(routes, {plugin, method: 'POST', path: '/api/references/import-bibtex', body: {bibtex: ARTICLE}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.added, 0);
    assert.match(r.payload.errors[0].error, /database unavailable/);
  });
});

// ── BibTeX export ─────────────────────────────────────────────────────────

describe('GET /api/references/export', () => {
  const REFS = {
    art: {type: 'article', title: 'An Article', author: ['Ada Lovelace', 'Grace Hopper'], year: 2020, venue: 'Nature', doi: '10.1/x', volume: '5', pages: '1-10'},
    proc: {type: 'inproceedings', title: 'A Paper', venue: 'NeurIPS', url: 'http://x'},
    book: {type: 'book', title: 'A Book', venue: 'Some Press'},
    typeless: {title: 'No Type', venue: 'Somewhere'},
    weird: {type: 'phdthesis', title: 'A Thesis', venue: 'A University'},
  };

  it('emits one entry per reference, mapping the venue field by type', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/export', ctx});
    const body = r.written.body;
    assert.ok(body.includes('@article{art,'));
    assert.ok(body.includes('  journal = {Nature}'));
    assert.ok(body.includes('  author = {Ada Lovelace and Grace Hopper}'));
    assert.ok(body.includes('  volume = {5}'));
    assert.ok(body.includes('  pages = {1-10}'));
    assert.ok(body.includes('@inproceedings{proc,'));
    assert.ok(body.includes('  booktitle = {NeurIPS}'));
    assert.ok(body.includes('  publisher = {Some Press}'), 'a book uses publisher');
    // An unknown type passes through verbatim; a missing one defaults to misc.
    assert.ok(body.includes('@phdthesis{weird,'));
    assert.ok(body.includes('@misc{typeless,'));
  });

  it('sends the BibTeX content type and attachment headers', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/export', ctx});
    assert.deepEqual(r.written.headers, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="references.bib"',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
  });

  it('escapes LaTeX specials in every field', async () => {
    const {ctx} = fsCtx({[BIB]: bib({k: {type: 'misc', title: 'Cost & 50% of x_1'}})});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/export', ctx});
    assert.ok(r.written.body.includes('title = {Cost \\& 50\\% of x\\_1}'));
  });

  it('memoizes the parse across two exports', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
    await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/export', ctx});
    const after = counts.read;
    await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/export', ctx});
    assert.equal(counts.read, after);
  });

  it('returns an empty bib for an empty but valid bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/export', ctx});
    assert.equal(r.written.status, 200);
    assert.equal(r.written.body, '\n');
  });

  // Once records are authoritative, a missing or malformed legacy mirror is
  // simply an empty initial import and export still succeeds.
  for (const [label, files] of [['a broken parse', {[BIB]: '\tnot: [valid'}], ['a missing file', {}]]) {
    it(`returns a prefixed 500 for ${label}`, async () => {
      const {ctx} = fsCtx(files);
      const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references/export', ctx});
      assert.equal(r.written.status, 200);
      assert.equal(r.written.body, '\n');
    });
  }
});

// ── cleanBibtexValue, moved here with the BibTeX export it serves ──────────────────────────────────────────────────────

describe('cleanBibtexValue', () => {
  const CASES = [
    {name: 'ampersand, underscore and percent', input: 'A & B_c 50%', want: 'A \\& B\\_c 50\\%'},
    {name: 'dollar, hash and braces', input: '$5 #1 {x}', want: '\\$5 \\#1 \\{x\\}'},
    // Tilde and caret are accent commands on their own, so they take the
    // explicit text forms rather than a bare backslash.
    {name: 'tilde and caret as text commands', input: 'a~b c^d', want: 'a\\textasciitilde{}b c\\textasciicircum{}d'},
    {name: 'a literal backslash', input: 'a\\b', want: 'a\\textbackslash{}b'},
    // One regex pass over the original means an introduced backslash is never
    // re-escaped by a later replacement.
    {name: 'without double-escaping what it introduces', input: '&', want: '\\&'},
    {name: 'several specials together', input: 'A&B_C%D$E#F{G}H~I^J', want: 'A\\&B\\_C\\%D\\$E\\#F\\{G\\}H\\textasciitilde{}I\\textasciicircum{}J'},
    {name: 'collapsing whitespace runs and trimming', input: '  a   b\n\tc  ', want: 'a b c'},
    {name: 'ordinary text untouched', input: 'Plain title here', want: 'Plain title here'},
    {name: 'null coerced to empty', input: null, want: ''},
    {name: 'undefined coerced to empty', input: undefined, want: ''},
    {name: 'a number coerced to its digits', input: 2024, want: '2024'},
  ];
  for (const {name, input, want} of CASES) {
    it(`escapes ${name}`, () => assert.equal(cleanBibtexValue(input), want));
  }

  it('produces a compile-safe field line for a messy value', () => {
    // The braces in \\textasciitilde{} and friends are part of the escape, so
    // this pins the whole output rather than scanning for bare specials.
    const out = cleanBibtexValue('Cost & benefit: 50% of x_1 {sic} ~approx ^2 \\path');
    assert.equal(out, 'Cost \\& benefit: 50\\% of x\\_1 \\{sic\\} \\textasciitilde{}approx \\textasciicircum{}2 \\textbackslash{}path');
  });
});
