import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// file-tools.js is CommonJS; load the REAL module via createRequire the way the
// sibling GET /api/search/global suites do (next-globalsearch-500,
// next-filetools-searchglobal-loadcached), so this characterization test drives
// the genuine handler in server/routes/file-tools.js, not a reimplementation.
const require = createRequire(import.meta.url);
const fileToolsRoutes = require('../server/routes/file-tools.js');

// The handler reads the bibliography through the shared loadReferencesCached memo,
// a module-level singleton in references.js. Clear it before each scenario so the
// reference branch re-stats and re-reads deterministically and never inherits the
// parse left behind by another suite.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/agg-root';
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');
const CONTENT_SUBDIR = path.join(CONTENT_DIR, 'sub');
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const COMMENTS_FILE = path.join(PROJECT_ROOT, 'data', 'comments.json');
const DISCUSSIONS_FILE = path.join(PROJECT_ROOT, 'data', 'discussions.json');

// Lower-cased by the handler before any matching, so every fixture body below that
// contains this substring (in any case) is a hit and every body without it is filtered.
const QUERY = 'term';

// Two bodies well over 100 characters, used to pin the handler's text.slice(0, 100)
// truncation on the comment and message branches. Each opens with the query and a
// short readable prefix so the 100-character cut point is visible in the golden.
const LONG_COMMENT = 'term comment ' + 'C'.repeat(200);
const LONG_MESSAGE = 'term message ' + 'M'.repeat(200);

// A Dirent-like entry for the withFileTypes readdir the content scan uses.
const dirent = (name, isDir) => ({ name, isDirectory: () => isDir });

// In-memory content tree. searchContent walks CONTENT_DIR via
// readdirSync(dir, {withFileTypes: true}), skips dotted names, recurses into
// directories, keeps only ALLOWED_EXTS files, and matches on the lower-cased body.
// The tree exercises each of those rules:
//   '.hidden'      a dotted directory, skipped before any recursion
//   'match.md'     an allowed file whose body holds the query -> a content hit
//   'skip.md'      an allowed file whose body lacks the query -> filtered out
//   'notes.txt'    a non-allowed extension                    -> skipped
//   'sub'          a directory, recursed into
//   'sub/deep.md'  an allowed nested file with the query      -> a second content hit
// so the two content hits also pin readdir plus recursion order.
const CONTENT_TREE = {
  [CONTENT_DIR]: [
    dirent('.hidden', true),
    dirent('match.md', false),
    dirent('skip.md', false),
    dirent('notes.txt', false),
    dirent('sub', true),
  ],
  [CONTENT_SUBDIR]: [
    dirent('deep.md', false),
  ],
};

// Bodies for the allowed files above. 'match.md' uses an upper-case TERM to also
// pin the case-insensitive content match; 'skip.md' deliberately holds no hit.
const CONTENT_FILES = {
  [path.join(CONTENT_DIR, 'match.md')]: 'A note about the TERM at the top level.',
  [path.join(CONTENT_DIR, 'skip.md')]: 'An unrelated note with no matching word.',
  [path.join(CONTENT_SUBDIR, 'deep.md')]: 'Nested note mentioning the term again.',
};

// Bibliography fixture for the reference branch. loadReferencesCached parses this
// via js-yaml; the handler then matches on `${key} ${title} ${authors}` lower-cased.
// 'termpaper2020' matches on its key and title; 'other2019' matches nothing, proving
// the reference filter.
const REFS_YAML = `termpaper2020:
  title: Studying the Term in Depth
  author:
    - Ada Lovelace
other2019:
  title: An Unrelated Subject
  author:
    - Grace Hopper
`;

// Comments keyed by page. 'blog/intro' yields one short hit and one non-hit;
// 'blog/long' is the over-long hit that pins the comment-branch truncation.
// 'meta/info' is a non-array OBJECT: the Array.isArray guard skips it, and because a
// plain object is not iterable, removing that guard would make the for..of throw and
// return 500. So the 200 golden genuinely pins the guard, not merely the value being
// absent from the results.
const COMMENTS = {
  'blog/intro': [
    { text: 'A short term comment', author: 'sam' },
    { text: 'no match in this one', author: 'pat' },
  ],
  'meta/info': { note: 'a non-array object the guard must skip' },
  'blog/long': [
    { text: LONG_COMMENT, author: 'lee' },
  ],
};

// Discussions keyed by channel under .messages. 'general' yields one short hit and
// one non-hit; 'other' is the over-long hit that pins the message-branch truncation.
// 'archive' is a non-array OBJECT skipped by the Array.isArray guard; as on the comment
// branch, a plain object is not iterable, so removing the guard would throw and return
// 500, making the 200 golden a real guard pin.
const DISCUSSIONS = {
  messages: {
    general: [
      { text: 'discussing the term right now', author: 'kai' },
      { text: 'off topic chatter', author: 'rob' },
    ],
    archive: { note: 'a non-array object the guard must skip' },
    other: [
      { text: LONG_MESSAGE, author: 'mia' },
    ],
  },
};

// fs steering the content scan and the bibliography read. readdirSync serves the
// content tree; readFileSync serves the bibliography and the allowed content files;
// statSync gives references.yaml a stable {mtimeMs, size} so loadReferencesCached can
// memoize. Every other path throws ENOENT so a stray read surfaces loudly.
function makeFs() {
  return {
    readdirSync(dir) {
      const entries = CONTENT_TREE[dir];
      if (entries) return entries;
      const err = new Error('ENOENT: ' + dir); err.code = 'ENOENT'; throw err;
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) return REFS_YAML;
      if (Object.hasOwn(CONTENT_FILES, fp)) return CONTENT_FILES[fp];
      const err = new Error('ENOENT: ' + fp); err.code = 'ENOENT'; throw err;
    },
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: REFS_YAML.length };
      const err = new Error('ENOENT: ' + fp); err.code = 'ENOENT'; throw err;
    },
  };
}

// Drive the real GET /api/search/global handler over a mocked ctx and capture the
// single json(res, status, payload) write. The content scan, references, comments,
// and discussions all run against the fixtures above, so the captured payload is the
// full cross-source aggregation.
async function runGlobalSearch({ query = QUERY, limit } = {}) {
  const search = limit === undefined
    ? `?q=${encodeURIComponent(query)}`
    : `?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`;
  const url = new URL(`http://localhost/api/search/global${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: makeFs(),
    ALLOWED_EXTS: ['.md', '.mdx'],
    COMMENTS_FILE,
    DISCUSSIONS_FILE,
    loadJSON: (file) =>
      file === COMMENTS_FILE ? COMMENTS :
      file === DISCUSSIONS_FILE ? DISCUSSIONS : {},
    json(_res, status, payload) {
      captured = { status, payload };
      res.writableEnded = true;
      return captured;
    },
  };
  await fileToolsRoutes(req, res, url, '/api/search/global', ctx);
  return captured;
}

// The full cross-source golden, in the order the handler appends: content first
// (in readdir plus recursion order), then reference, then comment, then message.
// The two over-long bodies are stored sliced to 100 characters; the truncation test
// below proves that slice is a real cut rather than a pass-through.
const EXPECTED_RESULTS = [
  { type: 'content', path: 'content/match.md', name: 'match.md' },
  { type: 'content', path: 'content/sub/deep.md', name: 'deep.md' },
  { type: 'reference', key: 'termpaper2020', title: 'Studying the Term in Depth' },
  { type: 'comment', page: 'blog/intro', text: 'A short term comment', author: 'sam' },
  { type: 'comment', page: 'blog/long', text: LONG_COMMENT.slice(0, 100), author: 'lee' },
  { type: 'message', channel: 'general', text: 'discussing the term right now', author: 'kai' },
  { type: 'message', channel: 'other', text: LONG_MESSAGE.slice(0, 100), author: 'mia' },
];

describe('GET /api/search/global success-path cross-source aggregation', () => {
  beforeEach(() => _resetReferencesCache());

  it('aggregates content, reference, comment, and message hits into one ordered list', async () => {
    const r = await runGlobalSearch({ query: QUERY });
    assert.equal(r.status, 200);
    // Value-full golden: source order, each branch projection key set, the
    // slice(0, 100) truncation, the full-count total, and the query echo. Every
    // non-hit fixture is absent: skip.md, notes.txt, the dotted dir, the no-match
    // comment and message, other2019, and the two non-array object pages that the
    // Array.isArray guard skips, so the filtering is pinned too.
    assert.deepStrictEqual(r.payload, {
      results: EXPECTED_RESULTS,
      total: EXPECTED_RESULTS.length,
      query: QUERY,
    });
  });

  it('emits sources in content, reference, comment, then message order', async () => {
    const r = await runGlobalSearch({ query: QUERY });
    assert.deepStrictEqual(
      r.payload.results.map((x) => x.type),
      ['content', 'content', 'reference', 'comment', 'comment', 'message', 'message'],
    );
  });

  it('truncates over-long comment and message bodies to 100 characters', async () => {
    const r = await runGlobalSearch({ query: QUERY });
    const longComment = r.payload.results.find((x) => x.type === 'comment' && x.page === 'blog/long');
    const longMessage = r.payload.results.find((x) => x.type === 'message' && x.channel === 'other');
    // The raw bodies are well past 100 chars, so a 100-char projection proves a real
    // truncation rather than a pass-through of the whole body.
    assert.ok(LONG_COMMENT.length > 100 && LONG_MESSAGE.length > 100);
    assert.equal(longComment.text.length, 100);
    assert.equal(longMessage.text.length, 100);
    assert.equal(longComment.text, LONG_COMMENT.slice(0, 100));
    assert.equal(longMessage.text, LONG_MESSAGE.slice(0, 100));
  });

  it('slices results to the limit while total reports the full match count', async () => {
    const r = await runGlobalSearch({ query: QUERY, limit: 1 });
    assert.equal(r.status, 200);
    // limit=1 keeps only the first hit (the first content match) yet total still
    // counts every cross-source match, pinning the slice-versus-total split.
    assert.deepStrictEqual(r.payload, {
      results: [EXPECTED_RESULTS[0]],
      total: EXPECTED_RESULTS.length,
      query: QUERY,
    });
  });
});
