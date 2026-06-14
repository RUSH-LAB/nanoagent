import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the REAL module via createRequire the way
// the sibling per-file cache suite (next-content-c-filemicro-cache.test.mjs) does, and
// reuse its ctx-mocking shape. That sibling pins only breakdown.frontmatter (always 15
// for its all-keys fixture) plus the cache mechanics (the qualityscore: key prefix, the
// 30000 ms TTL, per-path keying, 400, 404). This suite pins the genuinely uncovered
// VALUE surface of GET /api/file/quality-score: the top-level score, the five-arm level
// ladder (excellent, good, adequate, needs-improvement, minimal), and all seven
// breakdown components (frontmatter, wordCount, headings, citations, links, codeExamples,
// images). It is add-only characterization: no source file is changed, and every golden
// below was captured from the live handler in server/routes/content-analysis-c.js.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub returning one file's content keyed by absolute path; a missing path
// throws ENOENT, mirroring node:fs. The quality-score handler reads exactly one file.
function makeFs(absFileMap) {
  return {
    readFileSync(fp) {
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Pass-through cached(key, ttl, fn): always runs fn(), reproducing the exact pre-cache
// code path, so the captured payload is the handler's own output, not a cache artifact.
function passThroughCached() {
  return (_key, _ttl, fn) => fn();
}

// Memoizing cached(key, ttl, fn) backed by a Map, mirroring the server.js helper:
// compute and store on a miss, return the stored value untouched on a hit. The
// transparency check uses it to prove the cache returns the identical full payload.
function makeCached() {
  const store = new Map();
  const cached = (key, _ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const val = fn();
    store.set(key, val);
    return val;
  };
  return { cached, store };
}

// Invoke the GET /api/file/quality-score handler with a mocked ctx and capture the
// response handed to json(res, status, payload). isValidFilePath always accepts so the
// happy path reaches the read; cached defaults to the pass-through computation.
async function invoke(rel, content, { cached = passThroughCached() } = {}) {
  const abs = path.join(PROJECT_ROOT, rel);
  const url = new URL(`http://localhost/api/file/quality-score?path=${encodeURIComponent(rel)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: makeFs(new Map([[abs, content]])),
    path,
    PROJECT_ROOT,
    isValidFilePath: () => true,
    cached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/quality-score', ctx);
  return captured;
}

// ── Fixtures: each hand-crafted to land on a specific scoring boundary ──
// The BODY_1000 filler saturates the wordCount arm at its cap (Math.round(1000 / 50) is
// 20). Code-fence fixtures are built by joining lines so the triple backticks stay
// literal data inside single-quoted strings.
const BODY_1000 = 'lorem '.repeat(1000);
const FIXTURES = {
  // breakdown.frontmatter: each key contributes independently (title 5, date 3, tags 3,
  // description 4) and a file with no frontmatter block scores 0 for that arm.
  fmTitle: { rel: 'content/fm-title.md', content: '---\ntitle: Only Title\n---\n\nBody word here.\n' },
  fmDate: { rel: 'content/fm-date.md', content: '---\ndate: 2024-01-01\n---\n\nBody word here.\n' },
  fmTags: { rel: 'content/fm-tags.md', content: '---\ntags: [alpha]\n---\n\nBody word here.\n' },
  fmDesc: { rel: 'content/fm-desc.md', content: '---\ndescription: A short description\n---\n\nBody word here.\n' },
  noFm: { rel: 'content/no-fm.md', content: '# A Heading\n\nSome body text without any frontmatter block at all.\n' },
  // breakdown.wordCount: Math.min(20, Math.round(wordCount / 50)). 1100 words exceed the
  // cap (Math.round(22) clamps to 20) so the min() clamp is exercised, not just its value
  // pinned; 250 words land below it at Math.round(250 / 50) = 5.
  wordCap: { rel: 'content/word-cap.md', content: 'word '.repeat(1100) },
  wordBelow: { rel: 'content/word-below.md', content: 'word '.repeat(250) },
  // breakdown.headings: Math.min(15, headingCount * 3). Six headings exceed the cap (raw
  // 18 clamps to 15); two headings land below it at 6.
  headCap: { rel: 'content/head-cap.md', content: '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n' },
  headBelow: { rel: 'content/head-below.md', content: '# First Heading\n\n## Second Heading\n\nBody text here.\n' },
  // breakdown.citations: Math.min(15, count * 3) over /\[@[\w-]+/g. Six keys exceed the
  // cap (raw 18 clamps to 15); three keys land below it at 9.
  citeCap: { rel: 'content/cite-cap.md', content: 'Refs [@a] [@b] [@c] [@d] [@e] [@f] done.\n' },
  cite: { rel: 'content/cite.md', content: 'Some text with [@smith2020] and [@jones-2021] and [@doe_99] citations.\n' },
  // breakdown.links: Math.min(10, count * 2) where count is the number of [[ plus the
  // number of ]( occurrences. Six wiki links exceed the cap (raw 12 clamps to 10) with no
  // image coupling; two wiki links plus one markdown link land below it at 3, scoring 6.
  linkCap: { rel: 'content/link-cap.md', content: 'See [[A]] [[B]] [[C]] [[D]] [[E]] [[F]] here.\n' },
  link: { rel: 'content/link.md', content: 'See [[Page One]] and [[Page Two]] and a [link](http://example.com) here.\n' },
  // breakdown.codeExamples: Math.min(10, Math.round((fenceCount / 2) * 3)). Two fenced
  // blocks (four fences) land below the cap at Math.round(2 * 3) = 6; the excellent
  // fixture below exceeds it (four blocks, raw 12 clamps to 10).
  code: { rel: 'content/code.md', content: ['Some intro text.', '', '```js', 'const x = 1;', '```', '', 'Middle paragraph.', '', '```py', 'y = 2', '```', ''].join('\n') },
  // breakdown.images: Math.min(10, count * 5) over /!\[/g. Three images exceed the cap
  // (raw 15 clamps to 10); one image lands below it at 5. The bare ![alt] form keeps these
  // off the links arm (no ]( occurrence).
  imgCap: { rel: 'content/img-cap.md', content: '![first image]\n\n![second image]\n\n![third image]\n' },
  imgBelow: { rel: 'content/img-below.md', content: '![only one]\n' },
  // score and the five-arm level ladder. A lone word scores 0 (minimal). The richer
  // fixtures stack components to land one fixture squarely in each remaining arm: 35
  // needs-improvement, 50 adequate, 71 good, 95 excellent.
  minimal: { rel: 'content/lvl-minimal.md', content: 'Tiny.\n' },
  needsImprovement: { rel: 'content/lvl-ni.md', content: ['---', 'title: NI Doc', 'date: 2024-01-01', 'tags: [a]', 'description: A needs improvement document', '---', '', BODY_1000].join('\n') },
  adequate: { rel: 'content/lvl-adequate.md', content: ['---', 'title: Adequate Doc', 'date: 2024-01-01', 'tags: [a]', 'description: An adequate document', '---', '', '# One', '## Two', '### Three', '', 'Refs: [@a2020] [@b2021].', '', BODY_1000].join('\n') },
  good: { rel: 'content/lvl-good.md', content: ['---', 'title: Good Doc', 'date: 2024-01-01', 'tags: [a]', 'description: A good document', '---', '', '# One', '## Two', '### Three', '#### Four', '##### Five', '', 'Refs: [@a2020] [@b2021] [@c2022] [@d2023] [@e2024].', '', 'Links: [[Page A]] [[Page B]] and [x](http://e.com).', '', BODY_1000].join('\n') },
  // The excellent fixture's two markdown images (![...](...)) each add a ]( to the links
  // count, so its links arm reaches the cap (raw 6, clamped to 10) partly via the images;
  // the dedicated linkCap fixture above isolates the links clamp without that coupling.
  excellent: { rel: 'content/lvl-excellent.md', content: ['---', 'title: Excellent Doc', 'date: 2024-01-01', 'tags: [research, quality]', 'description: A thoroughly excellent document', '---', '', '# Introduction', '## Background', '### Methods', '#### Results', '##### Discussion', '###### Conclusion', '', 'See [[Related Page]] and [[Another Page]] and [a link](http://example.com) and [more](http://example.org).', '', 'Citations: [@smith2020] [@jones2021] [@doe2022] [@roe2023] [@kay2024].', '', '![figure one](fig1.png)', '', '![figure two](fig2.png)', '', '```js', 'const code = 1;', '```', '', '```py', 'value = 2', '```', '', '```sh', 'echo hi', '```', '', '```rb', 'x = 3', '```', '', BODY_1000].join('\n') },
};

// ── Goldens: the exact payload the REAL handler returns for each fixture, captured from
// the live module via a pass-through cache. assert.deepEqual against these pins the
// current behavior; if any fixture string or the handler ever drifts, the deepEqual
// fails loudly. ──
const GOLDENS = {
  fmTitle: { path: 'content/fm-title.md', score: 5, level: 'minimal', breakdown: { frontmatter: 5, wordCount: 0, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 8 },
  fmDate: { path: 'content/fm-date.md', score: 3, level: 'minimal', breakdown: { frontmatter: 3, wordCount: 0, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 7 },
  fmTags: { path: 'content/fm-tags.md', score: 3, level: 'minimal', breakdown: { frontmatter: 3, wordCount: 0, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 7 },
  fmDesc: { path: 'content/fm-desc.md', score: 4, level: 'minimal', breakdown: { frontmatter: 4, wordCount: 0, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 9 },
  noFm: { path: 'content/no-fm.md', score: 3, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 3, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 12 },
  wordCap: { path: 'content/word-cap.md', score: 20, level: 'needs-improvement', breakdown: { frontmatter: 0, wordCount: 20, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 1100 },
  wordBelow: { path: 'content/word-below.md', score: 5, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 5, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 250 },
  headCap: { path: 'content/head-cap.md', score: 15, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 15, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 12 },
  headBelow: { path: 'content/head-below.md', score: 6, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 6, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 9 },
  citeCap: { path: 'content/cite-cap.md', score: 15, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 0, citations: 15, links: 0, codeExamples: 0, images: 0 }, wordCount: 8 },
  cite: { path: 'content/cite.md', score: 9, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 0, citations: 9, links: 0, codeExamples: 0, images: 0 }, wordCount: 9 },
  linkCap: { path: 'content/link-cap.md', score: 10, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 0, citations: 0, links: 10, codeExamples: 0, images: 0 }, wordCount: 8 },
  link: { path: 'content/link.md', score: 6, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 0, citations: 0, links: 6, codeExamples: 0, images: 0 }, wordCount: 10 },
  code: { path: 'content/code.md', score: 6, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 0, citations: 0, links: 0, codeExamples: 6, images: 0 }, wordCount: 16 },
  imgCap: { path: 'content/img-cap.md', score: 10, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 10 }, wordCount: 6 },
  imgBelow: { path: 'content/img-below.md', score: 5, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 5 }, wordCount: 2 },
  minimal: { path: 'content/lvl-minimal.md', score: 0, level: 'minimal', breakdown: { frontmatter: 0, wordCount: 0, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 1 },
  needsImprovement: { path: 'content/lvl-ni.md', score: 35, level: 'needs-improvement', breakdown: { frontmatter: 15, wordCount: 20, headings: 0, citations: 0, links: 0, codeExamples: 0, images: 0 }, wordCount: 1014 },
  adequate: { path: 'content/lvl-adequate.md', score: 50, level: 'adequate', breakdown: { frontmatter: 15, wordCount: 20, headings: 9, citations: 6, links: 0, codeExamples: 0, images: 0 }, wordCount: 1022 },
  good: { path: 'content/lvl-good.md', score: 71, level: 'good', breakdown: { frontmatter: 15, wordCount: 20, headings: 15, citations: 15, links: 6, codeExamples: 0, images: 0 }, wordCount: 1036 },
  excellent: { path: 'content/lvl-excellent.md', score: 95, level: 'excellent', breakdown: { frontmatter: 15, wordCount: 20, headings: 15, citations: 15, links: 10, codeExamples: 10, images: 10 }, wordCount: 1068 },
};

// Drive the real handler for one fixture, assert 200 plus the full-payload golden, and
// return the live payload so each themed test can additionally name the boundary field
// it targets. Every assertion below therefore runs against the live module output.
async function pin(key) {
  const { rel, content } = FIXTURES[key];
  const r = await invoke(rel, content);
  assert.equal(r.status, 200, `${key} should respond 200`);
  assert.deepEqual(r.payload, GOLDENS[key], `${key} full payload must match the captured golden`);
  return r.payload;
}

describe('GET /api/file/quality-score score, level tiers, and breakdown (content-analysis-c.js)', () => {
  it('pins breakdown.frontmatter for title, date, tags, and description independently, and 0 with no block', async () => {
    assert.equal((await pin('fmTitle')).breakdown.frontmatter, 5, 'title: contributes 5');
    assert.equal((await pin('fmDate')).breakdown.frontmatter, 3, 'date: contributes 3');
    assert.equal((await pin('fmTags')).breakdown.frontmatter, 3, 'tags: contributes 3');
    assert.equal((await pin('fmDesc')).breakdown.frontmatter, 4, 'description: contributes 4');
    assert.equal((await pin('noFm')).breakdown.frontmatter, 0, 'no frontmatter block scores 0');
  });

  it('pins breakdown.wordCount at the cap (20) and below', async () => {
    const cap = await pin('wordCap');
    assert.equal(cap.breakdown.wordCount, 20, 'Math.round(1100 / 50) is 22, clamped to the cap at 20');
    assert.equal(cap.wordCount, 1100, 'the raw word count is reported alongside the capped score');
    const below = await pin('wordBelow');
    assert.equal(below.breakdown.wordCount, 5, 'Math.round(250 / 50) is 5');
    assert.ok(below.breakdown.wordCount < 20, 'the below fixture stays under the cap');
  });

  it('pins breakdown.headings at the cap (15) and below', async () => {
    const cap = await pin('headCap');
    assert.equal(cap.breakdown.headings, 15, 'six headings saturate the cap at 15');
    const below = await pin('headBelow');
    assert.equal(below.breakdown.headings, 6, 'two headings score 2 * 3 = 6');
    assert.ok(below.breakdown.headings < 15, 'the below fixture stays under the cap');
  });

  it('pins breakdown.citations at the cap (15) and below', async () => {
    const cap = await pin('citeCap');
    assert.equal(cap.breakdown.citations, 15, 'six citation keys (raw 18) clamp to 15');
    const below = await pin('cite');
    assert.equal(below.breakdown.citations, 9, 'three citation keys score 3 * 3 = 9');
    assert.ok(below.breakdown.citations < 15, 'the below fixture stays under the cap');
  });

  it('pins breakdown.links at the cap (10) and below', async () => {
    const cap = await pin('linkCap');
    assert.equal(cap.breakdown.links, 10, 'six wiki links (raw 12) clamp to 10, with no image coupling');
    const below = await pin('link');
    assert.equal(below.breakdown.links, 6, 'two [[ plus one ]( score 3 * 2 = 6');
    assert.ok(below.breakdown.links < 10, 'the below fixture stays under the cap');
  });

  it('pins breakdown.codeExamples below the cap, and at the cap via the excellent fixture', async () => {
    assert.equal((await pin('code')).breakdown.codeExamples, 6, 'two fenced blocks score Math.round(2 * 3) = 6');
    assert.equal((await pin('excellent')).breakdown.codeExamples, 10, 'four fenced blocks (raw 12) clamp to 10');
  });

  it('pins breakdown.images at the cap (10) and below', async () => {
    const cap = await pin('imgCap');
    assert.equal(cap.breakdown.images, 10, 'three images (raw 15) clamp to 10');
    const below = await pin('imgBelow');
    assert.equal(below.breakdown.images, 5, 'one image scores 1 * 5 = 5');
    assert.ok(below.breakdown.images < 10, 'the below fixture stays under the cap');
  });

  it('pins the score and the five-arm level ladder, including excellent and minimal', async () => {
    const minimal = await pin('minimal');
    assert.equal(minimal.score, 0);
    assert.equal(minimal.level, 'minimal', 'score below 20 is minimal');

    const ni = await pin('needsImprovement');
    assert.equal(ni.score, 35);
    assert.equal(ni.level, 'needs-improvement', 'score in [20, 40) is needs-improvement');

    const adequate = await pin('adequate');
    assert.equal(adequate.score, 50);
    assert.equal(adequate.level, 'adequate', 'score in [40, 60) is adequate');

    const good = await pin('good');
    assert.equal(good.score, 71);
    assert.equal(good.level, 'good', 'score in [60, 80) is good');

    const excellent = await pin('excellent');
    assert.equal(excellent.score, 95);
    assert.equal(excellent.level, 'excellent', 'score at or above 80 is excellent');
  });

  it('pins the level ladder floor: a score of exactly 20 is the lowest needs-improvement', async () => {
    // wordCap scores exactly 20 from the wordCount arm alone, so it pins the >= 20
    // boundary that separates minimal from needs-improvement.
    const boundary = await pin('wordCap');
    assert.equal(boundary.score, 20);
    assert.equal(boundary.level, 'needs-improvement');
  });

  it('returns the identical full payload through the memoizing cache wrapper', async () => {
    // The handler wraps its whole computation in cached(); a memoizing run and the
    // pass-through run must serialize identically, proving the cache alters nothing.
    const { rel, content } = FIXTURES.excellent;
    const { cached, store } = makeCached();
    const viaCache = await invoke(rel, content, { cached });
    const viaPre = await invoke(rel, content);
    assert.equal(viaCache.status, 200);
    assert.deepEqual(viaCache.payload, viaPre.payload);
    assert.equal(JSON.stringify(viaCache.payload), JSON.stringify(viaPre.payload));
    assert.deepEqual(viaCache.payload, GOLDENS.excellent);
    assert.equal(store.size, 1, 'one cache entry was created for the per-path key');
  });
});
