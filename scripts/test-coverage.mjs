#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Test coverage meta-test for the Mochi Lab editor server
// Compares endpoints defined in server.js and server/routes/ against
// paths exercised by all test-*.mjs scripts and reports coverage.
// Usage:  node scripts/test-coverage.mjs
// ─────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ── Colors ──
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ─────────────────────────────────────────────────────────────
// 1. Extract all unique endpoint paths from server.js
// ─────────────────────────────────────────────────────────────

function extractEndpoints() {
  // Routes live in server.js (core) plus the per-domain modules in api/routes/.
  let serverSrc = readFileSync(join(ROOT, 'server.js'), 'utf8');
  try {
    const routesDir = join(ROOT, 'server', 'routes');
    for (const f of readdirSync(routesDir)) {
      if (f.endsWith('.js')) serverSrc += '\n' + readFileSync(join(routesDir, f), 'utf8');
    }
  } catch { /* routes dir optional */ }
  const paths = new Set();

  // Match: pathname === '/api/...'
  const re = /pathname === '(\/api\/[^']+)'/g;
  let m;
  while ((m = re.exec(serverSrc)) !== null) {
    paths.add(m[1]);
  }

  return [...paths].sort();
}

// ─────────────────────────────────────────────────────────────
// 2. Scan all test-*.mjs files for tested paths
// ─────────────────────────────────────────────────────────────

function extractTestedPaths() {
  const scriptsDir = join(ROOT, 'scripts');
  const testFiles = readdirSync(scriptsDir).filter(
    f => f.startsWith('test-') && f.endsWith('.mjs') && f !== 'test-coverage.mjs'
  );

  const tested = new Set();

  for (const file of testFiles) {
    const src = readFileSync(join(scriptsDir, file), 'utf8');

    // Match single-quoted literal paths: '/api/...'
    const singleQuoteRe = /'(\/api\/[^'?]*)/g;
    let m;
    while ((m = singleQuoteRe.exec(src)) !== null) {
      tested.add(m[1]);
    }

    // Match template-literal paths: `/api/...`
    // We need to extract the static prefix up to the first ${} or ?
    const templateRe = /`(\/api\/[^`]*)`/g;
    while ((m = templateRe.exec(src)) !== null) {
      let path = m[1];
      // Strip query string (anything after ?)
      path = path.split('?')[0];
      // Strip dynamic segments (anything after ${)
      path = path.split('${')[0];
      // Remove trailing slash if any
      path = path.replace(/\/$/, '');
      if (path.length > 4) { // must be more than just '/api'
        tested.add(path);
      }
    }
  }

  return { tested, testFiles };
}

// ─────────────────────────────────────────────────────────────
// 3. Compare and report
// ─────────────────────────────────────────────────────────────

function main() {
  const endpoints = extractEndpoints();
  const { tested, testFiles } = extractTestedPaths();

  const covered = [];
  const uncovered = [];

  for (const ep of endpoints) {
    if (tested.has(ep)) {
      covered.push(ep);
    } else {
      uncovered.push(ep);
    }
  }

  const total = endpoints.length;
  const coveredCount = covered.length;
  const uncoveredCount = uncovered.length;
  const pct = total > 0 ? ((coveredCount / total) * 100).toFixed(1) : '0.0';

  // ── Report ──
  console.log(`\n${BOLD}Mochi Lab API Test Coverage Report${RESET}`);
  console.log(`${DIM}Server: server.js + server/routes/${RESET}`);
  console.log(`${DIM}Test files: ${testFiles.join(', ')}${RESET}\n`);

  console.log(`${BOLD}Total endpoints:${RESET}  ${total}`);
  console.log(`${BOLD}Covered:${RESET}          ${GREEN}${coveredCount}${RESET}`);
  console.log(`${BOLD}Uncovered:${RESET}        ${uncoveredCount > 0 ? RED : GREEN}${uncoveredCount}${RESET}`);
  console.log(`${BOLD}Coverage:${RESET}         ${pct >= 80 ? GREEN : pct >= 60 ? YELLOW : RED}${pct}%${RESET}\n`);

  if (uncovered.length > 0) {
    console.log(`${BOLD}${RED}Uncovered endpoints:${RESET}`);
    for (const ep of uncovered) {
      console.log(`  ${RED}-${RESET} ${ep}`);
    }
    console.log();
  }

  if (covered.length > 0) {
    console.log(`${BOLD}${GREEN}Covered endpoints:${RESET}`);
    for (const ep of covered) {
      console.log(`  ${GREEN}+${RESET} ${ep}`);
    }
    console.log();
  }

  // Exit with failure if coverage is below threshold
  const MIN_COVERAGE = 60;
  if (parseFloat(pct) < MIN_COVERAGE) {
    console.log(`${RED}FAIL: Coverage ${pct}% is below the ${MIN_COVERAGE}% threshold.${RESET}\n`);
    process.exit(1);
  }

  console.log(`${GREEN}PASS: Coverage ${pct}% meets the ${MIN_COVERAGE}% threshold.${RESET}\n`);
  process.exit(0);
}

main();
