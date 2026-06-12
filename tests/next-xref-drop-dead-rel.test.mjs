import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-b.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-b.js');

const PROJECT_ROOT = '/proj';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel-from-PROJECT_ROOT}: content`.
// The xref-matrix handler only touches readdirSync (recursive content walk with
// {withFileTypes:true}) and readFileSync (page reads); the stub returns entries
// shaped the way the walk expects and ignores the encoding / options argument.
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

// Invoke a content-analysis-b route handler with a mocked ctx and capture the
// response the handler hands to `json(res, status, payload)`. The xref-matrix
// handler wraps its work in `cached(key, ttl, fn)`, so the stub runs `fn`
// straight through (no real caching needed to pin a single response).
async function invoke({ pathname, ctx = {} }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    cached: (_key, _ttl, fn) => fn(),
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/content-xref-matrix (dead `rel` var dropped from the scan closure)', () => {
  // A small content tree that drives every transform the scan performs:
  //   - id from a top-level file (intro.md -> "intro")
  //   - a page with no frontmatter, so its title falls back to the filename
  //   - a nested index file (guide/index.md -> "guide", the "/index" stripped)
  //   - a nested .mdx file (guide/deep.mdx -> "guide/deep")
  //   - wiki links `[[target]]`, an alias form `[[target|label]]` (label dropped),
  //     and a padded `[[ target ]]` (trimmed)
  //   - citations `[@key]` including a hyphenated key
  //   - a `_draft` file and a non-markdown file, both skipped by the walk
  // Removing the write-only `const rel = ...` cannot change any of this output, so
  // pinning the full payload is the regression guard for the dead-code removal.
  const FIXTURE = {
    'content/intro.md':
      '---\ntitle: Introduction\n---\nSee [[guide]] and [[guide/deep|Deep Dive]] plus [[ spaced ]]. Cites [@smith2020].\n',
    'content/plain.md':
      'Just text linking [[intro]] with no front matter.\n',
    'content/guide/index.md':
      '---\ntitle: Guide Home\n---\nBack to [[intro]]. Also [@doe2019].\n',
    'content/guide/deep.mdx':
      '---\ntitle: Deep Dive\n---\nRefs [[intro]] and [[guide]]. Cite [@smith2020] [@lee-2021].\n',
    'content/_draft.md':
      '---\ntitle: Hidden\n---\nUnderscore-prefixed file is skipped [[intro]].\n',
    'content/notes.txt':
      'Not a markdown extension, skipped [[intro]].\n',
  };
  const ctx = { fs: makeFs(FIXTURE) };
  const call = () => invoke({ pathname: '/api/content-xref-matrix', ctx });

  it('returns the page rows with ids and titles in walk order', async () => {
    const r = await call();
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.pages, [
      { id: 'intro', title: 'Introduction' },   // frontmatter title
      { id: 'plain', title: 'plain' },           // no frontmatter -> filename fallback
      { id: 'guide', title: 'Guide Home' },      // guide/index.md -> "/index" stripped
      { id: 'guide/deep', title: 'Deep Dive' },  // nested .mdx
    ]);
    assert.equal(r.payload.totalPages, 4);
  });

  it('extracts wiki and citation links (alias label dropped, padding trimmed)', async () => {
    const r = await call();
    // Per file the scan emits all wiki links first, then all citations.
    assert.deepEqual(r.payload.links, [
      { from: 'intro', to: 'guide', type: 'wiki' },
      { from: 'intro', to: 'guide/deep', type: 'wiki' },
      { from: 'intro', to: 'spaced', type: 'wiki' },
      { from: 'intro', to: 'smith2020', type: 'citation' },
      { from: 'plain', to: 'intro', type: 'wiki' },
      { from: 'guide', to: 'intro', type: 'wiki' },
      { from: 'guide', to: 'doe2019', type: 'citation' },
      { from: 'guide/deep', to: 'intro', type: 'wiki' },
      { from: 'guide/deep', to: 'guide', type: 'wiki' },
      { from: 'guide/deep', to: 'smith2020', type: 'citation' },
      { from: 'guide/deep', to: 'lee-2021', type: 'citation' },
    ]);
    assert.equal(r.payload.totalLinks, 11);
  });

  it('skips underscore-prefixed and non-markdown files', async () => {
    const r = await call();
    const ids = r.payload.pages.map(p => p.id);
    assert.ok(!ids.includes('_draft'), 'underscore-prefixed file is not scanned');
    assert.ok(!ids.includes('notes'), 'non-markdown file is not scanned');
    // Neither skipped file contributes its `[[intro]]` link.
    assert.equal(r.payload.links.filter(l => l.from === '_draft' || l.from === 'notes').length, 0);
  });

  it('reports 500 when the content directory cannot be read', async () => {
    // An empty fs has no content dir, so the top-level readdirSync throws and the
    // handler falls into its catch branch.
    const r = await invoke({ pathname: '/api/content-xref-matrix', ctx: { fs: makeFs({}) } });
    assert.equal(r.status, 500);
    assert.deepEqual(r.payload, { error: 'Matrix generation failed' });
  });
});
