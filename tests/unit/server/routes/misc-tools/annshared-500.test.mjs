import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// misc-tools.js is CommonJS; load the REAL module via createRequire the way the
// sibling route suites do (next-citationgraph-500 for the structure,
// next-annotations-shared-projection-shape for this handler's ctx shape), so this
// characterization test drives the genuine GET /api/annotations/shared handler
// instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The feed build runs inside one try (handler
// opens at misc-tools.js:183, try at :184). The try's first throwable data op is
// `loadJSON(ANNOTATIONS_FILE)` at :186; the `numericParam(...)` on :185 is pure
// (parseInt + Math.min) and never throws, and no guard or early return precedes
// the load. Any throw inside the try lands in the catch at :197, which returns
// `json(res, 500, {error: 'Failed to load shared annotations'})` at :198. The
// success 200 projection `json(res, 200, {annotations, total})` at :196 is then
// never emitted.
const require = createRequire(import.meta.url);
const routes = require('../../../../../server/routes/misc-tools.js');

const ANNOTATIONS_FILE = '/virtual/annotations.json';

// The exact reply the outer catch emits, in the {status, body} shape the json()
// stub below records.
const GOLDEN_500 = { status: 500, body: { error: 'Failed to load shared annotations' } };

// Every key the success projection returns: the object sent by
// json(res, 200, {annotations: all.slice(0, limit), total: all.length}) at
// misc-tools.js:196. The never-reached proof asserts none of them surfaces in any
// captured reply.
const SUCCESS_KEYS = ['annotations', 'total'];

// Drive the real GET /api/annotations/shared handler over a mocked ctx. The caller
// supplies the one seam used to steer the single try into its catch: `loadJSON`.
// Every json(res, status, payload) write is captured in `replies` so a test can
// assert the 500 is the ONLY reply and the success projection never fired, and
// every loadJSON(file) argument is recorded so a test can prove the throw
// originates at the handler's lone data load.
async function runSharedAnnotations({ loadJSON: loadJSONImpl }) {
  const replies = [];
  const loadJSONArgs = [];
  const ctx = {
    json(_res, status, payload) {
      const r = { status, body: payload };
      replies.push(r);
      _res.writableEnded = true;
      return r;
    },
    loadJSON(file) { loadJSONArgs.push(file); return loadJSONImpl(file); },
    ANNOTATIONS_FILE,
  };
  const pathname = '/api/annotations/shared';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, loadJSONArgs };
}

// A loadJSON that throws synchronously, modelling a failure of the lone data load
// (e.g. a malformed annotations file): the throw at loadJSON(ANNOTATIONS_FILE)
// (misc-tools.js:186) lands directly in the outer catch.
function throwingLoadJSON() {
  return () => { throw new Error('annotations file unreadable'); };
}

describe('GET /api/annotations/shared outer catch returns 500 Failed to load shared annotations', () => {
  it('maps a throw from loadJSON(ANNOTATIONS_FILE) straight into the 500 reply', async () => {
    const { replies, loadJSONArgs } = await runSharedAnnotations({ loadJSON: throwingLoadJSON() });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Failed to load shared annotations'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the handler's lone data load: loadJSON is called once,
    // with exactly ANNOTATIONS_FILE (the first throwable step in the try).
    assert.deepStrictEqual(loadJSONArgs, [ANNOTATIONS_FILE]);
  });

  it('never emits the success 200 {annotations, total} projection', async () => {
    const { replies } = await runSharedAnnotations({ loadJSON: throwingLoadJSON() });

    // Anchor the never-reached proof so it cannot pass vacuously on an empty replies
    // array: the handler emits exactly the lone 500 on this seam.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The never-reached proof: no reply carries a 200 status, and none carries any
    // of the success projection keys, so the {annotations, total} object at :196 was
    // bypassed.
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });

  it('returns the same 500 when the throw comes AFTER the load (a non-object result), proving the catch is the sole sink', async () => {
    // loadJSON resolves but hands back null; the handler has no null guard, so
    // `Object.entries(null)` (misc-tools.js:188) throws synchronously and escapes
    // into the SAME outer catch as the load-throw path above. This pins that the
    // catch covers the entire try body, not only the loadJSON call.
    const { replies, loadJSONArgs } = await runSharedAnnotations({ loadJSON: () => null });

    assert.deepStrictEqual(loadJSONArgs, [ANNOTATIONS_FILE]);
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
    assert.equal(replies.some((r) => r.status === 200), false);
    assert.equal(
      replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
      false,
    );
  });
});
