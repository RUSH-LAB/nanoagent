import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

// research-tools.js is CommonJS; load it the way the other server route tests do.
// The default export is the async dispatcher research_tools_routes(req,res,url,pathname,ctx).
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

const ROOT = '/virtual';

// A tiny in-memory filesystem over a nested literal: a string value is a file's
// content, an object value is a directory. It serves the three calls the
// /api/search/replace walk makes (readdirSync withFileTypes, readFileSync, and,
// on a real run, writeFileSync) and records every write so a dry run can be
// proven side effect free and a real run's bytes inspected.
function makeFs(tree) {
  const writes = [];
  // Walk ROOT-relative path segments to the node they name; undefined if missing.
  function resolve(absPath) {
    const rel = nodePath.relative(ROOT, absPath);
    const parts = rel === '' ? [] : rel.split(nodePath.sep);
    let node = tree;
    for (const part of parts) {
      if (node === null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }
  const fs = {
    readdirSync(dir, opts) {
      const node = resolve(dir);
      if (node === null || typeof node !== 'object') {
        throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
      }
      const names = Object.keys(node);
      if (opts && opts.withFileTypes) {
        return names.map(name => ({
          name,
          isDirectory: () => node[name] !== null && typeof node[name] === 'object',
        }));
      }
      return names;
    },
    readFileSync(file) {
      const node = resolve(file);
      if (typeof node !== 'string') {
        throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      }
      return node;
    },
    writeFileSync(file, content) {
      const rel = nodePath.relative(ROOT, file);
      const parts = rel.split(nodePath.sep);
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
      node[parts[parts.length - 1]] = content;
      writes.push({ path: rel, content });
    },
  };
  return { fs, writes };
}

// Invoke the real POST /api/search/replace handler with a stubbed ctx and capture
// the json() response plus the list of writes the walk performed.
async function callReplace(tree, { search, replace, dryRun }) {
  const { fs, writes } = makeFs(tree);
  let captured = null;
  const ctx = {
    fs,
    path: nodePath,
    PROJECT_ROOT: ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    MAX_TEXT_LENGTH: 1_000_000,
    rateLimit: () => true,
    invalidateCache: () => {},
    readBody: async () => ({ search, replace, dryRun }),
    json(res, status, body) {
      captured = { status, body };
      res.writableEnded = true;
      return res;
    },
  };
  const pathname = '/api/search/replace';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await researchToolsRoutes(req, res, url, pathname, ctx);
  return { ...captured, writes };
}

// changes[] -> { relPath: occurrences } for order-independent comparison.
function byPath(changes) {
  return Object.fromEntries(changes.map(c => [c.path, c.occurrences]));
}

// The pre-change handler computed the replacement as content.split(search).join(replace).
// Re-derive it here, independently of the route, so a real run's written bytes can be
// proven identical to that old two-split form.
function oldReplacement(content, search, replace) {
  return content.split(search).join(replace);
}

// One literal fixture, kept as named constants so the same original content drives
// both the tree under test and the independently computed expectations. 'foo' counts
// are noted inline; the replacement is longer than the needle so byte-identity is
// a real check, not a length coincidence.
const A = 'foo bar foo';                 // foo x2
const B = 'baz foo qux';                 // foo x1
const NONE = 'nothing here to match';    // foo x0 -> skipped
const C = 'foo\nfoo\nfoo';               // foo x3
const SEARCH = 'foo';
const REPLACE = 'REPLACED';

const originalByPath = {
  'content/a.md': A,
  'content/b.mdx': B,
  'content/sub/c.md': C,
};
const expectedOccurrences = {
  'content/a.md': 2,
  'content/b.mdx': 1,
  'content/sub/c.md': 3,
};
const expectedTotal = 2 + 1 + 3; // 6

function freshTree() {
  return { content: { 'a.md': A, 'b.mdx': B, 'none.md': NONE, sub: { 'c.md': C } } };
}

describe('POST /api/search/replace splits each file once', () => {
  it('dry run reports the correct occurrences and writes nothing', async () => {
    const { status, body, writes } = await callReplace(freshTree(), {
      search: SEARCH,
      replace: REPLACE,
      dryRun: true,
    });

    assert.equal(status, 200);
    // Response shape is byte-for-byte the pre-change contract: same keys, same order.
    assert.deepEqual(Object.keys(body), ['dryRun', 'filesChanged', 'totalOccurrences', 'changes']);
    assert.equal(body.dryRun, true);
    for (const c of body.changes) {
      assert.deepEqual(Object.keys(c), ['path', 'occurrences']);
      assert.ok(c.occurrences > 0, 'only matching files are reported');
    }
    // The no-match file is skipped; the matching files carry their exact counts.
    assert.deepEqual(byPath(body.changes), expectedOccurrences);
    assert.ok(!('content/none.md' in byPath(body.changes)), 'no-match file is excluded');
    assert.equal(body.filesChanged, 3);
    assert.equal(body.totalOccurrences, expectedTotal);
    // A dry run reports counts without touching any file.
    assert.equal(writes.length, 0, 'dry run performs no writes');
  });

  it('real run replaces, reports the same occurrences, and writes byte-identical content', async () => {
    // Same fixture, run for real. Compare against the dry run to prove counting and
    // replacing share one split: occurrences must match exactly, file for file.
    const dry = await callReplace(freshTree(), { search: SEARCH, replace: REPLACE, dryRun: true });
    const { status, body, writes } = await callReplace(freshTree(), {
      search: SEARCH,
      replace: REPLACE,
      dryRun: false,
    });

    assert.equal(status, 200);
    assert.equal(body.dryRun, false);
    assert.deepEqual(Object.keys(body), ['dryRun', 'filesChanged', 'totalOccurrences', 'changes']);
    // The real run's per-file occurrences equal the dry run's exactly.
    assert.deepEqual(byPath(body.changes), byPath(dry.body.changes));
    assert.deepEqual(byPath(body.changes), expectedOccurrences);
    assert.equal(body.filesChanged, 3);
    assert.equal(body.totalOccurrences, expectedTotal);

    // One write per reported change; the no-match file is never written.
    assert.equal(writes.length, body.filesChanged);
    assert.ok(!writes.some(w => w.path.endsWith('none.md')), 'no-match file is not written');

    // Every write is byte-identical to the old content.split(search).join(replace).
    for (const w of writes) {
      const expected = oldReplacement(originalByPath[w.path], SEARCH, REPLACE);
      assert.equal(w.content, expected, `byte-identical replacement for ${w.path}`);
      assert.equal(w.content.split(SEARCH).length - 1, 0, 'no needle survives the replacement');
      assert.ok(w.content.includes(REPLACE), 'the replacement landed');
    }
    // The set of written paths is exactly the matching files.
    assert.deepEqual(
      writes.map(w => w.path).sort(),
      Object.keys(originalByPath).sort(),
    );
  });

  it('source caches the split once into const parts and drops the old second split', () => {
    // Mirror verify.sh: the single cached split is present and the old chained second
    // split is gone, so the byte-identity proven above cannot silently regress.
    const src = readFileSync(new URL('../server/routes/research-tools.js', import.meta.url), 'utf8');
    assert.ok(
      src.includes('const parts = content.split(search)'),
      'split is cached once into const parts',
    );
    assert.ok(
      !src.includes('content.split(search).join(replace)'),
      'old content.split(search).join(replace) second split is removed',
    );
  });
});
