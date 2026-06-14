import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling route suites do (next-citedensity-500, next-clusters-500, and the
// by-venue success suite next-references-byvenue-papers-projection), so this
// characterization test drives the genuine GET /api/references/by-venue handler
// instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole grouping runs inside one try
// (handler opens at references.js:119, try at :120) with NO pre-try guard. The
// try's first failable step is the memoized load
// loadReferencesCached(fs, path, PROJECT_ROOT) at :121; it then walks
// `for (const [key, entry] of Object.entries(refs))` (:123) reading `entry.venue`
// (:124). A throw from the load, or from that walk, lands in the catch at :132 and
// :133, which returns json(res, 500, {error: 'Failed to group references by venue:
// references.yaml may be missing or contain invalid YAML syntax'}). The success 200
// projection json(res, 200, {venues, totalVenues}) at :131 is then never emitted.
//
// Reaching this 500 is subtle because loadReferencesCached SWALLOWS fs and parse
// errors: a throwing readFileSync or genuinely-invalid YAML is caught inside the
// loader, which then returns {}, so the handler walks an empty object and answers
// 200, not 500. The message's "invalid YAML syntax" claim is therefore never what
// actually fires this 500. The two seams below are the real, verified triggers.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = {
  status: 500,
  body: { error: 'Failed to group references by venue: references.yaml may be missing or contain invalid YAML syntax' },
};

// Every key the success projection returns, the object {venues, totalVenues} sent
// by json(res, 200, ...) at references.js:131. The never-reached proof asserts that
// none of them surfaces in any captured reply.
const SUCCESS_KEYS = ['venues', 'totalVenues'];

// Seam (a): STRUCTURALLY-BAD-BUT-PARSEABLE data. statSync THROWS so the loader's
// best-effort stat falls through (stat stays null, so the module cache is bypassed
// and never written), then readFileSync hands back the VALID YAML 'k:' followed by a
// newline, which the real js-yaml parses to {k: null}. The handler's
// `for (const [key, entry] of Object.entries(refs))` then dereferences the null
// entry at `entry.venue` → TypeError → outer catch → 500. This is the ONLY
// data-shaped route to this 500: malformed YAML is swallowed by the loader to {}
// (and answers 200 with an empty grouping), so the real trigger is a null parsed
// entry whose `entry.venue` member read throws a TypeError.
function structurallyBadFs() {
  let statCalls = 0;
  let readFileCalls = 0;
  return {
    get statCalls() { return statCalls; },
    get readFileCalls() { return readFileCalls; },
    statSync() { statCalls++; throw new Error('stat unavailable'); },
    readFileSync() { readFileCalls++; return 'k:\n'; },
  };
}

// Seam (b): LOADER-LEVEL throw. The fs below records its calls so the test can prove
// neither ran; the throw is injected through `path` (next factory) at the loader's
// very first statement, before any stat or read happens.
function recordingFs() {
  let statCalls = 0;
  let readFileCalls = 0;
  return {
    get statCalls() { return statCalls; },
    get readFileCalls() { return readFileCalls; },
    statSync() { statCalls++; return { mtimeMs: 0, size: 0 }; },
    readFileSync() { readFileCalls++; return 'k:\n'; },
  };
}

// A path whose join() THROWS, used ONLY for seam (b). loadReferencesCached's first
// statement is `path.join(projectRoot, 'bibliography', 'references.yaml')`
// (references.js:34), the ONLY op outside the loader's internal try/catch, so this
// throw escapes the loader and lands in the handler's outer catch.
function throwingJoinPath() {
  let joinCalls = 0;
  return {
    get joinCalls() { return joinCalls; },
    join() { joinCalls++; throw new Error('path.join unavailable'); },
  };
}

// Drive the REAL GET /api/references/by-venue handler over a mocked ctx. The caller
// supplies the `fs` and `path` seams used to steer the single try into its catch.
// Every json(res, status, payload) write is captured in `replies` so a test can
// assert the 500 is the ONLY reply and the success projection never fired.
async function runByVenue({ fs, path }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path,
    PROJECT_ROOT,
  };
  const pathname = '/api/references/by-venue';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

// The references memo is module-level state shared across the eight references
// handlers; reset it before each case so the suite stays order-independent. (Both
// seams also bypass the cache on their own: seam (a)'s statSync throws so stat=null,
// and seam (b) throws before the stat even runs.)
beforeEach(() => {
  routes._resetReferencesCache();
});

describe('GET /api/references/by-venue outer catch returns 500 Failed to group references by venue', () => {
  it('maps a structurally-null parsed entry (statSync throws, readFileSync returns valid "k:" YAML → {k:null}) into the 500 reply', async () => {
    const fs = structurallyBadFs();
    const { replies } = await runByVenue({ fs, path: nodePath });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact error-body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The loader ran fresh: it attempted the best-effort stat (which threw, so the
    // cache was bypassed) and then read and parsed the file, whose {k:null} entry the
    // handler dereferenced at entry.venue.
    assert.equal(fs.statCalls, 1, 'the loader attempted its best-effort stat');
    assert.equal(fs.readFileCalls, 1, 'the loader read the file fresh after the stat threw');
  });

  it('maps a loader-level throw (path.join throws) into the SAME 500 reply, before any stat or read', async () => {
    const fs = recordingFs();
    const path = throwingJoinPath();
    const { replies } = await runByVenue({ fs, path });

    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the loader's first statement path.join (the only op
    // outside its internal try/catch), so neither the stat nor the read ran.
    assert.equal(path.joinCalls, 1, 'the loader reached its path.join first statement');
    assert.equal(fs.statCalls, 0, 'the throw preceded the best-effort stat');
    assert.equal(fs.readFileCalls, 0, 'the throw preceded the file read');
  });

  it('never emits the success 200 {venues, totalVenues} projection on either seam', async () => {
    const seamA = await runByVenue({ fs: structurallyBadFs(), path: nodePath });
    const seamB = await runByVenue({ fs: recordingFs(), path: throwingJoinPath() });

    for (const { replies } of [seamA, seamB]) {
      // Anchor the never-reached proof so it cannot pass vacuously on an empty
      // replies array: each seam emits exactly the lone 500.
      assert.equal(replies.length, 1);
      assert.deepStrictEqual(replies[0], GOLDEN_500);

      // The never-reached proof: no reply carries a 200 status, and none carries
      // either success-projection key, so the {venues, totalVenues} returned at
      // references.js:131 was bypassed on both seams.
      assert.equal(replies.some((r) => r.status === 200), false);
      assert.equal(
        replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
        false,
      );
    }
  });
});
