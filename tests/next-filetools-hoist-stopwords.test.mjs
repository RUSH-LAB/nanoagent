import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// The two handlers under test touch readFileSync (the source file plus, for
// suggest-tags, the existing-tag scan) and readdirSync (the recursive content
// walk with {withFileTypes:true}); the stub ignores the encoding or options arg.
function makeFs(fileMap) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

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

// Invoke a file-tools route handler with a mocked ctx and capture the response
// handed to `json(res, status, payload)`. isValidFilePath defaults to accepting
// any path so the tests focus on the handler body.
async function invoke({ pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    path,
    PROJECT_ROOT,
    isValidFilePath: () => true,
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await fileToolsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

const q = p => `?path=${encodeURIComponent(p)}`;

describe('GET /api/file/keywords (KEYWORDS_STOP_WORDS hoisted to module scope)', () => {
  // The body repeats three content words at distinct counts and seeds two stop
  // words, "because" (length 7) and "should" (length 6). Both clear the
  // length > 2 filter, so only KEYWORDS_STOP_WORDS can remove them: if the
  // hoisted set were lost or altered they would survive and the keyword table
  // and totalWords below would change. The set is read only, so the output is
  // identical to the pre-hoist per-request build.
  const FIXTURE = {
    'content/doc.md': '---\ntitle: Doc\n---\nnetworks networks networks machine machine learning because should neural\n',
  };
  const ctx = { fs: makeFs(FIXTURE), PROJECT_ROOT, path };

  it('extracts keyword counts with stop words filtered out', async () => {
    const r = await invoke({ pathname: '/api/file/keywords', search: q('content/doc.md'), ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      keywords: [
        { word: 'networks', count: 3 },
        { word: 'machine', count: 2 },
        { word: 'learning', count: 1 },
        { word: 'neural', count: 1 },
      ],
      totalWords: 7,
    });
  });

  it('excludes a known stop word from the keyword output', async () => {
    const r = await invoke({ pathname: '/api/file/keywords', search: q('content/doc.md'), ctx });
    const words = r.payload.keywords.map(k => k.word);
    assert.ok(!words.includes('because'), '"because" is a stop word and must be dropped');
    assert.ok(!words.includes('should'), '"should" is a stop word and must be dropped');
  });

  it('rejects an invalid path with 400', async () => {
    const r = await invoke({
      pathname: '/api/file/keywords',
      search: q('../etc/passwd'),
      ctx: { ...ctx, isValidFilePath: () => false },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid path' });
  });

  it('returns 404 when the file cannot be read', async () => {
    const r = await invoke({ pathname: '/api/file/keywords', search: q('content/missing.md'), ctx });
    assert.equal(r.status, 404);
    assert.deepEqual(r.payload, { error: 'File not found' });
  });
});

describe('GET /api/file/suggest-tags (SUGGEST_TAGS_STOP_WORDS hoisted to module scope)', () => {
  // The body repeats three content words at distinct counts and seeds two stop
  // words, "should" (length 6) and "other" (length 5). Both clear the
  // length > 3 filter, so only SUGGEST_TAGS_STOP_WORDS can remove them: were the
  // hoisted set lost or altered they would survive and leak into topKeywords.
  // The frontmatter tags drive the suggestion confidences off the same
  // stop-filtered frequency map, so the whole response pins the set as live.
  const FIXTURE = {
    'content/source.md': '---\ntitle: Source\ntags: [neural, networks]\n---\nneural neural neural networks networks machine should should other other other\n',
  };
  // `cached(key, ttl, fn)` runs the tag scan once per request in production; the
  // stub just invokes it so the existing-tag walk runs against the fixture.
  const ctx = {
    fs: makeFs(FIXTURE), PROJECT_ROOT, path, ALLOWED_EXTS,
    cached: (_key, _ttl, fn) => fn(),
  };

  it('ranks top keywords with stop words filtered out', async () => {
    const r = await invoke({ pathname: '/api/file/suggest-tags', search: q('content/source.md'), ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      suggestions: [
        { tag: 'neural', confidence: 0.6 },
        { tag: 'networks', confidence: 0.4 },
      ],
      topKeywords: ['neural', 'networks', 'machine'],
    });
  });

  it('excludes a known stop word from the top keywords', async () => {
    const r = await invoke({ pathname: '/api/file/suggest-tags', search: q('content/source.md'), ctx });
    assert.ok(!r.payload.topKeywords.includes('should'), '"should" is a stop word and must be dropped');
    assert.ok(!r.payload.topKeywords.includes('other'), '"other" is a stop word and must be dropped');
  });

  it('rejects an invalid path with 400', async () => {
    const r = await invoke({
      pathname: '/api/file/suggest-tags',
      search: q('../secret'),
      ctx: { ...ctx, isValidFilePath: () => false },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid path' });
  });

  it('returns 404 when the file cannot be read', async () => {
    const r = await invoke({ pathname: '/api/file/suggest-tags', search: q('content/missing.md'), ctx });
    assert.equal(r.status, 404);
    assert.deepEqual(r.payload, { error: 'File not found' });
  });
});
