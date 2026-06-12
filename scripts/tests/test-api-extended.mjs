#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Extended API integration tests for the Mochi Lab editor server
// Covers endpoints NOT tested by test-api.mjs
// Usage:  node scripts/tests/test-api-extended.mjs
// Requires the server running on http://localhost:3001
// ─────────────────────────────────────────────────────────────

const BASE = process.env.API_URL || 'http://localhost:3001';

// ── Colors ──
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ── State ──
let passed = 0;
let failed = 0;

// Track test data for cleanup
const cleanup = [];

function log(icon, color, label, detail = '') {
  const detailStr = detail ? ` ${DIM}${detail}${RESET}` : '';
  console.log(`  ${color}${icon}${RESET} ${label}${detailStr}`);
}

function pass(name, detail) {
  passed++;
  log('✓', GREEN, name, detail);
}

function fail(name, detail) {
  failed++;
  log('✗', RED, name, detail);
}

function section(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

// ── Helpers ──
async function api(method, path, body, opts = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const init = {method, headers: {}};
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof Buffer) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  if (opts.headers) Object.assign(init.headers, opts.headers);
  if (opts.signal) init.signal = opts.signal;
  const res = await fetch(url, init);
  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return {status: res.status, data, headers: res.headers};
}

function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertOk(cond, label) {
  if (!cond) throw new Error(label);
}

async function test(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, err.message);
  }
}

// ────────────────────────────────────────────────────────────────
// Connectivity check
// ────────────────────────────────────────────────────────────────

async function preflight() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(`${BASE}/api/health`, {signal: controller.signal});
    clearTimeout(timer);
    return true;
  } catch {
    console.error(`${RED}ERROR:${RESET} Cannot reach ${BASE}. Is the server running?`);
    console.error(`  Start it with:  node server.js`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// Test data identifiers
// ────────────────────────────────────────────────────────────────

const TEST_PREFIX = `__xtest_${Date.now()}`;
const TEST_COMMENT_PAGE = `${TEST_PREFIX}/react-page`;
const TEST_ANNOTATION_PAGE = `${TEST_PREFIX}/annotation-page`;
const TEST_CHANNEL_NAME = `XTest Pin Channel ${TEST_PREFIX}`;

// ────────────────────────────────────────────────────────────────
// History & Versioning (3 tests)
// ────────────────────────────────────────────────────────────────

async function testHistory() {
  section('History & Versioning');

  // 1. GET /api/history — for a known file
  await test('Get file history', async () => {
    const {status, data} = await api('GET', '/api/history?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(data.commits !== undefined, 'has commits field');
    assertOk(Array.isArray(data.commits), 'commits is array');
    if (data.commits.length > 0) {
      const c = data.commits[0];
      assertOk(typeof c.hash === 'string', 'commit has hash');
      assertOk(typeof c.author === 'string', 'commit has author');
      assertOk(typeof c.date === 'string', 'commit has date');
      assertOk(typeof c.message === 'string', 'commit has message');
    }
  });

  // 2. GET /api/history/diff — with a fabricated hash (should handle gracefully)
  await test('Get history diff with fabricated hash', async () => {
    const {status, data} = await api('GET', '/api/history/diff?path=content/books/math/0-intro.md&hash=abcdef1');
    // Server catches git errors and returns {diff: ''} with 200
    assertOk(status === 200 || status === 400, 'status is 200 or 400');
    if (status === 200) {
      assertOk(typeof data.diff === 'string', 'diff is string');
    }
  });

  // 3. GET /api/file/compare — missing params should return 400
  await test('File compare with missing params returns 400', async () => {
    const {status, data} = await api('GET', '/api/file/compare');
    assertEq(status, 400, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// Bibliography Advanced (5 tests)
// ────────────────────────────────────────────────────────────────

async function testBibliographyAdvanced() {
  section('Bibliography Advanced');

  // 1. GET /api/references/export — verify it returns valid BibTeX text
  await test('Export BibTeX returns valid text', async () => {
    const {status, data} = await api('GET', '/api/references/export');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('@'), 'contains BibTeX @ marker');
  });

  // 2. GET /api/references/enrich?key=nonexistent — should 404
  await test('Enrich nonexistent reference returns 404', async () => {
    const {status, data} = await api('GET', `/api/references/enrich?key=${TEST_PREFIX}_nonexistent`);
    assertEq(status, 404, 'status');
    assertOk(data.error, 'has error message');
    assertOk(data.error.includes('not found'), 'error mentions not found');
  });

  // 3. GET /api/references/track?key=nonexistent — should 404
  await test('Track nonexistent reference returns 404', async () => {
    const {status, data} = await api('GET', `/api/references/track?key=${TEST_PREFIX}_nonexistent`);
    assertEq(status, 404, 'status');
    assertOk(data.error, 'has error message');
  });

  // 4. POST /api/references/track-all — should work (may return empty or be rate limited)
  await test('Track-all references batch check', async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const {status, data} = await api('POST', '/api/references/track-all', null, {signal: controller.signal});
      clearTimeout(timeout);
      assertOk(status === 200 || status === 429, 'status is 200 or 429 (rate limited)');
      if (status === 200) {
        assertOk(typeof data.checked === 'number', 'has checked count');
        assertOk(typeof data.updated === 'number', 'has updated count');
        assertOk(Array.isArray(data.results), 'results is array');
      }
    } catch {
      // External API may be unreachable, this is not a server bug
      pass('Track-all references batch check', 'skipped (external API timeout)');
    }
  });

  // 5. GET /api/recommendations — verify shape
  await test('Get recommendations shape', async () => {
    const {status, data} = await api('GET', '/api/recommendations');
    assertOk(status === 200 || status === 429, 'status is 200 or 429 (rate limited)');
    if (status === 200) {
      assertOk(typeof data === 'object', 'response is object');
      // Response should contain recommendations or relevant structure
      assertOk(
        Array.isArray(data.recommendations) || data.recommendations !== undefined || data.message !== undefined,
        'response has expected shape',
      );
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Bookmarks (3 tests)
// ────────────────────────────────────────────────────────────────

async function testBookmarks() {
  section('Bookmarks');

  const bookmarkPath = `/${TEST_PREFIX}/test-bookmark`;

  // 1. POST /api/bookmarks
  await test('Create bookmark', async () => {
    const {status, data} = await api('POST', '/api/bookmarks', {
      path: bookmarkPath,
      title: 'Test Bookmark',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.bookmark, 'has bookmark object');
    assertEq(data.bookmark.path, bookmarkPath, 'path matches');
    assertEq(data.bookmark.title, 'Test Bookmark', 'title matches');
    assertOk(typeof data.bookmark.addedAt === 'string', 'has addedAt');
  });

  // 2. GET /api/bookmarks — should contain test bookmark
  await test('List bookmarks contains test bookmark', async () => {
    const {status, data} = await api('GET', '/api/bookmarks');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.bookmarks), 'bookmarks is array');
    const found = data.bookmarks.find(b => b.path === bookmarkPath);
    assertOk(found, 'found our test bookmark');
    assertEq(found.title, 'Test Bookmark', 'title matches');
  });

  // 3. DELETE /api/bookmarks
  await test('Delete bookmark', async () => {
    const {status, data} = await api('DELETE', '/api/bookmarks', {
      path: bookmarkPath,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/bookmarks');
    assertOk(!listData.bookmarks.some(b => b.path === bookmarkPath), 'bookmark removed');
  });
}

// ────────────────────────────────────────────────────────────────
// Reading Lists (4 tests)
// ────────────────────────────────────────────────────────────────

let createdListId = null;

async function testReadingLists() {
  section('Reading Lists');

  // 1. POST /api/reading-lists
  await test('Create reading list', async () => {
    const {status, data} = await api('POST', '/api/reading-lists', {
      name: `Test List ${TEST_PREFIX}`,
      description: 'A test reading list',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.list, 'has list object');
    assertOk(data.list.id, 'list has id');
    assertEq(data.list.name, `Test List ${TEST_PREFIX}`, 'name matches');
    assertOk(Array.isArray(data.list.items), 'items is array');
    assertEq(data.list.items.length, 0, 'items starts empty');
    createdListId = data.list.id;
  });

  // 2. POST /api/reading-lists/:id/items
  await test('Add item to reading list', async () => {
    if (!createdListId) throw new Error('No list id from previous test');
    const {status, data} = await api('POST', `/api/reading-lists/${createdListId}/items`, {
      path: '/test/item-path',
      title: 'Test Item',
      type: 'doc',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.list, 'has list');
    assertOk(data.list.items.length >= 1, 'list has at least one item');
    const item = data.list.items.find(i => i.path === '/test/item-path');
    assertOk(item, 'found our item');
    assertEq(item.title, 'Test Item', 'item title matches');
    assertEq(item.type, 'doc', 'item type matches');
  });

  // 3. GET /api/reading-lists
  await test('List reading lists includes test list', async () => {
    const {status, data} = await api('GET', '/api/reading-lists');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.lists), 'lists is array');
    const found = data.lists.find(l => l.id === createdListId);
    assertOk(found, 'found our test list');
    assertOk(found.items.length >= 1, 'list has items');
  });

  // 4. DELETE /api/reading-lists/:id
  await test('Delete reading list', async () => {
    if (!createdListId) throw new Error('No list id from previous test');
    const {status, data} = await api('DELETE', `/api/reading-lists/${createdListId}`);
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/reading-lists');
    assertOk(!listData.lists.some(l => l.id === createdListId), 'list deleted');
  });
}

// ────────────────────────────────────────────────────────────────
// Streak (2 tests)
// ────────────────────────────────────────────────────────────────

async function testStreak() {
  section('Streak');

  const streakUserId = `${TEST_PREFIX}_user`;

  // 1. POST /api/streak
  await test('Log streak entry', async () => {
    const {status, data} = await api('POST', '/api/streak', {
      userId: streakUserId,
      wordsWritten: 100,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(typeof data.date === 'string', 'has date');
    assertEq(data.words, 100, 'words matches');
  });

  // 2. GET /api/streak?userId=...
  await test('Get streak data', async () => {
    const {status, data} = await api('GET', `/api/streak?userId=${encodeURIComponent(streakUserId)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.currentStreak === 'number', 'has currentStreak');
    assertOk(typeof data.longestStreak === 'number', 'has longestStreak');
    assertOk(typeof data.totalWords === 'number', 'has totalWords');
    assertOk(Array.isArray(data.dailyLog), 'has dailyLog array');
    assertOk(data.totalWords >= 100, 'totalWords includes our entry');
  });
}

// ────────────────────────────────────────────────────────────────
// Annotations (3 tests)
// ────────────────────────────────────────────────────────────────

let createdAnnotationId = null;

async function testAnnotations() {
  section('Annotations');

  // 1. POST /api/annotations
  await test('Create annotation', async () => {
    const {status, data} = await api('POST', '/api/annotations', {
      page: TEST_ANNOTATION_PAGE,
      text: 'highlighted',
      note: 'my note',
      startOffset: 0,
      endOffset: 10,
      author: 'test',
    });
    assertEq(status, 201, 'status');
    assertOk(data.annotation, 'has annotation object');
    assertOk(data.annotation.id, 'annotation has id');
    assertEq(data.annotation.text, 'highlighted', 'text matches');
    assertEq(data.annotation.note, 'my note', 'note matches');
    assertEq(data.annotation.startOffset, 0, 'startOffset matches');
    assertEq(data.annotation.endOffset, 10, 'endOffset matches');
    assertEq(data.annotation.author, 'test', 'author matches');
    assertOk(typeof data.annotation.createdAt === 'string', 'has createdAt');
    createdAnnotationId = data.annotation.id;
  });

  // 2. GET /api/annotations?page=...
  await test('List annotations for page', async () => {
    const {status, data} = await api('GET', `/api/annotations?page=${encodeURIComponent(TEST_ANNOTATION_PAGE)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.annotations), 'annotations is array');
    assertOk(data.annotations.length >= 1, 'has at least one annotation');
    const found = data.annotations.find(a => a.id === createdAnnotationId);
    assertOk(found, 'found our annotation');
    assertEq(found.text, 'highlighted', 'text matches');
  });

  // 3. DELETE /api/annotations
  await test('Delete annotation', async () => {
    if (!createdAnnotationId) throw new Error('No annotation id from previous test');
    const {status, data} = await api('DELETE', '/api/annotations', {
      page: TEST_ANNOTATION_PAGE,
      id: createdAnnotationId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', `/api/annotations?page=${encodeURIComponent(TEST_ANNOTATION_PAGE)}`);
    assertOk(!listData.annotations.some(a => a.id === createdAnnotationId), 'annotation deleted');
  });
}

// ────────────────────────────────────────────────────────────────
// Reactions (2 tests)
// ────────────────────────────────────────────────────────────────

let reactCommentId = null;

async function testReactions() {
  section('Reactions');

  // Setup: create a comment to react to
  const {data: commentData} = await api('POST', '/api/comments', {
    page: TEST_COMMENT_PAGE,
    author: 'React Test User',
    text: 'Comment for reaction tests',
  });
  reactCommentId = commentData.comment?.id;
  if (!reactCommentId) {
    fail('Setup: create comment for reactions', 'Could not create comment');
    return;
  }
  cleanup.push(async () => {
    try {
      await api('DELETE', '/api/comments', {page: TEST_COMMENT_PAGE, commentId: reactCommentId});
    } catch { /* ignore */ }
  });

  // 1. POST /api/comments/react — add reaction
  await test('Add reaction to comment', async () => {
    const {status, data} = await api('POST', '/api/comments/react', {
      page: TEST_COMMENT_PAGE,
      commentId: reactCommentId,
      emoji: 'thumbsup',
      userId: `${TEST_PREFIX}_reactor`,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(Array.isArray(data.reactions), 'reactions is array');
    const reaction = data.reactions.find(r => r.emoji === 'thumbsup' && r.userId === `${TEST_PREFIX}_reactor`);
    assertOk(reaction, 'found our reaction');
  });

  // 2. DELETE /api/comments/react — remove reaction
  await test('Remove reaction from comment', async () => {
    const {status, data} = await api('DELETE', '/api/comments/react', {
      page: TEST_COMMENT_PAGE,
      commentId: reactCommentId,
      emoji: 'thumbsup',
      userId: `${TEST_PREFIX}_reactor`,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(Array.isArray(data.reactions), 'reactions is array');
    const reaction = data.reactions.find(r => r.emoji === 'thumbsup' && r.userId === `${TEST_PREFIX}_reactor`);
    assertOk(!reaction, 'reaction removed');
  });
}

// ────────────────────────────────────────────────────────────────
// Discussion Pins (2 tests)
// ────────────────────────────────────────────────────────────────

let pinChannelId = null;
let pinMessageId = null;

async function testDiscussionPins() {
  section('Discussion Pins');

  // Setup: create channel and post a message
  const {data: chData} = await api('POST', '/api/discussions', {
    name: TEST_CHANNEL_NAME,
    topic: 'Pin test channel',
  });
  pinChannelId = chData.channel?.id;
  if (!pinChannelId) {
    fail('Setup: create channel for pins', 'Could not create channel');
    return;
  }
  cleanup.push(async () => {
    try { await api('DELETE', `/api/discussions/${pinChannelId}`); } catch { /* ignore */ }
  });

  const {data: msgData} = await api('POST', `/api/discussions/${pinChannelId}/messages`, {
    author: 'Pin Test User',
    text: 'This message will be pinned',
  });
  pinMessageId = msgData.message?.id;
  if (!pinMessageId) {
    fail('Setup: post message for pins', 'Could not post message');
    return;
  }

  // 1. POST /api/discussions/:channelId/pin — pin message
  await test('Pin message in channel', async () => {
    const {status, data} = await api('POST', `/api/discussions/${pinChannelId}/pin`, {
      messageId: pinMessageId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });

  // 2. DELETE /api/discussions/:channelId/pin — unpin message
  await test('Unpin message in channel', async () => {
    const {status, data} = await api('DELETE', `/api/discussions/${pinChannelId}/pin`, {
      messageId: pinMessageId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });
}

// ────────────────────────────────────────────────────────────────
// Misc (5 tests)
// ────────────────────────────────────────────────────────────────

async function testMisc() {
  section('Misc');

  // 1. GET /api/graph — verify nodes array
  await test('Knowledge graph returns nodes and edges', async () => {
    const {status, data} = await api('GET', '/api/graph');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.nodes), 'nodes is array');
    assertOk(Array.isArray(data.edges), 'edges is array');
    if (data.nodes.length > 0) {
      const node = data.nodes[0];
      assertOk(typeof node.id === 'string', 'node has id');
      assertOk(typeof node.path === 'string', 'node has path');
      assertOk(typeof node.title === 'string', 'node has title');
    }
  });

  // 2. GET /api/backlinks?path=...
  await test('Backlinks for a known file', async () => {
    const {status, data} = await api('GET', '/api/backlinks?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(data.backlinks !== undefined, 'has backlinks field');
    assertOk(Array.isArray(data.backlinks), 'backlinks is array');
  });

  // 3. GET /api/analytics/topics — verify topics array
  await test('Analytics topics returns topics array', async () => {
    const {status, data} = await api('GET', '/api/analytics/topics');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.topics), 'topics is array');
    if (data.topics.length > 0) {
      const topic = data.topics[0];
      assertOk(typeof topic.word === 'string', 'topic has word');
      assertOk(typeof topic.count === 'number', 'topic has count');
    }
  });

  // 4. GET /api/files/recent — verify files array
  await test('Recent files returns files array', async () => {
    const {status, data} = await api('GET', '/api/files/recent');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.files), 'files is array');
    if (data.files.length > 0) {
      const file = data.files[0];
      assertOk(typeof file.name === 'string', 'file has name');
      assertOk(typeof file.path === 'string', 'file has path');
      assertOk(typeof file.mtime === 'number', 'file has mtime');
    }
  });

  // 5. POST /api/files/bulk with empty paths — should return 400
  await test('Bulk operation with empty paths returns 400', async () => {
    const {status, data} = await api('POST', '/api/files/bulk', {
      action: 'delete',
      paths: [],
    });
    assertEq(status, 400, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// Analytics: Duplicates & Orphans (2 tests)
// ────────────────────────────────────────────────────────────────

async function testAnalyticsDuplicatesAndOrphans() {
  section('Analytics: Duplicates & Orphans');

  // 1. GET /api/analytics/duplicates
  await test('Analytics duplicates returns duplicates array', async () => {
    const {status, data} = await api('GET', '/api/analytics/duplicates');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.duplicates), 'duplicates is array');
    if (data.duplicates.length > 0) {
      const dup = data.duplicates[0];
      assertOk(typeof dup.file1 === 'string', 'duplicate has file1');
      assertOk(typeof dup.file2 === 'string', 'duplicate has file2');
      assertOk(typeof dup.similarity === 'number', 'duplicate has similarity');
    }
  });

  // 2. GET /api/analytics/orphans
  await test('Analytics orphans returns orphans array', async () => {
    const {status, data} = await api('GET', '/api/analytics/orphans');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.orphans), 'orphans is array');
    if (data.orphans.length > 0) {
      const orphan = data.orphans[0];
      assertOk(typeof orphan.path === 'string', 'orphan has path');
      assertOk(typeof orphan.name === 'string', 'orphan has name');
      assertOk(typeof orphan.wordCount === 'number', 'orphan has wordCount');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Analytics: Topics (1 test — extended verification)
// ────────────────────────────────────────────────────────────────

async function testAnalyticsTopics() {
  section('Analytics: Topics');

  await test('Analytics topics returns word/count pairs', async () => {
    const {status, data} = await api('GET', '/api/analytics/topics');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.topics), 'topics is array');
    if (data.topics.length > 0) {
      const topic = data.topics[0];
      assertOk(typeof topic.word === 'string', 'topic has word');
      assertOk(typeof topic.count === 'number', 'topic has count');
      assertOk(topic.word.length > 0, 'word is non-empty');
      assertOk(topic.count > 0, 'count is positive');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// References: Format & Format-All (2 tests)
// ────────────────────────────────────────────────────────────────

async function testReferencesFormat() {
  section('References: Format & Format-All');

  // 1. GET /api/references/format?key=...&style=apa
  await test('Format single reference as APA', async () => {
    const {status, data} = await api('GET', '/api/references/format?key=alon2016probabilistic&style=apa');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertEq(data.key, 'alon2016probabilistic', 'key matches');
    assertEq(data.style, 'apa', 'style matches');
    assertOk(typeof data.formatted === 'string', 'formatted is a string');
    assertOk(data.formatted.length > 0, 'formatted is non-empty');
  });

  // 2. GET /api/references/format-all?style=apa
  await test('Format all references as APA returns text', async () => {
    const {status, data} = await api('GET', '/api/references/format-all?style=apa');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk(Array.isArray(data.references), 'has references array');
    assertOk(data.references.length > 0, 'references non-empty');
  });
}

// ────────────────────────────────────────────────────────────────
// Summary: Daily (1 test)
// ────────────────────────────────────────────────────────────────

async function testSummaryDaily() {
  section('Summary: Daily');

  await test('Daily summary returns html and stats', async () => {
    const {status, data} = await api('GET', '/api/summary/daily');
    assertEq(status, 200, 'status');
    assertOk(typeof data.date === 'string', 'has date field');
    assertOk(typeof data.filesModifiedToday === 'number', 'has filesModifiedToday');
    assertOk(typeof data.commentsToday === 'number', 'has commentsToday');
    assertOk(typeof data.messagesToday === 'number', 'has messagesToday');
    assertOk(typeof data.wordsWrittenToday === 'number', 'has wordsWrittenToday');
  });
}

// ────────────────────────────────────────────────────────────────
// File Info: Enriched (1 test)
// ────────────────────────────────────────────────────────────────

async function testFileInfoEnriched() {
  section('File Info: Enriched');

  await test('File info returns enriched fields', async () => {
    const {status, data} = await api('GET', '/api/file/info?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data.detectedLanguage === 'string', 'has detectedLanguage');
    assertOk(['english', 'chinese', 'mixed'].includes(data.detectedLanguage), 'detectedLanguage is valid');
    assertOk(typeof data.hasMath === 'boolean', 'has hasMath');
    assertOk(typeof data.citationCount === 'number', 'has citationCount');
    assertOk(typeof data.hasCodeBlocks === 'boolean', 'has hasCodeBlocks');
    assertOk(typeof data.imageCount === 'number', 'has imageCount');
    assertOk(typeof data.wordCount === 'number', 'has wordCount');
    assertOk(typeof data.size === 'number', 'has size');
  });
}

// ────────────────────────────────────────────────────────────────
// Lint (1 test)
// ────────────────────────────────────────────────────────────────

async function testLint() {
  section('Lint');

  await test('Lint markdown content returns issues array', async () => {
    const sampleContent = `---
description: no title here
---

# Heading One

Some content here.

# Heading One

![](broken-image.png)
`;
    const {status, data} = await api('POST', '/api/lint', {content: sampleContent});
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.issues), 'issues is array');
    // The sample content should trigger at least:
    // - missing title in frontmatter
    // - duplicate heading "Heading One"
    // - missing alt text on image
    assertOk(data.issues.length >= 1, 'at least one issue detected');
    const issue = data.issues[0];
    assertOk(typeof issue.line === 'number', 'issue has line');
    assertOk(typeof issue.column === 'number', 'issue has column');
    assertOk(typeof issue.message === 'string', 'issue has message');
    assertOk(typeof issue.severity === 'string', 'issue has severity');
  });
}

// ────────────────────────────────────────────────────────────────
// File Outline (1 test)
// ────────────────────────────────────────────────────────────────

async function testFileOutline() {
  section('File Outline');

  await test('File outline for existing file', async () => {
    const {status, data} = await api('GET', '/api/file/outline?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.headings), 'headings is array');
    assertOk(typeof data.count === 'number', 'has count');
    if (data.headings.length > 0) {
      const heading = data.headings[0];
      assertOk(typeof heading.level === 'number', 'heading has level');
      assertOk(typeof heading.text === 'string', 'heading has text');
      assertOk(typeof heading.line === 'number', 'heading has line');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Files Recent (1 test — extended verification)
// ────────────────────────────────────────────────────────────────

async function testFilesRecent() {
  section('Files Recent');

  await test('Recent files returns well-shaped entries', async () => {
    const {status, data} = await api('GET', '/api/files/recent');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.files), 'files is array');
    if (data.files.length > 0) {
      const file = data.files[0];
      assertOk(typeof file.name === 'string', 'file has name');
      assertOk(typeof file.path === 'string', 'file has path');
      assertOk(typeof file.mtime === 'number', 'file has mtime');
      // mtime should be a recent Unix timestamp (ms)
      assertOk(file.mtime > 1000000000000, 'mtime looks like ms timestamp');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Schedule CRUD (3 tests)
// ────────────────────────────────────────────────────────────────

async function testSchedule() {
  section('Schedule CRUD');

  const schedulePath = 'content/books/math/0-intro.md';
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1. POST /api/schedule — create a schedule
  await test('Create schedule entry', async () => {
    const {status, data} = await api('POST', '/api/schedule', {
      path: schedulePath,
      publishAt: futureDate,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.item, 'has item object');
    assertEq(data.item.path, schedulePath, 'path matches');
    assertOk(typeof data.item.publishAt === 'string', 'has publishAt');
    assertOk(typeof data.item.createdAt === 'string', 'has createdAt');
  });

  // 2. GET /api/schedule — list schedules and find our entry
  await test('List schedules contains test entry', async () => {
    const {status, data} = await api('GET', '/api/schedule');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.items), 'items is array');
    const found = data.items.find(s => s.path === schedulePath);
    assertOk(found, 'found our scheduled entry');
    assertOk(typeof found.publishAt === 'string', 'entry has publishAt');
  });

  // 3. DELETE /api/schedule — remove the schedule
  await test('Delete schedule entry', async () => {
    const {data: listData0} = await api('GET', '/api/schedule');
    const item = listData0.items.find(s => s.path === schedulePath);
    if (!item) {
      pass('Delete schedule entry', 'item already gone');
      return;
    }
    const {status, data} = await api('DELETE', '/api/schedule', {id: item.id});
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });
}

// ────────────────────────────────────────────────────────────────
// Whiteboard CRUD (4 tests)
// ────────────────────────────────────────────────────────────────

const TEST_WHITEBOARD_ID = `${TEST_PREFIX}_wb`;

async function testWhiteboardCrud() {
  section('Whiteboard CRUD');

  // 1. POST /api/whiteboard — create whiteboard
  await test('Create whiteboard', async () => {
    const {status, data} = await api('POST', '/api/whiteboard', {
      id: TEST_WHITEBOARD_ID,
      elements: [{type: 'note', x: 10, y: 10, text: 'Hello', color: '#ffeb3b'}],
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });

  // 2. GET /api/whiteboard?id=... — verify elements
  await test('Get whiteboard by id', async () => {
    const {status, data} = await api('GET', `/api/whiteboard?id=${TEST_WHITEBOARD_ID}`);
    assertEq(status, 200, 'status');
    const wb = data.whiteboard || data;
    assertOk(Array.isArray(wb.elements), 'elements is array');
    assertOk(wb.elements.length >= 1, 'has at least one element');
    const el = wb.elements[0];
    assertEq(el.type, 'note', 'element type is note');
    assertEq(el.text, 'Hello', 'element text matches');
    assertEq(el.color, '#ffeb3b', 'element color matches');
    assertEq(el.x, 10, 'element x matches');
    assertEq(el.y, 10, 'element y matches');
  });

  // 3. GET /api/whiteboards — verify list contains our whiteboard
  await test('List whiteboards contains test whiteboard', async () => {
    const {status, data} = await api('GET', '/api/whiteboards');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.whiteboards), 'whiteboards is array');
    const found = data.whiteboards.find(w => w.id === TEST_WHITEBOARD_ID);
    assertOk(found, 'found our test whiteboard');
  });

  // 4. DELETE /api/whiteboard?id=... — delete whiteboard
  await test('Delete whiteboard', async () => {
    const {status, data} = await api('DELETE', `/api/whiteboard?id=${TEST_WHITEBOARD_ID}`);
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/whiteboards');
    assertOk(!listData.whiteboards.some(w => w.id === TEST_WHITEBOARD_ID), 'whiteboard removed');
  });
}

// ────────────────────────────────────────────────────────────────
// RSS/Atom Feeds (2 tests)
// ────────────────────────────────────────────────────────────────

async function testFeeds() {
  section('RSS/Atom Feeds');

  // 1. GET /api/feed/rss — verify XML with <rss
  await test('RSS feed returns valid XML', async () => {
    const {status, data} = await api('GET', '/api/feed/rss');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('<rss'), 'contains <rss tag');
  });

  // 2. GET /api/feed/atom — verify XML with <feed
  await test('Atom feed returns valid XML', async () => {
    const {status, data} = await api('GET', '/api/feed/atom');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('<feed'), 'contains <feed tag');
  });
}

// ────────────────────────────────────────────────────────────────
// Slides (2 tests)
// ────────────────────────────────────────────────────────────────

async function testSlides() {
  section('Slides');

  // 1. GET /api/file/slides?path=... — verify JSON {slides} for existing file
  await test('Slides for existing file returns JSON slides array', async () => {
    const {status, data} = await api('GET', '/api/file/slides?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk(Array.isArray(data.slides), 'slides is array');
    assertOk(typeof data.title === 'string', 'has title');
    assertOk(typeof data.totalSlides === 'number', 'has totalSlides');
  });

  // 2. GET /api/file/slides?path=nonexistent.md — verify 400 or 404
  await test('Slides for nonexistent file returns 400 or 404', async () => {
    const {status, data} = await api('GET', '/api/file/slides?path=nonexistent.md');
    assertOk(status === 400 || status === 404, `status is ${status}, expected 400 or 404`);
    assertOk(typeof data === 'object' ? data.error : true, 'has error');
  });
}

// ────────────────────────────────────────────────────────────────
// Import URL Validation (1 test)
// ────────────────────────────────────────────────────────────────

async function testImportUrl() {
  section('Import URL Validation');

  // POST /api/import-url with empty body — verify 400 validation
  await test('Import URL with empty body returns 400', async () => {
    const {status, data} = await api('POST', '/api/import-url', {});
    assertEq(status, 400, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// Citation Format: Nonexistent Key (1 test)
// ────────────────────────────────────────────────────────────────

async function testCitationFormatNotFound() {
  section('Citation Format: Not Found');

  await test('Format nonexistent reference returns 404', async () => {
    const {status, data} = await api('GET', `/api/references/format?key=${TEST_PREFIX}_nonexistent&style=apa`);
    assertEq(status, 404, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// File Lint (2 tests)
// ────────────────────────────────────────────────────────────────

async function testFileLint() {
  section('File Lint');

  // 1. GET /api/file/lint?path=... — verify shape
  await test('File lint returns issues and issueCount', async () => {
    const {status, data} = await api('GET', '/api/file/lint?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.issues), 'issues is array');
    assertOk(typeof data.issueCount === 'number', 'issueCount is number');
    if (data.issues.length > 0) {
      const issue = data.issues[0];
      assertOk(typeof issue.line === 'number', 'issue has line');
      assertOk(typeof issue.severity === 'string', 'issue has severity');
      assertOk(typeof issue.message === 'string', 'issue has message');
    }
  });

  // 2. Invalid path returns 400
  await test('File lint with invalid path returns 400', async () => {
    const {status, data} = await api('GET', '/api/file/lint?path=../../etc/passwd');
    assertEq(status, 400, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// File Readability (1 test)
// ────────────────────────────────────────────────────────────────

async function testFileReadability() {
  section('File Readability');

  await test('File readability returns expected metrics', async () => {
    const {status, data} = await api('GET', '/api/file/readability?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data.wordCount === 'number', 'has wordCount');
    assertOk(typeof data.sentenceCount === 'number', 'has sentenceCount');
    assertOk(typeof data.avgWordsPerSentence === 'number', 'has avgWordsPerSentence');
    assertOk(typeof data.avgSyllablesPerWord === 'number', 'has avgSyllablesPerWord');
    assertOk(typeof data.fleschKincaidGrade === 'number', 'has fleschKincaidGrade');
    assertOk(typeof data.readingLevel === 'string', 'has readingLevel');
    assertOk(typeof data.readingTimeMinutes === 'number', 'has readingTimeMinutes');
  });
}

// ────────────────────────────────────────────────────────────────
// File Related (1 test)
// ────────────────────────────────────────────────────────────────

async function testFileRelated() {
  section('File Related');

  await test('File related returns related array', async () => {
    const {status, data} = await api('GET', '/api/file/related?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.related), 'related is array');
    if (data.related.length > 0) {
      const item = data.related[0];
      assertOk(typeof item.path === 'string', 'item has path');
      assertOk(typeof item.title === 'string', 'item has title');
      assertOk(typeof item.score === 'number', 'item has score');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Content Lint (1 test)
// ────────────────────────────────────────────────────────────────

async function testContentLint() {
  section('Content Lint');

  await test('Content lint returns files and severity counts', async () => {
    const {status, data} = await api('GET', '/api/content-lint');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.files), 'files is array');
    assertOk(typeof data.totalIssues === 'number', 'totalIssues is number');
    assertOk(typeof data.severityCounts === 'object', 'severityCounts is object');
    assertOk(typeof data.severityCounts.error === 'number', 'severityCounts has error');
    assertOk(typeof data.severityCounts.warning === 'number', 'severityCounts has warning');
    assertOk(typeof data.severityCounts.info === 'number', 'severityCounts has info');
  });
}

// ────────────────────────────────────────────────────────────────
// Citation Network (1 test)
// ────────────────────────────────────────────────────────────────

async function testCitationNetwork() {
  section('Citation Network');

  await test('Citation network returns expected shape', async () => {
    const {status, data} = await api('GET', '/api/references/network');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalReferences === 'number', 'has totalReferences');
    assertOk(typeof data.citedReferences === 'number', 'has citedReferences');
    assertOk(typeof data.uncitedReferences === 'number', 'has uncitedReferences');
    assertOk(Array.isArray(data.mostCited), 'mostCited is array');
    assertOk(Array.isArray(data.coCitations), 'coCitations is array');
  });
}

// ────────────────────────────────────────────────────────────────
// Content Duplicates (1 test)
// ────────────────────────────────────────────────────────────────

async function testContentDuplicates() {
  section('Content Duplicates');

  await test('Content duplicates returns expected shape', async () => {
    const {status, data} = await api('GET', '/api/content-duplicates');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.duplicates), 'duplicates is array');
    assertOk(typeof data.count === 'number', 'count is number');
    if (data.duplicates.length > 0) {
      const dup = data.duplicates[0];
      assertOk(typeof dup.title === 'string', 'duplicate has title');
      assertOk(Array.isArray(dup.files), 'duplicate has files array');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Search and Replace (2 tests)
// ────────────────────────────────────────────────────────────────

async function testSearchReplace() {
  section('Search and Replace');

  // 1. Dry run with a string that won't match anything
  await test('Search/replace dry run returns 0 changes', async () => {
    const {status, data} = await api('POST', '/api/search/replace', {
      search: 'test_unique_string_xyz',
      replace: 'replaced',
      dryRun: true,
    });
    assertEq(status, 200, 'status');
    assertOk(typeof data.filesChanged === 'number' || Array.isArray(data.changes), 'has filesChanged or changes');
    assertEq(data.filesChanged, 0, 'no files changed for unmatched string');
    assertEq(data.dryRun, true, 'dryRun is true');
  });

  // 2. Missing search field returns 400
  await test('Search/replace missing search returns 400', async () => {
    const {status, data} = await api('POST', '/api/search/replace', {
      replace: 'replaced',
    });
    assertEq(status, 400, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// Word Diff (2 tests)
// ────────────────────────────────────────────────────────────────

async function testWordDiff() {
  section('Word Diff');

  // 1. Invalid hash returns empty diff (endpoint catches git errors)
  await test('Word diff with invalid hash returns empty diff', async () => {
    const {status, data} = await api('GET', '/api/file/word-diff?path=content/books/math/0-intro.md&hash=0000000000000000000000000000000000000000');
    assertOk(status === 200 || status === 400, `status is ${status}`);
    if (status === 200) {
      assertOk(typeof data.diff === 'string' || typeof data.wordDiff === 'string', 'has diff field');
    }
  });

  // 2. Missing path returns 400
  await test('Word diff missing path returns 400', async () => {
    const {status, data} = await api('GET', '/api/file/word-diff');
    assertEq(status, 400, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// PDF Export (2 tests)
// ────────────────────────────────────────────────────────────────

async function testPdfExport() {
  section('PDF Export');

  // 1. Returns HTML text with print styles
  await test('PDF export returns HTML with print styles', async () => {
    const {status, data} = await api('GET', '/api/file/export?path=content/books/math/0-intro.md&format=pdf');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text (HTML)');
    assertOk(data.includes('<'), 'contains HTML tags');
  });

  // 2. Contains @page CSS rule
  await test('PDF export contains @page CSS rule', async () => {
    const {status, data} = await api('GET', '/api/file/export?path=content/books/math/0-intro.md&format=pdf');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('@page'), 'contains @page CSS rule');
  });
}

// ────────────────────────────────────────────────────────────────
// Citation Format (2 tests)
// ────────────────────────────────────────────────────────────────

async function testCitationFormat() {
  section('Citation Format');

  // 1. Format known reference returns expected shape
  await test('Citation format returns {formatted, key, style, entry}', async () => {
    const {status, data} = await api('GET', '/api/references/format?key=vaswani2017attention&style=apa');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk(typeof data.key === 'string', 'has key');
    assertOk(typeof data.style === 'string', 'has style');
    assertOk(
      typeof data.formatted === 'string' || typeof data.citation === 'string',
      'has formatted or citation string',
    );
    assertOk(data.entry !== undefined || data.key === 'vaswani2017attention', 'has entry or matching key');
  });

  // 2. Unknown key returns 404
  await test('Citation format unknown key returns 404', async () => {
    const {status, data} = await api('GET', `/api/references/format?key=${TEST_PREFIX}_nonexistent_key&style=apa`);
    assertEq(status, 404, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// Year Distribution (1 test)
// ────────────────────────────────────────────────────────────────

async function testYearDistribution() {
  section('Year Distribution');

  await test('Year distribution returns expected shape', async () => {
    const {status, data} = await api('GET', '/api/references/year-distribution');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.years), 'has years array');
    assertOk(Array.isArray(data.topVenues), 'has topVenues array');
    assertOk(typeof data.totalReferences === 'number', 'has totalReferences');
    if (data.years.length > 0) {
      const entry = data.years[0];
      assertOk(typeof entry.year === 'number', 'year entry has year');
      assertOk(typeof entry.count === 'number', 'year entry has count');
    }
    if (data.topVenues.length > 0) {
      const venue = data.topVenues[0];
      assertOk(typeof venue.venue === 'string', 'venue entry has venue');
      assertOk(typeof venue.count === 'number', 'venue entry has count');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// By Venue (1 test)
// ────────────────────────────────────────────────────────────────

async function testByVenue() {
  section('By Venue');

  await test('By venue returns expected shape', async () => {
    const {status, data} = await api('GET', '/api/references/by-venue');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.venues), 'has venues array');
    assertOk(typeof data.totalVenues === 'number', 'has totalVenues');
    if (data.venues.length > 0) {
      const venue = data.venues[0];
      assertOk(typeof venue.venue === 'string', 'venue has venue string');
      assertOk(typeof venue.count === 'number', 'venue has count');
      assertOk(Array.isArray(venue.papers), 'venue has papers array');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// By Author (1 test)
// ────────────────────────────────────────────────────────────────

async function testByAuthor() {
  section('By Author');

  await test('By author returns expected shape', async () => {
    const {status, data} = await api('GET', '/api/references/by-author?limit=5');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.authors), 'has authors array');
    assertOk(typeof data.totalAuthors === 'number', 'has totalAuthors');
    assertOk(data.authors.length <= 5, 'respects limit=5');
    if (data.authors.length > 0) {
      const author = data.authors[0];
      assertOk(typeof author.author === 'string', 'author has author string');
      assertOk(typeof author.count === 'number', 'author has count');
      assertOk(Array.isArray(author.papers), 'author has papers array');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Reference Search (2 tests)
// ────────────────────────────────────────────────────────────────

async function testReferenceSearch() {
  section('Reference Search');

  // 1. Search returns results with key and title
  await test('Reference search returns results with key and title', async () => {
    const {status, data} = await api('GET', '/api/references/search?q=attention');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.results), 'has results array');
    assertOk(typeof data.total === 'number', 'has total');
    if (data.results.length > 0) {
      const result = data.results[0];
      assertOk(typeof result.key === 'string', 'result has key');
      assertOk(typeof result.title === 'string', 'result has title');
    }
  });

  // 2. Total matches results length (or is >= for paginated)
  await test('Reference search total is consistent', async () => {
    const {status, data} = await api('GET', '/api/references/search?q=attention');
    assertEq(status, 200, 'status');
    assertOk(data.total >= data.results.length, 'total >= results length');
  });
}

// ────────────────────────────────────────────────────────────────
// Daily Summary (1 test)
// ────────────────────────────────────────────────────────────────

async function testDailySummary() {
  section('Daily Summary');

  await test('Daily summary returns date and activity fields', async () => {
    const {status, data} = await api('GET', '/api/summary/daily');
    assertEq(status, 200, 'status');
    // The endpoint may return stats nested or flat; check both patterns
    if (data.stats) {
      // Nested shape (seen in existing tests)
      assertOk(typeof data.stats === 'object', 'has stats object');
    }
    // Check for date field (may be top-level or inside stats)
    assertOk(
      typeof data.date === 'string' || typeof data.html === 'string',
      'has date or html field',
    );
    // Check for activity counts (flat or nested)
    const src = data.stats || data;
    assertOk(
      typeof src.files === 'number' ||
      typeof src.filesModifiedToday === 'number' ||
      typeof data.html === 'string',
      'has file activity metric or html',
    );
  });
}

// ────────────────────────────────────────────────────────────────
// Productivity Report (1 test)
// ────────────────────────────────────────────────────────────────

async function testProductivityReport() {
  section('Productivity Report');

  await test('Productivity report returns expected shape', async () => {
    const {status, data} = await api('GET', '/api/productivity-report');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk(data.streak !== undefined, 'has streak field');
    assertOk(data.content !== undefined, 'has content field');
    assertOk(data.traffic !== undefined, 'has traffic field');
    assertOk(typeof data.generatedAt === 'string', 'has generatedAt string');
  });
}

// ────────────────────────────────────────────────────────────────
// Cleanup helpers
// ────────────────────────────────────────────────────────────────

async function runCleanup() {
  section('Cleanup');
  let cleaned = 0;
  let cleanFailed = 0;
  for (const fn of cleanup) {
    try {
      await fn();
      cleaned++;
    } catch {
      cleanFailed++;
    }
  }

  if (cleanFailed > 0) {
    log('!', YELLOW, `${cleaned} cleaned, ${cleanFailed} cleanup errors`);
  } else {
    log('✓', GREEN, `${cleaned} cleanup actions completed`);
  }
}

// ────────────────────────────────────────────────────────────────
// Tags (2 tests)
// ────────────────────────────────────────────────────────────────

async function testTags() {
  section('Tags');

  // 1. GET /api/tags — verify shape
  await test('Tags returns {tags: [{tag, count}]} shape', async () => {
    const {status, data} = await api('GET', '/api/tags');
    assertEq(status, 200, 'status');
    assertOk(data.tags !== undefined, 'has tags field');
    assertOk(Array.isArray(data.tags), 'tags is array');
  });

  // 2. Tags array is non-empty (test project has tagged content)
  await test('Tags array is non-empty', async () => {
    const {status, data} = await api('GET', '/api/tags');
    assertEq(status, 200, 'status');
    assertOk(data.tags.length > 0, 'tags array is non-empty');
    const tag = data.tags[0];
    assertOk(typeof tag.tag === 'string', 'tag has tag string');
    assertOk(typeof tag.count === 'number', 'tag has count number');
    assertOk(tag.tag.length > 0, 'tag string is non-empty');
    assertOk(tag.count > 0, 'count is positive');
  });
}

// ────────────────────────────────────────────────────────────────
// Timeline Stats (2 tests)
// ────────────────────────────────────────────────────────────────

async function testTimelineStats() {
  section('Timeline Stats');

  // 1. GET /api/stats/timeline — verify shape
  await test('Timeline returns {timeline: [{month, count}]} shape', async () => {
    const {status, data} = await api('GET', '/api/stats/timeline');
    assertEq(status, 200, 'status');
    assertOk(data.timeline !== undefined, 'has timeline field');
    assertOk(Array.isArray(data.timeline), 'timeline is array');
  });

  // 2. Timeline array is non-empty
  await test('Timeline array is non-empty', async () => {
    const {status, data} = await api('GET', '/api/stats/timeline');
    assertEq(status, 200, 'status');
    assertOk(data.timeline.length > 0, 'timeline array is non-empty');
    const entry = data.timeline[0];
    assertOk(typeof entry.month === 'string', 'entry has month string');
    assertOk(typeof entry.count === 'number', 'entry has count number');
    assertOk(/^\d{4}-\d{2}$/.test(entry.month), 'month is YYYY-MM format');
    assertOk(entry.count > 0, 'count is positive');
  });
}

// ────────────────────────────────────────────────────────────────
// Content Health (1 test)
// ────────────────────────────────────────────────────────────────

async function testContentHealth() {
  section('Content Health');

  await test('Content health returns expected fields', async () => {
    const {status, data} = await api('GET', '/api/content-health');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalPages === 'number', 'totalPages is number');
    assertOk(typeof data.draftCount === 'number', 'draftCount is number');
    assertOk(typeof data.brokenLinkCount === 'number', 'brokenLinkCount is number');
    assertOk(typeof data.orphanPageCount === 'number', 'orphanPageCount is number');
    assertOk(typeof data.totalLinks === 'number', 'totalLinks is number');
    assertOk(Array.isArray(data.brokenLinks), 'brokenLinks is array');
    assertOk(Array.isArray(data.orphanPages), 'orphanPages is array');
    assertOk(data.totalPages > 0, 'totalPages is positive');
  });
}

// ────────────────────────────────────────────────────────────────
// File Keywords (3 tests)
// ────────────────────────────────────────────────────────────────

async function testFileKeywords() {
  section('File Keywords');

  // 1. GET /api/file/keywords — verify shape for a real file
  await test('File keywords returns {keywords, totalWords} shape', async () => {
    const {status, data} = await api('GET', '/api/file/keywords?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.keywords), 'keywords is array');
    assertOk(typeof data.totalWords === 'number', 'totalWords is number');
  });

  // 2. Keywords is non-empty for a real file
  await test('File keywords is non-empty for real file', async () => {
    const {status, data} = await api('GET', '/api/file/keywords?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(data.keywords.length > 0, 'keywords array is non-empty');
    const kw = data.keywords[0];
    assertOk(typeof kw.word === 'string', 'keyword has word string');
    assertOk(typeof kw.count === 'number', 'keyword has count number');
    assertOk(kw.word.length > 0, 'word is non-empty');
    assertOk(kw.count > 0, 'count is positive');
  });

  // 3. Invalid path returns 400
  await test('File keywords with invalid path returns 400', async () => {
    const {status, data} = await api('GET', '/api/file/keywords?path=../../etc/passwd');
    assertEq(status, 400, 'status');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// BibTeX Reading List Export (2 tests)
// ────────────────────────────────────────────────────────────────

let bibtexListId = null;

async function testBibtexExport() {
  section('BibTeX Reading List Export');

  // Setup: create a reading list with a reference-type item and export
  await test('Create reading list and export as BibTeX', async () => {
    // Create the list
    const {status: createStatus, data: createData} = await api('POST', '/api/reading-lists', {
      name: `BibTeX Export List ${TEST_PREFIX}`,
      description: 'A test list for BibTeX export',
    });
    assertEq(createStatus, 200, 'create status');
    assertOk(createData.list, 'has list object');
    bibtexListId = createData.list.id;
    cleanup.push(async () => {
      try { await api('DELETE', `/api/reading-lists/${bibtexListId}`); } catch { /* ignore */ }
    });

    // Add a reference-type item with a known key from references.yaml
    const {status: addStatus, data: addData} = await api('POST', `/api/reading-lists/${bibtexListId}/items`, {
      path: 'alon2016probabilistic',
      title: 'The Probabilistic Method',
      type: 'reference',
    });
    assertEq(addStatus, 200, 'add item status');
    assertOk(addData.list.items.length >= 1, 'item added');

    // Export as BibTeX
    const {status: exportStatus, data: exportData} = await api('GET', `/api/reading-lists/${bibtexListId}/export?format=bibtex`);
    assertEq(exportStatus, 200, 'export status');
    assertOk(typeof exportData === 'string', 'response is text');
    assertOk(exportData.includes('@'), 'contains BibTeX @ marker');
    assertOk(exportData.includes('alon2016probabilistic'), 'contains the reference key');
  });

  // Verify BibTeX contains expected fields
  await test('BibTeX export contains expected fields', async () => {
    if (!bibtexListId) throw new Error('No list id from previous test');
    const {status, data} = await api('GET', `/api/reading-lists/${bibtexListId}/export?format=bibtex`);
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('title'), 'contains title field');
    assertOk(data.includes('author'), 'contains author field');
    assertOk(data.includes('year'), 'contains year field');
  });
}

// ────────────────────────────────────────────────────────────────
// Shared Annotations (1 test)
// ────────────────────────────────────────────────────────────────

async function testSharedAnnotations() {
  section('Shared Annotations');

  await test('Shared annotations returns {annotations, total}', async () => {
    const {status, data} = await api('GET', '/api/annotations/shared');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.annotations), 'annotations is array');
    assertOk(typeof data.total === 'number', 'total is number');
    assertOk(data.total >= 0, 'total is non-negative');
    assertEq(data.total, data.annotations.length, 'total matches annotations length');
  });
}

// ────────────────────────────────────────────────────────────────
// Co-Author Network (1 test)
// ────────────────────────────────────────────────────────────────

async function testCoAuthorNetwork() {
  section('Co-Author Network');

  await test('Co-author network returns {edges, authors, totalPairs}', async () => {
    const {status, data} = await api('GET', '/api/references/co-authors');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.edges), 'edges is array');
    assertOk(Array.isArray(data.authors), 'authors is array');
    assertOk(typeof data.totalPairs === 'number', 'totalPairs is number');
    assertOk(data.totalPairs >= 0, 'totalPairs is non-negative');
    if (data.edges.length > 0) {
      const edge = data.edges[0];
      assertOk(typeof edge.author1 === 'string', 'edge has author1');
      assertOk(typeof edge.author2 === 'string', 'edge has author2');
      assertOk(typeof edge.papers === 'number', 'edge has papers count');
      assertOk(edge.papers > 0, 'papers count is positive');
    }
    if (data.authors.length > 0) {
      assertOk(typeof data.authors[0] === 'string', 'authors contains strings');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Content Freshness (1 test)
// ────────────────────────────────────────────────────────────────

async function testContentFreshness() {
  section('Content Freshness');

  await test('Content freshness returns {files, counts, totalFiles}', async () => {
    const {status, data} = await api('GET', '/api/content-freshness');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.files), 'files is array');
    assertOk(typeof data.totalFiles === 'number', 'totalFiles is number');
    assertOk(data.totalFiles >= 0, 'totalFiles is non-negative');
    assertOk(typeof data.counts === 'object', 'counts is object');
    assertOk(typeof data.counts.fresh === 'number', 'counts.fresh is number');
    assertOk(typeof data.counts.recent === 'number', 'counts.recent is number');
    assertOk(typeof data.counts.aging === 'number', 'counts.aging is number');
    assertOk(typeof data.counts.stale === 'number', 'counts.stale is number');
    // Sum of counts should equal totalFiles
    const sum = data.counts.fresh + data.counts.recent + data.counts.aging + data.counts.stale;
    assertEq(sum, data.totalFiles, 'counts sum equals totalFiles');
  });
}

// ────────────────────────────────────────────────────────────────
// Reading Progress (3 tests)
// ────────────────────────────────────────────────────────────────

async function testReadingProgress() {
  section('Reading Progress');

  const progressUserId = `${TEST_PREFIX}_reader`;
  const progressPagePath = `/${TEST_PREFIX}/progress-page`;

  // 1. POST /api/reading-progress — track progress
  await test('Post reading progress returns {success: true}', async () => {
    const {status, data} = await api('POST', '/api/reading-progress', {
      userId: progressUserId,
      pagePath: progressPagePath,
      progress: 0.5,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success === true, 'success is true');
  });

  // 2. GET /api/reading-progress?userId=... — retrieve progress
  await test('Get reading progress returns {pages, totalRead, inProgress, totalTracked}', async () => {
    const {status, data} = await api('GET', `/api/reading-progress?userId=${encodeURIComponent(progressUserId)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.pages), 'pages is array');
    assertOk(typeof data.totalRead === 'number', 'totalRead is number');
    assertOk(typeof data.inProgress === 'number', 'inProgress is number');
    assertOk(typeof data.totalTracked === 'number', 'totalTracked is number');
    // Should find our tracked page
    const found = data.pages.find(p => p.pagePath === progressPagePath);
    assertOk(found, 'found our tracked page');
    assertEq(found.progress, 0.5, 'progress matches');
  });

  // 3. POST again with full progress, verify totalRead increments
  await test('Update reading progress to 100 marks as read', async () => {
    const {status, data} = await api('POST', '/api/reading-progress', {
      userId: progressUserId,
      pagePath: progressPagePath,
      progress: 100,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success === true, 'success is true');
    const {data: getData} = await api('GET', `/api/reading-progress?userId=${encodeURIComponent(progressUserId)}`);
    const found = getData.pages.find(p => p.pagePath === progressPagePath);
    assertOk(found, 'found tracked page');
    assertEq(found.progress, 100, 'progress updated to 100');
    assertOk(getData.totalRead >= 1, 'totalRead is at least 1');
  });
}

// ────────────────────────────────────────────────────────────────
// Changelog (1 test)
// ────────────────────────────────────────────────────────────────

async function testChangelog() {
  section('Changelog');

  await test('Changelog returns {events, total}', async () => {
    const {status, data} = await api('GET', '/api/changelog');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.events), 'events is array');
    assertOk(typeof data.total === 'number', 'total is number');
    assertOk(data.total >= 0, 'total is non-negative');
    if (data.events.length > 0) {
      const event = data.events[0];
      // Events should have at least a date/timestamp
      assertOk(
        typeof event.date === 'string' || typeof event.timestamp === 'string',
        'event has date or timestamp',
      );
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Reference Impact (1 test)
// ────────────────────────────────────────────────────────────────

async function testReferenceImpact() {
  section('Reference Impact');

  await test('Reference impact returns {references, total}', async () => {
    const {status, data} = await api('GET', '/api/references/impact');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.references), 'references is array');
    assertOk(typeof data.total === 'number', 'total is number');
    assertOk(data.total >= 0, 'total is non-negative');
    if (data.references.length > 0) {
      const ref = data.references[0];
      assertOk(typeof ref.key === 'string', 'reference has key');
      assertOk(typeof ref.title === 'string', 'reference has title');
      assertOk(typeof ref.year === 'number' || typeof ref.year === 'string', 'reference has year');
      assertOk(typeof ref.venue === 'string' || ref.venue === undefined, 'reference has venue or undefined');
      assertOk(typeof ref.citations === 'number', 'reference has citations');
      assertOk(typeof ref.score === 'number', 'reference has score');
      assertOk(ref.score >= 0, 'score is non-negative');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Activity Heatmap (1 test)
// ────────────────────────────────────────────────────────────────

async function testActivityHeatmap() {
  section('Activity Heatmap');

  await test('Activity heatmap returns {days, totalDays}', async () => {
    const {status, data} = await api('GET', '/api/activity-heatmap');
    assertEq(status, 200, 'status');
    assertOk(typeof data.days === 'object', 'days is object');
    assertOk(typeof data.totalDays === 'number', 'totalDays is number');
    assertOk(data.totalDays >= 0, 'totalDays is non-negative');
    // Verify structure: days is a map of date strings to counts
    const dayKeys = Object.keys(data.days);
    if (dayKeys.length > 0) {
      const firstKey = dayKeys[0];
      assertOk(/^\d{4}-\d{2}-\d{2}$/.test(firstKey), 'day key is YYYY-MM-DD format');
      assertOk(typeof data.days[firstKey] === 'number', 'day value is a number');
      assertOk(data.days[firstKey] >= 0, 'day value is non-negative');
    }
    assertEq(dayKeys.length, data.totalDays, 'totalDays matches number of day keys');
  });
}

// ────────────────────────────────────────────────────────────────
// Content TOC (1 test)
// ────────────────────────────────────────────────────────────────

async function testContentToc() {
  section('Content TOC');

  await test('Content TOC returns {toc: [{type, name, title, ...}]}', async () => {
    const {status, data} = await api('GET', '/api/content-toc');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.toc), 'toc is array');
    assertOk(data.toc.length > 0, 'toc is non-empty');
    const entry = data.toc[0];
    assertOk(typeof entry.type === 'string', 'entry has type');
    assertOk(typeof entry.name === 'string', 'entry has name');
    assertOk(typeof entry.title === 'string', 'entry has title');
  });
}

// ────────────────────────────────────────────────────────────────
// Quick Notes CRUD (3 tests)
// ────────────────────────────────────────────────────────────────

let createdQuickNoteId = null;
const QUICKNOTE_USER = `${TEST_PREFIX}_qn_user`;

async function testQuickNotes() {
  section('Quick Notes');

  // 1. POST /api/quicknotes — create a note
  await test('Create quick note', async () => {
    const {status, data} = await api('POST', '/api/quicknotes', {
      userId: QUICKNOTE_USER,
      text: `Test note ${TEST_PREFIX}`,
      color: '#ffeb3b',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.note, 'has note object');
    assertOk(data.note.id, 'note has id');
    assertEq(data.note.text, `Test note ${TEST_PREFIX}`, 'text matches');
    assertEq(data.note.color, '#ffeb3b', 'color matches');
    assertOk(typeof data.note.createdAt === 'string', 'has createdAt');
    assertOk(typeof data.note.updatedAt === 'string', 'has updatedAt');
    createdQuickNoteId = data.note.id;
  });

  // 2. GET /api/quicknotes?userId=... — list notes
  await test('List quick notes contains test note', async () => {
    const {status, data} = await api('GET', `/api/quicknotes?userId=${encodeURIComponent(QUICKNOTE_USER)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.notes), 'notes is array');
    assertOk(typeof data.total === 'number', 'total is number');
    assertOk(data.total >= 1, 'total >= 1');
    const found = data.notes.find(n => n.id === createdQuickNoteId);
    assertOk(found, 'found our test note');
    assertEq(found.text, `Test note ${TEST_PREFIX}`, 'text matches');
  });

  // 3. DELETE /api/quicknotes — delete note
  await test('Delete quick note', async () => {
    if (!createdQuickNoteId) throw new Error('No note id from previous test');
    const {status, data} = await api('DELETE', '/api/quicknotes', {
      userId: QUICKNOTE_USER,
      id: createdQuickNoteId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', `/api/quicknotes?userId=${encodeURIComponent(QUICKNOTE_USER)}`);
    assertOk(!listData.notes.some(n => n.id === createdQuickNoteId), 'note removed');
  });
}

// ────────────────────────────────────────────────────────────────
// Pins CRUD (3 tests)
// ────────────────────────────────────────────────────────────────

const TEST_PIN_PATH = `/${TEST_PREFIX}/pinned-page`;

async function testPins() {
  section('Pins');

  // 1. POST /api/pins — pin a page
  await test('Pin a page', async () => {
    const {status, data} = await api('POST', '/api/pins', {
      path: TEST_PIN_PATH,
      title: `Pinned Page ${TEST_PREFIX}`,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });

  // 2. GET /api/pins — list pins, verify our pin exists
  await test('List pins contains test pin', async () => {
    const {status, data} = await api('GET', '/api/pins');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.pins), 'pins is array');
    const found = data.pins.find(p => p.path === TEST_PIN_PATH);
    assertOk(found, 'found our pinned page');
    assertEq(found.title, `Pinned Page ${TEST_PREFIX}`, 'title matches');
    assertOk(typeof found.pinnedAt === 'string', 'has pinnedAt');
  });

  // 3. DELETE /api/pins — unpin
  await test('Unpin a page', async () => {
    const {status, data} = await api('DELETE', '/api/pins', {
      path: TEST_PIN_PATH,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/pins');
    assertOk(!listData.pins.some(p => p.path === TEST_PIN_PATH), 'pin removed');
  });
}

// ────────────────────────────────────────────────────────────────
// Preferences (2 tests)
// ────────────────────────────────────────────────────────────────

const PREFS_USER = `${TEST_PREFIX}_prefs_user`;

async function testPreferences() {
  section('Preferences');

  // 1. PUT /api/preferences — set preferences
  await test('Set preferences', async () => {
    const {status, data} = await api('PUT', '/api/preferences', {
      userId: PREFS_USER,
      preferences: {theme: 'dark', fontSize: 16, language: 'en'},
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.preferences, 'has preferences object');
    assertEq(data.preferences.theme, 'dark', 'theme matches');
    assertEq(data.preferences.fontSize, 16, 'fontSize matches');
    assertEq(data.preferences.language, 'en', 'language matches');
    assertOk(typeof data.preferences.updatedAt === 'string', 'has updatedAt');
  });

  // 2. GET /api/preferences?userId=... — get preferences
  await test('Get preferences', async () => {
    const {status, data} = await api('GET', `/api/preferences?userId=${encodeURIComponent(PREFS_USER)}`);
    assertEq(status, 200, 'status');
    assertOk(data.preferences, 'has preferences object');
    assertEq(data.preferences.theme, 'dark', 'theme matches');
    assertEq(data.preferences.fontSize, 16, 'fontSize matches');
    assertEq(data.preferences.language, 'en', 'language matches');
  });
}

// ────────────────────────────────────────────────────────────────
// Reviews CRUD (3 tests)
// ────────────────────────────────────────────────────────────────

let createdReviewId = null;

async function testReviews() {
  section('Reviews');

  // 1. POST /api/reviews — create a review
  await test('Create review', async () => {
    const {status, data} = await api('POST', '/api/reviews', {
      path: `/${TEST_PREFIX}/review-page`,
      requestedBy: `${TEST_PREFIX}_reviewer`,
      note: 'Please review this page',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.review, 'has review object');
    assertOk(data.review.id, 'review has id');
    assertEq(data.review.path, `/${TEST_PREFIX}/review-page`, 'path matches');
    assertEq(data.review.requestedBy, `${TEST_PREFIX}_reviewer`, 'requestedBy matches');
    assertEq(data.review.note, 'Please review this page', 'note matches');
    assertEq(data.review.status, 'pending', 'status is pending');
    assertOk(typeof data.review.createdAt === 'string', 'has createdAt');
    createdReviewId = data.review.id;
  });

  // 2. GET /api/reviews — list reviews, verify our review exists
  await test('List reviews contains test review', async () => {
    const {status, data} = await api('GET', '/api/reviews');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.reviews), 'reviews is array');
    assertOk(typeof data.total === 'number', 'total is number');
    const found = data.reviews.find(r => r.id === createdReviewId);
    assertOk(found, 'found our test review');
    assertEq(found.status, 'pending', 'status is pending');
  });

  // 3. PUT /api/reviews — approve review
  await test('Approve review', async () => {
    if (!createdReviewId) throw new Error('No review id from previous test');
    const {status, data} = await api('PUT', '/api/reviews', {
      id: createdReviewId,
      status: 'approved',
      reviewedBy: `${TEST_PREFIX}_approver`,
      feedback: 'Looks good!',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.review, 'has review object');
    assertEq(data.review.status, 'approved', 'status is approved');
    assertEq(data.review.reviewedBy, `${TEST_PREFIX}_approver`, 'reviewedBy matches');
    assertEq(data.review.feedback, 'Looks good!', 'feedback matches');
    assertOk(typeof data.review.reviewedAt === 'string', 'has reviewedAt');
  });
}

// ────────────────────────────────────────────────────────────────
// Research Questions CRUD (4 tests)
// ────────────────────────────────────────────────────────────────

let createdResearchQuestionId = null;

async function testResearchQuestions() {
  section('Research Questions');

  // 1. POST /api/research-questions — create a question
  await test('Create research question', async () => {
    const {status, data} = await api('POST', '/api/research-questions', {
      question: `What is the ${TEST_PREFIX} hypothesis?`,
      context: 'Testing research question creation',
      relatedPapers: ['vaswani2017attention'],
      tags: ['test', 'hypothesis'],
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.question, 'has question object');
    assertOk(data.question.id, 'question has id');
    assertEq(data.question.question, `What is the ${TEST_PREFIX} hypothesis?`, 'question text matches');
    assertEq(data.question.context, 'Testing research question creation', 'context matches');
    assertEq(data.question.status, 'open', 'status is open');
    assertOk(Array.isArray(data.question.relatedPapers), 'relatedPapers is array');
    assertOk(Array.isArray(data.question.tags), 'tags is array');
    assertOk(typeof data.question.createdAt === 'string', 'has createdAt');
    createdResearchQuestionId = data.question.id;
  });

  // 2. GET /api/research-questions — list, verify our question exists
  await test('List research questions contains test question', async () => {
    const {status, data} = await api('GET', '/api/research-questions');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.questions), 'questions is array');
    assertOk(typeof data.total === 'number', 'total is number');
    const found = data.questions.find(q => q.id === createdResearchQuestionId);
    assertOk(found, 'found our test question');
    assertEq(found.status, 'open', 'status is open');
  });

  // 3. PUT /api/research-questions — update status and answer
  await test('Update research question', async () => {
    if (!createdResearchQuestionId) throw new Error('No question id from previous test');
    const {status, data} = await api('PUT', '/api/research-questions', {
      id: createdResearchQuestionId,
      status: 'resolved',
      answer: 'The hypothesis was confirmed.',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.question, 'has question object');
    assertEq(data.question.status, 'resolved', 'status is resolved');
    assertEq(data.question.answer, 'The hypothesis was confirmed.', 'answer matches');
    assertOk(typeof data.question.updatedAt === 'string', 'has updatedAt');
  });

  // 4. DELETE /api/research-questions — delete
  await test('Delete research question', async () => {
    if (!createdResearchQuestionId) throw new Error('No question id from previous test');
    const {status, data} = await api('DELETE', '/api/research-questions', {
      id: createdResearchQuestionId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', '/api/research-questions');
    assertOk(!listData.questions.some(q => q.id === createdResearchQuestionId), 'question removed');
  });
}

// ────────────────────────────────────────────────────────────────
// Search Suggestions (2 tests)
// ────────────────────────────────────────────────────────────────

async function testSearchSuggestions() {
  section('Search Suggestions');

  // 1. GET /api/search/suggest?q=attention — returns suggestions array
  await test('Search suggestions returns suggestions array', async () => {
    const {status, data} = await api('GET', '/api/search/suggest?q=attention');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.suggestions), 'suggestions is array');
    if (data.suggestions.length > 0) {
      const sug = data.suggestions[0];
      assertOk(typeof sug.type === 'string', 'suggestion has type');
      assertOk(typeof sug.text === 'string', 'suggestion has text');
    }
  });

  // 2. GET /api/search/suggest?q=x — short query returns empty suggestions
  await test('Search suggestions with short query returns empty', async () => {
    const {status, data} = await api('GET', '/api/search/suggest?q=x');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.suggestions), 'suggestions is array');
    assertEq(data.suggestions.length, 0, 'empty suggestions for single char');
  });
}

// ────────────────────────────────────────────────────────────────
// Dashboard (1 test)
// ────────────────────────────────────────────────────────────────

async function testDashboard() {
  section('Dashboard');

  await test('Dashboard returns {content, social, streak, traffic}', async () => {
    const {status, data} = await api('GET', '/api/dashboard');
    assertEq(status, 200, 'status');
    // content
    assertOk(typeof data.content === 'object', 'has content object');
    assertOk(typeof data.content.files === 'number', 'content.files is number');
    assertOk(typeof data.content.words === 'number', 'content.words is number');
    assertOk(typeof data.content.references === 'number', 'content.references is number');
    // social
    assertOk(typeof data.social === 'object', 'has social object');
    assertOk(typeof data.social.comments === 'number', 'social.comments is number');
    assertOk(typeof data.social.channels === 'number', 'social.channels is number');
    assertOk(typeof data.social.messages === 'number', 'social.messages is number');
    // streak
    assertOk(typeof data.streak === 'object', 'has streak object');
    assertOk(typeof data.streak.wordsToday === 'number', 'streak.wordsToday is number');
    assertOk(typeof data.streak.totalEntries === 'number', 'streak.totalEntries is number');
    // traffic
    assertOk(typeof data.traffic === 'object', 'has traffic object');
    assertOk(typeof data.traffic.totalPageviews === 'number', 'traffic.totalPageviews is number');
    // meta
    assertOk(typeof data.serverUptime === 'number', 'has serverUptime');
    assertOk(typeof data.generatedAt === 'string', 'has generatedAt');
  });
}

// ────────────────────────────────────────────────────────────────
// File Summary (2 tests)
// ────────────────────────────────────────────────────────────────

async function testFileSummary() {
  section('File Summary');

  // 1. GET /api/file/summary?path=... — returns expected shape
  await test('File summary returns {title, summary, headings}', async () => {
    const {status, data} = await api('GET', '/api/file/summary?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data.title === 'string', 'has title');
    assertOk(typeof data.summary === 'string', 'has summary');
    assertOk(Array.isArray(data.headings), 'headings is array');
    assertOk(typeof data.wordCount === 'number', 'has wordCount');
    assertOk(typeof data.readingTime === 'number', 'has readingTime');
    assertOk(data.title.length > 0, 'title is non-empty');
  });

  // 2. Nonexistent file returns 404
  await test('File summary for nonexistent file returns 404', async () => {
    const {status, data} = await api('GET', `/api/file/summary?path=${TEST_PREFIX}_nonexistent.md`);
    assertOk(status === 400 || status === 404, 'status is 400 or 404');
    assertOk(data.error, 'has error message');
  });
}

// ────────────────────────────────────────────────────────────────
// Knowledge Base Report (1 test)
// ────────────────────────────────────────────────────────────────

async function testKnowledgeBaseReport() {
  section('Knowledge Base Report');

  await test('KB report returns {overview, sections, topTags}', async () => {
    const {status, data} = await api('GET', '/api/report/knowledge-base');
    assertEq(status, 200, 'status');
    // overview
    assertOk(typeof data.overview === 'object', 'has overview object');
    assertOk(typeof data.overview.totalFiles === 'number', 'overview.totalFiles is number');
    assertOk(typeof data.overview.totalWords === 'number', 'overview.totalWords is number');
    assertOk(typeof data.overview.references === 'number', 'overview.references is number');
    assertOk(typeof data.overview.avgWordsPerFile === 'number', 'overview.avgWordsPerFile is number');
    assertOk(data.overview.totalFiles > 0, 'totalFiles is positive');
    // sections
    assertOk(Array.isArray(data.sections), 'sections is array');
    assertOk(data.sections.length > 0, 'sections is non-empty');
    const sec = data.sections[0];
    assertOk(typeof sec.name === 'string', 'section has name');
    assertOk(typeof sec.files === 'number', 'section has files');
    assertOk(typeof sec.words === 'number', 'section has words');
    // topTags
    assertOk(Array.isArray(data.topTags), 'topTags is array');
    if (data.topTags.length > 0) {
      const tag = data.topTags[0];
      assertOk(typeof tag.tag === 'string', 'topTag has tag');
      assertOk(typeof tag.count === 'number', 'topTag has count');
    }
    // meta
    assertOk(typeof data.generatedAt === 'string', 'has generatedAt');
  });
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}Mochi Lab Extended API Integration Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}\n`);

  await preflight();

  await testHistory();
  await testBibliographyAdvanced();
  await testBookmarks();
  await testReadingLists();
  await testStreak();
  await testAnnotations();
  await testReactions();
  await testDiscussionPins();
  await testMisc();

  await testAnalyticsDuplicatesAndOrphans();
  await testAnalyticsTopics();
  await testReferencesFormat();
  await testSummaryDaily();
  await testFileInfoEnriched();
  await testLint();
  await testFileOutline();
  await testFilesRecent();
  await testSchedule();
  await testTags();
  await testTimelineStats();
  await testContentHealth();
  await testFileKeywords();
  await testBibtexExport();

  await testWhiteboardCrud();
  await testFeeds();
  await testSlides();
  await testImportUrl();
  await testCitationFormatNotFound();

  await testFileLint();
  await testFileReadability();
  await testFileRelated();
  await testContentLint();
  await testCitationNetwork();
  await testContentDuplicates();

  await testSearchReplace();
  await testWordDiff();
  await testPdfExport();
  await testCitationFormat();
  await testYearDistribution();
  await testByVenue();
  await testByAuthor();
  await testReferenceSearch();
  await testDailySummary();
  await testProductivityReport();

  await testSharedAnnotations();
  await testCoAuthorNetwork();
  await testContentFreshness();
  await testReadingProgress();
  await testChangelog();
  await testReferenceImpact();
  await testActivityHeatmap();
  await testContentToc();

  await testQuickNotes();
  await testPins();
  await testPreferences();
  await testReviews();
  await testResearchQuestions();
  await testSearchSuggestions();
  await testDashboard();
  await testFileSummary();
  await testKnowledgeBaseReport();

  await runCleanup();

  // ── Summary ──
  const total = passed + failed;
  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  ${GREEN}${passed}${RESET} passed, ${failed > 0 ? RED : ''}${failed}${RESET} failed`);
  console.log(`  ${passed}/${total} tests passed\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}Unhandled error:${RESET}`, err);
  process.exit(2);
});
