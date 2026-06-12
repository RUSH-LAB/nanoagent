import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const SPECIFIER = '../server/routes/study-knowledge.js';
const studyRoutes = require(SPECIFIER);

// Temp PROJECT_ROOTs created during the run, removed in after().
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

// Create a fresh temp PROJECT_ROOT, write each [name, body] entry into
// content/posts/blog/, and return the root path.
function makeBlogDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quicknotes-hoist-'));
  roots.push(root);
  const blogDir = path.join(root, 'content', 'posts', 'blog');
  fs.mkdirSync(blogDir, { recursive: true });
  for (const [name, body] of files) fs.writeFileSync(path.join(blogDir, name), body, 'utf-8');
  return root;
}

// Drive the real GET /api/quicknotes handler over a temp root and capture json().
// loadJSON returns {} so the response carries only the filesystem blog notes,
// isolating the three hoisted parser regexes under test.
async function getQuicknotes(root) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    loadJSON: () => ({}),
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/quicknotes');
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyRoutes(req, res, url, '/api/quicknotes', ctx);
  return captured;
}

// A filesystem quick note exercising all three hoisted regexes in one file:
// a date-prefixed filename (date regex), title front matter in the "?-quoted
// form the handler parses (title regex), the quick-note marker that gates
// inclusion, and a body after the front matter (body regex).
const QUICK_NOTE = [
  '---',
  'title: "My Quick Note"',
  'tags: [quick-note]',
  '---',
  '',
  'This note body has enough words to be sliced.',
  '',
].join('\n');

describe('quicknotes parser regexes (hoisted to module scope)', () => {
  it('exports each regex with the exact source, flags, and no lastIndex state', () => {
    const specs = [
      ['QUICKNOTES_TITLE_RE', '^title:\\s*"?(.+?)"?\\s*$', 'm'],
      ['QUICKNOTES_DATE_RE', '^(\\d{4}-\\d{2}-\\d{2})', ''],
      ['QUICKNOTES_BODY_RE', '---\\s*\\n[\\s\\S]*?\\n---\\s*\\n([\\s\\S]*)', ''],
    ];
    for (const [name, source, flags] of specs) {
      const re = studyRoutes[name];
      assert.ok(re instanceof RegExp, `${name} is a RegExp`);
      assert.equal(re.source, source, `${name}.source`);
      assert.equal(re.flags, flags, `${name}.flags`);
      assert.equal(re.global, false, `${name}.global`);
      assert.equal(re.sticky, false, `${name}.sticky`);
    }
  });

  it('returns the same regex instances across two requires (built once at module load)', () => {
    // The module is cached, so a second require hands back the identical exports.
    // A per-request allocation could not satisfy this referential equality.
    const second = require(SPECIFIER);
    assert.strictEqual(second.QUICKNOTES_TITLE_RE, studyRoutes.QUICKNOTES_TITLE_RE);
    assert.strictEqual(second.QUICKNOTES_DATE_RE, studyRoutes.QUICKNOTES_DATE_RE);
    assert.strictEqual(second.QUICKNOTES_BODY_RE, studyRoutes.QUICKNOTES_BODY_RE);
  });

  it('drives GET /api/quicknotes identically on two back-to-back calls', async () => {
    const root = makeBlogDir([['2024-03-15-hello.md', QUICK_NOTE]]);
    const first = await getQuicknotes(root);
    const second = await getQuicknotes(root);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // The three regexes are non-global, so .match() never carries lastIndex
    // between requests; the parsed notes are identical call to call.
    assert.deepStrictEqual(second.payload, first.payload);
    assert.deepStrictEqual(first.payload, [{
      id: '2024-03-15-hello.md',
      text: 'This note body has enough words to be sliced.',
      title: 'My Quick Note',
      date: '2024-03-15',
      path: 'content/posts/blog/2024-03-15-hello.md',
      source: 'blog',
    }]);
  });

  it('excludes files without the quick-note marker', async () => {
    // "Not a quick note." has a space, not the hyphenated marker, so it is
    // filtered out before any regex runs.
    const root = makeBlogDir([['2024-02-02-plain.md', '---\ntitle: "Plain"\n---\n\nNot a quick note.\n']]);
    const { status, payload } = await getQuicknotes(root);
    assert.equal(status, 200);
    assert.deepStrictEqual(payload, []);
  });

  it('falls back when the title, date, and body patterns all miss', async () => {
    // No front matter (body and title miss) and no date prefix on the filename,
    // so title falls back to the filename, date to null, and text to ''.
    const root = makeBlogDir([['inline-note.md', 'quick-note jotted inline, no front matter.\n']]);
    const { status, payload } = await getQuicknotes(root);
    assert.equal(status, 200);
    assert.deepStrictEqual(payload, [{
      id: 'inline-note.md',
      text: '',
      title: 'inline-note.md',
      date: null,
      path: 'content/posts/blog/inline-note.md',
      source: 'blog',
    }]);
  });
});
