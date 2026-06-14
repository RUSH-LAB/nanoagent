import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load the REAL module via createRequire the way the
// sibling cached-first route suites do (next-citedensity-500 / next-clusters-500),
// so this characterization test drives the genuine
// GET /api/references/year-distribution handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole aggregation runs inside one try
// (handler opens at references.js:159, try at :160) with NO pre-try guard. The
// try's first statement is `const refs = loadReferencesCached(fs, path, PROJECT_ROOT)`
// (references.js:161); it then walks `for (const entry of Object.values(refs))`
// (:164) reading `entry.year` (:165) and `entry.venue` (:167), and on success
// returns `json(res, 200, {years, topVenues, totalReferences, unknownYear})` (:179).
// Any throw reaching the catch at :185 through :186 returns
// `json(res, 500, {error: 'Year distribution failed'})`, and the 200 projection is
// never emitted.
//
// CRITICAL — how the 500 is actually reached. loadReferencesCached (references.js:33)
// swallows fs and parse errors: its only op outside an internal try/catch is
// `path.join(projectRoot, 'bibliography', 'references.yaml')` (:34); a throwing
// statSync falls through to stat=null (no cache), and a throwing readFileSync or
// genuinely-invalid YAML is caught and returned as {}, so the handler walks an empty
// object and returns 200, NOT 500. (The sibling next-references-yeardist-filedraft
// suite pins exactly that 200-empty-on-read-throw behavior.) This 500 golden is
// therefore net-new, reached the two VERIFIED ways exercised below.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/references.js');
const { _resetReferencesCache } = routes;

const PROJECT_ROOT = '/virtual-root';

// The exact reply the outer catch emits, in the {status, body} shape captured by the
// json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Year distribution failed' } };

// Every key the success projection returns: the {years, topVenues, totalReferences,
// unknownYear} object sent by json(res, 200, ...) at references.js:179. The
// never-reached proof asserts none of them surfaces in any captured reply.
const SUCCESS_KEYS = ['years', 'topVenues', 'totalReferences', 'unknownYear'];

// loadReferencesCached memoizes in module scope; reset before each case so a run is
// hermetic regardless of order. Both seams below leave the cache null anyway — seam
// (a) because statSync throws so stat=null, seam (b) because path.join throws before
// any cache access — but the reset makes that independent of execution order.
beforeEach(() => { _resetReferencesCache(); });

// Drive the real GET /api/references/year-distribution handler over a mocked ctx.
// The caller supplies the two seams used to steer the single try into its catch:
// `fs` and `path`. Every json(res, status, body) write is captured in `replies` so a
// test can assert the 500 is the ONLY reply and the success projection never fired.
// Fully in-process: no network, no server, no real disk, no clock or randomness.
async function runYearDist({ fs, path: pathDep }) {
  const replies = [];
  const ctx = {
    json(_res, status, body) { const r = { status, body }; replies.push(r); return r; },
    fs,
    path: pathDep,
    PROJECT_ROOT,
  };
  const pathname = '/api/references/year-distribution';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return replies;
}

// ── Seam (a): structurally-bad-but-PARSEABLE data ──
// statSync throws, so the loader does not cache (stat=null) and reads directly;
// readFileSync returns the valid YAML 'k:\n', which the real js-yaml parses to
// {k: null}. The handler's `for (const entry of Object.values(refs))` then
// dereferences the null entry at `entry.year` (references.js:165) → TypeError →
// outer catch → 500. Calls are recorded so the seam mechanics are pinned.
function structurallyNullFs() {
  let statCalls = 0;
  let readCalls = 0;
  let lastEncoding;
  return {
    get statCalls() { return statCalls; },
    get readCalls() { return readCalls; },
    get lastEncoding() { return lastEncoding; },
    statSync() { statCalls++; throw new Error('statSync unavailable'); },
    readFileSync(_file, encoding) { readCalls++; lastEncoding = encoding; return 'k:\n'; },
  };
}

// ── Seam (b): loader-level throw ──
// path.join throws on its first call, so loadReferencesCached throws at
// references.js:34 (its only statement outside the internal try/catch) before any fs
// access → outer catch → 500. fs accesses are counted to prove it is never touched.
function throwingJoinPath() {
  let joinCalls = 0;
  return {
    get joinCalls() { return joinCalls; },
    join() { joinCalls++; throw new Error('path.join unavailable'); },
  };
}

function recordingUntouchedFs() {
  let touched = 0;
  return {
    get touched() { return touched; },
    statSync() { touched++; return {}; },
    readFileSync() { touched++; return ''; },
  };
}

// The two VERIFIED seams that reach the outer catch, each rebuilt fresh per use so
// recording stubs never carry state between assertions.
const SEAMS = [
  {
    name: 'structurally-null parsed data (statSync throws, readFileSync gives "k:\\n" parsed to {k:null})',
    make: () => ({ fs: structurallyNullFs(), path }),
  },
  {
    name: 'loader-level path.join throw',
    make: () => ({ fs: recordingUntouchedFs(), path: throwingJoinPath() }),
  },
];

describe('GET /api/references/year-distribution outer catch returns 500 Year distribution failed', () => {
  it('maps a structurally-null parsed entry into the lone 500 reply (statSync throws, "k:\\n" → {k:null})', async () => {
    const fs = structurallyNullFs();
    const replies = await runYearDist({ fs, path });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Year distribution failed'} body.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // Seam mechanics: statSync was consulted once and threw (so the cache was
    // bypassed, stat=null), then the loader read the file exactly once as utf8 and
    // js-yaml turned 'k:\n' into {k:null}, whose null entry the handler dereferenced.
    assert.equal(fs.statCalls, 1, 'statSync consulted once (threw → stat=null, cache bypassed)');
    assert.equal(fs.readCalls, 1, 'the file was read exactly once after the stat miss');
    assert.equal(fs.lastEncoding, 'utf8', 'references.yaml is read as utf8 text');
  });

  it('maps a loader-level path.join throw into the same lone 500 reply, never touching fs', async () => {
    const fs = recordingUntouchedFs();
    const pathDep = throwingJoinPath();
    const replies = await runYearDist({ fs, path: pathDep });

    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at loadReferencesCached's path.join (references.js:34),
    // the only op outside its internal try/catch, before any fs access.
    assert.equal(pathDep.joinCalls, 1, 'path.join was called once and threw');
    assert.equal(fs.touched, 0, 'fs is never reached: the loader throws before statSync/readFileSync');
  });

  it('never emits the success 200 {years, topVenues, totalReferences, unknownYear} projection on either seam', async () => {
    for (const seam of SEAMS) {
      const replies = await runYearDist(seam.make());

      // Anchor the never-reached proof so it cannot pass vacuously on an empty
      // replies array: each seam emits exactly the lone 500.
      assert.equal(replies.length, 1, `seam "${seam.name}": exactly one reply`);
      assert.deepStrictEqual(replies[0], GOLDEN_500, `seam "${seam.name}": the lone reply is the 500 golden`);

      // The never-reached proof: no reply carries a 200 status, and none carries any
      // of the success-projection keys, so the {years, topVenues, totalReferences,
      // unknownYear} object returned at references.js:179 was bypassed.
      assert.equal(
        replies.some((r) => r.status === 200),
        false,
        `seam "${seam.name}": no 200 reply`,
      );
      assert.equal(
        replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
        false,
        `seam "${seam.name}": no success-projection key in any reply body`,
      );
    }
  });
});
