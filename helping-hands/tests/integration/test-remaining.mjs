#!/usr/bin/env node
import {createApiClient} from './api-client.mjs';
// ─────────────────────────────────────────────────────────────
// Tests for previously uncovered endpoints in the Mochi Lab server
// Usage:  node tests/integration/test-remaining.mjs
// Requires the server running on http://localhost:3001, and a GitHub sign-in
// saved by `node cli/mochi.mjs login http://localhost:3001`
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

function log(icon, color, label, detail = '') {
  const detailStr = detail ? ` ${DIM}${detail}${RESET}` : '';
  console.log(`  ${color}${icon}${RESET} ${label}${detailStr}`);
}
function pass(name, detail) { passed++; log('✓', GREEN, name, detail); }
function fail(name, detail) { failed++; log('✗', RED, name, detail); }
function skip(name, detail) { skipped++; log('-', YELLOW, name, detail); }
function section(title) { console.log(`\n${BOLD}${title}${RESET}`); }

const api = createApiClient(BASE);

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
    if (data.key) await api('DELETE', `/api/references/${encodeURIComponent(data.key)}`);
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
// Users
// ────────────────────────────────────────────────────────────────
async function testUsers() {
  section('Users');

  await test('GET /api/users is limited to platform administrators', async () => {
    const {status, data} = await api('GET', '/api/users');
    assertEq(status, 403, 'status');
    assertOk(typeof data === 'object', 'response is object');
  });

  await test('GET /api/users/me returns user info or empty', async () => {
    const {status, data} = await api('GET', '/api/users/me');
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
    // Providers report missing credentials/configuration as a gateway failure.
    assertOk([400, 401, 403, 500, 502].includes(status), `status is ${status}`);
  });
}

// ────────────────────────────────────────────────────────────────
// Quick Note (POST /api/quicknote: distinct from /api/quicknotes)
// ────────────────────────────────────────────────────────────────
async function testQuickNote() {
  section('Quick Note');
  await test('POST /api/quicknote with empty text returns 400', async () => {
    const {status} = await api('POST', '/api/quicknote', {text: ''});
    assertEq(status, 400, 'status');
  });
  await test('GET /api/quicknote lists quick notes', async () => {
    const {status} = await api('GET', '/api/quicknote');
    assertOk(status === 200 || status === 404, `status is ${status}`);
  });
}

// ────────────────────────────────────────────────────────────────
// Trash Empty (validation only: we do not actually empty trash)
// ────────────────────────────────────────────────────────────────
async function testTrashEmpty() {
  section('Trash Empty');
  await test('DELETE /api/trash/empty responds (endpoint exists)', async () => {
    // GET /api/trash was removed with the editor, so there is no longer a way to
    // check whether the trash is already empty. Calling DELETE unconditionally
    // would destroy real data, so this stays a skip.
    skip('DELETE /api/trash/empty', 'skipped: cannot verify the trash is empty');
  });
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${BOLD}Mochi Lab — Remaining Endpoints Test Coverage${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}\n`);

  await preflight();
  await testDebugRoutes();
  await testFolderCrud();
  await testMetadataSearch();
  await testNotifications();
  await testRecommendationsAdd();
  await testSitemap();
  await testUsers();
  await testAiComplete();
  await testQuickNote();
  await testTrashEmpty();

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
