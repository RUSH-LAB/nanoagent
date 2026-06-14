import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// feeds.js is CommonJS; load the REAL module the way the sibling slides suites
// (next-feeds-slides-cache, next-feeds-slides-trim) do, and reuse their
// ctx-mocking shape. These tests drive the REAL GET /api/file/slides handler
// (server/routes/feeds.js, the inner cached transform of that route) over
// in-memory fixtures and pin the {title, slides:[{index,content}], totalSlides}
// payload against goldens captured from the live handler.
//
// Coverage gap pinned here: both existing slides suites use ONLY title-bearing
// frontmatter fixtures, so the basename title fallback never fires. This suite
// isolates the two uncovered fallback branches of the title derivation:
//   * the fmMatch-null path (no frontmatter at all), and
//   * the tm-false path (frontmatter present, but no title line),
// alongside a title-bearing positive control so the fallback fixtures are
// provably different. No source is changed; no network, clock, randomness, or
// directory walk is touched.
const require = createRequire(import.meta.url);
const SRC = path.resolve(fileURLToPath(import.meta.url), '../../server/routes/feeds.js');
const routes = require(SRC);

const PROJECT_ROOT = '/proj';

// In-memory fs stub keyed by absolute path. The slides handler reads exactly one
// file with readFileSync(path.join(PROJECT_ROOT, filePath)); a missing file
// throws ENOENT so the 404 path stays reachable (unused by these fixtures).
function makeFs(fileMap) {
  const fileContents = new Map();
  for (const [rel, content] of Object.entries(fileMap)) {
    fileContents.set(path.join(PROJECT_ROOT, rel), content);
  }
  return {
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Pass-through cached(key, ttl, fn): run fn and return it verbatim, ignoring the
// key and TTL. The cache wrapper itself is exercised by the sibling cache suite;
// here we only want the inner transform's output, so the faithful stand-in just
// runs fn() once per call.
const passThroughCached = (_key, _ttl, fn) => fn();

// Invoke the file-slides handler with a mocked ctx and capture the response
// handed to json(res, status, payload).
async function invoke(fileMap, rel) {
  const pathname = '/api/file/slides';
  const url = new URL(`http://localhost${pathname}?path=${rel}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs: makeFs(fileMap),
    path,
    PROJECT_ROOT,
    isValidFilePath: () => true,
    cached: passThroughCached,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// The basename the handler derives as the default title.
const basenameTitle = rel => path.basename(rel, path.extname(rel));

// Fixture 1: NO frontmatter (fmMatch null). A nested, hyphenated filename keeps
// the basename plus extension stripping non-trivial, with leading prose before the
// first heading. Because no frontmatter block matches, content is left untouched
// and the leading prose becomes its own first slide.
const RAW_DECK_REL = 'content/decks/raw-deck.md';
const RAW_DECK = {
  [RAW_DECK_REL]: 'Intro line before any heading.\n\n## First Slide\n\nBody of first.\n\n## Second Slide\n\nBody of second.',
};
const EXPECTED_RAW_DECK = {
  title: 'raw-deck',
  slides: [
    { index: 0, content: 'Intro line before any heading.' },
    { index: 1, content: '## First Slide\n\nBody of first.' },
    { index: 2, content: '## Second Slide\n\nBody of second.' },
  ],
  totalSlides: 3,
};

// Fixture 2: frontmatter WITHOUT a title line (fmMatch truthy, tm null). The
// frontmatter block matches and is stripped, but it carries no title line, so the
// title still falls back to the basename. The stripped date/tags lines must
// appear in NONE of the slides.
const META_ONLY_REL = 'content/decks/meta-only.md';
const META_ONLY = {
  [META_ONLY_REL]: '---\ndate: 2024-01-01\ntags: [talk]\n---\n## Only Slide\n\nBody here.',
};
const EXPECTED_META_ONLY = {
  title: 'meta-only',
  slides: [
    { index: 0, content: '## Only Slide\n\nBody here.' },
  ],
  totalSlides: 1,
};

// Fixture 3: POSITIVE control, frontmatter WITH a title line (tm branch). title
// is taken from the frontmatter, NOT the basename, proving the two fallback
// fixtures above are meaningfully different.
const WITH_TITLE_REL = 'content/decks/with-title.md';
const WITH_TITLE = {
  [WITH_TITLE_REL]: '---\ntitle: Real Title\n---\n## A\n\nbody',
};
const EXPECTED_WITH_TITLE = {
  title: 'Real Title',
  slides: [
    { index: 0, content: '## A\n\nbody' },
  ],
  totalSlides: 1,
};

// Fixture 4: title line wrapped in double quotes. The title regex strips a single
// pair of surrounding quotes, so the captured title is the unquoted text and
// still differs from the basename.
const QUOTED_REL = 'content/decks/quoted.md';
const QUOTED = {
  [QUOTED_REL]: '---\ntitle: "Quoted Title"\n---\n## A\n\nbody',
};
const EXPECTED_QUOTED = {
  title: 'Quoted Title',
  slides: [
    { index: 0, content: '## A\n\nbody' },
  ],
  totalSlides: 1,
};

describe('GET /api/file/slides title basename fallback and frontmatter strip', () => {
  it('no frontmatter: title falls back to the basename and content is NOT stripped (leading prose is the first slide)', async () => {
    const res = await invoke(RAW_DECK, RAW_DECK_REL);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_RAW_DECK);
    // Byte-identity: same fields, same order, same serialization as the live handler.
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_RAW_DECK));
    // The fallback fired: title is the extension-stripped basename of a nested path.
    assert.equal(res.payload.title, 'raw-deck');
    assert.equal(res.payload.title, basenameTitle(RAW_DECK_REL));
    // Nothing was sliced off the front, so the leading prose survives as slide 0.
    assert.equal(res.payload.slides[0].content, 'Intro line before any heading.');
    assert.ok(
      res.payload.slides.some(s => s.content === 'Intro line before any heading.'),
      'leading prose must remain a slide when there is no frontmatter to strip',
    );
  });

  it('frontmatter without a title line: title falls back to the basename and the frontmatter block IS stripped', async () => {
    const res = await invoke(META_ONLY, META_ONLY_REL);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_META_ONLY);
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_META_ONLY));
    // No title line, so the title is the basename, never a frontmatter value.
    assert.equal(res.payload.title, 'meta-only');
    assert.equal(res.payload.title, basenameTitle(META_ONLY_REL));
    // The matched frontmatter block was sliced off: its tokens reach no slide.
    const blob = res.payload.slides.map(s => s.content).join('\n');
    for (const token of ['date:', '2024-01-01', 'tags:', '[talk]', '---']) {
      assert.ok(!blob.includes(token), `stripped frontmatter token ${token} must not appear in any slide`);
    }
  });

  it('positive control: a title line is used verbatim and is NOT the basename', async () => {
    const res = await invoke(WITH_TITLE, WITH_TITLE_REL);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_WITH_TITLE);
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_WITH_TITLE));
    assert.equal(res.payload.title, 'Real Title');
    // Non-vacuous contrast: the title came from frontmatter, not the filename.
    assert.notEqual(res.payload.title, basenameTitle(WITH_TITLE_REL));
  });

  it('a title line wrapped in double quotes has the quotes stripped', async () => {
    const res = await invoke(QUOTED, QUOTED_REL);
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_QUOTED);
    assert.equal(JSON.stringify(res.payload), JSON.stringify(EXPECTED_QUOTED));
    assert.equal(res.payload.title, 'Quoted Title');
    assert.notEqual(res.payload.title, basenameTitle(QUOTED_REL));
  });
});
