import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it via createRequire the way the sibling
// suites next-filehealth-fmbody.test.mjs and next-content-a-filemicro-cache.test.mjs do.
// This suite pins the parts of GET /api/file/health that those two leave a genuine
// 0-hit: the three UPPER level tiers (excellent, good, adequate; every existing fixture
// lands needs-improvement or minimal), each non-zero body-metric contribution together
// with its Math.min cap (wordCount, headings, citations, links, images), and the
// imagesWithoutAlt penalty branch (the score minus 5 plus the conditional checks key,
// present only when an alt-less image exists and absent otherwise).
//
// Every expected payload below was captured from the REAL handler (a throwaway probe
// over a pass-through cached and a mocked fs), never hand-computed, then spliced in and
// asserted with a full-payload deepEqual plus a JSON.stringify order pin. The content
// generators are identical to the probe, so a transcription drift would fail the run.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub returning file contents keyed by absolute path. The handler reads a
// single content file with fs.readFileSync(path.join(PROJECT_ROOT, p)) and never walks a
// directory, so the stub only needs readFileSync; a missing path throws ENOENT.
function makeFs(absFileMap) {
  return {
    readFileSync(fp) {
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A non-memoizing pass-through cached(key, ttl, fn): always run fn(), reproducing the
// exact scoring code path on every call. The score is pure computation, so a pass-through
// cache is the cleanest way to read the real output.
function passThroughCached() {
  return (_key, _ttl, fn) => fn();
}

// Invoke GET /api/file/health with a mocked ctx and capture the response handed to
// json(res, status, payload). isValidFilePath accepts every path so the happy path
// reaches the file read and the scoring closure.
async function healthOf(content, rel) {
  const abs = path.join(PROJECT_ROOT, rel);
  const fs = makeFs(new Map([[abs, content]]));
  const url = new URL(`http://localhost/api/file/health?path=${encodeURIComponent(rel)}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    isValidFilePath: () => true,
    cached: passThroughCached(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/health', ctx);
  return captured;
}

// ── Deterministic content generators ──
//
// Each emits exactly the token shape that drives one regex in the scoring closure, with
// no accidental cross-matches: plain words never contain `[`, `]`, `(`, `@`, or `!`; a
// with-alt image `![a0](i0.png)` matches /!\[/g (images) and /\]\(/g (links) but NOT
// /!\[\]\(/g; an alt-less image `![](i0.png)` matches all three at once.
const W = n => Array.from({ length: n }, () => 'word').join(' ');                 // n plain word tokens
const H = n => Array.from({ length: n }, (_, i) => `# Heading ${i}`).join('\n');   // n ATX headings
const C = n => Array.from({ length: n }, (_, i) => `[@ref${i}]`).join(' ');        // n [@ citations
const WL = n => Array.from({ length: n }, (_, i) => `[[Page${i}]]`).join(' ');     // n wikilinks ([[)
const ML = n => Array.from({ length: n }, (_, i) => `[t${i}](u${i})`).join(' ');   // n markdown links (](
const IMG = n => Array.from({ length: n }, (_, i) => `![a${i}](i${i}.png)`).join(' ');  // n with-alt images
const IMGNOALT = n => Array.from({ length: n }, (_, i) => `![](i${i}.png)`).join(' ');  // n alt-less images
const FM = 'title: T\ntags: [x]\ndate: 2026-01-01';                                // full frontmatter body

// ── Fixtures with goldens captured from the real handler ──
//
// Expected key order matches the handler's insertion order so the JSON.stringify pin is
// meaningful: hasFrontmatter, [hasTitle, hasTags, hasDate], wordCount, headings,
// citations, links, images, [imagesWithoutAlt].
const FIX = {
  // Level ladder, one fixture per arm. The reachable maximum raw score is 90 (frontmatter
  // 30 + words 20 + headings 15 + citations 10 + links 10 + images 5), so excellent is
  // pinned at that realistic top and the Math.min(100) cap stays defensively unreachable.
  L_MINIMAL: {
    rel: 'content/ladder-minimal.md',
    content: W(6),
    expected: { path: 'content/ladder-minimal.md', healthScore: 0, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 6, headings: 0, citations: 0, links: 0, images: 0 } },
  },
  L_NEEDS: {
    rel: 'content/ladder-needs.md',
    content: `---\n${FM}\n---\n`,
    expected: { path: 'content/ladder-needs.md', healthScore: 30, level: 'needs-improvement', checks: { hasFrontmatter: true, hasTitle: true, hasTags: true, hasDate: true, wordCount: 8, headings: 0, citations: 0, links: 0, images: 0 } },
  },
  L_ADEQUATE: {
    rel: 'content/ladder-adequate.md',
    content: `---\n${FM}\n---\n${H(4)}`,
    expected: { path: 'content/ladder-adequate.md', healthScore: 42, level: 'adequate', checks: { hasFrontmatter: true, hasTitle: true, hasTags: true, hasDate: true, wordCount: 20, headings: 4, citations: 0, links: 0, images: 0 } },
  },
  L_GOOD: {
    rel: 'content/ladder-good.md',
    content: `---\n${FM}\n---\n${H(6)}\n${C(6)}\n${WL(3)} ${ML(3)}`,
    expected: { path: 'content/ladder-good.md', healthScore: 66, level: 'good', checks: { hasFrontmatter: true, hasTitle: true, hasTags: true, hasDate: true, wordCount: 38, headings: 6, citations: 6, links: 6, images: 0 } },
  },
  L_EXCELLENT: {
    rel: 'content/ladder-excellent.md',
    content: `---\n${FM}\n---\n${W(1000)}\n${H(6)}\n${C(6)}\n${WL(3)} ${ML(3)}\n${IMG(2)}`,
    expected: { path: 'content/ladder-excellent.md', healthScore: 90, level: 'excellent', checks: { hasFrontmatter: true, hasTitle: true, hasTags: true, hasDate: true, wordCount: 1040, headings: 6, citations: 6, links: 8, images: 2 } },
  },

  // wordCount: round(words / 50) below the cap (+10) and clamped at 20 (raw round(1100/50)=22).
  WORDS_CAP: {
    rel: 'content/words-cap.md',
    content: W(1100),
    expected: { path: 'content/words-cap.md', healthScore: 20, level: 'needs-improvement', checks: { hasFrontmatter: false, wordCount: 1100, headings: 0, citations: 0, links: 0, images: 0 } },
  },
  WORDS_SUB: {
    rel: 'content/words-sub.md',
    content: W(500),
    expected: { path: 'content/words-sub.md', healthScore: 10, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 500, headings: 0, citations: 0, links: 0, images: 0 } },
  },

  // headings: headings * 3 below the cap (+9 at 3) and clamped at 15 (raw 6 * 3 = 18).
  HEAD_CAP: {
    rel: 'content/head-cap.md',
    content: H(6),
    expected: { path: 'content/head-cap.md', healthScore: 15, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 18, headings: 6, citations: 0, links: 0, images: 0 } },
  },
  HEAD_SUB: {
    rel: 'content/head-sub.md',
    content: H(3),
    expected: { path: 'content/head-sub.md', healthScore: 9, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 9, headings: 3, citations: 0, links: 0, images: 0 } },
  },

  // citations: citations * 2 below the cap (+6 at 3) and clamped at 10 (raw 6 * 2 = 12).
  CITE_CAP: {
    rel: 'content/cite-cap.md',
    content: C(6),
    expected: { path: 'content/cite-cap.md', healthScore: 10, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 6, headings: 0, citations: 6, links: 0, images: 0 } },
  },
  CITE_SUB: {
    rel: 'content/cite-sub.md',
    content: C(3),
    expected: { path: 'content/cite-sub.md', healthScore: 6, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 3, headings: 0, citations: 3, links: 0, images: 0 } },
  },

  // links: count(/\[\[/g) plus count(/\]\(/g). Both kinds present; links * 2 below the cap
  // (+4 at 2) and clamped at 10 (raw 6 * 2 = 12, from 3 wikilinks plus 3 markdown links).
  LINK_CAP: {
    rel: 'content/link-cap.md',
    content: `${WL(3)} ${ML(3)}`,
    expected: { path: 'content/link-cap.md', healthScore: 10, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 6, headings: 0, citations: 0, links: 6, images: 0 } },
  },
  LINK_SUB: {
    rel: 'content/link-sub.md',
    content: `${WL(1)} ${ML(1)}`,
    expected: { path: 'content/link-sub.md', healthScore: 4, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 2, headings: 0, citations: 0, links: 2, images: 0 } },
  },

  // images: images * 3 clamped at 5 (raw 2 * 3 = 6); each with-alt image also adds one
  // link via its `](`, and checks.imagesWithoutAlt stays ABSENT (the negative case).
  IMG_CAP: {
    rel: 'content/img-cap.md',
    content: IMG(2),
    expected: { path: 'content/img-cap.md', healthScore: 9, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 2, headings: 0, citations: 0, links: 2, images: 2 } },
  },
  // A single with-alt image: images * 3 below the cap (+3) plus one link (+2); the
  // matched positive half of the penalty contrast (imagesWithoutAlt absent).
  ALT_ONE: {
    rel: 'content/alt-one.md',
    content: IMG(1),
    expected: { path: 'content/alt-one.md', healthScore: 5, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 1, headings: 0, citations: 0, links: 1, images: 1 } },
  },
  // A single alt-less image: image (+3) plus link (+2) minus the penalty (-5) nets 0, and
  // checks.imagesWithoutAlt is present and equals the alt-less count.
  NOALT_ONE: {
    rel: 'content/noalt-one.md',
    content: IMGNOALT(1),
    expected: { path: 'content/noalt-one.md', healthScore: 0, level: 'minimal', checks: { hasFrontmatter: false, wordCount: 1, headings: 0, citations: 0, links: 1, images: 1, imagesWithoutAlt: 1 } },
  },
};

describe('GET /api/file/health pins the full scored payload for every fixture', () => {
  for (const [name, f] of Object.entries(FIX)) {
    it(`returns the captured golden for ${name}`, async () => {
      const r = await healthOf(f.content, f.rel);
      assert.equal(r.status, 200);
      assert.deepEqual(r.payload, f.expected);
      // Pin the checks key order too (a stray or reordered key fails this).
      assert.equal(JSON.stringify(r.payload), JSON.stringify(f.expected));
    });
  }
});

describe('the level ladder covers all five arms', () => {
  it('lands excellent, good, adequate, needs-improvement, and minimal on distinct fixtures', async () => {
    const levels = {};
    for (const k of ['L_EXCELLENT', 'L_GOOD', 'L_ADEQUATE', 'L_NEEDS', 'L_MINIMAL']) {
      levels[k] = (await healthOf(FIX[k].content, FIX[k].rel)).payload.level;
    }
    assert.deepEqual(levels, {
      L_EXCELLENT: 'excellent',
      L_GOOD: 'good',
      L_ADEQUATE: 'adequate',
      L_NEEDS: 'needs-improvement',
      L_MINIMAL: 'minimal',
    });
    // Five DISTINCT level strings, so no two arms collapse together.
    assert.equal(new Set(Object.values(levels)).size, 5);
  });

  it('places each score inside its tier band so every ternary arm is exercised', async () => {
    const score = async k => (await healthOf(FIX[k].content, FIX[k].rel)).payload.healthScore;
    const excellent = await score('L_EXCELLENT');
    const good = await score('L_GOOD');
    const adequate = await score('L_ADEQUATE');
    const needs = await score('L_NEEDS');
    const minimal = await score('L_MINIMAL');
    assert.ok(excellent >= 80, `excellent ${excellent} >= 80`);
    assert.ok(good >= 60 && good < 80, `good ${good} in [60,80)`);
    assert.ok(adequate >= 40 && adequate < 60, `adequate ${adequate} in [40,60)`);
    assert.ok(needs >= 20 && needs < 40, `needs ${needs} in [20,40)`);
    assert.ok(minimal < 20, `minimal ${minimal} < 20`);
    // The excellent fixture stacks every component yet stays under the Math.min(100) cap,
    // so that defensive ceiling is provably unreachable from real content.
    assert.equal(excellent, 90);
    assert.ok(excellent < 100);
  });
});

describe('each body-metric contribution scores below its cap and clamps at the cap', () => {
  it('wordCount: round(words / 50) gives +10 below the cap and clamps at 20', async () => {
    const sub = (await healthOf(FIX.WORDS_SUB.content, FIX.WORDS_SUB.rel)).payload;
    const cap = (await healthOf(FIX.WORDS_CAP.content, FIX.WORDS_CAP.rel)).payload;
    // Words are the sole contributor here, so healthScore == min(20, round(wordCount / 50)).
    assert.equal(sub.healthScore, 10);                       // round(500 / 50) = 10, below cap
    assert.equal(cap.healthScore, 20);                       // round(1100 / 50) = 22, clamped to 20
    assert.ok(Math.round(cap.checks.wordCount / 50) > 20);   // raw contribution exceeds the cap
  });

  it('headings: count * 3 gives +9 below the cap and clamps at 15', async () => {
    const sub = (await healthOf(FIX.HEAD_SUB.content, FIX.HEAD_SUB.rel)).payload;
    const cap = (await healthOf(FIX.HEAD_CAP.content, FIX.HEAD_CAP.rel)).payload;
    assert.equal(sub.healthScore, 9);                // 3 * 3 = 9, below cap
    assert.equal(cap.healthScore, 15);               // 6 * 3 = 18, clamped to 15
    assert.equal(sub.checks.headings, 3);
    assert.equal(cap.checks.headings, 6);
    assert.ok(cap.checks.headings * 3 > 15);         // raw contribution exceeds the cap
  });

  it('citations: count * 2 gives +6 below the cap and clamps at 10', async () => {
    const sub = (await healthOf(FIX.CITE_SUB.content, FIX.CITE_SUB.rel)).payload;
    const cap = (await healthOf(FIX.CITE_CAP.content, FIX.CITE_CAP.rel)).payload;
    assert.equal(sub.healthScore, 6);                // 3 * 2 = 6, below cap
    assert.equal(cap.healthScore, 10);               // 6 * 2 = 12, clamped to 10
    assert.equal(sub.checks.citations, 3);
    assert.equal(cap.checks.citations, 6);
    assert.ok(cap.checks.citations * 2 > 10);        // raw contribution exceeds the cap
  });

  it('links: (wikilink plus markdown-link) count * 2 gives +4 below the cap and clamps at 10', async () => {
    const sub = (await healthOf(FIX.LINK_SUB.content, FIX.LINK_SUB.rel)).payload;
    const cap = (await healthOf(FIX.LINK_CAP.content, FIX.LINK_CAP.rel)).payload;
    assert.equal(sub.healthScore, 4);                // 2 * 2 = 4, below cap
    assert.equal(cap.healthScore, 10);               // 6 * 2 = 12, clamped to 10
    // links sums both kinds: the cap fixture is 3 `[[` plus 3 `](`, the sub fixture 1 each,
    // so a payload that dropped either kind would not reach these counts.
    assert.equal(sub.checks.links, 2);
    assert.equal(cap.checks.links, 6);
    assert.ok(cap.checks.links * 2 > 10);            // raw contribution exceeds the cap
  });

  it('images: count * 3 gives +3 below the cap and clamps at 5, with imagesWithoutAlt absent', async () => {
    const one = (await healthOf(FIX.ALT_ONE.content, FIX.ALT_ONE.rel)).payload;
    const cap = (await healthOf(FIX.IMG_CAP.content, FIX.IMG_CAP.rel)).payload;
    // One with-alt image: image (+3) plus its own link (+2) = 5.
    assert.equal(one.healthScore, 5);
    assert.equal(one.checks.images, 1);
    // Two with-alt images: image clamped to 5 plus two links (+4) = 9.
    assert.equal(cap.healthScore, 9);
    assert.equal(cap.checks.images, 2);
    assert.ok(cap.checks.images * 3 > 5);            // raw contribution exceeds the cap
    // A with-alt image never triggers the alt-less penalty, so the key stays absent.
    assert.ok(!('imagesWithoutAlt' in one.checks));
    assert.ok(!('imagesWithoutAlt' in cap.checks));
  });
});

describe('the imagesWithoutAlt penalty branch is present only for alt-less images', () => {
  it('subtracts 5 and records the alt-less count, contrasting a matched with-alt image', async () => {
    const withAlt = (await healthOf(FIX.ALT_ONE.content, FIX.ALT_ONE.rel)).payload;
    const noAlt = (await healthOf(FIX.NOALT_ONE.content, FIX.NOALT_ONE.rel)).payload;
    // The two fixtures differ only by the alt text, so the sole score delta is the penalty.
    assert.ok(!('imagesWithoutAlt' in withAlt.checks)); // key omitted when the count is 0
    assert.equal(noAlt.checks.imagesWithoutAlt, 1);     // key present and equal to the alt-less count
    assert.equal(withAlt.healthScore - noAlt.healthScore, 5); // exactly the 5-point penalty
    // Both still register one image and one link (the `](` inside either token).
    assert.equal(withAlt.checks.images, 1);
    assert.equal(noAlt.checks.images, 1);
    assert.equal(withAlt.checks.links, 1);
    assert.equal(noAlt.checks.links, 1);
  });
});
