import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const bibliographyProvides = createRequire(import.meta.url)('../../../../../plugins/bibliography/server.js').provides;
const miscToolsRoutes = require('../../../../../src/server/routes/misc-tools.js');
const { numericParam } = miscToolsRoutes;

// The bibliography plugin publishes a loader that asks for a reader, because the
// plugin is not allowed to touch the filesystem itself. The server adapts that
// reader into the (fs, path, root) call core handlers make: see
// referencesForCore in src/server/index.js. This mirrors that adaptation so the
// suite can feed its fixture fs to the real loader rather than to a stub of it.
function referencesForCore(provided) {
  const readerFor = (fs, path, root) => {
    const at = (relative) => path.join(root, 'content', relative);
    return {
      read(relative) {
        try {
          return fs.readFileSync(at(relative), 'utf-8');
        } catch {
          return null;
        }
      },
      stat(relative) {
        try {
          const { mtimeMs, size } = fs.statSync(at(relative));
          return { mtimeMs, size };
        } catch {
          return null;
        }
      },
    };
  };
  return { ...provided, load: (fs, path, root) => provided.load(readerFor(fs, path, root)) };
}

// Invoke a misc-tools route handler with a minimal mocked ctx and capture the
// response that the handler hands to `json(res, status, payload)`.
async function invoke({ method = 'GET', pathname, search = '', ctx = {} }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
    ...ctx,
  };
  await miscToolsRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('numericParam helper', () => {
  it('is exported alongside the route handler', () => {
    assert.equal(typeof miscToolsRoutes, 'function', 'default export is the route handler');
    assert.equal(typeof numericParam, 'function', 'numericParam is exported');
  });
});

describe('GET /api/suggest limit guard', () => {
  // A fixed in-memory corpus: 25 references and 25 content pages that each match
  // the single search keyword, so the default (5), the clamp (20), the floor (1),
  // and the broken NaN path (slice(0, NaN) === empty) are all distinguishable.
  // The handler reads references.yaml and the content tree straight from `fs`
  // (plus flatFiles for the listing), so mock those rather than `cached()`.
  const PROJECT_ROOT = '/proj';
  const KEYWORD = 'elephant'; // > 2 chars and not a stop word, so it survives keyword extraction
  const ENTRY_COUNT = 25;

  // references.yaml: every entry's title carries the keyword, so all 25 match.
  const refsYaml = Array.from({ length: ENTRY_COUNT }, (_, i) =>
    `ref${i}:\n  title: "Elephant study ${i}"\n  author: "Author ${i}"`,
  ).join('\n');

  // content tree: 25 markdown pages whose H1 heading carries the keyword.
  const contentDir = path.join(PROJECT_ROOT, 'content');
  const pageFiles = Array.from({ length: ENTRY_COUNT }, (_, i) => ({
    name: `page-${i}.md`,
    path: `content/page-${i}.md`,
  }));

  const fileContents = new Map();
  fileContents.set(path.join(PROJECT_ROOT, 'content', 'bibliography', 'references.yaml'), refsYaml);
  for (const f of pageFiles) {
    fileContents.set(path.join(PROJECT_ROOT, f.path), `# Elephant page ${f.name}\n`);
  }

  const fs = {
    existsSync(p) {
      return p === contentDir;
    },
    readFileSync(p) {
      if (fileContents.has(p)) return fileContents.get(p);
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
  };

  const ctx = {
    // The bibliography plugin lends its loader through ctx, exactly as
    // server/plugins.js does in production, wrapped the way the server wraps it.
    references: referencesForCore(bibliographyProvides.references),
    fs,
    path,
    PROJECT_ROOT,
    flatFiles: dir => (dir === contentDir ? pageFiles : []),
  };
  const callSuggest = search =>
    invoke({ pathname: '/api/suggest', search: `?text=${KEYWORD}${search}`, ctx });

  it('matches the corpus so slicing is observable', async () => {
    const r = await callSuggest('&limit=20');
    assert.equal(r.status, 200);
    // Sanity: there are more than 20 candidates on each side, so the cap bites.
    assert.equal(r.payload.references.length, 20);
    assert.equal(r.payload.pages.length, 20);
  });

  it('absent limit yields the default-sized lists (5)', async () => {
    const r = await callSuggest('');
    assert.equal(r.status, 200);
    assert.equal(r.payload.references.length, 5, 'default limit is 5');
    assert.equal(r.payload.pages.length, 5, 'default limit is 5');
  });

  it('valid limit is honored', async () => {
    const r = await callSuggest('&limit=8');
    assert.equal(r.status, 200);
    assert.equal(r.payload.references.length, 8);
    assert.equal(r.payload.pages.length, 8);
  });

  it('over-cap limit still clamps to 20', async () => {
    const r = await callSuggest('&limit=500');
    assert.equal(r.status, 200);
    assert.equal(r.payload.references.length, 20);
    assert.equal(r.payload.pages.length, 20);
  });

  it('limit of 0 still floors to 1 result', async () => {
    const r = await callSuggest('&limit=0');
    assert.equal(r.status, 200);
    assert.equal(r.payload.references.length, 1, 'floor of 1 is preserved');
    assert.equal(r.payload.pages.length, 1, 'floor of 1 is preserved');
  });

  it('negative limit still floors to 1 result', async () => {
    const r = await callSuggest('&limit=-3');
    assert.equal(r.status, 200);
    assert.equal(r.payload.references.length, 1, 'floor of 1 is preserved');
    assert.equal(r.payload.pages.length, 1, 'floor of 1 is preserved');
  });

  it('non-numeric limit yields the default-sized lists, not empty ones', async () => {
    const r = await callSuggest('&limit=abc');
    assert.equal(r.status, 200);
    assert.equal(r.payload.references.length, 5, 'guarded to default 5, not slice(0, NaN) === []');
    assert.equal(r.payload.pages.length, 5, 'guarded to default 5, not slice(0, NaN) === []');
    assert.notEqual(r.payload.references.length, 0, 'list is not collapsed to empty');
    assert.notEqual(r.payload.pages.length, 0, 'list is not collapsed to empty');
  });
});
