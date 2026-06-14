import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

// references.js is CommonJS; load the real module via createRequire the way the
// sibling cached-first route suites do (next-citedensity-500, next-clusters-500),
// so this characterization test drives the genuine GET /api/references/format-all
// handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. `const style = url.searchParams.get('style')
// || 'apa'` (references.js:99) runs BEFORE the try with no guard, so omitting the
// ?style param simply defaults style to 'apa'. The try opens at references.js:100
// and its first statement is the shared bibliography load
// loadReferencesCached(fs, path, PROJECT_ROOT) (references.js:101); the handler
// then walks `for (const [key, entry] of Object.entries(refs))` (references.js:103)
// reading entry.author / entry.year / entry.title / entry.venue and calling
// buildCitation, and on success returns json(res, 200, {style, references, total})
// at references.js:112. Any throw on that path lands in the catch at references.js:113
// and :114, which returns json(res, 500, {error: 'Format failed'}).
//
// IMPORTANT: 'Format failed' is ALSO the golden of the SEPARATE
// GET /api/references/format handler (references.js:239), so this suite drives the
// /api/references/format-all pathname SPECIFICALLY (see runFormatAll below) to pin
// THAT route, never /api/references/format.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Format failed' } };

// Every key the success projection returns, the object {style, references, total}
// sent by json(res, 200, ...) at references.js:112. The never-reached proof asserts
// that none of them surfaces in any captured reply.
const SUCCESS_KEYS = ['style', 'references', 'total'];

// Seam (a): structurally-bad-but-parseable bibliography. loadReferencesCached only
// consults or fills its memo when statSync succeeds (references.js:41 through :52),
// so a throwing statSync forces stat=null: the cache branch is skipped and the
// loader reads the file fresh every call (no clock or cross-test cache state).
// readFileSync then returns the VALID one-line YAML document 'k:\n', which the real
// js-yaml parses to {k: null}. Back in the handler, Object.entries({k: null}) yields
// the pair ['k', null], and the first field read `const authors = entry.author`
// (references.js:104) dereferences that null entry, throwing a TypeError the outer
// catch maps to the 500. statCalls / readCalls record that both loader steps ran, so
// the failure is the data walk rather than a stubbed-away seam.
function structurallyBadFs() {
  let statCalls = 0;
  let readCalls = 0;
  return {
    get statCalls() { return statCalls; },
    get readCalls() { return readCalls; },
    statSync() { statCalls++; throw new Error('stat unavailable'); },
    readFileSync() { readCalls++; return 'k:\n'; },
  };
}

// Seam (b): loader-level throw. loadReferencesCached's only statement OUTSIDE its
// own try/catch is path.join(projectRoot, 'bibliography', 'references.yaml')
// (references.js:34), so a path stub whose join() throws makes the loader itself
// throw at its very first op, ahead of any fs access; the throw propagates out of
// loadReferencesCached into the handler's outer catch. joinCalls records that the
// throwing join is what fired.
function throwingJoinPath() {
  let joinCalls = 0;
  return {
    get joinCalls() { return joinCalls; },
    join() { joinCalls++; throw new Error('path.join unavailable'); },
  };
}

// A recording fs whose statSync / readFileSync count their calls and otherwise
// throw. Paired with the throwing-join path (seam b) it proves the loader never
// reached any fs access (both counters stay 0) because path.join threw first.
function untouchedFs() {
  let statCalls = 0;
  let readCalls = 0;
  return {
    get statCalls() { return statCalls; },
    get readCalls() { return readCalls; },
    statSync() { statCalls++; throw new Error('statSync should not be reached'); },
    readFileSync() { readCalls++; throw new Error('readFileSync should not be reached'); },
  };
}

// Drive the real GET /api/references/format-all handler over a mocked ctx. The
// caller supplies the two injectable seams the handler reads through, `fs` and
// `path`; the remaining ctx fields this route touches are `json` and PROJECT_ROOT.
// Every json(res, status, payload) write is captured in `replies` so a test can
// assert the 500 is the ONLY reply and the 200 projection never fired. The pathname
// is fixed to /api/references/format-all so this never exercises the separate
// /api/references/format handler that shares the 'Format failed' text.
async function runFormatAll({ fs, path }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path,
    PROJECT_ROOT,
  };
  const pathname = '/api/references/format-all';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

describe('GET /api/references/format-all outer catch returns 500 Format failed', () => {
  it('maps a structurally-bad {k: null} bibliography (null entry deref) into the lone 500 reply', async () => {
    const fs = structurallyBadFs();
    const { replies } = await runFormatAll({ fs, path: nodePath });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Format failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Both loader steps ran: statSync threw (cache skipped) and the file was read
    // fresh, so the throw is the handler's null-entry walk, not a stubbed-away seam.
    assert.equal(fs.statCalls, 1, 'loadReferencesCached stat-probed once');
    assert.equal(fs.readCalls, 1, 'loadReferencesCached read the bibliography once');

    // Never-reached proof: no reply carries a 200 status and none carries any
    // success-projection key, so json(res, 200, {style, references, total}) at
    // references.js:112 was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('maps a loader-level throw (path.join) into the SAME lone 500, before any fs access', async () => {
    const fs = untouchedFs();
    const path = throwingJoinPath();
    const { replies } = await runFormatAll({ fs, path });

    // Same golden as seam (a), proving the 500 is independent of WHERE in the try the
    // throw originates (here the loader's first op, not the data walk).
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throwing join is what fired, and it fired before any fs access: the loader
    // throws at references.js:34, ahead of statSync / readFileSync.
    assert.ok(path.joinCalls > 0, 'loadReferencesCached called the throwing path.join');
    assert.equal(fs.statCalls, 0, 'no statSync: path.join threw first');
    assert.equal(fs.readCalls, 0, 'no readFileSync: path.join threw first');

    // Never-reached proof on this seam too.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('emits a byte-identical lone 500 on both seams (the two failure origins converge)', async () => {
    const a = await runFormatAll({ fs: structurallyBadFs(), path: nodePath });
    const b = await runFormatAll({ fs: untouchedFs(), path: throwingJoinPath() });

    assert.equal(a.replies.length, 1);
    assert.equal(b.replies.length, 1);
    assert.deepStrictEqual(a.replies[0], GOLDEN_500);
    assert.deepStrictEqual(b.replies, a.replies);
  });
});
