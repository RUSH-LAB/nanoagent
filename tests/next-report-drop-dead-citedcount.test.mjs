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
// Only the two calls the report handler makes are implemented: readdirSync
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

// Invoke GET /api/report/knowledge-base with a mocked ctx and return the
// captured json() response. The report handler reads path, PROJECT_ROOT,
// ALLOWED_EXTS, fs, cached, and json from ctx (js-yaml is required directly).
// `cached` is a pass-through here so the scan runs every call, preserving this
// suite's original behavior; the kb-report cache itself is covered by
// tests/next-kbreport-cache.test.mjs.
async function getReport(fs) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/report/knowledge-base');
  await studyKnowledgeRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/report/knowledge-base', ctx);
  return captured;
}

describe('GET /api/report/knowledge-base overview', () => {
  it('reports totals, references, and average words for a multi-dir corpus', async () => {
    // intro.md lives at the content root ("root"); setup.md lives under "guide".
    const fs = makeFs({
      'content/intro.md': 'one two three four five',                    // 5 words
      'content/guide/setup.md': 'alpha beta gamma',                     // 3 words
      'bibliography/references.yaml': 'key1:\n  title: A\nkey2:\n  title: B\n', // 2 refs
    });
    const res = await getReport(fs);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.overview, {
      totalFiles: 2,
      totalWords: 8,
      references: 2,
      avgWordsPerFile: 4,
    });
    assert.deepEqual(res.body.sections, [
      { name: 'root', files: 1, words: 5 },
      { name: 'guide', files: 1, words: 3 },
    ]);
    assert.deepEqual(res.body.topTags, []);
    assert.equal(typeof res.body.generatedAt, 'string');
    // citedCount was always write-only dead code; it must never reach the payload.
    assert.ok(!JSON.stringify(res.body).includes('citedCount'), 'payload must not contain citedCount');
  });

  it('zeroes the overview and guards the average for an empty corpus', async () => {
    const fs = makeFs({}, ['content']); // empty content dir, no references.yaml
    const res = await getReport(fs);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.overview, {
      totalFiles: 0,
      totalWords: 0,
      references: 0,
      avgWordsPerFile: 0,
    });
    assert.deepEqual(res.body.sections, []);
    assert.deepEqual(res.body.topTags, []);
  });

  it('falls back to zero references when the bibliography is missing', async () => {
    const fs = makeFs({
      'content/a.md': 'just four short words', // 4 words, no references.yaml
    });
    const res = await getReport(fs);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.overview, {
      totalFiles: 1,
      totalWords: 4,
      references: 0,
      avgWordsPerFile: 4,
    });
  });

  it('aggregates frontmatter tags into a ranked topTags list', async () => {
    // Word counts include frontmatter tokens, matching the handler's raw split.
    const fs = makeFs({
      'content/x.md': '---\ntags: [alpha, beta]\n---\nhello world', // 7 tokens
      'content/y.md': '---\ntags: [alpha]\n---\nfoo',               // 5 tokens
      'bibliography/references.yaml': 'only: 1\n',                  // 1 ref
    });
    const res = await getReport(fs);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.overview, {
      totalFiles: 2,
      totalWords: 12,
      references: 1,
      avgWordsPerFile: 6,
    });
    assert.deepEqual(res.body.topTags, [
      { tag: 'alpha', count: 2 },
      { tag: 'beta', count: 1 },
    ]);
  });
});
