import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// graph-trash-files.js is CommonJS; load the real shipping module the way the
// sibling badbody test does (see tests/next-glossary-badbody.test.mjs) and reuse
// the mocked-ctx idiom of tests/next-graphtrash-mutation-guards.test.mjs, so this
// pins the live POST /api/file/move handler rather than a copy of it.
const require = createRequire(import.meta.url);
const graphTrashFilesRoutes = require('../server/routes/graph-trash-files.js');

const FILE_MOVE_PATHNAME = '/api/file/move';
const REMOTE_ADDR = '203.0.113.7';

// Drive the real POST /api/file/move handler (graph-trash-files.js lines 384 to
// 408) over a minimal mocked ctx, exercising ONLY its outer catch. The handler
// shape is:
//
//   if (!rateLimit(`file-move:${req.socket.remoteAddress}`, 20)) return 429;  // gate, before the try
//   try {
//     const body = await readBody(req);                          // first statement in the try
//     const {filePath, targetDir} = body;                        // throws if body is null
//     if (!isValidFilePath(filePath)) return 400 'Invalid file path';  // first inner guard
//     ... more guards ...
//     fs.mkdirSync(fullTargetDir, {recursive: true});            // first filesystem side effect
//     fs.renameSync(fullSource, fullTarget);
//     return json(res, 200, ...);
//   } catch {
//     return json(res, 400, {error: 'Invalid request'});
//   }
//
// Any throw raised before that first fs.mkdirSync lands in the fixed 400 outer
// catch with zero filesystem side effects. This file pins both pre-IO throw
// sources:
//
//   1. readBody rejects: the catch fires before the destructure even runs.
//   2. readBody resolves null: the `const {filePath, targetDir} = null`
//      destructure throws into the SAME catch, so the response is the fixed 400,
//      NOT the inner 'Invalid file path' guard. That pins the precedence of the
//      outer catch over the first inner validation guard.
//
// An empty `{}` body is deliberately NOT a case here: isValidFilePath(undefined)
// is falsy, so it returns the inner 'Invalid file path' guard and never reaches
// the outer catch (that rung is pinned by next-graphtrash-mutation-guards).
//
// This handler writes the filesystem directly and has NO loadJSON; fs is
// ctx-provided. fs.mkdirSync and fs.renameSync are zero-call tripwires: each
// increments a counter AND throws on contact. The counter===0 assertions are
// what actually prove the 400 came from the pre-IO path, because an fs call that
// threw would land in the same catch and return an identical 400. rateLimit
// returns true (its gate sits before the try) and is recorded so each case
// confirms it entered THIS handler through the file-move: rate-limit key. The
// ctx mirrors the sibling's minimal shape; the later ctx fields (isValidFilePath,
// isValidDir, path, PROJECT_ROOT, invalidateCache) sit past the catch point on
// this error path and are never reached, so they stay omitted.
async function runFileMovePost({ readBody: readBodyImpl, remoteAddress = REMOTE_ADDR }) {
  const calls = { rateLimit: [], readBody: 0, mkdirSync: 0, renameSync: 0 };
  let captured = null;

  const ctx = {
    rateLimit: (key, limit) => {
      calls.rateLimit.push({ key, limit });
      return true;
    },
    readBody: async (req) => {
      calls.readBody += 1;
      return readBodyImpl(req);
    },
    fs: {
      mkdirSync: (dir) => {
        calls.mkdirSync += 1;
        throw new Error(`mkdirSync must not run on the pre-IO catch path (called with ${dir})`);
      },
      renameSync: (from, to) => {
        calls.renameSync += 1;
        throw new Error(`renameSync must not run on the pre-IO catch path (called with ${from} to ${to})`);
      },
    },
    json: (_res, status, body) => {
      captured = { status, body };
      return captured;
    },
  };

  const url = new URL(`http://localhost${FILE_MOVE_PATHNAME}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await graphTrashFilesRoutes(req, res, url, FILE_MOVE_PATHNAME, ctx);
  return { captured, calls };
}

describe('POST /api/file/move outer-catch 400 badbody golden', () => {
  it('returns the fixed 400 {error: "Invalid request"} when readBody rejects, before any filesystem side effect', async () => {
    const { captured, calls } = await runFileMovePost({
      readBody: async () => { throw new Error('readBody boom'); },
    });

    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });

    // Entered this handler via its own file-move: gate (before the try), awaited
    // readBody once, then the catch fired before the first fs.mkdirSync: zero IO.
    assert.deepEqual(calls.rateLimit, [{ key: `file-move:${REMOTE_ADDR}`, limit: 20 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });

  it('returns the same fixed 400 {error: "Invalid request"} when readBody resolves null, beating the inner file-path guard, before any filesystem side effect', async () => {
    const { captured, calls } = await runFileMovePost({
      readBody: async () => null,
    });

    // The destructure of null throws into the outer catch, so the body is the
    // fixed 'Invalid request', never the first inner guard's message. This pins
    // the outer catch winning over the 'Invalid file path' rung.
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notDeepEqual(captured.body, { error: 'Invalid file path' });

    assert.deepEqual(calls.rateLimit, [{ key: `file-move:${REMOTE_ADDR}`, limit: 20 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.mkdirSync, 0);
    assert.equal(calls.renameSync, 0);
  });
});
