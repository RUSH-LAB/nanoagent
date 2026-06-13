import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it via createRequire the way the sibling
// per-file cache suite does (next-content-a-filemicro-cache.test.mjs). This suite
// pins the frontmatter scoring of GET /api/file/health after the handler binds the
// captured frontmatter body once (`const fmBody = fm[1]`) and reuses it across the
// three `/^title:/m`, `/^tags:/m`, `/^date:/m` checks. The fixtures flip each of the
// three checks independently (all present, title only, tags + date only, none), so a
// mistyped reuse that crossed one read into another would change a score and fail.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/proj';

// In-memory fs stub returning file contents keyed by absolute path. The handler reads
// a single content file with fs.readFileSync(path.join(PROJECT_ROOT, p)) and never
// walks a directory, so the stub only needs readFileSync; a missing path throws ENOENT
// to exercise the 404 branch if needed.
function makeFs(absFileMap) {
  return {
    readFileSync(fp) {
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A non-memoizing pass-through cached(key, ttl, fn): always run fn(), reproducing the
// exact scoring code path on every call. The frontmatter reuse under test is pure
// computation, so a pass-through cache is the cleanest way to read the real output.
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

// ── Fixtures ──
//
// Every fixture shares the same `# Heading` body and five trailing words, so the only
// driver of score differences is the frontmatter block. Heading adds min(15, 1 * 3) = 3
// and the bodies are short enough that round(words / 50) = 0, so the frontmatter points
// (present 10, title 10, tags 5, date 5) stand out cleanly in each total.

// Full frontmatter: title + tags + date all present.
//   present 10 + title 10 + tags 5 + date 5 + heading 3 = 33  -> "needs-improvement".
//   15 whitespace tokens give round(15 / 50) = 0 word points.
const FULL_REL = 'content/fm-full.md';
const FULL = `---
title: Alpha
tags: [x]
date: 2026-06-12
---
# Heading
one two three four five
`;
const FULL_EXPECTED = {
  path: FULL_REL,
  healthScore: 33,
  level: 'needs-improvement',
  checks: { hasFrontmatter: true, hasTitle: true, hasTags: true, hasDate: true, wordCount: 15, headings: 1, citations: 0, links: 0, images: 0 },
};

// Partial frontmatter: title present, tags and date absent.
//   present 10 + title 10 + heading 3 = 23  -> "needs-improvement".
//   13 whitespace tokens give round(13 / 50) = 0 word points.
const TITLE_ONLY_REL = 'content/fm-title-only.md';
const TITLE_ONLY = `---
title: Alpha
author: Bob
---
# Heading
one two three four five
`;
const TITLE_ONLY_EXPECTED = {
  path: TITLE_ONLY_REL,
  healthScore: 23,
  level: 'needs-improvement',
  checks: { hasFrontmatter: true, hasTitle: true, hasTags: false, hasDate: false, wordCount: 13, headings: 1, citations: 0, links: 0, images: 0 },
};

// Partial frontmatter: tags and date present, title absent.
//   present 10 + tags 5 + date 5 + heading 3 = 23  -> "needs-improvement".
//   13 whitespace tokens give round(13 / 50) = 0 word points.
const TAGS_DATE_REL = 'content/fm-tags-date.md';
const TAGS_DATE = `---
tags: [y]
date: 2026-06-12
---
# Heading
one two three four five
`;
const TAGS_DATE_EXPECTED = {
  path: TAGS_DATE_REL,
  healthScore: 23,
  level: 'needs-improvement',
  checks: { hasFrontmatter: true, hasTitle: false, hasTags: true, hasDate: true, wordCount: 13, headings: 1, citations: 0, links: 0, images: 0 },
};

// No frontmatter at all: the `if (fm)` block is skipped, so fmBody is never bound and
// hasTitle / hasTags / hasDate are never set.
//   score 0  -> "minimal".  8 whitespace tokens, no heading.
const NONE_REL = 'content/fm-none.md';
const NONE = `plain text without frontmatter
just some words here
`;
const NONE_EXPECTED = {
  path: NONE_REL,
  healthScore: 0,
  level: 'minimal',
  checks: { hasFrontmatter: false, wordCount: 8, headings: 0, citations: 0, links: 0, images: 0 },
};

describe('GET /api/file/health frontmatter checks reuse the bound fmBody', () => {
  it('scores all three frontmatter checks when title, tags, and date are present', async () => {
    const r = await healthOf(FULL, FULL_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, FULL_EXPECTED);
    assert.equal(JSON.stringify(r.payload), JSON.stringify(FULL_EXPECTED));
  });

  it('reads each check independently: title only flips hasTitle, not hasTags or hasDate', async () => {
    const r = await healthOf(TITLE_ONLY, TITLE_ONLY_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, TITLE_ONLY_EXPECTED);
    assert.equal(JSON.stringify(r.payload), JSON.stringify(TITLE_ONLY_EXPECTED));
    // Exactly hasTitle is true among the three frontmatter checks.
    assert.deepEqual(
      [r.payload.checks.hasTitle, r.payload.checks.hasTags, r.payload.checks.hasDate],
      [true, false, false],
    );
  });

  it('reads each check independently: tags + date flip without a title', async () => {
    const r = await healthOf(TAGS_DATE, TAGS_DATE_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, TAGS_DATE_EXPECTED);
    assert.equal(JSON.stringify(r.payload), JSON.stringify(TAGS_DATE_EXPECTED));
    assert.deepEqual(
      [r.payload.checks.hasTitle, r.payload.checks.hasTags, r.payload.checks.hasDate],
      [false, true, true],
    );
  });

  it('the title + tags + date points exactly account for the score deltas vs the partial files', async () => {
    const full = (await healthOf(FULL, FULL_REL)).payload.healthScore;
    const titleOnly = (await healthOf(TITLE_ONLY, TITLE_ONLY_REL)).payload.healthScore;
    const tagsDate = (await healthOf(TAGS_DATE, TAGS_DATE_REL)).payload.healthScore;
    // Full minus title-only is the tags (5) plus date (5) contribution.
    assert.equal(full - titleOnly, 10);
    // Full minus tags+date is the title (10) contribution.
    assert.equal(full - tagsDate, 10);
  });

  it('skips the frontmatter checks entirely when there is no frontmatter', async () => {
    const r = await healthOf(NONE, NONE_REL);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, NONE_EXPECTED);
    assert.equal(JSON.stringify(r.payload), JSON.stringify(NONE_EXPECTED));
    // The fmBody binding lives inside `if (fm)`, so these keys are absent, not false.
    assert.ok(!('hasTitle' in r.payload.checks));
    assert.ok(!('hasTags' in r.payload.checks));
    assert.ok(!('hasDate' in r.payload.checks));
  });
});
