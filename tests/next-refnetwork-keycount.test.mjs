import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// analysis-admin.js is CommonJS; load it the way the other route tests do. The
// handler's module-scope require('./references.js') resolves loadReferencesCached
// from the repo, exactly as the live server wires it.
const require = createRequire(import.meta.url);
const analysisAdminRoutes = require('../server/routes/analysis-admin.js');
// loadReferencesCached memoizes in a module-level singleton; clear it between
// scenarios so each case re-stats and re-reads deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');

// Three references. The content pages below cite a chosen subset so each scenario
// produces distinct totalReferences / citedReferences / uncitedReferences values
// and exercises the uncited === total - cited relation the handler now derives
// from the two hoisted locals (totalRefCount / citedRefCount).
const REFS_YAML = `ref_a:
  title: First Paper
  year: 2020
ref_b:
  title: Second Paper
  year: 2021
ref_c:
  title: Third Paper
  year: 2022
`;

// An fs mock serving REFS_YAML for references.yaml and the given `pages` map for
// the content tree. statSync returns a stable (mtimeMs, size) so loadReferencesCached
// hits its memo the way the live server does. readdirSync always lists three entries
// the scan must ignore (a dotfile, an underscore file, and a non-markdown file)
// ahead of the real pages, proving those skips never touch a count. Any other path
// is ENOENT so a stray access surfaces.
function makeFs(pages) {
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  const SKIP = ['.hidden.md', '_draft.md', 'notes.txt'];
  return {
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: REFS_YAML.length };
      return enoent(fp);
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) return REFS_YAML;
      const rel = path.relative(CONTENT_DIR, fp);
      if (Object.hasOwn(pages, rel)) return pages[rel];
      return enoent(fp);
    },
    readdirSync(fp) {
      if (fp === CONTENT_DIR) {
        return [...SKIP, ...Object.keys(pages)].map(name => ({ name, isDirectory: () => false }));
      }
      return enoent(fp);
    },
    existsSync(fp) {
      return fp === REFS_PATH;
    },
  };
}

// Drive the real GET /api/references/network handler over a mocked ctx and capture
// what json() writes. The cached passthrough runs the fold on every call (no
// result-level memo), so each request recomputes the counts from scratch.
async function runNetwork(fsMock) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const pathname = '/api/references/network';
  const url = new URL(`http://localhost${pathname}`);
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await analysisAdminRoutes(req, res, url, pathname, ctx);
  return out;
}

describe('GET /api/references/network reference counts (totalRefCount / citedRefCount reuse)', () => {
  beforeEach(() => _resetReferencesCache());

  it('counts total, cited, and uncited references when only a subset is cited', async () => {
    // page1 cites ref_a and ref_b, page2 cites ref_a again, page3 cites nothing.
    // ref_c is never cited, so total 3, cited 2, uncited 1.
    const out = await runNetwork(makeFs({
      'page1.md': 'Intro [@ref_a] then [@ref_b] here.\n',
      'page2.md': 'Follow-up [@ref_a] only.\n',
      'page3.md': 'No citations on this page.\n',
    }));
    assert.equal(out.status, 200);
    assert.equal(out.json.totalReferences, 3);
    assert.equal(out.json.citedReferences, 2);
    assert.equal(out.json.uncitedReferences, 1);
    // The relation the hoisted locals encode: uncited is exactly total minus cited.
    assert.equal(out.json.uncitedReferences, out.json.totalReferences - out.json.citedReferences);
    // Full payload is pinned so the count hoist stays behavior preserving: ref_a is
    // most cited (2 pages), ref_b next (1 page), ref_c absent, and the single
    // co-citation (count 1) is filtered out of coCitations (> 1 only).
    assert.deepEqual(out.json, {
      totalReferences: 3,
      citedReferences: 2,
      uncitedReferences: 1,
      mostCited: [
        { key: 'ref_a', title: 'First Paper', count: 2, pages: ['content/page1.md', 'content/page2.md'] },
        { key: 'ref_b', title: 'Second Paper', count: 1, pages: ['content/page1.md'] },
      ],
      coCitations: [],
    });
  });

  it('reports every reference uncited when no page cites anything', async () => {
    // No citing pages at all: cited 0, so uncited equals total.
    const out = await runNetwork(makeFs({
      'page1.md': 'Prose with no citation markers.\n',
    }));
    assert.equal(out.status, 200);
    assert.equal(out.json.totalReferences, 3);
    assert.equal(out.json.citedReferences, 0);
    assert.equal(out.json.uncitedReferences, 3);
    assert.equal(out.json.uncitedReferences, out.json.totalReferences - out.json.citedReferences);
  });

  it('reports zero uncited when every reference is cited', async () => {
    // One page cites all three references: cited 3, so uncited is 0.
    const out = await runNetwork(makeFs({
      'page1.md': 'All three: [@ref_a] [@ref_b] [@ref_c].\n',
    }));
    assert.equal(out.status, 200);
    assert.equal(out.json.totalReferences, 3);
    assert.equal(out.json.citedReferences, 3);
    assert.equal(out.json.uncitedReferences, 0);
    assert.equal(out.json.uncitedReferences, out.json.totalReferences - out.json.citedReferences);
  });
});
