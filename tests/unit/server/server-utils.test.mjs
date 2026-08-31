import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  ALLOWED_EXTS,
  IMAGE_EXTS,
  MAX_BODY_SIZE,
  MAX_TEXT_LENGTH,
  MAX_PRESENCE_FILES,
  MAX_PRESENCE_USERS_PER_FILE,
  isValidFilePath,
  isValidDir,
  resolveContentPath,
  sanitizeText,
  makeRateLimiter,
  makeCache,
  makePresenceStore,
} = require('../../../src/server/server-utils.js');

// ─── Constants ────────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('ALLOWED_EXTS contains .md and .mdx', () => {
    assert.deepEqual(ALLOWED_EXTS, ['.md', '.mdx']);
  });

  it('IMAGE_EXTS contains common image formats', () => {
    assert.deepEqual(IMAGE_EXTS, ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
  });

  it('MAX_BODY_SIZE is 10 MiB', () => {
    assert.equal(MAX_BODY_SIZE, 10 * 1024 * 1024);
  });

  it('MAX_TEXT_LENGTH is 10000', () => {
    assert.equal(MAX_TEXT_LENGTH, 10000);
  });

  it('MAX_PRESENCE_FILES is 500', () => {
    assert.equal(MAX_PRESENCE_FILES, 500);
  });

  it('MAX_PRESENCE_USERS_PER_FILE is 50', () => {
    assert.equal(MAX_PRESENCE_USERS_PER_FILE, 50);
  });
});

// ─── isValidFilePath ──────────────────────────────────────────────────────────

// A path on the wire is relative to the caller's own workspace: `hello.md`, not
// `content/mochi/hello.md`. Which workspace that is comes from the verified
// session, so there is no `content/` prefix left to require and no organization
// a request could name. What is left to check is the shape of the name;
// containment is resolveContentPath's job, below.
describe('isValidFilePath', () => {
  it('accepts a valid .md path at the workspace root', () => {
    assert.equal(isValidFilePath('hello.md'), true);
  });

  it('accepts a valid .mdx path at the workspace root', () => {
    assert.equal(isValidFilePath('hello.mdx'), true);
  });

  it('accepts nested subdirectories', () => {
    assert.equal(isValidFilePath('books/a/b/c/file.md'), true);
  });

  it('rejects empty string', () => {
    assert.equal(isValidFilePath(''), false);
  });

  it('rejects null', () => {
    assert.equal(isValidFilePath(null), false);
  });

  it('rejects undefined', () => {
    assert.equal(isValidFilePath(undefined), false);
  });

  it('rejects path longer than 500 chars', () => {
    // One char over, with a basename well under its own 200 limit, so the
    // length gate is the only thing rejecting it.
    const longPath = 'a/'.repeat(151) + 'x'.repeat(196) + '.md';
    assert.equal(longPath.length, 501);
    assert.equal(isValidFilePath(longPath), false);
  });

  it('accepts path exactly 500 chars long with basename <= 200', () => {
    // Build a 500-char path with basename under 200 by using subdirs.
    // basename: 'x'.repeat(197) + '.md' = 200 chars
    // dirs: 'a/'.repeat(150) = 300 chars
    // total: 300 + 200 = 500
    const dirs = 'a/'.repeat(150);
    const basename = 'x'.repeat(197) + '.md';
    const p = dirs + basename;
    assert.equal(p.length, 500);
    assert.equal(basename.length, 200);
    assert.equal(isValidFilePath(p), true);
  });

  it('rejects traversal attack with ../', () => {
    assert.equal(isValidFilePath('../etc/passwd.md'), false);
  });

  it('rejects traversal embedded in path (books/../..)', () => {
    assert.equal(isValidFilePath('books/../../etc/passwd.md'), false);
  });

  it('rejects absolute paths', () => {
    assert.equal(isValidFilePath('/etc/hello.md'), false);
  });

  it('accepts any workspace-relative directory, not only content/', () => {
    // The prefix check is gone with the prefix: the server prepends the
    // workspace root, so `other/hello.md` is this workspace's own file.
    assert.equal(isValidFilePath('other/hello.md'), true);
    assert.equal(isValidFilePath('content/hello.md'), true);
  });

  it('rejects wrong extension .txt', () => {
    assert.equal(isValidFilePath('hello.txt'), false);
  });

  it('rejects wrong extension .js', () => {
    assert.equal(isValidFilePath('hello.js'), false);
  });

  it('rejects no extension', () => {
    assert.equal(isValidFilePath('hello'), false);
  });

  it('rejects basename longer than 200 chars', () => {
    const name = 'a'.repeat(198) + '.md'; // 201 chars
    assert.equal(isValidFilePath('books/' + name), false);
  });

  it('accepts basename exactly 200 chars', () => {
    const name = 'a'.repeat(197) + '.md'; // 200 chars
    assert.equal(name.length, 200);
    assert.equal(isValidFilePath('books/' + name), true);
  });

  it('accepts a path that normalizes back inside the workspace', () => {
    // path.normalize('books/../posts/file.md') => 'posts/file.md', which never
    // leaves the tree, unlike the '../' cases above.
    assert.equal(isValidFilePath('books/../posts/file.md'), true);
  });

  it('handles a ./ prefix', () => {
    // path.normalize('./books/file.md') => 'books/file.md'
    assert.equal(isValidFilePath('./books/file.md'), true);
  });
});

// ─── isValidDir ───────────────────────────────────────────────────────────────

// The same rule for a directory, which has no extension to check, plus one
// addition: the workspace root itself is now addressable. GET /api/files?dir=
// asks for the whole tree, and with the `content/` prefix gone the name of the
// root is the empty string.
describe('isValidDir', () => {
  it('accepts the empty string, which names the workspace root', () => {
    assert.equal(isValidDir(''), true);
  });

  it('accepts "." as the same root spelled the other way', () => {
    assert.equal(isValidDir('.'), true);
  });

  it('accepts a top-level directory', () => {
    assert.equal(isValidDir('posts'), true);
  });

  it('accepts a trailing slash', () => {
    assert.equal(isValidDir('posts/'), true);
  });

  it('accepts a nested subdirectory', () => {
    assert.equal(isValidDir('books/math'), true);
  });

  it('accepts a deeply nested subdirectory', () => {
    assert.equal(isValidDir('a/b/c/d'), true);
  });

  it('rejects null', () => {
    assert.equal(isValidDir(null), false);
  });

  it('rejects undefined', () => {
    assert.equal(isValidDir(undefined), false);
  });

  it('rejects a directory longer than 500 chars', () => {
    assert.equal(isValidDir('a/'.repeat(251)), false);
  });

  it('rejects traversal with ../', () => {
    assert.equal(isValidDir('../content'), false);
  });

  it('rejects traversal out through a subdirectory', () => {
    assert.equal(isValidDir('books/../../etc'), false);
  });

  it('rejects absolute path', () => {
    assert.equal(isValidDir('/etc'), false);
  });

  it('accepts any workspace-relative directory, not only content/', () => {
    // Same reason as isValidFilePath: the prefix went away with the prefix.
    assert.equal(isValidDir('other/stuff'), true);
    assert.equal(isValidDir('content'), true);
  });

  it('accepts a traversal that normalizes back inside the workspace', () => {
    assert.equal(isValidDir('books/../posts'), true);
  });

  it('handles ./ normalization', () => {
    assert.equal(isValidDir('./posts'), true);
  });
});

// ─── resolveContentPath ───────────────────────────────────────────────────────

// The one place a request's path becomes a real location on disk, and therefore
// the boundary between two organizations. It guards the resolved path rather
// than the string, because 'a/../../b' is a fine-looking string that is not
// inside anything, and answers null rather than throwing so a handler can turn
// an escape into an ordinary 400.
describe('resolveContentPath', () => {
  const ROOT = path.join('/srv', 'content', 'mochi');

  it('resolves a relative path inside the root', () => {
    assert.equal(resolveContentPath(ROOT, 'books/math/0-intro.md'), path.join(ROOT, 'books/math/0-intro.md'));
  });

  it('resolves the root itself for "" and "."', () => {
    assert.equal(resolveContentPath(ROOT, ''), ROOT);
    assert.equal(resolveContentPath(ROOT, '.'), ROOT);
  });

  it('resolves a traversal that lands back inside the root', () => {
    assert.equal(resolveContentPath(ROOT, 'books/../posts/a.md'), path.join(ROOT, 'posts/a.md'));
  });

  it('returns null for a leading ../', () => {
    assert.equal(resolveContentPath(ROOT, '../other/a.md'), null);
  });

  it('returns null for a traversal buried mid-path', () => {
    assert.equal(resolveContentPath(ROOT, 'a/../../b'), null);
  });

  it('returns null for a path that climbs to another organization', () => {
    // The escape the org boundary exists to stop: a sibling workspace is only
    // two levels up, and every character of the string looks harmless.
    assert.equal(resolveContentPath(ROOT, '../acme/books/secret.md'), null);
  });

  it('returns null for an absolute path, which ignores the root entirely', () => {
    assert.equal(resolveContentPath(ROOT, '/etc/passwd'), null);
  });

  it('returns null for the root as its own parent-prefix neighbour', () => {
    // `${ROOT}-other` starts with the root as a string but is not inside it,
    // which is why the guard compares against root + path.sep.
    assert.equal(resolveContentPath(ROOT, '../mochi-other/a.md'), null);
  });

  it('treats a missing path as the root rather than throwing', () => {
    assert.equal(resolveContentPath(ROOT, null), ROOT);
    assert.equal(resolveContentPath(ROOT, undefined), ROOT);
  });
});

// ─── sanitizeText ─────────────────────────────────────────────────────────────

describe('sanitizeText', () => {
  it('returns the string unchanged if short', () => {
    assert.equal(sanitizeText('hello'), 'hello');
  });

  it('returns empty string for null', () => {
    assert.equal(sanitizeText(null), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(sanitizeText(undefined), '');
  });

  it('returns empty string for number', () => {
    assert.equal(sanitizeText(42), '');
  });

  it('returns empty string for boolean', () => {
    assert.equal(sanitizeText(true), '');
  });

  it('returns empty string for object', () => {
    assert.equal(sanitizeText({}), '');
  });

  it('returns empty string when passed empty string', () => {
    assert.equal(sanitizeText(''), '');
  });

  it('truncates to MAX_TEXT_LENGTH (10000)', () => {
    const long = 'x'.repeat(20000);
    const result = sanitizeText(long);
    assert.equal(result.length, 10000);
  });

  it('returns string of exactly MAX_TEXT_LENGTH unchanged', () => {
    const exact = 'a'.repeat(10000);
    assert.equal(sanitizeText(exact), exact);
  });

  it('returns string of MAX_TEXT_LENGTH - 1 unchanged', () => {
    const str = 'b'.repeat(9999);
    assert.equal(sanitizeText(str), str);
  });

  it('returns string of MAX_TEXT_LENGTH + 1 truncated', () => {
    const str = 'c'.repeat(10001);
    const result = sanitizeText(str);
    assert.equal(result.length, 10000);
    assert.equal(result, 'c'.repeat(10000));
  });
});

// ─── makeRateLimiter ──────────────────────────────────────────────────────────

describe('makeRateLimiter', () => {
  it('allows first request', () => {
    const rl = makeRateLimiter();
    assert.equal(rl('key1', 5), true);
  });

  it('allows requests under the limit', () => {
    const rl = makeRateLimiter();
    assert.equal(rl('key1', 3), true);
    assert.equal(rl('key1', 3), true);
    assert.equal(rl('key1', 3), true);
  });

  it('blocks when at limit', () => {
    const rl = makeRateLimiter();
    rl('key1', 2);
    rl('key1', 2);
    assert.equal(rl('key1', 2), false);
  });

  it('tracks different keys independently', () => {
    const rl = makeRateLimiter();
    rl('a', 1);
    assert.equal(rl('a', 1), false);
    assert.equal(rl('b', 1), true);
  });

  it('expires old entries after 60 seconds', () => {
    const rl = makeRateLimiter();
    // Manually inject an old timestamp
    rl._store['old'] = [Date.now() - 61000];
    assert.equal(rl('old', 1), true);
  });

  it('keeps recent entries within 60 seconds', () => {
    const rl = makeRateLimiter();
    rl._store['recent'] = [Date.now() - 30000];
    assert.equal(rl('recent', 1), false);
  });

  it('exposes _store for inspection', () => {
    const rl = makeRateLimiter();
    rl('test', 10);
    assert.ok(Array.isArray(rl._store['test']));
    assert.equal(rl._store['test'].length, 1);
  });
});

// ─── makeCache ────────────────────────────────────────────────────────────────

describe('makeCache', () => {
  it('returns result of fn on cache miss', () => {
    const cached = makeCache();
    const result = cached('k', 1000, () => 'hello');
    assert.equal(result, 'hello');
  });

  it('returns cached value on cache hit within TTL', () => {
    const cached = makeCache();
    let callCount = 0;
    const fn = () => { callCount++; return 'data'; };
    cached('k', 5000, fn);
    const result = cached('k', 5000, fn);
    assert.equal(result, 'data');
    assert.equal(callCount, 1);
  });

  it('calls fn again after TTL expires', () => {
    const cached = makeCache();
    let callCount = 0;
    const fn = () => { callCount++; return `call-${callCount}`; };
    cached('k', 10, fn);
    // Manually expire the entry
    cached._store['k'].time = Date.now() - 20;
    const result = cached('k', 10, fn);
    assert.equal(result, 'call-2');
    assert.equal(callCount, 2);
  });

  it('invalidate() removes matching keys', () => {
    const cached = makeCache();
    cached('posts/a', 5000, () => 'a');
    cached('posts/b', 5000, () => 'b');
    cached('users/c', 5000, () => 'c');
    cached.invalidate('posts');
    assert.equal(cached._store['posts/a'], undefined);
    assert.equal(cached._store['posts/b'], undefined);
    assert.ok(cached._store['users/c']);
  });

  it('invalidate() with no pattern removes all keys', () => {
    const cached = makeCache();
    cached('a', 5000, () => 1);
    cached('b', 5000, () => 2);
    cached.invalidate();
    assert.deepEqual(Object.keys(cached._store), []);
  });

  it('invalidate() with empty string removes all keys', () => {
    const cached = makeCache();
    cached('x', 5000, () => 1);
    cached.invalidate('');
    assert.deepEqual(Object.keys(cached._store), []);
  });

  it('caches different keys independently', () => {
    const cached = makeCache();
    cached('a', 5000, () => 'val-a');
    cached('b', 5000, () => 'val-b');
    assert.equal(cached('a', 5000, () => 'new'), 'val-a');
    assert.equal(cached('b', 5000, () => 'new'), 'val-b');
  });
});

// ─── makePresenceStore ────────────────────────────────────────────────────────

describe('makePresenceStore', () => {
  it('returns store and clean', () => {
    const { store, clean } = makePresenceStore();
    assert.equal(typeof store, 'object');
    assert.equal(typeof clean, 'function');
  });

  it('can add users to the store', () => {
    const { store } = makePresenceStore();
    store['content/file.md'] = {
      user1: { userId: 'user1', userName: 'Alice', cursor: 0, lastSeen: Date.now() },
    };
    assert.equal(store['content/file.md'].user1.userName, 'Alice');
  });

  it('clean() removes stale entries (> 30s ago)', () => {
    const { store, clean } = makePresenceStore();
    store['content/file.md'] = {
      stale: { userId: 'stale', userName: 'Old', cursor: 0, lastSeen: Date.now() - 31000 },
    };
    clean();
    assert.equal(store['content/file.md'], undefined);
  });

  it('clean() keeps fresh entries (<= 30s ago)', () => {
    const { store, clean } = makePresenceStore();
    store['content/file.md'] = {
      fresh: { userId: 'fresh', userName: 'New', cursor: 0, lastSeen: Date.now() },
    };
    clean();
    assert.ok(store['content/file.md'].fresh);
  });

  it('clean() removes file key when all users stale', () => {
    const { store, clean } = makePresenceStore();
    store['content/a.md'] = {
      u1: { userId: 'u1', userName: 'A', cursor: 0, lastSeen: Date.now() - 40000 },
      u2: { userId: 'u2', userName: 'B', cursor: 0, lastSeen: Date.now() - 35000 },
    };
    clean();
    assert.equal(store['content/a.md'], undefined);
  });

  it('clean() keeps file key when some users are fresh', () => {
    const { store, clean } = makePresenceStore();
    store['content/mix.md'] = {
      stale: { userId: 'stale', userName: 'Old', cursor: 0, lastSeen: Date.now() - 40000 },
      fresh: { userId: 'fresh', userName: 'New', cursor: 0, lastSeen: Date.now() },
    };
    clean();
    assert.ok(store['content/mix.md']);
    assert.equal(store['content/mix.md'].stale, undefined);
    assert.ok(store['content/mix.md'].fresh);
  });

  it('clean() caps total file keys to MAX_PRESENCE_FILES', () => {
    const { store, clean } = makePresenceStore();
    for (let i = 0; i < 510; i++) {
      store[`file${i}`] = {
        user: { userId: 'u', userName: 'U', cursor: 0, lastSeen: Date.now() },
      };
    }
    clean();
    assert.ok(Object.keys(store).length <= MAX_PRESENCE_FILES);
  });
});

// ─── parseBibtex ──────────────────────────────────────────────────────────────

// ─── parseBibtexAuthors ───────────────────────────────────────────────────────

// ─── mapBibtexEntryType ───────────────────────────────────────────────────────
