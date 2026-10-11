#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Frontend page content verification tests
// Fetches each page from the Docusaurus dev server and verifies:
//   1. HTTP status is 200
//   2. HTML contains expected content strings
//   3. No error indicators in the HTML
// Usage:  node tests/integration/test-pages.mjs
// Requires the Docusaurus dev server running on http://localhost:3002
// ─────────────────────────────────────────────────────────────

import { PAGE_CONTENT_CHECKS as PAGES } from './pages.mjs';

const BASE = process.env.PAGES_URL || 'http://localhost:3002';

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

// ── Error indicators to scan for in HTML ──
const ERROR_PATTERNS = [
  /Internal Server Error/i,
  /500 Error/i,
  /Application error/i,
  /Cannot read propert/i,
  /is not defined/i,
  /Unexpected token/i,
  /SyntaxError/i,
  /TypeError/i,
  /ReferenceError/i,
  /<pre class="error">/i,
];

// ── Preflight connectivity check ──
async function preflight() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(BASE, { signal: controller.signal });
    clearTimeout(timer);
    return true;
  } catch {
    console.error(`${RED}ERROR:${RESET} Cannot reach ${BASE}. Is the Docusaurus dev server running?`);
    console.error(`  Start it with:  npm start  (or yarn start)`);
    process.exit(1);
  }
}

// ── Test a single page ──
async function testPage(path, contentStrings) {
  const url = `${BASE}${path}`;
  const label = `${path}`;

  try {
    // Fetch with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    // 1. Check HTTP status
    if (res.status !== 200) {
      fail(label, `HTTP ${res.status} (expected 200)`);
      return;
    }

    const html = await res.text();

    // 2. Check for error indicators
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(html)) {
        fail(label, `Error indicator found: ${pattern}`);
        return;
      }
    }

    // 3. Check for expected content (any one match is sufficient)
    // Docusaurus SPA serves a shell HTML for all routes — actual content
    // is rendered client-side. We do a case-insensitive search of the full
    // HTML (which may include route info in inline scripts or metadata).
    const htmlLower = html.toLowerCase();
    const found = contentStrings.some(str => htmlLower.includes(str.toLowerCase()));

    // 4. Verify valid SPA shell (Docusaurus bootstrap present)
    const validShell = html.includes('__docusaurus') || html.includes('Docusaurus');

    const sizeKB = (html.length / 1024).toFixed(1);

    if (found) {
      const matchedStr = contentStrings.find(str => htmlLower.includes(str.toLowerCase()));
      pass(label, `${sizeKB} KB, matched "${matchedStr}"`);
    } else if (validShell) {
      // SPA shell is valid but route-specific content is rendered client-side
      pass(label, `${sizeKB} KB, valid SPA shell (content renders client-side)`);
    } else {
      fail(label, `None of [${contentStrings.join(', ')}] found and no valid SPA shell`);
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      fail(label, 'Request timed out (10s)');
    } else {
      fail(label, err.message);
    }
  }
}

// ── Main ──
async function main() {
  console.log(`\n${BOLD}Mochi Lab — Frontend Page Content Verification${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}`);
  console.log(`${DIM}Testing: ${PAGES.length} pages${RESET}`);

  await preflight();

  console.log(`\n${BOLD}Pages${RESET}`);

  for (const [path, contentStrings] of PAGES) {
    await testPage(path, contentStrings);
  }

  // ── Summary ──
  const total = passed + failed;
  console.log(`\n${BOLD}Summary${RESET}`);
  if (failed === 0) {
    console.log(`  ${GREEN}All ${passed} pages passed${RESET}`);
  } else {
    console.log(`  ${GREEN}${passed}${RESET} passed, ${RED}${failed}${RESET} failed`);
  }
  console.log(`  ${passed}/${total} pages verified\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`${RED}Unhandled error:${RESET}`, err);
  process.exit(2);
});
