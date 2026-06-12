#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Extra endpoint coverage tests for the Mochi Lab editor server
// Usage:  node scripts/tests/test-extras.mjs
// Requires the server running on http://localhost:3001
// ─────────────────────────────────────────────────────────────

const BASE = process.env.API_URL || 'http://localhost:3001';

// ── Colors ──
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ── State ──
let passed = 0;
let failed = 0;

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
async function api(method, path, body) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const init = { method, headers: {} };
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const contentType = res.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, data, headers: res.headers };
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
    await fetch(`${BASE}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return true;
  } catch {
    console.error(`${RED}ERROR:${RESET} Cannot reach ${BASE}. Is the server running?`);
    console.error(`  Start it with:  node server.js`);
    process.exit(1);
  }
}

// ────────────────────────────────────────────────────────────────
// 1. Backup & Restore (2 tests)
// ────────────────────────────────────────────────────────────────

async function testBackup() {
  section('Backup & Restore');

  // 1. GET /api/backup — verify returns JSON with 10+ keys
  await test('GET /api/backup returns JSON with 10+ keys', async () => {
    const { status, data } = await api('GET', '/api/backup');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object' && data !== null, 'response is an object');
    const keys = Object.keys(data);
    assertOk(keys.length >= 10, `expected 10+ keys, got ${keys.length}: ${keys.join(', ')}`);
  });

  // 2. POST /api/backup/restore with {comments:{}} — verify 200
  await test('POST /api/backup/restore with {comments:{}} returns 200', async () => {
    const { status } = await api('POST', '/api/backup/restore', { comments: {} });
    assertEq(status, 200, 'status');
  });
}

// ────────────────────────────────────────────────────────────────
// 2. Batch Export (1 test)
// ────────────────────────────────────────────────────────────────

async function testBatchExport() {
  section('Batch Export');

  // 3. GET /api/export/batch — verify returns HTML >1000 bytes
  await test('GET /api/export/batch returns HTML >1000 bytes', async () => {
    const { status, data } = await api('GET', '/api/export/batch?dir=content/books/math&format=html');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.length > 1000, `expected >1000 bytes, got ${data.length}`);
    assertOk(data.includes('<'), 'contains HTML tags');
  });
}

// ────────────────────────────────────────────────────────────────
// 3. Reference Formatting (3 tests)
// ────────────────────────────────────────────────────────────────

async function testReferenceFormat() {
  section('Reference Formatting');

  let apaCitation = '';
  let ieeeCitation = '';

  // 4. GET /api/references/format?key=alon2016probabilistic&style=apa
  await test('GET /api/references/format APA style', async () => {
    const { status, data } = await api('GET', '/api/references/format?key=alon2016probabilistic&style=apa');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object' || typeof data === 'string', 'has response');
    const citation = typeof data === 'object' ? (data.citation || data.formatted || JSON.stringify(data)) : data;
    assertOk(citation.length > 0, 'citation is non-empty');
    apaCitation = citation;
  });

  // 5. GET /api/references/format?key=alon2016probabilistic&style=ieee
  await test('GET /api/references/format IEEE style (different from APA)', async () => {
    const { status, data } = await api('GET', '/api/references/format?key=alon2016probabilistic&style=ieee');
    assertEq(status, 200, 'status');
    const citation = typeof data === 'object' ? (data.citation || data.formatted || JSON.stringify(data)) : data;
    assertOk(citation.length > 0, 'citation is non-empty');
    ieeeCitation = citation;
    assertOk(ieeeCitation !== apaCitation, 'IEEE format differs from APA');
  });

  // 6. GET /api/references/format-all?style=mla
  await test('GET /api/references/format-all MLA style', async () => {
    const { status, data } = await api('GET', '/api/references/format-all?style=mla');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string' || typeof data === 'object', 'has response');
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    assertOk(text.length > 0, 'response is non-empty');
  });
}

// ────────────────────────────────────────────────────────────────
// 4. RSS & Atom Feeds (2 tests)
// ────────────────────────────────────────────────────────────────

async function testFeeds() {
  section('RSS & Atom Feeds');

  // 7. GET /api/feed/rss — verify XML contains <rss
  await test('GET /api/feed/rss returns XML with <rss', async () => {
    const { status, data } = await api('GET', '/api/feed/rss');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('<rss'), 'contains <rss tag');
  });

  // 8. GET /api/feed/atom — verify XML contains <feed
  await test('GET /api/feed/atom returns XML with <feed', async () => {
    const { status, data } = await api('GET', '/api/feed/atom');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('<feed'), 'contains <feed tag');
  });
}

// ────────────────────────────────────────────────────────────────
// 5. File Slides (1 test)
// ────────────────────────────────────────────────────────────────

async function testSlides() {
  section('File Slides');

  // 9. GET /api/file/slides — verify JSON with slides array
  await test('GET /api/file/slides returns slides array', async () => {
    const { status, data } = await api('GET', '/api/file/slides?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk(Array.isArray(data.slides), 'has slides array');
    assertOk(data.slides.length > 0, 'slides is non-empty');
    assertOk(typeof data.slides[0].content === 'string', 'slide has content');
  });
}

// ────────────────────────────────────────────────────────────────
// 6. Citation Graph (1 test)
// ────────────────────────────────────────────────────────────────

async function testCitationGraph() {
  section('Citation Graph');

  // 10. GET /api/references/citation-graph — verify nodes and edges
  await test('GET /api/references/citation-graph has nodes and edges', async () => {
    const { status, data } = await api('GET', '/api/references/citation-graph');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk(Array.isArray(data.nodes), 'has nodes array');
    assertOk(Array.isArray(data.edges), 'has edges array');
  });
}

// ────────────────────────────────────────────────────────────────
// 7. Daily Summary (1 test)
// ────────────────────────────────────────────────────────────────

async function testDailySummary() {
  section('Daily Summary');

  // 11. GET /api/summary/daily — verify daily summary fields
  await test('GET /api/summary/daily returns daily summary', async () => {
    const { status, data } = await api('GET', '/api/summary/daily');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('date' in data, 'has date field');
    assertOk('filesModifiedToday' in data, 'has filesModifiedToday field');
    assertOk(typeof data.filesModifiedToday === 'number', 'filesModifiedToday is a number');
  });
}

// ────────────────────────────────────────────────────────────────
// 8. Mindmap (1 test)
// ────────────────────────────────────────────────────────────────

async function testMindmap() {
  section('Mindmap');

  // 12. GET /api/file/mindmap — verify {root} tree
  await test('GET /api/file/mindmap returns {root} tree', async () => {
    const { status, data } = await api('GET', '/api/file/mindmap?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('root' in data, 'has root field');
    assertOk(typeof data.root === 'object', 'root is an object');
  });
}

// ────────────────────────────────────────────────────────────────
// 9. File Quality (2 tests)
// ────────────────────────────────────────────────────────────────

async function testFileQuality() {
  section('File Quality');

  // 13. GET /api/file/quality — verify score, breakdown, suggestions
  await test('GET /api/file/quality returns score, breakdown, suggestions', async () => {
    const { status, data } = await api('GET', '/api/file/quality?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('score' in data, 'has score field');
    assertOk(typeof data.score === 'number', 'score is a number');
    assertOk(data.score >= 0 && data.score <= 100, `score in 0–100 range, got ${data.score}`);
    assertOk('breakdown' in data, 'has breakdown field');
    assertOk(typeof data.breakdown === 'object', 'breakdown is an object');
    assertOk('suggestions' in data, 'has suggestions field');
    assertOk(Array.isArray(data.suggestions), 'suggestions is an array');
  });

  // 14. GET /api/file/quality-score — verify score only
  await test('GET /api/file/quality-score returns score', async () => {
    const { status, data } = await api('GET', '/api/file/quality-score?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('score' in data, 'has score field');
    assertOk(typeof data.score === 'number', 'score is a number');
  });
}

// ────────────────────────────────────────────────────────────────
// 10. Quicknotes (2 tests)
// ────────────────────────────────────────────────────────────────

async function testQuicknotes() {
  section('Quicknotes');

  // 15. POST /api/quicknote — verify success + path
  await test('POST /api/quicknote creates a note', async () => {
    const { status, data } = await api('POST', '/api/quicknote', { text: 'test note' });
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk(data.success === true || data.ok === true, 'reports success');
    assertOk('path' in data, 'has path field');
    assertOk(typeof data.path === 'string' && data.path.length > 0, 'path is non-empty string');
  });

  // 16. GET /api/quicknotes — verify list
  await test('GET /api/quicknotes returns a list', async () => {
    const { status, data } = await api('GET', '/api/quicknotes');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data), 'response is an array');
    assertOk(data.length > 0, 'list is non-empty (at least the note we just created)');
  });
}

// ────────────────────────────────────────────────────────────────
// 11. Suggestions (1 test)
// ────────────────────────────────────────────────────────────────

async function testSuggestions() {
  section('Suggestions');

  // 17. GET /api/suggest — verify references and pages arrays
  await test('GET /api/suggest returns references and pages', async () => {
    const { status, data } = await api('GET', '/api/suggest?text=machine+learning');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('references' in data, 'has references field');
    assertOk(Array.isArray(data.references), 'references is an array');
    assertOk('pages' in data, 'has pages field');
    assertOk(Array.isArray(data.pages), 'pages is an array');
  });
}

// ────────────────────────────────────────────────────────────────
// 12. Debug Routes (1 test)
// ────────────────────────────────────────────────────────────────

async function testDebugRoutes() {
  section('Debug Routes');

  // 18. GET /api/debug/routes — verify handler counts
  await test('GET /api/debug/routes returns handler counts', async () => {
    const { status, data } = await api('GET', '/api/debug/routes');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    const keys = Object.keys(data);
    assertOk(keys.length > 0, 'has at least one route group');
    // Each value should be a number (count) or an array of route descriptors
    for (const key of keys) {
      const val = data[key];
      assertOk(typeof val === 'number' || Array.isArray(val), `${key} is a number or array`);
    }
  });
}

// ────────────────────────────────────────────────────────────────
// 13. Perf Endpoint (1 test)
// ────────────────────────────────────────────────────────────────

async function testPerf() {
  section('Perf Endpoint');

  // 19. GET /api/perf — verify {endpoints: [...]}
  await test('GET /api/perf returns endpoints array', async () => {
    const { status, data } = await api('GET', '/api/perf');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('endpoints' in data, 'has endpoints field');
    assertOk(Array.isArray(data.endpoints), 'endpoints is an array');
  });
}

// ────────────────────────────────────────────────────────────────
// 14. Calendar Endpoint (1 test)
// ────────────────────────────────────────────────────────────────

async function testCalendar() {
  section('Calendar Endpoint');

  // 20. GET /api/calendar — verify {months: [...]}
  await test('GET /api/calendar returns months array', async () => {
    const { status, data } = await api('GET', '/api/calendar');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('months' in data, 'has months field');
    assertOk(Array.isArray(data.months), 'months is an array');
  });
}

// ────────────────────────────────────────────────────────────────
// 15. Integrity Endpoint (1 test)
// ────────────────────────────────────────────────────────────────

async function testIntegrity() {
  section('Integrity Endpoint');

  // 21. GET /api/integrity — verify {status: "healthy"}
  await test('GET /api/integrity returns healthy status', async () => {
    const { status, data } = await api('GET', '/api/integrity');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('status' in data, 'has status field');
    assertEq(data.status, 'healthy', 'status is healthy');
  });
}

// ────────────────────────────────────────────────────────────────
// 16. File Target (2 tests)
// ────────────────────────────────────────────────────────────────

async function testFileTarget() {
  section('File Target');

  // 22. POST /api/file/target — set word target
  await test('POST /api/file/target sets word target', async () => {
    const { status, data } = await api('POST', '/api/file/target', {
      path: 'content/books/math/0-intro.md',
      targetWords: 1000
    });
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  // 23. GET /api/file/target — verify target + progress
  await test('GET /api/file/target returns target and progress', async () => {
    const { status, data } = await api('GET', '/api/file/target?path=content/books/math/0-intro.md');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('target' in data || 'targetWords' in data, 'has target field');
    assertOk('progress' in data || 'currentWords' in data || 'wordCount' in data, 'has progress field');
  });
}

// ────────────────────────────────────────────────────────────────
// 17. Dashboard (1 test)
// ────────────────────────────────────────────────────────────────

async function testDashboard() {
  section('Dashboard');

  // 24. GET /api/dashboard — verify {server, content, activity, endpoints, health}
  await test('GET /api/dashboard returns server, content, activity, endpoints, health', async () => {
    const { status, data } = await api('GET', '/api/dashboard');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'object', 'response is object');
    assertOk('server' in data, 'has server field');
    assertOk('content' in data, 'has content field');
    assertOk('activity' in data, 'has activity field');
    assertOk('endpoints' in data, 'has endpoints field');
    assertOk('health' in data, 'has health field');
  });
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}Mochi Lab Extra Endpoint Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}\n`);

  await preflight();

  await testBackup();
  await testBatchExport();
  await testReferenceFormat();
  await testFeeds();
  await testSlides();
  await testCitationGraph();
  await testDailySummary();
  await testMindmap();
  await testFileQuality();
  await testQuicknotes();
  await testSuggestions();
  await testDebugRoutes();
  await testPerf();
  await testCalendar();
  await testIntegrity();
  await testFileTarget();
  await testDashboard();

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
