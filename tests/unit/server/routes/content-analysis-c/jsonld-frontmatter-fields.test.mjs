import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the real module the way the sibling
// route tests do (next-jsonld-mtime-iso.test.mjs, next-content-c-filemicro-cache.test.mjs)
// so this suite exercises the shipped GET /api/file/jsonld handler, not a copy.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

const PROJECT_ROOT = '/proj';

// A single fixed mtime so the stat.mtime the handler reads is fully controlled and
// every payload is deterministic, exactly like the sibling tests. dateModified is
// always this value, and datePublished falls back to it whenever a fixture omits a
// frontmatter date.
const MTIME = new Date('2024-02-20T12:00:00.000Z');
const MTIME_ISO = MTIME.toISOString();

// In-memory fs stub keyed by ABSOLUTE path, mirroring makeCountingFs in
// next-content-c-filemicro-cache.test.mjs: readFileSync returns the fixture content
// and statSync returns the fixed mtime, both looked up by path.join(PROJECT_ROOT, rel)
// so the handler reads exactly the file under test and a wrong path throws ENOENT.
function makeFs(absFileMap) {
  return {
    readFileSync(fp) {
      if (absFileMap.has(fp)) return absFileMap.get(fp);
      const e = new Error('ENOENT: ' + fp); e.code = 'ENOENT'; throw e;
    },
    statSync(fp) {
      if (absFileMap.has(fp)) return { mtime: MTIME };
      const e = new Error('ENOENT: ' + fp); e.code = 'ENOENT'; throw e;
    },
  };
}

// Drive the real GET /api/file/jsonld handler over a minimal mocked ctx. A
// pass-through cached (ctx.cached = (_k, _t, fn) => fn()) runs the inner transform
// inline so the suite exercises the real computation rather than the cache wrapper
// or the 404 catch. json() captures the {status, payload} the handler emits.
async function jsonld(relPath, content) {
  const absFileMap = new Map([[path.join(PROJECT_ROOT, relPath), content]]);
  const url = new URL('http://localhost/api/file/jsonld?path=' + encodeURIComponent(relPath));
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    isValidFilePath: () => true,
    PROJECT_ROOT,
    fs: makeFs(absFileMap),
    path,
    cached: (_key, _ttl, fn) => fn(),
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await routes(req, res, url, '/api/file/jsonld', ctx);
  return captured;
}

// ── Fixtures ──

// Rich: title, date, description, a tags array, and an authors array, so all three
// conditional spreads (description, author, keywords) are present.
const RICH_REL = 'content/rich-article.md';
const RICH_CONTENT = `---
title: Deep Learning Methods
date: 2022-08-15
description: A survey of modern techniques
tags: [ml, ai, research]
authors: [Ada Lovelace, Alan Turing]
---

# Deep Learning Methods

This is the body with several words in it.
`;

// Bare: no frontmatter at all, so headline falls back to the basename, datePublished
// falls back to the mtime, and all three conditional spreads are omitted entirely.
const BARE_REL = 'content/bare-note.md';
const BARE_CONTENT = `# Just A Heading

Some plain body text without any frontmatter block at all.
`;

// Authors but no tags and no description, so only the author spread appears.
const AUTHORS_ONLY_REL = 'content/authors-only.md';
const AUTHORS_ONLY_CONTENT = `---
title: Solo Authored
date: 2021-03-03
authors: [Grace Hopper]
---

Body content here with a handful of words.
`;

// Tags but no authors and no description, so only the keywords spread appears.
const TAGS_ONLY_REL = 'content/tags-only.md';
const TAGS_ONLY_CONTENT = `---
title: Tagged Only
date: 2020-12-25
tags: [alpha, beta, gamma]
---

Another body with some words to count.
`;

// ── Goldens captured from the real handler (pass-through cached, fixed mtime) ──

const GOLDEN_RICH = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'Deep Learning Methods',
  datePublished: '2022-08-15T00:00:00Z',
  dateModified: MTIME_ISO,
  wordCount: 36,
  description: 'A survey of modern techniques',
  author: [
    { '@type': 'Person', name: 'Ada Lovelace' },
    { '@type': 'Person', name: 'Alan Turing' },
  ],
  keywords: 'ml, ai, research',
};

const GOLDEN_BARE = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'bare-note',
  datePublished: MTIME_ISO,
  dateModified: MTIME_ISO,
  wordCount: 14,
};

const GOLDEN_AUTHORS_ONLY = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'Solo Authored',
  datePublished: '2021-03-03T00:00:00Z',
  dateModified: MTIME_ISO,
  wordCount: 18,
  author: [
    { '@type': 'Person', name: 'Grace Hopper' },
  ],
};

const GOLDEN_TAGS_ONLY = {
  '@context': 'https://schema.org',
  '@type': 'Article',
  headline: 'Tagged Only',
  datePublished: '2020-12-25T00:00:00Z',
  dateModified: MTIME_ISO,
  wordCount: 18,
  keywords: 'alpha, beta, gamma',
};

describe('GET /api/file/jsonld — frontmatter conditional spread fields', () => {
  it('pins the full payload when title, date, description, tags, and authors are all present', async () => {
    const r = await jsonld(RICH_REL, RICH_CONTENT);
    assert.equal(r.status, 200);
    // Full-payload golden: the three conditional spreads plus the static fields.
    assert.deepEqual(r.payload, GOLDEN_RICH);
    // Spell out the non-static fields so the golden is not the only witness.
    assert.equal(r.payload['@context'], 'https://schema.org');
    assert.equal(r.payload['@type'], 'Article');
    assert.equal(r.payload.headline, 'Deep Learning Methods');
    assert.equal(r.payload.datePublished, '2022-08-15T00:00:00Z');
    assert.equal(r.payload.dateModified, MTIME_ISO);
    assert.equal(r.payload.wordCount, 36);
    assert.equal(r.payload.description, 'A survey of modern techniques');
    assert.deepEqual(r.payload.author, [
      { '@type': 'Person', name: 'Ada Lovelace' },
      { '@type': 'Person', name: 'Alan Turing' },
    ]);
    assert.equal(r.payload.keywords, 'ml, ai, research');
  });

  it('omits description, author, and keywords entirely for a bare file with no frontmatter', async () => {
    const r = await jsonld(BARE_REL, BARE_CONTENT);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, GOLDEN_BARE);
    // The three conditional spreads are absent as keys, not present with empty values.
    assert.ok(!('description' in r.payload), 'description key must be absent');
    assert.ok(!('author' in r.payload), 'author key must be absent');
    assert.ok(!('keywords' in r.payload), 'keywords key must be absent');
    // Headline falls back to the basename with the extension removed.
    assert.equal(r.payload.headline, 'bare-note');
    // With no frontmatter date, datePublished falls back to the file mtime.
    assert.equal(r.payload.datePublished, MTIME_ISO);
    assert.equal(r.payload.dateModified, MTIME_ISO);
    assert.equal(r.payload.wordCount, 14);
    assert.equal(r.payload['@context'], 'https://schema.org');
    assert.equal(r.payload['@type'], 'Article');
  });

  it('spreads only author when authors are present but tags and description are not', async () => {
    const r = await jsonld(AUTHORS_ONLY_REL, AUTHORS_ONLY_CONTENT);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, GOLDEN_AUTHORS_ONLY);
    assert.deepEqual(r.payload.author, [{ '@type': 'Person', name: 'Grace Hopper' }]);
    // tags and description were omitted, so keywords and description must be absent.
    assert.ok(!('keywords' in r.payload), 'keywords key must be absent without tags');
    assert.ok(!('description' in r.payload), 'description key must be absent without a description line');
    assert.equal(r.payload.datePublished, '2021-03-03T00:00:00Z');
  });

  it('spreads only keywords when tags are present but authors and description are not', async () => {
    const r = await jsonld(TAGS_ONLY_REL, TAGS_ONLY_CONTENT);
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, GOLDEN_TAGS_ONLY);
    assert.equal(r.payload.keywords, 'alpha, beta, gamma');
    // authors and description were omitted, so author and description must be absent.
    assert.ok(!('author' in r.payload), 'author key must be absent without authors');
    assert.ok(!('description' in r.payload), 'description key must be absent without a description line');
    assert.equal(r.payload.datePublished, '2020-12-25T00:00:00Z');
  });
});
