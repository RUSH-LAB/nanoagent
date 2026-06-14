import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load the REAL route module via createRequire the
// way the sibling route suites do. next-importbibtex-guards.test.mjs drives this
// exact POST /api/references/import-bibtex handler (its 429 gate, the two early 400
// body guards, and the 200 success / skip paths) but never reaches the OUTER catch,
// and no test pins the 'BibTeX import failed' string. This is an add-only
// characterization test for that gap: when parseBibtex throws inside the outer try,
// after the rate-limit gate passes and both body guards pass, the handler answers
// HTTP 400 with {error: 'BibTeX import failed: ' + err.message}. No source is edited.
//
// The seam (server/routes/research-tools.js:544-604):
//   if (req.method === 'POST' && pathname === '/api/references/import-bibtex') {
//     if (!rateLimit(`import-bibtex:${req.socket.remoteAddress}`, 5)) return json(res, 429, {...}); // :545
//     try {                                                       // :546
//       const yaml = require('js-yaml');                          // :547
//       const body = await readBody(req);                         // :548
//       const {bibtex} = body;                                    // :549
//       if (!bibtex || typeof bibtex !== 'string') return json(res, 400, {...}); // :550 early 400 guard
//       if (bibtex.length > 500000) return json(res, 400, {...}); // :551 early 400 guard
//       const parsed = parseBibtex(bibtex);                       // :553 throws here
//       ... bibliography read at :554-560 ...                     // never reached
//       ... per-entry loop at :566-594 ...                        // never reached
//       if (added > 0) { fs.writeFileSync(...); invalidateCache('stats'); } // :596-599 never reached
//       return json(res, 200, {added, skipped, errors});          // :601 never reached
//     } catch (err) {                                             // :602
//       return json(res, 400, {error: 'BibTeX import failed: ' + err.message}); // :603 the pinned 400
//     }
//   }
// A parseBibtex that throws at :553 lands directly in this catch. It runs AFTER the
// two early 400 guards (so bibtex must be a valid non-empty string under 500KB) but
// BEFORE the bibliography read at :557, the per-entry loop, and the only write at
// :597. The catch returns 400, not 500. Network free; no real filesystem is touched.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/research-tools.js');

describe('POST /api/references/import-bibtex outer catch in routes/research-tools.js', () => {
  it('returns 400 BibTeX import failed when parseBibtex throws inside the outer try, after the rate-limit gate and both body guards pass', async () => {
    // ctx mirrors the sibling guards suite's invoker and the bundle-export outer-catch
    // recipe: rateLimit records each (key, limit) and returns true so the gate passes;
    // readBody resolves a valid non-empty bibtex string so both early 400 guards pass;
    // parseBibtex throws as the first effectful call past the guards; json captures
    // {status, payload} and marks the response ended. The load-bearing never-reached
    // proof is the fs Proxy tripwire (mirroring the bundle-export suite): this handler
    // reads references.yaml (:557) and writes it back (:597) only AFTER parseBibtex, so
    // an fs count of zero shows the throw preempted the bibliography read, the per-entry
    // loop, and the only write. The Proxy makes fs.writeFileSync (the GOAL's named
    // never-run tripwire) and fs.readFileSync both tripwires. invalidateCache is a
    // separate tripwire that must also stay at zero (it fires only after a write).
    const rateLimitCalls = [];
    let jsonCalls = 0;
    let fsCalls = 0;
    let parseBibtexCalls = 0;
    let invalidateCalls = 0;
    let captured = null;

    // Count any fs method the handler would reach past the throw, not just a fixed
    // list, exactly as the sibling bundle-export outer-catch suite does. Both
    // readFileSync (:557) and writeFileSync (:597) live past the :553 throw, so this
    // stays at zero.
    const fsTripwire = new Proxy({}, { get() { return () => { fsCalls++; }; } });

    const res = { writableEnded: false };

    const ctx = {
      json: (_res, status, payload) => { jsonCalls++; captured = { status, payload }; _res.writableEnded = true; },
      rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return true; },
      readBody: async () => ({ bibtex: '@article{a, title={T}}' }),
      parseBibtex: () => { parseBibtexCalls++; throw new Error('boom'); },
      invalidateCache: () => { invalidateCalls++; },
      fs: fsTripwire,
      path,
      PROJECT_ROOT: '/proj',
    };

    const pathname = '/api/references/import-bibtex';
    const url = new URL('http://localhost/api/references/import-bibtex');
    const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };

    // The handler swallows the parseBibtex throw in its outer catch, so the route
    // promise resolves; it must never reject out to the dispatcher.
    await assert.doesNotReject(() => routes(req, res, url, pathname, ctx));

    // The pinned golden: the outer catch answers 400 with the exact error string
    // 'BibTeX import failed: ' + err.message, i.e. 'BibTeX import failed: boom'.
    assert.deepStrictEqual(captured, { status: 400, payload: { error: 'BibTeX import failed: boom' } });

    // Provenance and never-reached proof.
    // The rate-limit gate ran once with the import-bibtex key and limit 5 and passed
    // (returned true), so the throw came from inside the outer try, not the 429 branch.
    assert.deepStrictEqual(rateLimitCalls, [{ key: 'import-bibtex:127.0.0.1', limit: 5 }]);
    // parseBibtex ran exactly once: the throw came from the parse step at :553, the
    // first effectful call after the two early 400 body guards.
    assert.equal(parseBibtexCalls, 1);
    // The import-bibtex success path also replies through json (:601, not a stream), so
    // exactly one json write proves the 400 was the sole reply: no 429 and no 200 fired.
    assert.equal(jsonCalls, 1);
    // The throw preempts the bibliography read (:557), the per-entry loop, and the only
    // write (:597), so no fs method ran at all.
    assert.equal(fsCalls, 0, 'the parseBibtex throw preempts the bibliography read and the write');
    // invalidateCache fires only after a successful write (:598), so it stays at zero.
    assert.equal(invalidateCalls, 0);
  });
});
