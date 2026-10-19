#!/usr/bin/env node
import {createApiClient} from './api-client.mjs';
// ─────────────────────────────────────────────────────────────
// Stress & resilience tests for the RUSH Lab editor server
// Usage:  node tests/integration/test-resilience.mjs
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

// ── Connectivity check ──
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

// ── Test identifiers ──
const TEST_PREFIX = `__resilience_${Date.now()}`;
const TEST_FILE = `content/posts/${TEST_PREFIX}_stress.md`;
const TEST_FILE_CONTENT = `---\ntitle: "Resilience Test"\ndate: 2025-01-01\n---\n\nOriginal content for resilience testing.\n`;
const TEST_STRESS_KEY = `${TEST_PREFIX}/stress`;

// ────────────────────────────────────────────────────────────────
// 1. Concurrent writes to same file: 5 parallel PUT requests
// ────────────────────────────────────────────────────────────────
async function testConcurrentWrites() {
  section('1. Concurrent writes to same file');

  await test('5 parallel PUT requests to same file', async () => {
    // Create the file first
    const {status: createStatus} = await api('POST', '/api/documents', {
      path: TEST_FILE,
      markdown: TEST_FILE_CONTENT,
    });
    assertEq(createStatus, 201, 'create status');
    cleanup.push(() => api('DELETE', '/api/documents', {path: TEST_FILE}));

    // Fire 5 parallel writes
    const writes = Array.from({length: 5}, (_, i) =>
      api('PUT', '/api/documents', {
        path: TEST_FILE,
        markdown: `---\ntitle: "Resilience Test"\n---\n\nWrite number ${i}\n`,
      })
    );
    const results = await Promise.all(writes);

    // All should succeed (status 200): no crashes, no corruption
    const successes = results.filter(r => r.status === 200).length;
    assertOk(successes >= 1, `at least 1 write succeeded (got ${successes}/5)`);

    // Verify file is still readable and contains one coherent version
    const {status: readStatus, data: readData} = await api('GET', `/api/documents/source?path=${encodeURIComponent(TEST_FILE)}`);
    assertEq(readStatus, 200, 'file still readable after concurrent writes');
    assertOk(readData.markdown.includes('Write number'), 'content is coherent');
  });
}

// ────────────────────────────────────────────────────────────────
// 4. Unicode stress: quick notes with every Unicode block
// ────────────────────────────────────────────────────────────────
async function testUnicodeStress() {
  section('4. Unicode stress');

  await test('Quick notes with emoji, CJK, Arabic, Cyrillic, etc.', async () => {
    const page = `${TEST_STRESS_KEY}/unicode`;
    const unicodeText = [
      // Emoji
      '\u{1F600}\u{1F680}\u{1F4A9}\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}',
      // CJK
      '你好世界，こんにちは世界，안녕하세요 세계',
      // Arabic
      'مرحبا بالعالم',
      // Cyrillic
      'Привет мир',
      // Devanagari
      'नमस्ते दुनिये',
      // Thai
      'สวัสดีชาวโลก',
      // Math symbols
      '∀x ∈ ℝ: x² ≥ 0, ∫₁ⁿ f(x)dx ≠ ∞',
      // Zero-width joiners and combining marks
      'àéîõü‌‍﻿',
    ].join(' | ');

    const {status, data} = await api('POST', '/api/quicknote', {
      title: page,
      text: unicodeText,
    });
    assertOk(status === 200 || status === 201, 'status');
    assertOk(data.success, 'note was written');
    assertOk(data.filename || data.path, 'reply names the file it wrote');
  });
}

// ────────────────────────────────────────────────────────────────
// 5. Empty strings: POST endpoints with empty required fields
// ────────────────────────────────────────────────────────────────
async function testEmptyStrings() {
  section('5. Empty strings');

}

// ────────────────────────────────────────────────────────────────
// 6. Null values: POST with null in required fields
// ────────────────────────────────────────────────────────────────
async function testNullValues() {
  section('6. Null values');

}

// ────────────────────────────────────────────────────────────────
// 7. Very long paths: GET /api/documents/source?path=content/a/b/c/d/e/f/g.md
// ────────────────────────────────────────────────────────────────
async function testLongPaths() {
  section('7. Very long paths');

  await test('GET document source with deeply nested path', async () => {
    const longPath = 'content/a/b/c/d/e/f/g.md';
    const {status} = await api('GET', `/api/documents/source?path=${encodeURIComponent(longPath)}`);
    // Should return 404 (file does not exist) but NOT crash
    assertOk(status === 404 || status === 400, `expected 404 or 400, got ${status}`);

    // Also test an absurdly long path
    const absurdPath = 'content/' + Array.from({length: 50}, (_, i) => `dir${i}`).join('/') + '/file.md';
    const {status: s2} = await api('GET', `/api/documents/source?path=${encodeURIComponent(absurdPath)}`);
    assertOk(s2 === 404 || s2 === 400, `absurdly deep path: expected 404 or 400, got ${s2}`);

    // Server should still be alive
    const {status: healthStatus} = await api('GET', '/api/health');
    assertEq(healthStatus, 200, 'server alive after long path requests');
  });
}

// ────────────────────────────────────────────────────────────────
// 8. Special characters in query: GET /api/search?q=%00%01%02
// ────────────────────────────────────────────────────────────────
async function testSpecialCharsInQuery() {
  section('8. Special characters in query');

  await test('GET /api/search with null bytes and control chars', async () => {
    const specialQ = '\x00\x01\x02\x03\x1F';
    const {status} = await api('GET', `/api/search?q=${encodeURIComponent(specialQ)}`);
    // Should either return results (empty) or 400: not crash
    assertOk(status === 200 || status === 400, `expected 200 or 400, got ${status}`);

    // Test with SQL-injection-like strings
    const sqlQ = "'; DROP TABLE comments; --";
    const {status: s2} = await api('GET', `/api/search?q=${encodeURIComponent(sqlQ)}`);
    assertOk(s2 === 200 || s2 === 400, `SQL-like query: expected 200 or 400, got ${s2}`);

    // Test with regex-breaking characters
    const regexQ = '(((((((';
    const {status: s3} = await api('GET', `/api/search?q=${encodeURIComponent(regexQ)}`);
    assertOk(s3 === 200 || s3 === 400, `regex-breaking query: expected 200 or 400, got ${s3}`);

    // Server alive
    const {status: healthStatus} = await api('GET', '/api/health');
    assertEq(healthStatus, 200, 'server alive after special char queries');
  });
}

// ────────────────────────────────────────────────────────────────
// 9. Concurrent reads during write: read and write same file simultaneously
// ────────────────────────────────────────────────────────────────
async function testConcurrentReadWrite() {
  section('9. Concurrent reads during write');

  await test('Simultaneous reads and writes to same file', async () => {
    // Ensure the test file exists
    const {status: checkStatus} = await api('GET', `/api/documents/source?path=${encodeURIComponent(TEST_FILE)}`);
    if (checkStatus === 404) {
      await api('POST', '/api/documents', {path: TEST_FILE, markdown: TEST_FILE_CONTENT});
    }

    // Fire 3 writes and 5 reads simultaneously
    const ops = [
      ...Array.from({length: 3}, (_, i) =>
        api('PUT', '/api/documents', {
          path: TEST_FILE,
          markdown: `---\ntitle: "Resilience Test"\n---\n\nConcurrent write ${i}\n`,
        }).then(r => ({type: 'write', status: r.status}))
      ),
      ...Array.from({length: 5}, () =>
        api('GET', `/api/documents/source?path=${encodeURIComponent(TEST_FILE)}`)
          .then(r => ({type: 'read', status: r.status}))
      ),
    ];

    const results = await Promise.all(ops);

    const reads = results.filter(r => r.type === 'read');
    const writes = results.filter(r => r.type === 'write');

    // All reads should succeed
    const readOk = reads.every(r => r.status === 200);
    assertOk(readOk, `all reads returned 200 (got: ${reads.map(r => r.status).join(',')})`);

    // At least some writes should succeed
    const writeOk = writes.filter(r => r.status === 200).length;
    assertOk(writeOk >= 1, `at least 1 write succeeded (${writeOk}/3)`);
  });
}

// ────────────────────────────────────────────────────────────────
// 10. Rate limit test: fire 100 requests, count 429s
// ────────────────────────────────────────────────────────────────
async function testRateLimit() {
  section('10. Rate limit test');

  await test('Fire 100 requests to rate-limited endpoint, count 429s', async () => {
    // The quicknote POST endpoint has a rate limit of 20/min per IP.
    // Some requests from earlier tests may have already consumed part of the budget.
    // We fire 100 requests and expect a mix of 200s and 429s.
    const page = `${TEST_STRESS_KEY}/ratelimit`;
    const requests = Array.from({length: 100}, (_, i) =>
      api('POST', '/api/quicknote', {
        title: page,
        text: `Rate limit test ${i}`,
      }).then(r => r.status)
    );

    const statuses = await Promise.all(requests);
    const ok = statuses.filter(s => s === 200).length;
    const limited = statuses.filter(s => s === 429).length;
    const other = statuses.filter(s => s !== 200 && s !== 429).length;

    log(' ', DIM, `  ${ok} accepted, ${limited} rate-limited, ${other} other`);

    // We expect some to be rate-limited (30/min limit, 100 requests)
    assertOk(limited > 0, `expected some 429s from 100 requests (got ${limited})`);
    assertOk(other === 0, `no unexpected status codes (got ${other})`);

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
// Main
// ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}RUSH Lab Stress & Resilience Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}\n`);

  await preflight();

  await testConcurrentWrites();
  await testUnicodeStress();
  await testEmptyStrings();
  await testNullValues();
  await testLongPaths();
  await testSpecialCharsInQuery();
  await testConcurrentReadWrite();
  await testRateLimit();

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
