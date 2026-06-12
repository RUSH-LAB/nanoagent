import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');
const yaml = require('js-yaml');
// loadReferencesCached memoizes in a module-level singleton on references.js;
// clear it between scenarios so each case re-stats and re-reads deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/proj';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const ALLOWED_EXTS = ['.md', '.mdx'];

// Bibliography fixture shared by both handlers. smith2020 and jones2021 overlap
// on one author (Carol White), the same venue (NeurIPS), and two title words
// (study, caching) so the compare handler produces a non-trivial payload.
const REFS_YAML = `smith2020:
  title: A Study of Caching
  author:
    - Alice Smith
    - Carol White
  year: 2020
  venue: NeurIPS
jones2021:
  title: Another Study of Caching
  author:
    - Bob Jones
    - Carol White
  year: 2021
  venue: NeurIPS
`;

// Content fixture for the context scan. Each body is one short line, so every
// citation's 100-char window spans the whole file and the context is the trimmed
// line verbatim with neither a leading nor a trailing ellipsis. other.md cites
// only jones2021, proving the per-key CITE_PATTERN filters by key.
const CONTENT_FILES = {
  'content/intro.md': 'See [@smith2020] for details.',
  'content/sub/methods.md': 'Built on [@smith2020] and [@jones2021].',
  'content/other.md': 'Only [@jones2021] here.',
};

// A counting in-memory fs. references.yaml is served from `refsYaml` with a stable
// statSync (mtimeMs + size) so the loadReferencesCached memo path is exercised the
// way the live server hits it; content files come from CONTENT_FILES. `refReads`
// counts references.yaml reads specifically so the memo can be asserted, separate
// from the content-file reads counted by `readFileSync`.
function makeFs(refsYaml, contentMap = {}) {
  const dirs = new Map(); // absDir -> Map<name, isDir>
  const fileContents = new Map(); // absFile -> content
  const ensureDir = absDir => { if (!dirs.has(absDir)) dirs.set(absDir, new Map()); };

  for (const [rel, content] of Object.entries(contentMap)) {
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

  const counts = { readdirSync: 0, readFileSync: 0, statSync: 0, refReads: 0 };
  return {
    counts,
    statSync(fp) {
      counts.statSync++;
      if (fp === REFS_PATH) return { mtimeMs: 1, size: refsYaml.length };
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    readdirSync(dir) {
      counts.readdirSync++;
      const entries = dirs.get(dir);
      if (!entries) { const e = new Error(`ENOENT: ${dir}`); e.code = 'ENOENT'; throw e; }
      return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
    },
    readFileSync(fp) {
      counts.readFileSync++;
      if (fp === REFS_PATH) { counts.refReads++; return refsYaml; }
      if (fileContents.has(fp)) return fileContents.get(fp);
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
}

// An fs whose references.yaml is missing: statSync and readFileSync both ENOENT.
function missingRefsFs() {
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  return { statSync: enoent, readdirSync: enoent, readFileSync: enoent };
}

// A memoizing cached(key, ttl, fn) stub: a hit returns the stored value by
// reference (like the production helper) so the context scan runs at most once.
function makeCached() {
  const store = new Map();
  const cached = (key, ttl, fn) => {
    if (store.has(key)) return store.get(key);
    const value = fn();
    store.set(key, value);
    return value;
  };
  return { cached, store };
}

// Drive GET /api/references/context once against the supplied stubs.
async function getContext(fs, cached, key) {
  let captured = null;
  const ctx = {
    path, PROJECT_ROOT, ALLOWED_EXTS, fs, cached,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const qs = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
  const url = new URL(`http://localhost/api/references/context${qs}`);
  await studyKnowledgeRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/context', ctx);
  return captured;
}

// Drive GET /api/references/compare once against the supplied fs.
async function getCompare(fs, key1, key2) {
  let captured = null;
  const ctx = {
    path, PROJECT_ROOT, fs,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const params = new URLSearchParams();
  if (key1 !== undefined) params.set('key1', key1);
  if (key2 !== undefined) params.set('key2', key2);
  const search = params.toString() ? `?${params}` : '';
  const url = new URL(`http://localhost/api/references/compare${search}`);
  await studyKnowledgeRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/compare', ctx);
  return captured;
}

// Walk order follows the dir Map insertion order (intro.md, then nested
// sub/methods.md, then other.md). position is the byte index of the [@key] match.
const EXPECTED_CONTEXT_SMITH = {
  key: 'smith2020',
  title: 'A Study of Caching',
  contexts: [
    { file: 'content/intro.md', context: 'See [@smith2020] for details.', position: 4 },
    { file: 'content/sub/methods.md', context: 'Built on [@smith2020] and [@jones2021].', position: 9 },
  ],
  totalCitations: 2,
};

const EXPECTED_COMPARE = {
  paper1: { key: 'smith2020', title: 'A Study of Caching', year: 2020, venue: 'NeurIPS', authors: ['Alice Smith', 'Carol White'] },
  paper2: { key: 'jones2021', title: 'Another Study of Caching', year: 2021, venue: 'NeurIPS', authors: ['Bob Jones', 'Carol White'] },
  comparison: {
    sharedAuthors: ['carol white'],
    sameVenue: true,
    yearDifference: 1,
    sharedTitleWords: ['study', 'caching'],
  },
};

// The shared memo lives at references.js module scope; start every case clean.
beforeEach(() => _resetReferencesCache());

describe('GET /api/references/context obtains refs via loadReferencesCached', () => {
  it('returns the byte-identical 200 payload (title from the raw yaml.load oracle)', async () => {
    const fs = makeFs(REFS_YAML, CONTENT_FILES);
    const { cached } = makeCached();
    const res = await getContext(fs, cached, 'smith2020');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_CONTEXT_SMITH);
    // Field order is part of the response contract; pin it explicitly.
    assert.deepEqual(Object.keys(res.payload), ['key', 'title', 'contexts', 'totalCitations']);
    // Tie the served title back to a raw parse of the same bytes.
    const oracle = yaml.load(REFS_YAML);
    assert.equal(res.payload.title, oracle.smith2020.title);
  });

  it('returns 400 for a missing key without reading the bibliography', async () => {
    const fs = makeFs(REFS_YAML, CONTENT_FILES);
    const { cached, store } = makeCached();
    const res = await getContext(fs, cached, undefined);
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing key' });
    assert.equal(fs.counts.refReads, 0, 'the 400 path never reads references.yaml');
    assert.equal(fs.counts.readdirSync, 0, 'the 400 path never scans');
    assert.equal(store.size, 0, 'the 400 path is never cached');
  });

  it('returns 404 for an unknown key and never scans the content tree', async () => {
    const fs = makeFs(REFS_YAML, CONTENT_FILES);
    const { cached, store } = makeCached();
    const res = await getContext(fs, cached, 'doesNotExist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'Reference not found' });
    assert.equal(fs.counts.readdirSync, 0, 'the 404 path never scans');
    assert.equal(store.size, 0, 'the 404 path is never cached');
  });

  it('preserves the 500 fallback on a broken parse', async () => {
    const fs = makeFs('{ unclosed', CONTENT_FILES);
    const { cached } = makeCached();
    const res = await getContext(fs, cached, 'smith2020');
    assert.equal(res.status, 500);
    assert.deepEqual(res.payload, { error: 'Context extraction failed' });
  });

  it('preserves the 500 fallback when references.yaml is missing', async () => {
    const { cached } = makeCached();
    const res = await getContext(missingRefsFs(), cached, 'smith2020');
    assert.equal(res.status, 500);
    assert.deepEqual(res.payload, { error: 'Context extraction failed' });
  });

  it('re-reads a legitimately empty file cleanly and falls through to 404 (not 500)', async () => {
    const fs = makeFs('{}', CONTENT_FILES);
    const { cached } = makeCached();
    const res = await getContext(fs, cached, 'smith2020');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'Reference not found' });
  });
});

describe('GET /api/references/compare obtains refs via loadReferencesCached', () => {
  it('returns the byte-identical 200 payload (papers from the raw yaml.load oracle)', async () => {
    const fs = makeFs(REFS_YAML);
    const res = await getCompare(fs, 'smith2020', 'jones2021');
    assert.equal(res.status, 200);
    assert.deepEqual(res.payload, EXPECTED_COMPARE);
    // Tie the served paper fields back to a raw parse of the same bytes.
    const oracle = yaml.load(REFS_YAML);
    assert.equal(res.payload.paper1.title, oracle.smith2020.title);
    assert.deepEqual(res.payload.paper1.authors, oracle.smith2020.author);
    assert.equal(res.payload.paper2.venue, oracle.jones2021.venue);
  });

  it('returns 400 when a key is missing without reading the bibliography', async () => {
    const fs = makeFs(REFS_YAML);
    const res = await getCompare(fs, 'smith2020', undefined);
    assert.equal(res.status, 400);
    assert.deepEqual(res.payload, { error: 'Missing key1 or key2' });
    assert.equal(fs.counts.refReads, 0, 'the 400 path never reads references.yaml');
  });

  it('returns 404 when a key is unknown', async () => {
    const fs = makeFs(REFS_YAML);
    const res = await getCompare(fs, 'smith2020', 'ghost');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'One or both references not found' });
  });

  it('preserves the 500 fallback on a broken parse', async () => {
    const fs = makeFs('{ unclosed');
    const res = await getCompare(fs, 'smith2020', 'jones2021');
    assert.equal(res.status, 500);
    assert.deepEqual(res.payload, { error: 'Comparison failed' });
  });

  it('preserves the 500 fallback when references.yaml is missing', async () => {
    const res = await getCompare(missingRefsFs(), 'smith2020', 'jones2021');
    assert.equal(res.status, 500);
    assert.deepEqual(res.payload, { error: 'Comparison failed' });
  });

  it('re-reads a legitimately empty file cleanly and falls through to 404 (not 500)', async () => {
    const fs = makeFs('{}');
    const res = await getCompare(fs, 'smith2020', 'jones2021');
    assert.equal(res.status, 404);
    assert.deepEqual(res.payload, { error: 'One or both references not found' });
  });
});

describe('the two handlers share the references.yaml memo', () => {
  it('parses references.yaml exactly once across a context call then a compare call', async () => {
    const fs = makeFs(REFS_YAML, CONTENT_FILES);
    const { cached } = makeCached();

    const ctxRes = await getContext(fs, cached, 'smith2020');
    assert.equal(ctxRes.status, 200);
    assert.equal(fs.counts.refReads, 1, 'the first handler reads references.yaml once');

    const cmpRes = await getCompare(fs, 'smith2020', 'jones2021');
    assert.equal(cmpRes.status, 200);
    // The second handler hits the stable-stat memo and does not re-read the file.
    assert.equal(fs.counts.refReads, 1, 'the second handler reuses the memo, no re-read');
  });
});
