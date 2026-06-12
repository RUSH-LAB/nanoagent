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
const TESTS_DIR = path.join(PROJECT_ROOT, 'tests');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// Two-entry fixture with years, venues, and authors so it drives every branch the
// three handlers read: the network counts (totalReferences) and the timeline fold
// (byYear, authors.slice(0, 3)) and the dashboard reference count.
const REFS_YAML = `ref_a:
  title: First Paper
  venue: Journal A
  year: 2020
  author:
    - Ada Lovelace
ref_b:
  title: Second Paper
  venue: Journal B
  year: 2021
  author:
    - Alan Turing
`;

// Expected GET /api/references/network payload for REFS_YAML over an empty content
// tree: nothing is cited, so every reference is uncited and the cited/co-cited
// lists are empty. Key order matches the handler's return literal so the
// JSON.stringify comparison below pins byte-identical output.
const NETWORK_EXPECTED = {
  totalReferences: 2,
  citedReferences: 0,
  uncitedReferences: 2,
  mostCited: [],
  coCitations: [],
};
const NETWORK_EMPTY = {
  totalReferences: 0,
  citedReferences: 0,
  uncitedReferences: 0,
  mostCited: [],
  coCitations: [],
};

// Expected GET /api/references/timeline payload for REFS_YAML: one paper per year,
// ascending, authors trimmed to three. Key order matches the handler literal.
const TIMELINE_EXPECTED = {
  timeline: [
    { year: 2020, count: 1, papers: [{ key: 'ref_a', title: 'First Paper', venue: 'Journal A', authors: ['Ada Lovelace'] }] },
    { year: 2021, count: 1, papers: [{ key: 'ref_b', title: 'Second Paper', venue: 'Journal B', authors: ['Alan Turing'] }] },
  ],
  totalYears: 2,
};
const TIMELINE_EMPTY = { timeline: [], totalYears: 0 };

// An fs mock serving `yamlText` for references.yaml. statSync returns a stable
// (mtimeMs, size) so loadReferencesCached's memo path is exercised the way the
// live server hits it; `reads` counts references.yaml reads only, so the memo
// (reads === 1 across two GETs) is observable. The content/tests/data directories
// are empty so the handlers' walks contribute nothing, and every other path is
// ENOENT so a stray access surfaces. With `missing: true` the bibliography is
// absent: statSync and readFileSync throw and existsSync is false.
function makeFs(yamlText, { missing = false } = {}) {
  const state = { reads: 0 };
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  const fsMock = {
    statSync(fp) {
      if (fp === REFS_PATH && !missing) return { mtimeMs: 1, size: yamlText.length };
      return enoent(fp);
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) {
        state.reads++;
        if (missing) return enoent(fp);
        return yamlText;
      }
      return enoent(fp);
    },
    readdirSync(fp) {
      if (fp === CONTENT_DIR || fp === TESTS_DIR || fp === DATA_DIR) return [];
      return enoent(fp);
    },
    existsSync(fp) {
      return fp === REFS_PATH && !missing;
    },
  };
  return { fsMock, state };
}

// Drive a real GET handler over a mocked ctx and capture what json() writes. The
// `cached` passthrough runs the fold on every call (no result-level memo), so the
// memo asserted by reads === 1 is loadReferencesCached's own parse memo, not the
// cached() wrapper. The dashboard's extra ctx (loadJSON, cache, _routeDiagnostics,
// the *_FILE paths) is harmless for the references endpoints.
async function runGet(pathname, fsMock) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    ALLOWED_EXTS: ['.md', '.mdx'],
    cached: (_k, _t, fn) => fn(),
    loadJSON: () => ({}),
    cache: {},
    _routeDiagnostics: {},
    ANALYTICS_FILE: 'analytics.json',
    COMMENTS_FILE: 'comments.json',
    DISCUSSIONS_FILE: 'discussions.json',
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const url = new URL(`http://localhost${pathname}`);
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await analysisAdminRoutes(req, res, url, pathname, ctx);
  return out;
}

describe('analysis-admin GET handlers reuse loadReferencesCached', () => {
  beforeEach(() => _resetReferencesCache());

  describe('GET /api/references/network', () => {
    it('parses references.yaml once across two GETs (memo) with byte-identical output', async () => {
      const { fsMock, state } = makeFs(REFS_YAML);
      const first = await runGet('/api/references/network', fsMock);
      const second = await runGet('/api/references/network', fsMock);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(first.json, NETWORK_EXPECTED);
      assert.equal(JSON.stringify(first.json), JSON.stringify(NETWORK_EXPECTED), 'output is byte-identical to the pre-fix fold');
      assert.equal(JSON.stringify(second.json), JSON.stringify(first.json), 'the memoized repeat is byte-identical');
      assert.equal(state.reads, 1, 'second GET is served from the memo, not a re-read');
    });

    it('returns 200 with empty results for a valid-but-empty bibliography', async () => {
      const { fsMock } = makeFs('{}');
      const out = await runGet('/api/references/network', fsMock);
      assert.equal(out.status, 200);
      assert.deepEqual(out.json, NETWORK_EMPTY);
      assert.equal(JSON.stringify(out.json), JSON.stringify(NETWORK_EMPTY));
    });

    it('preserves the 500 on a broken bibliography', async () => {
      const { fsMock } = makeFs('{ unclosed');
      const out = await runGet('/api/references/network', fsMock);
      assert.equal(out.status, 500);
      assert.deepEqual(out.json, { error: 'Citation network analysis failed' });
    });

    it('preserves the 500 when references.yaml is missing', async () => {
      const { fsMock } = makeFs('', { missing: true });
      const out = await runGet('/api/references/network', fsMock);
      assert.equal(out.status, 500);
      assert.deepEqual(out.json, { error: 'Citation network analysis failed' });
    });
  });

  describe('GET /api/references/timeline', () => {
    it('parses references.yaml once across two GETs (memo) with byte-identical output', async () => {
      const { fsMock, state } = makeFs(REFS_YAML);
      const first = await runGet('/api/references/timeline', fsMock);
      const second = await runGet('/api/references/timeline', fsMock);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(first.json, TIMELINE_EXPECTED);
      assert.equal(JSON.stringify(first.json), JSON.stringify(TIMELINE_EXPECTED), 'output is byte-identical to the pre-fix fold');
      assert.equal(JSON.stringify(second.json), JSON.stringify(first.json), 'the memoized repeat is byte-identical');
      assert.equal(state.reads, 1, 'second GET is served from the memo, not a re-read');
    });

    it('returns 200 with an empty timeline for a valid-but-empty bibliography', async () => {
      const { fsMock } = makeFs('{}');
      const out = await runGet('/api/references/timeline', fsMock);
      assert.equal(out.status, 200);
      assert.deepEqual(out.json, TIMELINE_EMPTY);
      assert.equal(JSON.stringify(out.json), JSON.stringify(TIMELINE_EMPTY));
    });

    it('preserves the 500 on a broken bibliography', async () => {
      const { fsMock } = makeFs('{ unclosed');
      const out = await runGet('/api/references/timeline', fsMock);
      assert.equal(out.status, 500);
      assert.deepEqual(out.json, { error: 'Timeline failed' });
    });

    it('preserves the 500 when references.yaml is missing', async () => {
      const { fsMock } = makeFs('', { missing: true });
      const out = await runGet('/api/references/timeline', fsMock);
      assert.equal(out.status, 500);
      assert.deepEqual(out.json, { error: 'Timeline failed' });
    });
  });

  describe('GET /api/dashboard', () => {
    it('counts references via the memo for a populated bibliography', async () => {
      const { fsMock } = makeFs(REFS_YAML);
      const out = await runGet('/api/dashboard', fsMock);
      assert.equal(out.status, 200);
      assert.equal(out.json.content.references, 2);
    });

    it('returns 200 with content.references === 0 on a broken bibliography', async () => {
      const { fsMock } = makeFs('{ unclosed');
      const out = await runGet('/api/dashboard', fsMock);
      assert.equal(out.status, 200);
      assert.equal(out.json.content.references, 0);
    });

    it('returns 200 with content.references === 0 when references.yaml is missing', async () => {
      const { fsMock } = makeFs('', { missing: true });
      const out = await runGet('/api/dashboard', fsMock);
      assert.equal(out.status, 200);
      assert.equal(out.json.content.references, 0);
    });
  });
});
