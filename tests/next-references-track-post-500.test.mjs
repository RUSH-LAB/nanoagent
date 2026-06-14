import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// research-tools.js is CommonJS; load the REAL module via createRequire the way the
// sibling research-tools suites do, then drive the POST /api/references/track handler
// directly over a mocked ctx. This characterizes ONLY the outer-catch 500 rung: the
// bibliography read throws, which escapes to the handler's outer catch and returns
// HTTP 500 'Track update failed. Please try again later.'.
//
// The throwing read is fs.readFileSync at server/routes/research-tools.js:237. It sits
// inside the outer try (opened :230) but BEFORE the Semantic Scholar https.get (:247)
// and BEFORE the only fs.writeFileSync (:276), so a read that throws lands in the outer
// catch at :284 with no network request and no write ever happening. The companion
// ladder suite tests/next-references-track-guards.test.mjs pins the pre-network guard
// rungs (429, missing-or-invalid key, 404, no-arxiv); this file pins the
// read-throws-to-500 rung those leave uncovered.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

const PROJECT_ROOT = '/fake/root';

// Build a recording ctx whose fs.readFileSync records 'read' then THROWS, modelling a
// bibliography read that fails (missing or unreadable references.yaml, EIO, and the
// like). `events` logs each fs side effect in order, so a lone ['read'] proves the read
// ran and threw before any write. writeFileSync stays a tripwire recorder that must
// never run, so `writes` must stay empty. `replies` captures EVERY json call so we can
// prove exactly one reply fired and it was the 500, never the 200 success at :277 nor
// the 502 Semantic Scholar failure at :260. `readBodyCount` proves the body was consumed
// once; `rateLimitCalls` captures the limiter key and ceiling. The limiter is always
// open here so control reaches the read.
function makeCtx({ body }) {
  const recorders = { captured: null, replies: [], readBodyCount: 0, events: [], writes: [], rateLimitCalls: [] };
  const ctx = {
    json(_res, status, payload) {
      recorders.captured = { status, payload };
      recorders.replies.push(recorders.captured);
      return recorders.captured;
    },
    rateLimit(key, limit) { recorders.rateLimitCalls.push({ key, limit }); return true; },
    readBody: async () => { recorders.readBodyCount += 1; return body; },
    fs: {
      readFileSync: () => { recorders.events.push('read'); throw new Error('readFileSync boom'); },
      writeFileSync: (file, data) => { recorders.events.push('write'); recorders.writes.push({ file, data }); },
    },
    path,
    PROJECT_ROOT,
  };
  return { ctx, recorders };
}

// POST /api/references/track with a valid string key and the limiter open, so the 429
// and missing-or-invalid-key guards pass and control reaches the bibliography read.
// remoteAddress 127.0.0.1 makes the limiter key 'track-ref:127.0.0.1'.
async function invokePost({ body, remoteAddress = '127.0.0.1' }) {
  const pathname = '/api/references/track';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const { ctx, recorders } = makeCtx({ body });
  await researchToolsRoutes(req, res, url, pathname, ctx);
  return recorders;
}

describe('POST /api/references/track outer-catch 500 when the bibliography read throws', () => {
  it('returns 500 Track update failed after reading but before any write or network call', async () => {
    const { captured, replies, events, writes, readBodyCount, rateLimitCalls } = await invokePost({
      body: { key: 'doe2021' },
    });

    // The golden: the outer catch maps the thrown read to a 500 with the fixed body.
    assert.deepStrictEqual(captured, {
      status: 500,
      payload: { error: 'Track update failed. Please try again later.' },
    });

    // Provenance: the limiter ran first with the track-ref key at ceiling 10 and
    // passed, then the body was consumed once, then the read ran and threw.
    assert.deepStrictEqual(rateLimitCalls, [{ key: 'track-ref:127.0.0.1', limit: 10 }]);
    assert.equal(readBodyCount, 1);
    assert.deepStrictEqual(events, ['read']);

    // Never-reached proof: the throw escapes before the only write (:276) and before
    // the Semantic Scholar call (:247), so nothing is written and exactly one reply
    // fired, which was neither the 200 success (:277) nor the 502 S2 failure (:260).
    assert.equal(writes.length, 0);
    assert.equal(replies.length, 1);
    assert.ok(!replies.some((r) => r.status === 200 || r.status === 502));
  });
});
