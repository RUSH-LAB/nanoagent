import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

// file-tools.js is CommonJS; load the real module the way the sibling route test
// tests/next-filetools-compare-guards.test.mjs does, so this characterization
// test pins the shipping handlers rather than a copy of them.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

const PROJECT_ROOT = '/fake/root';

// The opts the word-diff git call carries, copied verbatim from the handler so
// the test breaks if the cwd, encoding, or timeout ever drift.
const GIT_OPTS = { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000 };

// The data file versions reads, derived the same way the handler does:
// data/versions.json under PROJECT_ROOT. Pins that the handler loads that file.
const VERSIONS_FILE = nodePath.join(PROJECT_ROOT, 'data', 'versions.json');

// Drive GET /api/file/word-diff with a fully mocked ctx and capture the json()
// response. The handler (server/routes/file-tools.js around line 589) touches
// only url.searchParams (path, hash), isValidFilePath, execFileSync (the single
// git diff subprocess), PROJECT_ROOT and json, so the stub supplies just those.
// Nothing here invokes real git, the real filesystem, or the network.
//   filePath / hash   query values; leave either undefined to omit it
//   isValidFilePath   gate result (defaults to accepting the path)
//   diff              text the stubbed execFileSync returns on the success path
//   fail              when true the stub throws to exercise the soft catch branch
// The returned execCalls array records every git invocation ({cmd, args, opts}),
// so the guard cases prove git never ran and the success case asserts the exact
// args, opts, and order.
async function wordDiff({
  filePath,
  hash,
  isValidFilePath = () => true,
  diff = '',
  fail = false,
} = {}) {
  let captured = null;
  const execCalls = [];
  const ctx = {
    PROJECT_ROOT,
    isValidFilePath,
    execFileSync: (cmd, args, opts) => {
      execCalls.push({ cmd, args, opts });
      if (fail) throw new Error('git: bad revision');
      return diff;
    },
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/file/word-diff');
  if (filePath !== undefined) url.searchParams.set('path', filePath);
  if (hash !== undefined) url.searchParams.set('hash', hash);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/word-diff', ctx);
  return { captured, execCalls };
}

// Drive GET /api/file/versions with a fully mocked ctx and capture the json()
// response. The handler (server/routes/file-tools.js around line 98) is JSON
// data backed, not git backed: it touches only url.searchParams (path),
// isValidFilePath, path.join, PROJECT_ROOT, loadJSON and json. The stub records
// every loadJSON call and the path it received (loadCalls), so the guard case
// proves the data file is never read and the success cases assert the projection.
//   filePath          query value; leave undefined to omit it
//   isValidFilePath   gate result (defaults to accepting the path)
//   stored            the parsed versions map loadJSON returns
async function versions({
  filePath,
  isValidFilePath = () => true,
  stored = {},
} = {}) {
  let captured = null;
  const loadCalls = [];
  const ctx = {
    PROJECT_ROOT,
    path: nodePath,
    isValidFilePath,
    loadJSON: (file) => { loadCalls.push(file); return stored; },
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL('http://localhost/api/file/versions');
  if (filePath !== undefined) url.searchParams.set('path', filePath);
  await fileToolsRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/file/versions', ctx);
  return { captured, loadCalls };
}

describe('GET /api/file/word-diff (parameter guards, success marker counting, soft catch)', () => {
  it('returns 400 {Invalid path} before running git when the path is invalid', async () => {
    // The hash is valid hex, so the path is the only failing condition.
    const { captured, execCalls } = await wordDiff({
      filePath: 'content/post.md',
      hash: 'abc1234',
      isValidFilePath: () => false,
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid path' });
    assert.equal(execCalls.length, 0);
  });

  it('returns 400 {Invalid hash} before running git for a missing, non-hex, too-short, or too-long hash', async () => {
    // Every form the /^[a-f0-9]{4,40}$/i check rejects: omitted (undefined),
    // non-hex characters, shorter than 4, and longer than the 40 character ceiling.
    const rejected = [undefined, 'zzzz', 'g'.repeat(8), 'abc', 'a'.repeat(41)];
    for (const hash of rejected) {
      const { captured, execCalls } = await wordDiff({ filePath: 'content/post.md', hash });
      assert.equal(captured.status, 400, `expected 400 for hash ${JSON.stringify(hash)}`);
      assert.deepEqual(captured.body, { error: 'Invalid hash' });
      assert.equal(execCalls.length, 0, `git ran for rejected hash ${JSON.stringify(hash)}`);
    }
  });

  it('runs git once with the exact word-diff args and counts the {+ and [- markers on success', async () => {
    // Two {+ markers and three [- markers in a canned diff, so wordsAdded is 2
    // and wordsRemoved is 3. The diff text is returned verbatim in the body.
    const DIFF = 'context {+added one+} {+added two+} then [-gone a-] [-gone b-] [-gone c-]';
    const { captured, execCalls } = await wordDiff({
      filePath: 'content/post.md',
      hash: 'abc1234',
      diff: DIFF,
    });
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].cmd, 'git');
    assert.deepEqual(execCalls[0].args, ['diff', '--word-diff=plain', 'abc1234..HEAD', '--', 'content/post.md']);
    assert.deepEqual(execCalls[0].opts, GIT_OPTS);
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { diff: DIFF, wordsAdded: 2, wordsRemoved: 3 });
  });

  it('accepts boundary-valid hashes (4 chars, 40 chars, uppercase hex) and reaches git', async () => {
    // The hex guard is case-insensitive and spans 4 to 40 characters, so each of
    // these passes and reaches git with the matching `${hash}..HEAD` range. An
    // empty diff carries no markers, so both word counts are 0.
    const accepted = ['abcd', 'a'.repeat(40), 'ABCDEF'];
    for (const hash of accepted) {
      const { captured, execCalls } = await wordDiff({
        filePath: 'content/post.md',
        hash,
        diff: '',
      });
      assert.equal(execCalls.length, 1, `git did not run for accepted hash ${JSON.stringify(hash)}`);
      assert.deepEqual(execCalls[0].args, ['diff', '--word-diff=plain', `${hash}..HEAD`, '--', 'content/post.md']);
      assert.equal(captured.status, 200);
      assert.deepEqual(captured.body, { diff: '', wordsAdded: 0, wordsRemoved: 0 });
    }
  });

  it('returns 200 with an empty diff when git throws (soft fail, not a 500)', async () => {
    const { captured, execCalls } = await wordDiff({
      filePath: 'content/post.md',
      hash: 'abc1234',
      fail: true,
    });
    // git ran and threw; the catch converts it to a 200 empty diff, never a 500.
    assert.equal(execCalls.length, 1);
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { diff: '', wordsAdded: 0, wordsRemoved: 0 });
  });
});

describe('GET /api/file/versions (path guard, unknown path, projection + reverse + total)', () => {
  it('returns 400 {Invalid path} without reading the versions file when the path is invalid', async () => {
    const { captured, loadCalls } = await versions({
      filePath: 'content/post.md',
      isValidFilePath: () => false,
    });
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: 'Invalid path' });
    assert.equal(loadCalls.length, 0);
  });

  it('returns 200 {versions: [], total: 0} for a path absent from the versions map', async () => {
    // The stored map holds another file, so versions[filePath] is undefined and
    // the `|| []` fallback yields an empty list and a zero total.
    const { captured, loadCalls } = await versions({
      filePath: 'content/post.md',
      stored: { 'content/other.md': [{ id: 'ver_x', label: 'X', createdAt: '2024-01-01T00:00:00.000Z', wordCount: 1 }] },
    });
    assert.equal(loadCalls.length, 1);
    assert.equal(loadCalls[0], VERSIONS_FILE);
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, { versions: [], total: 0 });
  });

  it('projects each version to {id, label, createdAt, wordCount} newest first with the correct total', async () => {
    // Stored oldest first; the handler reverses the projection so the newest
    // version leads. total is the count, unchanged by the in-place reverse.
    const stored = {
      'content/post.md': [
        { id: 'ver_1', label: 'First', createdAt: '2024-01-01T00:00:00.000Z', wordCount: 10 },
        { id: 'ver_2', label: 'Second', createdAt: '2024-01-02T00:00:00.000Z', wordCount: 20 },
        { id: 'ver_3', label: 'Third', createdAt: '2024-01-03T00:00:00.000Z', wordCount: 30 },
      ],
    };
    const { captured } = await versions({ filePath: 'content/post.md', stored });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, {
      versions: [
        { id: 'ver_3', label: 'Third', createdAt: '2024-01-03T00:00:00.000Z', wordCount: 30 },
        { id: 'ver_2', label: 'Second', createdAt: '2024-01-02T00:00:00.000Z', wordCount: 20 },
        { id: 'ver_1', label: 'First', createdAt: '2024-01-01T00:00:00.000Z', wordCount: 10 },
      ],
      total: 3,
    });
  });

  it('drops extra stored fields via the projection while total reflects the pre-reverse length', async () => {
    // Each stored version carries content and other fields beyond the four the
    // projection keeps; the response must expose only {id, label, createdAt, wordCount}.
    const stored = {
      'content/post.md': [
        { id: 'ver_1', label: 'First', createdAt: '2024-01-01T00:00:00.000Z', wordCount: 10, content: 'full body one', author: 'a' },
        { id: 'ver_2', label: 'Second', createdAt: '2024-01-02T00:00:00.000Z', wordCount: 20, content: 'full body two', author: 'b' },
      ],
    };
    const { captured } = await versions({ filePath: 'content/post.md', stored });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.body, {
      versions: [
        { id: 'ver_2', label: 'Second', createdAt: '2024-01-02T00:00:00.000Z', wordCount: 20 },
        { id: 'ver_1', label: 'First', createdAt: '2024-01-01T00:00:00.000Z', wordCount: 10 },
      ],
      total: 2,
    });
    // Each projected object exposes exactly the four whitelisted keys.
    for (const v of captured.body.versions) {
      assert.deepEqual(Object.keys(v).sort(), ['createdAt', 'id', 'label', 'wordCount']);
    }
  });
});
