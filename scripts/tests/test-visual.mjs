#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Lightweight visual regression test for Mochi Lab pages
// For each page, fetches HTML and extracts content metrics:
//   - Page title (from <title>)
//   - Content length (bytes)
//   - Number of links (<a> tags)
//   - Number of scripts (<script> tags)
//   - Has CSS loaded (stylesheet links present)
// Compares against a baseline snapshot and flags regressions
// when any metric changes by more than 20%.
// Usage:  node scripts/tests/test-visual.mjs
// Requires the Docusaurus dev server running on http://localhost:3002
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_PATHS as PAGES } from './pages.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

const BASE = process.env.PAGES_URL || 'http://localhost:3002';
const BASELINE_PATH = join(ROOT, 'snapshots', 'visual-baseline.json');

// ── Colors ──
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ── Regression threshold ──
const THRESHOLD = 0.20; // 20%

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

// ── Extract metrics from HTML ──
function extractMetrics(html) {
  // Page title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Content length in bytes (use Buffer for accurate byte count)
  const contentLength = Buffer.byteLength(html, 'utf8');

  // Number of <a> tags
  const linkMatches = html.match(/<a[\s>]/gi);
  const linkCount = linkMatches ? linkMatches.length : 0;

  // Number of <script> tags
  const scriptMatches = html.match(/<script[\s>]/gi);
  const scriptCount = scriptMatches ? scriptMatches.length : 0;

  // Has CSS loaded (stylesheet links)
  const hasStylesheet = /<link[^>]+rel=["']stylesheet["'][^>]*>/i.test(html);

  return {
    title,
    contentLength,
    linkCount,
    scriptCount,
    hasStylesheet,
  };
}

// ── Fetch page and extract metrics ──
async function fetchPageMetrics(path) {
  const url = `${BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status !== 200) {
      return { path, error: `HTTP ${res.status}`, metrics: null };
    }

    const html = await res.text();
    const metrics = extractMetrics(html);
    return { path, error: null, metrics };
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? 'Request timed out (10s)' : err.message;
    return { path, error: msg, metrics: null };
  }
}

// ── Compare two metric sets for a page, return regressions ──
function compareMetrics(baseline, current) {
  const regressions = [];

  // Title change (exact match, not percentage)
  if (baseline.title !== current.title) {
    regressions.push({
      metric: 'title',
      baseline: baseline.title,
      current: current.title,
      note: 'changed',
    });
  }

  // Numeric metrics: flag if delta exceeds threshold
  const numericMetrics = ['contentLength', 'linkCount', 'scriptCount'];
  for (const key of numericMetrics) {
    const base = baseline[key];
    const curr = current[key];

    // If baseline is 0, any non-zero current is a change
    if (base === 0 && curr === 0) continue;
    if (base === 0 && curr > 0) {
      regressions.push({
        metric: key,
        baseline: base,
        current: curr,
        note: 'appeared (was 0)',
      });
      continue;
    }

    const delta = Math.abs(curr - base) / base;
    if (delta > THRESHOLD) {
      const direction = curr > base ? 'increased' : 'decreased';
      regressions.push({
        metric: key,
        baseline: base,
        current: curr,
        note: `${direction} by ${(delta * 100).toFixed(1)}%`,
      });
    }
  }

  // Boolean metric: hasStylesheet flipping is a regression
  if (baseline.hasStylesheet !== current.hasStylesheet) {
    regressions.push({
      metric: 'hasStylesheet',
      baseline: baseline.hasStylesheet,
      current: current.hasStylesheet,
      note: current.hasStylesheet ? 'stylesheet appeared' : 'stylesheet disappeared',
    });
  }

  return regressions;
}

// ── Load baseline ──
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    const raw = readFileSync(BASELINE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Save baseline ──
function saveBaseline(snapshot) {
  const dir = dirname(BASELINE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}

// ── Main ──
async function main() {
  console.log(`\n${BOLD}Mochi Lab — Visual Regression Test${RESET}`);
  console.log(`${DIM}Target: ${BASE}${RESET}`);
  console.log(`${DIM}Pages:  ${PAGES.length}${RESET}`);
  console.log(`${DIM}Threshold: >${(THRESHOLD * 100).toFixed(0)}% change in any metric${RESET}`);

  await preflight();

  // Fetch all pages
  console.log(`\n${BOLD}Fetching pages...${RESET}`);
  const results = [];
  let fetchErrors = 0;

  for (const path of PAGES) {
    const result = await fetchPageMetrics(path);
    results.push(result);

    if (result.error) {
      fetchErrors++;
      console.log(`  ${RED}✗${RESET} ${path} ${DIM}${result.error}${RESET}`);
    } else {
      const m = result.metrics;
      console.log(
        `  ${GREEN}✓${RESET} ${path} ${DIM}` +
        `${(m.contentLength / 1024).toFixed(1)} KB, ` +
        `${m.linkCount} links, ` +
        `${m.scriptCount} scripts, ` +
        `css: ${m.hasStylesheet ? 'yes' : 'no'}${RESET}`
      );
    }
  }

  // Build current snapshot
  const currentSnapshot = {
    timestamp: new Date().toISOString(),
    base: BASE,
    pages: {},
  };

  for (const r of results) {
    if (r.metrics) {
      currentSnapshot.pages[r.path] = r.metrics;
    }
  }

  // Load existing baseline
  const baseline = loadBaseline();

  if (!baseline) {
    // No baseline exists — create one
    saveBaseline(currentSnapshot);
    console.log(`\n${CYAN}${BOLD}Baseline created${RESET}`);
    console.log(`  ${DIM}Saved to: ${BASELINE_PATH}${RESET}`);
    console.log(`  ${DIM}${Object.keys(currentSnapshot.pages).length} pages captured${RESET}`);

    // Summary
    console.log(`\n${BOLD}Summary${RESET}`);
    console.log(`  Pages checked:       ${GREEN}${PAGES.length}${RESET}`);
    console.log(`  Fetch errors:        ${fetchErrors > 0 ? RED : GREEN}${fetchErrors}${RESET}`);
    console.log(`  Regressions found:   ${GREEN}0${RESET} ${DIM}(new baseline)${RESET}`);
    console.log(`  Baseline saved:      ${CYAN}yes (new)${RESET}\n`);
    process.exit(fetchErrors > 0 ? 1 : 0);
  }

  // Compare with baseline
  console.log(`\n${BOLD}Comparing with baseline...${RESET}`);
  console.log(`  ${DIM}Baseline from: ${baseline.timestamp}${RESET}`);

  let totalRegressions = 0;
  let pagesWithRegressions = 0;

  for (const path of PAGES) {
    const current = currentSnapshot.pages[path];
    const base = baseline.pages[path];

    if (!current) {
      // Fetch failed, skip comparison
      continue;
    }

    if (!base) {
      // New page, not in baseline
      console.log(`  ${YELLOW}●${RESET} ${path} ${DIM}(new page, not in baseline)${RESET}`);
      continue;
    }

    const regressions = compareMetrics(base, current);

    if (regressions.length === 0) {
      console.log(`  ${GREEN}✓${RESET} ${path} ${DIM}no regressions${RESET}`);
    } else {
      pagesWithRegressions++;
      totalRegressions += regressions.length;

      console.log(`  ${RED}✗${RESET} ${path} ${RED}${regressions.length} regression(s)${RESET}`);
      for (const r of regressions) {
        console.log(
          `    ${YELLOW}→${RESET} ${r.metric}: ` +
          `${DIM}${r.baseline}${RESET} → ${BOLD}${r.current}${RESET} ` +
          `${YELLOW}(${r.note})${RESET}`
        );
      }
    }
  }

  // Update baseline with current snapshot
  saveBaseline(currentSnapshot);
  console.log(`\n  ${DIM}Baseline updated: ${BASELINE_PATH}${RESET}`);

  // Summary
  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  Pages checked:       ${GREEN}${PAGES.length}${RESET}`);
  console.log(`  Fetch errors:        ${fetchErrors > 0 ? RED : GREEN}${fetchErrors}${RESET}`);

  if (totalRegressions > 0) {
    console.log(`  Regressions found:   ${RED}${totalRegressions}${RESET} ${DIM}across ${pagesWithRegressions} page(s)${RESET}`);
  } else {
    console.log(`  Regressions found:   ${GREEN}0${RESET}`);
  }

  console.log(`  Baseline saved:      ${CYAN}yes (updated)${RESET}\n`);

  // Exit with failure if regressions found
  if (totalRegressions > 0 || fetchErrors > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(`${RED}Unhandled error:${RESET}`, err);
  process.exit(2);
});
