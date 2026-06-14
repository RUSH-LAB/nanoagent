import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load the REAL module the way the sibling route
// tests do (no reimplementation of the handler). This add-only characterization
// suite pins the CURRENT behavior of the `format: 'html'` branch of
// POST /api/export/bundle (server/routes/graph-trash-files.js): the full
// `<!DOCTYPE html> ... <title>Bundle Export</title> ...` document, the per-section
// `<h1>${title}</h1>\n${content}` rendering joined by `<hr>`, the load-bearing
// title-vs-content escape ASYMMETRY, the html headers, and the multi-section `md`
// join separator. All golden bodies below were captured from the real handler.
const require = createRequire(import.meta.url);
const graphRoutes = require('../server/routes/graph-trash-files.js');

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-html-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

// Write a fixture under the temp root; return its PROJECT_ROOT-relative path.
function writeFixture(rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
  return rel;
}

// A distinct (non-'*') origin so the Access-Control-Allow-Origin assertion proves
// the handler echoes the injected CORS_ORIGIN rather than a hard-coded constant.
const CORS = 'https://notes.example.test';

// Drive POST /api/export/bundle over the real handler, capturing the streamed body
// + headers. The success path writes through res.writeHead/res.end (not json), so
// the stub res captures both; json() is wired for the guard branches.
async function exportBundle(body, { corsOrigin = CORS, isValidFilePath = () => true } = {}) {
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
    CORS_ORIGIN: corsOrigin,
    rateLimit: () => true,
    readBody: async () => body,
    json(_res, status, payload) { captured.json = { status, payload }; res.writableEnded = true; },
  };
  const url = new URL('http://localhost/api/export/bundle');
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await graphRoutes(req, res, url, '/api/export/bundle', ctx);
  return captured;
}

// Two fixtures. Section A carries `&`, `<`, `>` in BOTH its front-matter title and
// its body so it exercises the escape asymmetry; section B carries a `&`/`<`/`>`
// body to confirm the content escape repeats per section. Titles come from the
// front matter (EXPORT_TITLE_RE), so they survive untouched into the heading.
const REL_A = 'content/sec-a.md';
const REL_B = 'content/sec-b.md';
const FIXTURE_A = '---\ntitle: A & B <x>\n---\na & b <x>\n';
const FIXTURE_B = '---\ntitle: Beta\n---\nPlain & simple <ok>\n';

// ── Golden fragments (captured from the real handler, written out literally) ──
const HTML_HEAD =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bundle Export</title>' +
  '<style>body{max-width:800px;margin:0 auto;padding:2rem;font-family:sans-serif;line-height:1.6}' +
  'h1{border-bottom:2px solid #333;padding-bottom:8px}hr{margin:3rem 0}</style></head><body>';
// Title escapes & -> &amp; and < -> &lt; but NOT > ; content escapes < and > but NOT & .
const SECTION_A_HTML = '<h1>A &amp; B &lt;x></h1>\na & b &lt;x&gt;';
const SECTION_B_HTML = '<h1>Beta</h1>\nPlain & simple &lt;ok&gt;';
const EXPECTED_HTML = HTML_HEAD + SECTION_A_HTML + '<hr>' + SECTION_B_HTML + '</body></html>';
const EXPECTED_MD = '# A & B <x>\n\na & b <x>\n\n---\n\n# Beta\n\nPlain & simple <ok>';

describe('POST /api/export/bundle — html output golden (characterization)', () => {
  before(() => { writeFixture(REL_A, FIXTURE_A); writeFixture(REL_B, FIXTURE_B); });

  it('pins the exact 2-section html document, the <hr> join, and the html headers', async () => {
    const r = await exportBundle({ paths: [REL_A, REL_B], format: 'html' });

    // Full streamed body, byte-for-byte.
    assert.equal(r.body, EXPECTED_HTML);

    // Document shell: the DOCTYPE preamble and the fixed <title>.
    assert.ok(r.body.startsWith('<!DOCTYPE html><html><head>'));
    assert.ok(r.body.includes('<title>Bundle Export</title>'));
    assert.ok(r.body.endsWith('</body></html>'));

    // The two sections are joined by exactly one bare <hr> (no surrounding markup),
    // and <hr> appears only as that join (the inline CSS uses the `hr{...}` selector,
    // never the literal `<hr>` tag).
    assert.ok(r.body.includes(SECTION_A_HTML + '<hr>' + SECTION_B_HTML));
    assert.equal(r.body.split('<hr>').length - 1, 1);

    // Headers: 200, html content type, bundle.html disposition, echoed CORS origin.
    assert.equal(r.status, 200);
    assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['Content-Disposition'], 'attachment; filename="bundle.html"');
    assert.equal(r.headers['Access-Control-Allow-Origin'], CORS);
  });

  it('pins the title-vs-content escape asymmetry (> kept in title, & kept in content)', async () => {
    const r = await exportBundle({ paths: [REL_A], format: 'html' });
    assert.equal(r.status, 200);

    // TITLE: `A & B <x>` escapes & and < but leaves > intact.
    assert.ok(r.body.includes('<h1>A &amp; B &lt;x></h1>'));
    // Prove the `>` is NOT escaped in the title (asymmetry, not symmetric escaping).
    assert.ok(!r.body.includes('A &amp; B &lt;x&gt;'));

    // CONTENT: `a & b <x>` escapes < and > but leaves & intact.
    assert.ok(r.body.includes('a & b &lt;x&gt;'));
    // Prove the `&` is NOT escaped in the content.
    assert.ok(!r.body.includes('a &amp; b'));

    // A single section emits no <hr> separator.
    assert.ok(!r.body.includes('<hr>'));
  });

  it('pins the multi-section md join separator and headers (explicit and default format)', async () => {
    const explicit = await exportBundle({ paths: [REL_A, REL_B], format: 'md' });
    assert.equal(explicit.status, 200);
    assert.equal(explicit.body, EXPECTED_MD);

    // Sections joined by the literal '\n\n---\n\n' separator; md does NOT html-escape.
    assert.ok(explicit.body.includes('a & b <x>\n\n---\n\n# Beta'));
    assert.equal(explicit.body.split('\n\n---\n\n').length - 1, 1);

    assert.equal(explicit.headers['Content-Type'], 'text/markdown; charset=utf-8');
    assert.equal(explicit.headers['Content-Disposition'], 'attachment; filename="bundle.md"');
    assert.equal(explicit.headers['Access-Control-Allow-Origin'], CORS);

    // Omitting `format` defaults to md: identical body + headers.
    const fallback = await exportBundle({ paths: [REL_A, REL_B] });
    assert.equal(fallback.body, EXPECTED_MD);
    assert.deepEqual(fallback.headers, explicit.headers);
  });
});
