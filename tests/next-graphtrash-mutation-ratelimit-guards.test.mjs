import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// graph-trash-files.js is CommonJS; load the REAL route module the way the sibling
// route suites do (next-trash-empty-guards, next-folder-crud-guards) rather than
// reimplementing the handlers. Each mutation handler in this module opens with the
// same per-route rate-limit gate as its FIRST statement:
//
//   if (!rateLimit(`<key>:${req.socket.remoteAddress}`, <limit>))
//     return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
//
// returning BEFORE readBody and before any filesystem or store work. The existing
// mutation-guard suites default rateLimit to a function returning true, so they
// never reach this 429 branch or assert its key and limit. This add-only suite pins
// the gate for the five handlers that were uncovered: POST /api/trash/restore, POST
// /api/folder, DELETE /api/folder, POST /api/file/move, and POST /api/export/bundle.
// The sibling trash-empty gate (limit 2) is already characterized in
// next-trash-empty-guards.test.mjs. Network free; no real filesystem is touched.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

// Drive one handler over a mocked ctx whose rateLimit returns false and records the
// (key, limit) it was called with. readBody, loadJSON, saveJSON, and every fs method
// are call-counting tripwires that must stay at 0: the gate short-circuits before the
// body is read and before any disk or store mutation. The fs tripwire is a Proxy so
// ANY fs method a handler would reach past the gate is counted, not just a fixed list,
// across all five handlers. json() captures { status, body }; res.writeHead and
// res.end are counted too, so a streamed bundle response would also be caught.
async function driveGate({ method, route }) {
  const counts = { readBody: 0, loadJSON: 0, saveJSON: 0, fs: 0, stream: 0 };
  let recorded = null;
  let captured = null;

  const fsTripwire = new Proxy({}, {
    get() { return () => { counts.fs++; }; },
  });

  const res = {
    writableEnded: false,
    writeHead() { counts.stream++; },
    end() { counts.stream++; },
  };

  const ctx = {
    rateLimit: (key, limit) => { recorded = { key, limit }; return false; },
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
    readBody: async () => { counts.readBody++; return {}; },
    loadJSON: () => { counts.loadJSON++; return {}; },
    saveJSON: () => { counts.saveJSON++; },
    fs: fsTripwire,
  };

  const url = new URL('http://localhost' + route);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, route, ctx);
  return { captured, recorded, counts };
}

// Shared assertions for a single gate: 429 with the exact payload, the exact key
// (prefix plus caller address) and limit recorded, and zero body reads, store loads,
// store writes, filesystem calls, or streamed writes.
async function assertGated({ method, route, keyPrefix, limit }) {
  const { captured, recorded, counts } = await driveGate({ method, route });
  assert.equal(captured.status, 429, `${method} ${route} answers 429 when rate limited`);
  assert.deepEqual(captured.body, { error: 'Too many requests. Try again in a minute.' });
  assert.deepEqual(recorded, { key: keyPrefix + '127.0.0.1', limit }, `${method} ${route} gate key and limit`);
  assert.equal(counts.readBody, 0, `${method} ${route}: gate returns before readBody`);
  assert.equal(counts.fs, 0, `${method} ${route}: gate runs no filesystem work`);
  assert.equal(counts.loadJSON, 0, `${method} ${route}: gate loads no store`);
  assert.equal(counts.saveJSON, 0, `${method} ${route}: gate writes no store`);
  assert.equal(counts.stream, 0, `${method} ${route}: gate streams no response body`);
}

describe('graph-trash-files.js mutation handlers — per-route 429 rate-limit gates', () => {
  it('POST /api/trash/restore returns 429 with key "trash-restore:" and limit 10, before readBody', async () => {
    await assertGated({ method: 'POST', route: '/api/trash/restore', keyPrefix: 'trash-restore:', limit: 10 });
  });

  it('POST /api/folder returns 429 with key "create-folder:" and limit 20, before readBody', async () => {
    await assertGated({ method: 'POST', route: '/api/folder', keyPrefix: 'create-folder:', limit: 20 });
  });

  it('DELETE /api/folder returns 429 with key "del-folder:" and limit 10, before readBody', async () => {
    await assertGated({ method: 'DELETE', route: '/api/folder', keyPrefix: 'del-folder:', limit: 10 });
  });

  it('POST /api/file/move returns 429 with key "file-move:" and limit 20, before readBody', async () => {
    await assertGated({ method: 'POST', route: '/api/file/move', keyPrefix: 'file-move:', limit: 20 });
  });

  it('POST /api/export/bundle returns 429 with key "export-bundle:" and limit 10, before readBody', async () => {
    await assertGated({ method: 'POST', route: '/api/export/bundle', keyPrefix: 'export-bundle:', limit: 10 });
  });
});
