#!/usr/bin/env node
// -----------------------------------------------------------------
// Performance regression tests for the Mochi Lab editor server
// Usage:  node tests/integration/test-perf.mjs
// Requires the server running on http://localhost:3001, and a GitHub sign-in
// saved by `node cli/rush.mjs login http://localhost:3001`
// -----------------------------------------------------------------

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {signedInHeaders} from './api-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SNAPSHOT_DIR = join(PROJECT_ROOT, 'snapshots');
const SNAPSHOT_PATH = join(SNAPSHOT_DIR, 'perf-baseline.json');

const BASE = process.env.API_URL || 'http://localhost:3001';
const SIGNED_IN = signedInHeaders(BASE);
const ITERATIONS = 5;

// -- Colors --
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

// -- Endpoint definitions --
// Each entry is an object: { method, path, threshold, label }.
// cold (optional)      — if set, the first request is timed separately against this
//                        cold threshold; the ITERATIONS warm requests use `threshold`.
// coldLabel (optional) — label for the cold-start row (defaults to `${label} (cold)`).
const ENDPOINTS = [
  { method: 'GET', path: '/api/health',                   threshold: 5,   label: 'Health check' },
  { method: 'GET', path: '/api/documents/tree',                    threshold: 30,  label: 'File listing' },
  { method: 'GET', path: '/api/search?q=gradient',        threshold: 10,  label: 'Search (warm)', cold: 200, coldLabel: 'Search (cold)' },
  { method: 'GET', path: '/api/stats',                    threshold: 200, label: 'Stats' },
  { method: 'GET', path: '/api/integrity',                threshold: 20,  label: 'Integrity check' },
];

// -- Helpers --

function verdict(avg, threshold) {
  if (avg <= threshold * 2) return 'PASS';  // within 2x threshold
  if (avg <= threshold * 5) return 'WARN';
  return 'FAIL';
}

function verdictColor(v) {
  if (v === 'PASS') return GREEN;
  if (v === 'WARN') return YELLOW;
  return RED;
}

function fmtMs(ms) {
  return ms.toFixed(2);
}

async function timeRequest(method, path) {
  const url = `${BASE}${path}`;
  const start = performance.now();
  const res = await fetch(url, { method, headers: SIGNED_IN });
  // consume body to ensure full response is received
  await res.text();
  const elapsed = performance.now() - start;
  return { elapsed, status: res.status };
}

async function benchmark(endpoint) {
  const { method, path, threshold, label, cold, coldLabel } = endpoint;
  const results = [];

  // If this endpoint has a cold-start measurement, do one request first
  let coldResult = null;
  if (cold !== undefined) {
    try {
      const { elapsed, status } = await timeRequest(method, path);
      coldResult = {
        label: coldLabel || `${label} (cold)`,
        threshold: cold,
        times: [elapsed],
        avg: elapsed,
        max: elapsed,
        min: elapsed,
        status,
      };
    } catch (err) {
      coldResult = {
        label: coldLabel || `${label} (cold)`,
        threshold: cold,
        times: [],
        avg: null,
        max: null,
        min: null,
        error: err.message,
      };
    }
  }

  // Warm requests
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const { elapsed, status } = await timeRequest(method, path);
      results.push({ elapsed, status });
    } catch (err) {
      results.push({ elapsed: null, error: err.message });
    }
  }

  const successful = results.filter(r => r.elapsed !== null);
  const times = successful.map(r => r.elapsed);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const max = times.length ? Math.max(...times) : null;
  const min = times.length ? Math.min(...times) : null;
  const httpStatus = successful.length ? successful[0].status : null;
  const errors = results.filter(r => r.error).map(r => r.error);

  return {
    warm: { label, path, method, threshold, times, avg, max, min, status: httpStatus, errors },
    cold: coldResult,
  };
}

// -- Main --

async function main() {
  console.log(`\n${BOLD}${CYAN}Performance Regression Test${RESET}`);
  console.log(`${DIM}Server: ${BASE}  |  Iterations: ${ITERATIONS}${RESET}\n`);

  // Verify server is reachable
  try {
    await fetch(`${BASE}/api/health`);
  } catch {
    console.error(`${RED}Server not reachable at ${BASE}${RESET}`);
    console.error(`Start the server first:  node server/index.js`);
    process.exit(1);
  }

  const allResults = [];
  let passes = 0;
  let warns = 0;
  let fails = 0;
  let errors = 0;

  // Table header
  const hdr = [
    'Endpoint'.padEnd(30),
    'Avg (ms)'.padStart(10),
    'Max (ms)'.padStart(10),
    'Threshold'.padStart(10),
    'Result'.padStart(8),
  ].join('  ');
  console.log(`${BOLD}${hdr}${RESET}`);
  console.log('-'.repeat(hdr.length));

  for (const ep of ENDPOINTS) {
    const { warm, cold } = await benchmark(ep);

    // Print cold row first if present
    const rows = cold ? [cold, warm] : [warm];
    for (const row of rows) {
      if (row.avg === null) {
        const errMsg = row.errors?.[0] || row.error || 'unknown error';
        console.log(
          `  ${row.label.padEnd(28)}  ${RED}ERROR${RESET}  ${DIM}${errMsg}${RESET}`
        );
        errors++;
        allResults.push({
          endpoint: row.path || ep.path,
          label: row.label,
          avg: null,
          max: null,
          threshold: row.threshold,
          result: 'ERROR',
          error: errMsg,
        });
        continue;
      }

      const v = verdict(row.avg, row.threshold);
      const vc = verdictColor(v);

      if (v === 'PASS') passes++;
      else if (v === 'WARN') warns++;
      else fails++;

      const line = [
        `  ${row.label.padEnd(28)}`,
        `${fmtMs(row.avg).padStart(10)}`,
        `${fmtMs(row.max).padStart(10)}`,
        `${(row.threshold + 'ms').padStart(10)}`,
        `${vc}${v.padStart(8)}${RESET}`,
      ].join('  ');
      console.log(line);

      allResults.push({
        endpoint: row.path || ep.path,
        label: row.label,
        avg: Math.round(row.avg * 100) / 100,
        max: Math.round(row.max * 100) / 100,
        min: Math.round(row.min * 100) / 100,
        threshold: row.threshold,
        result: v,
        times: row.times.map(t => Math.round(t * 100) / 100),
        httpStatus: row.status,
      });
    }
  }

  // Summary
  console.log('-'.repeat(hdr.length));
  const parts = [];
  if (passes) parts.push(`${GREEN}${passes} PASS${RESET}`);
  if (warns)  parts.push(`${YELLOW}${warns} WARN${RESET}`);
  if (fails)  parts.push(`${RED}${fails} FAIL${RESET}`);
  if (errors) parts.push(`${RED}${errors} ERROR${RESET}`);
  console.log(`\n${BOLD}Summary:${RESET} ${parts.join('  ')}`);

  // Load previous baseline for comparison if it exists
  let previousBaseline = null;
  if (existsSync(SNAPSHOT_PATH)) {
    try {
      previousBaseline = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
      console.log(`\n${BOLD}${CYAN}Comparison with previous baseline${RESET} ${DIM}(${previousBaseline.timestamp})${RESET}`);

      for (const current of allResults) {
        if (current.avg === null) continue;
        const prev = previousBaseline.results.find(r => r.label === current.label);
        if (!prev || prev.avg === null) continue;

        const delta = current.avg - prev.avg;
        const pct = ((delta / prev.avg) * 100).toFixed(1);
        const sign = delta >= 0 ? '+' : '';
        const color = delta > prev.avg * 0.5 ? RED : delta < -prev.avg * 0.1 ? GREEN : DIM;
        console.log(
          `  ${current.label.padEnd(28)}  ${color}${sign}${fmtMs(delta)}ms (${sign}${pct}%)${RESET}`
        );
      }
    } catch {
      // ignore corrupt baseline
    }
  }

  // Save snapshot
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    server: BASE,
    iterations: ITERATIONS,
    nodeVersion: process.version,
    results: allResults,
  };

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`\n${DIM}Baseline saved to snapshots/perf-baseline.json${RESET}\n`);

  // Exit code: non-zero if any FAIL
  if (fails > 0 || errors > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`${RED}Unexpected error: ${err.message}${RESET}`);
  process.exit(1);
});
