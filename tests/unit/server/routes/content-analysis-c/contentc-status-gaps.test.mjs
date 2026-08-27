import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load the real module the way the sibling
// route tests do (mirrors tests/next-statsdir-cache.test.mjs).
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-c.js');

// Add-only characterization suite for two content-walk handlers in
// content-analysis-c.js that were untested today: GET /api/content-status (cache
// key 'content-status') and GET /api/knowledge-gaps (cache key 'knowledge-gaps').
// Both wrap a recursive content scan in cached(key, ttl, fn) and read the
// filesystem only through ctx.fs, so an in-memory mock fs plus a memoizing cached
// pins their behavior end to end with no real filesystem, network, git, clock, or
// randomness. The suite locks the CURRENT, correct behavior so a later refactor
// cannot silently change it; it edits no source.

const PROJECT_ROOT = '/virtual-root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs over a plain-object tree (copied from the sibling harness),
// exposing only what the handlers use: readdirSync (returning withFileTypes
// Dirent-likes) and readFileSync. It records how many times each runs so a
// cache-hit test can prove the second request never re-walks the tree. Directory
// listing order is fixed (object insertion order), keeping the scan deterministic
// without depending on a platform-defined fs ordering.
function buildMockFs(rootPath, tree) {
  const dirEntries = new Map(); // fullPath -> [{ name, isDir }]
  const fileContent = new Map(); // fullPath -> string
  (function walk(prefix, node) {
    const entries = [];
    for (const [name, value] of Object.entries(node)) {
      const full = path.join(prefix, name);
      if (typeof value === 'string') {
        fileContent.set(full, value);
        entries.push({ name, isDir: false });
      } else {
        entries.push({ name, isDir: true });
        walk(full, value);
      }
    }
    dirEntries.set(prefix, entries);
  })(rootPath, tree);

  let readdirCalls = 0;
  let readCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    get readCalls() { return readCalls; },
    readdirSync(dir) {
      readdirCalls++;
      const entries = dirEntries.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return entries.map(({ name, isDir }) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      readCalls++;
      if (fileContent.has(fp)) return fileContent.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A memoizing cached(key, ttl, fn): runs fn once per key, then serves the stored
// value, modelling the real server cache on a within-TTL hit. ttl is irrelevant to
// back-to-back calls, so it is intentionally ignored here.
function buildMemoizingCached() {
  const store = new Map();
  return (key, _ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const value = fn();
    store.set(key, value);
    return value;
  };
}

// An fs whose every operation throws, used to drive each handler's outer
// try/catch 500 path. readFileSync throws first for knowledge-gaps (the
// references.yaml read), readdirSync throws first for content-status (the root
// content walk); both throws escape the cached fn and surface as a 500.
const throwingFs = {
  readdirSync() { throw new Error('disk failure'); },
  readFileSync() { throw new Error('disk failure'); },
};

// Drive one real GET handler with the minimal ctx these two read, returning the
// captured json() response. fs and cached are supplied by the caller so a pair of
// calls can share one mock fs and one cache (the cache short-circuit tests).
async function runHandler(pathname, { fs, cached }) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost' + pathname);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

// ── content-status fixtures ───────────────────────────────────────────────
// A content/ tree exercising every classification branch plus both skip rules.
// Insertion order is the scan order, so the draft array below is deterministic:
//   intro.md          plain body, no frontmatter  -> published, title 'intro'
//   guide.mdx         frontmatter title           -> published, title 'Custom Guide Title'
//   draft-titled.md   draft: true + title         -> draft,     title 'Drafted Title'
//   draft-plain.md    draft: true, no title       -> draft,     title 'draft-plain' (filename fallback)
//   pending.md        status: review              -> review,    title 'pending'
//   notes.txt         disallowed extension        -> skipped (never read)
//   .hidden/          dot-prefixed directory      -> skipped (never recursed)
//   _internal/        underscore-prefixed dir     -> skipped (never recursed)
//   sub/nested.md     nested allowed file         -> published, title 'nested'
const STATUS_TREE = {
  content: {
    'intro.md': 'Welcome to the intro file',
    'guide.mdx': '---\ntitle: Custom Guide Title\n---\nguide body here',
    'draft-titled.md': '---\ntitle: Drafted Title\ndraft: true\n---\nbody text',
    'draft-plain.md': '---\ndraft: true\n---\nplain draft body',
    'pending.md': '---\nstatus: review\n---\nreview body',
    'notes.txt': 'this disallowed extension must never be counted',
    '.hidden': { 'secret.md': 'hidden words that must never be counted at all' },
    '_internal': { 'plan.md': 'underscore-dir words that must never be counted' },
    sub: { 'nested.md': 'nested published content' },
  },
};

// Hand-computed expected payload for STATUS_TREE. Counts are array lengths; total
// is their sum; drafts and inReview are the arrays themselves, each item
// {path, title} with path RELATIVE to PROJECT_ROOT. The drafts array contrasts a
// frontmatter title ('Drafted Title') against the filename fallback ('draft-plain').
const EXPECTED_STATUS = {
  published: 3,
  draft: 2,
  review: 1,
  total: 6,
  drafts: [
    { path: 'content/draft-titled.md', title: 'Drafted Title' },
    { path: 'content/draft-plain.md', title: 'draft-plain' },
  ],
  inReview: [
    { path: 'content/pending.md', title: 'pending' },
  ],
};

// ── knowledge-gaps fixtures ───────────────────────────────────────────────
// Each reference title is its topic word repeated, so the reference mention count
// for a topic equals the repeat count: transformers 6, diffusion 8, robotics 4,
// attention 5. The keys are ordered transformers-before-diffusion so the gap sort
// is genuinely exercised (transformers has the smaller gap yet is tallied first).
const REF_TITLES = {
  ref_transformers: Array(6).fill('transformers').join(' '),
  ref_diffusion: Array(8).fill('diffusion').join(' '),
  ref_robotics: Array(4).fill('robotics').join(' '),
  ref_attention: Array(5).fill('attention').join(' '),
};
const REFS_YAML = Object.entries(REF_TITLES)
  .map(([key, title]) => `${key}:\n  title: ${title}`)
  .join('\n') + '\n';

// Content topic counts after frontmatter stripping: diffusion 2, transformers 3
// (1 from c1 body + 2 from c2), attention 12. c1's frontmatter mentions diffusion
// and notes, which the strip removes, so they are not counted.
const GAP_CONTENT = {
  'c1.md': '---\ntitle: diffusion notes\n---\ndiffusion diffusion transformers',
  'c2.md': 'transformers transformers',
  'c3.md': Array(12).fill('attention').join(' '),
};
const GAP_TREE = {
  content: { ...GAP_CONTENT, bibliography: { 'references.yaml': REFS_YAML } },
};

// Hand-computed gaps for the fixtures above (only topics with refCount >= 5 and
// ratio < 2 qualify; gap = Math.round((1 - ratio / 2) * 100)):
//   diffusion:    ref 8, content 2, ratio 0.25 -> round((1 - 0.125) * 100) = 88
//   transformers: ref 6, content 3, ratio 0.50 -> round((1 - 0.25)  * 100) = 75
//   robotics:     ref 4  -> excluded (refCount < 5)
//   attention:    ref 5, content 12, ratio 2.4 -> excluded (ratio >= 2, well covered)
// Sorted by gap descending: diffusion (88) then transformers (75).
const EXPECTED_GAPS = {
  gaps: [
    { topic: 'diffusion', referenceMentions: 8, contentMentions: 2, gap: 88 },
    { topic: 'transformers', referenceMentions: 6, contentMentions: 3, gap: 75 },
  ],
  total: 2,
};

describe('GET /api/content-status (cached content publishing status walk)', () => {
  it('returns the exact published / draft / review counts and total for a seeded tree', async () => {
    const fs = buildMockFs(PROJECT_ROOT, STATUS_TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/content-status', { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload, EXPECTED_STATUS);
    assert.equal(payload.published, 3);
    assert.equal(payload.draft, 2);
    assert.equal(payload.review, 1);
    assert.equal(payload.total, 6);
  });

  it('returns drafts / inReview arrays using the frontmatter title with a filename fallback', async () => {
    const fs = buildMockFs(PROJECT_ROOT, STATUS_TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/content-status', { fs, cached });

    assert.equal(status, 200);
    // Frontmatter title wins; a draft with no title line falls back to the filename.
    assert.deepEqual(payload.drafts, [
      { path: 'content/draft-titled.md', title: 'Drafted Title' },
      { path: 'content/draft-plain.md', title: 'draft-plain' },
    ]);
    assert.deepEqual(payload.inReview, [
      { path: 'content/pending.md', title: 'pending' },
    ]);
  });

  it('serves a deeply equal payload from cache and does not re-walk on a second call', async () => {
    const fs = buildMockFs(PROJECT_ROOT, STATUS_TREE);
    const cached = buildMemoizingCached();

    const first = await runHandler('/api/content-status', { fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, EXPECTED_STATUS);
    const readdirAfterFirst = fs.readdirCalls;
    const readAfterFirst = fs.readCalls;
    assert.ok(readdirAfterFirst > 0, 'the first request walks the content tree');

    const second = await runHandler('/api/content-status', { fs, cached });
    assert.equal(second.status, 200);
    // The back-to-back call returns a deeply equal payload from the cache key.
    assert.deepEqual(second.payload, first.payload);
    // The 'content-status' cache short-circuits the scan: no further fs access.
    assert.equal(fs.readdirCalls, readdirAfterFirst, 'second request is served from cache (no repeat readdirSync)');
    assert.equal(fs.readCalls, readAfterFirst, 'second request reads no files (served from cache)');
  });

  it('returns zeroed counts and empty arrays for an empty content directory', async () => {
    const fs = buildMockFs(PROJECT_ROOT, { content: {} });
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/content-status', { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload, {
      published: 0,
      draft: 0,
      review: 0,
      total: 0,
      drafts: [],
      inReview: [],
    });
  });

  it('returns 500 Status check failed when the root content walk throws', async () => {
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/content-status', { fs: throwingFs, cached });

    assert.equal(status, 500);
    assert.deepEqual(payload, { error: 'Status check failed' });
  });
});

describe('GET /api/knowledge-gaps (cached reference vs content topic gap scan)', () => {
  it('returns gaps with exact mention counts, sorted by gap descending, excluding low-ref and well-covered topics', async () => {
    const fs = buildMockFs(PROJECT_ROOT, GAP_TREE);
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/knowledge-gaps', { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload, EXPECTED_GAPS);
    // The higher gap sorts first even though transformers is tallied before diffusion.
    assert.deepEqual(payload.gaps.map(g => g.topic), ['diffusion', 'transformers']);
    // robotics (refCount 4) and attention (ratio >= 2) never appear.
    assert.ok(!payload.gaps.some(g => g.topic === 'robotics'), 'a refCount < 5 topic is excluded');
    assert.ok(!payload.gaps.some(g => g.topic === 'attention'), 'a well-covered topic (ratio >= 2) is excluded');
    assert.equal(payload.total, 2);
  });

  it('serves a deeply equal gaps payload from cache without re-reading on a second call', async () => {
    const fs = buildMockFs(PROJECT_ROOT, GAP_TREE);
    const cached = buildMemoizingCached();

    const first = await runHandler('/api/knowledge-gaps', { fs, cached });
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload, EXPECTED_GAPS);
    const readdirAfterFirst = fs.readdirCalls;
    const readAfterFirst = fs.readCalls;
    assert.ok(readAfterFirst > 0, 'the first request reads references.yaml and the content tree');

    const second = await runHandler('/api/knowledge-gaps', { fs, cached });
    assert.equal(second.status, 200);
    assert.deepEqual(second.payload, first.payload);
    // The 'knowledge-gaps' cache short-circuits both the references read and the scan.
    assert.equal(fs.readdirCalls, readdirAfterFirst, 'second request runs no further readdirSync');
    assert.equal(fs.readCalls, readAfterFirst, 'second request reads no further files');
  });

  it('returns {gaps: [], total: 0} for an empty references.yaml', async () => {
    const fs = buildMockFs(PROJECT_ROOT, {
      content: {
        'only.md': 'diffusion transformers analysis content here',
        bibliography: { 'references.yaml': '' },
      },
    });
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/knowledge-gaps', { fs, cached });

    assert.equal(status, 200);
    assert.deepEqual(payload, { gaps: [], total: 0 });
  });

  it('returns 500 Knowledge gap analysis failed when the references.yaml read throws', async () => {
    const cached = buildMemoizingCached();

    const { status, payload } = await runHandler('/api/knowledge-gaps', { fs: throwingFs, cached });

    assert.equal(status, 500);
    assert.deepEqual(payload, { error: 'Knowledge gap analysis failed' });
  });
});
