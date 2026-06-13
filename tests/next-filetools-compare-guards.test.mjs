import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

// file-tools.js is CommonJS; load the real module the way the sibling route
// tests do so this characterization test pins the shipping handler, not a copy.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/fake/root';

// Drive GET /api/file/compare with a fully mocked ctx and capture the json()
// response. The handler (server/routes/file-tools.js around line 607) touches
// only url.searchParams (path, hash1, hash2), isValidFilePath, execFileSync (the
// git show / git log subprocess calls), path.join, fs.existsSync, fs.readFileSync
// and json, so the stub supplies just those. Nothing here invokes real git, the
// real filesystem, or the network.
//
//   filePath / hash1 / hash2  query values; leave any undefined to omit it
//   isValidFilePath           gate result (defaults to accepting the path)
//   gitReturns                values the stubbed execFileSync returns, one per
//                             call in order (git show, git log, ...)
//   failOnCall                1-based index of the execFileSync call that should
//                             throw, exercising the 500 catch; null disables it
//   existsSync                fs.existsSync result for the hash2 === 'current'
//                             branch (defaults to true)
//   fileContent               text the stubbed fs.readFileSync returns
//
// The returned execCalls array records every git invocation ({cmd, args, opts}),
// which lets the guard cases prove git never ran (execCalls.length 0) and the
// success cases assert the exact args, opts, and order. readCalls counts working
// file reads so the 404 case can prove fs.readFileSync was skipped.
async function compare({
  filePath,
  hash1,
  hash2,
  isValidFilePath = () => true,
  gitReturns = [],
  failOnCall = null,
  existsSync = () => true,
  fileContent = '',
} = {}) {
  let captured = null;
  const execCalls = [];
  let readCalls = 0;
  const ctx = {
    PROJECT_ROOT,
    isValidFilePath,
    path: nodePath,
    fs: {
      existsSync,
      readFileSync: () => { readCalls += 1; return fileContent; },
    },
    execFileSync: (cmd, args, opts) => {
      execCalls.push({ cmd, args, opts });
      if (failOnCall !== null && execCalls.length === failOnCall) {
        throw new Error('git: bad revision');
      }
      return gitReturns[execCalls.length - 1] ?? '';
    },
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/file/compare');
  if (filePath !== undefined) url.searchParams.set('path', filePath);
  if (hash1 !== undefined) url.searchParams.set('hash1', hash1);
  if (hash2 !== undefined) url.searchParams.set('hash2', hash2);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/compare', ctx);
  return { captured, execCalls, readCalls };
}

// The opts every git call shares, copied verbatim from the handler so the test
// breaks if the cwd, encoding, or timeout ever drift.
const GIT_OPTS = { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000 };

describe('GET /api/file/compare (parameter guards, two-hash + current success, 500 fallback)', () => {
  it('returns 400 {Invalid path} before running git when the path is invalid', async () => {
    // hash1 and hash2 are valid hex, so the path is the only failing condition.
    const { captured, execCalls } = await compare({
      filePath: 'content/post.md',
      hash1: 'abc1234',
      hash2: 'def5678',
      isValidFilePath: () => false,
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid path' });
    assert.equal(execCalls.length, 0);
  });

  it('returns 400 {Invalid hash1} before running git for a missing or non-hex hash1', async () => {
    // The path is valid and hash2 is valid hex, so hash1 is the failing field.
    // Cover an omitted hash1 (undefined), a non-hex string, a too-short one, and
    // a too-long one past the 40 character ceiling of the {4,40} quantifier.
    const cases = [undefined, 'zzzz', 'abc', 'a'.repeat(41)];
    for (const hash1 of cases) {
      const { captured, execCalls } = await compare({
        filePath: 'content/post.md',
        hash1,
        hash2: 'def5678',
      });
      assert.equal(captured.status, 400, `expected 400 for hash1 ${JSON.stringify(hash1)}`);
      assert.deepEqual(captured.body, { error: 'Invalid hash1' });
      assert.equal(execCalls.length, 0, `git ran for rejected hash1 ${JSON.stringify(hash1)}`);
    }
  });

  it('returns 400 {Invalid hash2} before running git for a missing or non-hex hash2 (not "current")', async () => {
    // The path and hash1 are valid, so hash2 is the failing field. The literal
    // "current" is exempt from the hex check, so it is covered by the success
    // cases below, never here. Cover an omitted hash2, a non-hex string, a
    // too-short one, and a too-long one past the 40 character ceiling.
    const cases = [undefined, 'zzzz', 'abc', 'a'.repeat(41)];
    for (const hash2 of cases) {
      const { captured, execCalls } = await compare({
        filePath: 'content/post.md',
        hash1: 'abc1234',
        hash2,
      });
      assert.equal(captured.status, 400, `expected 400 for hash2 ${JSON.stringify(hash2)}`);
      assert.deepEqual(captured.body, { error: 'Invalid hash2' });
      assert.equal(execCalls.length, 0, `git ran for rejected hash2 ${JSON.stringify(hash2)}`);
    }
  });

  it('makes exactly four ordered git calls and returns 200 with both versions for two real hashes', async () => {
    // git show output is passed through verbatim; git log output is trimmed. The
    // returns below carry a trailing newline so the assertions prove the trim
    // applies to the dates only, not to the file contents.
    const { captured, execCalls } = await compare({
      filePath: 'content/post.md',
      hash1: 'abc1234',
      hash2: 'def5678',
      gitReturns: [
        'old file body\n',
        '2024-01-01 10:00:00 +0000\n',
        'newer file body\n',
        '2024-02-02 12:00:00 +0000\n',
      ],
    });
    assert.equal(execCalls.length, 4);
    assert.deepEqual(execCalls.map(c => c.cmd), ['git', 'git', 'git', 'git']);
    assert.deepEqual(execCalls[0].args, ['show', 'abc1234:content/post.md']);
    assert.deepEqual(execCalls[1].args, ['log', '-1', '--format=%ai', 'abc1234']);
    assert.deepEqual(execCalls[2].args, ['show', 'def5678:content/post.md']);
    assert.deepEqual(execCalls[3].args, ['log', '-1', '--format=%ai', 'def5678']);
    for (const call of execCalls) assert.deepEqual(call.opts, GIT_OPTS);
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, {
      version1: { hash: 'abc1234', content: 'old file body\n', date: '2024-01-01 10:00:00 +0000' },
      version2: { hash: 'def5678', content: 'newer file body\n', date: '2024-02-02 12:00:00 +0000' },
    });
  });

  it('accepts boundary-valid hashes (4 chars, 40 chars, uppercase hex) and reaches git', async () => {
    // The hex guard is case-insensitive and spans 4 to 40 characters. Pair each
    // accepted hash1 with hash2 === "current" so the working-file branch keeps
    // the call count at two and isolates the hash1 guard boundary.
    const accepted = ['abcd', 'a'.repeat(40), 'ABCDEF'];
    for (const hash1 of accepted) {
      const { captured, execCalls } = await compare({
        filePath: 'content/post.md',
        hash1,
        hash2: 'current',
        gitReturns: ['body\n', '2024-01-01 10:00:00 +0000\n'],
        fileContent: 'working copy\n',
      });
      assert.equal(execCalls.length, 2, `git did not run for accepted hash1 ${JSON.stringify(hash1)}`);
      assert.deepEqual(execCalls[0].args, ['show', `${hash1}:content/post.md`]);
      assert.equal(captured.status, 200);
      assert.equal(captured.body.version1.hash, hash1);
    }
  });

  it('reads the working file (not git) for hash2 === "current" and returns version2.hash "current"', async () => {
    const { captured, execCalls, readCalls } = await compare({
      filePath: 'content/post.md',
      hash1: 'abc1234',
      hash2: 'current',
      gitReturns: ['old file body\n', '2024-01-01 10:00:00 +0000\n'],
      existsSync: () => true,
      fileContent: 'working copy body\n',
    });
    // Only the two hash1 git calls run; hash2 === "current" never shells out.
    assert.equal(execCalls.length, 2);
    assert.deepEqual(execCalls[0].args, ['show', 'abc1234:content/post.md']);
    assert.deepEqual(execCalls[1].args, ['log', '-1', '--format=%ai', 'abc1234']);
    for (const call of execCalls) assert.deepEqual(call.opts, GIT_OPTS);
    assert.equal(readCalls, 1);
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body.version1, {
      hash: 'abc1234', content: 'old file body\n', date: '2024-01-01 10:00:00 +0000',
    });
    assert.equal(captured.body.version2.hash, 'current');
    assert.equal(captured.body.version2.content, 'working copy body\n');
    // version2.date comes from new Date().toISOString(); pin the type, never the clock.
    assert.equal(typeof captured.body.version2.date, 'string');
  });

  it('returns 404 {File not found} for hash2 === "current" when the working file is absent', async () => {
    const { captured, execCalls, readCalls } = await compare({
      filePath: 'content/post.md',
      hash1: 'abc1234',
      hash2: 'current',
      gitReturns: ['old file body\n', '2024-01-01 10:00:00 +0000\n'],
      existsSync: () => false,
    });
    // The two hash1 git calls already ran before the existsSync check fails.
    assert.equal(execCalls.length, 2);
    assert.equal(captured.status, 404);
    assert.deepEqual(captured.body, { error: 'File not found' });
    // readFileSync is skipped once existsSync reports the file missing.
    assert.equal(readCalls, 0);
  });

  it('returns 500 {Failed to retrieve file versions} when the first git call throws', async () => {
    const { captured, execCalls } = await compare({
      filePath: 'content/post.md',
      hash1: 'abc1234',
      hash2: 'def5678',
      failOnCall: 1,
    });
    // The throwing call is recorded, then the catch converts it to a 500.
    assert.equal(execCalls.length, 1);
    assert.equal(captured.status, 500);
    assert.deepEqual(captured.body, { error: 'Failed to retrieve file versions' });
  });
});
