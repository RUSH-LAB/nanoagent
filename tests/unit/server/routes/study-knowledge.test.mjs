/**
 * server/routes/study-knowledge.js: spaced-repetition flashcards, citation
 * context and paper comparison, topic clusters, link suggestions, the
 * glossary, study plans, research questions, search autocomplete, quick notes,
 * pins, preferences, bookmark folders, the review workflow, custom templates,
 * per-page analytics and the knowledge-base report.
 *
 * Consolidated from the sixty per-branch suites that used to cover this module.
 * Many of its stores are keyed by a request-supplied userId, so the own-key and
 * proto-key guards are driven from shared tables.
 */
import {describe, it, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, loadServer, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT} from '../../_harness.mjs';

const routes = loadRoute('study-knowledge');
const {LINKSUGGEST_WIKI_RE, QUICKNOTES_TITLE_RE, QUICKNOTES_DATE_RE, QUICKNOTES_BODY_RE, FRONTMATTER_TITLE_RE} = routes;
const {FLASHCARDS_FILE, GLOSSARY_FILE, READING_LISTS_FILE, BOOKMARKS_FILE, ANALYTICS_FILE, COMMENTS_FILE} = FILES;
const at = rel => path.join(PROJECT_ROOT, rel);
const BIB = at('bibliography/references.yaml');
const RQ_FILE = at('data/research-questions.json');
const QUICKNOTES_FILE = at('data/quicknotes.json');
const PINS_FILE = at('data/pins.json');
const PREFS_FILE = at('data/preferences.json');
const REVIEWS_FILE = at('data/reviews.json');
const TEMPLATES_FILE = at('data/custom-templates.json');

const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
const INHERITED_KEYS = ['toString', 'valueOf', 'hasOwnProperty'];

const fm = (fields, body = '') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;

function fsCtx(files, over = {}) {
  const base = mockFs(files);
  const counts = {read: 0, readdir: 0};
  const fs = {
    ...base,
    readFileSync: p => { counts.read++; return base.readFileSync(p); },
    readdirSync: (p, o) => { counts.readdir++; return base.readdirSync(p, o); },
  };
  return {ctx: makeCtx({fs, ...over}), counts};
}

function bib(entries) {
  return Object.entries(entries).map(([key, e]) => {
    const lines = [`${key}:`];
    for (const [k, v] of Object.entries(e)) {
      if (Array.isArray(v)) { lines.push(`  ${k}:`); for (const i of v) lines.push(`    - ${JSON.stringify(i)}`); }
      else lines.push(`  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
    }
    return lines.length === 1 ? `${key}: {}` : lines.join('\n');
  }).join('\n') + '\n';
}

// The bibliography memo is module-level state shared with references.js.
beforeEach(() => loadRoute('references')._resetReferencesCache());

// ── Flashcards ────────────────────────────────────────────────────────────

describe('POST /api/flashcards', () => {
  const OK = {front: 'Q', back: 'A'};

  it('returns 429 without reading the body or saving', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/flashcards', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'flashcards:127.0.0.1', maxPerMinute: 30}]);
    assert.deepEqual([reads, ctx.calls.saveJSON.length], [0, 0]);
  });

  const GUARDS = [
    {name: 'an omitted front', body: {back: 'A'}, error: 'Missing or invalid front'},
    {name: 'a non-string front', body: {front: 7, back: 'A'}, error: 'Missing or invalid front'},
    {name: 'an omitted back', body: {front: 'Q'}, error: 'Missing or invalid back'},
    {name: 'a non-string back', body: {front: 'Q', back: 7}, error: 'Missing or invalid back'},
    {name: 'a front over 5000 characters', body: {front: 'f'.repeat(5001), back: 'A'}, error: 'front must be 5000 characters or fewer'},
    {name: 'a back over 5000 characters', body: {front: 'Q', back: 'b'.repeat(5001)}, error: 'back must be 5000 characters or fewer'},
    {name: 'a non-string userId', body: {...OK, userId: 7}, error: 'userId must be a string'},
    {name: 'a userId over 200 characters', body: {...OK, userId: 'u'.repeat(201)}, error: 'userId must be 200 characters or fewer'},
    {name: 'a non-array tags', body: {...OK, tags: 'x'}, error: 'tags must be an array of strings'},
    {name: 'a tags array with a non-string', body: {...OK, tags: ['ok', 7]}, error: 'tags must be an array of strings'},
    {name: 'a non-string sourcePath', body: {...OK, sourcePath: 7}, error: 'sourcePath must be a string'},
    {name: 'a sourcePath over 500 characters', body: {...OK, sourcePath: 'p'.repeat(501)}, error: 'sourcePath must be 500 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/flashcards', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('creates a card with the SM-2 starting schedule', async () => {
    const ctx = makeCtx();
    const today = new Date().toISOString().slice(0, 10);
    const r = await invoke(routes, {method: 'POST', path: '/api/flashcards', body: {...OK, tags: ['a', 'b'], sourcePath: 'content/x.md'}, ctx});
    assert.equal(r.status, 200);
    const {id, createdAt, ...stable} = r.payload.card;
    assert.deepEqual(stable, {
      front: 'Q', back: 'A', tags: ['a', 'b'], sourcePath: 'content/x.md',
      interval: 1, easeFactor: 2.5, repetitions: 0, nextReview: today,
    });
    assert.match(id, /^fc_\d+_[a-z0-9]+$/);
    assert.deepEqual(ctx.store[FLASHCARDS_FILE].default, [r.payload.card]);
  });

  it('caps the tag list at ten and nulls an omitted sourcePath', async () => {
    const tags = Array.from({length: 15}, (_, i) => `t${i}`);
    const r = await invoke(routes, {method: 'POST', path: '/api/flashcards', body: {...OK, tags}});
    assert.equal(r.payload.card.tags.length, 10);
    assert.equal(r.payload.card.sourcePath, null);
  });

  for (const userId of INHERITED_KEYS) {
    it(`stores the inherited userId ${JSON.stringify(userId)} as an own key`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/flashcards', body: {...OK, userId}, ctx});
      assert.equal(r.status, 200);
      assert.ok(Object.hasOwn(ctx.store[FLASHCARDS_FILE], userId));
    });
  }
});

describe('GET /api/flashcards and /due', () => {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const CARDS = [
    {id: 'past', nextReview: yesterday},
    {id: 'today', nextReview: today},
    {id: 'future', nextReview: tomorrow},
  ];
  const store = () => ({[FLASHCARDS_FILE]: {default: CARDS, alice: [{id: 'a', nextReview: today}]}});

  it('lists a user cards with the total', async () => {
    const r = await invoke(routes, {path: '/api/flashcards', ctx: makeCtx({store: store()})});
    assert.deepEqual([r.status, r.payload.total], [200, 3]);
    assert.deepEqual(r.payload.cards.map(c => c.id), ['past', 'today', 'future']);
  });

  it('reads the named user rather than the default', async () => {
    const r = await invoke(routes, {path: '/api/flashcards', query: {userId: 'alice'}, ctx: makeCtx({store: store()})});
    assert.deepEqual(r.payload.cards.map(c => c.id), ['a']);
  });

  // The due filter is inclusive of today.
  it('returns only cards due today or earlier', async () => {
    const r = await invoke(routes, {path: '/api/flashcards/due', ctx: makeCtx({store: store()})});
    assert.deepEqual(r.payload.cards.map(c => c.id), ['past', 'today']);
    assert.equal(r.payload.dueCount, 2);
  });

  for (const p of ['/api/flashcards', '/api/flashcards/due']) {
    for (const userId of [...PROTO_KEYS, ...INHERITED_KEYS, 'absent']) {
      it(`${p} returns an empty list for the non-own user ${JSON.stringify(userId)}`, async () => {
        const r = await invoke(routes, {path: p, query: {userId}, ctx: makeCtx({store: store()})});
        assert.deepEqual(r.payload.cards, []);
      });
    }
  }
});

describe('POST /api/flashcards/review', () => {
  const card = over => ({id: 'c1', interval: 1, easeFactor: 2.5, repetitions: 0, nextReview: '2020-01-01', ...over});
  const store = over => ({[FLASHCARDS_FILE]: {default: [card(over)]}});

  it('returns 429 with the fc-review key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/flashcards/review', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'fc-review:127.0.0.1', maxPerMinute: 120}]);
  });

  const GUARDS = [
    {name: 'an omitted cardId', body: {quality: 4}, error: 'Missing or invalid cardId'},
    {name: 'a non-string cardId', body: {cardId: 7, quality: 4}, error: 'Missing or invalid cardId'},
    {name: 'a cardId over 200 characters', body: {cardId: 'c'.repeat(201), quality: 4}, error: 'cardId must be 200 characters or fewer'},
    {name: 'an omitted quality', body: {cardId: 'c1'}, error: 'Missing or invalid quality'},
    {name: 'a non-numeric quality', body: {cardId: 'c1', quality: '4'}, error: 'Missing or invalid quality'},
    {name: 'an infinite quality', body: {cardId: 'c1', quality: Infinity}, error: 'Missing or invalid quality'},
    {name: 'a quality below zero', body: {cardId: 'c1', quality: -1}, error: 'quality must be between 0 and 5'},
    {name: 'a quality above five', body: {cardId: 'c1', quality: 6}, error: 'quality must be between 0 and 5'},
    {name: 'a non-string userId', body: {cardId: 'c1', quality: 4, userId: 7}, error: 'userId must be a string'},
    {name: 'a userId over 200 characters', body: {cardId: 'c1', quality: 4, userId: 'u'.repeat(201)}, error: 'userId must be 200 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: store()});
      const r = await invoke(routes, {method: 'POST', path: '/api/flashcards/review', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 404 for an unknown card', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/flashcards/review', body: {cardId: 'nope', quality: 4}, ctx: makeCtx({store: store()})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Card not found'}]);
  });

  // The SM-2 interval ladder: the first success is one day, the second six, and
  // each later one multiplies by the ease factor.
  const LADDER = [
    {name: 'the first success', card: {repetitions: 0, interval: 1}, quality: 5, interval: 1, repetitions: 1},
    {name: 'the second success', card: {repetitions: 1, interval: 1}, quality: 5, interval: 6, repetitions: 2},
    {name: 'a later success', card: {repetitions: 2, interval: 6, easeFactor: 2.5}, quality: 5, interval: 15, repetitions: 3},
    // Anything below three resets the schedule.
    {name: 'a failure', card: {repetitions: 5, interval: 30}, quality: 2, interval: 1, repetitions: 0},
    {name: 'the passing boundary at three', card: {repetitions: 0, interval: 1}, quality: 3, interval: 1, repetitions: 1},
  ];
  for (const {name, card: over, quality, interval, repetitions} of LADDER) {
    it(`applies ${name}`, async () => {
      const ctx = makeCtx({store: store(over)});
      const r = await invoke(routes, {method: 'POST', path: '/api/flashcards/review', body: {cardId: 'c1', quality}, ctx});
      assert.equal(r.status, 200);
      assert.deepEqual([r.payload.card.interval, r.payload.card.repetitions], [interval, repetitions]);
      const expected = new Date();
      expected.setDate(expected.getDate() + interval);
      assert.equal(r.payload.card.nextReview, expected.toISOString().slice(0, 10));
      assert.ok(r.payload.card.lastReviewed);
      assert.equal(ctx.calls.saveJSON.length, 1);
    });
  }

  it('adjusts the ease factor by the SM-2 formula, flooring it at 1.3', async () => {
    const perfect = await invoke(routes, {method: 'POST', path: '/api/flashcards/review', body: {cardId: 'c1', quality: 5}, ctx: makeCtx({store: store()})});
    assert.equal(perfect.payload.card.easeFactor, 2.6);
    const floored = await invoke(routes, {method: 'POST', path: '/api/flashcards/review', body: {cardId: 'c1', quality: 0}, ctx: makeCtx({store: store({easeFactor: 1.3})})});
    assert.equal(floored.payload.card.easeFactor, 1.3);
  });
});

describe('DELETE /api/flashcards', () => {
  const store = () => ({[FLASHCARDS_FILE]: {default: [{id: 'c1'}, {id: 'c2'}]}});

  it('rejects a missing cardId', async () => {
    const ctx = makeCtx({store: store()});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/flashcards', body: {}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing cardId'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  for (const userId of [...INHERITED_KEYS, 'absent']) {
    it(`returns 404 for the non-own user ${JSON.stringify(userId)}`, async () => {
      const r = await invoke(routes, {method: 'DELETE', path: '/api/flashcards', body: {cardId: 'c1', userId}, ctx: makeCtx({store: store()})});
      assert.deepEqual([r.status, r.payload], [404, {error: 'Card not found'}]);
    });
  }

  it('returns 404 for an unknown card id', async () => {
    const r = await invoke(routes, {method: 'DELETE', path: '/api/flashcards', body: {cardId: 'nope'}, ctx: makeCtx({store: store()})});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Card not found'}]);
  });

  it('removes the matching card, keeping its siblings', async () => {
    const ctx = makeCtx({store: store()});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/flashcards', body: {cardId: 'c1'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[FLASHCARDS_FILE].default.map(c => c.id), ['c2']);
  });
});

// ── Citation context and comparison ───────────────────────────────────────

describe('GET /api/references/context', () => {
  const REFS = {smith2020: {title: 'A Paper'}};
  const TREE = {
    [BIB]: bib(REFS),
    [at('content/a.md')]: `${'x'.repeat(150)} cites [@smith2020] here ${'y'.repeat(150)}`,
    [at('content/b.md')]: 'short [@smith2020] doc',
    [at('content/_skip.md')]: '[@smith2020]',
  };

  it('returns 400 without a key', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/references/context', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing key'}]);
  });

  it('returns 404 for a key absent from the bibliography', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/references/context', query: {key: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reference not found'}]);
  });

  it('extracts a windowed context per occurrence, eliding at each end', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/references/context', query: {key: 'smith2020'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual([r.payload.key, r.payload.title], ['smith2020', 'A Paper']);
    assert.equal(r.payload.totalCitations, 2, 'underscore files are skipped');
    const byFile = Object.fromEntries(r.payload.contexts.map(c => [c.file, c]));
    // A mid-document match is elided on both sides; a short file is not. The
    // window is 100 characters either side of the citation.
    const wide = byFile['content/a.md'].context;
    assert.ok(wide.startsWith('...') && wide.endsWith('...'));
    // Exactly 100 characters of lead-in sit between the ellipsis and the
    // citation, and 100 more follow it before the trailing ellipsis.
    assert.equal(wide.indexOf('[@smith2020]'), '...'.length + 100);
    assert.equal(wide.length, '...'.length + 100 + '[@smith2020]'.length + 100 + '...'.length);
    assert.equal(byFile['content/b.md'].context, 'short [@smith2020] doc');
    assert.equal(typeof byFile['content/a.md'].position, 'number');
  });

  it('memoizes per key and does not memoize the 404', async () => {
    let seen;
    const {ctx, counts} = fsCtx(TREE, {cached: (k, t, fn) => { seen ??= [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/references/context', query: {key: 'smith2020'}, ctx});
    assert.deepEqual(seen, ['refcontext:smith2020', 30000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/references/context', query: {key: 'smith2020'}, ctx});
    assert.equal(counts.readdir, after);
  });

  it('escapes regex metacharacters in the key', async () => {
    const files = {[BIB]: bib({'a.b*c': {title: 'Odd'}}), [at('content/x.md')]: 'cites [@a.b*c] and [@axbyc]'};
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/references/context', query: {key: 'a.b*c'}, ctx});
    assert.equal(r.payload.totalCitations, 1, 'the literal key matches, not the pattern');
  });

  it('returns 500 for a broken bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: '\tnot: [valid'});
    const r = await invoke(routes, {path: '/api/references/context', query: {key: 'k'}, ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Context extraction failed'}]);
  });
});

describe('GET /api/references/compare', () => {
  const REFS = {
    a: {title: 'Attention Mechanisms Explained', year: 2020, venue: 'NeurIPS', author: ['Ada Lovelace', 'Grace Hopper']},
    b: {title: 'Attention Revisited Again', year: 2018, venue: 'NeurIPS', author: ['ADA LOVELACE']},
    c: {title: 'Something Else', year: 2015, venue: 'Nature'},
  };
  const withRefs = () => fsCtx({[BIB]: bib(REFS)});

  for (const [label, query] of [['both keys', {}], ['key2', {key1: 'a'}], ['key1', {key2: 'b'}]]) {
    it(`returns 400 when ${label} is missing`, async () => {
      const {ctx} = withRefs();
      const r = await invoke(routes, {path: '/api/references/compare', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing key1 or key2'}]);
    });
  }

  it('returns 404 when either key is unknown', async () => {
    const {ctx} = withRefs();
    const r = await invoke(routes, {path: '/api/references/compare', query: {key1: 'a', key2: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'One or both references not found'}]);
  });

  it('reports shared authors case-insensitively, the venue, the year gap and shared title words', async () => {
    const {ctx} = withRefs();
    const r = await invoke(routes, {path: '/api/references/compare', query: {key1: 'a', key2: 'b'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.comparison, {
      sharedAuthors: ['ada lovelace'],
      sameVenue: true,
      yearDifference: 2,
      // Only words longer than three characters count.
      sharedTitleWords: ['attention'],
    });
    assert.deepEqual(r.payload.paper1, {key: 'a', title: REFS.a.title, year: 2020, venue: 'NeurIPS', authors: REFS.a.author});
  });

  it('reports no overlap between unrelated papers', async () => {
    const {ctx} = withRefs();
    const r = await invoke(routes, {path: '/api/references/compare', query: {key1: 'a', key2: 'c'}, ctx});
    assert.deepEqual(r.payload.comparison, {sharedAuthors: [], sameVenue: false, yearDifference: 5, sharedTitleWords: []});
  });
});

// ── Clusters, link suggestions, autocomplete ──────────────────────────────

describe('GET /api/content-clusters', () => {
  it('groups pages by shared tag, keeping only tags with two or more pages', async () => {
    const {ctx} = fsCtx({
      [at('content/a.md')]: fm({title: 'A', tags: `['alpha', "beta"]`}, 'x'),
      [at('content/b.md')]: fm({tags: '[alpha]'}, 'x'),
      [at('content/c.md')]: fm({tags: '[lonely]'}, 'x'),
      [at('content/_skip.md')]: fm({tags: '[alpha]'}, 'x'),
    });
    const r = await invoke(routes, {path: '/api/content-clusters', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.clusters, [{
      theme: 'alpha',
      pageCount: 2,
      // No front-matter title, so the filename minus extension is used.
      pages: [{path: 'content/a.md', title: 'A'}, {path: 'content/b.md', title: 'b'}],
    }]);
    assert.equal(r.payload.total, 1);
  });

  it('caps the cluster list at twenty and each page list at ten', async () => {
    const files = {};
    for (let t = 0; t < 25; t++) for (let p = 0; p < 12; p++) files[at(`content/t${t}p${p}.md`)] = fm({tags: `[tag${t}]`}, 'x');
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/content-clusters', ctx});
    assert.equal(r.payload.clusters.length, 20);
    assert.equal(r.payload.clusters[0].pageCount, 12);
    assert.equal(r.payload.clusters[0].pages.length, 10);
  });

  it('memoizes under "content-clusters" with a 120000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx({[at('content/a.md')]: fm({tags: '[x]'}, 'y')}, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/content-clusters', ctx});
    assert.deepEqual(seen, ['content-clusters', 120000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/content-clusters', ctx});
    assert.equal(counts.readdir, after);
  });

  it('returns 500 without caching when the walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/content-clusters', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Clustering failed'}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

describe('GET /api/file/link-suggestions', () => {
  const TREE = {
    [at('content/source.md')]: 'discusses quantum entanglement and links [[decoherence]] already',
    [at('content/quantum.md')]: fm({title: 'Quantum Page'}, 'x'),
    [at('content/entanglement.md')]: 'no front matter',
    [at('content/decoherence.md')]: 'already linked',
    [at('content/unrelated.md')]: 'x',
    [at('content/multi-word-quantum.md')]: 'x',
  };

  it('rejects an invalid path before any read', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/file/link-suggestions', query: {path: '../escape.md'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
    assert.equal(counts.read, 0);
  });

  it('returns 404 for a missing source and does not cache it', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const first = await invoke(routes, {path: '/api/file/link-suggestions', query: {path: 'content/gone.md'}, ctx});
    assert.deepEqual([first.status, first.payload], [404, {error: 'File not found'}]);
    const after = counts.read;
    await invoke(routes, {path: '/api/file/link-suggestions', query: {path: 'content/gone.md'}, ctx});
    assert.ok(counts.read > after);
  });

  it('suggests unlinked pages whose name appears in the body', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/file/link-suggestions', query: {path: 'content/source.md'}, ctx});
    assert.equal(r.status, 200);
    const byPath = Object.fromEntries(r.payload.suggestions.map(s => [s.path, s]));
    assert.deepEqual(byPath['content/quantum.md'], {path: 'content/quantum.md', title: 'Quantum Page', pageName: 'quantum'});
    // No front matter, so the title falls back to the basename.
    assert.equal(byPath['content/entanglement.md'].title, 'entanglement');
    // A hyphenated name matches when any segment longer than four characters does.
    assert.ok('content/multi-word-quantum.md' in byPath);
    assert.equal('content/decoherence.md' in byPath, false, 'an existing link is skipped');
    assert.equal('content/unrelated.md' in byPath, false);
    assert.equal('content/source.md' in byPath, false);
    assert.equal(r.payload.total, r.payload.suggestions.length);
  });

  it('caps the suggestion list at fifteen while total reports them all', async () => {
    // The body tokenizer splits on every non-letter, so these names are
    // letters only and longer than the four-character floor.
    const name = i => 'page' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    const files = {[at('content/source.md')]: Array.from({length: 20}, (_, i) => name(i)).join(' ')};
    for (let i = 0; i < 20; i++) files[at(`content/${name(i)}.md`)] = 'x';
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/file/link-suggestions', query: {path: 'content/source.md'}, ctx});
    assert.equal(r.payload.suggestions.length, 15);
    assert.equal(r.payload.total, 20);
  });

  it('memoizes per path with a 30000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx(TREE, {cached: (k, t, fn) => { seen ??= [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/file/link-suggestions', query: {path: 'content/source.md'}, ctx});
    assert.deepEqual(seen, ['linksuggest:content/source.md', 30000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/file/link-suggestions', query: {path: 'content/source.md'}, ctx});
    assert.equal(counts.readdir, after);
  });

  it('stays correct when LINKSUGGEST_WIKI_RE carries a stale lastIndex', async () => {
    // The per-request reset is load-bearing: without it the shared /g instance
    // would resume mid-string and miss the existing link.
    const first = await invoke(routes, {path: '/api/file/link-suggestions', query: {path: 'content/source.md'}, ctx: fsCtx(TREE).ctx});
    // Past the end of the only wiki link, so without the reset the exec loop
    // would find nothing and wrongly suggest the already-linked page.
    LINKSUGGEST_WIKI_RE.lastIndex = 60;
    const second = await invoke(routes, {path: '/api/file/link-suggestions', query: {path: 'content/source.md'}, ctx: fsCtx(TREE).ctx});
    assert.deepEqual(second.payload, first.payload);
  });
});

describe('GET /api/search/suggest', () => {
  const TREE = {
    [BIB]: bib({quantumref: {title: 'Quantum Reference'}, other: {title: 'Unrelated'}}),
    [at('content/quantum-notes.md')]: fm({title: 'Quantum Notes'}, 'x'),
    [at('content/plain-quantum.md')]: 'no front matter',
    [at('content/unrelated.md')]: 'x',
    [at('content/_skip-quantum.md')]: 'x',
  };

  for (const [label, query] of [['no q', {}], ['an empty q', {q: ''}], ['a single character', {q: 'a'}]]) {
    it(`returns an empty list for ${label} without scanning`, async () => {
      const {ctx, counts} = fsCtx(TREE);
      const r = await invoke(routes, {path: '/api/search/suggest', query, ctx});
      assert.deepEqual([r.status, r.payload], [200, {suggestions: []}]);
      assert.equal(counts.readdir, 0);
    });
  }

  it('suggests matching page titles and reference entries', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/search/suggest', query: {q: 'quantum'}, ctx});
    assert.equal(r.status, 200);
    const pages = r.payload.suggestions.filter(s => s.type === 'page');
    assert.deepEqual(pages.map(s => s.text).sort(), ['Quantum Notes', 'plain-quantum']);
    assert.equal(pages.some(s => s.path.includes('_skip')), false);
    const refs = r.payload.suggestions.filter(s => s.type === 'reference');
    assert.deepEqual(refs, [{type: 'reference', text: 'Quantum Reference', key: 'quantumref'}]);
  });

  it('caps the suggestion list at ten', async () => {
    const files = {};
    for (let i = 0; i < 15; i++) files[at(`content/quantum${i}.md`)] = 'x';
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/search/suggest', query: {q: 'quantum'}, ctx});
    assert.equal(r.payload.suggestions.length, 10);
  });

  it('still returns page matches when the bibliography is unreadable', async () => {
    const {ctx} = fsCtx({[at('content/quantum.md')]: 'x', [BIB]: '\tnot: [valid'});
    const r = await invoke(routes, {path: '/api/search/suggest', query: {q: 'quantum'}, ctx});
    assert.deepEqual(r.payload.suggestions.map(s => s.type), ['page']);
  });

  it('memoizes per query with a 30000 ms TTL', async () => {
    let seen;
    const {ctx, counts} = fsCtx(TREE, {cached: (k, t, fn) => { seen ??= [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    await invoke(routes, {path: '/api/search/suggest', query: {q: 'quantum'}, ctx});
    assert.deepEqual(seen, ['suggest:quantum', 30000]);
    const after = counts.readdir;
    await invoke(routes, {path: '/api/search/suggest', query: {q: 'quantum'}, ctx});
    assert.equal(counts.readdir, after);
  });

  it('falls back to an empty list without caching when the scan throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/search/suggest', query: {q: 'quantum'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {suggestions: []}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

// ── Glossary ──────────────────────────────────────────────────────────────

describe('GET /api/glossary', () => {
  const TERMS = [
    {id: 'g2', term: 'Zeta', definition: 'about quantum things'},
    {id: 'g1', term: 'Alpha', definition: 'first letter'},
  ];

  it('returns every term sorted alphabetically', async () => {
    const r = await invoke(routes, {path: '/api/glossary', ctx: makeCtx({store: {[GLOSSARY_FILE]: {terms: TERMS}}})});
    assert.deepEqual([r.status, r.payload.total], [200, 2]);
    assert.deepEqual(r.payload.terms.map(t => t.term), ['Alpha', 'Zeta']);
  });

  it('filters on the term or the definition, case-insensitively', async () => {
    const ctx = () => makeCtx({store: {[GLOSSARY_FILE]: {terms: TERMS}}});
    const byTerm = await invoke(routes, {path: '/api/glossary', query: {q: 'ALPHA'}, ctx: ctx()});
    assert.deepEqual(byTerm.payload.terms.map(t => t.id), ['g1']);
    const byDef = await invoke(routes, {path: '/api/glossary', query: {q: 'quantum'}, ctx: ctx()});
    assert.deepEqual(byDef.payload.terms.map(t => t.id), ['g2']);
  });

  it('returns an empty list for a store with no terms', async () => {
    const r = await invoke(routes, {path: '/api/glossary'});
    assert.deepEqual(r.payload, {terms: [], total: 0});
  });
});

describe('POST /api/glossary', () => {
  const OK = {term: 'Entropy', definition: 'a measure of disorder'};

  it('returns 429 with the glossary key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/glossary', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'glossary:127.0.0.1', maxPerMinute: 30}]);
  });

  const GUARDS = [
    {name: 'an omitted term', body: {definition: 'd'}, error: 'Missing or invalid term'},
    {name: 'a non-string term', body: {term: 7, definition: 'd'}, error: 'Missing or invalid term'},
    {name: 'a term over 200 characters', body: {term: 't'.repeat(201), definition: 'd'}, error: 'Term must be 200 characters or fewer'},
    {name: 'an omitted definition', body: {term: 't'}, error: 'Missing or invalid definition'},
    {name: 'a non-string definition', body: {term: 't', definition: 7}, error: 'Missing or invalid definition'},
    {name: 'a definition over 5000 characters', body: {term: 't', definition: 'd'.repeat(5001)}, error: 'Definition must be 5000 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/glossary', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns 409 for a term that already exists, matched case-insensitively', async () => {
    const ctx = makeCtx({store: {[GLOSSARY_FILE]: {terms: [{id: 'g1', term: 'ENTROPY'}]}}});
    const r = await invoke(routes, {method: 'POST', path: '/api/glossary', body: OK, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Term already exists'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  it('creates the entry with capped related lists', async () => {
    const ctx = makeCtx();
    const relatedTerms = Array.from({length: 15}, (_, i) => `r${i}`);
    const references = Array.from({length: 15}, (_, i) => `ref${i}`);
    const r = await invoke(routes, {method: 'POST', path: '/api/glossary', body: {...OK, relatedTerms, references}, ctx});
    assert.equal(r.status, 200);
    const {id, createdAt, ...stable} = r.payload.entry;
    assert.deepEqual(stable.term, 'Entropy');
    assert.equal(stable.relatedTerms.length, 10);
    assert.equal(stable.references.length, 10);
    assert.match(id, /^gl_\d+_[a-z0-9]+$/);
  });

  it('defaults the related lists to empty when they are not arrays', async () => {
    const r = await invoke(routes, {method: 'POST', path: '/api/glossary', body: {...OK, relatedTerms: 'x', references: 7}});
    assert.deepEqual([r.payload.entry.relatedTerms, r.payload.entry.references], [[], []]);
  });
});

describe('DELETE /api/glossary', () => {
  const CASES = [
    {name: 'a missing id', body: {}, store: {terms: []}, status: 400, error: 'Missing id'},
    {name: 'a store with no terms key', body: {id: 'g1'}, store: {}, status: 404, error: 'Term not found'},
    {name: 'an unknown id', body: {id: 'nope'}, store: {terms: [{id: 'g1'}]}, status: 404, error: 'Term not found'},
  ];
  for (const {name, body, store, status, error} of CASES) {
    it(`rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: {[GLOSSARY_FILE]: store}});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/glossary', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('removes the matching term', async () => {
    const ctx = makeCtx({store: {[GLOSSARY_FILE]: {terms: [{id: 'g1'}, {id: 'g2'}]}}});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/glossary', body: {id: 'g1'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[GLOSSARY_FILE].terms.map(t => t.id), ['g2']);
  });
});

// ── Study plan ────────────────────────────────────────────────────────────

describe('POST /api/study-plan', () => {
  const words = n => Array.from({length: n}, (_, i) => `w${i}`).join(' ');
  const LIST = {
    id: 'l1', name: 'My List',
    items: [
      {path: 'content/long.md', type: 'doc'},
      {path: 'content/short.md', type: 'doc'},
      {path: 'someref', type: 'reference'},
    ],
  };
  const files = {[at('content/long.md')]: words(2400), [at('content/short.md')]: words(100)};
  const store = {[READING_LISTS_FILE]: {lists: [LIST]}};

  it('returns 429 with the study-plan key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/study-plan', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'study-plan:127.0.0.1', maxPerMinute: 30}]);
  });

  for (const [label, body] of [['an omitted listId', {}], ['a non-string listId', {listId: 7}]]) {
    it(`rejects ${label}`, async () => {
      const {ctx} = fsCtx(files, {store});
      const r = await invoke(routes, {method: 'POST', path: '/api/study-plan', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Missing or invalid listId'}]);
    });
  }

  it('returns 404 for an unknown list', async () => {
    const {ctx} = fsCtx(files, {store});
    const r = await invoke(routes, {method: 'POST', path: '/api/study-plan', body: {listId: 'nope'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'Reading list not found'}]);
  });

  it('estimates reading time per item with a five-minute floor', async () => {
    const {ctx} = fsCtx(files, {store});
    const r = await invoke(routes, {method: 'POST', path: '/api/study-plan', body: {listId: 'l1'}, ctx});
    assert.equal(r.status, 200);
    const items = r.payload.plan.weeks.flatMap(w => w.items);
    const byPath = Object.fromEntries(items.map(i => [i.path, i]));
    // 2400 words at 200 per minute is twelve minutes.
    assert.deepEqual([byPath['content/long.md'].wordCount, byPath['content/long.md'].readingTimeMin], [2400, 12]);
    // 100 words rounds up to one minute, which the floor lifts to five.
    assert.deepEqual([byPath['content/short.md'].wordCount, byPath['content/short.md'].readingTimeMin], [100, 5]);
    // A reference is not read from disk, so it takes the floor with no words.
    assert.deepEqual([byPath.someref.wordCount, byPath.someref.readingTimeMin], [0, 5]);
    assert.deepEqual(items.map(i => i.order), [0, 1, 2]);
  });

  it('packs items into weeks by the hours-per-week budget', async () => {
    const {ctx} = fsCtx(files, {store});
    // A one-hour week holds sixty minutes, so the twelve-minute item and the two
    // five-minute ones all fit in week one.
    const roomy = await invoke(routes, {method: 'POST', path: '/api/study-plan', body: {listId: 'l1', hoursPerWeek: 1}, ctx});
    assert.equal(roomy.payload.plan.estimatedWeeks, 1);
    assert.deepEqual(roomy.payload.plan.weeks[0].totalMinutes, 22);

    // A budget under the first item still places it, since an empty week is
    // never flushed, and then starts a new week for the rest.
    const {ctx: tight} = fsCtx(files, {store});
    const cramped = await invoke(routes, {method: 'POST', path: '/api/study-plan', body: {listId: 'l1', hoursPerWeek: 0.1}, ctx: tight});
    assert.ok(cramped.payload.plan.estimatedWeeks > 1);
    assert.deepEqual(cramped.payload.plan.weeks.map(w => w.week), cramped.payload.plan.weeks.map((_, i) => i + 1));
    // The guard keeps an over-budget first item in its week rather than
    // flushing an empty one, so no week is ever empty.
    for (const w of cramped.payload.plan.weeks) assert.ok(w.items.length > 0, `week ${w.week} is empty`);
  });

  it('reports the plan envelope with the default ten hours per week', async () => {
    const {ctx} = fsCtx(files, {store});
    const r = await invoke(routes, {method: 'POST', path: '/api/study-plan', body: {listId: 'l1'}, ctx});
    const {plan} = r.payload;
    assert.deepEqual([plan.listName, plan.totalItems, plan.totalReadingMinutes, plan.hoursPerWeek], ['My List', 3, 22, 10]);
  });

  it('returns an empty plan for a list with no items', async () => {
    const {ctx} = fsCtx(files, {store: {[READING_LISTS_FILE]: {lists: [{id: 'l1', name: 'Empty'}]}}});
    const r = await invoke(routes, {method: 'POST', path: '/api/study-plan', body: {listId: 'l1'}, ctx});
    assert.deepEqual([r.payload.plan.totalItems, r.payload.plan.estimatedWeeks, r.payload.plan.weeks], [0, 0, []]);
  });
});

// ── Research questions ────────────────────────────────────────────────────

describe('/api/research-questions', () => {
  const QUESTIONS = [
    {id: 'q1', question: 'Why?', status: 'open'},
    {id: 'q2', question: 'How?', status: 'resolved'},
  ];
  const store = () => ({[RQ_FILE]: {questions: structuredClone(QUESTIONS)}});

  it('GET lists every question, or filters by status', async () => {
    const all = await invoke(routes, {path: '/api/research-questions', ctx: makeCtx({store: store()})});
    assert.deepEqual([all.status, all.payload.total], [200, 2]);
    const open = await invoke(routes, {path: '/api/research-questions', query: {status: 'open'}, ctx: makeCtx({store: store()})});
    assert.deepEqual(open.payload.questions.map(q => q.id), ['q1']);
  });

  it('GET returns an empty list for a store with no questions', async () => {
    const r = await invoke(routes, {path: '/api/research-questions'});
    assert.deepEqual(r.payload, {questions: [], total: 0});
  });

  const RATE_GATES = [
    {method: 'POST', key: 'rq:127.0.0.1'},
    {method: 'PUT', key: 'rq-update:127.0.0.1'},
  ];
  for (const {method, key} of RATE_GATES) {
    it(`${method} returns 429 with the ${key.split(':')[0]} key`, async () => {
      const ctx = makeCtx({rateLimitAllow: false});
      const r = await invoke(routes, {method, path: '/api/research-questions', ctx});
      assert.equal(r.status, 429);
      assert.deepEqual(ctx.calls.rateLimit, [{key, maxPerMinute: 30}]);
    });
  }

  const POST_GUARDS = [
    {name: 'an omitted question', body: {}, error: 'Missing or invalid question'},
    {name: 'a non-string question', body: {question: 7}, error: 'Missing or invalid question'},
    {name: 'a question over 5000 characters', body: {question: 'q'.repeat(5001)}, error: 'Question must be 5000 characters or fewer'},
    {name: 'a context over 5000 characters', body: {question: 'q', context: 'c'.repeat(5001)}, error: 'Context must be 5000 characters or fewer'},
  ];
  for (const {name, body, error} of POST_GUARDS) {
    it(`POST rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/research-questions', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('POST creates an open question with capped lists', async () => {
    const ctx = makeCtx();
    const relatedPapers = Array.from({length: 25}, (_, i) => `p${i}`);
    const tags = Array.from({length: 15}, (_, i) => `t${i}`);
    const r = await invoke(routes, {method: 'POST', path: '/api/research-questions', body: {question: 'Why?', relatedPapers, tags}, ctx});
    assert.equal(r.status, 200);
    const q = r.payload.question;
    assert.deepEqual([q.question, q.status, q.context], ['Why?', 'open', '']);
    assert.deepEqual([q.relatedPapers.length, q.tags.length], [20, 10]);
    assert.match(q.id, /^rq_\d+_[a-z0-9]+$/);
  });

  const PUT_GUARDS = [
    {name: 'an omitted id', body: {}, status: 400, error: 'Missing or invalid id'},
    {name: 'a non-string id', body: {id: 7}, status: 400, error: 'Missing or invalid id'},
    {name: 'an answer over 5000 characters', body: {id: 'q1', answer: 'a'.repeat(5001)}, status: 400, error: 'Answer must be 5000 characters or fewer'},
    {name: 'an unknown id', body: {id: 'nope'}, status: 404, error: 'Question not found'},
  ];
  for (const {name, body, status, error} of PUT_GUARDS) {
    it(`PUT rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: store()});
      const r = await invoke(routes, {method: 'PUT', path: '/api/research-questions', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('PUT applies a recognised status and ignores an unrecognised one', async () => {
    for (const [given, want] of [['in-progress', 'in-progress'], ['resolved', 'resolved'], ['bogus', 'open']]) {
      const ctx = makeCtx({store: store()});
      const r = await invoke(routes, {method: 'PUT', path: '/api/research-questions', body: {id: 'q1', status: given}, ctx});
      assert.equal(r.payload.question.status, want, given);
      assert.ok(r.payload.question.updatedAt);
    }
  });

  it('PUT records an answer', async () => {
    const ctx = makeCtx({store: store()});
    const r = await invoke(routes, {method: 'PUT', path: '/api/research-questions', body: {id: 'q1', answer: 'Because'}, ctx});
    assert.equal(r.payload.question.answer, 'Because');
    assert.equal(ctx.calls.saveJSON.length, 1);
  });

  const DELETE_CASES = [
    {name: 'a missing id', body: {}, stored: {questions: []}, status: 400, error: 'Missing id'},
    {name: 'a store with no questions key', body: {id: 'q1'}, stored: {}, status: 404, error: 'Not found'},
    {name: 'an unknown id', body: {id: 'nope'}, stored: {questions: QUESTIONS}, status: 404, error: 'Question not found'},
  ];
  for (const {name, body, stored, status, error} of DELETE_CASES) {
    it(`DELETE rejects ${name}`, async () => {
      const ctx = makeCtx({store: {[RQ_FILE]: stored}});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/research-questions', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('DELETE removes the matching question', async () => {
    const ctx = makeCtx({store: store()});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/research-questions', body: {id: 'q1'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[RQ_FILE].questions.map(q => q.id), ['q2']);
  });
});

// ── Quick notes ───────────────────────────────────────────────────────────

describe('GET /api/quicknotes', () => {
  const JSON_NOTES = [
    {id: 'n1', text: 'older', updatedAt: '2026-01-01T00:00:00.000Z'},
    {id: 'n2', text: 'newer', updatedAt: '2026-02-01T00:00:00.000Z'},
  ];

  it('returns the stored notes newest first', async () => {
    const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {default: JSON_NOTES}}, fs: mockFs({})});
    const r = await invoke(routes, {path: '/api/quicknotes', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.map(n => n.id), ['n2', 'n1']);
  });

  for (const userId of [...PROTO_KEYS, ...INHERITED_KEYS, 'absent']) {
    it(`returns nothing for the non-own user ${JSON.stringify(userId)}`, async () => {
      const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {default: JSON_NOTES}}, fs: mockFs({})});
      const r = await invoke(routes, {path: '/api/quicknotes', query: {userId}, ctx});
      assert.deepEqual(r.payload, []);
    });
  }

  it('appends blog-sourced notes tagged quick-note, newest filename first', async () => {
    const blog = rel => at(`content/posts/blog/${rel}`);
    const files = {
      [blog('2026-02-01-second.md')]: `${fm({title: 'Second', tags: '[quick-note]'})}\nSecond body\n`,
      [blog('2026-01-01-first.md')]: `${fm({title: 'First', tags: '[quick-note]'})}\nFirst body\n`,
      [blog('2026-03-01-regular.md')]: fm({title: 'Regular'}, 'not a quick note'),
      [blog('notes.txt')]: 'quick-note but wrong extension',
    };
    const ctx = makeCtx({fs: mockFs(files)});
    const r = await invoke(routes, {path: '/api/quicknotes', ctx});
    assert.deepEqual(r.payload.map(n => n.id), ['2026-02-01-second.md', '2026-01-01-first.md']);
    assert.deepEqual(r.payload[0], {
      id: '2026-02-01-second.md',
      text: 'Second body',
      title: 'Second',
      date: '2026-02-01',
      path: 'content/posts/blog/2026-02-01-second.md',
      source: 'blog',
    });
  });

  it('caps the blog notes at fifty', async () => {
    const files = {};
    for (let i = 0; i < 60; i++) files[at(`content/posts/blog/2026-01-${String(i + 1).padStart(2, '0')}-n.md`)] = `${fm({title: `N${i}`, tags: '[quick-note]'})}\nbody\n`;
    const ctx = makeCtx({fs: mockFs(files)});
    const r = await invoke(routes, {path: '/api/quicknotes', ctx});
    assert.equal(r.payload.length, 50);
  });

  it('returns only the stored notes when the blog directory is absent', async () => {
    const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {default: JSON_NOTES}}, fs: mockFs({})});
    const r = await invoke(routes, {path: '/api/quicknotes', ctx});
    assert.equal(r.payload.length, 2);
  });
});

describe('POST and DELETE /api/quicknotes', () => {
  it('returns 429 with the quicknotes key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/quicknotes', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'quicknotes:127.0.0.1', maxPerMinute: 30}]);
  });

  const GUARDS = [
    {name: 'an omitted text', body: {}, error: 'Missing or invalid text'},
    {name: 'a non-string text', body: {text: 7}, error: 'Missing or invalid text'},
    {name: 'a text over the length cap', body: {text: 't'.repeat(10001)}, error: 'Text too long'},
    {name: 'a non-string userId', body: {text: 't', userId: 7}, error: 'userId must be a string'},
    {name: 'a userId over 200 characters', body: {text: 't', userId: 'u'.repeat(201)}, error: 'userId must be 200 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`POST rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/quicknotes', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('POST stores the note with the default colour', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/quicknotes', body: {text: 'jot'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.note.color, '#fef3c7');
    assert.match(r.payload.note.id, /^qn_\d+_[a-z0-9]+$/);
    assert.deepEqual(ctx.store[QUICKNOTES_FILE].default, [r.payload.note]);
  });

  // Only a hex colour of three to eight digits is accepted.
  const COLOURS = [['#abc', '#abc'], ['#aabbccdd', '#aabbccdd'], ['red', '#fef3c7'], ['#gg', '#fef3c7'], [undefined, '#fef3c7']];
  for (const [given, want] of COLOURS) {
    it(`POST normalises the colour ${JSON.stringify(given)} to ${want}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/quicknotes', body: {text: 't', color: given}});
      assert.equal(r.payload.note.color, want);
    });
  }

  it('POST caps a user history at the most recent two hundred notes', async () => {
    const existing = Array.from({length: 200}, (_, i) => ({id: `n${i}`}));
    const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {default: existing}}});
    await invoke(routes, {method: 'POST', path: '/api/quicknotes', body: {text: 't'}, ctx});
    const saved = ctx.store[QUICKNOTES_FILE].default;
    assert.equal(saved.length, 200);
    assert.equal(saved[0].id, 'n1');
  });

  for (const userId of INHERITED_KEYS) {
    it(`POST stores the inherited userId ${JSON.stringify(userId)} as an own key`, async () => {
      const ctx = makeCtx();
      await invoke(routes, {method: 'POST', path: '/api/quicknotes', body: {text: 't', userId}, ctx});
      assert.ok(Object.hasOwn(ctx.store[QUICKNOTES_FILE], userId));
    });
  }

  const DELETE_CASES = [
    {name: 'a missing id', body: {}, stored: {default: [{id: 'n1'}]}, status: 400, error: 'Missing id'},
    {name: 'an absent user', body: {id: 'n1', userId: 'nobody'}, stored: {default: [{id: 'n1'}]}, status: 404, error: 'Note not found'},
    {name: 'an unknown id', body: {id: 'nope'}, stored: {default: [{id: 'n1'}]}, status: 404, error: 'Note not found'},
  ];
  for (const {name, body, stored, status, error} of DELETE_CASES) {
    it(`DELETE rejects ${name}`, async () => {
      const ctx = makeCtx({store: {[QUICKNOTES_FILE]: stored}});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/quicknotes', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('DELETE removes the matching note', async () => {
    const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {default: [{id: 'n1'}, {id: 'n2'}]}}});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/quicknotes', body: {id: 'n1'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[QUICKNOTES_FILE].default.map(n => n.id), ['n2']);
  });
});

describe('quicknotes parser regexes', () => {
  const CANONICAL = {
    QUICKNOTES_TITLE_RE: /^title:\s*"?(.+?)"?\s*$/m,
    QUICKNOTES_DATE_RE: /^(\d{4}-\d{2}-\d{2})/,
    QUICKNOTES_BODY_RE: /---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)/,
  };
  for (const [name, canonical] of Object.entries(CANONICAL)) {
    it(`${name} matches its canonical literal and is one shared instance`, () => {
      const re = routes[name];
      assert.equal(re.source, canonical.source, name);
      assert.equal(re.flags, canonical.flags, name);
      assert.equal(re.global, false, name);
      assert.strictEqual(loadRoute('study-knowledge')[name], re, name);
    });
  }

  // The front-matter title matcher accepts either quote style, unlike the
  // quicknotes one which accepts a double quote only.
  it('FRONTMATTER_TITLE_RE accepts a single, double or absent quote', () => {
    const canonical = /^title:\s*["']?(.+?)["']?\s*$/m;
    assert.equal(FRONTMATTER_TITLE_RE.source, canonical.source);
    assert.equal(FRONTMATTER_TITLE_RE.flags, canonical.flags);
    for (const [line, want] of [['title: "Q"', 'Q'], ["title: 'Q'", 'Q'], ['title: Q', 'Q']]) {
      assert.equal(line.match(FRONTMATTER_TITLE_RE)[1], want, line);
    }
    assert.strictEqual(loadRoute('study-knowledge').FRONTMATTER_TITLE_RE, FRONTMATTER_TITLE_RE);
  });
});

// ── Pins ──────────────────────────────────────────────────────────────────

describe('/api/pins', () => {
  it('GET lists the stored pins, defaulting to empty', async () => {
    const withPins = await invoke(routes, {path: '/api/pins', ctx: makeCtx({store: {[PINS_FILE]: {pins: [{path: '/a'}]}}})});
    assert.deepEqual([withPins.status, withPins.payload], [200, {pins: [{path: '/a'}]}]);
    const empty = await invoke(routes, {path: '/api/pins'});
    assert.deepEqual(empty.payload, {pins: []});
  });

  it('POST returns 429 with the pins key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/pins', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'pins:127.0.0.1', maxPerMinute: 30}]);
  });

  const GUARDS = [
    {name: 'an omitted path', body: {}, error: 'Missing or invalid path'},
    {name: 'a non-string path', body: {path: 7}, error: 'Missing or invalid path'},
    {name: 'a path over 500 characters', body: {path: 'p'.repeat(501)}, error: 'Path must be 500 characters or fewer'},
    {name: 'a title over 500 characters', body: {path: '/a', title: 't'.repeat(501)}, error: 'Title must be 500 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`POST rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/pins', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('POST adds a pin, defaulting the title to the path', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/pins', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    const [pin] = ctx.store[PINS_FILE].pins;
    assert.deepEqual([pin.path, pin.title], ['/a', '/a']);
    assert.ok(pin.pinnedAt);
  });

  it('POST is idempotent for an already pinned path', async () => {
    const ctx = makeCtx({store: {[PINS_FILE]: {pins: [{path: '/a'}]}}});
    const r = await invoke(routes, {method: 'POST', path: '/api/pins', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true, message: 'Already pinned'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  const DELETE_CASES = [
    {name: 'a missing path', body: {}, stored: {pins: []}, status: 400, error: 'Missing path'},
    {name: 'a store with no pins key', body: {path: '/a'}, stored: {}, status: 404, error: 'Not pinned'},
    {name: 'an unpinned path', body: {path: '/gone'}, stored: {pins: [{path: '/a'}]}, status: 404, error: 'Not pinned'},
  ];
  for (const {name, body, stored, status, error} of DELETE_CASES) {
    it(`DELETE rejects ${name}`, async () => {
      const ctx = makeCtx({store: {[PINS_FILE]: stored}});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/pins', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('DELETE removes the matching pin', async () => {
    const ctx = makeCtx({store: {[PINS_FILE]: {pins: [{path: '/a'}, {path: '/b'}]}}});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/pins', body: {path: '/a'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[PINS_FILE].pins.map(p => p.path), ['/b']);
  });
});

// ── Preferences ───────────────────────────────────────────────────────────

describe('/api/preferences', () => {
  const PREFS = {alice: {theme: 'dark'}};

  it('GET returns 400 without a userId', async () => {
    const r = await invoke(routes, {path: '/api/preferences'});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing userId'}]);
  });

  it('GET returns the stored preferences for a real user', async () => {
    const r = await invoke(routes, {path: '/api/preferences', query: {userId: 'alice'}, ctx: makeCtx({store: {[PREFS_FILE]: PREFS}})});
    assert.deepEqual([r.status, r.payload], [200, {preferences: {theme: 'dark'}}]);
  });

  for (const userId of [...PROTO_KEYS, ...INHERITED_KEYS, 'absent']) {
    it(`GET returns an empty object for the non-own user ${JSON.stringify(userId)}`, async () => {
      const r = await invoke(routes, {path: '/api/preferences', query: {userId}, ctx: makeCtx({store: {[PREFS_FILE]: PREFS}})});
      assert.deepEqual([r.status, r.payload], [200, {preferences: {}}]);
    });
  }

  it('PUT returns 429 with the prefs key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'prefs:127.0.0.1', maxPerMinute: 30}]);
  });

  const GUARDS = [
    {name: 'an omitted userId', body: {preferences: {}}, error: 'Missing or invalid userId'},
    {name: 'a non-string userId', body: {userId: 7, preferences: {}}, error: 'Missing or invalid userId'},
    {name: 'a userId over 200 characters', body: {userId: 'u'.repeat(201), preferences: {}}, error: 'userId must be 200 characters or fewer'},
    {name: 'an omitted preferences', body: {userId: 'u'}, error: 'Missing or invalid preferences'},
    {name: 'a non-object preferences', body: {userId: 'u', preferences: 'x'}, error: 'Missing or invalid preferences'},
    {name: 'an array preferences', body: {userId: 'u', preferences: []}, error: 'Missing or invalid preferences'},
    ...PROTO_KEYS.map(userId => ({name: `the proto userId ${JSON.stringify(userId)}`, body: {userId, preferences: {}}, error: 'Invalid userId'})),
    ...PROTO_KEYS.map(k => ({name: `the proto preference key ${JSON.stringify(k)}`, body: {userId: 'u', preferences: {[k]: 1}}, error: `Invalid preference key: ${k}`})),
  ];
  for (const {name, body, error} of GUARDS) {
    it(`PUT rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
      assert.equal({}.polluted, undefined);
    });
  }

  it('PUT merges the supplied keys and stamps updatedAt', async () => {
    const ctx = makeCtx({store: {[PREFS_FILE]: {alice: {theme: 'dark', keep: 'me'}}}});
    const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', body: {userId: 'alice', preferences: {theme: 'light', size: 14}}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual([r.payload.preferences.theme, r.payload.preferences.size, r.payload.preferences.keep], ['light', 14, 'me']);
    assert.ok(r.payload.preferences.updatedAt);
  });

  it('PUT truncates a string preference at 5000 characters', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', body: {userId: 'u', preferences: {bio: 'b'.repeat(6000)}}, ctx});
    assert.equal(r.payload.preferences.bio.length, 5000);
  });

  for (const userId of INHERITED_KEYS) {
    it(`PUT writes the inherited userId ${JSON.stringify(userId)} as an own key`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', body: {userId, preferences: {a: 1}}, ctx});
      assert.equal(r.status, 200);
      assert.ok(Object.hasOwn(ctx.store[PREFS_FILE], userId));
    });
  }
});

// ── Bookmark folders ──────────────────────────────────────────────────────

describe('/api/bookmarks/folders', () => {
  it('GET lists the stored folders, defaulting to empty', async () => {
    const withFolders = await invoke(routes, {path: '/api/bookmarks/folders', ctx: makeCtx({store: {[BOOKMARKS_FILE]: {folders: [{id: 'a'}]}}})});
    assert.deepEqual(withFolders.payload, {folders: [{id: 'a'}]});
    const empty = await invoke(routes, {path: '/api/bookmarks/folders'});
    assert.deepEqual(empty.payload, {folders: []});
  });

  it('POST returns 429 with the bm-folders key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks/folders', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'bm-folders:127.0.0.1', maxPerMinute: 30}]);
  });

  const GUARDS = [
    {name: 'an omitted name', body: {}, status: 400, error: 'Missing name'},
    {name: 'a non-string name', body: {name: 7}, status: 400, error: 'Missing name'},
    {name: 'a name over 200 characters', body: {name: 'n'.repeat(201)}, status: 400, error: 'Name must be 200 characters or fewer'},
  ];
  for (const {name, body, status, error} of GUARDS) {
    it(`POST rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks/folders', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('POST creates a folder with a slugified id', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks/folders', body: {name: 'My New Folder!'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual([r.payload.folder.id, r.payload.folder.name], ['my-new-folder', 'My New Folder!']);
  });

  it('POST returns 409 for a colliding slug', async () => {
    const ctx = makeCtx({store: {[BOOKMARKS_FILE]: {folders: [{id: 'my-folder'}]}}});
    const r = await invoke(routes, {method: 'POST', path: '/api/bookmarks/folders', body: {name: 'My Folder'}, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Folder already exists'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });
});

// ── Reviews ───────────────────────────────────────────────────────────────

describe('/api/reviews', () => {
  const REVIEWS = [{id: 'r1', status: 'pending'}, {id: 'r2', status: 'approved'}];
  const store = () => ({[REVIEWS_FILE]: {reviews: structuredClone(REVIEWS)}});

  it('GET lists every review, or filters by status', async () => {
    const all = await invoke(routes, {path: '/api/reviews', ctx: makeCtx({store: store()})});
    assert.deepEqual([all.status, all.payload.total], [200, 2]);
    const pending = await invoke(routes, {path: '/api/reviews', query: {status: 'pending'}, ctx: makeCtx({store: store()})});
    assert.deepEqual(pending.payload.reviews.map(r => r.id), ['r1']);
  });

  for (const [method, key] of [['POST', 'reviews:127.0.0.1'], ['PUT', 'reviews-update:127.0.0.1']]) {
    it(`${method} returns 429 with the ${key.split(':')[0]} key`, async () => {
      const ctx = makeCtx({rateLimitAllow: false});
      const r = await invoke(routes, {method, path: '/api/reviews', ctx});
      assert.equal(r.status, 429);
      assert.deepEqual(ctx.calls.rateLimit, [{key, maxPerMinute: 30}]);
    });
  }

  const POST_GUARDS = [
    {name: 'an omitted path', body: {}, error: 'Missing or invalid path'},
    {name: 'a non-string path', body: {path: 7}, error: 'Missing or invalid path'},
    {name: 'a path over 500 characters', body: {path: 'p'.repeat(501)}, error: 'Path must be 500 characters or fewer'},
    {name: 'a requestedBy over 100 characters', body: {path: '/a', requestedBy: 'r'.repeat(101)}, error: 'requestedBy must be 100 characters or fewer'},
    {name: 'a note over 5000 characters', body: {path: '/a', note: 'n'.repeat(5001)}, error: 'Note must be 5000 characters or fewer'},
  ];
  for (const {name, body, error} of POST_GUARDS) {
    it(`POST rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/reviews', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('POST creates a pending review with Anonymous as the default requester', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/reviews', body: {path: '/a'}, ctx});
    assert.equal(r.status, 200);
    const {id, createdAt, ...stable} = r.payload.review;
    assert.deepEqual(stable, {path: '/a', requestedBy: 'Anonymous', note: '', status: 'pending'});
    assert.match(id, /^rev_\d+_[a-z0-9]+$/);
  });

  const PUT_GUARDS = [
    {name: 'an omitted id', body: {status: 'approved'}, status: 400, error: 'Missing or invalid id'},
    {name: 'a non-string id', body: {id: 7, status: 'approved'}, status: 400, error: 'Missing or invalid id'},
    {name: 'an omitted status', body: {id: 'r1'}, status: 400, error: 'Missing or invalid status'},
    {name: 'a non-string status', body: {id: 'r1', status: 7}, status: 400, error: 'Missing or invalid status'},
    {name: 'a status outside the allow list', body: {id: 'r1', status: 'maybe'}, status: 400, error: 'Invalid status'},
    {name: 'a reviewedBy over 100 characters', body: {id: 'r1', status: 'approved', reviewedBy: 'r'.repeat(101)}, status: 400, error: 'reviewedBy must be 100 characters or fewer'},
    {name: 'a feedback over 5000 characters', body: {id: 'r1', status: 'approved', feedback: 'f'.repeat(5001)}, status: 400, error: 'Feedback must be 5000 characters or fewer'},
    {name: 'an unknown id', body: {id: 'nope', status: 'approved'}, status: 404, error: 'Review not found'},
  ];
  for (const {name, body, status, error} of PUT_GUARDS) {
    it(`PUT rejects ${name} without saving`, async () => {
      const ctx = makeCtx({store: store()});
      const r = await invoke(routes, {method: 'PUT', path: '/api/reviews', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('PUT applies each allowed status and nulls the omitted optional fields', async () => {
    for (const status of ['approved', 'rejected', 'pending']) {
      const ctx = makeCtx({store: store()});
      const r = await invoke(routes, {method: 'PUT', path: '/api/reviews', body: {id: 'r1', status}, ctx});
      assert.equal(r.payload.review.status, status);
      assert.deepEqual([r.payload.review.reviewedBy, r.payload.review.feedback], [null, null]);
      assert.ok(r.payload.review.reviewedAt);
    }
  });

  it('PUT records the reviewer and feedback', async () => {
    const ctx = makeCtx({store: store()});
    const r = await invoke(routes, {method: 'PUT', path: '/api/reviews', body: {id: 'r1', status: 'approved', reviewedBy: 'Ada', feedback: 'looks good'}, ctx});
    assert.deepEqual([r.payload.review.reviewedBy, r.payload.review.feedback], ['Ada', 'looks good']);
    assert.equal(ctx.calls.saveJSON.length, 1);
  });
});

// ── Custom templates ──────────────────────────────────────────────────────

describe('/api/templates/custom', () => {
  it('POST returns 429 with the templates key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'POST', path: '/api/templates/custom', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'templates:127.0.0.1', maxPerMinute: 30}]);
  });

  const GUARDS = [
    {name: 'an omitted name', body: {content: 'c'}, error: 'Missing or invalid name'},
    {name: 'a non-string name', body: {name: 7, content: 'c'}, error: 'Missing or invalid name'},
    {name: 'a name over 200 characters', body: {name: 'n'.repeat(201), content: 'c'}, error: 'Name must be 200 characters or fewer'},
    {name: 'an omitted content', body: {name: 'n'}, error: 'Missing or invalid content'},
    {name: 'a non-string content', body: {name: 'n', content: 7}, error: 'Missing or invalid content'},
    {name: 'content over 50000 characters', body: {name: 'n', content: 'c'.repeat(50001)}, error: 'Content must be 50000 characters or fewer'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`POST rejects ${name} without saving`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'POST', path: '/api/templates/custom', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('POST creates a template with a slugified id', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'POST', path: '/api/templates/custom', body: {name: 'My Template!', content: 'body'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual([r.payload.template.id, r.payload.template.name], ['my-template', 'My Template!']);
    assert.deepEqual(ctx.store[TEMPLATES_FILE].items, [r.payload.template]);
  });

  it('POST returns 409 for a colliding slug', async () => {
    const ctx = makeCtx({store: {[TEMPLATES_FILE]: {items: [{id: 'my-template'}]}}});
    const r = await invoke(routes, {method: 'POST', path: '/api/templates/custom', body: {name: 'My Template', content: 'c'}, ctx});
    assert.deepEqual([r.status, r.payload], [409, {error: 'Template with this name already exists'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  const DELETE_CASES = [
    {name: 'a missing id', body: {}, stored: {items: []}, status: 400, error: 'Missing id'},
    {name: 'a store with no items key', body: {id: 't1'}, stored: {}, status: 404, error: 'Template not found'},
    {name: 'an unknown id', body: {id: 'nope'}, stored: {items: [{id: 't1'}]}, status: 404, error: 'Template not found'},
  ];
  for (const {name, body, stored, status, error} of DELETE_CASES) {
    it(`DELETE rejects ${name}`, async () => {
      const ctx = makeCtx({store: {[TEMPLATES_FILE]: stored}});
      const r = await invoke(routes, {method: 'DELETE', path: '/api/templates/custom', body, ctx});
      assert.deepEqual([r.status, r.payload], [status, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('DELETE removes the matching template', async () => {
    const ctx = makeCtx({store: {[TEMPLATES_FILE]: {items: [{id: 't1'}, {id: 't2'}]}}});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/templates/custom', body: {id: 't1'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[TEMPLATES_FILE].items.map(t => t.id), ['t2']);
  });
});

// ── Per-page analytics ────────────────────────────────────────────────────

describe('GET /api/analytics/page', () => {
  const STORE = {
    [ANALYTICS_FILE]: {counts: {'/p': 7}},
    [COMMENTS_FILE]: {'/p': [{}, {}]},
    [BOOKMARKS_FILE]: {bookmarks: [{path: '/p'}]},
    [READING_LISTS_FILE]: {lists: [{items: [{path: '/p'}]}, {items: [{path: '/other'}]}, {}]},
  };

  it('returns 400 without a path', async () => {
    const r = await invoke(routes, {path: '/api/analytics/page'});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing path'}]);
  });

  it('aggregates views, comments, bookmark state and reading-list membership', async () => {
    const r = await invoke(routes, {path: '/api/analytics/page', query: {path: '/p'}, ctx: makeCtx({store: STORE})});
    assert.deepEqual(r.payload, {path: '/p', views: 7, comments: 2, isBookmarked: true, inReadingLists: 1});
  });

  it('zeroes every counter for an unseen page', async () => {
    const r = await invoke(routes, {path: '/api/analytics/page', query: {path: '/unseen'}, ctx: makeCtx({store: STORE})});
    assert.deepEqual(r.payload, {path: '/unseen', views: 0, comments: 0, isBookmarked: false, inReadingLists: 0});
  });

  // Both lookups are own-key checks, so an inherited name cannot leak a
  // function or an object into the numeric fields.
  for (const pagePath of [...PROTO_KEYS, ...INHERITED_KEYS]) {
    it(`returns zeroes for the non-own page ${JSON.stringify(pagePath)}`, async () => {
      const r = await invoke(routes, {path: '/api/analytics/page', query: {path: pagePath}, ctx: makeCtx({store: STORE})});
      assert.deepEqual([r.payload.views, r.payload.comments], [0, 0]);
    });
  }
});

// ── Knowledge-base report ─────────────────────────────────────────────────

describe('GET /api/report/knowledge-base', () => {
  const words = n => Array.from({length: n}, (_, i) => `w${i}`).join(' ');
  const TREE = {
    [at('content/books/a.md')]: fm({tags: `['alpha', "beta"]`}, words(400)),
    [at('content/books/deep/b.md')]: fm({tags: '[alpha]'}, words(200)),
    [at('content/loose.md')]: words(100),
    [at('content/_skip.md')]: words(999),
    [BIB]: bib({r1: {title: 'R1'}, r2: {title: 'R2'}}),
  };

  it('summarises files, words, sections and top tags', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/report/knowledge-base', ctx});
    assert.equal(r.status, 200);
    // The word count covers the whole file, front matter included, so the two
    // front-matter blocks add nine tokens to the 700 body words.
    assert.deepEqual(r.payload.overview, {totalFiles: 3, totalWords: 709, references: 2, avgWordsPerFile: 236});
    // A nested directory rolls up into its top-level ancestor; a file directly
    // under content/ lands in "root".
    assert.deepEqual(r.payload.sections, [{name: 'books', files: 2, words: 609}, {name: 'root', files: 1, words: 100}]);
    assert.deepEqual(r.payload.topTags, [{tag: 'alpha', count: 2}, {tag: 'beta', count: 1}]);
    assert.ok(r.payload.generatedAt);
  });

  it('reports zero references when the bibliography is unreadable', async () => {
    const files = {...TREE, [BIB]: '\tnot: [valid'};
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/report/knowledge-base', ctx});
    assert.equal(r.payload.overview.references, 0);
  });

  it('avoids dividing by zero for an empty content tree', async () => {
    const {ctx} = fsCtx({[at('content/.keep')]: '', [BIB]: ''});
    const r = await invoke(routes, {path: '/api/report/knowledge-base', ctx});
    assert.deepEqual(r.payload.overview, {totalFiles: 0, totalWords: 0, references: 0, avgWordsPerFile: 0});
  });

  it('caps the tag list at ten', async () => {
    const files = {};
    for (let i = 0; i < 15; i++) files[at(`content/t${i}.md`)] = fm({tags: `[tag${i}]`}, 'x');
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/report/knowledge-base', ctx});
    assert.equal(r.payload.topTags.length, 10);
  });

  // The scan is memoized but generatedAt is computed outside, so each response
  // carries a fresh timestamp.
  it('memoizes the scan under "kb-report" while keeping generatedAt per request', async () => {
    let seen;
    const {ctx, counts} = fsCtx(TREE, {cached: (k, t, fn) => { seen = [k, t]; return ctx.cache[k] ?? (ctx.cache[k] = fn()); }});
    const first = await invoke(routes, {path: '/api/report/knowledge-base', ctx});
    assert.deepEqual(seen, ['kb-report', 60000]);
    const after = counts.readdir;
    const second = await invoke(routes, {path: '/api/report/knowledge-base', ctx});
    assert.equal(counts.readdir, after);
    assert.deepEqual(second.payload.overview, first.payload.overview);
    assert.ok(second.payload.generatedAt);
  });

  it('returns 500 without caching when the walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/report/knowledge-base', ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Report generation failed'}]);
    assert.deepEqual(Object.keys(ctx.cache), []);
  });
});

// Every body-reading handler wraps the read in one try whose catch returns a
// fixed 400 ahead of the first inner guard.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/flashcards', error: 'Invalid request'},
    {method: 'POST', path: '/api/flashcards/review', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/flashcards', error: 'Invalid request'},
    {method: 'POST', path: '/api/glossary', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/glossary', error: 'Invalid request'},
    {method: 'POST', path: '/api/study-plan', error: 'Study plan generation failed'},
    {method: 'POST', path: '/api/research-questions', error: 'Invalid request'},
    {method: 'PUT', path: '/api/research-questions', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/research-questions', error: 'Invalid request'},
    {method: 'POST', path: '/api/quicknotes', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/quicknotes', error: 'Invalid request'},
    {method: 'POST', path: '/api/pins', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/pins', error: 'Invalid request'},
    {method: 'PUT', path: '/api/preferences', error: 'Invalid request'},
    {method: 'POST', path: '/api/bookmarks/folders', error: 'Invalid request'},
    {method: 'POST', path: '/api/reviews', error: 'Invalid request'},
    {method: 'PUT', path: '/api/reviews', error: 'Invalid request'},
    {method: 'POST', path: '/api/templates/custom', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/templates/custom', error: 'Invalid request'},
  ];
  for (const {method, path: p, error} of CASES) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`${method} ${p} returns its fixed 400 when ${label}, without saving`, async () => {
        const ctx = makeCtx({readBody, fs: mockFs()});
        const r = await invoke(routes, {method, path: p, ctx});
        assert.deepEqual([r.status, r.payload], [400, {error}]);
        assert.deepEqual(ctx.calls.saveJSON, []);
      });
    }
  }
});
