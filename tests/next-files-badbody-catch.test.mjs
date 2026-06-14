import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// files.js is CommonJS; load the real route module and the real path validator the
// way the sibling suites do (next-files-put-write-guards,
// next-files-mutation-error-branches), then drive the handler through a mocked ctx.
// These cases pin the CURRENT behavior of the OUTER catch on the two POST mutation
// handlers those siblings leave uncovered: POST /api/file (create) and
// POST /api/file/rename.
//
// next-files-mutation-error-branches always resolves readBody to a valid object, so
// it exercises only the inner validation guards (Invalid path, Content must be a
// string, File already exists, Source not found, Target already exists) and never
// enters the outer catch. next-files-put-write-guards already pins the parallel PUT
// catch ("Failed to update file: request body..."), so this file applies that
// blessed pattern to the two siblings it does not cover.
//
// Each handler wraps `const body = await readBody(req)` and the destructure of that
// body inside one try, and its catch returns a FIXED 400 string built before any
// filesystem IO. The two triggers below drive that catch two independent ways: a
// readBody that rejects, and a readBody that resolves null (the destructure of null
// throws). The null trigger also pins PRECEDENCE: the catch wins over the inner
// Invalid path guard, so a null body yields the badbody 400, never Invalid path. A
// zero-call fs tripwire whose methods throw on contact proves the catch fires before
// any IO.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');
const { isValidFilePath } = require('../server/server-utils.js');

const PROJECT_ROOT = '/fake/root';

// The exact fixed catch strings from files.js, copied byte for byte from the source
// so the pin fails loudly if either message ever drifts.
const CREATE_BADBODY = 'Failed to create file: request body must be JSON with "path" (string) and "content" (string) fields';
const RENAME_BADBODY = 'Failed to rename file: request body must be JSON with "oldPath" (string) and "newPath" (string) fields';

// An fs whose every mutating method is a tripwire: it counts the call and throws on
// contact. The catch path under test never touches the filesystem, so a green run
// leaves all four counters at zero. If a regression ever let a handler reach fs on
// this path the counter assertion catches it, and the throw keeps a stray write from
// escaping into the test environment.
function makeTripwireFs() {
  const calls = { existsSync: 0, mkdirSync: 0, writeFileSync: 0, renameSync: 0 };
  const trip = (name) => () => {
    calls[name]++;
    throw new Error(`fs.${name} must not run on the badbody catch path`);
  };
  const fs = {
    existsSync: trip('existsSync'),
    mkdirSync: trip('mkdirSync'),
    writeFileSync: trip('writeFileSync'),
    renameSync: trip('renameSync'),
  };
  return { fs, calls };
}

// Drive a files.js route with a mocked ctx and capture the json() response. Mirrors
// the invokeRoute helper in the sibling suites: a fake res, a real URL, a socket so
// any rate-limit key resolves, a default rateLimit that clears the gate, and a json()
// that records { status, body }. Per-test ctx fields (fs, readBody) spread in last.
async function invokeRoute({ method, pathname, ctx }) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    path,
    PROJECT_ROOT,
    isValidFilePath,
    rateLimit: () => true,
    invalidateCache: () => {},
    json(_res, status, body) { captured = { status, body }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await filesRoutes(req, res, url, pathname, fullCtx);
  return captured;
}

// A fresh expected snapshot per assertion: all four tripwire methods untouched.
const ZERO_IO = { existsSync: 0, mkdirSync: 0, writeFileSync: 0, renameSync: 0 };

describe('POST /api/file (create) outer catch', () => {
  it('returns the create badbody 400 when readBody rejects, before any fs IO', async () => {
    const { fs, calls } = makeTripwireFs();
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file',
      ctx: { readBody: async () => { throw new Error('bad json'); }, fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: CREATE_BADBODY });
    assert.deepEqual(calls, ZERO_IO, 'the catch fires before any filesystem call');
  });

  it('returns the create badbody 400 when readBody resolves null, beating the Invalid path guard', async () => {
    const { fs, calls } = makeTripwireFs();
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file',
      ctx: { readBody: async () => null, fs },
    });
    // Destructuring `{ path, content }` from null throws into the catch, so the
    // badbody 400 wins over the inner Invalid path guard, which never runs.
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: CREATE_BADBODY });
    assert.deepEqual(calls, ZERO_IO, 'the null destructure throws before any filesystem call');
  });
});

describe('POST /api/file/rename outer catch', () => {
  it('returns the rename badbody 400 when readBody rejects, before any fs IO', async () => {
    const { fs, calls } = makeTripwireFs();
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file/rename',
      ctx: { readBody: async () => { throw new Error('bad json'); }, fs },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: RENAME_BADBODY });
    assert.deepEqual(calls, ZERO_IO, 'the catch fires before any filesystem call');
  });

  it('returns the rename badbody 400 when readBody resolves null, beating the Invalid path guard', async () => {
    const { fs, calls } = makeTripwireFs();
    const res = await invokeRoute({
      method: 'POST',
      pathname: '/api/file/rename',
      ctx: { readBody: async () => null, fs },
    });
    // Destructuring `{ oldPath, newPath }` from null throws into the catch, so the
    // badbody 400 wins over the inner Invalid path guard, which never runs.
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: RENAME_BADBODY });
    assert.deepEqual(calls, ZERO_IO, 'the null destructure throws before any filesystem call');
  });
});
