#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Stress & resilience tests for the Mochi Lab editor server
// Usage:  node scripts/tests/test-resilience.mjs
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
    console.error(`  Start it with:  node server.js`);
    process.exit(1);
  }
}

// ── Test identifiers ──
const TEST_PREFIX = `__resilience_${Date.now()}`;
const TEST_FILE = `content/posts/${TEST_PREFIX}_stress.md`;
const TEST_FILE_CONTENT = `---\ntitle: "Resilience Test"\ndate: 2025-01-01\n---\n\nOriginal content for resilience testing.\n`;
const TEST_COMMENT_PAGE = `${TEST_PREFIX}/stress`;

// ────────────────────────────────────────────────────────────────
// 1. Concurrent writes to same file: 5 parallel PUT requests
// ────────────────────────────────────────────────────────────────
async function testConcurrentWrites() {
  section('1. Concurrent writes to same file');

  await test('5 parallel PUT requests to same file', async () => {
    // Create the file first
    const {status: createStatus} = await api('POST', '/api/file', {
      path: TEST_FILE,
      content: TEST_FILE_CONTENT,
    });
    assertEq(createStatus, 200, 'create status');
    cleanup.push(() => api('DELETE', `/api/file?path=${encodeURIComponent(TEST_FILE)}`));

    // Fire 5 parallel writes
    const writes = Array.from({length: 5}, (_, i) =>
      api('PUT', '/api/file', {
        path: TEST_FILE,
        content: `---\ntitle: "Resilience Test"\n---\n\nWrite number ${i}\n`,
      })
    );
    const results = await Promise.all(writes);

    // All should succeed (status 200): no crashes, no corruption
    const successes = results.filter(r => r.status === 200).length;
    assertOk(successes >= 1, `at least 1 write succeeded (got ${successes}/5)`);

    // Verify file is still readable and contains one coherent version
    const {status: readStatus, data: readData} = await api('GET', `/api/file?path=${encodeURIComponent(TEST_FILE)}`);
    assertEq(readStatus, 200, 'file still readable after concurrent writes');
    assertOk(readData.content.includes('Write number'), 'content is coherent');
  });
}

// ────────────────────────────────────────────────────────────────
// 2. Rapid-fire comments: 20 POST /api/comments in quick succession
// ────────────────────────────────────────────────────────────────
async function testRapidComments() {
  section('2. Rapid-fire comments');

  await test('20 rapid POST /api/comments', async () => {
    const page = `${TEST_COMMENT_PAGE}/rapid`;
    const requests = Array.from({length: 20}, (_, i) =>
      api('POST', '/api/comments', {
        page,
        author: `Bot ${i}`,
        text: `Rapid comment ${i}`,
      })
    );
    const results = await Promise.all(requests);

    const ok = results.filter(r => r.status === 200).length;
    const rateLimited = results.filter(r => r.status === 429).length;

    // Server should not crash: either accept or rate-limit
    assertOk(ok + rateLimited === 20, `all 20 got valid responses (${ok} ok, ${rateLimited} rate-limited)`);
    assertOk(ok >= 1, 'at least 1 comment accepted');

    // Cleanup
    cleanup.push(async () => {
      const {data} = await api('GET', `/api/comments?page=${encodeURIComponent(page)}&limit=100`);
      for (const c of (data.comments || [])) {
        await api('DELETE', '/api/comments', {page, commentId: c.id});
      }
    });
  });
}

// ────────────────────────────────────────────────────────────────
// 3. Large payload: POST /api/comments with 9MB text
// ────────────────────────────────────────────────────────────────
async function testLargePayload() {
  section('3. Large payload');

  await test('POST /api/comments with 9MB text (under 10MB limit)', async () => {
    const page = `${TEST_COMMENT_PAGE}/large`;
    const bigText = 'x'.repeat(9 * 1024 * 1024); // 9MB
    const {status} = await api('POST', '/api/comments', {
      page,
      author: 'Big Sender',
      text: bigText,
    });
    // Should succeed (under 10MB limit) or at least not crash the server
    // Note: the text may be truncated by sanitizeText (MAX_TEXT_LENGTH = 10000)
    assertOk(status === 200 || status === 413, `expected 200 or 413, got ${status}`);

    // Verify server is still alive
    const {status: healthStatus} = await api('GET', '/api/health');
    assertEq(healthStatus, 200, 'server still alive after large payload');

    // Cleanup
    cleanup.push(async () => {
      const {data} = await api('GET', `/api/comments?page=${encodeURIComponent(page)}&limit=100`);
      for (const c of (data.comments || [])) {
        await api('DELETE', '/api/comments', {page, commentId: c.id});
      }
    });
  });
}

// ────────────────────────────────────────────────────────────────
// 4. Unicode stress: comments with every Unicode block
// ────────────────────────────────────────────────────────────────
async function testUnicodeStress() {
  section('4. Unicode stress');

  await test('Comments with emoji, CJK, Arabic, Cyrillic, etc.', async () => {
    const page = `${TEST_COMMENT_PAGE}/unicode`;
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
      'àéîõü​‌‍﻿',
    ].join(' | ');

    const {status, data} = await api('POST', '/api/comments', {
      page,
      author: '\u{1F600} Тест テスト',
      text: unicodeText,
    });
    assertEq(status, 200, 'status');
    assertOk(data.comment, 'has comment');
    assertOk(data.comment.text.length > 0, 'text is non-empty');

    // Read it back
    const {data: listData} = await api('GET', `/api/comments?page=${encodeURIComponent(page)}`);
    const found = listData.comments.find(c => c.id === data.comment.id);
    assertOk(found, 'comment persisted');
    assertOk(found.text.length > 0, 'stored text is non-empty');

    // Cleanup
    cleanup.push(async () => {
      const {data: d} = await api('GET', `/api/comments?page=${encodeURIComponent(page)}&limit=100`);
      for (const c of (d.comments || [])) {
        await api('DELETE', '/api/comments', {page, commentId: c.id});
      }
    });
  });
}

// ────────────────────────────────────────────────────────────────
// 5. Empty strings: POST endpoints with empty required fields
// ────────────────────────────────────────────────────────────────
async function testEmptyStrings() {
  section('5. Empty strings');

  await test('POST /api/comments with empty required fields', async () => {
    // Empty text should be rejected (server checks: if (!page || !text))
    const {status: s1} = await api('POST', '/api/comments', {
      page: `${TEST_COMMENT_PAGE}/empty`,
      author: 'Test',
      text: '',
    });
    assertEq(s1, 400, 'empty text rejected');

    // Empty page should also be rejected
    const {status: s2} = await api('POST', '/api/comments', {
      page: '',
      author: 'Test',
      text: 'Some text',
    });
    assertEq(s2, 400, 'empty page rejected');
  });
}

// ────────────────────────────────────────────────────────────────
// 6. Null values: POST with null in required fields
// ────────────────────────────────────────────────────────────────
async function testNullValues() {
  section('6. Null values');

  await test('POST /api/comments with null text and page', async () => {
    const {status: s1} = await api('POST', '/api/comments', {
      page: null,
      author: 'Test',
      text: 'Some text',
    });
    assertEq(s1, 400, 'null page rejected');

    const {status: s2} = await api('POST', '/api/comments', {
      page: `${TEST_COMMENT_PAGE}/null`,
      author: 'Test',
      text: null,
    });
    assertEq(s2, 400, 'null text rejected');

    const {status: s3} = await api('POST', '/api/file', {
      path: null,
      content: 'test',
    });
    assertEq(s3, 400, 'null path rejected for file create');
  });
}

// ────────────────────────────────────────────────────────────────
// 7. Very long paths: GET /api/file?path=content/a/b/c/d/e/f/g.md
// ────────────────────────────────────────────────────────────────
async function testLongPaths() {
  section('7. Very long paths');

  await test('GET /api/file with deeply nested path', async () => {
    const longPath = 'content/a/b/c/d/e/f/g.md';
    const {status} = await api('GET', `/api/file?path=${encodeURIComponent(longPath)}`);
    // Should return 404 (file does not exist) but NOT crash
    assertOk(status === 404 || status === 400, `expected 404 or 400, got ${status}`);

    // Also test an absurdly long path
    const absurdPath = 'content/' + Array.from({length: 50}, (_, i) => `dir${i}`).join('/') + '/file.md';
    const {status: s2} = await api('GET', `/api/file?path=${encodeURIComponent(absurdPath)}`);
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
    const {status: checkStatus} = await api('GET', `/api/file?path=${encodeURIComponent(TEST_FILE)}`);
    if (checkStatus === 404) {
      await api('POST', '/api/file', {path: TEST_FILE, content: TEST_FILE_CONTENT});
    }

    // Fire 3 writes and 5 reads simultaneously
    const ops = [
      ...Array.from({length: 3}, (_, i) =>
        api('PUT', '/api/file', {
          path: TEST_FILE,
          content: `---\ntitle: "Resilience Test"\n---\n\nConcurrent write ${i}\n`,
        }).then(r => ({type: 'write', status: r.status}))
      ),
      ...Array.from({length: 5}, () =>
        api('GET', `/api/file?path=${encodeURIComponent(TEST_FILE)}`)
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
    // The comments POST endpoint has a rate limit of 30/min per IP.
    // Some requests from earlier tests may have already consumed part of the budget.
    // We fire 100 requests and expect a mix of 200s and 429s.
    const page = `${TEST_COMMENT_PAGE}/ratelimit`;
    const requests = Array.from({length: 100}, (_, i) =>
      api('POST', '/api/comments', {
        page,
        author: 'Rate Tester',
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

    // Cleanup
    cleanup.push(async () => {
      const {data} = await api('GET', `/api/comments?page=${encodeURIComponent(page)}&limit=200`);
      for (const c of (data.comments || [])) {
        await api('DELETE', '/api/comments', {page, commentId: c.id});
      }
    });
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
  console.log(`\n${BOLD}Mochi Lab Stress & Resilience Tests${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}\n`);

  await preflight();

  await testConcurrentWrites();    // 1
  await testRapidComments();       // 2
  await testLargePayload();        // 3
  await testUnicodeStress();       // 4
  await testEmptyStrings();        // 5
  await testNullValues();          // 6
  await testLongPaths();           // 7
  await testSpecialCharsInQuery(); // 8
  await testConcurrentReadWrite(); // 9
  await testRateLimit();           // 10

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
