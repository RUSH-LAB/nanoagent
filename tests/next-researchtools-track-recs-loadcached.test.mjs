import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');
// loadReferencesCached memoizes in a module-level singleton; clear it between
// scenarios so each case re-stats and re-reads deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// Two entries carrying no arXiv id, url, doi, or paperId. That keeps both GET
// handlers on a deterministic, network-free branch: GET /api/references/track
// finds the entry but reports no arXiv id, and GET /api/recommendations finds no
// seedable paper id and returns an empty list. Neither reaches Semantic Scholar.
const REFS_YAML = `ref_a:
  type: article
  title: First Paper
  author:
    - Ada Lovelace
  year: 2020
  venue: NeurIPS
ref_b:
  title: Second Paper
  author:
    - Alan Turing
  year: 2021
  venue: Workshop X
`;

// An fs mock serving `yamlText` for references.yaml; every other path is ENOENT
// so a stray read surfaces instead of returning silent empty data. statSync
// returns a stable {mtimeMs, size} so loadReferencesCached's memo key holds
// across calls, and `reads` counts references.yaml reads so the memo can be
// asserted.
function makeFs(yamlText) {
  const state = { reads: 0 };
  const fsMock = {
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: yamlText.length };
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) { state.reads++; return yamlText; }
      const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
    },
  };
  return { fsMock, state };
}

// Drive a real GET handler in research-tools.js over a mocked ctx and capture
// the json() response. The fs mock exposes statSync + readFileSync so the memo
// path in loadReferencesCached is exercised the way the live server hits it.
async function runGet(pathname, search, fsMock) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    rateLimit: () => true,
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const url = new URL(`http://localhost${pathname}${search}`);
  const res = {
    writableEnded: false,
    writeHead() {},
    end() { this.writableEnded = true; },
  };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await researchToolsRoutes(req, res, url, pathname, ctx);
  return out;
}

const runTrack = (fsMock, key) =>
  runGet('/api/references/track', `?key=${encodeURIComponent(key)}`, fsMock);
const runRecs = (fsMock) => runGet('/api/recommendations', '', fsMock);

describe('GET /api/references/track (refs via loadReferencesCached)', () => {
  beforeEach(() => _resetReferencesCache());

  it('looks the key up in the memoized bibliography (no arXiv id branch)', async () => {
    const { fsMock } = makeFs(REFS_YAML);
    const out = await runTrack(fsMock, 'ref_a');
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { published: false, error: 'No arXiv ID found for this reference' });
  });

  it('returns 404 for a key absent from the bibliography', async () => {
    const { fsMock } = makeFs(REFS_YAML);
    const out = await runTrack(fsMock, 'nope');
    assert.equal(out.status, 404);
    assert.deepEqual(out.json, { error: 'Reference not found' });
  });

  it('memoizes the parse: a second track does not re-read references.yaml', async () => {
    const { fsMock, state } = makeFs(REFS_YAML);
    const first = await runTrack(fsMock, 'ref_a');
    const second = await runTrack(fsMock, 'ref_a');
    assert.deepEqual(first.json, { published: false, error: 'No arXiv ID found for this reference' });
    assert.deepEqual(second.json, first.json);
    assert.equal(state.reads, 1, 'second track is served from the memo, not a re-read');
  });

  it('preserves the 500 fallback on a broken parse', async () => {
    const { fsMock } = makeFs('{ unclosed');
    const out = await runTrack(fsMock, 'ref_a');
    assert.equal(out.status, 500);
    assert.match(out.json.error, /Track check failed/);
  });

  it('preserves the 500 fallback when references.yaml is missing', async () => {
    const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
    const out = await runTrack({ statSync: enoent, readFileSync: enoent }, 'ref_a');
    assert.equal(out.status, 500);
    assert.match(out.json.error, /Track check failed/);
  });

  it('returns 404 (not 500) for an empty but valid bibliography', async () => {
    const { fsMock } = makeFs('{}');
    const out = await runTrack(fsMock, 'ref_a');
    assert.equal(out.status, 404);
    assert.deepEqual(out.json, { error: 'Reference not found' });
  });
});

describe('GET /api/recommendations (refs via loadReferencesCached)', () => {
  beforeEach(() => _resetReferencesCache());

  it('returns an empty list when no entry has a seedable paper id', async () => {
    const { fsMock } = makeFs(REFS_YAML);
    const out = await runRecs(fsMock);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { recommendations: [] });
  });

  it('memoizes the parse: a second request does not re-read references.yaml', async () => {
    const { fsMock, state } = makeFs(REFS_YAML);
    const first = await runRecs(fsMock);
    const second = await runRecs(fsMock);
    assert.deepEqual(first.json, { recommendations: [] });
    assert.deepEqual(second.json, first.json);
    assert.equal(state.reads, 1, 'second request is served from the memo, not a re-read');
  });

  it('preserves the 500 fallback on a broken parse', async () => {
    const { fsMock } = makeFs('{ unclosed');
    const out = await runRecs(fsMock);
    assert.equal(out.status, 500);
    assert.match(out.json.error, /Failed to fetch recommendations/);
  });

  it('preserves the 500 fallback when references.yaml is missing', async () => {
    const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
    const out = await runRecs({ statSync: enoent, readFileSync: enoent });
    assert.equal(out.status, 500);
    assert.match(out.json.error, /Failed to fetch recommendations/);
  });

  it('returns an empty list (200) for an empty but valid bibliography', async () => {
    const { fsMock } = makeFs('{}');
    const out = await runRecs(fsMock);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { recommendations: [] });
  });
});

// The memo is one shared singleton across every references reader, so a track
// lookup and a recommendations request over the same file parse it exactly once
// between them, not once each.
describe('shared memo across both GET handlers', () => {
  beforeEach(() => _resetReferencesCache());

  it('parses references.yaml once across a track and a recommendations call', async () => {
    const { fsMock, state } = makeFs(REFS_YAML);
    await runTrack(fsMock, 'ref_a');
    await runRecs(fsMock);
    assert.equal(state.reads, 1, 'the second handler reuses the first handler memo');
  });
});
