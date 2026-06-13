import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// files.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const filesRoutes = require('../server/routes/files.js');

const PROJECT_ROOT = '/fake/root';

// The exact 400 body the GET /api/history/diff guard returns when the path is
// invalid, the hash is missing, or the hash fails the hex check. Copied verbatim
// from server/routes/files.js so the test breaks if the wording ever drifts.
const GUARD_MESSAGE =
  'Missing or invalid query parameters: "path" must be a valid file path and "hash" must be a 4-40 character hex string';

// Drive GET /api/history/diff with a mocked ctx and capture the json() response.
// The handler only touches url.searchParams (path + hash), isValidFilePath,
// execFileSync (the git diff) and json, so the stub supplies just those.
//   path / hash      query values; omit either to leave it off the URL
//   isValidFilePath  gate result (defaults to accepting the path)
//   diff             text the stubbed execFileSync returns on the success path
//   fail             when true the stub throws to exercise the catch branch
// The returned execCalls counter is what lets the guard cases prove git never ran.
async function getDiff({ path, hash, isValidFilePath = () => true, diff = '', fail = false } = {}) {
  let captured = null;
  let git = null;
  let execCalls = 0;
  const ctx = {
    PROJECT_ROOT,
    isValidFilePath,
    execFileSync: (cmd, args, opts) => {
      execCalls += 1;
      git = { cmd, args, opts };
      if (fail) throw new Error('git unavailable');
      return diff;
    },
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/history/diff');
  if (path !== undefined) url.searchParams.set('path', path);
  if (hash !== undefined) url.searchParams.set('hash', hash);
  await filesRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/history/diff', ctx);
  return { captured, git, execCalls };
}

describe('GET /api/history/diff (parameter guard, success, error fallback)', () => {
  it('returns 400 before running git when the path is invalid', async () => {
    // The hash is a valid hex string, so the path is the only failing condition.
    const { captured, execCalls } = await getDiff({
      path: 'content/post.md',
      hash: 'abc1234',
      isValidFilePath: () => false,
    });
    assert.equal(captured.status, 400);
    assert.equal(captured.body.error, GUARD_MESSAGE);
    assert.equal(execCalls, 0);
  });

  it('returns 400 before running git when the hash is missing', async () => {
    // Path is valid; the hash query param is absent, so get('hash') is null.
    const { captured, execCalls } = await getDiff({ path: 'content/post.md' });
    assert.equal(captured.status, 400);
    assert.equal(captured.body.error, GUARD_MESSAGE);
    assert.equal(execCalls, 0);
  });

  it('returns 400 before running git when the hash is not a valid hex string', async () => {
    // Every form the /^[a-f0-9]{4,40}$/i check rejects: too short, non-hex
    // characters, and longer than 40 characters.
    const rejected = ['abc', 'xyzxyz', 'g'.repeat(8), 'a'.repeat(41)];
    for (const hash of rejected) {
      const { captured, execCalls } = await getDiff({ path: 'content/post.md', hash });
      assert.equal(captured.status, 400, `expected 400 for hash ${JSON.stringify(hash)}`);
      assert.equal(captured.body.error, GUARD_MESSAGE);
      assert.equal(execCalls, 0, `git ran for rejected hash ${JSON.stringify(hash)}`);
    }
  });

  it('runs git diff once and returns 200 {diff} on the success path', async () => {
    const DIFF = 'patch text line one\npatch text line two\n';
    const { captured, git, execCalls } = await getDiff({
      path: 'content/post.md',
      hash: 'abc1234',
      diff: DIFF,
    });
    assert.equal(execCalls, 1);
    assert.equal(git.cmd, 'git');
    assert.deepEqual(git.args, ['diff', 'abc1234~1..abc1234', '--', 'content/post.md']);
    assert.deepEqual(git.opts, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000 });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { diff: DIFF });
  });

  it('accepts boundary-valid hashes (4 chars, 40 chars, uppercase hex)', async () => {
    // The hex check is case-insensitive and spans 4 to 40 characters, so each of
    // these passes the guard and reaches git.
    const accepted = ['abcd', 'a'.repeat(40), 'ABCDEF'];
    for (const hash of accepted) {
      const { captured, git, execCalls } = await getDiff({ path: 'content/post.md', hash });
      assert.equal(execCalls, 1, `git did not run for accepted hash ${JSON.stringify(hash)}`);
      assert.deepEqual(git.args, ['diff', `${hash}~1..${hash}`, '--', 'content/post.md']);
      assert.equal(captured.status, 200);
    }
  });

  it('returns 200 {diff: ""} when git throws', async () => {
    const { captured, execCalls } = await getDiff({
      path: 'content/post.md',
      hash: 'abc1234',
      fail: true,
    });
    assert.equal(execCalls, 1);
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { diff: '' });
  });
});
