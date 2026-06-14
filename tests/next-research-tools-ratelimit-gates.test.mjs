import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// research-tools.js is CommonJS; load the REAL route module the way the sibling
// rate-limit suite does (next-graphtrash-mutation-ratelimit-guards) rather than
// reimplementing the handlers. Two handlers in this module open with a per-route
// rate-limit gate as their FIRST statement, before the try and before any IO or
// network:
//
//   GET  /api/recommendations:
//     if (!rateLimit(`recommendations:${req.socket.remoteAddress}`, 10))
//       return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
//   POST /api/references/track-all:
//     if (!rateLimit(`track-all:${req.socket.remoteAddress}`, 2))
//       return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
//
// The existing recommendation and track suites exercise only the gate-PASSES path
// (rateLimit returns true) and assert the 200 result, so this 429 early return and
// its key and limit are uncovered. This add-only suite pins that gate branch for
// both handlers. It is a fresh coverage angle (the rate-limit gate), distinct from
// the outer-catch badbody vein. Network free; no real filesystem is touched.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

// Drive one handler over a minimal mocked ctx whose rateLimit returns false and
// records the (key, limit) it was called with. readBody, loadJSON, saveJSON, and
// every fs method are tripwires that increment a counter AND throw on contact: the
// gate short-circuits before the body is read and before any disk, store, or network
// work, so every counter must stay at 0. The fs tripwire is a Proxy, so ANY fs method
// a handler would reach past the gate (readFileSync, writeFileSync, statSync, and the
// rest) is caught, not just a fixed list. json() captures { status, body }; res.writeHead
// and res.end are counted too, so a streamed response past the gate would also surface.
async function driveGate({ method, route }) {
  const counts = { readBody: 0, loadJSON: 0, saveJSON: 0, fs: 0, stream: 0 };
  let recorded = null;
  let captured = null;

  const fsTripwire = new Proxy({}, {
    get(_target, prop) {
      return () => {
        counts.fs++;
        throw new Error(`fs.${String(prop)} reached past the rate-limit gate`);
      };
    },
  });

  const res = {
    writableEnded: false,
    writeHead() { counts.stream++; },
    end() { counts.stream++; },
  };

  const ctx = {
    rateLimit: (key, limit) => { recorded = { key, limit }; return false; },
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
    readBody: async () => { counts.readBody++; throw new Error('readBody reached past the rate-limit gate'); },
    loadJSON: () => { counts.loadJSON++; throw new Error('loadJSON reached past the rate-limit gate'); },
    saveJSON: () => { counts.saveJSON++; throw new Error('saveJSON reached past the rate-limit gate'); },
    fs: fsTripwire,
  };

  const url = new URL('http://localhost' + route);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  await researchToolsRoutes(req, res, url, route, ctx);
  return { captured, recorded, counts };
}

// Shared assertions for a single gate: a deepEqual on the captured { status, body }
// pins the exact 429 payload, a deepEqual on the recorded call pins the exact key
// (prefix plus caller address) and limit, and every tripwire counter stays at 0,
// proving the 429 precedes any body read, store access, filesystem call, or network.
async function assertGated({ method, route, keyPrefix, limit }) {
  const { captured, recorded, counts } = await driveGate({ method, route });
  assert.deepEqual(captured, { status: 429, body: { error: 'Too many requests. Try again in a minute.' } });
  assert.deepEqual(recorded, { key: keyPrefix + '127.0.0.1', limit });
  assert.equal(counts.readBody, 0, `${method} ${route}: gate returns before readBody`);
  assert.equal(counts.loadJSON, 0, `${method} ${route}: gate loads no store`);
  assert.equal(counts.saveJSON, 0, `${method} ${route}: gate writes no store`);
  assert.equal(counts.fs, 0, `${method} ${route}: gate runs no filesystem work`);
  assert.equal(counts.stream, 0, `${method} ${route}: gate streams no response body`);
}

describe('research-tools.js — per-route 429 rate-limit gates (uncovered branch)', () => {
  it('GET /api/recommendations returns 429 with key "recommendations:" and limit 10, before any IO', async () => {
    await assertGated({ method: 'GET', route: '/api/recommendations', keyPrefix: 'recommendations:', limit: 10 });
  });

  it('POST /api/references/track-all returns 429 with key "track-all:" and limit 2, before any IO', async () => {
    await assertGated({ method: 'POST', route: '/api/references/track-all', keyPrefix: 'track-all:', limit: 2 });
  });
});
