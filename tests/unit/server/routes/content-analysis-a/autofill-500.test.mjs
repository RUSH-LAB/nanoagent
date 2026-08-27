import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module via createRequire the
// way the sibling cached-first route suites do (next-byauthor-500,
// next-citedensity-500, next-clusters-500), so this characterization test drives
// the genuine GET /api/references/autofill handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH (content-analysis-a.js:844 through :845),
// which returns json(res, 500, {error: 'Autofill failed'}). The handler opens at
// content-analysis-a.js:787. A pre-try guard at content-analysis-a.js:789,
// if (!key) return json(res, 400, {error: 'Missing key'}), forces a ?key=K query.
// The try opens at content-analysis-a.js:790; its first statement is
// loadReferencesCached(fs, path, PROJECT_ROOT) (content-analysis-a.js:791), then
// const entry = refs[key] (content-analysis-a.js:792) and an in-try guard at
// content-analysis-a.js:793, if (!entry) return json(res, 404, {error: 'Reference
// not found'}), which forces a truthy seeded entry at that key. On success the
// handler returns json(res, 200, {key, currentEntry, suggestions}) at
// content-analysis-a.js:843, which these seams prove is never emitted.
//
// loadReferencesCached (references.js:33) is the references route's shared loader:
// path.join (references.js:34) runs OUTSIDE its internal try/catch (references.js:36
// through :57), while statSync (references.js:37) and yaml.load(readFileSync(...))
// (references.js:49) run inside it. A throwing statSync leaves stat null, so the
// cache is skipped and the file is read directly; a throwing readFileSync or
// genuinely-invalid YAML is SWALLOWED to {} (references.js:56), which makes the
// handler hit the 404 guard, NOT the 500. So the two seams below are the VERIFIED
// ways the outer catch actually fires: (a) structurally-bad-but-parseable data
// whose author is a number, so new Set(srcAuthors.map(a => a.toLowerCase())) at
// content-analysis-a.js:802 calls (123).toLowerCase() and throws a TypeError, and
// (b) a loader-level throw from a path.join that throws at references.js:34. Unlike
// the by-author precedent, a structurally-null entry will NOT do here: the in-try
// 404 guard rejects a falsy entry before any author access, so the entry must be a
// truthy object carrying a malformed (number) author.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = {
  status: 500,
  body: { error: 'Autofill failed' },
};

// The result-only keys of the success projection, the object {key, currentEntry,
// suggestions} sent by json(res, 200, ...) at content-analysis-a.js:843. The
// never-reached proof asserts that neither surfaces in any captured reply. (key is
// excluded: it is the echoed query param, not a success-only marker.)
const SUCCESS_ONLY_KEYS = ['currentEntry', 'suggestions'];

// Seam (a): STRUCTURALLY-BAD-BUT-PARSEABLE data. statSync throws so
// loadReferencesCached does not cache (stat stays null) and reads directly;
// readFileSync returns the valid YAML 'K:\n  author:\n    - 123\n', which the real
// js-yaml parses to {K: {author: [123]}}. The K entry is truthy, so the 404 guard
// passes, and then new Set(srcAuthors.map(a => a.toLowerCase())) over [123] calls
// (123).toLowerCase() (content-analysis-a.js:802) → TypeError → outer catch → 500.
// Paired with the REAL node path module so path.join succeeds and the failure is
// purely the number-author TypeError, not a loader throw.
function badDataFs() {
  return {
    statSync() { throw new Error('stat unavailable'); },
    readFileSync() { return 'K:\n  author:\n    - 123\n'; },
  };
}

// Seam (b): LOADER-LEVEL throw. A path whose .join throws makes
// loadReferencesCached throw at references.js:34 (the one op outside its internal
// try/catch) → outer catch → 500. The fs is never reached because join throws
// first, so its methods assert they stay untouched.
function throwingJoinPath() {
  return {
    join() { throw new Error('path.join unavailable'); },
  };
}
function unreachedFs() {
  return {
    statSync() { throw new Error('fs.statSync must stay unreached on seam (b)'); },
    readFileSync() { throw new Error('fs.readFileSync must stay unreached on seam (b)'); },
  };
}

// Drive the real GET /api/references/autofill handler over a mocked ctx. The caller
// supplies the fs and path seams used to steer the single try into its catch; the
// ?key=K query clears the pre-try Missing-key guard. Every json(res, status,
// payload) write is captured in `replies` so a test can assert the 500 is the ONLY
// reply and the success projection never fired. Only the ctx fields the handler
// reads on this route are supplied (json, fs, path, PROJECT_ROOT); the rest stay
// undefined because the failing path never touches them, and the cache is bypassed
// (statSync throws, so no clock dependence).
async function runAutofill({ fs, path: pathArg }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path: pathArg,
    PROJECT_ROOT,
  };
  const pathname = '/api/references/autofill';
  const url = new URL(`http://localhost${pathname}?key=K`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

describe('GET /api/references/autofill outer catch returns 500 Autofill failed', () => {
  it('maps a number-typed author (parseable YAML {K: {author: [123]}}) into the 500 reply', async () => {
    const { replies } = await runAutofill({ fs: badDataFs(), path });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact error body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Never-reached proof, anchored against a vacuous pass by the length check
    // above: no reply carries a 200 status, and none carries either result-only key
    // of the {key, currentEntry, suggestions} success projection at
    // content-analysis-a.js:843.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_ONLY_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('maps a loader-level throw (path.join throws) into the SAME 500 reply', async () => {
    const { replies } = await runAutofill({ fs: unreachedFs(), path: throwingJoinPath() });

    // path.join throws inside loadReferencesCached before any fs call, so the throw
    // escapes the loader and lands in the SAME outer catch as seam (a).
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_ONLY_KEYS.some((k) => k in r.body)),
      false,
    );
  });
});
