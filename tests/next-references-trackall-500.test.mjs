import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load the REAL route module via createRequire the
// way the sibling research-tools suites do (next-references-track-guards,
// next-research-tools-ratelimit-gates), then drive the POST
// /api/references/track-all handler directly over a mocked ctx.
//
// This add-only suite characterizes the handler's outer-catch 500. The handler
// (server/routes/research-tools.js:289 through 370) opens with a rate-limit gate
// that must PASS, then inside the outer try its FIRST I/O is
//   const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};   (:296)
// reading bibliography/references.yaml. That read runs OUTSIDE any inner try,
// BEFORE the toCheck loop, before the fetchS2 https.get network call, and before
// the conditional writeFileSync at :363. When fs.readFileSync throws, the error
// escapes to the outer catch at :367, which returns
//   json(res, 500, {error: 'Batch track failed. Please try again later.'})
// with no loop iteration, no network request, and no write. This pins that
// branch. The route never reads the request body. Network free; no real
// filesystem is touched.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

const PROJECT_ROOT = '/fake/root';

// Build a recording ctx for the 500 case. `events` logs each fs side effect in
// order ('read' per readFileSync, 'write' per writeFileSync). readFileSync
// records its (file, encoding) then THROWS, modelling an unreadable or broken
// bibliography. writeFileSync is a tripwire that must never fire. `captures`
// collects every json() reply so we can prove the 200 success body never ran.
// `rateLimitCalls` captures the limiter key and ceiling; rateLimit returns true
// so the gate passes and control reaches the try. readBody is a tripwire: this
// route never reads the request body.
function makeCtx() {
  const recorders = {
    captures: [],
    captured: null,
    events: [],
    writes: [],
    rateLimitCalls: [],
    readBodyCount: 0,
    readArgs: null,
  };
  const ctx = {
    json(_res, status, payload) {
      recorders.captured = { status, payload };
      recorders.captures.push(recorders.captured);
      return recorders.captured;
    },
    rateLimit(key, limit) { recorders.rateLimitCalls.push({ key, limit }); return true; },
    readBody: async () => { recorders.readBodyCount += 1; throw new Error('readBody must not run for track-all'); },
    fs: {
      readFileSync: (file, enc) => {
        recorders.readArgs = { file, enc };
        recorders.events.push('read');
        throw new Error('readFileSync boom: bibliography unreadable');
      },
      writeFileSync: (file, data) => { recorders.events.push('write'); recorders.writes.push({ file, data }); },
    },
    path,
    PROJECT_ROOT,
  };
  return { ctx, recorders };
}

// Drive POST /api/references/track-all with the rate-limit gate passing. The
// socket address makes the limiter key 'track-all:127.0.0.1'.
async function invokeTrackAll() {
  const pathname = '/api/references/track-all';
  const url = new URL('http://localhost/api/references/track-all');
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const { ctx, recorders } = makeCtx();
  await researchToolsRoutes(req, res, url, pathname, ctx);
  return recorders;
}

describe('POST /api/references/track-all outer-catch 500 (bibliography read throws)', () => {
  it('returns 500 Batch track failed when fs.readFileSync throws, after the read and before any write or network', async () => {
    const { captured, captures, events, writes, rateLimitCalls, readArgs, readBodyCount } = await invokeTrackAll();

    // The golden: the outer catch at :367 maps the thrown read to a 500.
    assert.deepStrictEqual(captured, {
      status: 500,
      payload: { error: 'Batch track failed. Please try again later.' },
    });

    // Provenance: the rate-limit gate passed, recording the track-all key at limit 2.
    assert.deepStrictEqual(rateLimitCalls, [{ key: 'track-all:127.0.0.1', limit: 2 }]);

    // The single I/O was the bibliography read, opened with utf8 encoding, and it threw.
    assert.deepStrictEqual(events, ['read']);
    assert.deepStrictEqual(readArgs, {
      file: path.join(PROJECT_ROOT, 'bibliography', 'references.yaml'),
      enc: 'utf8',
    });

    // Never reached: no write at :363, no request body read, and the 200 success
    // body at :366 never fired (exactly one reply, none with status 200).
    assert.equal(writes.length, 0);
    assert.equal(readBodyCount, 0);
    assert.equal(captures.length, 1);
    assert.equal(captures.filter(c => c.status === 200).length, 0);
  });
});
