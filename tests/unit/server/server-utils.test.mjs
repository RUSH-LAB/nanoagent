import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

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

describe('isValidFilePath', () => {
  it('accepts a valid .md path under content/', () => {
    assert.equal(isValidFilePath('content/hello.md'), true);
  });

  it('accepts a valid .mdx path under content/', () => {
    assert.equal(isValidFilePath('content/hello.mdx'), true);
  });

  it('accepts nested subdirectories', () => {
    assert.equal(isValidFilePath('content/a/b/c/file.md'), true);
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
    const longPath = 'content/' + 'a'.repeat(490) + '.md';
    assert.equal(longPath.length > 500, true);
    assert.equal(isValidFilePath(longPath), false);
  });

  it('accepts path exactly 500 chars long with basename <= 200', () => {
    // Build a 500-char path with basename under 200 by using subdirs.
    // 'content/' = 8, need 492 more chars. Use dirs to keep basename short.
    // e.g. content/ + 'a/'.repeat(N) + basename + .md
    // basename: 'x'.repeat(197) + '.md' = 200 chars
    // dirs: 'a/'.repeat(146) = 292 chars
    // total: 8 + 292 + 200 = 500
    const dirs = 'a/'.repeat(146);
    const basename = 'x'.repeat(197) + '.md';
    const p = 'content/' + dirs + basename;
    assert.equal(p.length, 500);
    assert.equal(basename.length, 200);
    assert.equal(isValidFilePath(p), true);
  });

  it('rejects traversal attack with ../', () => {
    assert.equal(isValidFilePath('../etc/passwd.md'), false);
  });

  it('rejects traversal embedded in path (content/../..)', () => {
    assert.equal(isValidFilePath('content/../../etc/passwd.md'), false);
  });

  it('rejects absolute paths', () => {
    assert.equal(isValidFilePath('/content/hello.md'), false);
  });

  it('rejects paths not starting with content/', () => {
    assert.equal(isValidFilePath('other/hello.md'), false);
  });

  it('rejects wrong extension .txt', () => {
    assert.equal(isValidFilePath('content/hello.txt'), false);
  });

  it('rejects wrong extension .js', () => {
    assert.equal(isValidFilePath('content/hello.js'), false);
  });

  it('rejects no extension', () => {
    assert.equal(isValidFilePath('content/hello'), false);
  });

  it('rejects basename longer than 200 chars', () => {
    const name = 'a'.repeat(198) + '.md'; // 201 chars
    assert.equal(isValidFilePath('content/' + name), false);
  });

  it('accepts basename exactly 200 chars', () => {
    const name = 'a'.repeat(197) + '.md'; // 200 chars
    assert.equal(name.length, 200);
    assert.equal(isValidFilePath('content/' + name), true);
  });

  it('rejects path that merely contains "content" but not at root', () => {
    assert.equal(isValidFilePath('notcontent/file.md'), false);
  });

  it('handles path with ./content/ prefix', () => {
    // path.normalize('./content/file.md') => 'content/file.md'
    assert.equal(isValidFilePath('./content/file.md'), true);
  });
});

// ─── isValidDir ───────────────────────────────────────────────────────────────

describe('isValidDir', () => {
  it('accepts "content" root', () => {
    assert.equal(isValidDir('content'), true);
  });

  it('accepts "content/" with trailing slash', () => {
    assert.equal(isValidDir('content/'), true);
  });

  it('accepts content subdirectory', () => {
    assert.equal(isValidDir('content/posts'), true);
  });

  it('accepts deeply nested content subdirectory', () => {
    assert.equal(isValidDir('content/a/b/c'), true);
  });

  it('rejects empty string', () => {
    assert.equal(isValidDir(''), false);
  });

  it('rejects null', () => {
    assert.equal(isValidDir(null), false);
  });

  it('rejects undefined', () => {
    assert.equal(isValidDir(undefined), false);
  });

  it('rejects traversal with ../', () => {
    assert.equal(isValidDir('../content'), false);
  });

  it('rejects traversal inside content path', () => {
    assert.equal(isValidDir('content/../../etc'), false);
  });

  it('rejects absolute path', () => {
    assert.equal(isValidDir('/content'), false);
  });

  it('rejects path not starting with content', () => {
    assert.equal(isValidDir('other/stuff'), false);
  });

  it('rejects path that is prefix of "content" but not "content" itself', () => {
    assert.equal(isValidDir('conten'), false);
  });

  it('handles ./content normalization', () => {
    assert.equal(isValidDir('./content'), true);
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
