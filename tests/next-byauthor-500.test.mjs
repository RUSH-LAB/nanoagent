import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the real module via createRequire the way the
// sibling cached-first route suites do (next-citedensity-500, next-clusters-500),
// so this characterization test drives the genuine GET /api/references/by-author
// handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH (references.js:153 through :154), which
// returns json(res, 500, {error: 'Failed to group references by author:
// references.yaml may be missing or contain invalid YAML syntax'}). The try opens
// at references.js:139 with NO pre-try guard; its first statement is
// loadReferencesCached(fs, path, PROJECT_ROOT) (references.js:140), then it walks
// for (const [key, entry] of Object.entries(refs)) (references.js:142) and inside
// it for (const author of (entry.author || UNKNOWN_AUTHORS)) (references.js:143).
// On success it returns json(res, 200, {authors, totalAuthors}) at
// references.js:152, which these seams prove is never emitted. (numericParam at
// references.js:151 is a module-level helper, not a ctx field, and is never
// reached on the failing seams.)
//
// loadReferencesCached (references.js:33) swallows fs and parse errors: its
// fs.statSync is try/caught (→ null on throw, so the cache is skipped and the file
// is read directly) and its yaml.load(fs.readFileSync(...)) is try/caught (→ {} on
// ANY read or parse error). So a throwing readFileSync, or genuinely-invalid YAML,
// is SWALLOWED to {} and the handler walks an empty object and returns 200, NOT
// 500. The two seams below are the VERIFIED ways the outer catch actually fires;
// note the worth-recording mismatch that the message blames "invalid YAML syntax"
// yet invalid YAML is swallowed to 200, so only a structurally-null parsed entry
// or a loader-level throw really reaches this 500.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = {
  status: 500,
  body: { error: 'Failed to group references by author: references.yaml may be missing or contain invalid YAML syntax' },
};

// Every key the success projection returns, the object {authors, totalAuthors}
// sent by json(res, 200, ...) at references.js:152. The never-reached proof
// asserts that none of them surfaces in any captured reply.
const SUCCESS_KEYS = ['authors', 'totalAuthors'];

// Seam (a): STRUCTURALLY-BAD-BUT-PARSEABLE data. statSync throws so
// loadReferencesCached does not cache (stat stays null) and reads directly;
// readFileSync returns the valid YAML 'k:\n', which the real js-yaml parses to
// {k: null}. The handler's for…of then dereferences the null entry at
// entry.author (references.js:143) → TypeError → outer catch → 500. Paired with
// the REAL node path module so path.join succeeds and the failure is purely the
// null deref, not a loader throw.
function badDataFs() {
  return {
    statSync() { throw new Error('stat unavailable'); },
    readFileSync() { return 'k:\n'; },
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

// Drive the real GET /api/references/by-author handler over a mocked ctx. The
// caller supplies the fs and path seams used to steer the single try into its
// catch. Every json(res, status, payload) write is captured in `replies` so a test
// can assert the 500 is the ONLY reply and the success projection never fired.
// Only the ctx fields the handler reads on this route are supplied (json, fs, path,
// PROJECT_ROOT); the rest stay undefined because the failing path never touches
// them, and the cache is bypassed (statSync throws, so no clock dependence).
async function runByAuthor({ fs, path: pathArg }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path: pathArg,
    PROJECT_ROOT,
  };
  const pathname = '/api/references/by-author';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

describe('GET /api/references/by-author outer catch returns 500 Failed to group references by author', () => {
  it('maps a structurally-null parsed entry (parseable YAML {k: null}) into the 500 reply', async () => {
    const { replies } = await runByAuthor({ fs: badDataFs(), path });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact error body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Never-reached proof, anchored against a vacuous pass by the length check
    // above: no reply carries a 200 status, and none carries either key of the
    // {authors, totalAuthors} success projection returned at references.js:152.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('maps a loader-level throw (path.join throws) into the SAME 500 reply', async () => {
    const { replies } = await runByAuthor({ fs: unreachedFs(), path: throwingJoinPath() });

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
