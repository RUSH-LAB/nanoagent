import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling references suites do (tests/next-references-limit-guards.test.mjs,
// tests/next-references-add-guards.test.mjs, and
// tests/next-references-similar-hoist-targetwords.test.mjs), and reuse their
// ctx-mocking shape. This drives single GET requests over a fully mocked ctx and
// captures the response handed to json(res, status, payload).
//
// Each case pins the required-parameter 400 guard of one read handler:
//   GET /api/references/similar  (handler at line 191; guard at line 193)
//   GET /api/references/format   (handler at line 224; guard at line 227)
//   GET /api/references/search   (handler at line 244; guard at line 246)
// The non-400 paths of these handlers are already pinned by sibling suites: the
// similar 200 and 404 by the targetWords sibling, the format 200 by
// moon-citation-format-dedup and its 404 by next-references-yaml-cache, and the
// search limit guard by the limit-guards sibling. Only the missing-parameter 400
// of each was untested.
//
// Every one of these guards returns BEFORE loadReferencesCached (called at lines
// 195, 229, and 248), so a guarded request never reaches the loader and never
// reads the filesystem. The fs mock's readFileSync is a recorder that pushes to
// `reads` and then throws: it must never run, so `reads` stays empty on every
// case, and a regression that removed a guard would surface as a non-empty
// `reads` (plus a non-400 status) rather than passing silently. The real node
// `path` and a PROJECT_ROOT string round out the ctx the loader would consume,
// mirroring the sibling suites even though the loader is never reached here.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

const PROJECT_ROOT = '/proj';

async function invoke({ pathname, search = '' }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };

  let captured = null;
  const reads = [];

  const ctx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    // readFileSync must never run: the missing-parameter guard returns before
    // loadReferencesCached, so this both records the call and throws to make any
    // regression that reached the loader impossible to miss.
    fs: {
      readFileSync() {
        reads.push('read');
        throw new Error('readFileSync must not run: the missing-parameter guard returns before loadReferencesCached');
      },
    },
    path,
    PROJECT_ROOT,
  };

  await routes(req, res, url, pathname, ctx);
  return { captured, reads };
}

describe('GET references read handlers: missing-parameter 400 guards (characterization)', () => {
  it('GET /api/references/similar without a key returns 400 Missing key and never reads the filesystem', async () => {
    const { captured, reads } = await invoke({ pathname: '/api/references/similar' });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing key' });
    assert.deepEqual(reads, []);
  });

  it('GET /api/references/format without a key returns 400 Missing key and never reads the filesystem', async () => {
    const { captured, reads } = await invoke({ pathname: '/api/references/format' });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing key' });
    assert.deepEqual(reads, []);
  });

  it('GET /api/references/search without a q returns 400 Missing query and never reads the filesystem', async () => {
    // The q parameter is absent, so url.searchParams.get('q') is null and the
    // (null || '').toLowerCase().trim() expression collapses to ''.
    assert.equal(new URL('http://localhost/api/references/search').searchParams.get('q'), null);

    const { captured, reads } = await invoke({ pathname: '/api/references/search' });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing query' });
    assert.deepEqual(reads, []);
  });

  it('GET /api/references/search with an empty q returns 400 Missing query and never reads the filesystem', async () => {
    // q is present but empty, so get('q') returns the empty string (not null),
    // a branch distinct from the absent-parameter case above; it still trims to ''.
    assert.equal(new URL('http://localhost/api/references/search?q=').searchParams.get('q'), '');

    const { captured, reads } = await invoke({ pathname: '/api/references/search', search: '?q=' });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing query' });
    assert.deepEqual(reads, []);
  });

  it('GET /api/references/search with a whitespace-only q returns 400 Missing query and never reads the filesystem', async () => {
    // q is a non-empty run of spaces, so get('q') returns '   ' and only .trim()
    // reduces it to '' and trips the guard.
    assert.equal(new URL('http://localhost/api/references/search?q=%20%20%20').searchParams.get('q'), '   ');

    const { captured, reads } = await invoke({ pathname: '/api/references/search', search: '?q=%20%20%20' });

    assert.equal(captured.status, 400);
    assert.deepEqual(captured.payload, { error: 'Missing query' });
    assert.deepEqual(reads, []);
  });
});
