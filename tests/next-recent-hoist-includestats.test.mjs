import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// analysis-admin.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/analysis-admin.js');

// A real temp content tree: two markdown files (one nested in a subdirectory, to
// exercise the recursive walk) plus a non-markdown file that must be ignored.
// Word counts split on /\s+/ across the whole file (frontmatter included), just
// like the handler, so the expected values below are exact.
const FILES = {
  'content/alpha.md': '---\ntitle: Alpha Title\n---\none two three four five\n',
  'content/sub/beta.mdx': '---\ntitle: Beta Title\n---\nalpha beta gamma delta\n',
  'content/notes.txt': 'ignored because the extension is not allowed\n',
};

// Expected stats for the two allowed files: wordCount = whitespace-split tokens
// over the entire file; readingTimeMin = ceil(wordCount / 200); title from the
// frontmatter `title:` line.
const EXPECTED = {
  'content/alpha.md': { wordCount: 10, readingTimeMin: 1, title: 'Alpha Title' },
  'content/sub/beta.mdx': { wordCount: 9, readingTimeMin: 1, title: 'Beta Title' },
};

let ROOT;

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'next-recent-hoist-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
});

after(() => {
  if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true });
});

// Drive GET /api/files/recent against the real temp tree with the real fs/path,
// so the hoisted includeStats flag is exercised end to end through walkRecent.
// Capture the payload handed to json(res, status, payload).
async function getRecent(search = '') {
  const url = new URL(`http://localhost/api/files/recent${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT: ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
    // The handler now wraps its walk in cached(); inject a pass-through so these
    // tests exercise the walk on every call exactly as before (no memoization).
    cached: (_k, _t, fn) => fn(),
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, '/api/files/recent', ctx);
  return captured;
}

// mtime ordering is not asserted here, so look files up by their relative path
// (normalized to forward slashes) rather than relying on array position.
const byPath = (files, rel) =>
  files.find((f) => f.path.split(path.sep).join('/') === rel);

describe('GET /api/files/recent includeStats hoist', () => {
  it('?includeStats=true carries wordCount, readingTimeMin, and title on every file', async () => {
    const r = await getRecent('?includeStats=true');
    assert.equal(r.status, 200);
    // Only the two allowed files; notes.txt is filtered out by extension.
    assert.equal(r.payload.files.length, 2);
    for (const [rel, exp] of Object.entries(EXPECTED)) {
      const file = byPath(r.payload.files, rel);
      assert.ok(file, `expected ${rel} in the response`);
      assert.equal(file.wordCount, exp.wordCount);
      assert.equal(file.readingTimeMin, exp.readingTimeMin);
      assert.equal(file.title, exp.title);
    }
  });

  it('omitting the param leaves the stats fields absent (base fields only)', async () => {
    const r = await getRecent('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.files.length, 2);
    for (const file of r.payload.files) {
      // Base fields are always present...
      assert.equal(typeof file.name, 'string');
      assert.equal(typeof file.path, 'string');
      assert.equal(typeof file.mtime, 'number');
      // ...but the includeStats-only fields must not appear.
      assert.ok(!('wordCount' in file), 'wordCount must be absent without includeStats');
      assert.ok(!('readingTimeMin' in file), 'readingTimeMin must be absent without includeStats');
      assert.ok(!('title' in file), 'title must be absent without includeStats');
    }
  });

  it('only the exact value "true" enables stats (includeStats=1 does not)', async () => {
    const r = await getRecent('?includeStats=1');
    assert.equal(r.status, 200);
    for (const file of r.payload.files) {
      assert.ok(!('wordCount' in file), 'non-"true" values must not enable stats');
    }
  });
});
