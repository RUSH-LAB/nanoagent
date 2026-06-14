import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the real module via createRequire the way the
// sibling cached-first route suites do (next-byauthor-500, next-byvenue-500),
// so this characterization test drives the genuine GET /api/references/similar
// handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH (references.js:218 through :219), which
// returns json(res, 500, {error: 'Similar papers search failed'}). The route opens
// with a PRE-TRY guard, if (!key) return json(res, 400, {error: 'Missing key'})
// (references.js:193), so every seam passes ?key=K. The try opens at
// references.js:194; its first statement is loadReferencesCached(fs, path,
// PROJECT_ROOT) (references.js:195), then const target = refs[key] gated by
// if (!target) return json(res, 404, {error: 'Reference not found'})
// (references.js:197), so seam (a)'s seeded refs must hold a truthy entry at K. On
// success it returns json(res, 200, {key, similar}) at references.js:217, which
// these seams prove is never emitted.
//
// loadReferencesCached (references.js:33) swallows fs and parse errors: its
// fs.statSync is try/caught (→ null on throw, so the cache is skipped and the file
// is read directly) and its yaml.load(fs.readFileSync(...)) is try/caught (→ {} on
// ANY read or parse error). So a throwing readFileSync, or genuinely-invalid YAML,
// is SWALLOWED to {}, after which refs[key] is undefined and the handler 404s, NOT
// 500. The two seams below are the VERIFIED ways the outer catch actually fires: a
// structurally-bad-but-parseable entry whose author list holds a non-string, and a
// loader-level throw raised by path.join before the loader's internal try/catch.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

const PROJECT_ROOT = '/virtual-root';

// The lookup key shared by every seam. It clears the pre-try !key guard and, on
// seam (a), names the seeded entry so the 404 guard passes and execution reaches
// the throwing author map at references.js:198.
const KEY = 'K';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = {
  status: 500,
  body: { error: 'Similar papers search failed' },
};

// Every key the success projection returns, the object {key, similar} sent by
// json(res, 200, ...) at references.js:217. The never-reached proof asserts that
// none of them surfaces in any captured reply.
const SUCCESS_KEYS = ['key', 'similar'];

// Seam (a): STRUCTURALLY-BAD-BUT-PARSEABLE data. statSync throws so
// loadReferencesCached does not cache (stat stays null) and reads directly;
// readFileSync returns the valid YAML 'K:\n  author:\n    - 123\n', which the real
// js-yaml parses to {K: {author: [123]}}. The entry at K is truthy (clears the 404
// guard) but its author list holds the number 123, so
// new Set((target.author || []).map(a => a.toLowerCase())) (references.js:198)
// calls (123).toLowerCase() → TypeError → outer catch → 500. Paired with the REAL
// node path module so path.join succeeds and the failure is purely the throwing
// map, not a loader throw.
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

// Drive the real GET /api/references/similar handler over a mocked ctx. The caller
// supplies the fs and path seams used to steer the single try into its catch. Every
// json(res, status, payload) write is captured in `replies` so a test can assert the
// 500 is the ONLY reply and the success projection never fired. Only the ctx fields
// the handler reads on this route are supplied (json, fs, path, PROJECT_ROOT); the
// rest stay undefined because the failing path never touches them, and the cache is
// bypassed (statSync throws, so no clock dependence).
async function runSimilar({ fs, path: pathArg }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path: pathArg,
    PROJECT_ROOT,
  };
  const pathname = '/api/references/similar';
  const url = new URL(`http://localhost${pathname}?key=${KEY}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

describe('GET /api/references/similar outer catch returns 500 Similar papers search failed', () => {
  it('maps a structurally-bad parsed entry (author list holds a non-string) into the 500 reply', async () => {
    const { replies } = await runSimilar({ fs: badDataFs(), path });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact error body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Never-reached proof, anchored against a vacuous pass by the length check
    // above: no reply carries a 200 status, and none carries either key of the
    // {key, similar} success projection returned at references.js:217.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('maps a loader-level throw (path.join throws) into the SAME 500 reply', async () => {
    const { replies } = await runSimilar({ fs: unreachedFs(), path: throwingJoinPath() });

    // path.join throws inside loadReferencesCached before any fs call, so the throw
    // escapes the loader and lands in the SAME outer catch as seam (a).
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });
});
