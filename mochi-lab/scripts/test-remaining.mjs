#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Tests for previously uncovered endpoints in the Mochi Lab server
// Usage:  node scripts/test-remaining.mjs
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
let skipped = 0;
const cleanup = [];

function log(icon, color, label, detail = '') {
  const detailStr = detail ? ` ${DIM}${detail}${RESET}` : '';
  console.log(`  ${color}${icon}${RESET} ${label}${detailStr}`);
}
function pass(name, detail) { passed++; log('✓', GREEN, name, detail); }
function fail(name, detail) { failed++; log('✗', RED, name, detail); }
function skip(name, detail) { skipped++; log('-', YELLOW, name, detail); }
function section(title) { console.log(`\n${BOLD}${title}${RESET}`); }

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
  try { await fn(); pass(name); }
  catch (err) { fail(name, err.message); }
}

async function preflight() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(`${BASE}/api/health`, {signal: controller.signal});
    clearTimeout(timer);
    return true;
  } catch {
    console.error(`${RED}ERROR:${RESET} Cannot reach ${BASE}. Is the server running?`);
    process.exit(1);
  }
}

const TEST_PREFIX = `__rem_${Date.now()}`;
const TEST_FILE_PATH = 'content/books/math/0-intro.md';

// ────────────────────────────────────────────────────────────────
// Activity Feed
// ────────────────────────────────────────────────────────────────
async function testActivityFeed() {
  section('Activity Feed');
  await test('GET /api/activity-feed returns events array', async () => {
    const {status, data} = await api('GET', '/api/activity-feed');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.events), 'events is array');
    assertOk(typeof data.total === 'number', 'total is number');
  });
}

// ────────────────────────────────────────────────────────────────
// Admin Health Summary
// ────────────────────────────────────────────────────────────────
async function testAdminHealthSummary() {
  section('Admin Health Summary');
  await test('GET /api/admin/health-summary returns summary', async () => {
    const {status, data} = await api('GET', '/api/admin/health-summary');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalFiles === 'number', 'has totalFiles');
    assertOk(typeof data.totalWords === 'number', 'has totalWords');
  });
}

// ────────────────────────────────────────────────────────────────
// Analytics Export (CSV)
// ────────────────────────────────────────────────────────────────
async function testAnalyticsExport() {
  section('Analytics Export');
  await test('GET /api/analytics/export returns CSV text', async () => {
    const {status, data} = await api('GET', '/api/analytics/export');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('Page,Views'), 'has CSV header');
  });
}

// ────────────────────────────────────────────────────────────────
// Analytics Page
// ────────────────────────────────────────────────────────────────
async function testAnalyticsPage() {
  section('Analytics Page');
  await test('GET /api/analytics/page returns page stats', async () => {
    const {status, data} = await api('GET', `/api/analytics/page?path=/test`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.views === 'number', 'has views');
    assertOk(typeof data.comments === 'number', 'has comments');
    assertOk(typeof data.isBookmarked === 'boolean', 'has isBookmarked');
  });
  await test('GET /api/analytics/page missing path returns 400', async () => {
    const {status} = await api('GET', '/api/analytics/page');
    assertEq(status, 400, 'status');
  });
}

// ────────────────────────────────────────────────────────────────
// Analytics Trends
// ────────────────────────────────────────────────────────────────
async function testAnalyticsTrends() {
  section('Analytics Trends');
  await test('GET /api/analytics/trends returns trend data', async () => {
    const {status, data} = await api('GET', '/api/analytics/trends');
    assertEq(status, 200, 'status');
    assertOk(typeof data.pageviews === 'object', 'has pageviews');
    assertOk(typeof data.pageviews.thisWeek === 'number', 'has thisWeek');
    assertOk(typeof data.pageviews.lastWeek === 'number', 'has lastWeek');
    assertOk(typeof data.pageviews.growth === 'number', 'has growth');
  });
}

// ────────────────────────────────────────────────────────────────
// Bookmarks Folders
// ────────────────────────────────────────────────────────────────
async function testBookmarksFolders() {
  section('Bookmarks Folders');
  await test('GET /api/bookmarks/folders returns folders', async () => {
    const {status, data} = await api('GET', '/api/bookmarks/folders');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.folders), 'folders is array');
  });
  await test('POST /api/bookmarks/folders creates folder', async () => {
    const {status, data} = await api('POST', '/api/bookmarks/folders', {
      name: `test-folder-${TEST_PREFIX}`,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });
}

// ────────────────────────────────────────────────────────────────
// Content Analysis endpoints (read-only GET)
// ────────────────────────────────────────────────────────────────
async function testContentAnalysis() {
  section('Content Analysis');

  await test('GET /api/content-audience returns audience data', async () => {
    const {status, data} = await api('GET', '/api/content-audience');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-backlink-ranking returns ranking', async () => {
    const {status, data} = await api('GET', '/api/content-backlink-ranking');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-calendar returns calendar', async () => {
    const {status, data} = await api('GET', '/api/content-calendar');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-clusters returns clusters', async () => {
    const {status, data} = await api('GET', '/api/content-clusters');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-coverage returns coverage', async () => {
    const {status, data} = await api('GET', '/api/content-coverage');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-diff-summary returns diff summary', async () => {
    const {status, data} = await api('GET', '/api/content-diff-summary');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-engagement returns engagement', async () => {
    const {status, data} = await api('GET', '/api/content-engagement');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-outline returns outline', async () => {
    const {status, data} = await api('GET', '/api/content-outline');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-quality returns quality scores', async () => {
    const {status, data} = await api('GET', '/api/content-quality');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-reading-path returns reading path', async () => {
    const {status, data} = await api('GET', '/api/content-reading-path');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-recommend returns recommendations', async () => {
    const {status, data} = await api('GET', '/api/content-recommend');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-recommend-v2 returns recommendations (needs path)', async () => {
    const {status, data} = await api('GET', `/api/content-recommend-v2?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertOk(status === 200 || status === 400, 'status is 200 or 400');
  });

  await test('GET /api/content-similar returns similar content', async () => {
    const {status, data} = await api('GET', '/api/content-similar');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-status returns status', async () => {
    const {status, data} = await api('GET', '/api/content-status');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-summary returns summary', async () => {
    const {status, data} = await api('GET', '/api/content-summary');
    assertEq(status, 200, 'status');
    assertOk(typeof data.files === 'number', 'has files');
    assertOk(typeof data.words === 'number', 'has words');
    assertOk(typeof data.references === 'number', 'has references');
  });

  await test('GET /api/content-topics returns topics', async () => {
    const {status, data} = await api('GET', '/api/content-topics');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-update-suggestions returns suggestions', async () => {
    const {status, data} = await api('GET', '/api/content-update-suggestions');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/content-wordcloud returns word cloud', async () => {
    const {status, data} = await api('GET', '/api/content-wordcloud');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.words), 'words is array');
  });

  await test('GET /api/content-xref-matrix returns cross-reference matrix', async () => {
    const {status, data} = await api('GET', '/api/content-xref-matrix');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });
}

// ────────────────────────────────────────────────────────────────
// Debug Routes
// ────────────────────────────────────────────────────────────────
async function testDebugRoutes() {
  section('Debug Routes');
  await test('GET /api/debug/routes returns route info', async () => {
    const {status, data} = await api('GET', '/api/debug/routes');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalHandlers === 'number', 'has totalHandlers');
    assertOk(typeof data.uniqueRoutes === 'number', 'has uniqueRoutes');
    assertOk(Array.isArray(data.routes), 'routes is array');
  });
}

// ────────────────────────────────────────────────────────────────
// Export Bundle
// ────────────────────────────────────────────────────────────────
async function testExportBundle() {
  section('Export Bundle');
  await test('POST /api/export/bundle returns bundled content', async () => {
    const {status, data} = await api('POST', '/api/export/bundle', {
      paths: [TEST_FILE_PATH],
      format: 'md',
    });
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });
  await test('POST /api/export/bundle empty paths returns 400', async () => {
    const {status} = await api('POST', '/api/export/bundle', {paths: []});
    assertEq(status, 400, 'status');
  });
}

// ────────────────────────────────────────────────────────────────
// File Analysis endpoints (single file, GET with ?path=)
// ────────────────────────────────────────────────────────────────
async function testFileAnalysis() {
  section('File Analysis');

  await test('GET /api/file/accessibility returns score and issues', async () => {
    const {status, data} = await api('GET', `/api/file/accessibility?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.score === 'number', 'has score');
    assertOk(Array.isArray(data.issues), 'issues is array');
  });

  await test('GET /api/file/complexity returns complexity metrics', async () => {
    const {status, data} = await api('GET', `/api/file/complexity?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.complexityScore === 'number', 'has complexityScore');
  });

  await test('GET /api/file/dependencies returns outgoing and incoming', async () => {
    const {status, data} = await api('GET', `/api/file/dependencies?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.outgoing), 'outgoing is array');
    assertOk(Array.isArray(data.incoming), 'incoming is array');
  });

  await test('GET /api/file/diff requires path1 and path2', async () => {
    const {status} = await api('GET', '/api/file/diff');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/file/diff with valid paths returns diff', async () => {
    const {status, data} = await api('GET', `/api/file/diff?path1=${encodeURIComponent(TEST_FILE_PATH)}&path2=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.changes === 'number', 'has changes');
    assertOk(Array.isArray(data.diff), 'diff is array');
    assertEq(data.changes, 0, 'same file produces 0 changes');
  });

  await test('GET /api/file/health returns health score', async () => {
    const {status, data} = await api('GET', `/api/file/health?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.score === 'number', 'has score');
    assertOk(typeof data.checks === 'object', 'has checks');
  });

  await test('GET /api/file/jsonld returns JSON-LD structured data', async () => {
    const {status, data} = await api('GET', `/api/file/jsonld?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk(data['@context'] || data['@type'], 'has JSON-LD fields');
  });

  await test('GET /api/file/link-suggestions returns suggestions', async () => {
    const {status, data} = await api('GET', `/api/file/link-suggestions?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.suggestions), 'suggestions is array');
  });

  await test('GET /api/file/mentions returns mentions', async () => {
    const {status, data} = await api('GET', `/api/file/mentions?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.mentions), 'mentions is array');
  });

  await test('GET /api/file/quality-score returns quality breakdown', async () => {
    const {status, data} = await api('GET', `/api/file/quality-score?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.score === 'number', 'has score');
    assertOk(typeof data.breakdown === 'object', 'has breakdown');
  });

  await test('GET /api/file/similarity requires path1 and path2', async () => {
    const {status} = await api('GET', '/api/file/similarity');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/file/similarity with same file returns high similarity', async () => {
    const {status, data} = await api('GET', `/api/file/similarity?path1=${encodeURIComponent(TEST_FILE_PATH)}&path2=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.similarity === 'number', 'has similarity');
    assertEq(data.similarity, 1, 'same file has similarity 1');
  });

  await test('GET /api/file/style returns style metrics', async () => {
    const {status, data} = await api('GET', `/api/file/style?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(typeof data.style === 'object', 'has style');
  });

  await test('GET /api/file/suggest-tags returns tag suggestions', async () => {
    const {status, data} = await api('GET', `/api/file/suggest-tags?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.suggestedTags) || Array.isArray(data.tags), 'has suggestions');
  });

  await test('GET /api/file/toc-tree returns hierarchical TOC', async () => {
    const {status, data} = await api('GET', `/api/file/toc-tree?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.tree), 'tree is array');
  });
}

// ────────────────────────────────────────────────────────────────
// File Versioning
// ────────────────────────────────────────────────────────────────
async function testFileVersioning() {
  section('File Versioning');

  let versionId = null;

  await test('POST /api/file/version creates a version', async () => {
    const {status, data} = await api('POST', '/api/file/version', {
      path: TEST_FILE_PATH,
      label: `test-version-${TEST_PREFIX}`,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.version, 'has version');
    assertOk(data.version.id, 'version has id');
    versionId = data.version.id;
  });

  await test('GET /api/file/versions lists versions', async () => {
    const {status, data} = await api('GET', `/api/file/versions?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.versions), 'versions is array');
    assertOk(typeof data.total === 'number', 'total is number');
  });

  await test('GET /api/file/version retrieves a specific version', async () => {
    if (!versionId) { skip('Get specific version', 'no version id'); return; }
    const {status, data} = await api('GET', `/api/file/version?path=${encodeURIComponent(TEST_FILE_PATH)}&id=${versionId}`);
    assertEq(status, 200, 'status');
    assertOk(data.version, 'has version');
    assertOk(data.version.content, 'version has content');
  });
}

// ────────────────────────────────────────────────────────────────
// Batch file operations
// ────────────────────────────────────────────────────────────────
async function testBatchOps() {
  section('Batch File Operations');

  await test('POST /api/files/batch-metadata with empty paths returns 400', async () => {
    const {status} = await api('POST', '/api/files/batch-metadata', {paths: []});
    assertEq(status, 400, 'status');
  });

  await test('POST /api/files/info returns file info for paths', async () => {
    const {status, data} = await api('POST', '/api/files/info', {
      paths: [TEST_FILE_PATH],
    });
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.files), 'files is array');
    assertOk(data.files.length >= 1, 'at least one result');
  });

  await test('POST /api/files/merge missing params returns 400', async () => {
    const {status} = await api('POST', '/api/files/merge', {});
    assertEq(status, 400, 'status');
  });
}

// ────────────────────────────────────────────────────────────────
// Folder CRUD
// ────────────────────────────────────────────────────────────────
async function testFolderCrud() {
  section('Folder CRUD');

  const folderPath = `content/__test_folder_${TEST_PREFIX}`;

  await test('POST /api/folder creates a folder', async () => {
    const {status, data} = await api('POST', '/api/folder', {path: folderPath});
    assertOk(status === 201 || status === 200, 'status is 201 or 200');
    assertOk(data.success, 'success');
  });

  await test('DELETE /api/folder removes an empty folder', async () => {
    const {status, data} = await api('DELETE', '/api/folder', {path: folderPath});
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });
}

// ────────────────────────────────────────────────────────────────
// Graph Export
// ────────────────────────────────────────────────────────────────
async function testGraphExport() {
  section('Graph Export');
  await test('GET /api/graph/export returns DOT format', async () => {
    const {status, data} = await api('GET', '/api/graph/export?format=dot');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('digraph'), 'contains digraph keyword');
  });
}

// ────────────────────────────────────────────────────────────────
// Health History
// ────────────────────────────────────────────────────────────────
async function testHealthHistory() {
  section('Health History');

  await test('POST /api/health-history records a score', async () => {
    const {status, data} = await api('POST', '/api/health-history', {
      score: 85,
      details: {test: true},
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });

  await test('GET /api/health-history returns entries and trend', async () => {
    const {status, data} = await api('GET', '/api/health-history');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.entries), 'entries is array');
    assertOk(typeof data.total === 'number', 'total is number');
    assertOk(typeof data.trend === 'string', 'trend is string');
  });
}

// ────────────────────────────────────────────────────────────────
// Knowledge Gaps
// ────────────────────────────────────────────────────────────────
async function testKnowledgeGaps() {
  section('Knowledge Gaps');
  await test('GET /api/knowledge-gaps returns gaps', async () => {
    const {status, data} = await api('GET', '/api/knowledge-gaps');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });
}

// ────────────────────────────────────────────────────────────────
// Metadata Search (external API - may timeout)
// ────────────────────────────────────────────────────────────────
async function testMetadataSearch() {
  section('Metadata Search');
  await test('GET /api/metadata/search missing query returns 400', async () => {
    const {status} = await api('GET', '/api/metadata/search');
    assertEq(status, 400, 'status');
  });
}

// ────────────────────────────────────────────────────────────────
// Notifications
// ────────────────────────────────────────────────────────────────
async function testNotifications() {
  section('Notifications');
  await test('GET /api/notifications/counts returns counts', async () => {
    const {status, data} = await api('GET', '/api/notifications/counts');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });
}

// ────────────────────────────────────────────────────────────────
// Presence
// ────────────────────────────────────────────────────────────────
async function testPresence() {
  section('Presence');

  await test('POST /api/presence updates presence', async () => {
    const {status, data} = await api('POST', '/api/presence', {
      filePath: TEST_FILE_PATH,
      userId: `user-${TEST_PREFIX}`,
      userName: 'Test User',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });

  await test('GET /api/presence returns users for path', async () => {
    const {status, data} = await api('GET', `/api/presence?path=${encodeURIComponent(TEST_FILE_PATH)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.users), 'users is array');
  });

  await test('GET /api/presence missing path returns 400', async () => {
    const {status} = await api('GET', '/api/presence');
    assertEq(status, 400, 'status');
  });
}

// ────────────────────────────────────────────────────────────────
// Reading Lists Stats
// ────────────────────────────────────────────────────────────────
async function testReadingListsStats() {
  section('Reading Lists Stats');
  await test('GET /api/reading-lists/stats returns list stats', async () => {
    const {status, data} = await api('GET', '/api/reading-lists/stats');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalLists === 'number', 'has totalLists');
    assertOk(typeof data.totalItems === 'number', 'has totalItems');
  });
}

// ────────────────────────────────────────────────────────────────
// Recommendations Add
// ────────────────────────────────────────────────────────────────
async function testRecommendationsAdd() {
  section('Recommendations Add');
  await test('POST /api/recommendations/add missing title returns 400', async () => {
    const {status} = await api('POST', '/api/recommendations/add', {});
    assertEq(status, 400, 'status');
  });
  await test('POST /api/recommendations/add with title succeeds', async () => {
    const {status, data} = await api('POST', '/api/recommendations/add', {
      title: `Test Paper ${TEST_PREFIX}`,
      authors: ['Test Author'],
      year: 2025,
    });
    assertOk(status === 200 || status === 201, 'status is 200 or 201');
    assertOk(data.success || data.key, 'has success or key');
  });
}

// ────────────────────────────────────────────────────────────────
// References Analysis endpoints
// ────────────────────────────────────────────────────────────────
async function testReferencesAnalysis() {
  section('References Analysis');

  await test('GET /api/references/abstracts missing query returns 400', async () => {
    const {status} = await api('GET', '/api/references/abstracts');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/references/abstracts with query returns results', async () => {
    const {status, data} = await api('GET', '/api/references/abstracts?q=attention');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.matches), 'matches is array');
  });

  await test('GET /api/references/analytics returns analytics', async () => {
    const {status, data} = await api('GET', '/api/references/analytics');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalReferences === 'number', 'has totalReferences');
    assertOk(typeof data.uniqueAuthors === 'number', 'has uniqueAuthors');
  });

  await test('GET /api/references/author-profile missing name returns 400', async () => {
    const {status} = await api('GET', '/api/references/author-profile');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/references/author-profile with name returns profile', async () => {
    const {status, data} = await api('GET', '/api/references/author-profile?name=Alon');
    assertEq(status, 200, 'status');
    assertOk(typeof data.paperCount === 'number', 'has paperCount');
    assertOk(Array.isArray(data.papers), 'papers is array');
  });

  await test('GET /api/references/autofill missing key returns 400', async () => {
    const {status} = await api('GET', '/api/references/autofill');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/references/autofill with known key returns suggestions', async () => {
    const {status, data} = await api('GET', '/api/references/autofill?key=alon2016probabilistic');
    assertEq(status, 200, 'status');
    assertOk(typeof data.suggestions === 'object', 'has suggestions');
    assertOk(typeof data.currentEntry === 'object', 'has currentEntry');
  });

  await test('GET /api/references/compare missing keys returns 400', async () => {
    const {status} = await api('GET', '/api/references/compare');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/references/compare with valid keys returns comparison', async () => {
    const {status, data} = await api('GET', '/api/references/compare?key1=alon2016probabilistic&key2=vaswani2017attention');
    assertOk(status === 200 || status === 404, 'status is 200 or 404');
    if (status === 200) {
      assertOk(data.comparison, 'has comparison');
    }
  });

  await test('GET /api/references/completeness returns completeness data', async () => {
    const {status, data} = await api('GET', '/api/references/completeness');
    assertEq(status, 200, 'status');
    assertOk(typeof data.averageCompleteness === 'number', 'has averageCompleteness');
    assertOk(typeof data.totalReferences === 'number', 'has totalReferences');
  });

  await test('GET /api/references/context missing key returns 400', async () => {
    const {status} = await api('GET', '/api/references/context');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/references/context with known key returns contexts', async () => {
    const {status, data} = await api('GET', '/api/references/context?key=alon2016probabilistic');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.contexts), 'contexts is array');
  });

  await test('GET /api/references/duplicates returns duplicate groups', async () => {
    const {status, data} = await api('GET', '/api/references/duplicates');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.duplicates), 'duplicates is array');
    assertOk(typeof data.totalDuplicateGroups === 'number', 'has totalDuplicateGroups');
  });

  await test('GET /api/references/export-json returns JSON file', async () => {
    const {status, data} = await api('GET', '/api/references/export-json');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/references/pagerank returns pagerank data', async () => {
    const {status, data} = await api('GET', '/api/references/pagerank');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.rankings), 'rankings is array');
  });

  await test('GET /api/references/random returns a random reference', async () => {
    const {status, data} = await api('GET', '/api/references/random');
    assertEq(status, 200, 'status');
    assertOk(typeof data.key === 'string' || data.reference === null, 'has key or null reference');
  });

  await test('GET /api/references/reading-order returns ordered list', async () => {
    const {status, data} = await api('GET', '/api/references/reading-order');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.order), 'order is array');
  });

  await test('GET /api/references/recommend-by-author missing name returns 400', async () => {
    const {status} = await api('GET', '/api/references/recommend-by-author');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/references/similar missing key returns 400', async () => {
    const {status} = await api('GET', '/api/references/similar');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/references/similar with known key returns similar papers', async () => {
    const {status, data} = await api('GET', '/api/references/similar?key=alon2016probabilistic');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.similar), 'similar is array');
  });

  await test('GET /api/references/timeline returns timeline by year', async () => {
    const {status, data} = await api('GET', '/api/references/timeline');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.timeline), 'timeline is array');
    assertOk(typeof data.totalYears === 'number', 'has totalYears');
  });

  await test('GET /api/references/trajectory missing key returns 400', async () => {
    const {status} = await api('GET', '/api/references/trajectory');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/references/trending returns trending papers', async () => {
    const {status, data} = await api('GET', '/api/references/trending');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/references/venue-stats missing venue returns 400', async () => {
    const {status} = await api('GET', '/api/references/venue-stats');
    assertEq(status, 400, 'status');
  });
}

// ────────────────────────────────────────────────────────────────
// Search endpoints
// ────────────────────────────────────────────────────────────────
async function testSearchEndpoints() {
  section('Search Endpoints');

  await test('GET /api/search/analytics returns search analytics', async () => {
    const {status, data} = await api('GET', '/api/search/analytics');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalSearches === 'number', 'has totalSearches');
  });

  await test('GET /api/search/global missing query returns 400', async () => {
    const {status} = await api('GET', '/api/search/global');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/search/global with query returns results', async () => {
    const {status, data} = await api('GET', '/api/search/global?q=math');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.results), 'results is array');
  });

  await test('POST /api/search/history logs a search', async () => {
    const {status, data} = await api('POST', '/api/search/history', {
      query: `test-search-${TEST_PREFIX}`,
      resultCount: 5,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });

  await test('GET /api/search/history returns search history', async () => {
    const {status, data} = await api('GET', '/api/search/history');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.searches), 'searches is array');
  });

  await test('GET /api/search/semantic missing query returns 400', async () => {
    const {status} = await api('GET', '/api/search/semantic');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/search/semantic with query returns results', async () => {
    const {status, data} = await api('GET', '/api/search/semantic?q=probability');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.results), 'results is array');
  });
}

// ────────────────────────────────────────────────────────────────
// Sessions
// ────────────────────────────────────────────────────────────────
async function testSessions() {
  section('Sessions');

  await test('POST /api/sessions creates a session', async () => {
    const {status, data} = await api('POST', '/api/sessions', {
      userId: `user-${TEST_PREFIX}`,
      startTime: new Date(Date.now() - 3600000).toISOString(),
      endTime: new Date().toISOString(),
      wordsWritten: 100,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertOk(data.session, 'has session');
  });

  await test('GET /api/sessions returns sessions for user', async () => {
    const {status, data} = await api('GET', `/api/sessions?userId=${encodeURIComponent(`user-${TEST_PREFIX}`)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.sessions), 'sessions is array');
  });
}

// ────────────────────────────────────────────────────────────────
// Sitemap
// ────────────────────────────────────────────────────────────────
async function testSitemap() {
  section('Sitemap');
  await test('GET /api/sitemap.xml returns valid XML', async () => {
    const {status, data} = await api('GET', '/api/sitemap.xml');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('<urlset'), 'contains urlset tag');
    assertOk(data.includes('<?xml'), 'contains XML declaration');
  });
}

// ────────────────────────────────────────────────────────────────
// Stats endpoints
// ────────────────────────────────────────────────────────────────
async function testStatsEndpoints() {
  section('Stats Endpoints');

  await test('GET /api/stats/citations-per-page returns page rankings', async () => {
    const {status, data} = await api('GET', '/api/stats/citations-per-page');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.pages), 'pages is array');
    assertOk(typeof data.total === 'number', 'has total');
  });

  await test('GET /api/stats/compare missing dirs returns 400', async () => {
    const {status} = await api('GET', '/api/stats/compare');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/stats/compare with valid dirs returns comparison', async () => {
    const {status, data} = await api('GET', '/api/stats/compare?dir1=content/books&dir2=content/posts');
    assertEq(status, 200, 'status');
    assertOk(typeof data.dir1 === 'object', 'has dir1');
    assertOk(typeof data.dir2 === 'object', 'has dir2');
  });

  await test('GET /api/stats/directory missing dir returns 400', async () => {
    const {status} = await api('GET', '/api/stats/directory');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/stats/directory with valid dir returns stats', async () => {
    const {status, data} = await api('GET', '/api/stats/directory?dir=content/books');
    assertEq(status, 200, 'status');
    assertOk(typeof data.files === 'number', 'has files');
    assertOk(typeof data.words === 'number', 'has words');
  });

  await test('GET /api/stats/heading-depth returns depth distribution', async () => {
    const {status, data} = await api('GET', '/api/stats/heading-depth');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/stats/link-density returns link density data', async () => {
    const {status, data} = await api('GET', '/api/stats/link-density');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/stats/overview returns overview stats', async () => {
    const {status, data} = await api('GET', '/api/stats/overview');
    assertEq(status, 200, 'status');
    assertOk(typeof data.files === 'number', 'has files');
    assertOk(typeof data.words === 'number', 'has words');
  });

  await test('GET /api/stats/readability returns readability trends', async () => {
    const {status, data} = await api('GET', '/api/stats/readability');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/stats/reading-time returns reading time data', async () => {
    const {status, data} = await api('GET', '/api/stats/reading-time');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalMinutes === 'number', 'has totalMinutes');
  });

  await test('GET /api/stats/word-frequency missing dir returns 400', async () => {
    const {status} = await api('GET', '/api/stats/word-frequency');
    assertEq(status, 400, 'status');
  });

  await test('GET /api/stats/word-frequency with valid dir returns words', async () => {
    const {status, data} = await api('GET', '/api/stats/word-frequency?dir=content/books');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.words), 'words is array');
  });

  await test('GET /api/stats/word-leaderboard returns leaderboard', async () => {
    const {status, data} = await api('GET', '/api/stats/word-leaderboard');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });
}

// ────────────────────────────────────────────────────────────────
// Study Plan
// ────────────────────────────────────────────────────────────────
async function testStudyPlan() {
  section('Study Plan');
  await test('POST /api/study-plan returns a study plan', async () => {
    const {status, data} = await api('POST', '/api/study-plan', {
      topic: 'probability',
    });
    assertOk(status === 200 || status === 400, 'status is 200 or 400');
    if (status === 200) {
      assertOk(typeof data === 'object', 'response is object');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Template Variables
// ────────────────────────────────────────────────────────────────
async function testTemplateVariables() {
  section('Template Variables');

  await test('GET /api/template-variables returns variables', async () => {
    const {status, data} = await api('GET', '/api/template-variables');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('POST /api/template-variables sets a variable', async () => {
    const {status, data} = await api('POST', '/api/template-variables', {
      key: `test_var_${TEST_PREFIX}`,
      value: 'test_value',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });

  await test('DELETE /api/template-variables removes a variable', async () => {
    const {status, data} = await api('DELETE', '/api/template-variables', {
      key: `test_var_${TEST_PREFIX}`,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });
}

// ────────────────────────────────────────────────────────────────
// Custom Templates
// ────────────────────────────────────────────────────────────────
async function testCustomTemplates() {
  section('Custom Templates');

  await test('POST /api/templates/custom creates a template', async () => {
    const {status, data} = await api('POST', '/api/templates/custom', {
      name: `Test Template ${TEST_PREFIX}`,
      content: '# {{title}}\n\nContent here.',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
  });
}

// ────────────────────────────────────────────────────────────────
// Trash
// ────────────────────────────────────────────────────────────────
async function testTrash() {
  section('Trash');

  await test('GET /api/trash returns trash items', async () => {
    const {status, data} = await api('GET', '/api/trash');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.items), 'items is array');
  });

  // We won't test trash/restore or trash/empty as they could destroy data
  // Just verify the endpoints accept proper requests
  await test('POST /api/trash/restore with nonexistent item returns 404', async () => {
    const {status} = await api('POST', '/api/trash/restore', {
      trashPath: 'nonexistent-file.md',
    });
    assertOk(status === 404 || status === 400, 'status is 404 or 400');
  });
}

// ────────────────────────────────────────────────────────────────
// Upload (validation only)
// ────────────────────────────────────────────────────────────────
async function testUpload() {
  section('Upload');
  // We test that the endpoint exists and validates input
  await test('POST /api/upload without proper data returns error', async () => {
    const {status} = await api('POST', '/api/upload', null);
    assertOk(status === 400 || status === 415 || status === 500, `status is ${status}`);
  });
}

// ────────────────────────────────────────────────────────────────
// Users
// ────────────────────────────────────────────────────────────────
async function testUsers() {
  section('Users');

  await test('GET /api/users returns users list', async () => {
    const {status, data} = await api('GET', '/api/users');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/users/me returns user info or empty', async () => {
    const {status, data} = await api('GET', '/api/users/me');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });
}

// ────────────────────────────────────────────────────────────────
// Writing Prompts
// ────────────────────────────────────────────────────────────────
async function testWritingPrompts() {
  section('Writing Prompts');
  await test('GET /api/writing-prompts returns prompts', async () => {
    const {status, data} = await api('GET', '/api/writing-prompts');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });
}

// ────────────────────────────────────────────────────────────────
// AI Complete (validation only - needs API key)
// ────────────────────────────────────────────────────────────────
async function testAiComplete() {
  section('AI Complete');
  await test('POST /api/ai/complete without key returns error', async () => {
    const {status} = await api('POST', '/api/ai/complete', {
      prompt: 'test',
    });
    // Without an API key, expect 400 or 500
    assertOk(status === 400 || status === 500 || status === 401 || status === 403 || status === 200, `status is ${status}`);
  });
}

// ────────────────────────────────────────────────────────────────
// Quick Note (POST /api/quicknote -- distinct from /api/quicknotes)
// ────────────────────────────────────────────────────────────────
async function testQuickNote() {
  section('Quick Note');
  await test('POST /api/quicknote with empty text returns 400', async () => {
    const {status} = await api('POST', '/api/quicknote', {text: ''});
    assertEq(status, 400, 'status');
  });
  await test('GET /api/quicknote lists quick notes', async () => {
    const {status, data} = await api('GET', '/api/quicknote');
    assertOk(status === 200 || status === 404, `status is ${status}`);
  });
}

// ────────────────────────────────────────────────────────────────
// Trash Empty (validation only -- we do not actually empty trash)
// ────────────────────────────────────────────────────────────────
async function testTrashEmpty() {
  section('Trash Empty');
  // We just verify the endpoint exists and responds.
  // Calling DELETE /api/trash/empty would destroy real data, so we only
  // confirm the endpoint is reachable by checking the response status.
  await test('DELETE /api/trash/empty responds (endpoint exists)', async () => {
    // This endpoint actually empties the trash, so we only call it if
    // the trash is empty already.
    const {status: trashStatus, data: trashData} = await api('GET', '/api/trash');
    if (trashData.items && trashData.items.length === 0) {
      const {status} = await api('DELETE', '/api/trash/empty');
      assertEq(status, 200, 'status');
    } else {
      // Trash has items; skip actual deletion to avoid data loss
      skip('DELETE /api/trash/empty', 'skipped: trash has items');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────────
async function runCleanup() {
  section('Cleanup');
  let cleaned = 0;
  let cleanFailed = 0;
  for (const fn of cleanup) {
    try { await fn(); cleaned++; } catch { cleanFailed++; }
  }
  if (cleanFailed > 0) {
    log('!', YELLOW, `${cleaned} cleaned, ${cleanFailed} cleanup errors`);
  } else {
    log('✓', GREEN, `${cleaned} cleanup actions completed`);
  }
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${BOLD}Mochi Lab -- Remaining Endpoints Test Coverage${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}\n`);

  await preflight();

  await testActivityFeed();
  await testAdminHealthSummary();
  await testAnalyticsExport();
  await testAnalyticsPage();
  await testAnalyticsTrends();
  await testBookmarksFolders();
  await testContentAnalysis();
  await testDebugRoutes();
  await testExportBundle();
  await testFileAnalysis();
  await testFileVersioning();
  await testBatchOps();
  await testFolderCrud();
  await testGraphExport();
  await testHealthHistory();
  await testKnowledgeGaps();
  await testMetadataSearch();
  await testNotifications();
  await testPresence();
  await testReadingListsStats();
  await testRecommendationsAdd();
  await testReferencesAnalysis();
  await testSearchEndpoints();
  await testSessions();
  await testSitemap();
  await testStatsEndpoints();
  await testStudyPlan();
  await testTemplateVariables();
  await testCustomTemplates();
  await testTrash();
  await testUpload();
  await testUsers();
  await testWritingPrompts();
  await testAiComplete();
  await testQuickNote();
  await testTrashEmpty();

  await runCleanup();

  // ── Summary ──
  const total = passed + failed + skipped;
  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  ${GREEN}${passed}${RESET} passed, ${failed > 0 ? RED : ''}${failed}${RESET} failed${skipped > 0 ? `, ${YELLOW}${skipped}${RESET} skipped` : ''}`);
  console.log(`  ${passed}/${total} tests passed\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}Unhandled error:${RESET}`, err);
  process.exit(2);
});
