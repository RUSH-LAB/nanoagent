import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// Only the two calls the clusters handler makes are implemented: readdirSync
// (withFileTypes) and readFileSync. `emptyDirs` registers existing-but-empty
// directories so the handler sees an empty content dir rather than an ENOENT.
function makeFs(fileMap, emptyDirs = []) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const rel of emptyDirs) ensureDir(path.join(PROJECT_ROOT, rel));

  for (const [rel, content] of Object.entries(fileMap)) {
    const segs = rel.split('/');
    let cur = PROJECT_ROOT;
    for (let i = 0; i < segs.length; i++) {
      const isDir = i < segs.length - 1;
      ensureDir(cur);
      if (!dirs.get(cur).has(segs[i])) dirs.get(cur).set(segs[i], isDir);
      cur = path.join(cur, segs[i]);
    }
    fileContents.set(cur, content);
  }

  return {
    readdirSync(dir) {
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// Invoke GET /api/content-clusters with a mocked ctx and return the captured
// json() response. `cached` is collapsed to a pass-through so the fixture fs is
// read on every call.
async function getClusters(fs) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    cached: (_key, _ttl, fn) => fn(),
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/content-clusters');
  await studyKnowledgeRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/content-clusters', ctx);
  return captured;
}

const fm = (title, tags) => `---\ntitle: ${title}\ntags: [${tags.join(', ')}]\n---\n\nBody of ${title}.\n`;

describe('GET /api/content-clusters response shape', () => {
  it('groups pages by shared tag and matches the expected fixture payload', async () => {
    // alpha is shared by a + b (kept); beta and gamma each have one page (dropped).
    const fs = makeFs({
      'content/a.md': fm('Page A', ['alpha', 'beta']),
      'content/b.md': fm('Page B', ['alpha']),
      'content/c.md': fm('Page C', ['gamma']),
    });
    const res = await getClusters(fs);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      clusters: [
        {
          theme: 'alpha',
          pageCount: 2,
          pages: [
            { path: 'content/a.md', title: 'Page A' },
            { path: 'content/b.md', title: 'Page B' },
          ],
        },
      ],
      total: 1,
    });
  });

  it('never serializes topWords (dead computation removed)', async () => {
    const fs = makeFs({
      'content/a.md': fm('Page A', ['alpha']),
      'content/b.md': fm('Page B', ['alpha']),
    });
    const res = await getClusters(fs);
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.body).includes('topWords'), 'payload must not contain topWords');
    for (const cluster of res.body.clusters) {
      for (const page of cluster.pages) {
        assert.deepEqual(Object.keys(page).sort(), ['path', 'title'], 'page carries only path + title');
      }
    }
  });

  it('returns {clusters: [], total: 0} for an empty content dir', async () => {
    const fs = makeFs({}, ['content']);
    const res = await getClusters(fs);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { clusters: [], total: 0 });
  });

  it('excludes a tag group with only a single page (pages.length >= 2 filter)', async () => {
    const fs = makeFs({
      'content/solo.md': fm('Solo Page', ['lonely']),
    });
    const res = await getClusters(fs);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { clusters: [], total: 0 });
  });
});
