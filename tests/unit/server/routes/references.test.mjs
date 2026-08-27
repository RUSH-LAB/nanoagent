/**
 * server/routes/references.js: the bibliography read endpoints (format,
 * format-all, by-venue, by-author, year-distribution, similar, search), adding
 * and enriching entries, the draft toggle, the AI writing assistant, and the
 * multi-source metadata search.
 *
 * Consolidated from the twenty-six per-branch suites that used to cover this
 * module. Two outbound paths are stubbed rather than reached: metadata search
 * gets a fake https.get, and the AI assistant a fake global fetch.
 */
import {describe, it, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {loadRoute, makeCtx, invoke, mockFs, PROJECT_ROOT} from '../../_harness.mjs';

const routes = loadRoute('references');
const {numericParam, loadReferencesCached, buildCitation, _resetReferencesCache} = routes;
const at = rel => path.join(PROJECT_ROOT, rel);
const BIB = at('bibliography/references.yaml');

function fsCtx(files, over = {}) {
  const base = mockFs(files);
  const counts = {read: 0, write: 0, stat: 0};
  const fs = {
    ...base,
    readFileSync: p => { counts.read++; return base.readFileSync(p); },
    writeFileSync: (p, d) => { counts.write++; return base.writeFileSync(p, d); },
    statSync: p => { counts.stat++; return base.statSync(p); },
  };
  return {ctx: makeCtx({fs, ...over}), counts, fs};
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

// ── loadReferencesCached ──────────────────────────────────────────────────

describe('loadReferencesCached', () => {
  const REFS = bib({a: {title: 'A'}});

  /** A minimal fs whose stat values the test controls directly. */
  function statFs(content, {mtimeMs = 1, size = content?.length ?? 0, noStat = false} = {}) {
    const counts = {read: 0};
    return {
      counts,
      fs: {
        statSync() { if (noStat) throw new Error('no statSync'); return {mtimeMs, size}; },
        readFileSync() { counts.read++; if (content == null) throw new Error('ENOENT'); return content; },
      },
    };
  }

  it('is exported alongside the route handler', () => {
    assert.equal(typeof loadReferencesCached, 'function');
  });

  it('parses once across two unchanged calls and hands back one shared instance', () => {
    const {fs, counts} = statFs(REFS);
    const first = loadReferencesCached(fs, path, PROJECT_ROOT);
    const second = loadReferencesCached(fs, path, PROJECT_ROOT);
    assert.equal(counts.read, 1);
    assert.strictEqual(second, first);
  });

  it('re-parses after mtimeMs changes', () => {
    let mtimeMs = 1;
    const counts = {read: 0};
    const fs = {statSync: () => ({mtimeMs, size: 10}), readFileSync: () => { counts.read++; return bib({a: {title: `T${mtimeMs}`}}); }};
    assert.equal(loadReferencesCached(fs, path, PROJECT_ROOT).a.title, 'T1');
    mtimeMs = 2;
    assert.equal(loadReferencesCached(fs, path, PROJECT_ROOT).a.title, 'T2');
    assert.equal(counts.read, 2);
  });

  it('re-parses when only the size changes within the same mtime', () => {
    let size = 10;
    const counts = {read: 0};
    const fs = {statSync: () => ({mtimeMs: 1, size}), readFileSync: () => { counts.read++; return bib({a: {title: `S${size}`}}); }};
    assert.equal(loadReferencesCached(fs, path, PROJECT_ROOT).a.title, 'S10');
    size = 20;
    assert.equal(loadReferencesCached(fs, path, PROJECT_ROOT).a.title, 'S20');
    assert.equal(counts.read, 2);
  });

  const FALLBACKS = [
    {name: 'a corrupt parse', content: '\tnot: [valid'},
    {name: 'a missing file', content: null},
  ];
  for (const {name, content} of FALLBACKS) {
    it(`returns an empty object and caches nothing for ${name}`, () => {
      const {fs, counts} = statFs(content);
      assert.deepEqual(loadReferencesCached(fs, path, PROJECT_ROOT), {});
      loadReferencesCached(fs, path, PROJECT_ROOT);
      assert.equal(counts.read, 2, 'the failure is not memoized, so the next call retries');
    });
  }

  it('treats an empty file as an empty object', () => {
    const {fs} = statFs('');
    assert.deepEqual(loadReferencesCached(fs, path, PROJECT_ROOT), {});
  });

  it('clears the memo on a failed load, so an earlier stat cannot serve stale data', () => {
    let stat = {mtimeMs: 1, size: 10};
    let content = bib({a: {title: 'First'}});
    const fs = {statSync: () => stat, readFileSync: () => { if (content == null) throw new Error('ENOENT'); return content; }};
    assert.equal(loadReferencesCached(fs, path, PROJECT_ROOT).a.title, 'First');
    // The file changes and the read fails, which must drop the entry.
    stat = {mtimeMs: 2, size: 20};
    content = null;
    assert.deepEqual(loadReferencesCached(fs, path, PROJECT_ROOT), {});
    // Now the original stat reappears with different bytes. With the entry
    // dropped this re-reads; a retained entry would answer "First".
    stat = {mtimeMs: 1, size: 10};
    content = bib({a: {title: 'Second'}});
    assert.equal(loadReferencesCached(fs, path, PROJECT_ROOT).a.title, 'Second');
  });

  // The stat is best effort, so an fs without statSync falls through to a fresh
  // read every time rather than throwing.
  it('skips the cache entirely when statSync throws', () => {
    const {fs, counts} = statFs(REFS, {noStat: true});
    loadReferencesCached(fs, path, PROJECT_ROOT);
    loadReferencesCached(fs, path, PROJECT_ROOT);
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

describe('GET /api/references/format and /format-all', () => {
  const REFS = {
    zed: {title: 'Zed Paper', year: 2021, venue: 'V2', author: ['Ada Lovelace']},
    alpha: {title: 'Alpha Paper', year: 2020, venue: 'V1', author: ['Grace Hopper', 'Alan Turing']},
    bare: {title: 'Bare Paper'},
  };
  const withRefs = () => fsCtx({[BIB]: bib(REFS)});

  it('returns 400 for /format without a key, never reading the bibliography', async () => {
    const {ctx, counts} = withRefs();
    const r = await invoke(routes, {path: '/api/references/format', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing key'}]);
    assert.equal(counts.read, 0);
  });

  it('returns 404 for an unknown key', async () => {
    const {ctx} = withRefs();
    const r = await invoke(routes, {path: '/api/references/format', query: {key: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference not found'}]);
  });

  it('defaults to the apa style when none is supplied', async () => {
    const {ctx} = withRefs();
    const r = await invoke(routes, {path: '/api/references/format', query: {key: 'zed'}, ctx});
    assert.equal(r.payload.style, 'apa');
    assert.equal(r.payload.formatted, buildCitation('apa', {authors: ['Ada Lovelace'], year: 2021, title: 'Zed Paper', venue: 'V2'}));
    assert.deepEqual(r.payload.entry, REFS.zed);
  });

  // Both handlers route through the same buildCitation, so they must agree.
  for (const key of ['zed', 'alpha', 'bare']) {
    for (const style of ['apa', 'mla', 'chicago']) {
      it(`/format and /format-all agree for ${key} in ${style}`, async () => {
        const one = await invoke(routes, {path: '/api/references/format', query: {key, style}, ctx: withRefs().ctx});
        const all = await invoke(routes, {path: '/api/references/format-all', query: {style}, ctx: withRefs().ctx});
        const fromAll = all.payload.references.find(x => x.key === key).citation;
        assert.equal(one.payload.formatted, fromAll);
        const e = REFS[key];
        assert.equal(fromAll, buildCitation(style, {
          authors: e.author || [], year: e.year || 'n.d.', title: e.title || '', venue: e.venue || '',
        }));
      });
    }
  }

  it('/format-all returns the envelope sorted by citation text', async () => {
    const {ctx} = withRefs();
    const r = await invoke(routes, {path: '/api/references/format-all', query: {style: 'apa'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.style, 'apa');
    assert.equal(r.payload.total, 3);
    const citations = r.payload.references.map(x => x.citation);
    assert.deepEqual(citations, [...citations].sort((a, b) => a.localeCompare(b)));
  });

  // /format-all dereferences every entry, so a structurally null one throws
  // into its catch. /format checks `!entry` first, so the same bibliography
  // gives it a 404 instead; its 500 seam is the non-string author below.
  it('/format-all returns 500 on a structurally broken entry', async () => {
    const {ctx} = fsCtx({[BIB]: 'broken:\n'});
    const r = await invoke(routes, {path: '/api/references/format-all', ctx});
    assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Format failed'}, opts: undefined}]);
  });

  it('/format returns 404, not 500, for a structurally null entry', async () => {
    const {ctx} = fsCtx({[BIB]: 'broken:\n'});
    const r = await invoke(routes, {path: '/api/references/format', query: {key: 'broken'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference not found'}]);
  });

  it('/format returns 500 when an author is not a string', async () => {
    // buildCitation calls .split on each author, so a numeric one throws.
    const {ctx} = fsCtx({[BIB]: 'k:\n  title: "T"\n  author:\n    - 7\n'});
    const r = await invoke(routes, {path: '/api/references/format', query: {key: 'k'}, ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Format failed'}]);
  });
});

// ── Grouping ──────────────────────────────────────────────────────────────

describe('GET /api/references/by-venue', () => {
  it('groups by venue, sorting papers by year descending and venues by count', async () => {
    const refs = {
      a: {title: 'A', year: 2020, venue: 'NeurIPS', author: ['Ada']},
      b: {title: 'B', year: 2024, venue: 'NeurIPS'},
      c: {title: 'C', venue: 'NeurIPS'},
      d: {title: 'D', year: 2022, venue: 'Nature'},
      e: {title: 'E', year: 2021},
    };
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/by-venue', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.venues.map(v => [v.venue, v.count]), [['NeurIPS', 3], ['Nature', 1], ['Unknown', 1]]);
    assert.equal(r.payload.totalVenues, 3);
    // A missing year sorts as 0, so it lands last.
    assert.deepEqual(r.payload.venues[0].papers.map(p => p.key), ['b', 'a', 'c']);
    assert.deepEqual(r.payload.venues[0].papers[1], {key: 'a', title: 'A', year: 2020, authors: ['Ada']});
  });

  for (const [label, content] of [['a structurally null entry', 'broken:\n'], ['an unreadable file', null]]) {
    it(`returns 500 for ${label}`, async () => {
      const {ctx} = content === null
        ? {ctx: makeCtx({fs: {statSync() { throw new Error('x'); }, readFileSync() { throw new Error('x'); }}, path: {join() { throw new Error('boom'); }}})}
        : fsCtx({[BIB]: content});
      const r = await invoke(routes, {path: '/api/references/by-venue', ctx});
      assert.equal(r.status, 500);
      assert.ok(r.payload.error.startsWith('Failed to group references by venue'));
      assert.equal(r.replies.some(x => x.payload && 'venues' in x.payload), false);
    });
  }
});

describe('GET /api/references/by-author', () => {
  const REFS = {
    a: {title: 'A', year: 2020, venue: 'V', author: ['Ada Lovelace', 'Grace Hopper']},
    b: {title: 'B', year: 2024, author: ['Ada Lovelace']},
    c: {title: 'C', year: 2021},
    d: {title: 'D', year: 2022, author: []},
  };

  it('groups by author, folding author-less entries into Unknown', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/by-author', ctx});
    assert.equal(r.status, 200);
    // The count sort is stable, so the two groups tied at 1 keep the order in
    // which they were first created: Grace Hopper during entry a, Unknown at c.
    assert.deepEqual(r.payload.authors.map(a => [a.author, a.count]), [
      ['Ada Lovelace', 2], ['Grace Hopper', 1], ['Unknown', 1],
    ]);
    assert.equal(r.payload.totalAuthors, 3);
    assert.deepEqual(r.payload.authors[0].papers.map(p => p.key), ['b', 'a'], 'papers sort by year descending');
    assert.deepEqual(r.payload.authors[0].papers[1], {key: 'a', title: 'A', year: 2020, venue: 'V'});
  });

  // An empty array is truthy, so it short-circuits the UNKNOWN_AUTHORS fallback
  // and then contributes nothing, since the loop body never runs.
  it('treats an empty author array as contributing no author group', async () => {
    const {ctx} = fsCtx({[BIB]: bib({only: {title: 'Only', author: []}})});
    const r = await invoke(routes, {path: '/api/references/by-author', ctx});
    assert.deepEqual(r.payload.authors, []);
  });

  const LIMITS = [
    {name: 'absent, giving the default of 50', query: {}, want: 3},
    {name: 'valid', query: {limit: '1'}, want: 1},
    {name: 'over the cap, clamped to 200', query: {limit: '9999'}, want: 3},
    {name: 'non-numeric, falling back to the default', query: {limit: 'abc'}, want: 3},
  ];
  for (const {name, query, want} of LIMITS) {
    it(`handles a limit that is ${name}`, async () => {
      const {ctx} = fsCtx({[BIB]: bib(REFS)});
      const r = await invoke(routes, {path: '/api/references/by-author', query, ctx});
      assert.equal(r.payload.authors.length, want);
      assert.equal(r.payload.totalAuthors, 3, 'the total is never truncated');
    });
  }

  it('clamps an over-cap limit to two hundred authors', async () => {
    const refs = Object.fromEntries(Array.from({length: 300}, (_, i) => [`k${i}`, {title: 'T', author: [`Author ${i}`]}]));
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/by-author', query: {limit: '9999'}, ctx});
    assert.equal(r.payload.authors.length, 200);
    assert.equal(r.payload.totalAuthors, 300);
  });

  it('returns 500 on a structurally broken entry', async () => {
    const {ctx} = fsCtx({[BIB]: 'broken:\n'});
    const r = await invoke(routes, {path: '/api/references/by-author', ctx});
    assert.equal(r.status, 500);
    assert.ok(r.payload.error.startsWith('Failed to group references by author'));
  });
});

// ── Year distribution ─────────────────────────────────────────────────────

describe('GET /api/references/year-distribution', () => {
  it('aggregates years ascending and the top venues descending', async () => {
    const refs = {
      a: {year: 2020, venue: 'NeurIPS'},
      b: {year: 2024, venue: 'NeurIPS'},
      c: {year: 2020, venue: 'Nature'},
      d: {venue: 'Nature'},
      e: {year: 0},
      f: {},
    };
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/year-distribution', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.years, [{year: 2020, count: 2}, {year: 2024, count: 1}]);
    assert.deepEqual(r.payload.topVenues, [{venue: 'NeurIPS', count: 2}, {venue: 'Nature', count: 2}]);
    assert.equal(r.payload.totalReferences, 6);
    // Every falsy year collapses into the unknown bucket, counted but not listed.
    assert.equal(r.payload.unknownYear, 3);
  });

  it('caps the venue list at fifteen', async () => {
    const refs = Object.fromEntries(Array.from({length: 20}, (_, i) => [`k${i}`, {year: 2020, venue: `V${i}`}]));
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/year-distribution', ctx});
    assert.equal(r.payload.topVenues.length, 15);
  });

  it('returns empty aggregates for an empty bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {path: '/api/references/year-distribution', ctx});
    assert.deepEqual(r.payload, {years: [], topVenues: [], totalReferences: 0, unknownYear: 0});
  });

  // loadReferencesCached swallows a read failure to {}, so this endpoint reports
  // an empty distribution rather than a 500.
  it('returns 200 with empty aggregates when the read throws', async () => {
    const ctx = makeCtx({fs: {statSync() { throw new Error('x'); }, readFileSync() { throw new Error('x'); }}});
    const r = await invoke(routes, {path: '/api/references/year-distribution', ctx});
    assert.deepEqual([r.status, r.payload.totalReferences], [200, 0]);
  });
});

// ── Similar ───────────────────────────────────────────────────────────────

describe('GET /api/references/similar', () => {
  const REFS = {
    target: {title: 'Attention Mechanisms Explained', year: 2020, venue: 'NeurIPS', author: ['Ada Lovelace']},
    sameAuthor: {title: 'Unrelated Words Here', year: 2010, venue: 'Other', author: ['Ada Lovelace']},
    sameVenue: {title: 'Nothing Alike', year: 2000, venue: 'NeurIPS'},
    nearYear: {title: 'Zzz Qqq', year: 2021, venue: 'Other'},
    sharedWords: {title: 'Attention Mechanisms Explained Again', year: 1990, venue: 'Other'},
    unrelated: {title: 'Zzz', year: 1900, venue: 'Nowhere'},
  };

  it('returns 400 without a key, never reading the bibliography', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/similar', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing key'}]);
    assert.equal(counts.read, 0);
  });

  it('returns 404 for an unknown key', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/similar', query: {key: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference not found'}]);
  });

  it('scores shared authors, venue, nearby year and title words', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/similar', query: {key: 'target'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.key, 'target');
    const byKey = Object.fromEntries(r.payload.similar.map(s => [s.key, s.score]));
    // A shared author is worth 3, the same venue 2, a year within two 1, and
    // each shared title word longer than three characters 0.5.
    assert.equal(byKey.sameAuthor, 3);
    assert.equal(byKey.sameVenue, 2);
    // Three shared words at 0.5 each; two would total exactly 1, which the
    // `score > 1` threshold excludes.
    assert.equal(byKey.sharedWords, 1.5);
    // nearYear scores only 1, which is not above the threshold.
    assert.equal(byKey.nearYear, undefined);
    assert.equal(byKey.unrelated, undefined);
    assert.equal(byKey.target, undefined, 'the target never matches itself');
    const scores = r.payload.similar.map(s => s.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  it('contributes no title overlap when the target has no title', async () => {
    const refs = {...REFS, target: {year: 2020, venue: 'NeurIPS', author: ['Ada Lovelace']}};
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/similar', query: {key: 'target'}, ctx});
    const byKey = Object.fromEntries(r.payload.similar.map(s => [s.key, s.score]));
    assert.equal(byKey.sharedWords, undefined);
  });

  it('caps the list at fifteen', async () => {
    const refs = {target: {title: 'T', venue: 'V', author: ['Ada']}};
    for (let i = 0; i < 20; i++) refs[`k${i}`] = {title: `T${i}`, venue: 'V', author: ['Ada']};
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/similar', query: {key: 'target'}, ctx});
    assert.equal(r.payload.similar.length, 15);
  });
});

// ── Search ────────────────────────────────────────────────────────────────

describe('GET /api/references/search', () => {
  const REFS = {
    quantumkey: {title: 'Nothing', year: 1999, venue: 'Nowhere'},
    byauthor: {title: 'Nothing', author: ['Quantum Person']},
    byvenue: {title: 'Nothing', venue: 'Quantum Journal'},
    byyear: {title: 'Nothing', year: 2020},
    full: {title: 'Quantum Paper', year: 2021, venue: 'V', doi: '10.1/x', extra: 'kept'},
  };

  for (const [label, query] of [['no q', {}], ['an empty q', {q: ''}], ['a whitespace-only q', {q: '   '}]]) {
    it(`returns 400 for ${label}, never reading the bibliography`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
      const r = await invoke(routes, {path: '/api/references/search', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing query'}]);
      assert.equal(counts.read, 0);
    });
  }

  const MATCHES = [
    {name: 'the citation key', q: 'quantumkey', keys: ['quantumkey']},
    {name: 'an author name', q: 'quantum person', keys: ['byauthor']},
    {name: 'the venue', q: 'quantum journal', keys: ['byvenue']},
    {name: 'the stringified year', q: '2020', keys: ['byyear']},
  ];
  for (const {name, q, keys} of MATCHES) {
    it(`matches via ${name}`, async () => {
      const {ctx} = fsCtx({[BIB]: bib(REFS)});
      const r = await invoke(routes, {path: '/api/references/search', query: {q}, ctx});
      assert.deepEqual(r.payload.results.map(x => x.key), keys);
    });
  }

  it('returns the full {key, ...entry} shape including non-searchable fields', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/search', query: {q: 'quantum paper'}, ctx});
    assert.deepEqual(r.payload.results, [{key: 'full', ...REFS.full}]);
  });

  it('returns an empty payload when nothing matches', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const r = await invoke(routes, {path: '/api/references/search', query: {q: 'nomatch'}, ctx});
    assert.deepEqual(r.payload, {results: [], total: 0});
  });

  // The loop breaks at the limit, so total reports the truncated count rather
  // than the number of matches in the whole bibliography.
  it('truncates at the limit and reports the truncated total', async () => {
    const refs = Object.fromEntries(Array.from({length: 10}, (_, i) => [`quantum${i}`, {title: 'T'}]));
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/search', query: {q: 'quantum', limit: '3'}, ctx});
    assert.deepEqual([r.payload.results.length, r.payload.total], [3, 3]);
  });

  const LIMITS = [
    {name: 'absent, giving the default of 20', query: {}, want: 20},
    {name: 'over the cap, clamped to 100', query: {limit: '9999'}, want: 30, corpus: 30},
    {name: 'non-numeric, falling back to the default', query: {limit: 'abc'}, want: 20},
  ];
  for (const {name, query, want, corpus = 30} of LIMITS) {
    it(`handles a limit that is ${name}`, async () => {
      const refs = Object.fromEntries(Array.from({length: corpus}, (_, i) => [`quantum${i}`, {title: 'T'}]));
      const {ctx} = fsCtx({[BIB]: bib(refs)});
      const r = await invoke(routes, {path: '/api/references/search', query: {q: 'quantum', ...query}, ctx});
      assert.equal(r.payload.results.length, want);
    });
  }

  it('clamps an over-cap limit to one hundred results', async () => {
    const refs = Object.fromEntries(Array.from({length: 150}, (_, i) => [`quantum${i}`, {title: 'T'}]));
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/search', query: {q: 'quantum', limit: '9999'}, ctx});
    assert.deepEqual([r.payload.results.length, r.payload.total], [100, 100]);
  });

  it('returns 500 on a structurally broken entry', async () => {
    const {ctx} = fsCtx({[BIB]: 'broken:\n'});
    const r = await invoke(routes, {path: '/api/references/search', query: {q: 'broken'}, ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Search failed'}]);
  });
});

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
    const r = await invoke(routes, {method: 'POST', path: '/api/references', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'add-ref:127.0.0.1', maxPerMinute: 20}]);
    assert.deepEqual([counts.read, counts.write], [0, 0]);
  });

  const GUARDS = [
    {name: 'an omitted key', body: {entry: {}}, error: 'Missing key or entry'},
    // The !entry guard fires before the type checks.
    {name: 'a null entry', body: {key: 'k', entry: null}, error: 'Missing key or entry'},
    {name: 'a non-string key', body: {key: 7, entry: {title: 'T'}}, error: 'Invalid key'},
    {name: 'a key over 200 characters', body: {key: 'k'.repeat(201), entry: {title: 'T'}}, error: 'Invalid key'},
    {name: 'a non-object entry', body: {key: 'k', entry: 'not an object'}, error: 'Invalid entry'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without writing`, async () => {
      const {ctx, counts} = fsCtx({[BIB]: ''});
      const r = await invoke(routes, {method: 'POST', path: '/api/references', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  it('returns 409 for an existing key, reading but not writing', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib({new2024: {title: 'Existing'}})});
    const r = await invoke(routes, {method: 'POST', path: '/api/references', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Key already exists'}]);
    assert.ok(counts.read > 0);
    assert.equal(counts.write, 0);
  });

  // js-yaml parses an empty document to null, so the `|| {}` fallback applies
  // and a __proto__ key still collides with the inherited member.
  it('returns 409 for a __proto__ key against an empty bibliography', async () => {
    const {ctx, counts} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {method: 'POST', path: '/api/references', body: {key: '__proto__', entry: {title: 'T'}}, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Key already exists'}]);
    assert.equal(counts.write, 0);
  });

  it('writes the entry then invalidates stats', async () => {
    const {ctx, counts, fs} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {method: 'POST', path: '/api/references', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [201, {success: true}]);
    assert.equal(counts.write, 1);
    assert.deepEqual(ctx.calls.invalidateCache, ['stats']);
    assert.ok(fs.readFileSync(BIB).includes('new2024'));
  });

  it('slices string fields to 5000 characters and arrays to 50 entries of 500', async () => {
    const {ctx, fs} = fsCtx({[BIB]: ''});
    const entry = {title: 't'.repeat(6000), author: Array.from({length: 60}, () => 'a'.repeat(600)), year: 2024, flag: true};
    await invoke(routes, {method: 'POST', path: '/api/references', body: {key: 'k', entry}, ctx});
    const yaml = (await import('js-yaml')).default;
    const written = yaml.load(fs.readFileSync(BIB));
    assert.equal(written.k.title.length, 5000);
    assert.equal(written.k.author.length, 50);
    assert.equal(written.k.author[0].length, 500);
    // Non-string, non-array values pass through untouched.
    assert.deepEqual([written.k.year, written.k.flag], [2024, true]);
  });

  it('returns 400 without writing when the existing bibliography is malformed', async () => {
    const {ctx, counts} = fsCtx({[BIB]: '\tnot: [valid'});
    const r = await invoke(routes, {method: 'POST', path: '/api/references', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
    assert.equal(counts.write, 0);
  });
});

// ── Draft toggle ──────────────────────────────────────────────────────────

describe('POST /api/file/draft', () => {
  it('returns 429 without reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/file/draft', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'file-draft:127.0.0.1', maxPerMinute: 20}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'a path outside content/', body: {path: '../escape.md', draft: true}, error: 'Invalid path'},
    {name: 'a non-boolean draft', body: {path: 'content/a.md', draft: 'yes'}, error: 'draft must be a boolean'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name}`, async () => {
      const {ctx, counts} = fsCtx({[at('content/a.md')]: 'x'});
      const r = await invoke(routes, {method: 'POST', path: '/api/file/draft', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  const REWRITES = [
    {
      name: 'replaces an existing draft line in place',
      before: '---\ntitle: T\ndraft: false\n---\n\nbody\n',
      after: '---\ntitle: T\ndraft: true\n---\n\nbody\n',
    },
    {
      name: 'appends a draft line to frontmatter that lacks one',
      before: '---\ntitle: T\n---\n\nbody\n',
      after: '---\ntitle: T\ndraft: true\n---\n\nbody\n',
    },
    {
      name: 'prepends a frontmatter block when the file has none',
      before: 'plain body\n',
      after: '---\ndraft: true\n---\nplain body\n',
    },
  ];
  for (const {name, before, after} of REWRITES) {
    it(name, async () => {
      const {ctx, fs} = fsCtx({[at('content/a.md')]: before});
      const r = await invoke(routes, {method: 'POST', path: '/api/file/draft', body: {path: 'content/a.md', draft: true}, ctx});
      assert.deepEqual([r.status, r.payload], [200, {success: true}]);
      assert.equal(fs.readFileSync(at('content/a.md')), after);
    });
  }

  it('renders the literal boolean, so false round-trips too', async () => {
    const {ctx, fs} = fsCtx({[at('content/a.md')]: 'plain\n'});
    await invoke(routes, {method: 'POST', path: '/api/file/draft', body: {path: 'content/a.md', draft: false}, ctx});
    assert.ok(fs.readFileSync(at('content/a.md')).startsWith('---\ndraft: false\n---\n'));
  });

  it('returns 400 rather than 500 when the file read throws', async () => {
    const {ctx} = fsCtx({});
    const r = await invoke(routes, {method: 'POST', path: '/api/file/draft', body: {path: 'content/gone.md', draft: true}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
  });
});

// ── AI assistant ──────────────────────────────────────────────────────────

describe('POST /api/ai/complete', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  });

  const OK = {prompt: 'Write something', type: 'continue'};

  it('returns 429 before reading the body, keyed on the caller address', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'ai-complete:127.0.0.1', maxPerMinute: 10}]);
    assert.equal(reads, 0);
  });

  const GUARDS = [
    {name: 'an omitted prompt', body: {}, error: 'Missing or invalid prompt'},
    {name: 'a non-string prompt', body: {prompt: 7}, error: 'Missing or invalid prompt'},
    {name: 'a prompt over 50000 characters', body: {prompt: 'p'.repeat(50001)}, error: 'Prompt must be 50000 characters or fewer'},
    {name: 'a non-string context', body: {prompt: 'p', context: 7}, error: 'context must be a string'},
    {name: 'a context over 50000 characters', body: {prompt: 'p', context: 'c'.repeat(50001)}, error: 'Context must be 50000 characters or fewer'},
    {name: 'a non-string type', body: {prompt: 'p', type: 7}, error: 'type must be a string'},
    {name: 'a type over 50 characters', body: {prompt: 'p', type: 't'.repeat(51)}, error: 'Type must be 50 characters or fewer'},
    {name: 'a type outside the allow list', body: {prompt: 'p', type: 'translate'}, error: 'Invalid type. Must be one of: continue, improve, explain, summarize'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} before any upstream call`, async () => {
      let fetches = 0;
      globalThis.fetch = async () => { fetches++; throw new Error('must not be called'); };
      const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(fetches, 0);
    });
  }

  it('returns 500 when the API key is unset, before any upstream call', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('must not be called'); };
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK});
    assert.equal(r.status, 500);
    assert.ok(r.payload.error.startsWith('ANTHROPIC_API_KEY is not set'));
    assert.equal(fetches, 0);
  });

  it('returns the completion text on a successful upstream call', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    let sent;
    globalThis.fetch = async (u, init) => {
      sent = {url: u, body: JSON.parse(init.body), headers: init.headers};
      return {ok: true, json: async () => ({content: [{text: 'the continuation'}]})};
    };
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {...OK, context: 'earlier text'}});
    assert.deepEqual([r.status, r.payload], [200, {text: 'the continuation'}]);
    assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(sent.headers['x-api-key'], 'sk-test');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    // A supplied context is folded into the user message.
    assert.equal(sent.body.messages[0].content, 'Context:\nearlier text\n\nText:\nWrite something');
    assert.ok(sent.body.system.startsWith('You are a writing assistant.'));
  });

  it('falls back to a placeholder when the upstream returns no text', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    globalThis.fetch = async () => ({ok: true, json: async () => ({})});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK});
    assert.deepEqual(r.payload, {text: 'No response generated'});
  });

  it('omits the system prompt when no type is given', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    let sent;
    globalThis.fetch = async (u, init) => { sent = JSON.parse(init.body); return {ok: true, json: async () => ({content: [{text: 'x'}]})}; };
    await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: {prompt: 'p'}});
    assert.equal('system' in sent, false);
  });

  it('returns 502 when the upstream responds not-ok', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    globalThis.fetch = async () => ({ok: false, json: async () => ({error: 'nope'})});
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK});
    assert.deepEqual([r.status, r.payload], [502, {error: 'AI service returned an error. Please try again.'}]);
  });

  it('returns 504 when the upstream call aborts', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', body: OK});
    assert.deepEqual([r.status, r.payload], [504, {error: 'AI request timed out. Please try again.'}]);
  });

  for (const [label, readBody] of [
    ['readBody rejects', async () => { throw new Error('bad json'); }],
    ['readBody resolves null', async () => null],
  ]) {
    it(`returns the generic 500 when ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/ai/complete', ctx: makeCtx({readBody})});
      assert.deepEqual([r.status, r.payload], [500, {error: 'AI request failed. Please try again later.'}]);
    });
  }
});

// ── Metadata search ───────────────────────────────────────────────────────

describe('GET /api/metadata/search', () => {
  const realGet = https.get;
  afterEach(() => { https.get = realGet; });

  /** Serve canned JSON per request URL; undefined means the source is down. */
  function fakeHttps(responder) {
    https.get = (urlArg, opts, cb) => {
      if (typeof opts === 'function') cb = opts;
      const payload = responder(String(urlArg));
      const stream = new EventEmitter();
      stream.resume = () => {};
      stream.statusCode = payload === undefined ? 500 : 200;
      if (typeof cb === 'function') cb(stream);
      setImmediate(() => {
        if (stream.statusCode !== 200) return;
        stream.emit('data', Buffer.from(JSON.stringify(payload)));
        stream.emit('end');
      });
      const req = new EventEmitter();
      req.destroy = () => {};
      return req;
    };
  }

  const S2 = {data: [{title: 'Attention Is All You Need', authors: [{name: 'Ashish Vaswani'}, {name: 'N. Shazeer'}], year: 2017, venue: 'NeurIPS', externalIds: {DOI: '10.1/x', ArXiv: '1706.03762'}, url: 'https://s2/x'}]};
  const CROSSREF = {message: {items: [{title: ['Attention Is All You Need'], author: [{given: 'Ashish', family: 'Vaswani'}], published: {'date-parts': [[2017]]}, 'container-title': ['NIPS'], DOI: '10.1/x', URL: 'https://cr/x'}]}};
  const DBLP = {result: {hits: {hit: [{info: {title: 'Attention Is All You Need', authors: {author: [{text: 'Ashish Vaswani'}, 'Noam Shazeer']}, year: '2017', venue: 'NIPS', doi: '10.1/x', ee: 'https://dblp/x', type: 'Conference', pages: '5998-6008', volume: '30'}}]}}};

  const respond = (over = {}) => url =>
    url.includes('semanticscholar') ? ('s2' in over ? over.s2 : S2) :
    url.includes('crossref') ? ('crossref' in over ? over.crossref : CROSSREF) :
    ('dblp' in over ? over.dblp : DBLP);

  it('returns 400 when the query is missing', async () => {
    fakeHttps(() => undefined);
    const r = await invoke(routes, {path: '/api/metadata/search'});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing query'}]);
  });

  it('collects per-source results and one merged record', async () => {
    fakeHttps(respond());
    const r = await invoke(routes, {path: '/api/metadata/search', query: {q: 'attention'}});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.results.map(x => x.source), ['semanticscholar', 'crossref', 'dblp']);
    assert.equal(r.payload.merged.title, 'Attention Is All You Need');
    assert.equal(r.payload.merged.year, 2017);
    // The merge strips the source discriminator.
    assert.equal('source' in r.payload.merged, false);
  });

  it('deduplicates authors across name formats, keeping the fuller spelling', async () => {
    fakeHttps(respond());
    const r = await invoke(routes, {path: '/api/metadata/search', query: {q: 'attention'}});
    assert.ok(r.payload.merged.authors.includes('Ashish Vaswani'));
    assert.equal(r.payload.merged.authors.filter(a => a.toLowerCase().includes('vaswani')).length, 1);
  });

  it('normalises a single-author DBLP hit delivered as an object', async () => {
    const single = {result: {hits: {hit: [{info: {title: 'Solo', authors: {author: {text: 'Ada Lovelace'}}, year: '2020'}}]}}};
    fakeHttps(respond({s2: undefined, crossref: undefined, dblp: single}));
    const r = await invoke(routes, {path: '/api/metadata/search', query: {q: 'solo'}});
    const [rec] = r.payload.results;
    assert.deepEqual([rec.source, rec.authors], ['dblp', ['Ada Lovelace']]);
  });

  it('still merges when a source is unavailable', async () => {
    fakeHttps(respond({crossref: undefined}));
    const r = await invoke(routes, {path: '/api/metadata/search', query: {q: 'attention'}});
    assert.deepEqual(r.payload.results.map(x => x.source), ['semanticscholar', 'dblp']);
    assert.equal(r.payload.merged.title, 'Attention Is All You Need');
  });

  it('stays pollution-safe against a hostile upstream key', async () => {
    const hostile = {result: {hits: {hit: [{info: {title: 'X', __proto__: {polluted: true}, authors: {author: 'A'}}}]}}};
    fakeHttps(respond({s2: undefined, crossref: undefined, dblp: hostile}));
    const r = await invoke(routes, {path: '/api/metadata/search', query: {q: 'x'}});
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
    const r = await invoke(routes, {path: '/api/references/enrich', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing key param'}]);
    assert.deepEqual([counts.read, curls], [0, 0]);
  });

  it('returns a templated 404 for an unknown key, never curling', async () => {
    let curls = 0;
    const {ctx} = fsCtx({[BIB]: bib(REFS)}, {execFileSync: () => { curls++; return '{}'; }});
    const r = await invoke(routes, {path: '/api/references/enrich', query: {key: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference "nope" not found'}]);
    assert.equal(curls, 0);
  });

  it('returns 400 when the entry carries no title, never curling', async () => {
    let curls = 0;
    const {ctx} = fsCtx({[BIB]: bib(REFS)}, {execFileSync: () => { curls++; return '{}'; }});
    const r = await invoke(routes, {path: '/api/references/enrich', query: {key: 'noTitle'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Reference has no title to search for'}]);
    assert.equal(curls, 0);
  });

  it('parses each source and returns the merged record', async () => {
    const responses = {
      semanticscholar: {data: [{title: 'A Paper', authors: [{name: 'Ada Lovelace'}], year: 2020, venue: 'V', externalIds: {DOI: '10.1/x'}, citationCount: 5, referenceCount: 2, tldr: {text: 'summary'}}]},
      crossref: {message: {items: [{title: ['A Paper'], author: [{given: 'Ada', family: 'Lovelace'}], DOI: '10.1/x', publisher: 'Pub'}]}},
      dblp: {result: {hits: {hit: [{info: {title: 'A Paper', authors: {author: 'Ada Lovelace'}, year: '2020', venue: 'V'}}]}}},
    };
    const execFileSync = (cmd, args) => {
      const url = args[args.length - 1];
      const which = url.includes('semanticscholar') ? 'semanticscholar' : url.includes('crossref') ? 'crossref' : 'dblp';
      return JSON.stringify(responses[which]);
    };
    const {ctx} = fsCtx({[BIB]: bib(REFS)}, {execFileSync});
    const r = await invoke(routes, {path: '/api/references/enrich', query: {key: 'withTitle'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.key, 'withTitle');
    assert.deepEqual(r.payload.current, REFS.withTitle);
    assert.equal(r.payload.sources.semanticScholar.tldr, 'summary');
    assert.equal(r.payload.sources.crossref.publisher, 'Pub');
    assert.deepEqual(r.payload.sources.dblp.authors, ['Ada Lovelace']);
    assert.equal(r.payload.merged.title, 'A Paper');
  });

  it('nulls a source that returns nothing usable', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)}, {execFileSync: () => { throw new Error('curl failed'); }});
    const r = await invoke(routes, {path: '/api/references/enrich', query: {key: 'withTitle'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.sources, {semanticScholar: null, crossref: null, dblp: null});
  });

  it('returns 500 when the loader itself throws', async () => {
    const ctx = makeCtx({path: {join() { throw new Error('boom'); }}});
    const r = await invoke(routes, {path: '/api/references/enrich', query: {key: 'withTitle'}, ctx});
    assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Enrichment failed. Please try again later.'}, opts: undefined}]);
  });
});

describe('POST /api/references/enrich', () => {
  const REFS = {k: {title: 'Old Title', year: 2000}};
  const OK = {key: 'k', fields: {title: 'New Title'}};

  it('returns 429 without touching anything', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)}, {rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/references/enrich', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'enrich-ref:127.0.0.1', maxPerMinute: 10}]);
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
      const r = await invoke(routes, {method: 'POST', path: '/api/references/enrich', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.equal(counts.write, 0);
    });
  }

  it('merges only allowed, non-null fields and writes once', async () => {
    const {ctx, counts} = fsCtx({[BIB]: bib(REFS)});
    const fields = {title: 'New Title', doi: '10.1/x', notAllowed: 'ignored', year: null, author: ['Ada Lovelace']};
    const r = await invoke(routes, {method: 'POST', path: '/api/references/enrich', body: {key: 'k', fields}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.entry.title, 'New Title');
    assert.equal(r.payload.entry.doi, '10.1/x');
    assert.deepEqual(r.payload.entry.author, ['Ada Lovelace']);
    assert.equal('notAllowed' in r.payload.entry, false);
    // A null value is skipped, so the existing year survives.
    assert.equal(r.payload.entry.year, 2000);
    assert.equal(counts.write, 1);
  });

  it('slices string fields to 5000 characters and arrays to 50 entries of 500', async () => {
    const {ctx} = fsCtx({[BIB]: bib(REFS)});
    const fields = {title: 't'.repeat(6000), author: Array.from({length: 60}, () => 'a'.repeat(600))};
    const r = await invoke(routes, {method: 'POST', path: '/api/references/enrich', body: {key: 'k', fields}, ctx});
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
      const r = await invoke(routes, {method: 'POST', path: '/api/references/enrich', ctx});
      assert.equal(r.status, 400);
      assert.ok(r.payload.error.startsWith('Invalid request: '));
      assert.deepEqual([counts.read, counts.write], [0, 0]);
    });
  }
});
