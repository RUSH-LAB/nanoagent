import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load the REAL module via createRequire the way the
// sibling route suites do (next-annshared-500 for the structure, the same file and
// the same GET outer-catch shape), so this characterization test drives the genuine
// GET /api/suggest handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The suggestion build runs inside one try
// (handler opens at misc-tools.js:1414, try at :1415). The try's FIRST throwable op
// is `url.searchParams.get('text')` at :1416. The limit read on :1417 invokes the pure
// `numericParam` import (misc-tools.js:6) around a SECOND `url.searchParams.get('limit')`
// that would throw too, but it never runs because :1416 throws first. The two work
// blocks that follow (the references search at :1429 to :1444 and the page scan at :1449
// to :1482) each carry
// their OWN inner try/catch that swallow errors and still return a 200, so the only
// route into the outer catch is a throw OUTSIDE those inner blocks. The first such op
// is the line 1416 searchParams read. A throw there lands in the catch at :1489 to
// :1491, which returns `json(res, 500, {error: 'Failed to generate suggestions'})` at
// :1490. The success 200 projection `json(res, 200, {references, pages})` at :1485 to
// :1488 is then never emitted.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

// The exact reply the outer catch emits, in the {status, body} shape the json() stub
// below records.
const GOLDEN_500 = { status: 500, body: { error: 'Failed to generate suggestions' } };

// Every key the success projection returns: the object sent by
// json(res, 200, {references: ..., pages: ...}) at misc-tools.js:1485 to :1488. The
// never-reached proof asserts none of them surfaces in any captured reply.
const SUCCESS_KEYS = ['references', 'pages'];

// Drive the real GET /api/suggest handler over a mocked ctx. The single seam used to
// steer the lone try into its catch is a `url` whose searchParams.get throws. Every
// json(res, status, payload) write is captured in `replies` so a test can assert the
// 500 is the ONLY reply and the success projection never fired, and every
// searchParams.get(key) argument is recorded in `getCalls` so a test can prove the
// throw originates at the handler's first param read ('text'), before the limit read
// on :1417 and before any reference or page work.
async function runSuggest() {
  const replies = [];
  const getCalls = [];
  // The SEAM: a url whose searchParams.get records its key then throws
  // synchronously, modelling a failure of the first param read at :1416. A real URL
  // would not throw, so the object is hand-built. fs, path, PROJECT_ROOT, and
  // flatFiles are intentionally omitted from ctx below because line 1416 throws
  // before any of them is reached.
  const url = {
    searchParams: {
      get(key) {
        getCalls.push(key);
        throw new Error('searchParams.get failed');
      },
    },
  };
  const ctx = {
    json(_res, status, payload) {
      const r = { status, body: payload };
      replies.push(r);
      _res.writableEnded = true;
      return r;
    },
  };
  const pathname = '/api/suggest';
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, getCalls };
}

describe('GET /api/suggest outer catch returns 500 Failed to generate suggestions', () => {
  it('maps a throw from url.searchParams.get(text) straight into the 500 reply', async () => {
    const { replies, getCalls } = await runSuggest();

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Failed to generate suggestions'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the handler's first param read: searchParams.get is
    // called once, with exactly 'text' (the first throwable step in the try), so the
    // limit read on :1417 never runs and the 500 comes from the line 1416 seam rather
    // than an inner-swallowed throw.
    assert.deepStrictEqual(getCalls, ['text']);
  });

  it('never emits the success 200 {references, pages} projection', async () => {
    const { replies } = await runSuggest();

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any of
    // the success projection keys, so the {references, pages} object at :1485 to :1488
    // was bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });
});
