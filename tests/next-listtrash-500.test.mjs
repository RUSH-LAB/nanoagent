import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the real module via createRequire the way
// the sibling route suite next-bibanalytics-500 does, so this characterization test
// drives the genuine GET /api/trash handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The whole listing runs inside one try (the
// GET /api/trash branch of graph-trash-files.js). The try's first failable step is
// `fs.existsSync(TRASH_DIR)`; any throw there, or from the `fs.readdirSync` walk
// that follows once the dir is reported present, lands in the outer catch, which
// returns json(res, 500, {error: 'Failed to list trash'}). The two success 200
// paths (the `{files}` result and the `{files: []}` empty early-return) are then
// never emitted.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/graph-trash-files.js');

const PROJECT_ROOT = '/virtual-root';
const TRASH_DIR = '/virtual-root/.trash';

// The exact reply the outer catch emits, captured in the {status, body} shape the
// json() stub below records.
const GOLDEN_500 = { status: 500, body: { error: 'Failed to list trash' } };

// A throwing fs whose existsSync (the try's first failable step) throws, steering
// the handler straight into the outer catch BEFORE the trash walk. readdirSync is
// wired to throw too, but the readdir counter proves the walk was never entered on
// this seam, so the throw really did originate at the existsSync probe.
function existsThrowingFs() {
  let existsCalls = 0;
  let readdirCalls = 0;
  return {
    get existsCalls() { return existsCalls; },
    get readdirCalls() { return readdirCalls; },
    existsSync() { existsCalls++; throw new Error('existsSync unavailable'); },
    readdirSync() { readdirCalls++; throw new Error('readdirSync should be unreachable'); },
  };
}

// A throwing fs whose existsSync reports the trash dir present (so the `{files: []}`
// empty early-return is skipped) and whose readdirSync throws on the first
// walkTrash read, reaching the SAME outer catch from deeper inside the try.
function readdirThrowingFs() {
  let existsCalls = 0;
  let readdirCalls = 0;
  return {
    get existsCalls() { return existsCalls; },
    get readdirCalls() { return readdirCalls; },
    existsSync() { existsCalls++; return true; },
    readdirSync() { readdirCalls++; throw new Error('readdirSync unavailable'); },
  };
}

// Drive the real GET /api/trash handler over a mocked ctx. The caller supplies the
// fs seam that steers the single try into its catch. Every json(res, status,
// payload) write is captured in `replies` so a test can assert the 500 is the ONLY
// reply and neither 200 path fired.
async function runListTrash({ fs }) {
  const replies = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    fs,
    path,
    PROJECT_ROOT,
    TRASH_DIR,
  };
  const pathname = '/api/trash';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies };
}

describe('GET /api/trash outer catch returns 500 Failed to list trash', () => {
  it('maps a throw from the first fs.existsSync(TRASH_DIR) straight into the 500 reply', async () => {
    const fs = existsThrowingFs();
    const { replies } = await runListTrash({ fs });

    // The single reply is the catch's 500; deepStrictEqual pins both the status and
    // the exact {error: 'Failed to list trash'} body shape.
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);

    // The throw originates at the try's first failable step (the existsSync probe),
    // and the walk never started, so the {files: []} early-return path was bypassed.
    assert.equal(fs.existsCalls, 1, 'existsSync(TRASH_DIR) ran once, the first throwable step');
    assert.equal(fs.readdirCalls, 0, 'the trash walk never started (no readdirSync)');
  });

  it('returns the same 500 when fs.readdirSync throws inside the walk, dir present', async () => {
    const fs = readdirThrowingFs();
    const { replies } = await runListTrash({ fs });

    // existsSync reported the dir present, so the early-return was skipped and the
    // walk ran; its first readdirSync throw escapes into the SAME outer catch.
    assert.equal(fs.existsCalls, 1, 'existsSync(TRASH_DIR) ran and reported present');
    assert.ok(fs.readdirCalls > 0, 'the trash walk started and called readdirSync');
    assert.equal(replies.length, 1);
    assert.deepStrictEqual(replies[0], GOLDEN_500);
  });

  it('never emits either success 200 path (the {files} result or the {files: []} early-return)', async () => {
    // Run both failure seams; neither may produce a 200 or a files-bearing body.
    for (const fs of [existsThrowingFs(), readdirThrowingFs()]) {
      const { replies } = await runListTrash({ fs });

      // Anchor the never-reached proof so it cannot pass vacuously on an empty
      // replies array: each seam emits exactly the lone 500.
      assert.equal(replies.length, 1);
      assert.deepStrictEqual(replies[0], GOLDEN_500);

      // The never-reached proof: no reply carries a 200 status, and none carries a
      // `files` key, so neither the {files} success nor the {files: []} early-return fired.
      assert.equal(replies.some((r) => r.status === 200), false);
      assert.equal(replies.some((r) => r.body && 'files' in r.body), false);
    }
  });
});
