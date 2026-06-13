import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling enrich-POST suite (tests/next-references-enrich-post-guards.test.mjs)
// and the loadReferencesCached suite (tests/next-study-references-loadcached.test.mjs)
// do, and reuse their ctx-mocking shape. This drives GET /api/references/enrich
// (the metadata-fetch handler that shells out to curl for Semantic Scholar,
// Crossref, and DBLP) directly over a mocked ctx with recorders, so there is no
// network and no real filesystem is touched. The POST sibling at the same path is
// already covered; the GET handler was previously driven by no test at all.
//
// Every case here pins one of the three guard rungs that reject BEFORE the
// execFileSync('curl', ...) call at line 544. The first (missing key param)
// returns at line 519 before the try block, so it is fully hermetic and never
// touches fs. The second (reference not found, line 524) and third (reference has
// no title, line 527) read the bibliography through loadReferencesCached and
// reject before curlJSON runs. A stat-less fs mock (only readFileSync) makes
// loadReferencesCached fall through to a fresh read per case and never memoize,
// and _resetReferencesCache clears the module-level memo between cases as a
// belt-and-suspenders reset.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');
const { _resetReferencesCache } = require('../server/routes/references.js');
const yaml = require('js-yaml');

const PROJECT_ROOT = '/proj';

// Invoke the GET enrich handler with a mocked ctx. `reads` records each
// references.yaml read performed by loadReferencesCached (the stat-less fs forces
// a fresh read every call), so an empty `reads` array proves the pre-try guard
// never reached the loader. `curlCalls` records every execFileSync invocation so a
// test can prove the curl network call is never reached; the stand-in also throws,
// so even a regression that reached it could not spawn a real curl subprocess.
// readFileSync returns `bibYaml` verbatim (a YAML string the real js-yaml parses).
async function invoke({ key, bibYaml = '{}' }) {
  const pathname = '/api/references/enrich';
  const qs = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
  const url = new URL(`http://localhost${pathname}${qs}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };

  let captured = null;
  const reads = [];
  const curlCalls = [];

  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    // Stat-less fs: no statSync, so loadReferencesCached falls through to a fresh
    // read on every call and never populates the module-level memo.
    fs: {
      readFileSync: () => { reads.push('read'); return bibYaml; },
    },
    execFileSync: (...args) => { curlCalls.push(args); throw new Error('curl must not run in a pre-curl guard test'); },
    path,
    PROJECT_ROOT,
  };

  await routes(req, res, url, pathname, ctx);
  return { captured, reads, curlCalls };
}

// The shared memo lives at references.js module scope; start every case clean.
beforeEach(() => _resetReferencesCache());

describe('GET /api/references/enrich pre-curl guard rungs characterization', () => {
  it('returns 400 Missing key param and touches neither fs nor curl when the key query parameter is omitted', async () => {
    const { captured, reads, curlCalls } = await invoke({ key: undefined });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing key param' });
    // This rung returns before the try block, so loadReferencesCached never runs
    // and the bibliography is never read.
    assert.deepEqual(reads, []);
    assert.equal(curlCalls.length, 0);
  });

  it('returns 404 with the templated message, reading the bibliography but never curling, when the key is absent', async () => {
    const bibYaml = 'other: {}\n';
    const { captured, reads, curlCalls } = await invoke({ key: 'ghost2023', bibYaml });

    assert.equal(captured.status, 404);
    assert.deepEqual(captured.payload, { error: 'Reference "ghost2023" not found' });
    // loadReferencesCached read the bibliography once; the missing key rejects
    // before curlJSON runs.
    assert.deepEqual(reads, ['read']);
    assert.equal(curlCalls.length, 0);
    // The fixture truly lacks the requested key, so the 404 is the missing-entry
    // branch and not an empty or broken parse.
    const oracle = yaml.load(bibYaml);
    assert.equal(oracle.ghost2023, undefined);
  });

  it('returns 400 Reference has no title when the entry exists but carries no title, never curling', async () => {
    const bibYaml = 'notitle2022:\n  year: 2022\n  venue: NeurIPS\n';
    const { captured, reads, curlCalls } = await invoke({ key: 'notitle2022', bibYaml });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Reference has no title to search for' });
    // The entry was found (so the bibliography was read) but has no title, so the
    // handler rejects before curlJSON runs.
    assert.deepEqual(reads, ['read']);
    assert.equal(curlCalls.length, 0);
    // The fixture is genuinely an existing entry with no title field, so this is
    // the no-title branch and not the missing-entry 404 above it.
    const oracle = yaml.load(bibYaml);
    assert.notEqual(oracle.notitle2022, undefined);
    assert.equal(oracle.notitle2022.title, undefined);
  });
});
