import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// The related handler only touches readFileSync (source file) and readdirSync
// (recursive content walk); existsSync is included for parity with the real fs.
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
    existsSync(p) { return dirs.has(p) || fileContents.has(p); },
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

// Drive GET /api/file/related with a mocked ctx and capture the json() response.
// isValidFilePath defaults to accepting any path so tests focus on the handler.
async function getRelated(fs, filePath, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    isValidFilePath,
    // The handler now wraps its result building in cached(); inject a
    // pass-through so this test keeps exercising the full scan on every call.
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/file/related?path=${encodeURIComponent(filePath)}`);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/related', ctx);
  return captured;
}

// Source frontmatter carries the tags used for the tag-overlap score; the body
// mixes four content words with eight stop words. The stop words are seeded so
// that, were the RELATED_STOP_WORDS filter dropped, a candidate built only from
// those same stop words would cross the score threshold and surface as related.
const SOURCE = `---
title: Source Doc
tags: [graph, theory]
---

machine learning neural networks this that with from will have been were
`;

// Shares all four source content words but no tags. Word overlap caps the score
// at 5 (min(4/5 * 10, 5)).
const RELATED_CONTENT = `---
title: Related By Content
---

machine learning neural networks concepts
`;

// Shares both source tags but no content words. Two tag hits give a score of 10.
const RELATED_TAGS = `---
title: Related By Tags
tags: [graph, theory]
---

completely different vocabulary here
`;

// Nested under a subdirectory to exercise the recursive walk. Shares one content
// word out of four tokens, so min(1/4 * 10, 5) = 2.5.
const NESTED = `---
title: Nested Related
---

machine zebra giraffe antelope
`;

// Holds only stop words that also appear in the source. With the filter intact
// every token is dropped, so the shared count is zero and this file must NOT be
// reported as related. If RELATED_STOP_WORDS were emptied or lost any of these
// words, the overlap would surface this file and the assertion would fail.
const STOPWORDS_ONLY = `---
title: Stop Words Only
---

this that with from will have been were
`;

// Shares neither tags nor content words with the source.
const UNRELATED = `---
title: Unrelated
---

elephant ostrich walrus dolphin
`;

const FIXTURE = {
  'content/source.md': SOURCE,
  'content/related-content.md': RELATED_CONTENT,
  'content/related-tags.md': RELATED_TAGS,
  'content/sub/nested.md': NESTED,
  'content/stopwords-only.md': STOPWORDS_ONLY,
  'content/unrelated.md': UNRELATED,
};

describe('GET /api/file/related (RELATED_STOP_WORDS hoisted to module scope)', () => {
  it('ranks related files by tag and content overlap', async () => {
    const res = await getRelated(makeFs(FIXTURE), 'content/source.md');
    assert.equal(res.status, 200);

    // Descending score: tags (10) > content (5) > nested single-word (2.5).
    // The source file itself, the stop-word-only file, and the unrelated file
    // all fall below the > 0.5 threshold and are absent.
    assert.deepEqual(res.body.related, [
      { path: 'content/related-tags.md', title: 'Related By Tags', score: 10 },
      { path: 'content/related-content.md', title: 'Related By Content', score: 5 },
      { path: 'content/sub/nested.md', title: 'Nested Related', score: 2.5 },
    ]);
  });

  it('does not surface the source, stop-word-only, or unrelated files', async () => {
    const res = await getRelated(makeFs(FIXTURE), 'content/source.md');
    const paths = res.body.related.map(r => r.path);
    assert.ok(!paths.includes('content/source.md'), 'the queried file excludes itself');
    assert.ok(!paths.includes('content/stopwords-only.md'), 'stop-word-only overlap is filtered out');
    assert.ok(!paths.includes('content/unrelated.md'), 'a file with no overlap is omitted');
  });

  it('filters stop words so shared stop words alone never count as related', async () => {
    // Only two files: the source and a candidate built purely from stop words
    // the source also contains. With the filter live, nothing overlaps and the
    // related list is empty.
    const fs = makeFs({
      'content/src.md': `---\ntitle: Src\n---\n\nmachine learning this that with from will have been were\n`,
      'content/only-stops.md': `---\ntitle: Only Stops\n---\n\nthis that with from will have been were\n`,
    });
    const res = await getRelated(fs, 'content/src.md');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.related, []);
  });

  it('returns 400 for an invalid path', async () => {
    const res = await getRelated(makeFs({}), '../etc/passwd', () => false);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path' });
  });

  it('returns 404 when the source file cannot be read', async () => {
    const res = await getRelated(makeFs({}), 'content/missing.md');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'File not found' });
  });
});
