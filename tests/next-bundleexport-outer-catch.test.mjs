import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// graph-trash-files.js is CommonJS; load the REAL route module via createRequire the
// way the sibling route suites do (next-graphtrash-mutation-ratelimit-guards.test.mjs
// drives this exact POST /api/export/bundle route for its 429 gate) rather than
// reimplementing the handler. This is an add-only characterization test. It pins the
// CURRENT behavior of the bundle-export outer catch: when readBody rejects inside the
// outer try, after the rate-limit gate passes, the handler answers HTTP 400 with
// {error: 'Bundle export failed'}. No source file is edited.
//
// The seam (server/routes/graph-trash-files.js:473-510):
//   if (req.method === 'POST' && pathname === '/api/export/bundle') {
//     if (!rateLimit(`export-bundle:${req.socket.remoteAddress}`, 10)) return json(res, 429, {...});
//     try {
//       const body = await readBody(req);   // FIRST statement; a reject throws here
//       const {paths, format} = body;       // never reached
//       ... validation guards return 400 ... // never reached
//       res.writeHead(200, ...); res.end(...) // never reached (md / html streams)
//     } catch {
//       return json(res, 400, {error: 'Bundle export failed'}); // the pinned 400
//     }
//   }
// A readBody that rejects as the outer try's FIRST statement lands directly in this
// catch, before the {paths, format} destructure, before every validation 400, and
// before either 200 stream. The catch returns 400 (not 500). Network free; no real
// filesystem is touched.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

describe('POST /api/export/bundle outer catch in routes/graph-trash-files.js', () => {
  it('returns 400 Bundle export failed when readBody rejects inside the outer try, after the rate-limit gate passes', async () => {
    // ctx mirrors the sibling rate-limit suite's invoker: rateLimit records each
    // (key, limit) and returns true so the gate passes; readBody rejects to throw as
    // the outer try's first statement; json captures {status, payload} and marks the
    // response ended. The load-bearing never-reached proof is the fs Proxy tripwire,
    // mirroring next-graphtrash-mutation-ratelimit-guards.test.mjs: this handler reads
    // bundle files via fs.readFileSync inside the post-validation loop, so an fs count
    // of zero shows the throw preempted all body processing before any file work.
    // loadJSON and saveJSON stay at zero too, but only as a plain no-store-mutation
    // guard: this handler calls neither on any branch (it uses fs directly), so their
    // zero holds independent of the throw. The handler reaches none of the other ctx
    // helpers before the throw, so leaving them off the mock is safe: the module
    // destructures absent fields to undefined.
    const rateLimitCalls = [];
    let jsonCalls = 0;
    let fsCalls = 0;
    let loadJSONCount = 0;
    let saveJSONCount = 0;
    let captured = null;

    // Count any fs method a handler would reach past the gate, not just a fixed list,
    // exactly as the sibling 429 suite does for this same route.
    const fsTripwire = new Proxy({}, { get() { return () => { fsCalls++; }; } });

    const res = {
      writableEnded: false,
      headersSent: false,
      writeHead() { this.headersSent = true; },
      end() { this.writableEnded = true; },
    };

    const ctx = {
      rateLimit: (key, limit) => { rateLimitCalls.push({ key, limit }); return true; },
      readBody: async () => { throw new Error('readBody boom'); },
      json: (_res, status, payload) => { jsonCalls++; captured = { status, payload }; _res.writableEnded = true; },
      fs: fsTripwire,
      loadJSON: () => { loadJSONCount++; return {}; },
      saveJSON: () => { saveJSONCount++; },
    };

    const pathname = '/api/export/bundle';
    const url = new URL('http://localhost/api/export/bundle');
    const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };

    // The handler swallows the readBody rejection in its outer catch, so the route
    // promise resolves; it must never reject out to the dispatcher.
    await assert.doesNotReject(() => routes(req, res, url, pathname, ctx));

    // The pinned golden: the outer catch answers 400 with the exact error string.
    assert.deepStrictEqual(captured, { status: 400, payload: { error: 'Bundle export failed' } });

    // Provenance and never-reached proof.
    // The rate-limit gate ran once with the export-bundle key and limit 10 and passed
    // (returned true), so the throw came from inside the outer try, not the 429 branch.
    assert.deepStrictEqual(rateLimitCalls, [{ key: 'export-bundle:127.0.0.1', limit: 10 }]);
    // Exactly one json write, the 400; no 429 fired and no second response was sent.
    assert.equal(jsonCalls, 1);
    // No 200 export stream began: neither writeHead nor end ran before the throw.
    assert.equal(res.headersSent, false, 'no 200 export stream began before the throw');
    // The throw preempts the post-validation file loop, so no fs method ran.
    assert.equal(fsCalls, 0, 'the readBody throw preempts the bundle file-read loop');
    // This handler uses fs directly and never calls loadJSON or saveJSON on any
    // branch, so these stay at zero as a no-store-mutation guard.
    assert.equal(loadJSONCount, 0);
    assert.equal(saveJSONCount, 0);
  });
});
