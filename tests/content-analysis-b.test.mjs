/**
 * server/routes/content-analysis-b.js: corpus-wide analyses (publishing
 * calendar, cross-reference matrix, heading depth, update suggestions,
 * audience, word leaderboard, coverage, reading time, recommendations,
 * similarity), the bibliography reports (analytics, reading order, duplicates,
 * completeness, trending), the DOT graph export, and the per-file style and
 * complexity metrics.
 *
 * Consolidated from the twenty-eight per-branch suites that used to cover this
 * module.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT} from './_harness.mjs';

const routes = loadRoute('content-analysis-b');
const {BOOKMARKS_FILE} = FILES;
const at = rel => path.join(PROJECT_ROOT, rel);
const BIB = at('bibliography/references.yaml');
const PROGRESS_FILE = at('data/reading-progress.json');

const fm = (fields, body = '') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;

/** A ctx over an in-memory tree that counts reads and directory walks. */
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

/** Serialise a plain object of reference entries as the bibliography YAML. */
function bib(entries) {
  return Object.entries(entries).map(([key, e]) => {
    const lines = [`${key}:`];
    for (const [k, v] of Object.entries(e)) {
      if (Array.isArray(v)) { lines.push(`  ${k}:`); for (const item of v) lines.push(`    - ${item}`); }
      else lines.push(`  ${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
    }
    return lines.join('\n');
  }).join('\n') + '\n';
}

// ── The shared cached-scan contract ───────────────────────────────────────

// Twelve corpus-wide GET handlers wrap their whole computation in one
// cached(key, ttl, fn) call inside one try. The read stays inside the closure,
// so a failing scan reaches the outer catch and cached() stores nothing.
describe('cached corpus scans', () => {
  const SCANS = [
    {path: '/api/content-calendar', key: 'content-calendar', ttl: 60000, error: 'Calendar failed', source: 'fs'},
    {path: '/api/references/analytics', key: 'bib-analytics', ttl: 60000, error: 'Analytics failed', source: 'bib'},
    {path: '/api/references/reading-order', key: 'reading-order', ttl: 60000, error: 'Reading order failed', source: 'bib'},
    {path: '/api/content-xref-matrix', key: 'xref-matrix', ttl: 120000, error: 'Matrix generation failed', source: 'fs'},
    {path: '/api/stats/heading-depth', key: 'heading-depth', ttl: 60000, error: 'Heading analysis failed', source: 'fs'},
    {path: '/api/content-update-suggestions', key: 'update-suggestions', ttl: 120000, error: 'Suggestions failed', source: 'fs'},
    {path: '/api/content-audience', key: 'content-audience', ttl: 120000, error: 'Audience analysis failed', source: 'fs'},
    {path: '/api/stats/word-leaderboard', key: 'word-leaderboard', ttl: 60000, error: 'Leaderboard failed', source: 'fs'},
    {path: '/api/references/duplicates', key: 'references-duplicates', ttl: 60000, error: 'Deduplication failed', source: 'bib'},
    {path: '/api/content-coverage', key: 'content-coverage', ttl: 120000, error: 'Coverage map failed', source: 'bib'},
    {path: '/api/stats/reading-time', key: 'reading-time-stats', ttl: 60000, error: 'Reading time calculation failed', source: 'fs'},
    {path: '/api/references/completeness', key: 'references-completeness', ttl: 60000, error: 'Completeness check failed', source: 'bib'},
    {path: '/api/references/trending', key: 'ref-trending', ttl: 60000, error: 'Trending analysis failed', source: 'bib'},
    {path: '/api/graph/export', key: 'graph-export-dot', ttl: 60000, error: 'DOT export failed', source: 'fs'},
  ];
  const TREE = {[at('content/a.md')]: fm({title: 'A'}, 'body text'), [BIB]: bib({k1: {title: 'T', year: 2024}})};

  for (const {path: p, key, ttl, error, source} of SCANS) {
    it(`${p} memoizes under "${key}" with a ${ttl} ms TTL`, async () => {
      let seen;
      const {ctx} = fsCtx(TREE, {cached: (k, t, fn) => { seen ??= [k, t]; return fn(); }});
      await invoke(routes, {path: p, ctx});
      assert.deepEqual(seen, [key, ttl]);
    });

    it(`${p} serves a repeat request without re-scanning`, async () => {
      const {ctx, counts} = fsCtx(TREE);
      await invoke(routes, {path: p, ctx});
      const after = counts.read + counts.readdir;
      await invoke(routes, {path: p, ctx});
      assert.equal(counts.read + counts.readdir, after);
    });

    it(`${p} returns 500 ${JSON.stringify(error)} when its source fails, caching nothing`, async () => {
      const base = mockFs(TREE);
      const fs = source === 'bib'
        ? {...base, readFileSync: q => { if (q === BIB) throw new Error('unreadable'); return base.readFileSync(q); }}
        : {...base, readdirSync() { throw new Error('unreadable'); }};
      const ctx = makeCtx({fs});
      const r = await invoke(routes, {path: p, ctx});
      assert.deepEqual(r.replies, [{status: 500, payload: {error}, opts: undefined}]);
      assert.deepEqual(Object.keys(ctx.cache), [], 'a failed scan caches nothing, so the next request retries');
      assert.equal(r.written, null);
    });
  }
});

// ── Publishing calendar ───────────────────────────────────────────────────

describe('GET /api/content-calendar', () => {
  it('groups pages by ascending month, falling back to the mtime and filename', async () => {
    const {ctx} = fsCtx({
      [at('content/late.md')]: fm({date: '2026-03-15', title: 'Late Post'}, 'x'),
      [at('content/early.md')]: fm({date: '2026-01-02'}, 'x'),
      [at('content/nodate.md')]: 'no front matter at all',
      [at('content/_skip.md')]: fm({date: '2026-01-02'}, 'x'),
      [at('content/.dot.md')]: fm({date: '2026-01-02'}, 'x'),
    });
    const r = await invoke(routes, {path: '/api/content-calendar', ctx});
    assert.equal(r.status, 200);
    const months = r.payload.calendar.map(m => m.month);
    assert.deepEqual(months, [...months].sort(), 'months come out ascending');
    const jan = r.payload.calendar.find(m => m.month === '2026-01');
    // No front-matter title, so the filename minus extension is used.
    assert.deepEqual(jan.pages, [{path: 'content/early.md', title: 'early'}]);
    assert.equal(r.payload.calendar.find(m => m.month === '2026-03').pages[0].title, 'Late Post');
    // The undated file falls back to its mtime month, which mockFs stamps in 2023.
    assert.ok(months.includes('2023-11'));
    assert.equal(r.payload.totalMonths, r.payload.calendar.length);
  });

  it('caps each month at five pages while count reports the full total', async () => {
    const files = Object.fromEntries(Array.from({length: 8}, (_, i) => [at(`content/p${i}.md`), fm({date: '2026-01-01'}, 'x')]));
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/content-calendar', ctx});
    const [month] = r.payload.calendar;
    assert.equal(month.count, 8);
    assert.equal(month.pages.length, 5);
  });
});

// ── Bibliography analytics ────────────────────────────────────────────────

describe('GET /api/references/analytics', () => {
  it('aggregates counts, top lists and the year range in one pass', async () => {
    const refs = {
      a: {title: 'A', year: 2020, venue: 'NeurIPS', type: 'inproceedings', author: ['Ada', 'Grace']},
      b: {title: 'B', year: 2024, venue: 'NeurIPS', type: 'inproceedings', author: ['Ada']},
      c: {title: 'C', venue: 'Nature', author: ['Alan']},
    };
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/analytics', ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.totalReferences, 3);
    assert.equal(r.payload.avgYear, 2022);
    assert.equal(r.payload.uniqueAuthors, 3);
    assert.equal(r.payload.uniqueVenues, 2);
    assert.deepEqual(r.payload.topAuthors[0], {name: 'Ada', count: 2});
    assert.deepEqual(r.payload.topVenues[0], {venue: 'NeurIPS', count: 2});
    // A typeless entry falls into the misc bucket.
    assert.deepEqual(r.payload.typeDistribution, {inproceedings: 2, misc: 1});
    assert.deepEqual(r.payload.yearRange, {min: 2020, max: 2024});
  });

  it('returns the zeroed payload with a null year range for an empty bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {path: '/api/references/analytics', ctx});
    assert.deepEqual(r.payload, {
      totalReferences: 0, avgYear: 0, medianYear: 0, avgAge: 0,
      uniqueAuthors: 0, uniqueVenues: 0, topAuthors: [], topVenues: [],
      typeDistribution: {}, yearRange: null,
    });
  });

  it('caps the top author and venue lists at ten', async () => {
    const refs = Object.fromEntries(Array.from({length: 15}, (_, i) => [`k${i}`, {title: `T${i}`, venue: `V${i}`, author: [`A${i}`]}]));
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/analytics', ctx});
    assert.equal(r.payload.topAuthors.length, 10);
    assert.equal(r.payload.topVenues.length, 10);
  });
});

// ── DOT export ────────────────────────────────────────────────────────────

describe('GET /api/graph/export', () => {
  const TREE = {
    [at('content/a.md')]: 'links [[b]] and [[sub/c|alias]] and [[unterminated',
    [at('content/sub/c.md')]: 'no links',
    [at('content/guide/index.md')]: 'index page',
    [at('content/_skip.md')]: '[[b]]',
    [at('content/notes.txt')]: '[[b]]',
  };

  it('renders the DOT graph with content-relative ids, stripping aliases', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/graph/export', ctx});
    assert.equal(r.written.status, 200);
    assert.deepEqual(r.written.headers, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="knowledge-graph.dot"',
      'Access-Control-Allow-Origin': '*',
    });
    const body = r.written.body;
    assert.ok(body.startsWith('digraph KnowledgeGraph {\n  rankdir=LR;\n  node [shape=box, style=rounded];\n'));
    assert.ok(body.endsWith('}\n'));
    // Ids are relative to content/, and a trailing /index is stripped.
    assert.ok(body.includes('  "a";\n'));
    assert.ok(body.includes('  "sub/c";\n'));
    assert.ok(body.includes('  "guide";\n'));
    assert.equal(body.includes('content/'), false, 'no id keeps the content/ prefix');
    // The alias tail is dropped; the unterminated link never matches.
    assert.ok(body.includes('  "a" -> "b";\n'));
    assert.ok(body.includes('  "a" -> "sub/c";\n'));
    assert.equal(body.includes('unterminated'), false);
    assert.equal(body.includes('_skip'), false);
  });

  it('rejects a non-DOT format without writing a body', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/graph/export', query: {format: 'svg'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Only DOT format supported'}]);
    assert.equal(r.written, null);
  });

  it('stays complete when GRAPH_WIKI_RE carries a stale lastIndex', async () => {
    // The per-file reset is load-bearing: without it the shared /g instance
    // would resume mid-file and drop the leading links.
    const first = await invoke(routes, {path: '/api/graph/export', ctx: fsCtx(TREE).ctx});
    routes.GRAPH_WIKI_RE.lastIndex = 25;
    const second = await invoke(routes, {path: '/api/graph/export', ctx: fsCtx(TREE).ctx});
    assert.equal(second.written.body, first.written.body);
  });
});

// ── Reading order ─────────────────────────────────────────────────────────

describe('GET /api/references/reading-order', () => {
  const REFS = {old: {title: 'Old', year: 2000, venue: 'V1'}, mid: {title: 'Mid', year: 2010, venue: 'V2'}, undated: {title: 'Undated', venue: 'V3'}};

  it('orders co-cited references oldest first and records prerequisites', async () => {
    // The undated key leads the group so both the yearA and yearB 9999
    // fallbacks are exercised, not just yearB.
    const {ctx} = fsCtx({[BIB]: bib(REFS), [at('content/a.md')]: 'cites [@undated; @mid; @old]'});
    const r = await invoke(routes, {path: '/api/references/reading-order', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.readingOrder.map(x => x.key), ['old', 'mid', 'undated']);
    assert.equal(r.payload.totalOrdered, 3);
    // Each entry is built from its own reference, so title/year/venue line up.
    assert.deepEqual(r.payload.readingOrder[1], {order: 2, key: 'mid', title: 'Mid', year: 2010, venue: 'V2', prerequisites: ['old']});
    // An undated reference sorts last through the 9999 fallback.
    assert.deepEqual(r.payload.readingOrder[2].prerequisites.sort(), ['mid', 'old']);
  });

  it('caps the returned order at thirty while totalOrdered counts them all', async () => {
    const refs = Object.fromEntries(Array.from({length: 40}, (_, i) => [`k${i}`, {title: `T${i}`, year: 2000 + i}]));
    const {ctx} = fsCtx({[BIB]: bib(refs), [at('content/a.md')]: 'no citations'});
    const r = await invoke(routes, {path: '/api/references/reading-order', ctx});
    assert.equal(r.payload.readingOrder.length, 30);
    assert.equal(r.payload.totalOrdered, 40);
  });

  it('caps the prerequisite list at five', async () => {
    const refs = {late: {title: 'Late', year: 2050}};
    for (let i = 0; i < 8; i++) refs[`e${i}`] = {title: `E${i}`, year: 2000 + i};
    const cites = `[@late; ${Object.keys(refs).slice(1).map(k => `@${k}`).join('; ')}]`;
    const {ctx} = fsCtx({[BIB]: bib(refs), [at('content/a.md')]: cites});
    const r = await invoke(routes, {path: '/api/references/reading-order', ctx});
    assert.equal(r.payload.readingOrder.find(x => x.key === 'late').prerequisites.length, 5);
  });

  it('stays correct when READING_ORDER_CITE_RE carries a stale lastIndex', async () => {
    const files = {[BIB]: bib(REFS), [at('content/a.md')]: 'cites [@mid; @old]'};
    const first = await invoke(routes, {path: '/api/references/reading-order', ctx: fsCtx(files).ctx});
    routes.READING_ORDER_CITE_RE.lastIndex = 9;
    const second = await invoke(routes, {path: '/api/references/reading-order', ctx: fsCtx(files).ctx});
    assert.deepEqual(second.payload, first.payload);
  });
});

// ── Cross-reference matrix ────────────────────────────────────────────────

describe('GET /api/content-xref-matrix', () => {
  it('lists pages by content-relative id and records wiki and citation links', async () => {
    const {ctx} = fsCtx({
      [at('content/docs/a.md')]: fm({title: 'Page A'}, 'links [[ b|alias ]] and cites [@key-one]'),
      [at('content/guide/index.md')]: 'plain',
      [at('content/_skip.md')]: '[[b]]',
      [at('content/notes.txt')]: '[[b]]',
    });
    const r = await invoke(routes, {path: '/api/content-xref-matrix', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.pages, [
      {id: 'docs/a', title: 'Page A'},
      // No front-matter title, so the filename minus extension is used, and a
      // trailing /index is stripped from the id.
      {id: 'guide', title: 'index'},
    ]);
    assert.deepEqual(r.payload.links, [
      // The alias label is dropped and the padding trimmed.
      {from: 'docs/a', to: 'b', type: 'wiki'},
      {from: 'docs/a', to: 'key-one', type: 'citation'},
    ]);
    assert.deepEqual([r.payload.totalPages, r.payload.totalLinks], [2, 2]);
  });

  it('caps pages at one hundred and links at five hundred while the totals stay full', async () => {
    const files = {};
    for (let i = 0; i < 120; i++) files[at(`content/p${i}.md`)] = '[[x]] [[y]] [[z]] [[w]] [[v]]';
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/content-xref-matrix', ctx});
    assert.equal(r.payload.pages.length, 100);
    assert.equal(r.payload.totalPages, 120);
    assert.equal(r.payload.links.length, 500);
    assert.equal(r.payload.totalLinks, 600);
  });
});

// ── Heading depth ─────────────────────────────────────────────────────────

describe('GET /api/stats/heading-depth', () => {
  it('tallies each depth and splits files with and without headings', async () => {
    const {ctx} = fsCtx({
      [at('content/a.md')]: '# One\n## Two\n## Three\n###### Six\n',
      [at('content/b.md')]: 'no headings here',
      [at('content/_skip.md')]: '# Skipped',
    });
    const r = await invoke(routes, {path: '/api/stats/heading-depth', ctx});
    assert.deepEqual(r.payload, {
      depthCounts: {1: 1, 2: 2, 3: 0, 4: 0, 5: 0, 6: 1},
      totalHeadings: 4,
      filesWithHeadings: 1,
      filesWithoutHeadings: 1,
    });
  });
});

// ── Update suggestions ────────────────────────────────────────────────────

describe('GET /api/content-update-suggestions', () => {
  const long = n => Array.from({length: n}, (_, i) => `w${i}`).join(' ');

  const RULES = [
    {name: 'very short content', body: 'only a few words', reason: 'Very short content (< 100 words)', priority: 3},
    {name: 'missing frontmatter', body: long(150), reason: 'Missing frontmatter', priority: 2},
    {name: 'frontmatter without a title', body: fm({date: '2026-01-01', tags: '[a]'}, long(150)), reason: 'Missing title in frontmatter', priority: 2},
    {name: 'frontmatter without tags', body: fm({title: 'T'}, long(150)), reason: 'No tags defined', priority: 1},
    {name: 'long content with few headings', body: fm({title: 'T', tags: '[a]'}, `# One\n${long(600)}`), reason: 'Long content with few headings', priority: 2},
    {name: 'long content with no images', body: fm({title: 'T', tags: '[a]'}, `# One\n## Two\n${long(1200)}`), reason: 'Long content with no images', priority: 1},
  ];
  for (const {name, body, reason, priority} of RULES) {
    it(`flags ${name}`, async () => {
      const {ctx} = fsCtx({[at('content/a.md')]: body});
      const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
      const [item] = r.payload.suggestions;
      assert.ok(item.reasons.includes(reason), `expected ${reason} among ${JSON.stringify(item.reasons)}`);
      assert.ok(item.priority >= priority);
    });
  }

  // The thresholds are exact: 100 words for the short rule, and two headings
  // for the long-content rule.
  it('flags a 70-word file as short but not a 150-word one', async () => {
    const complete = body => fm({title: 'T', tags: '[a]'}, `# One\n## Two\n${body}`);
    const {ctx} = fsCtx({[at('content/a.md')]: complete(long(70))});
    const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
    assert.deepEqual(r.payload.suggestions[0].reasons, ['Very short content (< 100 words)']);
  });

  it('leaves a 150-word file unflagged by the short-content rule', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: fm({title: 'T', tags: '[a]'}, `# One\n## Two\n${long(150)}`)});
    const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
    assert.deepEqual(r.payload.suggestions, []);
  });

  it('leaves a long file with two headings unflagged by the heading rule', async () => {
    const {ctx} = fsCtx({[at('content/a.md')]: fm({title: 'T', tags: '[a]'}, `# One\n## Two\n${long(600)}`)});
    const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
    assert.deepEqual(r.payload.suggestions, []);
  });

  it('accumulates the priority across every tripped rule', async () => {
    // Short content (3) plus missing frontmatter (2).
    const {ctx} = fsCtx({[at('content/a.md')]: 'tiny body'});
    const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
    assert.deepEqual(r.payload.suggestions[0].reasons, ['Very short content (< 100 words)', 'Missing frontmatter']);
    assert.equal(r.payload.suggestions[0].priority, 5);
  });

  it('excludes a healthy file and reports the documented item shape', async () => {
    const healthy = fm({title: 'Good', tags: '[a, b]'}, `# One\n## Two\n${long(300)}`);
    const {ctx} = fsCtx({[at('content/good.md')]: healthy, [at('content/bad.md')]: 'tiny'});
    const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
    assert.deepEqual(r.payload.suggestions.map(s => s.path), ['content/bad.md']);
    assert.deepEqual(Object.keys(r.payload.suggestions[0]).sort(), ['path', 'priority', 'reasons', 'title', 'wordCount']);
    assert.equal(r.payload.total, r.payload.suggestions.length);
  });

  it('sorts by priority descending', async () => {
    const {ctx} = fsCtx({
      [at('content/worst.md')]: 'tiny',
      [at('content/mild.md')]: fm({title: 'T'}, long(150)),
    });
    const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
    const priorities = r.payload.suggestions.map(s => s.priority);
    assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
  });

  it('takes the frontmatter title, else the filename, and recurses into subdirectories', async () => {
    const {ctx} = fsCtx({
      [at('content/sub/deep.md')]: fm({title: 'Deep Title'}, 'tiny'),
      [at('content/plain.md')]: 'tiny',
      [at('content/_skip.md')]: 'tiny',
      [at('content/.dot.md')]: 'tiny',
      [at('content/notes.txt')]: 'tiny',
    });
    const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
    assert.deepEqual(r.payload.suggestions.map(s => s.title).sort(), ['Deep Title', 'plain']);
  });

  it('caps the list at thirty', async () => {
    const files = Object.fromEntries(Array.from({length: 40}, (_, i) => [at(`content/p${i}.md`), 'tiny']));
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/content-update-suggestions', ctx});
    assert.equal(r.payload.suggestions.length, 30);
  });
});

// ── Style ─────────────────────────────────────────────────────────────────

describe('GET /api/file/style', () => {
  const style = async body => {
    const {ctx} = fsCtx({[at('content/a.md')]: body});
    const r = await invoke(routes, {path: '/api/file/style', query: {path: 'content/a.md'}, ctx});
    return r.payload;
  };

  it('reports every derived metric on a normal multi-paragraph document', async () => {
    const out = await style('The report was completed by the team. It covers many topics in detail.\n\nA second paragraph adds more words so the paragraph metrics are non-zero here.\n');
    assert.equal(out.path, 'content/a.md');
    for (const key of ['avgSentenceLength', 'sentenceLengthVariation', 'vocabularyDiversity', 'avgParagraphLength']) {
      assert.ok(out.style[key] > 0, `${key} should be non-zero`);
    }
    assert.equal(out.style.totalSentences, 3);
    assert.equal(out.style.totalParagraphs, 2);
    // The pattern needs a \w+ed participle, so "was completed" matches while
    // an irregular form such as "was written" would not.
    assert.ok(out.style.passiveVoicePercentage > 0);
  });

  const ZERO_ARMS = [
    {name: 'sentenceLengthVariation on a single sentence', body: 'One single sentence of several words here.', key: 'sentenceLengthVariation', other: 'avgSentenceLength'},
    {name: 'avgSentenceLength with no qualifying sentence', body: 'ab', key: 'avgSentenceLength'},
    {name: 'vocabularyDiversity with no words', body: '', key: 'vocabularyDiversity'},
    {name: 'avgParagraphLength with no qualifying paragraph', body: 'tiny.', key: 'avgParagraphLength'},
  ];
  for (const {name, body, key, other} of ZERO_ARMS) {
    it(`returns zero for ${name}`, async () => {
      const out = await style(body);
      assert.equal(out.style[key], 0);
      if (other) assert.ok(out.style[other] > 0, `${other} stays non-zero`);
    });
  }

  // The sentence filter keeps only chunks longer than five characters, so a
  // short interjection does not add one.
  it('ignores a sentence chunk of five characters or fewer', async () => {
    const withShort = await style('Okay. This is a properly long sentence here.');
    assert.equal(withShort.style.totalSentences, 1);
    const withLong = await style('Indeed so. This is a properly long sentence here.');
    assert.equal(withLong.style.totalSentences, 2);
  });

  it('strips frontmatter, fenced code and HTML before counting', async () => {
    const bare = await style('Alpha beta gamma delta epsilon.');
    const dressed = await style(fm({title: 'Removed'}, 'Alpha beta gamma delta epsilon.\n```\nfenced noise noise\n```\n<span></span>\n'));
    assert.equal(dressed.style.totalWords, bare.style.totalWords);
  });

  it('keeps the passive count stable across a poisoned lastIndex', async () => {
    // STYLE_PASSIVE_RE is consumed through String.prototype.match, which resets
    // lastIndex itself, so no manual reset is needed.
    const body = 'The report was written. The notes were edited. The plan is approved.';
    const first = await style(body);
    routes.STYLE_PASSIVE_RE.lastIndex = 12;
    assert.deepEqual(await style(body), first);
  });
});

// ── Audience ──────────────────────────────────────────────────────────────

describe('GET /api/content-audience', () => {
  const words = n => Array.from({length: n}, (_, i) => `word${i}`).join(' ');

  const all = p => [...p.beginner, ...p.intermediate, ...p.advanced, ...p.expert];

  it('buckets each document by Flesch-Kincaid grade', async () => {
    const {ctx} = fsCtx({
      [at('content/simple.md')]: `${'cat dog sun run fun bat hat mat rat pat '.repeat(3)}.`,
      [at('content/hard.md')]: `${'incontrovertible epistemological considerations notwithstanding phenomenological interpretation '.repeat(5)}.`,
    });
    const r = await invoke(routes, {path: '/api/content-audience', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(all(r.payload).map(x => x.path).sort(), ['content/hard.md', 'content/simple.md']);
    assert.equal(r.payload.expert.some(x => x.path === 'content/hard.md'), true);
    assert.equal(r.payload.beginner.some(x => x.path === 'content/simple.md'), true);
    // counts mirror the four bucket lengths.
    assert.equal(Object.values(r.payload.counts).reduce((a, b) => a + b, 0), 2);
  });

  // The under-20-words check is a `return` from scan(), not a `continue`, so a
  // short document abandons the rest of its directory rather than being
  // skipped on its own.
  it('abandons the rest of a directory once it meets a document under twenty words', async () => {
    const long = `${'cat dog sun run fun bat hat mat rat pat '.repeat(3)}.`;
    const {ctx} = fsCtx({
      [at('content/first.md')]: long,
      [at('content/second-short.md')]: 'only five words here now',
      [at('content/third.md')]: long,
    });
    const r = await invoke(routes, {path: '/api/content-audience', ctx});
    assert.deepEqual(all(r.payload).map(x => x.path), ['content/first.md']);
  });

  it('reads the title from a title: line surviving the frontmatter strip', async () => {
    // The strip removes the block, but the handler then matches title: anywhere.
    const {ctx} = fsCtx({[at('content/a.md')]: `title: My Title\n${words(40)}.`});
    const r = await invoke(routes, {path: '/api/content-audience', ctx});
    assert.equal(all(r.payload)[0].title, 'My Title');
  });

  it('counts the full level before slicing each list to ten', async () => {
    const files = Object.fromEntries(Array.from({length: 14}, (_, i) => [at(`content/p${i}.md`), `${words(30)}.`]));
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/content-audience', ctx});
    const total = Object.values(r.payload.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 14);
    for (const level of ['beginner', 'intermediate', 'advanced', 'expert']) {
      assert.ok(r.payload[level].length <= 10, level);
    }
  });
});

// ── Word leaderboard ──────────────────────────────────────────────────────

describe('GET /api/stats/word-leaderboard', () => {
  const words = n => Array.from({length: n}, (_, i) => `w${i}`).join(' ');

  it('ranks longest descending with shortest as the reversed tail', async () => {
    const {ctx} = fsCtx({
      [at('content/big.md')]: words(300),
      [at('content/mid.md')]: words(200),
      [at('content/small.md')]: words(100),
    });
    const r = await invoke(routes, {path: '/api/stats/word-leaderboard', ctx});
    assert.deepEqual(r.payload.longest.map(p => p.path), ['content/big.md', 'content/mid.md', 'content/small.md']);
    assert.deepEqual(r.payload.shortest.map(p => p.path), ['content/small.md', 'content/mid.md', 'content/big.md']);
    assert.equal(r.payload.total, 3);
    assert.equal(r.payload.avgWordCount, 200);
  });

  it('caps longest at twenty and shortest at ten', async () => {
    const files = Object.fromEntries(Array.from({length: 30}, (_, i) => [at(`content/p${i}.md`), words(i + 1)]));
    const {ctx} = fsCtx(files);
    const r = await invoke(routes, {path: '/api/stats/word-leaderboard', ctx});
    assert.equal(r.payload.longest.length, 20);
    assert.equal(r.payload.shortest.length, 10);
  });

  it('returns zeroes for an empty content tree without dividing by zero', async () => {
    const {ctx} = fsCtx({[at('content/.keep')]: ''});
    const r = await invoke(routes, {path: '/api/stats/word-leaderboard', ctx});
    assert.deepEqual(r.payload, {longest: [], shortest: [], total: 0, avgWordCount: 0});
  });
});

// ── Duplicates ────────────────────────────────────────────────────────────

describe('GET /api/references/duplicates', () => {
  it('groups references by normalised title and totals the entries', async () => {
    const refs = {
      a: {title: 'Attention Is All You Need', year: 2017},
      b: {title: 'attention is all you need!', year: 2017},
      c: {title: 'Attention Is All You Need.', year: 2018},
      d: {title: 'A Different Paper Title', year: 2020},
      // A normalised title under five characters is skipped entirely, so even a
      // matching pair of them forms no group.
      e: {title: 'Hi!', year: 2020},
      f: {title: 'Hi!', year: 2021},
    };
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/duplicates', ctx});
    assert.equal(r.payload.totalDuplicateGroups, 1);
    assert.equal(r.payload.totalDuplicateEntries, 3);
    assert.equal(r.payload.duplicates[0].count, 3);
    assert.deepEqual(r.payload.duplicates[0].entries.map(x => x.key), ['a', 'b', 'c']);
  });

  it('reports zeroes when every title is unique', async () => {
    const {ctx} = fsCtx({[BIB]: bib({a: {title: 'First Paper Title'}, b: {title: 'Second Paper Title'}})});
    const r = await invoke(routes, {path: '/api/references/duplicates', ctx});
    assert.deepEqual(r.payload, {duplicates: [], totalDuplicateGroups: 0, totalDuplicateEntries: 0});
  });

  it('sorts groups by size descending and totals across them', async () => {
    const refs = {a1: {title: 'Group One Title'}, a2: {title: 'Group One Title'}, b1: {title: 'Group Two Title'}, b2: {title: 'Group Two Title'}, b3: {title: 'Group Two Title'}};
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/duplicates', ctx});
    assert.deepEqual(r.payload.duplicates.map(g => g.count), [3, 2]);
    assert.equal(r.payload.totalDuplicateEntries, 5);
  });

  it('returns an empty payload for an empty bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {path: '/api/references/duplicates', ctx});
    assert.deepEqual(r.payload, {duplicates: [], totalDuplicateGroups: 0, totalDuplicateEntries: 0});
  });
});

// ── Coverage ──────────────────────────────────────────────────────────────

describe('GET /api/content-coverage', () => {
  it('maps each venue to its reference and citation coverage', async () => {
    const refs = {a: {title: 'A', venue: 'NeurIPS'}, b: {title: 'B', venue: 'NeurIPS'}, c: {title: 'C'}};
    const {ctx} = fsCtx({
      [BIB]: bib(refs),
      // The scan skips dot entries but does walk underscore-prefixed files.
      [at('content/_notes.md')]: 'cites [@a] and [@a] again',
      [at('content/.hidden.md')]: 'cites [@b]',
    });
    const r = await invoke(routes, {path: '/api/content-coverage', ctx});
    const byVenue = Object.fromEntries(r.payload.coverage.map(v => [v.venue, v]));
    // Citations are deduplicated per file, so the repeat does not double-count.
    assert.deepEqual(byVenue.NeurIPS, {venue: 'NeurIPS', references: 2, cited: 1, coverage: 50});
    // A venueless entry falls into the Unknown bucket.
    assert.deepEqual(byVenue.Unknown, {venue: 'Unknown', references: 1, cited: 0, coverage: 0});
    assert.equal(r.payload.total, r.payload.coverage.length);
  });

  it('sorts by reference count descending and caps at thirty', async () => {
    const refs = {};
    for (let i = 0; i < 35; i++) for (let j = 0; j <= i % 3; j++) refs[`k${i}_${j}`] = {title: `T${i}${j}`, venue: `V${i}`};
    const {ctx} = fsCtx({[BIB]: bib(refs), [at('content/a.md')]: 'no citations'});
    const r = await invoke(routes, {path: '/api/content-coverage', ctx});
    assert.equal(r.payload.coverage.length, 30);
    const counts = r.payload.coverage.map(v => v.references);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  });
});

// ── Reading time ──────────────────────────────────────────────────────────

describe('GET /api/stats/reading-time', () => {
  const words = n => Array.from({length: n}, (_, i) => `w${i}`).join(' ');

  it('totals words, ceils the minutes and buckets by top-level directory', async () => {
    const {ctx} = fsCtx({
      [at('content/books/a.md')]: words(400),
      [at('content/books/deep/b.md')]: words(200),
      [at('content/loose.md')]: words(20),
    });
    const r = await invoke(routes, {path: '/api/stats/reading-time', ctx});
    // 620 / 200 is 3.1, so the ceil gives 4 where a round would give 3.
    assert.equal(r.payload.totalWords, 620);
    assert.equal(r.payload.totalReadingMinutes, 4);
    assert.equal(r.payload.totalReadingHours, 0.1);
    const byName = Object.fromEntries(r.payload.directories.map(d => [d.name, d]));
    // A nested directory rolls up into its top-level ancestor.
    assert.deepEqual(byName.books, {name: 'books', words: 600, readingTimeMinutes: 3, readingTimeHours: 0.1});
    // A file directly under content/ lands in the "root" bucket.
    assert.deepEqual(byName.root, {name: 'root', words: 20, readingTimeMinutes: 1, readingTimeHours: 0});
    assert.deepEqual(r.payload.directories.map(d => d.words), [600, 20], 'sorted by words descending');
  });
});

// ── Recommendations ───────────────────────────────────────────────────────

describe('GET /api/content-recommend', () => {
  const INTEREST = 'quantum entanglement decoherence measurement superposition observable';
  const TREE = {
    [at('content/read.md')]: INTEREST,
    [at('content/bookmarked.md')]: INTEREST,
    [at('content/overlap.md')]: fm({title: 'Overlapping'}, INTEREST),
    [at('content/unrelated.md')]: 'gardening horticulture botany greenhouse cultivation',
    // Two interest words only, under the score > 3 threshold.
    [at('content/faint.md')]: 'quantum entanglement gardening horticulture botany',
  };
  const STORE = {
    [PROGRESS_FILE]: {default: {'content/read.md': {}}},
    [BOOKMARKS_FILE]: {bookmarks: [{path: 'content/bookmarked.md'}]},
  };

  it('recommends the unread page overlapping the read and bookmarked interests', async () => {
    const {ctx} = fsCtx(TREE, {store: STORE});
    const r = await invoke(routes, {path: '/api/content-recommend', ctx});
    assert.equal(r.status, 200);
    const paths = r.payload.recommendations.map(x => x.path);
    assert.ok(paths.includes('content/overlap.md'));
    assert.equal(paths.includes('content/read.md'), false, 'an already read page is excluded');
    // Only read pages are excluded; a bookmarked page seeds the interests AND
    // stays a candidate.
    assert.ok(paths.includes('content/bookmarked.md'));
    assert.equal(paths.includes('content/unrelated.md'), false);
    assert.equal(paths.includes('content/faint.md'), false, 'a faint overlap stays under the score threshold');
    assert.deepEqual(r.payload.basedOn, {pagesRead: 1, bookmarks: 1});
    assert.ok(r.payload.recommendations.some(x => x.title === 'Overlapping'));
  });

  it('reads the per-user progress bucket', async () => {
    const store = {...STORE, [PROGRESS_FILE]: {alice: {'content/read.md': {}}}};
    const {ctx} = fsCtx(TREE, {store});
    const r = await invoke(routes, {path: '/api/content-recommend', query: {userId: 'alice'}, ctx});
    assert.equal(r.payload.basedOn.pagesRead, 1);
    const other = await invoke(routes, {path: '/api/content-recommend', query: {userId: 'bob'}, ctx: fsCtx(TREE, {store}).ctx});
    assert.equal(other.payload.basedOn.pagesRead, 0);
  });

  it('caps the recommendation list at ten, sorted by relevance', async () => {
    const files = {...TREE};
    for (let i = 0; i < 15; i++) files[at(`content/c${i}.md`)] = INTEREST;
    const {ctx} = fsCtx(files, {store: STORE});
    const r = await invoke(routes, {path: '/api/content-recommend', ctx});
    assert.equal(r.payload.recommendations.length, 10);
    const scores = r.payload.recommendations.map(x => x.relevanceScore);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  // Both store reads sit inside the one try, so either failing yields the lone 500.
  for (const failing of [PROGRESS_FILE, BOOKMARKS_FILE]) {
    it(`returns the lone 500 when loading ${path.basename(failing)} throws`, async () => {
      const {ctx} = fsCtx(TREE, {
        store: STORE,
        loadJSON(file) { if (file === failing) throw new Error('unreadable'); return STORE[file] ?? {}; },
      });
      const r = await invoke(routes, {path: '/api/content-recommend', ctx});
      assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Recommendation failed'}, opts: undefined}]);
      assert.equal(r.replies.some(x => x.payload && 'recommendations' in x.payload), false);
    });
  }
});

// ── Completeness ──────────────────────────────────────────────────────────

describe('GET /api/references/completeness', () => {
  const FIELDS = ['title', 'author', 'year', 'venue', 'doi', 'url'];

  it('scores each entry, averages them and derives the per-field coverage', async () => {
    const refs = {
      full: {title: 'Full', author: ['Ada'], year: 2020, venue: 'V', doi: 'd', url: 'u'},
      half: {title: 'Half', year: 2020, venue: 'V'},
      // An empty author array counts as missing.
      empty: {title: 'Empty', author: []},
    };
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/completeness', ctx});
    assert.equal(r.payload.totalReferences, 3);
    assert.equal(r.payload.fullyComplete, 1);
    // 100 + 50 + 17, averaged and rounded.
    assert.equal(r.payload.averageCompleteness, Math.round((100 + 50 + 17) / 3));
    assert.deepEqual(r.payload.incomplete.map(x => x.key), ['empty', 'half'], 'ascending by completeness');
    const coverage = Object.fromEntries(r.payload.fieldCoverage.map(f => [f.field, f]));
    assert.deepEqual(r.payload.fieldCoverage.map(f => f.field), FIELDS, 'in the declared field order');
    assert.deepEqual(coverage.title, {field: 'title', count: 3, percentage: 100});
    assert.deepEqual(coverage.author, {field: 'author', count: 1, percentage: 33});
    assert.deepEqual(coverage.doi, {field: 'doi', count: 1, percentage: 33});
  });

  it('handles an empty reference set without dividing by zero', async () => {
    const {ctx} = fsCtx({[BIB]: ''});
    const r = await invoke(routes, {path: '/api/references/completeness', ctx});
    assert.equal(r.payload.averageCompleteness, 0);
    assert.equal(r.payload.totalReferences, 0);
    assert.deepEqual(r.payload.incomplete, []);
    for (const f of r.payload.fieldCoverage) assert.deepEqual([f.count, f.percentage], [0, 0]);
  });

  it('caps the incomplete list at thirty while the totals stay full', async () => {
    const refs = Object.fromEntries(Array.from({length: 40}, (_, i) => [`k${i}`, {title: `T${i}`}]));
    const {ctx} = fsCtx({[BIB]: bib(refs)});
    const r = await invoke(routes, {path: '/api/references/completeness', ctx});
    assert.equal(r.payload.incomplete.length, 30);
    assert.equal(r.payload.totalReferences, 40);
  });
});

// ── Similarity ────────────────────────────────────────────────────────────

describe('GET /api/content-similar', () => {
  const SHARED = 'quantum entanglement decoherence measurement superposition observable';
  const TREE = {
    [at('content/source.md')]: SHARED,
    [at('content/close.md')]: fm({title: 'Close'}, SHARED),
    [at('content/alsoclose.md')]: SHARED,
    [at('content/stopwords.md')]: 'the a an is are was were been have from with that this could would',
    [at('content/unrelated.md')]: 'gardening horticulture botany greenhouse cultivation',
    // Two shared keywords only, under the overlap > 2 threshold.
    [at('content/faint.md')]: 'quantum entanglement gardening horticulture botany',
  };

  it('ranks by keyword overlap, excluding the source and unrelated pages', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/content-similar', query: {path: 'content/source.md'}, ctx});
    assert.equal(r.status, 200);
    const paths = r.payload.similar.map(x => x.path);
    assert.deepEqual(paths.sort(), ['content/alsoclose.md', 'content/close.md']);
    assert.equal(paths.includes('content/source.md'), false);
    // Shared stop words alone never clear the overlap threshold.
    assert.equal(paths.includes('content/stopwords.md'), false);
    assert.equal(paths.includes('content/unrelated.md'), false);
    assert.equal(paths.includes('content/faint.md'), false, 'a two-word overlap stays under the threshold');
    assert.equal(r.payload.total, 2);
  });

  // The source's keyword set is the top thirty by frequency. With every word
  // appearing once the order is positional, so a candidate matching only words
  // ranked eleven and beyond still scores.
  it('scores against the top thirty source keywords, not merely the top ten', async () => {
    // The keyword extractor strips every non-letter, so these names are
    // letters only and each is longer than the four-character floor.
    const vocab = Array.from({length: 30}, (_, i) =>
      `word${String.fromCharCode(97 + Math.floor(i / 5))}${String.fromCharCode(97 + (i % 5))}`);
    const {ctx} = fsCtx({
      [at('content/src.md')]: vocab.join(' '),
      [at('content/tail.md')]: vocab.slice(15).join(' '),
    });
    const r = await invoke(routes, {path: '/api/content-similar', query: {path: 'content/src.md'}, ctx});
    assert.deepEqual(r.payload.similar.map(x => x.path), ['content/tail.md']);
  });

  it('rejects an invalid path before any read', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/content-similar', query: {path: '../escape.md'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
    assert.equal(counts.read, 0);
  });

  it('returns 404 for a missing source and does not cache it', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const first = await invoke(routes, {path: '/api/content-similar', query: {path: 'content/gone.md'}, ctx});
    assert.deepEqual([first.status, first.payload], [404, {error: 'File not found'}]);
    const after = counts.read;
    await invoke(routes, {path: '/api/content-similar', query: {path: 'content/gone.md'}, ctx});
    assert.ok(counts.read > after);
  });

  it('caches the full candidate list per path and slices it per request', async () => {
    const {ctx, counts} = fsCtx(TREE);
    await invoke(routes, {path: '/api/content-similar', query: {path: 'content/source.md'}, ctx});
    const after = counts.readdir;
    const second = await invoke(routes, {path: '/api/content-similar', query: {path: 'content/source.md', limit: '1'}, ctx});
    assert.equal(counts.readdir, after, 'the limit slice runs off the cached list');
    assert.equal(second.payload.similar.length, 1);
    assert.equal(second.payload.total, 2, 'total still reports the full candidate count');
    await invoke(routes, {path: '/api/content-similar', query: {path: 'content/close.md'}, ctx});
    assert.ok(counts.readdir > after, 'a distinct path re-scans');
  });

  // numericParam only upper-bounds, so without the floor slice(0, negative)
  // would count from the end and drop the last matches.
  const LIMITS = [
    {name: 'absent, giving the default of 5', query: {}, want: 2},
    {name: 'valid', query: {limit: '1'}, want: 1},
    {name: 'above the cap, clamped to 20', query: {limit: '9999'}, want: 2},
    {name: 'non-numeric, falling back to the default', query: {limit: 'abc'}, want: 2},
    {name: 'zero', query: {limit: '0'}, want: 0},
    {name: 'negative, clamped to zero', query: {limit: '-1'}, want: 0},
    {name: 'very negative, clamped the same way', query: {limit: '-5'}, want: 0},
  ];
  for (const {name, query, want} of LIMITS) {
    it(`handles a limit that is ${name}`, async () => {
      const {ctx} = fsCtx(TREE);
      const r = await invoke(routes, {path: '/api/content-similar', query: {path: 'content/source.md', ...query}, ctx});
      assert.equal(r.payload.similar.length, want);
      assert.equal(r.payload.total, 2);
    });
  }
});

// ── Trending ──────────────────────────────────────────────────────────────

describe('GET /api/references/trending', () => {
  const year = new Date().getFullYear();
  const REFS = {
    hot: {title: 'Hot', year, venue: 'V'},
    warm: {title: 'Warm', year: year - 2, venue: 'V'},
    stale: {title: 'Stale', year: year - 3, venue: 'V'},
    uncited: {title: 'Uncited', year, venue: 'V'},
    undated: {title: 'Undated', venue: 'V'},
  };

  it('ranks recently cited papers by citation count descending', async () => {
    const {ctx} = fsCtx({
      [BIB]: bib(REFS),
      // Every occurrence counts, with no per-file dedup; underscore files and
      // subdirectories are scanned, dot files and other extensions are not.
      [at('content/_notes.md')]: '[@hot] [@hot] [@warm]',
      [at('content/sub/deep.md')]: '[@hot] [@stale] [@undated]',
      [at('content/.hidden.md')]: '[@warm] [@warm] [@warm]',
      [at('content/notes.txt')]: '[@warm] [@warm]',
    });
    const r = await invoke(routes, {path: '/api/references/trending', ctx});
    assert.deepEqual(r.payload.trending.map(x => [x.key, x.citations]), [['hot', 3], ['warm', 1]]);
    assert.equal(r.payload.total, 2);
  });

  it('keeps only the twenty most cited', async () => {
    const refs = {};
    let cites = '';
    for (let i = 0; i < 25; i++) { refs[`k${i}`] = {title: `T${i}`, year}; cites += `[@k${i}] `.repeat(i + 1); }
    const {ctx} = fsCtx({[BIB]: bib(refs), [at('content/a.md')]: cites});
    const r = await invoke(routes, {path: '/api/references/trending', ctx});
    assert.equal(r.payload.trending.length, 20);
  });

  it('returns an empty list for an empty bibliography', async () => {
    const {ctx} = fsCtx({[BIB]: '', [at('content/a.md')]: '[@anything]'});
    const r = await invoke(routes, {path: '/api/references/trending', ctx});
    assert.deepEqual(r.payload, {trending: [], total: 0});
  });
});

// ── Complexity ────────────────────────────────────────────────────────────

describe('GET /api/file/complexity', () => {
  const complexity = async body => {
    const {ctx} = fsCtx({[at('content/a.md')]: body});
    const r = await invoke(routes, {path: '/api/file/complexity', query: {path: 'content/a.md'}, ctx});
    return r.payload;
  };

  it('saturates every capped term on a rich document', async () => {
    const body = [
      fm({title: 'T'}),
      ...Array.from({length: 10}, (_, i) => `## Heading ${i}`),
      '```\ncode\n```\n'.repeat(5),
      '$$x$$\n'.repeat(5),
      '[@a] [@b] [@c] [@d] [@e] [@f]',
      '[[x]] [[y]] [[z]] [a](b) [c](d)',
      '- one\n- two\n1. three\n',
      Array.from({length: 40}, (_, i) => `unique${i}`).join(' ') + '.',
    ].join('\n');
    const out = await complexity(body);
    assert.equal(out.path, 'content/a.md');
    const m = out.metrics;
    assert.equal(m.headings, 10);
    assert.equal(m.maxHeadingDepth, 2);
    assert.equal(m.codeBlocks, 5);
    assert.equal(m.mathBlocks, 5);
    assert.equal(m.citations, 6);
    assert.equal(m.links, 5);
    assert.equal(m.lists, 3);
    assert.ok(out.complexityScore > 0 && out.complexityScore <= 100);
  });

  it('clamps the score at one hundred once every term saturates', async () => {
    // A long single sentence of all-unique words saturates both the
    // avgSentenceLength arm (> 20) and the vocabularyRichness arm (> 0.6); the
    // repeated markers saturate the five capped terms.
    // Just enough repetition to saturate each capped term (7 headings, 3 code
    // blocks, 3 math blocks, 5 citations, 5 links) so the mostly-unique prose
    // still carries the vocabulary ratio past 0.6.
    const unique = Array.from({length: 120}, (_, i) => `unique${i}`).join(' ');
    const body = `${'## H\n'.repeat(7)}${'```\nx\n```\n'.repeat(3)}${'$$a$$\n'.repeat(3)}${'[@k] '.repeat(5)}${'[[l]] '.repeat(5)}${unique}.`;
    const out = await complexity(body);
    assert.equal(out.complexityScore, 100);
  });

  const ZERO_ARMS = [
    {name: 'an empty document', body: '', checks: o => {
      assert.equal(o.metrics.wordCount, 0);
      assert.equal(o.metrics.vocabularyRichness, 0);
      assert.equal(o.metrics.avgSentenceLength, 0);
      assert.equal(o.metrics.maxHeadingDepth, 0);
    }},
    // The sentence filter keeps any chunk longer than three characters, so the
    // zero arm needs a body shorter than that.
    {name: 'words but no qualifying sentence', body: 'ab', checks: o => {
      assert.ok(o.metrics.wordCount > 0);
      assert.equal(o.metrics.avgSentenceLength, 0);
    }},
  ];
  for (const {name, body, checks} of ZERO_ARMS) {
    it(`takes the zero arms for ${name}`, async () => checks(await complexity(body)));
  }

  it('counts the backslash-bracket math form alongside the dollar form', async () => {
    const withDollars = await complexity('$$a$$ $$b$$ text here.');
    const withBrackets = await complexity('\\[a\\] \\[b\\] text here.');
    assert.equal(withDollars.metrics.mathBlocks, 2, 'each pair of $$ markers makes one block');
    assert.equal(withBrackets.metrics.mathBlocks, 2, 'each \\[ counts as one');
  });

  // A single 40-word sentence of unique words: the sentence arm contributes its
  // flat 15 rather than 0.75 * 40, and the vocabulary arm its flat 15 rather
  // than 25 * 1.0, so the whole score is 30.
  it('takes the flat sentence and vocabulary arms rather than their linear twins', async () => {
    const out = await complexity(`${Array.from({length: 40}, (_, i) => `u${i}`).join(' ')}.`);
    assert.equal(out.metrics.avgSentenceLength, 40);
    assert.equal(out.metrics.vocabularyRichness, 1);
    assert.equal(out.complexityScore, 30);
  });

  // Ten headings would contribute 30 uncapped; the cap holds them to 20, so the
  // score is 15 (sentence) + 20 (headings) + 15 (vocabulary).
  it('caps the heading term at twenty', async () => {
    const heads = Array.from({length: 10}, (_, i) => `## H${i}`).join('\n');
    const out = await complexity(`${heads}\none two three four.`);
    assert.equal(out.metrics.headings, 10);
    assert.equal(out.complexityScore, 50);
  });

  it('takes the linear arms on a low-complexity document', async () => {
    const out = await complexity('One short sentence here. Another short one follows.');
    assert.ok(out.metrics.avgSentenceLength > 0 && out.metrics.avgSentenceLength <= 20);
    assert.equal(out.metrics.headings, 0);
    assert.equal(out.metrics.codeBlocks, 0);
    assert.ok(out.complexityScore > 0);
  });
});

// ── Exports ───────────────────────────────────────────────────────────────

describe('exported helpers and regexes', () => {
  const {numericParam} = routes;
  const CASES = [
    {name: 'null falls back to the default', args: [null, 5, 20], want: 5},
    {name: 'an empty string falls back to the default', args: ['', 5, 20], want: 5},
    {name: 'a non-numeric value falls back rather than yielding NaN', args: ['abc', 5, 20], want: 5},
    {name: 'a valid value passes through', args: ['7', 5, 20], want: 7},
    {name: 'a value above the cap is clamped', args: ['999', 5, 20], want: 20},
  ];
  for (const {name, args, want} of CASES) {
    it(`numericParam: ${name}`, () => assert.equal(numericParam(...args), want));
  }

  const CANONICAL = {
    GRAPH_WIKI_RE: /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g,
    READING_ORDER_CITE_RE: /\[@([\w-]+(?:\s*;\s*@[\w-]+)*)\]/g,
    STYLE_PASSIVE_RE: /\b(is|are|was|were|been|being)\s+(being\s+)?\w+ed\b/gi,
  };
  for (const [name, canonical] of Object.entries(CANONICAL)) {
    it(`${name} matches its canonical literal and is one shared instance`, () => {
      const re = routes[name];
      assert.equal(re.source, canonical.source, name);
      assert.equal(re.flags, canonical.flags, name);
      assert.strictEqual(loadRoute('content-analysis-b')[name], re, name);
    });
  }
});
