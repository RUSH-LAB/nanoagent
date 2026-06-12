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
// (relative to PROJECT_ROOT) to its raw text.
async function searchFiles({ files, contents, query }) {
  const abs = new Map(
    Object.entries(contents).map(([rel, text]) => [path.join(PROJECT_ROOT, rel), text])
  );
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
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
// the handler must still fall back to the filename. This also pins the
// FRONTMATTER_RE `^` anchor: a regex that matched a fence anywhere (not only at
// the document start) would wrongly pull "Not The Real Title" out of this block.
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

describe('GET /api/files/search (FRONTMATTER_RE hoisted to module scope)', () => {
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
    // FRONTMATTER_RE has no /g flag, so the module-scope instance keeps no
    // lastIndex between requests and the two responses must be identical.
    assert.deepEqual(second.body.files, first.body.files);
  });
});
