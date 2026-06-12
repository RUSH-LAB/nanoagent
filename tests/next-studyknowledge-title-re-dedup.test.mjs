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

// The canonical inline literal the three content-scan handlers shared before the
// hoist. The single module-scope const must equal this byte for byte.
const CANONICAL = /^title:\s*["']?(.+?)["']?\s*$/m;

// Temp PROJECT_ROOTs created during the run, removed in after().
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

// Create a fresh temp PROJECT_ROOT, write each [name, body] entry into content/,
// and return the root path.
function makeContentDir(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-title-hoist-'));
  roots.push(root);
  const contentDir = path.join(root, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  for (const [name, body] of files) fs.writeFileSync(path.join(contentDir, name), body, 'utf-8');
  return root;
}

// Drive the real GET /api/search/suggest handler over a temp root and capture
// json(). cached() is a pass-through (it just runs fn each call) and ALLOWED_EXTS
// covers the .md fixtures; bibliography/references.yaml is absent under the temp
// root, so the handler's inner reference read throws into its own try/catch and
// only the page suggestions (each built through FRONTMATTER_TITLE_RE) remain.
async function suggest(root, query) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/search/suggest?q=${encodeURIComponent(query)}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await studyRoutes(req, res, url, '/api/search/suggest', ctx);
  return captured;
}

// One fixture per quote style the matcher must accept: a double-quoted, a
// single-quoted, and an unquoted front-matter title. Each filename contains
// "note" so a single query surfaces all three.
const DOUBLE = '---\ntitle: "Double Quoted Title"\n---\n\nBody for the double-quoted note.\n';
const SINGLE = "---\ntitle: 'Single Quoted Title'\n---\n\nBody for the single-quoted note.\n";
const PLAIN  = '---\ntitle: Plain Unquoted Title\n---\n\nBody for the unquoted note.\n';

const FILES = [
  ['dq-note.md', DOUBLE],
  ['sq-note.md', SINGLE],
  ['uq-note.md', PLAIN],
];

describe('FRONTMATTER_TITLE_RE hoisted to module scope in study-knowledge.js', () => {
  it('exports a stateless, non-global, non-sticky title RegExp with the canonical source/flags', () => {
    const { FRONTMATTER_TITLE_RE } = studyRoutes;
    assert.ok(FRONTMATTER_TITLE_RE instanceof RegExp, 'FRONTMATTER_TITLE_RE should be a RegExp');
    // Pattern and flags must equal the original inline literal verbatim, so a
    // widened or narrowed hoist is caught.
    assert.equal(FRONTMATTER_TITLE_RE.source, CANONICAL.source);
    assert.equal(FRONTMATTER_TITLE_RE.flags, CANONICAL.flags);
    assert.equal(FRONTMATTER_TITLE_RE.flags, 'm');
    // Non-global and non-sticky: it carries no lastIndex between .match() calls.
    assert.equal(FRONTMATTER_TITLE_RE.global, false);
    assert.equal(FRONTMATTER_TITLE_RE.sticky, false);
  });

  it('stays distinct from QUICKNOTES_TITLE_RE (the double-quote-only variant)', () => {
    // The two patterns differ on purpose: this one accepts a single OR a double
    // quote (["']?), while QUICKNOTES_TITLE_RE accepts a double quote only ("?).
    // The hoist must not collapse them onto one shared instance.
    assert.notEqual(studyRoutes.FRONTMATTER_TITLE_RE.source, studyRoutes.QUICKNOTES_TITLE_RE.source);
    assert.equal(studyRoutes.QUICKNOTES_TITLE_RE.source, '^title:\\s*"?(.+?)"?\\s*$');
  });

  it('is referentially stable across two requires (single shared instance)', () => {
    const a = require(SPECIFIER).FRONTMATTER_TITLE_RE;
    const b = require(SPECIFIER).FRONTMATTER_TITLE_RE;
    assert.strictEqual(a, b);
  });

  it('extracts double-quoted, single-quoted, and unquoted titles (direct match)', () => {
    const re = studyRoutes.FRONTMATTER_TITLE_RE;
    assert.equal('title: "Double Quoted Title"'.match(re)[1], 'Double Quoted Title');
    assert.equal("title: 'Single Quoted Title'".match(re)[1], 'Single Quoted Title');
    assert.equal('title: Plain Unquoted Title'.match(re)[1], 'Plain Unquoted Title');
  });

  it('drives GET /api/search/suggest and returns the extracted title for each quote style', async () => {
    const root = makeContentDir(FILES);
    const { status, body } = await suggest(root, 'note');
    assert.equal(status, 200);
    // Map by path so the assertion does not depend on readdir ordering.
    const byPath = Object.fromEntries(body.suggestions.map(s => [s.path, s.text]));
    assert.equal(byPath['content/dq-note.md'], 'Double Quoted Title');
    assert.equal(byPath['content/sq-note.md'], 'Single Quoted Title');
    assert.equal(byPath['content/uq-note.md'], 'Plain Unquoted Title');
  });

  it('returns identical results on a second back-to-back request (shared regex carries no state)', async () => {
    const root = makeContentDir(FILES);
    const first = await suggest(root, 'note');
    const second = await suggest(root, 'note');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // FRONTMATTER_TITLE_RE has no /g flag, so the module-scope instance keeps no
    // lastIndex between requests and the two responses must be identical.
    assert.deepEqual(second.body, first.body);
  });
});
