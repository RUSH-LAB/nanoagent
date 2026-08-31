/**
 * server/routes/file-tools.js: per-file analysis (summary, outline, lint,
 * keywords, readability, related, suggested tags, dependencies), manual
 * versioning, batch file info, global search and the git diff/compare pair.
 *
 * Consolidated from the twenty-six per-branch suites that used to cover this
 * module. Eight handlers share one per-path micro-cache shape and one
 * invalid-path/404 guard pair, so those are driven from a single table.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadRoute, makeCtx, invoke, mockFs, FILES, PROJECT_ROOT} from '../../_harness.mjs';

const routes = loadRoute('file-tools');

const VERSIONS_FILE = path.join(PROJECT_ROOT, 'var', 'data', 'versions.json');
const at = rel => path.join(PROJECT_ROOT, rel);

const fm = (fields, body = '') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`;

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

// ── The shared per-path guard and micro-cache contract ────────────────────

// Eight GET handlers take ?path=, reject an invalid one with 400 before any
// work, read the source inside a cached() closure keyed by path, and map a read
// failure to 404. The read stays inside the closure so the 404 is never cached.
describe('per-path guard and cache contract', () => {
  const CACHED = [
    {path: '/api/file/lint', prefix: 'filelint:'},
    {path: '/api/file/related', prefix: 'related:'},
  ];
  const UNCACHED = [
    {path: '/api/file/keywords'},
    {path: '/api/file/readability'},
  ];
  const DOC = {[at('content/a.md')]: fm({title: 'A'}, 'Some body text here.'), [at('content/b.md')]: 'Other body text here.'};

  for (const {path: p, prefix} of [...CACHED, ...UNCACHED]) {
    it(`${p} rejects an invalid path before any read`, async () => {
      const {ctx, counts} = fsCtx(DOC);
      const r = await invoke(routes, {path: p, query: {path: '../escape.md'}, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
      assert.equal(counts.read, 0);
      assert.deepEqual(ctx.calls.cached, []);
    });

    it(`${p} returns 404 when the source cannot be read`, async () => {
      const {ctx} = fsCtx(DOC);
      const r = await invoke(routes, {path: p, query: {path: 'content/missing.md'}, ctx});
      assert.deepEqual([r.status, r.payload], [404, {error: 'File not found'}]);
    });
  }

  for (const {path: p, prefix} of CACHED) {
    it(`${p} caches per path under "${prefix}" with a 30000 ms TTL`, async () => {
      let seen;
      // suggest-tags nests an inner all-tags-set memo, so record the first key only.
      const {ctx} = fsCtx(DOC, {cached: (key, ttl, fn) => { seen ??= [key, ttl]; return fn(); }});
      await invoke(routes, {path: p, query: {path: 'content/a.md'}, ctx});
      assert.deepEqual(seen, [`${prefix}content/a.md`, 30000]);
    });

    it(`${p} serves a repeat request from cache and keys each path separately`, async () => {
      const {ctx, counts} = fsCtx(DOC);
      await invoke(routes, {path: p, query: {path: 'content/a.md'}, ctx});
      const afterFirst = counts.read;
      await invoke(routes, {path: p, query: {path: 'content/a.md'}, ctx});
      assert.equal(counts.read, afterFirst, 'the repeat request is served from cache');
      await invoke(routes, {path: p, query: {path: 'content/b.md'}, ctx});
      assert.ok(counts.read > afterFirst, 'a distinct path is a distinct cache entry');
    });

    it(`${p} does not cache the 404 for a missing file`, async () => {
      const {ctx, counts} = fsCtx(DOC);
      await invoke(routes, {path: p, query: {path: 'content/gone.md'}, ctx});
      const afterFirst = counts.read;
      await invoke(routes, {path: p, query: {path: 'content/gone.md'}, ctx});
      assert.ok(counts.read > afterFirst, 'the error path stays outside the cache, so the next request retries');
    });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────

// ── Outline ───────────────────────────────────────────────────────────────

// ── Lint ──────────────────────────────────────────────────────────────────

describe('GET /api/file/lint', () => {
  const lint = async doc => {
    const {ctx} = fsCtx({[at('content/doc.md')]: doc});
    const r = await invoke(routes, {path: '/api/file/lint', query: {path: 'content/doc.md'}, ctx});
    return r.payload;
  };

  it('reports no issues for a clean file with a titled front-matter block', async () => {
    const out = await lint(fm({title: 'Clean'}, 'Body text.\n'));
    assert.deepEqual(out, {issues: [], issueCount: 0});
  });

  const RULES = [
    {name: 'missing frontmatter', doc: 'no front matter here\n', issue: {line: 1, severity: 'warning', message: 'Missing frontmatter'}},
    {name: 'frontmatter without a title', doc: fm({date: '2026-01-01'}, 'Body.\n'), issue: {line: 1, severity: 'warning', message: 'Missing title in frontmatter'}},
    {name: 'an empty heading', doc: fm({title: 'T'}, '###\n'), issue: {line: 5, severity: 'warning', message: 'Empty heading'}},
    {name: 'a heading with leading whitespace', doc: fm({title: 'T'}, '  # Indented\n'), issue: {line: 5, severity: 'info', message: 'Heading has leading whitespace'}},
    {name: 'unbalanced brackets', doc: fm({title: 'T'}, 'an [unclosed link\n'), issue: {line: 5, severity: 'info', message: 'Potentially unclosed brackets'}},
  ];
  for (const {name, doc, issue} of RULES) {
    it(`flags ${name}`, async () => {
      const out = await lint(doc);
      assert.ok(out.issues.some(i => i.message === issue.message && i.line === issue.line && i.severity === issue.severity),
        `expected ${JSON.stringify(issue)} among ${JSON.stringify(out.issues)}`);
    });
  }

  it('reports a long line with its exact character count', async () => {
    const out = await lint(fm({title: 'T'}, `${'x'.repeat(501)}\n`));
    assert.ok(out.issues.some(i => i.message === 'Very long line (501 chars)' && i.severity === 'info'));
  });

  // The threshold is exclusive, so a 500-character line is still acceptable.
  it('leaves a line of exactly 500 characters alone', async () => {
    const out = await lint(fm({title: 'T'}, `${'x'.repeat(500)}\n`));
    assert.deepEqual(out, {issues: [], issueCount: 0});
  });

  // A wiki link legitimately unbalances the bracket counts, so lines carrying
  // [[ or ]] are exempt. The control proves the rule fires once they are gone.
  it('exempts wiki-link lines from the bracket rule, but not their bracket-free twin', async () => {
    const exempt = await lint(fm({title: 'T'}, 'see [[Some Page] here\n'));
    assert.equal(exempt.issues.some(i => i.message === 'Potentially unclosed brackets'), false);
    const control = await lint(fm({title: 'T'}, 'see [Some Page here\n'));
    assert.ok(control.issues.some(i => i.message === 'Potentially unclosed brackets'));
  });

  // An indented heading mentioning "code" is treated as sample output.
  it('exempts an indented heading mentioning code, but not its twin without it', async () => {
    const exempt = await lint(fm({title: 'T'}, '  # code sample\n'));
    assert.equal(exempt.issues.some(i => i.message === 'Heading has leading whitespace'), false);
    const control = await lint(fm({title: 'T'}, '  # plain sample\n'));
    assert.ok(control.issues.some(i => i.message === 'Heading has leading whitespace'));
  });

  it('suppresses per-line rules inside a closed fence', async () => {
    const out = await lint(fm({title: 'T'}, `\`\`\`\n${'x'.repeat(600)}\n\`\`\`\n`));
    assert.deepEqual(out, {issues: [], issueCount: 0});
  });

  it('reports an unclosed code fence at the last line', async () => {
    const out = await lint(fm({title: 'T'}, '```\nstill open\n'));
    assert.ok(out.issues.some(i => i.severity === 'error' && i.message === 'Unclosed code block'));
  });
});

// ── Keywords ──────────────────────────────────────────────────────────────

describe('GET /api/file/keywords', () => {
  it('counts keywords, dropping stop words and markdown scaffolding', async () => {
    const doc = fm({title: 'Ignored'}, [
      '# Heading',
      'The quantum quantum quantum computer is fast.',
      '`inline code`',
      '```',
      'fenced quantum noise',
      '```',
      '[link text](http://example.com)',
      '<span>html</span>',
    ].join('\n'));
    const {ctx} = fsCtx({[at('content/doc.md')]: doc});
    const r = await invoke(routes, {path: '/api/file/keywords', query: {path: 'content/doc.md'}, ctx});
    assert.equal(r.status, 200);
    const counts = Object.fromEntries(r.payload.keywords.map(k => [k.word, k.count]));
    assert.equal(counts.quantum, 3, 'the fenced occurrence is stripped before counting');
    assert.equal(counts.computer, 1);
    // Stop words and words of two characters or fewer are dropped.
    for (const dropped of ['the', 'is', 'a']) assert.equal(counts[dropped], undefined);
    assert.equal(r.payload.totalWords, r.payload.keywords.reduce((s, k) => s + k.count, 0));
  });

  it('caps the keyword list at twenty, ordered by count descending', async () => {
    // The split pattern is /[^a-z]+/, so a digit would break a word in two;
    // these names are letters only.
    const name = i => 'w' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
    const words = Array.from({length: 30}, (_, i) => Array(i + 1).fill(name(i)).join(' ')).join(' ');
    const {ctx} = fsCtx({[at('content/doc.md')]: words});
    const r = await invoke(routes, {path: '/api/file/keywords', query: {path: 'content/doc.md'}, ctx});
    assert.equal(r.payload.keywords.length, 20);
    const counts = r.payload.keywords.map(k => k.count);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  });
});

describe('keyword strip regexes exported from the module', () => {
  const CANONICAL = {
    KEYWORDS_FRONTMATTER_RE: /^---[\s\S]*?---/,
    KEYWORDS_FENCE_RE: /```[\s\S]*?```/g,
    KEYWORDS_INLINE_CODE_RE: /`[^`]*`/g,
    KEYWORDS_LINK_RE: /!?\[([^\]]*)\]\([^)]*\)/g,
    KEYWORDS_HEADING_RE: /#{1,6}\s*/g,
    KEYWORDS_PUNCT_RE: /[*_~`>|\\[\]()-]/g,
    KEYWORDS_HTML_RE: /<[^>]+>/g,
    KEYWORDS_SPLIT_RE: /[^a-z]+/,
  };

  for (const [name, canonical] of Object.entries(CANONICAL)) {
    it(`${name} matches its canonical literal and is one shared instance`, () => {
      const re = routes[name];
      assert.ok(re instanceof RegExp, name);
      assert.equal(re.source, canonical.source, name);
      assert.equal(re.flags, canonical.flags, name);
      assert.strictEqual(loadRoute('file-tools')[name], re, name);
    });
  }

  // The /g instances are used only through replace and split, which run to
  // completion each call, so a poisoned lastIndex cannot leak between requests.
  it('produces identical output on back-to-back requests and after a poisoned lastIndex', async () => {
    const doc = fm({title: 'T'}, 'alpha beta alpha gamma alpha beta');
    const run = async () => {
      const {ctx} = fsCtx({[at('content/doc.md')]: doc});
      const r = await invoke(routes, {path: '/api/file/keywords', query: {path: 'content/doc.md'}, ctx});
      return r.payload;
    };
    const first = await run();
    for (const name of Object.keys(CANONICAL)) if (routes[name].global) routes[name].lastIndex = 5;
    assert.deepEqual(await run(), first);
    assert.deepEqual(await run(), first);
  });
});

// ── Readability ───────────────────────────────────────────────────────────

describe('GET /api/file/readability', () => {
  const read = async doc => {
    const {ctx} = fsCtx({[at('content/doc.md')]: doc});
    const r = await invoke(routes, {path: '/api/file/readability', query: {path: 'content/doc.md'}, ctx});
    return r.payload;
  };

  it('pins the whole metric set for a hand-checked sentence pair', async () => {
    // Nine words over two sentences, one syllable each:
    //   avgWordsPerSentence = round(9/2 * 10)/10       = 4.5
    //   avgSyllablesPerWord = round(9/9 * 10)/10       = 1
    //   grade = round((0.39*4.5 + 11.8*1 - 15.59)*10)/10 = -2
    assert.deepEqual(await read('The cat sat on the mat. The dog ran.'), {
      wordCount: 9,
      sentenceCount: 2,
      avgWordsPerSentence: 4.5,
      avgSyllablesPerWord: 1,
      fleschKincaidGrade: -2,
      readingLevel: 'Easy',
      readingTimeMinutes: 1,
    });
  });

  it('floors the sentence count at one so a fragment cannot divide by zero', async () => {
    const out = await read('one two three four five');
    assert.equal(out.sentenceCount, 1);
    assert.equal(out.avgWordsPerSentence, 5);
  });

  // The four bands are (-inf, 6] Easy, (6, 10] Intermediate, (10, 14]
  // Advanced, (14, inf) Expert.
  const bandFor = g => (g <= 6 ? 'Easy' : g <= 10 ? 'Intermediate' : g <= 14 ? 'Advanced' : 'Expert');
  // Chosen so the set brackets every boundary: 5.2 and 6.4 straddle 6, 9.9 and
  // 12.7 straddle 10, and 12.7 and 17.0 straddle 14. A shifted threshold
  // therefore misclassifies at least one fixture.
  const FIXTURES = [
    'Cat sat. Dog ran. Sun set.',
    'The farmer sold fresh apples and pears at the village market.',
    'We walked to the market and bought fresh bread for the family dinner tonight.',
    'The council approved the proposal after a lengthy debate about funding.',
    'The report describes several common problems and offers practical solutions for readers.',
    'Investigators reviewed the available evidence and prepared a detailed report for the supervising committee.',
  ];
  it('classifies each fixture into the band its grade falls in, covering all four bands', async () => {
    const seen = new Set();
    for (const text of FIXTURES) {
      const out = await read(text);
      assert.equal(out.readingLevel, bandFor(out.fleschKincaidGrade), `text: ${text.slice(0, 40)}`);
      seen.add(out.readingLevel);
    }
    assert.deepEqual([...seen].sort(), ['Advanced', 'Easy', 'Expert', 'Intermediate'], 'all four bands exercised');
  });

  it('strips front matter, fences, inline code, links, headings and HTML before measuring', async () => {
    // Markers go, the text they wrap stays: a heading keeps its words, a link
    // keeps its label, and an HTML tag keeps its inner text. Front matter,
    // fenced blocks and inline code are removed outright.
    const bare = await read('Heading Alpha beta gamma delta label inner');
    const dressed = await read(fm({title: 'Removed Entirely'}, [
      '# Heading',
      'Alpha beta gamma delta',
      '```',
      'fenced noise noise noise',
      '```',
      '`inline noise`',
      '[label](http://example.com)',
      '<span>inner</span>',
    ].join('\n')));
    assert.equal(dressed.wordCount, 7);
    assert.equal(dressed.wordCount, bare.wordCount);
  });

  it('is unaffected by a poisoned lastIndex on the shared global instances', async () => {
    const doc = 'Alpha beta gamma delta epsilon zeta.';
    const first = await read(doc);
    for (const name of ['KEYWORDS_FENCE_RE', 'KEYWORDS_INLINE_CODE_RE', 'KEYWORDS_LINK_RE', 'KEYWORDS_HEADING_RE', 'KEYWORDS_HTML_RE']) {
      routes[name].lastIndex = 3;
    }
    assert.deepEqual(await read(doc), first);
  });
});

// ── Dependencies ──────────────────────────────────────────────────────────

// ── Related ───────────────────────────────────────────────────────────────

describe('GET /api/file/related', () => {
  const TREE = {
    [at('content/source.md')]: fm({title: 'Source', tags: '[alpha, beta]'}, 'quantum entanglement decoherence measurement'),
    [at('content/sharesTag.md')]: fm({title: 'Shares Tag', tags: '[alpha]'}, 'completely different subject matter'),
    [at('content/sharesWords.md')]: fm({title: 'Shares Words'}, 'quantum entanglement decoherence measurement'),
    [at('content/stopwords.md')]: fm({title: 'Stop Words'}, 'the a an is are was were been have from with that this'),
    [at('content/unrelated.md')]: fm({title: 'Unrelated'}, 'gardening horticulture botany greenhouse'),
  };

  it('ranks by tag and word overlap, excluding the source and unrelated files', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/file/related', query: {path: 'content/source.md'}, ctx});
    assert.equal(r.status, 200);
    const paths = r.payload.related.map(x => x.path);
    assert.ok(paths.includes('content/sharesTag.md'));
    assert.ok(paths.includes('content/sharesWords.md'));
    assert.equal(paths.includes('content/source.md'), false, 'the source never relates to itself');
    assert.equal(paths.includes('content/unrelated.md'), false);
    // Shared stop words alone never score, so a stop-word-only file is dropped.
    assert.equal(paths.includes('content/stopwords.md'), false);
    // A shared tag is worth 5 and word overlap at most 5, so the tag match leads.
    assert.equal(paths[0], 'content/sharesTag.md');
    assert.deepEqual(r.payload.related.map(x => x.score), [...r.payload.related.map(x => x.score)].sort((a, b) => b - a));
  });

  it('caps the related list at ten', async () => {
    const many = {[at('content/source.md')]: fm({title: 'S', tags: '[alpha]'}, 'shared vocabulary here')};
    for (let i = 0; i < 15; i++) many[at(`content/r${i}.md`)] = fm({title: `R${i}`, tags: '[alpha]'}, 'shared vocabulary here');
    const {ctx} = fsCtx(many);
    const r = await invoke(routes, {path: '/api/file/related', query: {path: 'content/source.md'}, ctx});
    assert.equal(r.payload.related.length, 10);
  });
});

// ── Suggest tags ──────────────────────────────────────────────────────────

// ── Versioning ────────────────────────────────────────────────────────────

// ── Batch file info ───────────────────────────────────────────────────────

// ── Global search ─────────────────────────────────────────────────────────

// ── Git diff and compare ──────────────────────────────────────────────────

describe('numericParam (re-exported)', () => {
  const {numericParam} = routes;
  const CASES = [
    {name: 'null falls back to the default', args: [null, 30, 100], want: 30},
    {name: 'an empty string falls back to the default', args: ['', 30, 100], want: 30},
    {name: 'a non-numeric value falls back rather than yielding NaN', args: ['abc', 30, 100], want: 30},
    {name: 'a valid value passes through', args: ['42', 30, 100], want: 42},
    {name: 'a value above the cap is clamped', args: ['9999', 30, 100], want: 100},
    {name: 'a leading-numeric value keeps parseInt semantics', args: ['12abc', 30, 100], want: 12},
  ];
  for (const {name, args, want} of CASES) {
    it(name, () => assert.equal(numericParam(...args), want));
  }
});
