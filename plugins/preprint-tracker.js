#!/usr/bin/env node
'use strict';

/**
 * Preprint Tracker
 *
 * Scans references.yaml for arXiv preprints and checks Semantic Scholar
 * to see if they have been published in a venue. If so, updates the
 * entry with the venue information.
 *
 * Usage: node plugins/preprint-tracker.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const yaml = require('js-yaml');

const REFERENCES_PATH = path.join(__dirname, '..', 'bibliography', 'references.yaml');
const S2_API_BASE = 'https://api.semanticscholar.org/graph/v1/paper';
const RATE_LIMIT_MS = 100;

/**
 * Extract arXiv ID from a reference entry.
 * Checks the arxivId field and the url field for arxiv.org links.
 */
function extractArxivId(entry) {
  if (entry.arxivId) return entry.arxivId;

  if (entry.url) {
    const match = entry.url.match(/arxiv\.org\/abs\/(\d+\.\d+(?:v\d+)?)/);
    if (match) return match[1];
  }

  return null;
}

/**
 * Fetch JSON from a URL using the built-in https module.
 * Returns a promise that resolves to the parsed JSON or null on failure.
 */
function fetchJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'MochiLab-PreprintTracker/1.0' } }, (res) => {
      if (res.statusCode === 429) {
        console.warn('  [rate-limited] Got 429, skipping...');
        res.resume();
        resolve(null);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.warn(`  [error] ${err.message}`);
      resolve(null);
    });
  });
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // Read references.yaml
  if (!fs.existsSync(REFERENCES_PATH)) {
    console.error(`Error: ${REFERENCES_PATH} not found.`);
    process.exit(1);
  }

  const rawYaml = fs.readFileSync(REFERENCES_PATH, 'utf8');
  const references = yaml.load(rawYaml) || {};
  const keys = Object.keys(references);

  console.log(`Loaded ${keys.length} references from references.yaml`);

  // Find entries with arXiv IDs that don't have a venue yet
  // (empty venue, or venue is just "arXiv"/"arxiv")
  const candidates = [];
  for (const key of keys) {
    const entry = references[key];
    const arxivId = extractArxivId(entry);
    if (!arxivId) continue;

    const venue = (entry.venue || '').trim().toLowerCase();
    if (venue && venue !== 'arxiv') {
      continue;
    }

    candidates.push({ key, entry, arxivId });
  }

  console.log(`Found ${candidates.length} arXiv preprints without a formal venue\n`);

  if (candidates.length === 0) {
    console.log('Nothing to do — all arXiv papers already have venues.');
    return;
  }

  let updated = 0;
  let checked = 0;
  let errors = 0;

  for (const { key, entry, arxivId } of candidates) {
    checked++;
    process.stdout.write(`[${checked}/${candidates.length}] ${key} (arXiv:${arxivId})... `);

    const url = `${S2_API_BASE}/arXiv:${arxivId}?fields=venue,year,externalIds,journal`;
    const data = await fetchJson(url);

    if (!data) {
      console.log('not found or error');
      errors++;
      await sleep(RATE_LIMIT_MS);
      continue;
    }

    // Determine the venue: prefer data.venue, fall back to journal name
    let venue = data.venue || (data.journal && data.journal.name) || '';

    // Don't count "ArXiv" / "arXiv" as a real venue
    if (venue.toLowerCase() === 'arxiv') {
      venue = '';
    }

    if (venue.trim()) {
      console.log(`PUBLISHED -> "${venue}"`);
      entry.venue = venue;

      // Also update DOI if Semantic Scholar provides one and the entry lacks it
      if (!entry.doi && data.externalIds && data.externalIds.DOI) {
        entry.doi = data.externalIds.DOI;
        console.log(`  + added DOI: ${entry.doi}`);
      }

      updated++;
    } else {
      console.log('still preprint');
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n--- Summary ---`);
  console.log(`Checked: ${checked}`);
  console.log(`Updated: ${updated}`);
  console.log(`Errors:  ${errors}`);

  if (updated > 0) {
    // Write back to references.yaml
    const output = yaml.dump(references, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
    });
    fs.writeFileSync(REFERENCES_PATH, output, 'utf8');
    console.log(`\nWrote updated references.yaml`);
  } else {
    console.log(`\nNo updates needed.`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
