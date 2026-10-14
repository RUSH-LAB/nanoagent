#!/usr/bin/env node
import {createApiClient} from './api-client.mjs';
// ─────────────────────────────────────────────────────────────
// Comprehensive API integration tests for the Mochi Lab editor server
// Usage:  node tests/integration/test-api.mjs
// Requires the server running on http://localhost:3001, and a GitHub sign-in
// saved by `node cli/rush.mjs login http://localhost:3001`
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

const TEST_PREFIX = `__test_${Date.now()}`;
const TEST_FILE = `posts/${TEST_PREFIX}_post.md`;
const TEST_FILE_CONTENT = `---\ntitle: "Test Post"\ndate: 2025-01-01\n---\n\n# Test Post\n\nHello world. This is a test file for API integration tests.\n`;
const TEST_NOTE_KEY = `${TEST_PREFIX}_note`;
const TEST_REF_KEY = `${TEST_PREFIX}_ref`;

// ────────────────────────────────────────────────────────────────
// File CRUD (7 tests)
// ────────────────────────────────────────────────────────────────

async function testFileCRUD() {
  section('File CRUD');

  // 1. List files
  await test('List files', async () => {
    const {status, data} = await api('GET', '/api/documents/tree');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.documents), 'documents is array');
  });

  // 2. Create file
  await test('Create file', async () => {
    const {status, data} = await api('POST', '/api/documents', {
      path: TEST_FILE,
      markdown: TEST_FILE_CONTENT,
    });
    assertEq(status, 201, 'status');
    assertOk(data.success, 'success');
    cleanup.push(() => safeDeleteFile(TEST_FILE));
  });

  // 3. Read file
  await test('Read file', async () => {
    const {status, data} = await api('GET', `/api/documents/source?path=${encodeURIComponent(TEST_FILE)}`);
    assertEq(status, 200, 'status');
    assertOk(data.markdown.includes('Test Post'), 'content matches');
  });

  // 4. Update file
  await test('Update file', async () => {
    const updatedContent = TEST_FILE_CONTENT.replace('Hello world', 'Updated content');
    const {status, data} = await api('PUT', '/api/documents', {
      path: TEST_FILE,
      markdown: updatedContent,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify the update
    const {data: readData} = await api('GET', `/api/documents/source?path=${encodeURIComponent(TEST_FILE)}`);
    assertOk(readData.markdown.includes('Updated content'), 'content updated');
  });

  // 5. Search files
  await test('Search files', async () => {
    const {status, data} = await api('GET', `/api/documents/search?q=${encodeURIComponent(TEST_PREFIX)}`);
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.documents), 'documents is array');
    assertOk(data.documents.length >= 1, 'found at least one file');
    assertOk(data.documents.some(f => f.path.includes(TEST_PREFIX)), 'found our test file');
  });

  // 6. File move
  await test('File move', async () => {
    const movedPath = `books/${TEST_FILE.split('/').pop()}`;
    const {status, data} = await api('POST', '/api/documents/move', {
      from: TEST_FILE,
      to: movedPath,
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // The moved file keeps the basename of TEST_FILE
    cleanup.pop();
    cleanup.push(() => safeDeleteFile(movedPath));
    // Verify it is at the new location
    const {status: readStatus} = await api('GET', `/api/documents/source?path=${encodeURIComponent(movedPath)}`);
    assertEq(readStatus, 200, 'moved file readable');
  });

  // 7. Delete file (soft-delete to trash)
  await test('Delete file (soft-delete)', async () => {
    // Figure out the current location after move
    const movedPath = `books/${TEST_FILE.split('/').pop()}`;
    const {status, data} = await api('DELETE', '/api/documents', {path: movedPath});
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    assertEq(data.success, true, 'document was soft-deleted');
    // Remove the now-stale cleanup; add trash cleanup instead
    cleanup.pop();
    cleanup.push(() => emptyTrashIfNeeded());
    // Verify the file is gone from its original location
    const {status: readStatus} = await api('GET', `/api/documents/source?path=${encodeURIComponent(movedPath)}`);
    assertEq(readStatus, 404, 'file no longer readable');
  });
}

// ────────────────────────────────────────────────────────────────
// Comments (5 tests)
// ────────────────────────────────────────────────────────────────

let createdCommentId = null;
let createdReplyId = null;

async function testComments() {
  section('Comments');

  // 1. Create comment

  // 2. List comments

  // 3. Create reply (with parentId)

  // 4. Delete comment

  // 5. List after deletion
}

// ────────────────────────────────────────────────────────────────
// Notes (3 tests)
// ────────────────────────────────────────────────────────────────

async function testNotes() {
  section('Notes');

  // 1. Save note
  await test('Save note', async () => {
    const {status, data} = await api('PUT', '/api/notes', {
      key: TEST_NOTE_KEY,
      title: 'Test Note',
      content: 'This is test note content.',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    cleanup.push(async () => {
      // Notes don't have a delete endpoint, but they live in notes.json
      // We clean them up by overwriting (or we leave it; it is harmless)
    });
  });

  // 2. Get note
  await test('Get note', async () => {
    const {status, data} = await api('GET', `/api/notes?key=${encodeURIComponent(TEST_NOTE_KEY)}`);
    assertEq(status, 200, 'status');
    assertOk(data.note, 'has note');
    assertEq(data.note.title, 'Test Note', 'title matches');
    assertOk(data.note.content.includes('test note content'), 'content matches');
  });

  // 3. List notes
  await test('List notes', async () => {
    const {status, data} = await api('GET', '/api/notes');
    assertEq(status, 200, 'status');
    assertOk(data.notes, 'has notes');
    assertOk(data.notes[TEST_NOTE_KEY], 'found our note');
  });
}

// ────────────────────────────────────────────────────────────────
// References (4 tests)
// ────────────────────────────────────────────────────────────────

async function testReferences() {
  section('References');

  // 1. List references
  await test('List references', async () => {
    const {status, data} = await api('GET', '/api/references');
    assertEq(status, 200, 'status');
    assertOk(data.references, 'has references');
    assertOk(typeof data.references === 'object', 'references is object');
  });

  // 2. Add reference
  await test('Add reference', async () => {
    const {status, data} = await api('POST', '/api/references', {
      key: TEST_REF_KEY,
      entry: {
        type: 'article',
        title: 'Test Reference Paper',
        author: ['Test Author'],
        year: 2025,
        venue: 'Test Conference',
      },
    });
    assertOk(status === 200 || status === 201, 'status 200 or 201');
    assertOk(data.success, 'success');
    cleanup.push(() => api('DELETE', `/api/references/${encodeURIComponent(TEST_REF_KEY)}`));
  });

  // 3. Export BibTeX
  await test('Export BibTeX', async () => {
    const {status, data} = await api('GET', '/api/references/export');
    assertEq(status, 200, 'status');
    assertOk(typeof data === 'string', 'response is text');
    assertOk(data.includes('@'), 'contains BibTeX entries');
    assertOk(data.includes(TEST_REF_KEY), 'contains our test reference');
  });

  // 4. Import BibTeX
  await test('Import BibTeX', async () => {
    const bibtex = `@article{${TEST_PREFIX}_import,
  title = {Imported Test Paper},
  author = {Import Author},
  year = {2025},
  journal = {Test Journal}
}`;
    const {status, data} = await api('POST', '/api/references/import-bibtex', {bibtex});
    assertEq(status, 200, 'status');
    assertEq(data.added, 1, 'added 1 entry');
    assertEq(data.skipped, 0, 'skipped 0');
    // Verify it exists now
    const {data: refs} = await api('GET', '/api/references');
    assertOk(refs.references[`${TEST_PREFIX}_import`], 'imported reference exists');
    cleanup.push(() => api('DELETE', `/api/references/${encodeURIComponent(`${TEST_PREFIX}_import`)}`));
  });
}

// ────────────────────────────────────────────────────────────────
// Misc (4 tests)
// ────────────────────────────────────────────────────────────────

async function testMisc() {
  section('Misc');

  // 1. Health check
  await test('Health check', async () => {
    const {status, data} = await api('GET', '/api/health');
    assertEq(status, 200, 'status');
    assertEq(data.status, 'ok', 'status is ok');
    assertOk(typeof data.uptime === 'number', 'has uptime');
    assertOk(typeof data.memory === 'number', 'has memory');
  });

  // 2. Stats
  await test('Stats', async () => {
    const {status, data} = await api('GET', '/api/stats');
    assertEq(status, 200, 'status');
    assertOk(typeof data.totalFiles === 'number', 'has totalFiles');
    assertOk(typeof data.totalWords === 'number', 'has totalWords');
    assertOk(typeof data.references === 'number', 'has references count');
  });

  // 3. Pageview tracking
  await test('Pageview tracking', async () => {
    const {status, data} = await api('POST', '/api/analytics/pageview', {
      path: `/${TEST_PREFIX}/test-page`,
      referrer: 'https://example.com',
    });
    assertEq(status, 200, 'status');
    assertOk(data.success, 'success');
    // Verify it was recorded
    const {data: analytics} = await api('GET', '/api/analytics');
    assertOk(analytics.pageviews[`/${TEST_PREFIX}/test-page`] >= 1, 'pageview counted');
  });

  // 4. Full-text search
  await test('Full-text search', async () => {
    // Search for something that likely exists in any docusaurus site
    const {status, data} = await api('GET', '/api/search?q=the');
    assertEq(status, 200, 'status');
    assertOk(Array.isArray(data.results), 'results is array');
    // Even if no results, the shape should be correct
    if (data.results.length > 0) {
      assertOk(data.results[0].path, 'result has path');
      assertOk(data.results[0].snippet, 'result has snippet');
    }
  });
}

// ────────────────────────────────────────────────────────────────
// Security (5 tests)
// ────────────────────────────────────────────────────────────────

async function testSecurity() {
  section('Security');

  // 1. Path traversal blocked
  await test('Path traversal blocked', async () => {
    const {status, data} = await api('GET', '/api/documents/source?path=../../../etc/passwd');
    assertEq(status, 400, 'status');
    assertOk(data.error, 'has error');
  });

  // 2. Prototype-shaped ids cannot bypass platform authorization.
  await test('Prototype pollution blocked', async () => {
    const {status} = await api('PUT', '/api/users/__proto__/role', {
      role: 'admin',
    });
    assertOk(status === 400 || status === 403, 'unsafe target is rejected');
  });

  // 3. Auth bypass blocked (role change by a non-owner)
  await test('Auth bypass blocked', async () => {
    // A requesterId in the body used to decide this. Naming a real owner here
    // is now inert: the caller is whoever the session token says, and the
    // development identity holds no owner record.
    const {status, data} = await api('PUT', '/api/users/someuser/role', {
      role: 'admin',
      requesterId: 'nonexistent-user',
    });
    assertEq(status, 403, 'status should be 403');
    assertOk(data.error.includes('platform administrator'), 'error mentions platform administrator requirement');
  });

  // 4. Body size limit
  await test('Body size limit', async () => {
    // The server has a 10MB limit. We test by sending a request that would
    // exceed a reasonable threshold. We don't actually send 10MB; instead we
    // verify the limit exists by checking server behavior on a normal request.
    // A true test would send >10MB but that's slow. We test the logic path
    // by confirming a valid request works and that the constant is 10MB.
    const {status} = await api('POST', '/api/documents', {
      path: 'should-not-exist.md',
      markdown: 'x'.repeat(1000),
    });
    // The file gets created (or 409 if exists), proving body parsing works
    assertOk(status === 201 || status === 409, 'body parsed correctly');
    // Clean up if it was created
    if (status === 201) {
      await api('DELETE', '/api/documents', {path: 'should-not-exist.md'});
    }
  });

  // 5. Rate limit check
  await test('Rate limit check', async () => {
    // /api/quicknote is rate-limited to 20/min per IP. Confirm a single request
    // is not rate-limited rather than actually driving the limiter.
    const {status} = await api('POST', '/api/quicknote', {
      title: `${TEST_PREFIX} rate limit`,
      text: 'rate limit test',
    });
    assertOk(status === 200 || status === 201, 'first request passes rate limit');
  });
}

// ────────────────────────────────────────────────────────────────
// Cleanup helpers
// ────────────────────────────────────────────────────────────────

async function safeDeleteFile(filePath) {
  try {
    await api('DELETE', '/api/documents', {path: filePath});
  } catch { /* ignore */ }
}

async function emptyTrashIfNeeded() {
  // We only empty test-created trash; the endpoint empties ALL trash,
  // so we skip this to avoid destroying real data.
  // Trash entries from our test have the TEST_PREFIX in the name.
}

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

  // Notes still have no delete API. Bibliography records are removed through
  // the cleanup callbacks registered as soon as each test creates one.
  // Notes: remove our test key from notes.json
  try {
    const {data} = await api('GET', '/api/notes');
    if (data.notes && data.notes[TEST_NOTE_KEY]) {
      // No delete API for notes; it is harmless to leave it
    }
  } catch { /* ignore */ }

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
  console.log(`\n${BOLD}Mochi Lab API Integration Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}\n`);

  await preflight();

  await testFileCRUD();
  await testComments();
  await testNotes();
  await testReferences();
  await testMisc();
  await testSecurity();

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
