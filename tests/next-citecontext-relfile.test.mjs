import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// In-memory fs stub built from a `${rel-from-PROJECT_ROOT}: content` map. Only the
// calls the context handler makes are implemented: readdirSync with withFileTypes
// (for the recursive scanContexts walk) and readFileSync. It is intentionally
// stat-less, so loadReferencesCached skips its memo and re-reads references.yaml
// from this fixture on every call, keeping each test independent of the others.
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

// Pass-through cached(key, ttl, fn): runs the producer and memoizes by key so a
// repeat call returns the stored array by reference, mirroring the production
// helper. A fresh instance per test resets the per-key scan cache.
function makeCached() {
  const store = new Map();
  const cached = (key, _ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const value = fn();
    store.set(key, value);
    return value;
  };
  return { cached };
}

// Drive GET /api/references/context once against the supplied fs + cached stubs.
async function getContext(fs, cached, key) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const qs = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
  const url = new URL(`http://localhost/api/references/context${qs}`);
  await studyKnowledgeRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/context', ctx);
  return captured;
}

// `content/intro.md` cites the same key twice on one line, so the inner
// `while` loop runs more than once for that single file: this is what exercises
// the hoisted `relFile` (computed once per file, reused for every match).
// `content/sub/deep.md` lives one directory deeper and cites the key once, so the
// expected `file` differs per file and the recursive walk is covered. Each body is
// a single short line, so every citation's 100-char window spans the whole file:
// the context is the trimmed line verbatim with neither leading nor trailing
// ellipsis. notes.txt is filtered by extension and never read.
const FIXTURE = {
  'content/intro.md': 'Start [@smith2020] mid [@smith2020] end.',
  'content/sub/deep.md': 'Nested [@smith2020] once.',
  'content/notes.txt': 'Ignore [@smith2020] in plain text.',
  'bibliography/references.yaml': 'smith2020:\n  title: A Study\n',
};

// Citations follow the content/ walk order (intro.md first, then nested
// sub/deep.md). intro.md yields two entries that share one relative file path;
// position is the byte index of each match.
const EXPECTED = {
  key: 'smith2020',
  title: 'A Study',
  contexts: [
    { file: 'content/intro.md', context: 'Start [@smith2020] mid [@smith2020] end.', position: 6 },
    { file: 'content/intro.md', context: 'Start [@smith2020] mid [@smith2020] end.', position: 23 },
    { file: 'content/sub/deep.md', context: 'Nested [@smith2020] once.', position: 7 },
  ],
  totalCitations: 3,
};

describe('GET /api/references/context (relFile hoisted out of the match loop)', () => {
  it('carries the relative file path and slice for every match, multiple matches per file included', async () => {
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getContext(fs, cached, 'smith2020');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED);
    // Field order is part of the contract; pin it explicitly.
    assert.deepEqual(Object.keys(res.payload), ['key', 'title', 'contexts', 'totalCitations']);
  });

  it('gives both matches in one file the identical relative file path', async () => {
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getContext(fs, cached, 'smith2020');
    const [first, second, nested] = res.payload.contexts;
    // The two matches from intro.md must report the same hoisted relFile value.
    assert.equal(first.file, 'content/intro.md');
    assert.equal(second.file, first.file);
    // A file in a deeper directory gets its own relative path, proving relFile is
    // recomputed per file rather than shared across the whole scan.
    assert.equal(nested.file, 'content/sub/deep.md');
  });

  it('reports every file path relative to PROJECT_ROOT, never absolute', async () => {
    const fs = makeFs(FIXTURE);
    const { cached } = makeCached();
    const res = await getContext(fs, cached, 'smith2020');
    for (const c of res.payload.contexts) {
      assert.ok(!c.file.startsWith('/'), `expected a relative path, got ${c.file}`);
      assert.ok(!c.file.startsWith(PROJECT_ROOT), `path leaks PROJECT_ROOT: ${c.file}`);
    }
  });
});
