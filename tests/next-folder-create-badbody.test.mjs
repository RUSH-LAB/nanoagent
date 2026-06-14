import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// graph-trash-files.js is CommonJS; load the real shipping module the way the
// sibling badbody suites do (see tests/next-glossary-badbody.test.mjs and
// tests/next-folder-crud-guards.test.mjs), so this pins the live POST /api/folder
// handler rather than a copy of it.
const require = createRequire(import.meta.url);
const graphTrashFilesRoutes = require('../server/routes/graph-trash-files.js');

const FOLDER_PATHNAME = '/api/folder';
const REMOTE_ADDR = '198.51.100.4';

// Drive the real POST /api/folder handler (graph-trash-files.js lines 344 to 358)
// over a minimal mocked ctx, exercising ONLY its outer catch. The handler shape is:
//
//   if (!rateLimit(`create-folder:${req.socket.remoteAddress}`, 20)) return 429; // gate, before the try
//   try {
//     const body = await readBody(req);                            // first statement in the try
//     const {path: dirPath} = body;                                // throws if body is null
//     if (!isValidDir(dirPath)) return 400 'Invalid path...';      // first inner guard
//     const fullPath = path.join(PROJECT_ROOT, dirPath);
//     if (fs.existsSync(fullPath)) return 409 'Directory already exists'; // first filesystem read
//     fs.mkdirSync(fullPath, {recursive: true});                   // the only filesystem write
//     return json(res, 201, {success: true, path: dirPath});
//   } catch {
//     return json(res, 400, {error: 'Invalid request'});
//   }
//
// Any throw raised before the first filesystem call lands in the fixed 400 outer
// catch with zero side effects. This file pins both pre-IO throw sources:
//
//   1. readBody rejects: the catch fires before the destructure even runs.
//   2. readBody resolves null: the `const {path: dirPath} = null` destructure
//      throws into the SAME catch, so the response is the fixed 400, NOT the inner
//      'Invalid path. Must start with content/' guard. That pins the precedence of
//      the outer catch over the first inner validation guard.
//
// isValidDir, fs.existsSync, and fs.mkdirSync are zero-call tripwires: each
// increments a counter AND throws on contact. The counter===0 assertions are what
// actually prove the 400 came from the pre-IO path, because any of those three
// throwing would land in the SAME catch and return an identical 400. rateLimit
// returns true (its gate sits before the try) and is recorded so each case confirms
// it entered THIS handler through the create-folder: rate-limit key. Later ctx
// fields (PROJECT_ROOT, path) sit past the first inner guard and are never reached,
// so they stay omitted.
async function runFolderPost({ readBody: readBodyImpl, remoteAddress = REMOTE_ADDR }) {
  const calls = { rateLimit: [], readBody: 0, isValidDir: 0, existsSync: 0, mkdirSync: 0 };
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
    isValidDir: (dir) => {
      calls.isValidDir += 1;
      throw new Error(`isValidDir must not run on the pre-IO catch path (called with ${dir})`);
    },
    fs: {
      existsSync: (p) => {
        calls.existsSync += 1;
        throw new Error(`fs.existsSync must not run on the pre-IO catch path (called with ${p})`);
      },
      mkdirSync: (p) => {
        calls.mkdirSync += 1;
        throw new Error(`fs.mkdirSync must not run on the pre-IO catch path (called with ${p})`);
      },
    },
    json: (_res, status, body) => {
      captured = { status, body };
      return captured;
    },
  };

  const url = new URL(`http://localhost${FOLDER_PATHNAME}`);
  const req = { method: 'POST', socket: { remoteAddress } };
  const res = { writableEnded: false };
  await graphTrashFilesRoutes(req, res, url, FOLDER_PATHNAME, ctx);
  return { captured, calls };
}

describe('POST /api/folder outer-catch 400 badbody golden', () => {
  it('returns the fixed 400 {error: "Invalid request"} when readBody rejects, before any filesystem side effect', async () => {
    const { captured, calls } = await runFolderPost({
      readBody: async () => { throw new Error('readBody boom'); },
    });

    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });

    // Entered this handler via its own create-folder: gate (before the try),
    // awaited readBody once, then the catch fired before the first inner guard
    // and before any filesystem call: zero side effects.
    assert.deepEqual(calls.rateLimit, [{ key: `create-folder:${REMOTE_ADDR}`, limit: 20 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.isValidDir, 0);
    assert.equal(calls.existsSync, 0);
    assert.equal(calls.mkdirSync, 0);
  });

  it('returns the same fixed 400 {error: "Invalid request"} when readBody resolves null, beating the inner path guard, before any filesystem side effect', async () => {
    const { captured, calls } = await runFolderPost({
      readBody: async () => null,
    });

    // The destructure of null throws into the outer catch, so the body is the
    // fixed 'Invalid request', never the first inner guard's message. The
    // deepEqual already forces that, so the notDeepEqual below is documentary: it
    // spells out the inner-guard message the null case must NOT return. The
    // load-bearing precedence proof is calls.isValidDir === 0, which shows the
    // destructure threw BEFORE the inner isValidDir guard ran, so the outer catch
    // wins over that guard.
    assert.deepEqual(captured, { status: 400, body: { error: 'Invalid request' } });
    assert.notDeepEqual(captured.body, { error: 'Invalid path. Must start with content/' });

    assert.deepEqual(calls.rateLimit, [{ key: `create-folder:${REMOTE_ADDR}`, limit: 20 }]);
    assert.equal(calls.readBody, 1);
    assert.equal(calls.isValidDir, 0);
    assert.equal(calls.existsSync, 0);
    assert.equal(calls.mkdirSync, 0);
  });
});
