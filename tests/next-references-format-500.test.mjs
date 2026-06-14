import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

// references.js is CommonJS; load the real module via createRequire the way the
// sibling cached-first route suites do (next-byauthor-500, next-formatall-500), so
// this characterization test drives the genuine GET /api/references/format handler
// instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The route opens at references.js:224. Two
// reads run BEFORE the try with no guard between them: `const key =
// url.searchParams.get('key')` (references.js:225) and `const style =
// url.searchParams.get('style') || 'apa'` (references.js:226). Then a PRE-TRY guard
// `if (!key) return json(res, 400, {error: 'Missing key'})` (references.js:227)
// short-circuits when key is absent, so every seam below passes `?key=foo` to clear
// it and actually enter the try. The try opens at references.js:228; its first
// statement is the shared bibliography load loadReferencesCached(fs, path,
// PROJECT_ROOT) (references.js:229), then `const entry = refs[key]`
// (references.js:230), the 404 branch `if (!entry) ...` (references.js:231), the
// field reads entry.author / entry.year / entry.title / entry.venue
// (references.js:232 through :235), buildCitation (references.js:236), and on success
// json(res, 200, {key, style, formatted, entry}) at references.js:237. Any throw on
// that path lands in the bindingless catch at references.js:238 and :239, which
// returns json(res, 500, {error: 'Format failed'}). Because the catch takes no
// binding, the body is a fixed string with no err.message leak.
//
// IMPORTANT (disambiguation): 'Format failed' is ALSO the golden of the SEPARATE
// GET /api/references/format-all handler (references.js:114), already pinned by
// tests/next-formatall-500.test.mjs. The dispatcher matches pathname by strict
// equality, so this suite fixes pathname to '/api/references/format' (see runFormat
// below) to drive THIS route at references.js:224, never the format-all twin.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Format failed' } };

// The reply the PRE-TRY key guard emits when ?key is omitted (references.js:227).
// Used by the guard test to prove that clearing the guard with ?key=foo is what lets
// the seams reach the 500 at all.
const GUARD_400 = { status: 400, body: { error: 'Missing key' } };

// Keys unique to the success projection json(res, 200, {key, style, formatted,
// entry}) at references.js:237. The never-reached proof asserts none of them surfaces
// in any captured reply. 'key' is deliberately excluded (no error body carries it
// either, but these three are the projection-only witnesses called out by the GOAL).
const SUCCESS_KEYS = ['formatted', 'style', 'entry'];

// Seam (a): DATA-WALK throw on a TRUTHY entry. statSync throws so
// loadReferencesCached does not cache (stat stays null) and reads fresh every call
// (no clock or cross-test cache state); readFileSync returns the valid YAML
// 'foo:\n  author:\n    - 123\n', which the real js-yaml parses to
// {foo: {author: [123]}}. The key 'foo' matches the runner's ?key=foo, so back in the
// handler `const entry = refs['foo']` is the truthy object {author: [123]}: the 404
// branch (references.js:231) is skipped, `const authors = entry.author`
// (references.js:232) is the array [123], and buildCitation('apa', ...) runs its
// one-author APA branch authors[0].split(' ') (references.js:78) on the NUMBER 123,
// throwing `123.split is not a function`. The outer catch maps it to the 500. This is
// deliberately NOT the {k: null} null-entry seam that the format-all/by-author suites
// use: here a null entry is falsy, so the lookup returns 404 (references.js:231), not
// 500. statCalls / readCalls record that both loader steps ran, so the failure is the
// data walk rather than a stubbed-away seam.
function nonStringAuthorFs() {
  let statCalls = 0;
  let readCalls = 0;
  return {
    get statCalls() { return statCalls; },
    get readCalls() { return readCalls; },
    statSync() { statCalls++; throw new Error('stat unavailable'); },
    readFileSync() { readCalls++; return 'foo:\n  author:\n    - 123\n'; },
  };
}

// Seam (b): LOADER-LEVEL throw. loadReferencesCached's only statement OUTSIDE its own
// try/catch is path.join(projectRoot, 'bibliography', 'references.yaml')
// (references.js:34), so a path stub whose join() throws makes the loader itself throw
// at its very first op, ahead of any fs access; the throw propagates out of
// loadReferencesCached into the handler's outer catch. joinCalls records that the
// throwing join is what fired. This is the seam empirically proven in the GOAL.
function throwingJoinPath() {
  let joinCalls = 0;
  return {
    get joinCalls() { return joinCalls; },
    join() { joinCalls++; throw new Error('path.join unavailable'); },
  };
}

// A recording fs whose statSync / readFileSync count their calls and otherwise throw.
// Paired with the throwing-join path (seam b) it proves the loader never reached any
// fs access (both counters stay 0) because path.join threw first.
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

// Drive the real GET /api/references/format handler over a mocked ctx. The caller
// supplies the two injectable seams the handler reads through, `fs` and `path`; the
// remaining ctx fields this route touches are `json` and PROJECT_ROOT. `query`
// defaults to '?key=foo' so the pre-try Missing-key guard (references.js:227) is
// cleared and the try is entered; the guard test overrides it with ''. Every
// json(res, status, payload) write is captured in `replies` so a test can assert the
// 500 is the ONLY reply and the 200 projection never fired. The pathname is fixed to
// /api/references/format so this never exercises the format-all twin that shares the
// 'Format failed' text.
async function runFormat({ fs, path, query = '?key=foo' }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path,
    PROJECT_ROOT,
  };
  const pathname = '/api/references/format';
  const url = new URL(`http://localhost${pathname}${query}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

describe('GET /api/references/format outer catch returns 500 Format failed', () => {
  it('maps a data-walk throw (non-string author makes buildCitation throw) into the lone 500 reply', async () => {
    const fs = nonStringAuthorFs();
    const { replies } = await runFormat({ fs, path: nodePath });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Format failed'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Both loader steps ran: statSync threw (cache skipped) and the file was read
    // fresh, so the throw is the handler's data walk, not a stubbed-away seam.
    assert.equal(fs.statCalls, 1, 'loadReferencesCached stat-probed once');
    assert.equal(fs.readCalls, 1, 'loadReferencesCached read the bibliography once');

    // Never-reached proof, anchored against a vacuous pass by the length check above:
    // no reply carries a 200 status (the success projection at references.js:237) nor
    // a 404 (the not-found branch at references.js:231 the truthy entry skipped), and
    // none carries any projection-only key, so json(res, 200, {key, style, formatted,
    // entry}) was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(replies.some((r) => r.status === 404), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('maps a loader-level throw (path.join) into the SAME lone 500, before any fs access', async () => {
    const fs = untouchedFs();
    const path = throwingJoinPath();
    const { replies } = await runFormat({ fs, path });

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
    assert.equal(replies.some((r) => r.status === 404), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('emits a byte-identical lone 500 on both seams (the two failure origins converge)', async () => {
    const a = await runFormat({ fs: nonStringAuthorFs(), path: nodePath });
    const b = await runFormat({ fs: untouchedFs(), path: throwingJoinPath() });

    assert.equal(a.replies.length, 1);
    assert.equal(b.replies.length, 1);
    assert.deepStrictEqual(a.replies[0], GOLDEN_500);
    assert.deepStrictEqual(b.replies, a.replies);
  });

  it('returns the pre-try 400 Missing-key guard when ?key is omitted (so clearing it is load-bearing for the 500)', async () => {
    // With no ?key, the guard at references.js:227 fires BEFORE the try opens. Pair it
    // with the throwing-join path (seam b) to prove the guard wins regardless: the
    // loader that would 500 is never entered, so the lone reply is the 400, not the
    // 500. This is why every 500 seam above must pass ?key=foo.
    const fs = untouchedFs();
    const path = throwingJoinPath();
    const { replies } = await runFormat({ fs, path, query: '' });

    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GUARD_400);

    // The try was never entered: the loader's path.join and the fs seams stayed
    // untouched, confirming the guard short-circuits ahead of references.js:228.
    assert.equal(path.joinCalls, 0, 'guard returned before the loader ran');
    assert.equal(fs.statCalls, 0, 'guard returned before any fs access');
    assert.equal(fs.readCalls, 0, 'guard returned before any fs access');

    // It is the 400 guard, not a 500/404/200: the only reply is exactly GUARD_400.
    assert.equal(replies.some((r) => r.status === 500), false);
    assert.equal(replies.some((r) => r.status === 404), false);
    assert.equal(replies.some((r) => r.status === 200), false);
  });
});
