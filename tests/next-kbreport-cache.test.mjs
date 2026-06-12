import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from a `${rel-from-PROJECT_ROOT}: content` map. Only
// the two calls the report handler makes are implemented (readdirSync with
// withFileTypes, and readFileSync), plus a `counts` tally so a test can prove a
// cache hit skips the filesystem walk entirely.
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

  const counts = { readdirSync: 0, readFileSync: 0 };
  return {
    counts,
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      counts.readFileSync++;
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// A `cached` stub that BOTH memoizes by key (so a second call is served without
// re-running the producer) AND records every value the handler asked to cache,
// so a test can inspect exactly what was stored.
function makeCached() {
  const store = new Map();
  const captures = [];
  const cached = (key, _ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const value = fn();
    store.set(key, value);
    captures.push({ key, value });
    return value;
  };
  return { cached, captures };
}

// Invoke GET /api/report/knowledge-base against the supplied fs + cached stubs
// and return the captured json() response.
async function getReport(fs, cached) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    cached,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/report/knowledge-base');
  await studyKnowledgeRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/report/knowledge-base', ctx);
  return captured;
}

describe('GET /api/report/knowledge-base caching', () => {
  it('caches the scan-derived report and keeps generatedAt per-request', async () => {
    // x.md/y.md live at the content root; setup.md lives under "guide". Word
    // counts include frontmatter tokens, matching the handler's raw split.
    const fs = makeFs({
      'content/x.md': '---\ntags: [alpha, beta]\n---\nhello world', // 7 tokens, tags alpha+beta
      'content/y.md': '---\ntags: [alpha]\n---\nfoo',               // 5 tokens, tag alpha
      'content/guide/setup.md': 'alpha beta gamma',                // 3 tokens, no tags
      'bibliography/references.yaml': 'only: 1\n',                  // 1 ref
    });
    const { cached, captures } = makeCached();

    const expectedOverview = { totalFiles: 3, totalWords: 15, references: 1, avgWordsPerFile: 5 };
    const expectedSections = [
      { name: 'root', files: 2, words: 12 },
      { name: 'guide', files: 1, words: 3 },
    ];
    const expectedTopTags = [
      { tag: 'alpha', count: 2 },
      { tag: 'beta', count: 1 },
    ];

    // (1) The payload matches the expected values on the first call.
    const res1 = await getReport(fs, cached);
    assert.equal(res1.status, 200);
    assert.deepEqual(res1.body.overview, expectedOverview);
    assert.deepEqual(res1.body.sections, expectedSections);
    assert.deepEqual(res1.body.topTags, expectedTopTags);

    // (2) The captured cached value carries the scan fields but NOT generatedAt,
    // proving the timestamp is assembled outside the cached closure.
    assert.equal(captures.length, 1);
    assert.equal(captures[0].key, 'kb-report');
    const cachedValue = captures[0].value;
    assert.deepEqual(cachedValue.overview, expectedOverview);
    assert.deepEqual(cachedValue.sections, expectedSections);
    assert.deepEqual(cachedValue.topTags, expectedTopTags);
    assert.ok(!('generatedAt' in cachedValue), 'cached value must not contain generatedAt');
    assert.ok(!JSON.stringify(cachedValue).includes('generatedAt'), 'cached value JSON must not mention generatedAt');

    // (3) The response itself carries a fresh, valid ISO generatedAt timestamp.
    assert.equal(typeof res1.body.generatedAt, 'string');
    assert.equal(new Date(res1.body.generatedAt).toISOString(), res1.body.generatedAt);

    // (4) A second back-to-back call is served from cache: the scan fields are
    // deeply equal and fs.readdirSync is not called again.
    const readdirAfterFirst = fs.counts.readdirSync;
    assert.ok(readdirAfterFirst > 0, 'first call must walk the content tree');
    const res2 = await getReport(fs, cached);
    assert.equal(res2.status, 200);
    assert.deepEqual(res2.body.overview, res1.body.overview);
    assert.deepEqual(res2.body.sections, res1.body.sections);
    assert.deepEqual(res2.body.topTags, res1.body.topTags);
    assert.equal(fs.counts.readdirSync, readdirAfterFirst, 'second call must be served from cache (no repeat readdirSync)');
    assert.equal(captures.length, 1, 'producer must run only once across both calls');
    assert.equal(typeof res2.body.generatedAt, 'string');
    assert.equal(new Date(res2.body.generatedAt).toISOString(), res2.body.generatedAt);
  });
});
