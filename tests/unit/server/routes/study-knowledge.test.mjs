/**
 * server/routes/study-knowledge.js: spaced-repetition flashcards, citation
 * context and paper comparison, topic clusters, link suggestions, the
 * glossary, study plans, research questions, search autocomplete, quick notes,
 * pins, preferences, bookmark folders, the review workflow, custom templates,
 * per-page analytics and the knowledge-base report.
 *
 * Consolidated from the sixty per-branch suites that used to cover this module.
 * Many of its stores are keyed by the authenticated userId, so the own-key and
 * proto-key guards are driven from shared tables.
 */
import {describe, it, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {loadRoute, loadServer, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT, CONTENT_DIR, TEST_IDENTITY} from '../../_harness.mjs';

const routes = loadRoute('study-knowledge');
// The memo belongs to the bibliography plugin now, and so does resetting it.
const bibliographyLib = createRequire(import.meta.url)('../../../../plugins/bibliography/lib/references.js');
const {LINKSUGGEST_WIKI_RE, QUICKNOTES_TITLE_RE, QUICKNOTES_DATE_RE, QUICKNOTES_BODY_RE, FRONTMATTER_TITLE_RE} = routes;
const {FLASHCARDS_FILE, GLOSSARY_FILE, READING_LISTS_FILE, ANALYTICS_FILE} = FILES;
const at = rel => path.join(PROJECT_ROOT, rel);
// Content lives in the workspace's own tree, and the paths a request carries
// are relative to it: `posts/blog/x.md`, never `content/mochi/posts/blog/x.md`.
const atContent = rel => path.join(CONTENT_DIR, rel);
const BIB = atContent('bibliography/references.yaml');
const RQ_FILE = at('var/data/research-questions.json');
const QUICKNOTES_FILE = at('var/data/quicknotes.json');
const PINS_FILE = at('var/data/pins.json');
const PREFS_FILE = at('var/data/preferences.json');
const REVIEWS_FILE = at('var/data/reviews.json');
const TEMPLATES_FILE = at('var/data/custom-templates.json');

const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];
const INHERITED_KEYS = ['toString', 'valueOf', 'hasOwnProperty'];

// Every per-user store below is keyed on the session subject the harness signs
// requests as. A case that needs a different caller passes `auth`, which is
// what a differing `?userId=` or `body.userId` used to do before the API
// started deriving identity from the token.
const UID = TEST_IDENTITY.userId;
const asUser = userId => ({...TEST_IDENTITY, userId});

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
beforeEach(() => bibliographyLib._resetReferencesCache());

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
    const r = await invoke(routes, {method: 'POST', path: '/api/flashcards', body: {...OK, tags: ['a', 'b'], sourcePath: 'x.md'}, ctx});
    assert.equal(r.status, 200);
    const {id, createdAt, ...stable} = r.payload.card;
    assert.deepEqual(stable, {
      front: 'Q', back: 'A', tags: ['a', 'b'], sourcePath: 'x.md',
      interval: 1, easeFactor: 2.5, repetitions: 0, nextReview: today,
    });
    assert.match(id, /^fc_\d+_[a-z0-9]+$/);
    assert.deepEqual(ctx.store[FLASHCARDS_FILE][UID], [r.payload.card]);
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
      const r = await invoke(routes, {method: 'POST', path: '/api/flashcards', body: OK, ctx, auth: asUser(userId)});
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
  const store = () => ({[FLASHCARDS_FILE]: {[UID]: CARDS, alice: [{id: 'a', nextReview: today}]}});

  it('lists a user cards with the total', async () => {
    const r = await invoke(routes, {path: '/api/flashcards', ctx: makeCtx({store: store()})});
    assert.deepEqual([r.status, r.payload.total], [200, 3]);
    assert.deepEqual(r.payload.cards.map(c => c.id), ['past', 'today', 'future']);
  });

  it('reads the signed-in user, not a userId in the query', async () => {
    const r = await invoke(routes, {path: '/api/flashcards', query: {userId: 'alice'}, ctx: makeCtx({store: store()})});
    assert.deepEqual(r.payload.cards.map(c => c.id), ['past', 'today', 'future']);
  });

  it('reads a different caller\'s own cards', async () => {
    const r = await invoke(routes, {path: '/api/flashcards', ctx: makeCtx({store: store()}), auth: asUser('alice')});
    assert.deepEqual(r.payload.cards.map(c => c.id), ['a']);
  });

  // The due filter is inclusive of today.
  it('returns only cards due today or earlier', async () => {
    const r = await invoke(routes, {path: '/api/flashcards/due', ctx: makeCtx({store: store()})});
    assert.deepEqual(r.payload.cards.map(c => c.id), ['past', 'today']);
    assert.equal(r.payload.dueCount, 2);
  });

  for (const p of ['/api/flashcards', '/api/flashcards/due']) {
    for (const userId of [...INHERITED_KEYS, 'absent']) {
      it(`${p} returns an empty list for the non-own user ${JSON.stringify(userId)}`, async () => {
        const r = await invoke(routes, {path: p, ctx: makeCtx({store: store()}), auth: asUser(userId)});
        assert.deepEqual(r.payload.cards, []);
      });
    }
  }
});

describe('POST /api/flashcards/review', () => {
  const card = over => ({id: 'c1', interval: 1, easeFactor: 2.5, repetitions: 0, nextReview: '2020-01-01', ...over});
  const store = over => ({[FLASHCARDS_FILE]: {[UID]: [card(over)]}});

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
  const store = () => ({[FLASHCARDS_FILE]: {[UID]: [{id: 'c1'}, {id: 'c2'}]}});

  it('rejects a missing cardId', async () => {
    const ctx = makeCtx({store: store()});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/flashcards', body: {}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing cardId'}]);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  for (const userId of [...INHERITED_KEYS, 'absent']) {
    it(`returns 404 for the non-own user ${JSON.stringify(userId)}`, async () => {
      const r = await invoke(routes, {method: 'DELETE', path: '/api/flashcards', body: {cardId: 'c1'}, ctx: makeCtx({store: store()}), auth: asUser(userId)});
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
    assert.deepEqual(ctx.store[FLASHCARDS_FILE][UID].map(c => c.id), ['c2']);
  });
});

// ── Citation context and comparison ───────────────────────────────────────

// ── Clusters, link suggestions, autocomplete ──────────────────────────────

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

// ── Research questions ────────────────────────────────────────────────────

// ── Quick notes ───────────────────────────────────────────────────────────

describe('GET /api/quicknotes', () => {
  const JSON_NOTES = [
    {id: 'n1', text: 'older', updatedAt: '2026-01-01T00:00:00.000Z'},
    {id: 'n2', text: 'newer', updatedAt: '2026-02-01T00:00:00.000Z'},
  ];

  it('returns the stored notes newest first', async () => {
    const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {[UID]: JSON_NOTES}}, fs: mockFs({})});
    const r = await invoke(routes, {path: '/api/quicknotes', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.map(n => n.id), ['n2', 'n1']);
  });

  for (const userId of [...INHERITED_KEYS, 'absent']) {
    it(`returns nothing for the non-own user ${JSON.stringify(userId)}`, async () => {
      const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {[UID]: JSON_NOTES}}, fs: mockFs({})});
      const r = await invoke(routes, {path: '/api/quicknotes', ctx, auth: asUser(userId)});
      assert.deepEqual(r.payload, []);
    });
  }

  it('appends blog-sourced notes tagged quick-note, newest filename first', async () => {
    const blog = rel => atContent(`posts/blog/${rel}`);
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
      path: 'posts/blog/2026-02-01-second.md',
      source: 'blog',
    });
  });

  it('caps the blog notes at fifty', async () => {
    const files = {};
    for (let i = 0; i < 60; i++) files[atContent(`posts/blog/2026-01-${String(i + 1).padStart(2, '0')}-n.md`)] = `${fm({title: `N${i}`, tags: '[quick-note]'})}\nbody\n`;
    const ctx = makeCtx({fs: mockFs(files)});
    const r = await invoke(routes, {path: '/api/quicknotes', ctx});
    assert.equal(r.payload.length, 50);
  });

  it('returns only the stored notes when the blog directory is absent', async () => {
    const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {[UID]: JSON_NOTES}}, fs: mockFs({})});
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
    assert.deepEqual(ctx.store[QUICKNOTES_FILE][UID], [r.payload.note]);
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
    const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {[UID]: existing}}});
    await invoke(routes, {method: 'POST', path: '/api/quicknotes', body: {text: 't'}, ctx});
    const saved = ctx.store[QUICKNOTES_FILE][UID];
    assert.equal(saved.length, 200);
    assert.equal(saved[0].id, 'n1');
  });

  for (const userId of INHERITED_KEYS) {
    it(`POST stores the inherited userId ${JSON.stringify(userId)} as an own key`, async () => {
      const ctx = makeCtx();
      await invoke(routes, {method: 'POST', path: '/api/quicknotes', body: {text: 't'}, ctx, auth: asUser(userId)});
      assert.ok(Object.hasOwn(ctx.store[QUICKNOTES_FILE], userId));
    });
  }

  const DELETE_CASES = [
    {name: 'a missing id', body: {}, stored: {[UID]: [{id: 'n1'}]}, status: 400, error: 'Missing id'},
    {name: 'a caller with no notes', body: {id: 'n1'}, stored: {someone_else: [{id: 'n1'}]}, status: 404, error: 'Note not found'},
    {name: 'an unknown id', body: {id: 'nope'}, stored: {[UID]: [{id: 'n1'}]}, status: 404, error: 'Note not found'},
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
    const ctx = makeCtx({store: {[QUICKNOTES_FILE]: {[UID]: [{id: 'n1'}, {id: 'n2'}]}}});
    const r = await invoke(routes, {method: 'DELETE', path: '/api/quicknotes', body: {id: 'n1'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {success: true}]);
    assert.deepEqual(ctx.store[QUICKNOTES_FILE][UID].map(n => n.id), ['n2']);
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

// ── Preferences ───────────────────────────────────────────────────────────

describe('/api/preferences', () => {
  const PREFS = {alice: {theme: 'dark'}};

  it('GET returns the stored preferences for the signed-in user', async () => {
    const r = await invoke(routes, {path: '/api/preferences', ctx: makeCtx({store: {[PREFS_FILE]: PREFS}}), auth: asUser('alice')});
    assert.deepEqual([r.status, r.payload], [200, {preferences: {theme: 'dark'}}]);
  });

  it('GET ignores a userId in the query', async () => {
    const r = await invoke(routes, {path: '/api/preferences', query: {userId: 'alice'}, ctx: makeCtx({store: {[PREFS_FILE]: PREFS}})});
    assert.deepEqual([r.status, r.payload], [200, {preferences: {}}]);
  });

  for (const userId of [...INHERITED_KEYS, 'absent']) {
    it(`GET returns an empty object for the non-own user ${JSON.stringify(userId)}`, async () => {
      const r = await invoke(routes, {path: '/api/preferences', ctx: makeCtx({store: {[PREFS_FILE]: PREFS}}), auth: asUser(userId)});
      assert.deepEqual([r.status, r.payload], [200, {preferences: {}}]);
    });
  }

  it('PUT returns 429 with the prefs key', async () => {
    const ctx = makeCtx({rateLimitAllow: false});
    const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'prefs:127.0.0.1', maxPerMinute: 30}]);
  });

  // The store key is the session subject now, so only the preference payload
  // is still client-supplied, and only its keys still need a pollution guard.
  const GUARDS = [
    {name: 'an omitted preferences', body: {}, error: 'Missing or invalid preferences'},
    {name: 'a non-object preferences', body: {preferences: 'x'}, error: 'Missing or invalid preferences'},
    {name: 'an array preferences', body: {preferences: []}, error: 'Missing or invalid preferences'},
    ...PROTO_KEYS.map(k => ({name: `the proto preference key ${JSON.stringify(k)}`, body: {preferences: {[k]: 1}}, error: `Invalid preference key: ${k}`})),
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
    const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', body: {preferences: {theme: 'light', size: 14}}, ctx, auth: asUser('alice')});
    assert.equal(r.status, 200);
    assert.deepEqual([r.payload.preferences.theme, r.payload.preferences.size, r.payload.preferences.keep], ['light', 14, 'me']);
    assert.ok(r.payload.preferences.updatedAt);
  });

  it('PUT truncates a string preference at 5000 characters', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', body: {preferences: {bio: 'b'.repeat(6000)}}, ctx});
    assert.equal(r.payload.preferences.bio.length, 5000);
  });

  for (const userId of INHERITED_KEYS) {
    it(`PUT writes the inherited userId ${JSON.stringify(userId)} as an own key`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {method: 'PUT', path: '/api/preferences', body: {preferences: {a: 1}}, ctx, auth: asUser(userId)});
      assert.equal(r.status, 200);
      assert.ok(Object.hasOwn(ctx.store[PREFS_FILE], userId));
    });
  }
});

// ── Bookmark folders ──────────────────────────────────────────────────────

// ── Reviews ───────────────────────────────────────────────────────────────

// ── Custom templates ──────────────────────────────────────────────────────

// ── Per-page analytics ────────────────────────────────────────────────────

// ── Knowledge-base report ─────────────────────────────────────────────────

// Every body-reading handler wraps the read in one try whose catch returns a
// fixed 400 ahead of the first inner guard.
describe('malformed-body outer catches', () => {
  const CASES = [
    {method: 'POST', path: '/api/flashcards', error: 'Invalid request'},
    {method: 'POST', path: '/api/flashcards/review', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/flashcards', error: 'Invalid request'},
    {method: 'POST', path: '/api/glossary', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/glossary', error: 'Invalid request'},
    {method: 'POST', path: '/api/quicknotes', error: 'Invalid request'},
    {method: 'DELETE', path: '/api/quicknotes', error: 'Invalid request'},
    {method: 'PUT', path: '/api/preferences', error: 'Invalid request'},
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
