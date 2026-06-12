import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/fake/root';
const ALLOWED_EXTS = ['.md', '.mdx'];

// Build an in-memory fs stub from a map of `${rel from PROJECT_ROOT}: content`.
// The dependencies handler only touches readFileSync (the source file) and
// readdirSync (the recursive content walk that finds incoming links).
function makeFs(fileMap) {
  const dirs = new Map();          // absDir -> Map<name, isDir>
  const fileContents = new Map();  // absFile -> content
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

// Drive GET /api/file/dependencies with a mocked ctx and capture the json()
// response. isValidFilePath defaults to accepting any path so the tests focus on
// the handler body rather than path validation.
async function getDependencies(fs, filePath, isValidFilePath = () => true) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS,
    fs,
    isValidFilePath,
    // The dependencies handler now wraps its result building in cached(); inject
    // a pass-through so this test still exercises the full handler body unchanged.
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/file/dependencies?path=${encodeURIComponent(filePath)}`);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/dependencies', ctx);
  return captured;
}

// Source mixes all three outgoing link kinds the handler extracts: two wiki
// links (the second carries an alias that must be stripped), two citation
// markers (one of them a multi-key group), and two root-relative markdown links.
const SOURCE = `---
title: Dependency Source
---

See [[graph-theory]] and [[linear-algebra|algebra]] for background.
This builds on [@knuth1997] and combines [@smith2020; @jones2019].
Read the [intro guide](/docs/intro) and the [API reference](/api/reference).
`;

// Links to the source near the top, so its incoming match breaks the scan loop
// at a small offset.
const REFERS_EARLY = `---
title: Refers Early
---

Right away this links to [[dep-source]] near the top, then moves on.
`;

// Points only at a different page, so it must NOT appear in incoming.
const NO_REF = `---
title: No Ref
---

This only points to [[other-page]], never back to the source file.
`;

// Links to the source at the end of a long body. It is the last file in the
// walk, so after the incoming scan the shared WIKI_RE is left with a large
// lastIndex. Without the per-loop reset on the outgoing scan, a second
// back-to-back request would resume from that offset and silently drop every
// outgoing wiki link, which the back-to-back assertion below catches.
const REFERS_LATE = `---
title: Refers Late
---

${'This paragraph is filler that carries no links at all. '.repeat(40)}
Finally, at the very end, it references [[dep-source]] once.
`;

const FIXTURE = {
  'content/dep-source.md': SOURCE,
  'content/refers-early.md': REFERS_EARLY,
  'content/no-ref.md': NO_REF,
  'content/refers-late.md': REFERS_LATE,
};

const EXPECTED_OUTGOING = [
  { type: 'wiki', target: 'graph-theory' },
  { type: 'wiki', target: 'linear-algebra' },
  { type: 'citation', target: 'knuth1997' },
  { type: 'citation', target: 'smith2020' },
  { type: 'citation', target: 'jones2019' },
  { type: 'link', target: 'docs/intro' },
  { type: 'link', target: 'api/reference' },
];

// Walk order is dep-source (skipped as self), refers-early (match), no-ref (no
// match), refers-late (match), so incoming keeps refers-early before refers-late.
const EXPECTED_INCOMING = [
  { type: 'wiki', source: 'content/refers-early.md' },
  { type: 'wiki', source: 'content/refers-late.md' },
];

describe('GET /api/file/dependencies (WIKI_RE/CITE_RE/MD_LINK_RE hoisted to module scope)', () => {
  it('extracts outgoing wiki links, citations, and markdown links plus incoming wiki links', async () => {
    const res = await getDependencies(makeFs(FIXTURE), 'content/dep-source.md');
    assert.equal(res.status, 200);
    assert.equal(res.body.path, 'content/dep-source.md');
    assert.deepEqual(res.body.outgoing, EXPECTED_OUTGOING);
    assert.deepEqual(res.body.incoming, EXPECTED_INCOMING);
    assert.equal(res.body.outgoingCount, EXPECTED_OUTGOING.length);
    assert.equal(res.body.incomingCount, EXPECTED_INCOMING.length);
  });

  it('returns identical results on a second back-to-back request (no stale lastIndex leakage)', async () => {
    const fs = makeFs(FIXTURE);
    const first = await getDependencies(fs, 'content/dep-source.md');
    const second = await getDependencies(fs, 'content/dep-source.md');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // The module-scope /g regexes persist between requests, so the second
    // response must match both the expected shape and the first response exactly.
    assert.deepEqual(second.body.outgoing, EXPECTED_OUTGOING);
    assert.deepEqual(second.body.incoming, EXPECTED_INCOMING);
    assert.deepEqual(second.body.outgoing, first.body.outgoing);
    assert.deepEqual(second.body.incoming, first.body.incoming);
  });

  it('returns 400 for an invalid path', async () => {
    const res = await getDependencies(makeFs({}), '../etc/passwd', () => false);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid path' });
  });

  it('returns 404 when the source file cannot be read', async () => {
    const res = await getDependencies(makeFs({}), 'content/missing.md');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'File not found' });
  });
});
