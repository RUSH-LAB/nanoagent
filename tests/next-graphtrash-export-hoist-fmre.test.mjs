import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the other route tests do.
// This suite guards the hoist of the export/bundle front-matter + title regex
// literals to module-scope consts (EXPORT_FM_RE, EXPORT_TITLE_RE): it proves the
// GET /api/file/export and POST /api/export/bundle bodies are byte-for-byte
// unchanged across every format, that the now-shared regexes carry no state across
// back-to-back requests (neither is global), and that the source allocates each
// literal exactly once at module scope instead of rebuilding it per request.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-hoist-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

// Write a fixture under the temp root; return its PROJECT_ROOT-relative path.
function writeFixture(rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
  return rel;
}

// Drive GET /api/file/export for one format over a fixture, capturing the streamed
// body + headers. The success path writes through res.writeHead/res.end (not json),
// so the stub res captures both; json() is wired for the guard branches.
async function exportFile(filePath, format, isValidFilePath = () => true) {
  const captured = { status: null, headers: null, body: null, json: null };
  const res = {
    writableEnded: false,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; return this; },
    end(body) { captured.body = body; this.writableEnded = true; return this; },
  };
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    isValidFilePath,
    json(_res, status, payload) { captured.json = { status, payload }; res.writableEnded = true; },
  };
  const url = new URL(`http://localhost/api/file/export?path=${encodeURIComponent(filePath)}&format=${encodeURIComponent(format)}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, '/api/file/export', ctx);
  return captured;
}

// Drive POST /api/export/bundle (the bundle branch is the fifth hoist site).
async function exportBundle(body, isValidFilePath = () => true) {
  const captured = { status: null, headers: null, body: null, json: null };
  const res = {
    writableEnded: false,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; return this; },
    end(b) { captured.body = b; this.writableEnded = true; return this; },
  };
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    isValidFilePath,
    CORS_ORIGIN: '*',
    rateLimit: () => true,
    readBody: async () => body,
    json(_res, status, payload) { captured.json = { status, payload }; res.writableEnded = true; },
  };
  const url = new URL('http://localhost/api/export/bundle');
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, '/api/export/bundle', ctx);
  return captured;
}

// Fixture whose front matter carries a `title:` line distinct from the filename
// baseName ("export-fixture"), so every assertion that the FM title survived also
// proves it was not silently defaulted to the baseName. The `authors:` line feeds
// the latex author branch (not hoisted, but it shares the same stripped fm block).
const TITLE = 'Hoisted Export Title';
const FIXTURE = [
  '---',
  `title: ${TITLE}`,
  'authors: [Ada Lovelace, Alan Turing]',
  '---',
  '# Heading One',
  '',
  'A paragraph of body text.',
  '',
].join('\n');
const REL = 'content/export-fixture.md';

describe('GET /api/file/export — hoisted EXPORT_FM_RE / EXPORT_TITLE_RE', () => {
  before(() => { writeFixture(REL, FIXTURE); });

  it('md returns the raw content unchanged (control: no fm/title regex on this path)', async () => {
    const r = await exportFile(REL, 'md');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/markdown; charset=utf-8');
    assert.equal(r.headers['Content-Disposition'], 'attachment; filename="export-fixture.md"');
    assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(r.body, FIXTURE);
  });

  it('latex extracts the fm title + authors and strips the fm block (exact body)', async () => {
    const EXPECTED_LATEX =
      '\\documentclass{article}\n' +
      '\\usepackage[utf8]{inputenc}\n' +
      '\\usepackage{hyperref}\n' +
      '\\title{Hoisted Export Title}\n' +
      '\\author{Ada Lovelace \\and Alan Turing}\n' +
      '\\date{\\today}\n' +
      '\\begin{document}\n' +
      '\\maketitle\n' +
      '\\section{Heading One}\n' +
      '\n' +
      'A paragraph of body text.\n' +
      '\\end{document}\n';
    const r = await exportFile(REL, 'latex');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(r.headers['Content-Disposition'], 'attachment; filename="export-fixture.tex"');
    assert.equal(r.body, EXPECTED_LATEX);
  });

  it('html puts the fm title in <title> and strips the fm block', async () => {
    const r = await exportFile(REL, 'html');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['Content-Disposition'], 'attachment; filename="export-fixture.html"');
    assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
    // Title came from the fm, not the baseName.
    assert.ok(r.body.includes('<title>Hoisted Export Title</title>'));
    assert.ok(!r.body.includes('<title>export-fixture</title>'));
    // Body converted; the fm block (raw title line, authors, fences) is gone.
    assert.ok(r.body.includes('<h1>Heading One</h1>'));
    assert.ok(r.body.includes('<p>A paragraph of body text.</p>'));
    assert.ok(!r.body.includes('title: Hoisted Export Title'));
    assert.ok(!r.body.includes('authors:'));
  });

  it('pdf puts the fm title in <title> and strips the fm block', async () => {
    const r = await exportFile(REL, 'pdf');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['Content-Disposition'], 'attachment; filename="export-fixture-print.html"');
    assert.ok(r.body.includes('<title>Hoisted Export Title</title>'));
    assert.ok(r.body.includes('<h1>Heading One</h1>'));
    assert.ok(!r.body.includes('title: Hoisted Export Title'));
    assert.ok(!r.body.includes('authors:'));
  });

  it('slides puts the fm title in <title> and the title slide', async () => {
    const r = await exportFile(REL, 'slides');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['Content-Disposition'], 'attachment; filename="export-fixture-slides.html"');
    assert.ok(r.body.includes('<title>Hoisted Export Title</title>'));
    assert.ok(r.body.includes('<h1 style="font-size:3rem;color:#e94560">Hoisted Export Title</h1>'));
    assert.ok(!r.body.includes('authors:'));
  });

  it('returns byte-identical bodies + headers on two back-to-back requests per format', async () => {
    // Both consts are non-global and consumed through String.prototype.match, so
    // they keep no lastIndex; two consecutive exports of the same file must be
    // byte-identical. A leaked lastIndex (e.g. a stray /g) would change the second.
    for (const format of ['md', 'html', 'pdf', 'latex', 'slides']) {
      const first = await exportFile(REL, format);
      const second = await exportFile(REL, format);
      assert.equal(second.status, 200, `${format} status`);
      assert.equal(second.body, first.body, `${format} body identical`);
      assert.deepEqual(second.headers, first.headers, `${format} headers identical`);
    }
  });

  it('falls back to the baseName title when there is no front matter (EXPORT_FM_RE returns null)', async () => {
    const rel = writeFixture('content/nofm.md', '# Just A Heading\n\nBody without front matter.\n');
    const first = await exportFile(rel, 'html');
    const second = await exportFile(rel, 'html');
    assert.equal(first.status, 200);
    assert.ok(first.body.includes('<title>nofm</title>'));
    assert.ok(first.body.includes('<h1>Just A Heading</h1>'));
    assert.ok(first.body.includes('<p>Body without front matter.</p>'));
    assert.equal(second.body, first.body);
  });

  it('falls back to the baseName title when the front matter has no title line (EXPORT_TITLE_RE returns null)', async () => {
    const rel = writeFixture('content/notitle.md', '---\ndraft: true\n---\n# H\n\nBody.\n');
    const r = await exportFile(rel, 'html');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('<title>notitle</title>'));
    // The fm block was matched and stripped even though it carried no title line.
    assert.ok(!r.body.includes('draft: true'));
    assert.ok(r.body.includes('<h1>H</h1>'));
  });

  it('rejects an invalid path (400) and an unknown format (400) without writing a body', async () => {
    const bad = await exportFile('../etc/passwd', 'md', () => false);
    assert.equal(bad.body, null);
    assert.deepEqual(bad.json, { status: 400, payload: { error: 'Invalid path' } });
    const badFmt = await exportFile(REL, 'docx');
    assert.equal(badFmt.body, null);
    assert.equal(badFmt.json.status, 400);
  });
});

describe('POST /api/export/bundle — hoisted EXPORT_FM_RE / EXPORT_TITLE_RE', () => {
  before(() => { writeFixture(REL, FIXTURE); });

  it('extracts the fm title into the section heading and strips the fm block (exact body)', async () => {
    const EXPECTED_BUNDLE_MD = '# Hoisted Export Title\n\n# Heading One\n\nA paragraph of body text.';
    const r = await exportBundle({ paths: [REL], format: 'md' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/markdown; charset=utf-8');
    assert.equal(r.headers['Content-Disposition'], 'attachment; filename="bundle.md"');
    assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
    assert.equal(r.body, EXPECTED_BUNDLE_MD);
  });

  it('returns identical bundle output on a second back-to-back request', async () => {
    const first = await exportBundle({ paths: [REL], format: 'md' });
    const second = await exportBundle({ paths: [REL], format: 'md' });
    assert.equal(second.body, first.body);
    assert.deepEqual(second.headers, first.headers);
  });
});

describe('source structure — export regexes hoisted once, inline literals dropped', () => {
  const SRC = fs.readFileSync(new URL('../server/routes/graph-trash-files.js', import.meta.url), 'utf-8');
  const count = (hay, needle) => hay.split(needle).length - 1;

  it('defines EXPORT_FM_RE and EXPORT_TITLE_RE exactly once at module scope, with the exact literals', () => {
    assert.equal(count(SRC, 'const EXPORT_FM_RE ='), 1);
    assert.equal(count(SRC, 'const EXPORT_TITLE_RE ='), 1);
    // The exact def lines pin the trailing "\n?", the /m flag, and the absence of a
    // /g flag (each ends at "/;" / "/m;"), which is what makes sharing one instance
    // behavior-preserving.
    assert.ok(SRC.includes(String.raw`const EXPORT_FM_RE = /^---\n([\s\S]*?)\n---\n?/;`));
    assert.ok(SRC.includes(String.raw`const EXPORT_TITLE_RE = /^title:\s*["']?(.+?)["']?\s*$/m;`));
  });

  it('no longer allocates the two export literals inline (occurrence count dropped)', () => {
    // The fm "\n?" literal now lives only in the EXPORT_FM_RE definition (was 5).
    assert.equal(count(SRC, String.raw`/^---\n([\s\S]*?)\n---\n?/`), 1);
    // The title literal survives only in the EXPORT_TITLE_RE definition and the
    // untouched /api/graph handler (was 6).
    assert.equal(count(SRC, String.raw`/^title:\s*["']?(.+?)["']?\s*$/m`), 2);
    // Each const is referenced by its definition plus the five export/bundle sites.
    assert.ok(count(SRC, 'EXPORT_FM_RE') >= 6);
    assert.ok(count(SRC, 'EXPORT_TITLE_RE') >= 6);
  });

  it('leaves the /api/graph and /api/file/info no-suffix front-matter regex untouched', () => {
    // Both handlers use the distinct no-"\n?" variant; it must still appear twice.
    assert.equal(count(SRC, String.raw`/^---\n([\s\S]*?)\n---/`), 2);
  });
});
