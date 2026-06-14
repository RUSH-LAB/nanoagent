import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// files.js is CommonJS; load the REAL route module the way the sibling files.js
// suites do. next-files-put-write-guards.test.mjs drives the PUT 429 gate, and
// next-research-tools-ratelimit-gates.test.mjs supplies the driveGate / assertGated
// shape that records {key, limit} and tripwires every downstream call. Two mutation
// handlers in files.js open with a per-route rate-limit gate as their FIRST
// statement, before any body read, query parse, validation, or IO:
//
//   POST   /api/file (create), files.js:59
//     if (!rateLimit(`file-create:${req.socket.remoteAddress}`, 30))
//       return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
//   DELETE /api/file (delete), files.js:81
//     if (!rateLimit(`file-delete:${req.socket.remoteAddress}`, 30))
//       return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
//
// The existing files.js suites cover the create and delete gate-PASSES paths but
// never this 429 early return, so its key, its limit, and the short-circuit are
// uncovered. This add-only suite pins that gate branch for both handlers. The PUT
// gate (file-write, limit 60) is already pinned by next-files-put-write-guards, so
// this suite stays on the two remaining create and delete gates. No real filesystem
// is touched.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');

// A fixed caller address so the recorded rate-limit key is deterministic.
const REMOTE = '203.0.113.9';

// Drive one /api/file mutation handler over a minimal mocked ctx whose rateLimit
// returns false and records the (key, limit) it was called with. Every downstream
// helper the handler would reach past the gate is a tripwire that both counts the
// call and throws on contact: readBody (the POST body parse), url.searchParams.get
// (the DELETE query read), isValidFilePath (path validation), invalidateCache (the
// cache bust), and every fs.* method. The fs tripwire is a Proxy, so any fs call
// (existsSync, mkdirSync, writeFileSync, renameSync, and the rest) is caught, not
// just a fixed list. Because the gate returns 429 first, every counter must stay at
// 0. json() captures {status, body}.
async function driveGate(method) {
  const counts = { readBody: 0, urlGet: 0, isValidFilePath: 0, invalidateCache: 0, fs: 0 };
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

  const res = { writableEnded: false };

  const url = {
    searchParams: {
      get() {
        counts.urlGet++;
        throw new Error('url.searchParams.get reached past the rate-limit gate');
      },
    },
  };

  const ctx = {
    rateLimit: (key, limit) => { recorded = { key, limit }; return false; },
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
    readBody: async () => { counts.readBody++; throw new Error('readBody reached past the rate-limit gate'); },
    isValidFilePath: () => { counts.isValidFilePath++; throw new Error('isValidFilePath reached past the rate-limit gate'); },
    invalidateCache: () => { counts.invalidateCache++; throw new Error('invalidateCache reached past the rate-limit gate'); },
    fs: fsTripwire,
  };

  const req = { method, socket: { remoteAddress: REMOTE } };
  await filesRoutes(req, res, url, '/api/file', ctx);
  return { captured, recorded, counts };
}

// Shared assertions for one gate: a deepStrictEqual on the captured {status, body}
// pins the exact 429 payload, a deepStrictEqual on the recorded call pins the exact
// key (prefix plus the fixed caller address) and limit, and every tripwire counter
// stays at 0. Together they prove the 429 precedes the body read, the query parse,
// path validation, the cache bust, and all filesystem work.
async function assertGated(method, keyPrefix, limit) {
  const { captured, recorded, counts } = await driveGate(method);
  assert.deepStrictEqual(captured, { status: 429, body: { error: 'Too many requests. Try again in a minute.' } });
  assert.deepStrictEqual(recorded, { key: keyPrefix + REMOTE, limit });
  assert.equal(counts.readBody, 0, `${method} /api/file: gate returns before readBody`);
  assert.equal(counts.urlGet, 0, `${method} /api/file: gate returns before url.searchParams.get`);
  assert.equal(counts.isValidFilePath, 0, `${method} /api/file: gate returns before isValidFilePath`);
  assert.equal(counts.invalidateCache, 0, `${method} /api/file: gate busts no cache`);
  assert.equal(counts.fs, 0, `${method} /api/file: gate runs no filesystem work`);
}

describe('files.js — POST and DELETE /api/file 429 rate-limit gates (uncovered branch)', () => {
  it('POST /api/file returns 429 with key "file-create:" and limit 30, before any body read or IO', async () => {
    await assertGated('POST', 'file-create:', 30);
  });

  it('DELETE /api/file returns 429 with key "file-delete:" and limit 30, before any query parse or IO', async () => {
    await assertGated('DELETE', 'file-delete:', 30);
  });
});
