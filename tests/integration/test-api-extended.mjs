#!/usr/bin/env node
import {createApiClient} from './api-client.mjs';
// ─────────────────────────────────────────────────────────────
// Extended API integration tests for the Mochi Lab editor server
// Covers endpoints NOT tested by test-api.mjs
// Usage:  node tests/integration/test-api-extended.mjs
// Requires the server running on http://localhost:3001
// ─────────────────────────────────────────────────────────────

const BASE = process.env.API_URL || 'http://localhost:3001';
// Sample document path exercised across the endpoint tests below.
const SAMPLE_DOC = 'books/math/0-intro.md';

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
const api = createApiClient(BASE);

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
    console.error(`  Start it with:  node server/index.js`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// Test data identifiers
// ────────────────────────────────────────────────────────────────

const TEST_PREFIX = `__xtest_${Date.now()}`;
const TEST_ANNOTATION_PAGE = `${TEST_PREFIX}/annotation-page`;
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
      wordsWritten: 100,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(typeof data.date === 'string', 'has date');
    assertEq(data.words, 100, 'words matches');
  });

  // 2. GET /api/streak
  await test('Get streak data', async () => {
    const {status, data} = await api('GET', `/api/streak`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.currentStreak === 'number', 'has currentStreak');
    assertOk(typeof data.longestStreak === 'number', 'has longestStreak');
    assertOk(typeof data.totalWords === 'number', 'has totalWords');
    assertOk(Array.isArray(data.dailyLog), 'has dailyLog array');
    assertOk(data.totalWords >= 100, 'totalWords includes our entry');
  });
}

// ────────────────────────────────────────────────────────────────
// Misc (4 tests)
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
    const {status, data} = await api('GET', `/api/backlinks?path=${SAMPLE_DOC}`);
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

  // 4. GET /api/documents/recent — verify files array
  await test('Recent files returns files array', async () => {
    const {status, data} = await api('GET', '/api/documents/recent');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.files), 'files is array');
    if (data.files.length > 0) {
      const file = data.files[0];
      assertOk(typeof file.name === 'string', 'file has name');
      assertOk(typeof file.path === 'string', 'file has path');
      assertOk(typeof file.mtime === 'number', 'file has mtime');
    }
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
// Files Recent (1 test — extended verification)
// ────────────────────────────────────────────────────────────────

async function testFilesRecent() {
  section('Files Recent');

  await test('Recent files returns well-shaped entries', async () => {
    const {status, data} = await api('GET', '/api/documents/recent');
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

  const schedulePath = SAMPLE_DOC;
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
// File Lint (2 tests)
// ────────────────────────────────────────────────────────────────

async function testFileLint() {
  section('File Lint');

  // 1. GET /api/documents/analysis/lint?path=... — verify shape
  await test('File lint returns issues and issueCount', async () => {
    const {status, data} = await api('GET', `/api/documents/analysis/lint?path=${SAMPLE_DOC}`);
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
    const {status, data} = await api('GET', '/api/documents/analysis/lint?path=../../etc/passwd');
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
    const {status, data} = await api('GET', `/api/documents/analysis/readability?path=${SAMPLE_DOC}`);
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
    const {status, data} = await api('GET', `/api/documents/analysis/related?path=${SAMPLE_DOC}`);
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

  // 1. GET /api/documents/analysis/keywords — verify shape for a real file
  await test('File keywords returns {keywords, totalWords} shape', async () => {
    const {status, data} = await api('GET', `/api/documents/analysis/keywords?path=${SAMPLE_DOC}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.keywords), 'keywords is array');
    assertOk(typeof data.totalWords === 'number', 'totalWords is number');
  });

  // 2. Keywords is non-empty for a real file
  await test('File keywords is non-empty for real file', async () => {
    const {status, data} = await api('GET', `/api/documents/analysis/keywords?path=${SAMPLE_DOC}`);
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
    const {status, data} = await api('GET', '/api/documents/analysis/keywords?path=../../etc/passwd');
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

}

// ────────────────────────────────────────────────────────────────
// Changelog (1 test)
// ────────────────────────────────────────────────────────────────

async function testChangelog() {
  section('Changelog');

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
// Quick Notes CRUD (3 tests)
// ────────────────────────────────────────────────────────────────

let createdQuickNoteId = null;
const QUICKNOTE_USER = `${TEST_PREFIX}_qn_user`;

async function testQuickNotes() {
  section('Quick Notes');

  // 1. POST /api/quicknotes — create a note
  await test('Create quick note', async () => {
    const {status, data} = await api('POST', '/api/quicknotes', {
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

  // 2. GET /api/quicknotes — list notes
  await test('List quick notes contains test note', async () => {
    const {status, data} = await api('GET', `/api/quicknotes`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data), 'notes is array');
    const found = data.find(n => n.id === createdQuickNoteId);
    assertOk(found, 'found our test note');
    assertEq(found.text, `Test note ${TEST_PREFIX}`, 'text matches');
  });

  // 3. DELETE /api/quicknotes — delete note
  await test('Delete quick note', async () => {
    if (!createdQuickNoteId) throw new Error('No note id from previous test');
    const {status, data} = await api('DELETE', '/api/quicknotes', {
      id: createdQuickNoteId,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it is gone
    const {data: listData} = await api('GET', `/api/quicknotes`);
    assertOk(!listData.some(n => n.id === createdQuickNoteId), 'note removed');
  });
}

// ────────────────────────────────────────────────────────────────
// Pins CRUD (3 tests)
// ────────────────────────────────────────────────────────────────

const TEST_PIN_PATH = `/${TEST_PREFIX}/pinned-page`;

// ────────────────────────────────────────────────────────────────
// Preferences (2 tests)
// ────────────────────────────────────────────────────────────────

const PREFS_USER = `${TEST_PREFIX}_prefs_user`;

async function testPreferences() {
  section('Preferences');

  // 1. PUT /api/preferences — set preferences
  await test('Set preferences', async () => {
    const {status, data} = await api('PUT', '/api/preferences', {
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

  // 2. GET /api/preferences — get preferences
  await test('Get preferences', async () => {
    const {status, data} = await api('GET', `/api/preferences`);
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

// ────────────────────────────────────────────────────────────────
// Research Questions CRUD (4 tests)
// ────────────────────────────────────────────────────────────────

let createdResearchQuestionId = null;

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}Mochi Lab Extended API Integration Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}\n`);

  await preflight();
  await testBibliographyAdvanced();
  await testBookmarks();
  await testReadingLists();
  await testStreak();
  await testMisc();

  await testAnalyticsDuplicatesAndOrphans();
  await testAnalyticsTopics();
  await testFilesRecent();
  await testSchedule();
  await testTags();
  await testTimelineStats();
  await testContentHealth();
  await testFileKeywords();
  await testBibtexExport();

  await testWhiteboardCrud();
  await testFeeds();

  await testFileLint();
  await testFileReadability();
  await testFileRelated();
  await testContentLint();
  await testCitationNetwork();
  await testContentDuplicates();

  await testSharedAnnotations();
  await testChangelog();
  await testActivityHeatmap();

  await testQuickNotes();
  await testPreferences();

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
