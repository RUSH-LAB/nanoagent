import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// api/_github.js is a CommonJS module of shared GitHub API helpers. Load it the
// way the api/ serverless handlers (api/file.js, api/file-rename.js) do, so we
// exercise the exported guard directly. This mirrors tests/server-utils.test.mjs
// and tests/next-files-dir-reject-dotdot.test.mjs.
const require = createRequire(import.meta.url);
const { isValidFilePath } = require('../api/_github.js');

// These tests lock the CURRENT runtime behavior of the api/_github.js copy of
// isValidFilePath, a SECOND guard that diverges from the one in
// server/server-utils.js. The api copy is a raw string check with NO
// path.normalize and NO length cap, so two cases differ from the server copy:
//
//   1. A very long path is ACCEPTED here, because this copy has no length cap.
//      The server copy rejects anything past 500 chars.
//   2. './content/file.md' is REJECTED here, because this copy never normalizes,
//      so the leading './' breaks the 'content/' prefix check. The server copy
//      normalizes first and would accept it.
//
// The assertions below capture what the code does today, not what it ideally
// should do. They are additive and touch no source file.

// ─── Accept ─────────────────────────────────────────────────────────────────

describe('api/_github.js isValidFilePath accepts', () => {
  it('a .md file under content/', () => {
    assert.equal(isValidFilePath('content/hello.md'), true);
  });

  it('a .mdx file under content/', () => {
    assert.equal(isValidFilePath('content/hello.mdx'), true);
  });

  it('a deeply nested path under content/', () => {
    assert.equal(isValidFilePath('content/a/b/c/deep.md'), true);
  });

  it('a very long path, since this copy has no length cap (locks divergence)', () => {
    // The server copy caps at 500 chars and would reject this; the api copy accepts it.
    const longPath = 'content/' + 'a'.repeat(600) + '.md';
    assert.equal(longPath.length > 500, true);
    assert.equal(isValidFilePath(longPath), true);
  });
});

// ─── Reject ─────────────────────────────────────────────────────────────────

describe('api/_github.js isValidFilePath rejects', () => {
  it('an empty string', () => {
    assert.equal(isValidFilePath(''), false);
  });

  it('null', () => {
    assert.equal(isValidFilePath(null), false);
  });

  it('undefined', () => {
    assert.equal(isValidFilePath(undefined), false);
  });

  it('a non-string value', () => {
    assert.equal(isValidFilePath(123), false);
  });

  it('a leading traversal segment', () => {
    assert.equal(isValidFilePath('../etc/passwd.md'), false);
  });

  it('an embedded traversal segment', () => {
    assert.equal(isValidFilePath('content/../../etc/passwd.md'), false);
  });

  it('an absolute path with a leading slash', () => {
    assert.equal(isValidFilePath('/content/hello.md'), false);
  });

  it('a path outside content/', () => {
    assert.equal(isValidFilePath('other/hello.md'), false);
  });

  it('a path that only resembles content/ at the prefix', () => {
    assert.equal(isValidFilePath('notcontent/file.md'), false);
  });

  it('a disallowed extension', () => {
    assert.equal(isValidFilePath('content/hello.txt'), false);
  });

  it('a path with no extension', () => {
    assert.equal(isValidFilePath('content/hello'), false);
  });

  it("a './content/' prefix, since this copy never normalizes (locks divergence)", () => {
    // No path.normalize here, so the leading './' fails the 'content/' prefix
    // check. The server copy normalizes first and would accept this.
    assert.equal(isValidFilePath('./content/file.md'), false);
  });
});
