import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the sibling route suites do
// (next-graph-strippedname-hoist, next-trashname-re-hoist).
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

// ── Why this hoist is behavior-preserving ───────────────────────────────────
// The GET /api/backlinks wiki-link loop matched each link target against three
// forms: the basename, the extension-stripped path (`withoutExt`), and that path
// with a leading `docs/` removed. The third form recomputed
// `withoutExt.replace(/^docs\//, '')` on every wiki link in every file the
// recursive walk visits, even though `withoutExt` is a `const` (assigned once,
// never reassigned) and String.prototype.replace with a fixed regex and fixed
// receiver is pure. Computing it once into `const withoutExtNoDocs` next to
// `withoutExt` yields the identical string on every iteration, so every `===`
// result and the returned backlinks array are unchanged.
//
// For a target page at `content/docs/math/algebra.md` the three derived forms are:
//   baseName         = 'algebra'           (a bare `[[algebra]]` link)
//   withoutExt       = 'docs/math/algebra' (a full `[[docs/math/algebra]]` link)
//   withoutExtNoDocs = 'math/algebra'      (a docs-stripped `[[math/algebra]]` link)
// The fixture exercises one source file per form plus a non-matching link, a
// citation (a branch this hoist does not touch), and the target's own self-link
// (which the handler must skip).
const TARGET = path.join('content', 'docs', 'math', 'algebra.md');

const FIXTURE = {
  // The target page itself: its self-link must never appear in its own backlinks.
  [path.join('docs', 'math', 'algebra.md')]: '# Algebra\n\nSelf reference: [[math/algebra]].\n',
  // Docs-stripped form → matches via the hoisted `withoutExtNoDocs` branch.
  [path.join('notes', 'ref-nodocs.md')]: '# Ref NoDocs\n\nLink: [[math/algebra]].\n',
  // Full extension-stripped form → matches via `withoutExt`.
  [path.join('notes', 'ref-prefixed.md')]: '# Ref Prefixed\n\nLink: [[docs/math/algebra]].\n',
  // Bare basename form → matches via `baseName`.
  [path.join('notes', 'ref-basename.md')]: '# Ref Basename\n\nLink: [[algebra]].\n',
  // Unrelated target → must not match any of the three forms.
  [path.join('notes', 'ref-unrelated.md')]: '# Ref Unrelated\n\nLink: [[other/topic]].\n',
  // A citation to the basename → matches the untouched citation branch.
  [path.join('notes', 'cite-ref.md')]: '# Cite Ref\n\nCitation: [@algebra].\n',
  // Superstrings of the derived forms: near misses the exact `===` comparison must
  // reject. Guards the matcher against any future widening to a substring/contains test.
  [path.join('notes', 'ref-superstring.md')]: '# Ref Superstring\n\nNear misses: [[math/algebra-extra]] and [[xalgebra]].\n',
};

// Every backlink the handler should report for TARGET, compared order-independently
// (fs.readdirSync order is platform-defined and the handler does not sort).
const EXPECTED = [
  { sourcePath: path.join('content', 'notes', 'ref-nodocs.md'), sourceTitle: 'Ref NoDocs', linkType: 'wikilink' },
  { sourcePath: path.join('content', 'notes', 'ref-prefixed.md'), sourceTitle: 'Ref Prefixed', linkType: 'wikilink' },
  { sourcePath: path.join('content', 'notes', 'ref-basename.md'), sourceTitle: 'Ref Basename', linkType: 'wikilink' },
  { sourcePath: path.join('content', 'notes', 'cite-ref.md'), sourceTitle: 'Cite Ref', linkType: 'citation' },
];

const bySource = (a, b) => a.sourcePath.localeCompare(b.sourcePath);

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlinks-nodocs-'));
  for (const [rel, body] of Object.entries(FIXTURE)) {
    const full = path.join(root, 'content', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Drive the real GET /api/backlinks handler over the fixture and return the
// captured json() response. A pass-through cached() keeps the suite exercising the
// real fs-backed recursive walk (mirrors the sibling /api/graph suites).
async function runBacklinks(targetPath) {
  let captured = null;
  const res = { writableEnded: false };
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached: (_k, _ttl, fn) => fn(),
    json: (_res, status, payload) => { captured = { status, payload }; res.writableEnded = true; },
  };
  const url = new URL('http://localhost/api/backlinks?path=' + encodeURIComponent(targetPath));
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, '/api/backlinks', ctx);
  return captured;
}

describe('GET /api/backlinks resolves a docs page via the hoisted withoutExtNoDocs', () => {
  it('returns exactly the expected backlinks across all three link forms plus the citation', async () => {
    const { status, payload } = await runBacklinks(TARGET);
    assert.equal(status, 200);
    assert.deepEqual([...payload.backlinks].sort(bySource), [...EXPECTED].sort(bySource));
  });

  it('matches a docs-stripped [[math/algebra]] link (the branch this hoist preserves)', async () => {
    const { payload } = await runBacklinks(TARGET);
    const hit = payload.backlinks.find(b => b.sourcePath === path.join('content', 'notes', 'ref-nodocs.md'));
    assert.ok(hit, 'the docs-stripped wiki link must still resolve to the target');
    assert.equal(hit.linkType, 'wikilink');
  });

  it('matches a full [[docs/math/algebra]] link (the withoutExt branch)', async () => {
    const { payload } = await runBacklinks(TARGET);
    assert.ok(payload.backlinks.some(b => b.sourcePath === path.join('content', 'notes', 'ref-prefixed.md')));
  });

  it('matches a bare [[algebra]] link (the baseName branch)', async () => {
    const { payload } = await runBacklinks(TARGET);
    assert.ok(payload.backlinks.some(b => b.sourcePath === path.join('content', 'notes', 'ref-basename.md')));
  });

  it('ignores an unrelated [[other/topic]] link and excludes the page self-link', async () => {
    const { payload } = await runBacklinks(TARGET);
    const sources = payload.backlinks.map(b => b.sourcePath);
    assert.ok(!sources.includes(path.join('content', 'notes', 'ref-unrelated.md')), 'unrelated link must not match');
    assert.ok(!sources.includes(TARGET), 'the target must not back-link to itself');
  });

  it('does not over-match a superstring link (the === comparison rejects near misses)', async () => {
    const { payload } = await runBacklinks(TARGET);
    const sources = payload.backlinks.map(b => b.sourcePath);
    assert.ok(
      !sources.includes(path.join('content', 'notes', 'ref-superstring.md')),
      'a [[math/algebra-extra]] / [[xalgebra]] near-miss must not resolve to the target',
    );
  });

  it('returns 400 when the path param is missing', async () => {
    const { status, payload } = await runBacklinks('');
    assert.equal(status, 400);
    assert.equal(payload.error, 'Missing path param');
  });

  it('is byte-identical across two back-to-back calls', async () => {
    const first = await runBacklinks(TARGET);
    const second = await runBacklinks(TARGET);
    assert.equal(first.status, 200);
    assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
  });
});

describe('graph-trash-files.js source: backlinks hoists withoutExtNoDocs once', () => {
  const SRC = readFileSync(new URL('../server/routes/graph-trash-files.js', import.meta.url), 'utf-8');
  const count = (hay, needle) => hay.split(needle).length - 1;

  it('defines const withoutExtNoDocs once, derived from withoutExt', () => {
    assert.equal(
      count(SRC, "const withoutExtNoDocs = withoutExt.replace(/^docs\\//, '');"),
      1,
      'expected exactly one "const withoutExtNoDocs = withoutExt.replace(/^docs//, \'\');"',
    );
  });

  it('uses === withoutExtNoDocs in the wiki-link comparison', () => {
    assert.ok(SRC.includes('linkTarget === withoutExtNoDocs'), 'comparison must reuse the hoisted const');
  });

  it('leaves no inline withoutExt.replace(/^docs recompute behind the definition line', () => {
    // Per the goal: the only remaining `withoutExt.replace(/^docs` is the new
    // definition line, so the inline recompute inside the comparison is gone.
    assert.equal(count(SRC, 'withoutExt.replace(/^docs'), 1, 'only the definition may compute the docs-stripped form');
  });
});
