#!/usr/bin/env node
/**
 * Populate raw files for the central bibliography.
 *
 * For every entry in references.yaml this script tries to materialize the raw
 * artifacts that the bibliography system expects under:
 *
 *   raw/bibliography/{key}/paper.pdf        the PDF
 *   raw/bibliography/{key}/source.tar.gz    the LaTeX source (arXiv e-print)
 *   raw/bibliography/{key}/meta.json        provenance (urls, status, timestamp)
 *   raw/bibliography/{key}/NOT_FOUND.md     the "special note" when raw is missing
 *
 * arXiv entries get both PDF and LaTeX source. Non-arXiv entries get a PDF when
 * the URL points straight at one, otherwise a NOT_FOUND.md explaining why the
 * raw could not be retrieved automatically (the requirement's "特殊说明").
 *
 * The script is idempotent: an entry that already has its expected artifacts is
 * skipped, so it can be re-run to fill gaps after throttling or network errors.
 *
 * Usage:
 *   node scripts/fetch-bibliography-raw.mjs            # all entries
 *   node scripts/fetch-bibliography-raw.mjs --only key1,key2
 *   node scripts/fetch-bibliography-raw.mjs --limit 20
 *   node scripts/fetch-bibliography-raw.mjs --concurrency 3 --delay 1500
 *   node scripts/fetch-bibliography-raw.mjs --force      # ignore existing files
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, '..');
const bibPath = path.join(projectDir, 'references.yaml');
const rawDir = path.join(projectDir, 'raw', 'bibliography');

// ---- args ---------------------------------------------------------------
function parseArgs(argv) {
  const opts = { concurrency: 3, delay: 1200, limit: 0, only: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--concurrency') opts.concurrency = parseInt(argv[++i], 10);
    else if (a === '--delay') opts.delay = parseInt(argv[++i], 10);
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--only') opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return opts;
}
const opts = parseArgs(process.argv.slice(2));

// ---- helpers ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractArxivId(url) {
  if (!url) return null;
  const m = url.match(/arxiv\.org\/(?:abs|pdf)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?(?:[#?].*)?$/);
  return m ? m[1] : null;
}

async function download(url, destPath, { expect } = {}) {
  // Returns { ok, bytes } — never throws on HTTP errors.
  // Uses curl: the sandbox blocks node's outbound sockets (EPERM) but allows curl.
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part`;
  try {
    const { stdout } = await execFileP('curl', [
      '-sSL',
      '--fail',
      '--max-time', '120',
      '--retry', '2',
      '--retry-delay', '2',
      '-A', 'mochi-lab-bibliography/1.0 (+local research archive)',
      '-o', tmp,
      '-w', '%{http_code}',
      url,
    ], { maxBuffer: 1024 * 1024 });
    const status = parseInt(stdout.trim(), 10);
    if (!fs.existsSync(tmp)) return { ok: false, status };
    const buf = fs.readFileSync(tmp);
    if (expect === 'pdf') {
      const isPdf = buf.slice(0, 5).toString('latin1') === '%PDF-';
      if (!isPdf) {
        fs.rmSync(tmp, { force: true });
        return { ok: false, status, notPdf: true };
      }
    }
    fs.renameSync(tmp, destPath);
    return { ok: true, bytes: buf.length };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, status: err.code || 'curl-error' };
  }
}

function writeNotFound(itemDir, key, entry, reason) {
  const lines = [
    `# Raw not available: ${key}`,
    '',
    `**Title:** ${entry.title || '(untitled)'}`,
    `**Year:** ${entry.year || '?'}`,
    `**Venue:** ${entry.venue || '?'}`,
    entry.url ? `**URL:** ${entry.url}` : '**URL:** (none)',
    '',
    '## Why no raw files',
    '',
    reason,
    '',
    '## How to add it manually',
    '',
    `Drop the PDF at \`raw/bibliography/${key}/paper.pdf\` and the LaTeX source at`,
    `\`raw/bibliography/${key}/source.tar.gz\`, then remove this file.`,
    '',
  ];
  fs.mkdirSync(itemDir, { recursive: true });
  fs.writeFileSync(path.join(itemDir, 'NOT_FOUND.md'), lines.join('\n'));
}

function writeMeta(itemDir, meta) {
  fs.writeFileSync(path.join(itemDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

// ---- per-entry worker ---------------------------------------------------
async function processEntry(key, entry) {
  const itemDir = path.join(rawDir, key);
  const pdfPath = path.join(itemDir, 'paper.pdf');
  const srcPath = path.join(itemDir, 'source.tar.gz');
  const arxivId = extractArxivId(entry.url);

  const hasPdf = fs.existsSync(pdfPath);
  const hasSrc = fs.existsSync(srcPath);

  if (!opts.force) {
    if (arxivId && hasPdf && hasSrc) return { key, status: 'skip' };
    if (!arxivId && hasPdf) return { key, status: 'skip' };
    if (!arxivId && fs.existsSync(path.join(itemDir, 'NOT_FOUND.md'))) return { key, status: 'skip' };
  }

  const meta = { key, url: entry.url || null, arxivId: arxivId || null, fetchedAt: new Date().toISOString() };

  if (arxivId) {
    let pdfOk = hasPdf && !opts.force;
    let srcOk = hasSrc && !opts.force;
    if (!pdfOk) {
      const r = await download(`https://arxiv.org/pdf/${arxivId}`, pdfPath, { expect: 'pdf' });
      pdfOk = r.ok;
      meta.pdf = r.ok ? { bytes: r.bytes } : { error: r.status || r.contentType || 'failed' };
    }
    if (!srcOk) {
      const r = await download(`https://arxiv.org/e-print/${arxivId}`, srcPath);
      srcOk = r.ok;
      meta.source = r.ok ? { bytes: r.bytes } : { error: r.status || 'failed' };
    }
    if (pdfOk || srcOk) {
      // Clear any stale NOT_FOUND once we have at least one artifact.
      const nf = path.join(itemDir, 'NOT_FOUND.md');
      if (fs.existsSync(nf)) fs.rmSync(nf);
      writeMeta(itemDir, meta);
      return { key, status: pdfOk && srcOk ? 'full' : 'partial' };
    }
    writeNotFound(itemDir, key, entry,
      `arXiv ${arxivId} download failed (pdf=${meta.pdf?.error}, source=${meta.source?.error}). Re-run the fetch script to retry.`);
    writeMeta(itemDir, meta);
    return { key, status: 'failed' };
  }

  // Non-arXiv: only a direct .pdf URL is reliably fetchable.
  const url = entry.url || '';
  if (/\.pdf($|[?#])/i.test(url)) {
    const r = await download(url, pdfPath, { expect: 'pdf' });
    if (r.ok) {
      meta.pdf = { bytes: r.bytes };
      writeMeta(itemDir, meta);
      return { key, status: 'pdf-only' };
    }
  }
  writeNotFound(itemDir, key, entry,
    entry.url
      ? `This is not an arXiv paper and the URL is not a direct PDF (likely a publisher/landing page, possibly paywalled). LaTeX source is not publicly available.`
      : `No URL is recorded for this entry, so no raw artifact could be located automatically.`);
  writeMeta(itemDir, meta);
  return { key, status: 'note-only' };
}

// ---- pool runner --------------------------------------------------------
async function main() {
  const refs = yaml.load(fs.readFileSync(bibPath, 'utf8')) || {};
  let entries = Object.entries(refs);
  if (opts.only) entries = entries.filter(([k]) => opts.only.includes(k));
  if (opts.limit > 0) entries = entries.slice(0, opts.limit);

  const total = entries.length;
  console.log(`[fetch] ${total} entries | concurrency=${opts.concurrency} delay=${opts.delay}ms force=${opts.force}`);
  fs.mkdirSync(rawDir, { recursive: true });

  const counts = {};
  let done = 0;
  let cursor = 0;

  async function worker(id) {
    while (cursor < entries.length) {
      const idx = cursor++;
      const [key, entry] = entries[idx];
      let res;
      try {
        res = await processEntry(key, entry);
      } catch (err) {
        res = { key, status: 'error', error: err.message };
      }
      counts[res.status] = (counts[res.status] || 0) + 1;
      done++;
      if (res.status !== 'skip') {
        console.log(`[${String(done).padStart(4)}/${total}] ${res.status.padEnd(9)} ${key}${res.error ? ' :: ' + res.error : ''}`);
      } else if (done % 50 === 0) {
        console.log(`[${String(done).padStart(4)}/${total}] ...`);
      }
      if (res.status !== 'skip') await sleep(opts.delay);
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => worker(i)));

  console.log('\n[fetch] done. summary:');
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k.padEnd(10)} ${v}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
