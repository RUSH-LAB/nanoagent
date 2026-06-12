import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');

const ALLOWED_EXTS = ['.md', '.mdx'];

// A real tmp content dir backs this test (no network, no fixture fs stub), so the
// GET /api/search/suggest handler runs its actual recursive walk and reads each
// file through the shared module-scope FRONTMATTER_RE. Three pages whose names all
// contain "neural" so a single query matches them:
//   - with-fm carries a leading `---` block, so the `title:` value surfaces.
//   - plain has no front matter, so the title falls back to the filename.
//   - late-fence opens with body text and only fences further down. The `^`
//     anchor in FRONTMATTER_RE means that block is NOT front matter, so its
//     "Should Not Surface" title must never appear. This pins the anchor rather
//     than just "any `---` matcher".
const CONTENT_FILES = {
  'neural-with-fm.md': '---\ntitle: Deep Neural Networks\n---\n\nBody about neural nets.\n',
  'neural-plain.md': 'Plain neural body with no front matter block at all.\n',
  'neural-late-fence.md': 'Intro about neural topics before any fence.\n---\ntitle: Should Not Surface\n---\nMore body.\n',
};

let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studyknow-fm-'));
  const contentDir = path.join(TMP, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  for (const [name, body] of Object.entries(CONTENT_FILES)) {
    fs.writeFileSync(path.join(contentDir, name), body);
  }
});

after(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

// Drive GET /api/search/suggest in-process with a mocked ctx and capture the
// json() response. The handler reads only fs, path, PROJECT_ROOT, ALLOWED_EXTS,
// and json from ctx (js-yaml is required directly; the missing references.yaml
// read is swallowed by the handler's own try/catch).
async function suggest(query) {
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT: TMP,
    ALLOWED_EXTS,
    // The handler now memoizes its scan through ctx.cached; this pass-through runs
    // fn() every call (no caching), so the assertions below are unaffected.
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/search/suggest?q=${encodeURIComponent(query)}`);
  await studyKnowledgeRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/search/suggest', ctx);
  return captured;
}

describe('GET /api/search/suggest (FRONTMATTER_RE deduped to a module const)', () => {
  it('uses the front-matter title when present and the filename otherwise', async () => {
    const res = await suggest('neural');
    assert.equal(res.status, 200);
    const pages = res.body.suggestions.filter(s => s.type === 'page');
    const byPath = Object.fromEntries(pages.map(s => [s.path, s.text]));
    // Leading front matter: the `title:` value, not the filename.
    assert.equal(byPath['content/neural-with-fm.md'], 'Deep Neural Networks');
    // No front matter: filename minus the .md extension.
    assert.equal(byPath['content/neural-plain.md'], 'neural-plain');
    // Fence not at document start: FRONTMATTER_RE's `^` anchor rejects it, so the
    // title falls back to the filename and the in-body title never leaks out.
    assert.equal(byPath['content/neural-late-fence.md'], 'neural-late-fence');
    assert.ok(!res.body.suggestions.some(s => s.text === 'Should Not Surface'));
  });

  it('returns identical results on a second back-to-back request (shared regex carries no state)', async () => {
    const first = await suggest('neural');
    const second = await suggest('neural');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // FRONTMATTER_RE is non-global, so the shared module-scope instance keeps no
    // lastIndex between requests and the two responses must be byte-identical.
    assert.deepEqual(second.body.suggestions, first.body.suggestions);
  });
});
