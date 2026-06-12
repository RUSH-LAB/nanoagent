import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// files.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');

const PROJECT_ROOT = '/fake/root';

// Drive GET /api/files/search with a mocked ctx and capture the json() response.
// The handler only touches flatFiles (the file list), fs.readFileSync (each
// matched file's content), path, and PROJECT_ROOT, so the stub supplies just
// those. `files` is the flatFiles result; `contents` maps a file's `path`
// (relative to PROJECT_ROOT) to its raw text. Modeled on
// tests/next-filesearch-hoist-fmre.test.mjs.
async function searchFiles({ files, contents, query }) {
  const abs = new Map(
    Object.entries(contents).map(([rel, text]) => [path.join(PROJECT_ROOT, rel), text])
  );
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    // The search handler snapshots its directory walk through
    // cached('search:list', 30000, () => flatFiles(fullDir)); a pass-through
    // cached keeps this suite's behavior identical (it just runs fn each call),
    // and the no-op invalidateCache satisfies the shared ctx shape.
    cached: (_k, _t, fn) => fn(),
    invalidateCache: () => {},
    flatFiles: () => files,
    fs: {
      readFileSync(fp) {
        if (abs.has(fp)) return abs.get(fp);
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/files/search?q=${encodeURIComponent(query)}`);
  await filesRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/files/search', ctx);
  return captured;
}

// One file carries a YAML front-matter `title:` (so the handler should surface
// that title); the other has no front-matter at all (so the handler should fall
// back to the filename minus its extension). Both names contain "note" so a
// single query matches the pair.
const WITH_FM = `---
title: Custom Front Matter Title
---

Body text for the front-matter note.
`;

// No front-matter: the file opens with body text, so there is no opening block
// at the document start. The `---` fence further down is not front-matter, so
// the handler must still fall back to the filename.
const NO_FM = `Intro paragraph that mentions notes before any fence.
---
title: Not The Real Title
---
More body after the fence.
`;

const FILES = [
  { name: 'with-fm-note.md', path: 'content/with-fm-note.md' },
  { name: 'no-fm-note.md', path: 'content/no-fm-note.md' },
];

const CONTENTS = {
  'content/with-fm-note.md': WITH_FM,
  'content/no-fm-note.md': NO_FM,
};

describe('GET /api/files/search (SEARCH_TITLE_RE hoisted to module scope)', () => {
  it('exports a stateless, non-global, non-sticky title RegExp', () => {
    const { SEARCH_TITLE_RE } = filesRoutes;
    assert.ok(SEARCH_TITLE_RE instanceof RegExp, 'SEARCH_TITLE_RE should be a RegExp');
    // Stateless across .match() calls: no /g and no /y, so it carries no
    // lastIndex between requests.
    assert.equal(SEARCH_TITLE_RE.global, false);
    assert.equal(SEARCH_TITLE_RE.sticky, false);
    // Pattern and flags must match the original inline literal verbatim. Compare
    // against a fresh literal of the canonical pattern so a widened/narrowed
    // hoist is caught.
    const CANONICAL = /^title:\s*["']?(.+?)["']?\s*$/m;
    assert.equal(SEARCH_TITLE_RE.source, CANONICAL.source);
    assert.equal(SEARCH_TITLE_RE.flags, CANONICAL.flags);
    assert.equal(SEARCH_TITLE_RE.flags, 'm');
  });

  it('is referentially stable across two requires (single shared instance)', () => {
    const a = require('../server/routes/files.js').SEARCH_TITLE_RE;
    const b = require('../server/routes/files.js').SEARCH_TITLE_RE;
    assert.strictEqual(a, b);
  });

  it('uses the front-matter title when present and the filename otherwise', async () => {
    const res = await searchFiles({ files: FILES, contents: CONTENTS, query: 'note' });
    assert.equal(res.status, 200);
    const byPath = Object.fromEntries(res.body.files.map(f => [f.path, f.title]));
    // File with front-matter: the `title:` value, not the filename.
    assert.equal(byPath['content/with-fm-note.md'], 'Custom Front Matter Title');
    // File without front-matter: filename minus the .md extension.
    assert.equal(byPath['content/no-fm-note.md'], 'no-fm-note');
  });

  it('returns identical results on a second back-to-back request (shared regex carries no state)', async () => {
    const first = await searchFiles({ files: FILES, contents: CONTENTS, query: 'note' });
    const second = await searchFiles({ files: FILES, contents: CONTENTS, query: 'note' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // SEARCH_TITLE_RE has no /g flag, so the module-scope instance keeps no
    // lastIndex between requests and the two responses must be identical.
    assert.deepEqual(second.body.files, first.body.files);
  });
});
