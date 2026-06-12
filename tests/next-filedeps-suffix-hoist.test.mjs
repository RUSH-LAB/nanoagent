import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// file-tools.js is CommonJS; load it the way the sibling route tests do
// (next-filedeps-hoist-regexes.test.mjs, next-filedeps-cache.test.mjs) and reuse
// the same in-memory-fs ctx-mocking shape. These tests drive the REAL GET
// /api/file/dependencies handler over a virtual content tree, with no server.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_TOOLS_PATH = path.join(__dirname, '..', 'server', 'routes', 'file-tools.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// ── Why this hoist is behavior-preserving ───────────────────────────────────
// In the GET /api/file/dependencies scanIncoming walk, `baseName` is a const
// derived from the validated filePath and never reassigned, so the suffix
// `'/' + baseName` is invariant across the whole walk; hoisting it once into
// `baseSuffix` yields the identical string on every WIKI_RE match. And
// `m[1].trim()` is pure, so reading it once into `target` and reusing it for
// both the equality and the suffix test returns the same booleans the old
// double-trim did. The fixture below exercises an exact `[[baseName]]` match, a
// `[[dir/baseName]]` suffix match, a plain non-match, and a substring trap
// (`[[supergraph-theory]]`) that ends with the literal base name but NOT with
// `'/' + baseName`, proving the leading slash in baseSuffix is what excludes it.

// In-memory fs stub built from a map of `${rel from PROJECT_ROOT}: content`,
// matching next-filedeps-hoist-regexes.test.mjs. The dependencies handler only
// touches readFileSync (the source file) and readdirSync (the recursive content
// walk that finds incoming links). Map preserves insertion order, so directory
// listings (and thus the incoming order) are deterministic.
function makeFs(fileMap) {
  const dirs = new Map();          // absDir -> Map<name, isDir>
  const fileContents = new Map();  // absFile -> content
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

// Drive GET /api/file/dependencies with a mocked ctx and capture the json()
// response. cached() is a pass-through so the full handler body runs every call.
async function getDependencies(fs, filePath, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    isValidFilePath,
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/file/dependencies?path=${encodeURIComponent(filePath)}`);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/dependencies', ctx);
  return captured;
}

// The source file (baseName "graph-theory") has no outgoing links of its own, so
// the test focuses purely on the incoming-link matching the hoist touches.
const SOURCE = `---
title: Graph Theory
---

A standalone source page with no outgoing wiki links of its own.
`;

// Exact match: [[graph-theory]] equals baseName, so target === baseName.
const EXACT_REF = `---
title: Exact Ref
---

This links to [[graph-theory]] by its exact base name.
`;

// Suffix match: [[notes/graph-theory]] ends with '/' + baseName, so it matches
// via target.endsWith(baseSuffix) even though it is not an exact equal.
const SUFFIX_REF = `---
title: Suffix Ref
---

This links to [[notes/graph-theory]] using a directory-qualified name.
`;

// Non-match (different page): never references the source file at all.
const NO_REF = `---
title: No Ref
---

This only points to [[other-page]], never back to the source file.
`;

// Non-match (substring trap): [[supergraph-theory]] ends with the literal
// "graph-theory" but NOT with "/graph-theory", and is not an exact equal, so the
// leading slash carried by baseSuffix is exactly what keeps it out of incoming.
const SUBSTRING_TRAP = `---
title: Substring Trap
---

This links to [[supergraph-theory]], a separate page whose name merely ends with
the source's base name.
`;

// Nested exact match, to exercise the recursive scanIncoming walk and confirm the
// reported source is the nested relative path.
const NESTED_REF = `---
title: Nested Ref
---

Deep in a subfolder, this links to [[graph-theory]] too.
`;

// Insertion order fixes the directory walk order: graph-theory (skipped as self),
// exact-ref (match), suffix-ref (match), no-ref (no match), substring-trap (no
// match), then sub/ recursed last (nested match).
const FIXTURE = {
  'content/graph-theory.md': SOURCE,
  'content/exact-ref.md': EXACT_REF,
  'content/suffix-ref.md': SUFFIX_REF,
  'content/no-ref.md': NO_REF,
  'content/substring-trap.md': SUBSTRING_TRAP,
  'content/sub/nested-ref.md': NESTED_REF,
};

// Independent reference, hand-derived from the fixture and the matching rule
// (NOT a re-run of the handler). It is identical to what the handler produced
// before this hoist, so deep-equality against it pins byte-identical behavior.
const EXPECTED_INCOMING = [
  { type: 'wiki', source: 'content/exact-ref.md' },
  { type: 'wiki', source: 'content/suffix-ref.md' },
  { type: 'wiki', source: 'content/sub/nested-ref.md' },
];

describe('GET /api/file/dependencies (baseSuffix hoisted, m[1].trim() deduped into target)', () => {
  it('returns incoming sources deep-equal to the pre-change behavior', async () => {
    const res = await getDependencies(makeFs(FIXTURE), 'content/graph-theory.md');
    assert.equal(res.status, 200);
    assert.equal(res.body.path, 'content/graph-theory.md');
    // The source has no links of its own, so outgoing stays empty.
    assert.deepEqual(res.body.outgoing, []);
    assert.equal(res.body.outgoingCount, 0);
    // Exact, suffix, and nested-exact matches in walk order; non-matches excluded.
    assert.deepEqual(res.body.incoming, EXPECTED_INCOMING);
    assert.equal(res.body.incomingCount, EXPECTED_INCOMING.length);
  });

  it('matches exact and "/"-suffix links but excludes plain and substring non-matches', async () => {
    const res = await getDependencies(makeFs(FIXTURE), 'content/graph-theory.md');
    const sources = res.body.incoming.map(i => i.source);
    // Exact and directory-qualified suffix both resolve.
    assert.ok(sources.includes('content/exact-ref.md'), 'exact [[graph-theory]] resolves');
    assert.ok(sources.includes('content/suffix-ref.md'), '[[notes/graph-theory]] suffix resolves');
    assert.ok(sources.includes('content/sub/nested-ref.md'), 'nested exact match resolves');
    // The plain non-match and the substring trap stay out: the latter proves the
    // leading slash in baseSuffix matters ("supergraph-theory" must not match).
    assert.ok(!sources.includes('content/no-ref.md'), '[[other-page]] is not incoming');
    assert.ok(!sources.includes('content/substring-trap.md'), '[[supergraph-theory]] is not incoming');
  });

  it('returns identical results on a second back-to-back request (no stale lastIndex leakage)', async () => {
    const fs = makeFs(FIXTURE);
    const first = await getDependencies(fs, 'content/graph-theory.md');
    const second = await getDependencies(fs, 'content/graph-theory.md');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.incoming, EXPECTED_INCOMING);
    assert.deepEqual(second.body.incoming, first.body.incoming);
    assert.deepEqual(second.body.outgoing, first.body.outgoing);
  });
});

describe('file-tools.js source: the dependencies handler hoists baseSuffix and dedups the trim', () => {
  it('hoists const baseSuffix once, reads m[1].trim() once into target, and drops the old inline guard', () => {
    const src = readFileSync(FILE_TOOLS_PATH, 'utf8');
    // Slice just the GET /api/file/dependencies handler block: from its pathname
    // guard up to the next handler (GET /api/file/summary). Both markers are ASCII.
    const start = src.indexOf("pathname === '/api/file/dependencies'");
    assert.ok(start !== -1, 'dependencies handler not found in source');
    const end = src.indexOf("pathname === '/api/file/summary'", start);
    assert.ok(end !== -1, 'summary handler (block end marker) not found in source');
    const block = src.slice(start, end);

    // The invariant suffix is concatenated exactly once, above the walk.
    assert.ok(
      block.includes("const baseSuffix = '/' + baseName"),
      "expected the hoisted \"const baseSuffix = '/' + baseName\"",
    );
    // The per-match value is trimmed exactly once into target.
    assert.ok(
      block.includes('const target = m[1].trim()'),
      "expected the deduped \"const target = m[1].trim()\"",
    );
    // The incoming guard reads the hoisted/deduped values.
    assert.ok(
      block.includes('target === baseName || target.endsWith(baseSuffix)'),
      'expected the guard to read "target === baseName || target.endsWith(baseSuffix)"',
    );
    // The old inline double-trim guard with the inline concat is gone.
    assert.ok(
      !block.includes('m[1].trim() === baseName'),
      'old "m[1].trim() === baseName" inline guard must be gone',
    );
    assert.ok(
      !block.includes("endsWith('/' + baseName)"),
      "old inline \"endsWith('/' + baseName)\" must be gone",
    );
  });
});
