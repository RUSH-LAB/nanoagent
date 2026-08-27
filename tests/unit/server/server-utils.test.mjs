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
  parseBibtex,
  parseBibtexAuthors,
  mapBibtexEntryType,
} = require('../../../server/server-utils.js');

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

describe('parseBibtex', () => {
  it('parses a single article entry', () => {
    const input = `@article{doe2020,
      author = {John Doe},
      title = {A Paper},
      year = {2020}
    }`;
    const entries = parseBibtex(input);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entryType, 'article');
    assert.equal(entries[0].citationKey, 'doe2020');
    assert.equal(entries[0].fields.author, 'John Doe');
    assert.equal(entries[0].fields.title, 'A Paper');
    assert.equal(entries[0].fields.year, '2020');
  });

  it('parses multiple entries', () => {
    const input = `@article{a1, title = {Title1}}
    @book{b1, title = {Title2}}`;
    const entries = parseBibtex(input);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].entryType, 'article');
    assert.equal(entries[1].entryType, 'book');
  });

  it('handles quoted values', () => {
    const input = '@article{k1, title = "Quoted Title"}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].fields.title, 'Quoted Title');
  });

  it('handles bare numeric values', () => {
    const input = '@article{k1, year = 2023}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].fields.year, '2023');
  });

  it('handles nested braces in values', () => {
    const input = '@article{k1, title = {A {Nested} Title}}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].fields.title, 'A {Nested} Title');
  });

  it('normalizes entry type to lowercase', () => {
    const input = '@ARTICLE{k1, title = {Test}}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].entryType, 'article');
  });

  it('normalizes field names to lowercase', () => {
    const input = '@article{k1, Title = {Test}, YEAR = {2020}}';
    const entries = parseBibtex(input);
    assert.ok('title' in entries[0].fields);
    assert.ok('year' in entries[0].fields);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseBibtex(''), []);
  });

  it('returns empty array for non-bibtex text', () => {
    assert.deepEqual(parseBibtex('just some random text'), []);
  });

  it('skips malformed entries without proper header', () => {
    const input = '@article{, title = {No Key}}';
    const entries = parseBibtex(input);
    assert.equal(entries.length, 0);
  });

  it('handles entries with many fields', () => {
    const input = `@inproceedings{smith2021,
      author = {Jane Smith},
      title = {Great Work},
      booktitle = {Proc ICML},
      year = {2021},
      pages = {1--10},
      publisher = {ACM}
    }`;
    const entries = parseBibtex(input);
    assert.equal(entries[0].fields.author, 'Jane Smith');
    assert.equal(entries[0].fields.booktitle, 'Proc ICML');
    assert.equal(entries[0].fields.pages, '1--10');
    assert.equal(entries[0].fields.publisher, 'ACM');
  });

  it('handles @InProceedings with mixed case', () => {
    const input = '@InProceedings{key1, title = {T}}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].entryType, 'inproceedings');
  });

  it('preserves citation key as-is', () => {
    const input = '@article{CamelCase_Key-123, title = {T}}';
    const entries = parseBibtex(input);
    assert.equal(entries[0].citationKey, 'CamelCase_Key-123');
  });
});

// ─── parseBibtexAuthors ───────────────────────────────────────────────────────

describe('parseBibtexAuthors', () => {
  it('parses single "First Last" author', () => {
    assert.deepEqual(parseBibtexAuthors('John Doe'), ['John Doe']);
  });

  it('parses single "Last, First" author', () => {
    assert.deepEqual(parseBibtexAuthors('Doe, John'), ['John Doe']);
  });

  it('parses multiple authors separated by " and "', () => {
    const result = parseBibtexAuthors('John Doe and Jane Smith');
    assert.deepEqual(result, ['John Doe', 'Jane Smith']);
  });

  it('handles "Last, First" for multiple authors', () => {
    const result = parseBibtexAuthors('Doe, John and Smith, Jane');
    assert.deepEqual(result, ['John Doe', 'Jane Smith']);
  });

  it('handles mixed author formats', () => {
    const result = parseBibtexAuthors('Doe, John and Jane Smith');
    assert.deepEqual(result, ['John Doe', 'Jane Smith']);
  });

  it('returns empty array for null', () => {
    assert.deepEqual(parseBibtexAuthors(null), []);
  });

  it('returns empty array for undefined', () => {
    assert.deepEqual(parseBibtexAuthors(undefined), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseBibtexAuthors(''), []);
  });

  it('handles author with middle name in "First Last" format', () => {
    assert.deepEqual(parseBibtexAuthors('John M. Doe'), ['John M. Doe']);
  });

  it('handles "Last, First Middle" format', () => {
    const result = parseBibtexAuthors('Doe, John M.');
    assert.deepEqual(result, ['John M. Doe']);
  });

  it('handles single-name author (mononym)', () => {
    assert.deepEqual(parseBibtexAuthors('Aristotle'), ['Aristotle']);
  });

  it('handles three authors', () => {
    const result = parseBibtexAuthors('Alice A and Bob B and Charlie C');
    assert.deepEqual(result, ['Alice A', 'Bob B', 'Charlie C']);
  });
});

// ─── mapBibtexEntryType ───────────────────────────────────────────────────────

describe('mapBibtexEntryType', () => {
  it('maps "article" to "article"', () => {
    assert.equal(mapBibtexEntryType('article'), 'article');
  });

  it('maps "inproceedings" to "inproceedings"', () => {
    assert.equal(mapBibtexEntryType('inproceedings'), 'inproceedings');
  });

  it('maps "conference" to "inproceedings"', () => {
    assert.equal(mapBibtexEntryType('conference'), 'inproceedings');
  });

  it('maps "book" to "book"', () => {
    assert.equal(mapBibtexEntryType('book'), 'book');
  });

  it('maps "phdthesis" to "phdthesis"', () => {
    assert.equal(mapBibtexEntryType('phdthesis'), 'phdthesis');
  });

  it('maps "mastersthesis" to "mastersthesis"', () => {
    assert.equal(mapBibtexEntryType('mastersthesis'), 'mastersthesis');
  });

  it('maps "techreport" to "techreport"', () => {
    assert.equal(mapBibtexEntryType('techreport'), 'techreport');
  });

  it('maps "misc" to "misc"', () => {
    assert.equal(mapBibtexEntryType('misc'), 'misc');
  });

  it('maps "unpublished" to "unpublished"', () => {
    assert.equal(mapBibtexEntryType('unpublished'), 'unpublished');
  });

  it('maps "incollection" to "incollection"', () => {
    assert.equal(mapBibtexEntryType('incollection'), 'incollection');
  });

  it('maps "inbook" to "inbook"', () => {
    assert.equal(mapBibtexEntryType('inbook'), 'inbook');
  });

  it('maps "proceedings" to "proceedings"', () => {
    assert.equal(mapBibtexEntryType('proceedings'), 'proceedings');
  });

  it('maps unknown type to "misc"', () => {
    assert.equal(mapBibtexEntryType('somethingelse'), 'misc');
  });

  it('maps undefined to "misc"', () => {
    assert.equal(mapBibtexEntryType(undefined), 'misc');
  });
});
