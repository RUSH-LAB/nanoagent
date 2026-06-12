import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
// proven side effect free.
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

// Re-derive the total the way the pre-fold handler did: a second pass that reduces
// the built `changes`. The live handler now accumulates the same sum during the
// walk, so matching this proves the fold stays identical to the old reduce.
function oldTotal(changes) {
  return changes.reduce((s, c) => s + c.occurrences, 0);
}

// changes[] -> { relPath: occurrences } for order-independent comparison.
function byPath(changes) {
  return Object.fromEntries(changes.map(c => [c.path, c.occurrences]));
}

describe('POST /api/search/replace total fold', () => {
  it('folds totalOccurrences in one pass over a representative multi-file tree (dry run)', async () => {
    // 'foo' counts per file are noted inline. Files with zero matches, the wrong
    // extension, or a dot/underscore name must not appear in `changes`.
    const tree = {
      content: {
        'a.md': 'alpha foo beta foo gamma',          // foo x2
        'b.mdx': 'foo at the start, foo at the end',  // foo x2
        'c.md': 'no occurrences in this file at all', // foo x0 -> excluded
        posts: {
          'd.md': 'foo foo foo',                      // foo x3
          'e.mdx': 'just one foo here',               // foo x1
          'f.txt': 'foo foo foo foo',                 // .txt -> skipped (ext)
          '_draft.md': 'foo foo foo foo foo',         // underscore -> skipped
        },
        '.git-notes.md': 'foo foo',                   // dotfile -> skipped
        nested: { deep: { 'g.md': 'deep foo, deep foo, deep foo, deep foo' } }, // foo x4
      },
    };
    const expected = {
      'content/a.md': 2,
      'content/b.mdx': 2,
      'content/posts/d.md': 3,
      'content/posts/e.mdx': 1,
      'content/nested/deep/g.md': 4,
    };
    const expectedTotal = 2 + 2 + 3 + 1 + 4; // 12

    const { status, body, writes } = await callReplace(tree, {
      search: 'foo',
      replace: 'REPLACED',
      dryRun: true,
    });

    assert.equal(status, 200);
    // Pin the exact response shape and key order so the fold cannot drift it.
    assert.deepEqual(Object.keys(body), ['dryRun', 'filesChanged', 'totalOccurrences', 'changes']);
    assert.equal(body.dryRun, true);
    // Each change keeps exactly the {path, occurrences} contract, all positive.
    for (const c of body.changes) {
      assert.deepEqual(Object.keys(c), ['path', 'occurrences']);
      assert.ok(c.occurrences > 0, 'only matching files are reported');
    }
    // The skipped and zero-match files are excluded; the rest carry their counts.
    assert.deepEqual(byPath(body.changes), expected);
    assert.equal(body.filesChanged, body.changes.length);
    assert.equal(body.filesChanged, 5);
    // The headline invariant: the folded total equals both the literal sum and an
    // independent reduce over the built `changes`.
    assert.equal(body.totalOccurrences, expectedTotal);
    assert.equal(body.totalOccurrences, oldTotal(body.changes));
    // A dry run reports counts without touching any file.
    assert.equal(writes.length, 0, 'dry run performs no writes');
  });

  it('keeps the invariant for an empty result (0 === sum of [])', async () => {
    const tree = { content: { 'a.md': 'nothing to match', sub: { 'b.mdx': 'still nothing' } } };
    const { status, body, writes } = await callReplace(tree, {
      search: 'absent-needle',
      replace: 'x',
      dryRun: true,
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { dryRun: true, filesChanged: 0, totalOccurrences: 0, changes: [] });
    assert.equal(body.totalOccurrences, oldTotal(body.changes));
    assert.equal(writes.length, 0);
  });

  it('the folded total equals an independent reduce regardless of traversal order', async () => {
    // Many files spread across nested directories, each with a distinct count, so
    // the accumulation order varies. The fold must still match the reduce exactly.
    const content = {};
    let expectedSum = 0;
    let expectedFiles = 0;
    for (let i = 0; i < 15; i++) {
      const count = (i % 4) + 1; // 1..4 occurrences
      expectedSum += count;
      expectedFiles += 1;
      const body = Array.from({ length: count }, () => 'foo').join(' and ');
      // Alternate between the top level and a per-index subdirectory.
      if (i % 2 === 0) {
        content[`file-${String(i).padStart(2, '0')}.md`] = body;
      } else {
        content[`dir-${String(i).padStart(2, '0')}`] = {
          [`file-${String(i).padStart(2, '0')}.mdx`]: body,
        };
      }
    }
    const { status, body } = await callReplace({ content }, {
      search: 'foo',
      replace: 'bar',
      dryRun: true,
    });
    assert.equal(status, 200);
    assert.equal(body.filesChanged, expectedFiles);
    assert.equal(body.totalOccurrences, expectedSum);
    assert.equal(body.totalOccurrences, oldTotal(body.changes));
  });

  it('preserves the total and shape on a real run and writes each matching file', async () => {
    // Same matching layout as the dry-run case, on a fresh tree (writes mutate it).
    const tree = {
      content: {
        'a.md': 'alpha foo beta foo gamma',          // foo x2
        'c.md': 'no occurrences in this file at all', // foo x0 -> excluded
        posts: { 'd.md': 'foo foo foo' },             // foo x3
      },
    };
    const { status, body, writes } = await callReplace(tree, {
      search: 'foo',
      replace: 'BAR',
      dryRun: false,
    });
    assert.equal(status, 200);
    assert.equal(body.dryRun, false);
    assert.equal(body.filesChanged, 2);
    assert.equal(body.totalOccurrences, 5);
    assert.equal(body.totalOccurrences, oldTotal(body.changes));
    // One write per reported change, and no 'foo' survives in any written file.
    assert.equal(writes.length, body.filesChanged);
    for (const w of writes) {
      assert.equal(w.content.split('foo').length - 1, 0, 'every occurrence was replaced');
      assert.ok(w.content.includes('BAR'), 'the replacement landed');
    }
  });
});
