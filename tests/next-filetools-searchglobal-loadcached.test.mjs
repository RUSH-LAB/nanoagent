import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');
// GET /api/search/global now reads the bibliography through the shared
// loadReferencesCached memo, which lives in references.js as a module-level
// singleton; clear it between scenarios so each case re-stats and re-reads
// deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');

// Two-entry fixture. Keys and titles are disjoint enough that "attention"
// matches only the first entry and never the second.
const REFS_YAML = `attention2017:
  title: Attention Is All You Need
  author:
    - Ashish Vaswani
  year: 2017
resnet2016:
  title: Deep Residual Learning
  author:
    - Kaiming He
  year: 2016
`;

// An fs mock serving `yamlText` for references.yaml and an empty content tree.
// statSync carries a stable {mtimeMs, size} so loadReferencesCached can memoize
// (a stat-less mock would silently fall through to a fresh read every call and
// the memo assertion below could not tell pre-fix from post-fix). `reads` counts
// references.yaml reads only; the empty content scan reads no files. Every other
// path throws ENOENT so a stray read surfaces instead of returning silent data.
function makeFs(yamlText) {
  const state = { reads: 0 };
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  const fsMock = {
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: yamlText.length };
      return enoent(fp);
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) { state.reads++; return yamlText; }
      return enoent(fp);
    },
    readdirSync(fp) {
      if (fp === CONTENT_DIR) return [];
      return enoent(fp);
    },
  };
  return { fsMock, state };
}

// Drive the real GET /api/search/global handler over a mocked ctx and capture
// what it writes. Content is empty (readdir []), so results come only from the
// bibliography (via loadReferencesCached) and the supplied comments/discussions.
async function searchGlobal(fsMock, { query, limit, comments = {}, discussions = {} } = {}) {
  const search = limit === undefined
    ? `?q=${encodeURIComponent(query)}`
    : `?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`;
  const url = new URL(`http://localhost/api/search/global${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    ALLOWED_EXTS: ['.md', '.mdx'],
    COMMENTS_FILE: 'comments',
    DISCUSSIONS_FILE: 'discussions',
    loadJSON: (file) => (file === 'comments' ? comments : file === 'discussions' ? discussions : {}),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await fileToolsRoutes(req, res, url, '/api/search/global', ctx);
  return captured;
}

describe('GET /api/search/global (references via loadReferencesCached)', () => {
  beforeEach(() => _resetReferencesCache());

  it('parses references.yaml once across two identical requests (memo)', async () => {
    const { fsMock, state } = makeFs(REFS_YAML);
    const first = await searchGlobal(fsMock, { query: 'attention' });
    const second = await searchGlobal(fsMock, { query: 'attention' });
    assert.equal(first.status, 200);
    assert.deepEqual(second.payload, first.payload);
    // Pre-fix the handler re-parsed references.yaml every request (reads === 2);
    // the shared memo serves the second request without a re-read.
    assert.equal(state.reads, 1, 'second request served from the loadReferencesCached memo');
  });

  it('returns the matching reference for a reference query, unchanged', async () => {
    const { fsMock } = makeFs(REFS_YAML);
    const r = await searchGlobal(fsMock, { query: 'attention' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      results: [{ type: 'reference', key: 'attention2017', title: 'Attention Is All You Need' }],
      total: 1,
      query: 'attention',
    });
  });

  it('returns the matching comment for a comment query, with no reference noise', async () => {
    const { fsMock } = makeFs(REFS_YAML);
    const comments = { 'blog/intro': [{ text: 'great post about widgets', author: 'sam' }] };
    const r = await searchGlobal(fsMock, { query: 'widgets', comments });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      results: [{ type: 'comment', page: 'blog/intro', text: 'great post about widgets', author: 'sam' }],
      total: 1,
      query: 'widgets',
    });
  });

  it('still returns 200 with no reference results for a broken bibliography', async () => {
    const { fsMock } = makeFs('{ unclosed');
    const comments = { 'blog/intro': [{ text: 'mentions attention here', author: 'sam' }] };
    const r = await searchGlobal(fsMock, { query: 'attention', comments });
    assert.equal(r.status, 200);
    assert.ok(!r.payload.results.some((x) => x.type === 'reference'), 'no reference results from a broken bibliography');
    assert.deepEqual(r.payload, {
      results: [{ type: 'comment', page: 'blog/intro', text: 'mentions attention here', author: 'sam' }],
      total: 1,
      query: 'attention',
    });
  });
});
