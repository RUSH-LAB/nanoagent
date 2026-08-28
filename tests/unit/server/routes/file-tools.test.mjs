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
const {COMMENTS_FILE} = FILES;
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
    {path: '/api/file/dependencies', prefix: 'filedeps:'},
    {path: '/api/file/summary', prefix: 'filesummary:'},
    {path: '/api/file/outline', prefix: 'fileoutline:'},
    {path: '/api/file/lint', prefix: 'filelint:'},
    {path: '/api/file/suggest-tags', prefix: 'suggesttags:'},
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

describe('GET /api/file/summary', () => {
  const call = (files, p = 'content/doc.md') =>
    invoke(routes, {path: '/api/file/summary', query: {path: p}, ctx: fsCtx(files).ctx});

  it('pins the whole payload for a representative document', async () => {
    const body = [
      '# Heading One',
      '',
      'This first paragraph is comfortably longer than twenty characters.',
      '',
      'short',
      '',
      'This second paragraph is also comfortably longer than twenty characters.',
      '',
      '## Heading Two',
      '',
      '### Heading Three',
      '',
      '#### Heading Four',
    ].join('\n');
    const r = await call({[at('content/doc.md')]: fm({title: 'Doc Title'}, body)});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      title: 'Doc Title',
      // "Heading One" is 11 characters after the marker is stripped, under the
      // 20-character floor, so the two long paragraphs are the ones joined.
      summary: 'This first paragraph is comfortably longer than twenty characters. This second paragraph is also comfortably longer than twenty characters.',
      // Levels 1 to 3 only, so "#### Heading Four" is not collected.
      headings: ['Heading One', 'Heading Two', 'Heading Three'],
      wordCount: 37,
      readingTime: 1,
    });
  });

  const TITLES = [
    {name: 'the front-matter title when present', files: {[at('content/doc.md')]: fm({title: 'From FM'}, 'Body paragraph over twenty chars.')}, title: 'From FM'},
    {name: 'the basename when there is no front matter', files: {[at('content/doc.md')]: 'Body paragraph over twenty chars.'}, title: 'doc'},
    {name: 'the basename when front matter lacks a title', files: {[at('content/doc.md')]: fm({date: '2026-01-01'}, 'Body paragraph over twenty chars.')}, title: 'doc'},
  ];
  for (const {name, files, title} of TITLES) {
    it(`takes ${name}`, async () => {
      const r = await call(files);
      assert.equal(r.payload.title, title);
    });
  }

  it('drops short, import, code and HTML paragraphs and caps the summary at 300 chars', async () => {
    const body = [
      'tiny',
      '',
      'import Thing from "../../../thing";',
      '',
      '```\ncode block that is quite long indeed\n```',
      '',
      '<div>html block that is quite long indeed</div>',
      '',
      'A'.repeat(400),
    ].join('\n');
    const r = await call({[at('content/doc.md')]: body});
    // The tiny, import and fenced paragraphs are dropped. The HTML strip removes
    // the tags but keeps their text, which still clears the 20-character floor.
    assert.equal(r.payload.summary.length, 300);
    assert.ok(r.payload.summary.startsWith('html block that is quite long indeed A'));
    assert.equal(r.payload.summary.includes('tiny'), false);
    assert.equal(r.payload.summary.includes('import'), false);
  });

  it('joins only the first two qualifying paragraphs', async () => {
    const para = n => `Paragraph number ${n} is comfortably longer than twenty characters.`;
    const r = await call({[at('content/doc.md')]: [para('one'), para('two'), para('three')].join('\n\n')});
    assert.equal(r.payload.summary, `${para('one')} ${para('two')}`);
    assert.equal(r.payload.summary.includes('three'), false);
  });

  it('caps the heading list at ten', async () => {
    const body = Array.from({length: 15}, (_, i) => `# H${i}`).join('\n\n');
    const r = await call({[at('content/doc.md')]: body});
    assert.equal(r.payload.headings.length, 10);
  });

  it('computes readingTime as ceil(wordCount / 200)', async () => {
    const r = await call({[at('content/doc.md')]: Array.from({length: 250}, (_, i) => `w${i}`).join(' ')});
    assert.equal(r.payload.wordCount, 250);
    assert.equal(r.payload.readingTime, 2);
  });
});

// ── Outline ───────────────────────────────────────────────────────────────

describe('GET /api/file/outline', () => {
  it('collects levels one to six with one-based line numbers, skipping fenced code', async () => {
    const doc = [
      '# Top',            // line 1
      'prose',            // 2
      '```',              // 3
      '# Not A Heading',  // 4 (inside the fence)
      '```',              // 5
      '###### Deep  ',    // 6
      '####### Too Deep', // 7
    ].join('\n');
    const {ctx} = fsCtx({[at('content/doc.md')]: doc});
    const r = await invoke(routes, {path: '/api/file/outline', query: {path: 'content/doc.md'}, ctx});
    assert.deepEqual(r.payload, {
      headings: [
        {level: 1, text: 'Top', line: 1},
        {level: 6, text: 'Deep', line: 6},
      ],
      count: 2,
    });
  });
});

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

describe('GET /api/file/dependencies', () => {
  const SOURCE = [
    'See [[Target Page]] and [[Folder/Nested|alias]].',
    'Cited [@smith2020] and [@a2021; @b2022].',
    'Linked [text](/docs/thing) and [ext](https://example.com).',
  ].join('\n');

  const TREE = {
    [at('content/source.md')]: SOURCE,
    [at('content/linker.md')]: 'points at [[source]]',
    [at('content/suffix.md')]: 'points at [[folder/source]]',
    [at('content/substring.md')]: 'points at [[notsource]]',
    [at('content/plain.md')]: 'no links at all',
    [at('content/_draft.md')]: 'points at [[source]]',
    [at('content/.hidden.md')]: 'points at [[source]]',
  };

  it('extracts every outgoing link type and the matching incoming wiki links', async () => {
    const {ctx} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/file/dependencies', query: {path: 'content/source.md'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(r.payload.path, 'content/source.md');
    assert.deepEqual(r.payload.outgoing, [
      {type: 'wiki', target: 'Target Page'},
      {type: 'wiki', target: 'Folder/Nested'},
      {type: 'citation', target: 'smith2020'},
      {type: 'citation', target: 'a2021'},
      {type: 'citation', target: 'b2022'},
      // Only root-relative markdown links are captured, so the https one is not.
      {type: 'link', target: 'docs/thing'},
    ]);
    assert.equal(r.payload.outgoingCount, 6);
    // An exact basename match and a "/basename" suffix match count; a substring
    // does not, nor does the source file itself, a dot file or an underscore file.
    assert.deepEqual(r.payload.incoming.map(i => i.source).sort(), ['content/linker.md', 'content/suffix.md']);
    assert.equal(r.payload.incomingCount, 2);
  });

  it('returns identical results back to back, so no lastIndex leaks between requests', async () => {
    const first = await invoke(routes, {path: '/api/file/dependencies', query: {path: 'content/source.md'}, ctx: fsCtx(TREE).ctx});
    const second = await invoke(routes, {path: '/api/file/dependencies', query: {path: 'content/source.md'}, ctx: fsCtx(TREE).ctx});
    assert.deepEqual(second.payload, first.payload);
  });
});

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

describe('GET /api/file/suggest-tags', () => {
  const corpus = (tags, extra = {}) => ({
    [at('content/tagged.md')]: fm({title: 'Tagged', tags: `[${tags.join(', ')}]`}, 'corpus body'),
    ...extra,
  });

  it('suggests a corpus tag whose body frequency reaches two, at min(freq/5, 1)', async () => {
    const body = 'quantum quantum quantum theory theory';
    const {ctx} = fsCtx({...corpus(['quantum', 'theory']), [at('content/doc.md')]: body});
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    const byTag = Object.fromEntries(r.payload.suggestions.map(s => [s.tag, s.confidence]));
    assert.equal(byTag.quantum, 3 / 5);
    assert.equal(byTag.theory, 2 / 5);
  });

  it('clamps the confidence at one once the frequency reaches five', async () => {
    const body = Array(7).fill('quantum').join(' ');
    const {ctx} = fsCtx({...corpus(['quantum']), [at('content/doc.md')]: body});
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    assert.equal(r.payload.suggestions[0].confidence, 1);
  });

  it('omits a tag whose body frequency is below two', async () => {
    const {ctx} = fsCtx({...corpus(['quantum']), [at('content/doc.md')]: 'quantum appears once'});
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    assert.deepEqual(r.payload.suggestions, []);
  });

  // A hyphenated tag also matches when every part appears at least once, at a
  // flat 0.7. The dedup keeps the last push, so a tag hitting both branches
  // resolves to 0.7 rather than its frequency confidence.
  it('suggests a hyphenated tag at 0.7 when every part appears', async () => {
    const {ctx} = fsCtx({...corpus(['machine-learning']), [at('content/doc.md')]: 'machine learning discussed here'});
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    assert.deepEqual(r.payload.suggestions, [{tag: 'machine-learning', confidence: 0.7}]);
  });

  it('enforces the every() gate, so a missing part suppresses the 0.7 push', async () => {
    const {ctx} = fsCtx({...corpus(['machine-learning']), [at('content/doc.md')]: 'machine appears but the other word does not'});
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    assert.deepEqual(r.payload.suggestions, []);
  });

  it('resolves a tag hitting both branches to the last push, 0.7', async () => {
    const {ctx} = fsCtx({...corpus(['machine-learning']), [at('content/doc.md')]: 'machine-learning machine-learning machine learning'});
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    assert.deepEqual(r.payload.suggestions, [{tag: 'machine-learning', confidence: 0.7}]);
  });

  it('sorts by confidence descending and caps the list at ten', async () => {
    // The body strip drops every non-letter, so digit-bearing tags would all
    // collapse to the same word; these are letters only.
    const tags = Array.from({length: 15}, (_, i) => 'tag' + String.fromCharCode(97 + i) + String.fromCharCode(97 + i));
    const body = tags.map((t, i) => Array(i + 2).fill(t).join(' ')).join(' ');
    const {ctx} = fsCtx({...corpus(tags), [at('content/doc.md')]: body});
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    assert.equal(r.payload.suggestions.length, 10);
    const confs = r.payload.suggestions.map(s => s.confidence);
    assert.deepEqual(confs, [...confs].sort((a, b) => b - a));
  });

  it('recurses into subdirectories but skips dot and underscore corpus entries', async () => {
    const tree = {
      [at('content/sub/deep.md')]: fm({title: 'Deep', tags: '[nested]'}, 'x'),
      [at('content/_skip.md')]: fm({title: 'Skip', tags: '[hidden]'}, 'x'),
      [at('content/.dot.md')]: fm({title: 'Dot', tags: '[dotted]'}, 'x'),
      [at('content/doc.md')]: 'nested nested hidden hidden dotted dotted',
    };
    const {ctx} = fsCtx(tree);
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    assert.deepEqual(r.payload.suggestions.map(s => s.tag), ['nested']);
  });

  it('reports the five most frequent body words as topKeywords', async () => {
    const body = 'alpha alpha alpha beta beta gamma delta epsilon zeta';
    const {ctx} = fsCtx({...corpus([]), [at('content/doc.md')]: body});
    const r = await invoke(routes, {path: '/api/file/suggest-tags', query: {path: 'content/doc.md'}, ctx});
    assert.equal(r.payload.topKeywords.length, 5);
    assert.deepEqual(r.payload.topKeywords.slice(0, 2), ['alpha', 'beta']);
  });
});

// ── Versioning ────────────────────────────────────────────────────────────

describe('POST /api/file/version', () => {
  const DOC = {[at('content/a.md')]: 'one two three'};

  it('returns 429 with the file-version key, reading nothing and saving nothing', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/file/version', ctx});
    assert.deepEqual([r.status, r.payload], [429, {error: 'Too many requests. Try again in a minute.'}]);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'file-version:127.0.0.1', maxPerMinute: 30}]);
    assert.equal(reads, 0);
    assert.deepEqual(ctx.calls.saveJSON, []);
  });

  const GUARDS = [
    {name: 'an invalid path', body: {path: '../escape.md'}, error: 'Invalid path'},
    {name: 'a string label over 500 characters', body: {path: 'content/a.md', label: 'L'.repeat(501)}, error: 'Label must be 500 characters or fewer'},
    {name: 'a source file that cannot be read', body: {path: 'content/missing.md'}, error: 'Invalid request'},
  ];
  for (const {name, body, error} of GUARDS) {
    it(`rejects ${name} without saving`, async () => {
      const {ctx} = fsCtx(DOC);
      const r = await invoke(routes, {method: 'POST', path: '/api/file/version', body, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(ctx.calls.saveJSON, []);
    });
  }

  it('returns the curated subset and persists the full record including content', async () => {
    const {ctx} = fsCtx(DOC);
    const r = await invoke(routes, {method: 'POST', path: '/api/file/version', body: {path: 'content/a.md'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.payload.version).sort(), ['createdAt', 'id', 'label', 'wordCount']);
    assert.equal(r.payload.version.label, 'Untitled version');
    assert.equal(r.payload.version.wordCount, 3);
    // The reply omits content; the stored record carries it.
    assert.equal('content' in r.payload.version, false);
    const stored = ctx.store[VERSIONS_FILE]['content/a.md'];
    assert.equal(stored.length, 1);
    assert.equal(stored[0].content, 'one two three');
  });

  it('echoes a supplied label', async () => {
    const {ctx} = fsCtx(DOC);
    const r = await invoke(routes, {method: 'POST', path: '/api/file/version', body: {path: 'content/a.md', label: 'Before edit'}, ctx});
    assert.equal(r.payload.version.label, 'Before edit');
  });

  // The length guard is gated on typeof label === 'string', so a non-string
  // falls through even when it is long, and sanitizeText blanks it.
  for (const [label, value] of [['a number', 12345], ['a 501-element array', new Array(501).fill('x')]]) {
    it(`lets ${label} through the length guard`, async () => {
      const {ctx} = fsCtx(DOC);
      const r = await invoke(routes, {method: 'POST', path: '/api/file/version', body: {path: 'content/a.md', label: value}, ctx});
      assert.equal(r.status, 200);
      assert.equal(r.payload.version.label, '');
    });
  }

  it('caps the stored history at fifty, dropping the oldest', async () => {
    const existing = Array.from({length: 50}, (_, i) => ({id: `v${i}`}));
    const {ctx} = fsCtx(DOC, {store: {[VERSIONS_FILE]: {'content/a.md': existing}}});
    await invoke(routes, {method: 'POST', path: '/api/file/version', body: {path: 'content/a.md'}, ctx});
    const stored = ctx.store[VERSIONS_FILE]['content/a.md'];
    assert.equal(stored.length, 50);
    assert.equal(stored[0].id, 'v1');
  });
});

describe('GET /api/file/versions', () => {
  const stored = [
    {id: 'v1', label: 'First', createdAt: '2026-01-01', wordCount: 10, content: 'body one', extra: 'dropped'},
    {id: 'v2', label: 'Second', createdAt: '2026-01-02', wordCount: 20, content: 'body two'},
  ];

  it('rejects an invalid path without reading the store', async () => {
    const ctx = makeCtx();
    const r = await invoke(routes, {path: '/api/file/versions', query: {path: '../escape.md'}, ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid path'}]);
    assert.deepEqual(ctx.calls.loadJSON, []);
  });

  it('returns an empty list for a path absent from the store', async () => {
    const r = await invoke(routes, {path: '/api/file/versions', query: {path: 'content/none.md'}});
    assert.deepEqual([r.status, r.payload], [200, {versions: [], total: 0}]);
  });

  it('projects to the curated subset, newest first, with the full total', async () => {
    const ctx = makeCtx({store: {[VERSIONS_FILE]: {'content/a.md': stored}}});
    const r = await invoke(routes, {path: '/api/file/versions', query: {path: 'content/a.md'}, ctx});
    assert.deepEqual(r.payload, {
      versions: [
        {id: 'v2', label: 'Second', createdAt: '2026-01-02', wordCount: 20},
        {id: 'v1', label: 'First', createdAt: '2026-01-01', wordCount: 10},
      ],
      total: 2,
    });
  });
});

describe('GET /api/file/version', () => {
  const stored = [{id: 'v1', label: 'First', content: 'body one'}, {id: 'v2', label: 'Second', content: 'body two'}];
  const withStore = () => makeCtx({store: {[VERSIONS_FILE]: {'content/a.md': stored}}});

  const GUARDS = [
    {name: 'an invalid path', query: {path: '../escape.md', id: 'v1'}},
    {name: 'a missing id', query: {path: 'content/a.md'}},
  ];
  for (const {name, query} of GUARDS) {
    it(`rejects ${name} without reading the store`, async () => {
      const ctx = makeCtx();
      const r = await invoke(routes, {path: '/api/file/version', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid params'}]);
      assert.deepEqual(ctx.calls.loadJSON, []);
    });
  }

  const MISSES = [
    {name: 'an id absent from the array', query: {path: 'content/a.md', id: 'nope'}},
    {name: 'a path with no entry at all', query: {path: 'content/none.md', id: 'v1'}},
  ];
  for (const {name, query} of MISSES) {
    it(`returns 404 for ${name}`, async () => {
      const r = await invoke(routes, {path: '/api/file/version', query, ctx: withStore()});
      assert.deepEqual([r.status, r.payload], [404, {error: 'Version not found'}]);
    });
  }

  it('returns the matching entry in full, including content', async () => {
    const r = await invoke(routes, {path: '/api/file/version', query: {path: 'content/a.md', id: 'v2'}, ctx: withStore()});
    assert.deepEqual([r.status, r.payload], [200, {version: stored[1]}]);
  });
});

// ── Batch file info ───────────────────────────────────────────────────────

describe('POST /api/files/info', () => {
  it('returns 429 with the files-info key without reading the body', async () => {
    let reads = 0;
    const ctx = makeCtx({rateLimitAllow: false, readBody: async () => { reads++; return {}; }});
    const r = await invoke(routes, {method: 'POST', path: '/api/files/info', ctx});
    assert.equal(r.status, 429);
    assert.deepEqual(ctx.calls.rateLimit, [{key: 'files-info:127.0.0.1', maxPerMinute: 30}]);
    assert.equal(reads, 0);
  });

  for (const [label, body] of [['a non-array paths', {paths: 'a.md'}], ['an omitted paths', {}]]) {
    it(`rejects ${label}`, async () => {
      const r = await invoke(routes, {method: 'POST', path: '/api/files/info', body, ctx: fsCtx({}).ctx});
      assert.deepEqual([r.status, r.payload], [400, {error: 'paths must be an array'}]);
    });
  }

  it('reports per-entry errors without abandoning later entries', async () => {
    const {ctx} = fsCtx({[at('content/ok.md')]: 'body words here'});
    const paths = ['../escape.md', 'content/missing.md', 'content/ok.md'];
    const r = await invoke(routes, {method: 'POST', path: '/api/files/info', body: {paths}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.results.map(x => x.error), ['Invalid path', 'File not found', undefined]);
    assert.equal(r.payload.count, 3);
  });

  it('caps the batch at the first fifty paths', async () => {
    const files = Object.fromEntries(Array.from({length: 60}, (_, i) => [at(`content/f${i}.md`), 'x']));
    const {ctx} = fsCtx(files);
    const paths = Array.from({length: 60}, (_, i) => `content/f${i}.md`);
    const r = await invoke(routes, {method: 'POST', path: '/api/files/info', body: {paths}, ctx});
    assert.equal(r.payload.count, 50);
  });

  const SHAPES = [
    {name: 'no front matter', body: 'one two three', title: 'doc', draft: false},
    {name: 'a front-matter title and draft true', body: fm({title: 'Real', draft: 'true'}, 'one two three'), title: 'Real', draft: true},
    {name: 'front matter with no draft line', body: fm({title: 'Real'}, 'one two three'), title: 'Real', draft: false},
  ];
  for (const {name, body, title, draft} of SHAPES) {
    it(`describes a file with ${name}`, async () => {
      const {ctx} = fsCtx({[at('content/doc.md')]: body});
      const r = await invoke(routes, {method: 'POST', path: '/api/files/info', body: {paths: ['content/doc.md']}, ctx});
      const [entry] = r.payload.results;
      assert.equal(entry.title, title);
      assert.equal(entry.draft, draft);
      assert.equal(entry.size, Buffer.byteLength(body));
      assert.equal(typeof entry.mtime, 'string');
      assert.ok(entry.wordCount > 0);
    });
  }
});

// ── Global search ─────────────────────────────────────────────────────────

describe('GET /api/search/global', () => {
  const TREE = {
    [at('content/quantum.md')]: 'a page about quantum things',
    [at('content/.hidden.md')]: 'hidden quantum page',
    [at('content/notes.txt')]: 'quantum but wrong extension',
    [at('content/bibliography/references.yaml')]: 'q2020:\n  title: Quantum Paper\n  author:\n    - Alice Quantum\n',
  };
  const STORE = {
    [COMMENTS_FILE]: {'/p': [{text: 'a quantum comment', author: 'Ada'}], bad: 'not-an-array'},
  };

  it('aggregates content, reference and comment hits in that order', async () => {
    const {ctx} = fsCtx(TREE, {store: STORE});
    const r = await invoke(routes, {path: '/api/search/global', query: {q: 'quantum'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.results.map(x => x.type), ['content', 'reference', 'comment']);
    assert.equal(r.payload.query, 'quantum');
    assert.equal(r.payload.total, 3);
    assert.equal(r.payload.results[0].path, 'content/quantum.md', 'dot files and non-markdown are skipped');
  });

  it('truncates comment bodies to one hundred characters', async () => {
    const long = `quantum ${'x'.repeat(200)}`;
    const store = {[COMMENTS_FILE]: {'/p': [{text: long}]}};
    const {ctx} = fsCtx({[at('content/.keep')]: ''}, {store});
    const r = await invoke(routes, {path: '/api/search/global', query: {q: 'quantum'}, ctx});
    for (const hit of r.payload.results) assert.equal(hit.text.length, 100);
  });

  it('returns 400 for a missing query before scanning', async () => {
    const {ctx, counts} = fsCtx(TREE);
    const r = await invoke(routes, {path: '/api/search/global', ctx});
    assert.deepEqual([r.status, r.payload], [400, {error: 'Missing query'}]);
    assert.equal(counts.readdir, 0);
  });

  it('still returns 200 when the bibliography is unreadable', async () => {
    const {ctx} = fsCtx({[at('content/quantum.md')]: 'quantum', [at('content/bibliography/references.yaml')]: '\tbroken: [' }, {store: {}});
    const r = await invoke(routes, {path: '/api/search/global', query: {q: 'quantum'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.results.map(x => x.type), ['content']);
  });

  it('returns 500 when the content walk throws', async () => {
    const ctx = makeCtx({fs: {readdirSync() { throw new Error('unreadable'); }}});
    const r = await invoke(routes, {path: '/api/search/global', query: {q: 'quantum'}, ctx});
    assert.deepEqual(r.replies, [{status: 500, payload: {error: 'Global search failed'}, opts: undefined}]);
    assert.equal(r.replies.some(x => x.payload && 'results' in x.payload), false);
  });

  // Per-file read failures are swallowed inside the scan, so they reach the 200.
  it('does not 500 when an individual file read throws', async () => {
    const base = mockFs(TREE);
    const fs = {...base, readFileSync: p => { if (p.endsWith('quantum.md')) throw new Error('locked'); return base.readFileSync(p); }};
    const r = await invoke(routes, {path: '/api/search/global', query: {q: 'quantum'}, ctx: makeCtx({fs, store: STORE})});
    assert.equal(r.status, 200);
    assert.equal(r.payload.results.some(x => x.type === 'content'), false);
  });

  const LIMITS = [
    {name: 'absent, giving the default of 30', query: {}, want: 3},
    {name: 'valid', query: {limit: '2'}, want: 2},
    {name: 'above the cap, clamped to 100', query: {limit: '9999'}, want: 3},
    {name: 'non-numeric, falling back to the default', query: {limit: 'abc'}, want: 3},
    // numericParam only upper-bounds, so without the floor slice(0, -1) would
    // silently drop the last match instead of returning nothing.
    {name: 'negative, clamped to zero', query: {limit: '-1'}, want: 0},
    {name: 'very negative, clamped the same way', query: {limit: '-3'}, want: 0},
  ];
  for (const {name, query, want} of LIMITS) {
    it(`handles a limit that is ${name}`, async () => {
      const {ctx} = fsCtx(TREE, {store: STORE});
      const r = await invoke(routes, {path: '/api/search/global', query: {q: 'quantum', ...query}, ctx});
      assert.equal(r.payload.results.length, want);
      assert.equal(r.payload.total, 3, 'total always reports the full match count');
    });
  }
});

// ── Git diff and compare ──────────────────────────────────────────────────

describe('GET /api/file/word-diff', () => {
  function gitCtx(over = {}) {
    const calls = {n: 0, args: null, opts: null};
    const ctx = makeCtx({
      execFileSync: (cmd, args, opts) => { calls.n++; calls.args = args; calls.opts = opts; return '{+added+} [-removed-] {+more+}'; },
      ...over,
    });
    return {ctx, calls};
  }

  const REJECTED = [
    {name: 'an invalid path', query: {path: '../escape.md', hash: 'abc1234'}, error: 'Invalid path'},
    {name: 'a missing hash', query: {path: 'content/a.md'}, error: 'Invalid hash'},
    ...['abc', 'zzzz', 'a'.repeat(41)].map(hash => ({name: `the bad hash ${JSON.stringify(hash)}`, query: {path: 'content/a.md', hash}, error: 'Invalid hash'})),
  ];
  for (const {name, query, error} of REJECTED) {
    it(`returns 400 for ${name} before running git`, async () => {
      const {ctx, calls} = gitCtx();
      const r = await invoke(routes, {path: '/api/file/word-diff', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.equal(calls.n, 0);
    });
  }

  it('runs git once with the word-diff args and counts the markers', async () => {
    const {ctx, calls} = gitCtx();
    const r = await invoke(routes, {path: '/api/file/word-diff', query: {path: 'content/a.md', hash: 'abc1234'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(calls.n, 1);
    assert.deepEqual(calls.args, ['diff', '--word-diff=plain', 'abc1234..HEAD', '--', 'content/a.md']);
    assert.deepEqual(calls.opts, {cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000});
    assert.equal(r.payload.wordsAdded, 2);
    assert.equal(r.payload.wordsRemoved, 1);
  });

  for (const hash of ['abcd', 'a'.repeat(40), 'ABCDEF']) {
    it(`accepts the boundary-valid hash ${JSON.stringify(hash)}`, async () => {
      const {ctx, calls} = gitCtx();
      const r = await invoke(routes, {path: '/api/file/word-diff', query: {path: 'content/a.md', hash}, ctx});
      assert.equal(r.status, 200);
      assert.equal(calls.n, 1);
    });
  }

  it('soft-fails to an empty diff when git throws', async () => {
    const {ctx} = gitCtx({execFileSync() { throw new Error('git unavailable'); }});
    const r = await invoke(routes, {path: '/api/file/word-diff', query: {path: 'content/a.md', hash: 'abc1234'}, ctx});
    assert.deepEqual([r.status, r.payload], [200, {diff: '', wordsAdded: 0, wordsRemoved: 0}]);
  });
});

describe('GET /api/file/compare', () => {
  function compareCtx(over = {}) {
    const calls = [];
    const ctx = makeCtx({
      fs: mockFs({[at('content/a.md')]: 'working copy'}),
      execFileSync: (cmd, args) => {
        calls.push(args);
        return args[0] === 'show' ? `content at ${args[1]}` : '2026-01-01 00:00:00 +0000\n';
      },
      ...over,
    });
    return {ctx, calls};
  }

  const REJECTED = [
    {name: 'an invalid path', query: {path: '../escape.md', hash1: 'abcd', hash2: 'ef01'}, error: 'Invalid path'},
    {name: 'a missing hash1', query: {path: 'content/a.md', hash2: 'ef01'}, error: 'Invalid hash1'},
    {name: 'a non-hex hash1', query: {path: 'content/a.md', hash1: 'zzzz', hash2: 'ef01'}, error: 'Invalid hash1'},
    {name: 'a missing hash2', query: {path: 'content/a.md', hash1: 'abcd'}, error: 'Invalid hash2'},
    {name: 'a non-hex hash2 that is not "current"', query: {path: 'content/a.md', hash1: 'abcd', hash2: 'zzzz'}, error: 'Invalid hash2'},
  ];
  for (const {name, query, error} of REJECTED) {
    it(`returns 400 for ${name} before running git`, async () => {
      const {ctx, calls} = compareCtx();
      const r = await invoke(routes, {path: '/api/file/compare', query, ctx});
      assert.deepEqual([r.status, r.payload], [400, {error}]);
      assert.deepEqual(calls, []);
    });
  }

  it('makes four ordered git calls and returns both versions for two hashes', async () => {
    const {ctx, calls} = compareCtx();
    const r = await invoke(routes, {path: '/api/file/compare', query: {path: 'content/a.md', hash1: 'abcd', hash2: 'ef01'}, ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [
      ['show', 'abcd:content/a.md'],
      ['log', '-1', '--format=%ai', 'abcd'],
      ['show', 'ef01:content/a.md'],
      ['log', '-1', '--format=%ai', 'ef01'],
    ]);
    assert.deepEqual(r.payload.version1, {hash: 'abcd', content: 'content at abcd:content/a.md', date: '2026-01-01 00:00:00 +0000'});
    assert.equal(r.payload.version2.hash, 'ef01');
  });

  it('reads the working file rather than git when hash2 is "current"', async () => {
    const {ctx, calls} = compareCtx();
    const r = await invoke(routes, {path: '/api/file/compare', query: {path: 'content/a.md', hash1: 'abcd', hash2: 'current'}, ctx});
    assert.equal(r.status, 200);
    assert.equal(calls.length, 2, 'only the hash1 pair goes to git');
    assert.equal(r.payload.version2.hash, 'current');
    assert.equal(r.payload.version2.content, 'working copy');
  });

  it('returns 404 when hash2 is "current" and the working file is absent', async () => {
    const {ctx} = compareCtx({fs: mockFs({})});
    const r = await invoke(routes, {path: '/api/file/compare', query: {path: 'content/a.md', hash1: 'abcd', hash2: 'current'}, ctx});
    assert.deepEqual([r.status, r.payload], [404, {error: 'File not found'}]);
  });

  it('returns 500 when a git call throws', async () => {
    const {ctx} = compareCtx({execFileSync() { throw new Error('git unavailable'); }});
    const r = await invoke(routes, {path: '/api/file/compare', query: {path: 'content/a.md', hash1: 'abcd', hash2: 'ef01'}, ctx});
    assert.deepEqual([r.status, r.payload], [500, {error: 'Failed to retrieve file versions'}]);
  });
});

// ── numericParam ──────────────────────────────────────────────────────────

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

// Both body-reading handlers wrap the read in one try whose catch returns a
// fixed 400 ahead of the first inner guard.
describe('malformed-body outer catches', () => {
  for (const p of ['/api/file/version', '/api/files/info']) {
    for (const [label, readBody] of [
      ['readBody rejects', async () => { throw new Error('bad json'); }],
      ['readBody resolves null', async () => null],
    ]) {
      it(`POST ${p} returns 400 Invalid request when ${label}, without saving`, async () => {
        const ctx = makeCtx({readBody, fs: mockFs()});
        const r = await invoke(routes, {method: 'POST', path: p, ctx});
        assert.deepEqual([r.status, r.payload], [400, {error: 'Invalid request'}]);
        assert.deepEqual(ctx.calls.saveJSON, []);
      });
    }
  }
});
