import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const miscRoutes = require('../../../../../server/routes/misc-tools.js');

const PROJECT_ROOT = '/fake/root';
const EXPORT_DIR = 'content/batch-sample';
const SAMPLE_NAME = 'sample.md';
const SAMPLE_REL = `${EXPORT_DIR}/${SAMPLE_NAME}`;

// Representative markdown that exercises every branch of the render chain: code
// fence (with a language tag plus the &/</> escapes), all four heading levels,
// bold, italic, inline code, link, list, blockquote, paragraph, and a run of
// blank lines (collapsed by the final pass). Built from an array so the triple
// and single backticks do not collide with the JS template-literal delimiter.
const SAMPLE = [
  '# Title One',
  '',
  'A normal paragraph with **bold text** and *italic text* and `inline code`.',
  '',
  '## Section Two',
  '',
  '### Sub Section',
  '',
  '#### Tiny Heading',
  '',
  'Visit [the link](https://example.com) for more.',
  '',
  '> A blockquote line.',
  '',
  '- first item',
  '- second item',
  '- third item',
  '',
  '```js',
  'const x = 1 < 2 && 3 > 2;',
  'const s = "a & b";',
  '```',
  '',
  '',
  '',
  'Final paragraph after several blank lines.',
  '',
].join('\n');

// Independent reference: the exact pre-hoist render chain with fresh inline
// regex literals copied verbatim from the former call sites. Because every
// pattern is applied through String.prototype.replace (which resets lastIndex on
// entry and exit), this reproduces the former per-file output byte-for-byte.
function convertReference(content) {
  let html = content;
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escaped}</code></pre>`;
  });
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/(^- .+$(\n- .+$)*)/gm, (match) => {
    const items = match.split('\n').map(line => `<li>${line.slice(2)}</li>`).join('\n');
    return `<ul>\n${items}\n</ul>`;
  });
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^(?!<[a-z/])((?!\s*$).+)$/gm, '<p>$1</p>');
  html = html.replace(/\n{3,}/g, '\n\n');
  return html.trim();
}

// Minimal in-memory fs covering only what GET /api/export/batch reads:
// existsSync, statSync().isDirectory(), readdirSync(d, {withFileTypes:true}),
// and readFileSync(fp, 'utf-8'). One flat directory holds the markdown files.
function makeFs(files) {
  const dirAbs = path.join(PROJECT_ROOT, EXPORT_DIR);
  const fileAbs = new Map(
    Object.entries(files).map(([name, text]) => [path.join(dirAbs, name), text])
  );
  return {
    existsSync: (p) => p === dirAbs || fileAbs.has(p),
    statSync: (p) => ({ isDirectory: () => p === dirAbs }),
    readdirSync: (d) => {
      if (d !== dirAbs) return [];
      return [...fileAbs.keys()].map((abs) => ({
        name: path.basename(abs),
        isDirectory: () => false,
        isFile: () => true,
      }));
    },
    readFileSync: (p) => {
      if (fileAbs.has(p)) return fileAbs.get(p);
      const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err;
    },
  };
}

// Drive GET /api/export/batch with a mocked ctx; return the string passed to
// res.end (the exported HTML document) or, on an error path, the json() body.
async function batchExport(files) {
  let captured = null;
  const res = {
    writableEnded: false,
    writeHead() { return res; },
    end(body) { captured = body; res.writableEnded = true; return res; },
  };
  const ctx = {
    path,
    PROJECT_ROOT,
    CORS_ORIGIN: '*',
    isValidDir: (d) => typeof d === 'string' && d.startsWith('content/'),
    fs: makeFs(files),
    json: (_res, status, body) => { captured = { status, body }; res.writableEnded = true; },
  };
  const url = new URL(`http://localhost/api/export/batch?dir=${encodeURIComponent(EXPORT_DIR)}&format=html`);
  await miscRoutes({ method: 'GET' }, res, url, '/api/export/batch', ctx);
  return captured;
}

// Pull the rendered section body (the per-file converted markdown) back out of
// the full HTML document: the section-path paragraph immediately precedes it and
// the closing </section> tag terminates it.
function extractBody(payload, relPath) {
  const marker = `<p class="section-path">${relPath}</p>\n`;
  const start = payload.indexOf(marker);
  assert.notEqual(start, -1, 'section-path marker not found in payload');
  const from = start + marker.length;
  const end = payload.indexOf('\n</section>', from);
  assert.notEqual(end, -1, 'closing </section> not found in payload');
  return payload.slice(from, end);
}

// Canonical patterns, copied verbatim from the former inline literals. Used to
// assert the hoisted consts neither widened nor narrowed.
const CANON = {
  BATCH_CODE_BLOCK_RE: /```(\w*)\n([\s\S]*?)```/g,
  BATCH_H4_RE: /^#### (.+)$/gm,
  BATCH_H3_RE: /^### (.+)$/gm,
  BATCH_H2_RE: /^## (.+)$/gm,
  BATCH_H1_RE: /^# (.+)$/gm,
  BATCH_BOLD_RE: /\*\*(.+?)\*\*/g,
  BATCH_ITALIC_RE: /\*(.+?)\*/g,
  BATCH_INLINE_CODE_RE: /`([^`]+)`/g,
  BATCH_LINK_RE: /\[([^\]]+)\]\(([^)]+)\)/g,
  BATCH_LIST_RE: /(^- .+$(\n- .+$)*)/gm,
  BATCH_BLOCKQUOTE_RE: /^> (.+)$/gm,
  BATCH_PARA_RE: /^(?!<[a-z/])((?!\s*$).+)$/gm,
  BATCH_BLANK_LINES_RE: /\n{3,}/g,
};

describe('GET /api/export/batch (BATCH_* render regexes hoisted to module scope)', () => {
  it('exports each render regex with the exact former source and flags', () => {
    for (const [name, canon] of Object.entries(CANON)) {
      const re = miscRoutes[name];
      assert.ok(re instanceof RegExp, `${name} should be an exported RegExp`);
      assert.equal(re.source, canon.source, `${name} source drifted`);
      assert.equal(re.flags, canon.flags, `${name} flags drifted`);
    }
    // Spot-check the flag strings directly so a silent flag change is obvious.
    assert.equal(miscRoutes.BATCH_CODE_BLOCK_RE.flags, 'g');
    assert.equal(miscRoutes.BATCH_H1_RE.flags, 'gm');
    assert.equal(miscRoutes.BATCH_BLANK_LINES_RE.flags, 'g');
  });

  it('shares one referentially stable instance across requires', () => {
    const a = require('../../../../../server/routes/misc-tools.js');
    const b = require('../../../../../server/routes/misc-tools.js');
    for (const name of Object.keys(CANON)) {
      assert.strictEqual(a[name], b[name], `${name} should be a single shared instance`);
    }
  });

  it('renders a representative document identically to the pre-hoist chain', async () => {
    const payload = await batchExport({ [SAMPLE_NAME]: SAMPLE });
    assert.equal(typeof payload, 'string', 'expected an HTML string, not an error response');
    assert.ok(payload.includes('<!DOCTYPE html>'), 'expected a full HTML document');

    const body = extractBody(payload, SAMPLE_REL);
    assert.equal(body, convertReference(SAMPLE));

    // Every branch left its mark (guards against a SAMPLE that quietly stops
    // exercising one of the patterns).
    assert.ok(body.includes('<pre><code class="language-js">'), 'code fence + language');
    assert.ok(body.includes('1 &lt; 2 &amp;&amp; 3 &gt; 2'), 'code-fence &/</> escapes');
    assert.ok(body.includes('<h1>Title One</h1>'), 'h1');
    assert.ok(body.includes('<h2>Section Two</h2>'), 'h2');
    assert.ok(body.includes('<h3>Sub Section</h3>'), 'h3');
    assert.ok(body.includes('<h4>Tiny Heading</h4>'), 'h4');
    assert.ok(body.includes('<strong>bold text</strong>'), 'bold');
    assert.ok(body.includes('<em>italic text</em>'), 'italic');
    assert.ok(body.includes('<code>inline code</code>'), 'inline code');
    assert.ok(body.includes('<a href="https://example.com">the link</a>'), 'link');
    assert.ok(body.includes('<ul>\n<li>first item</li>'), 'list');
    assert.ok(body.includes('<blockquote>A blockquote line.</blockquote>'), 'blockquote');
    assert.ok(body.includes('<p>'), 'paragraph');
    // Blank-line collapse fired: the input held a 3+ newline run, the output none.
    assert.ok(/\n{3,}/.test(SAMPLE), 'sample should contain a blank-line run');
    assert.ok(!/\n{3,}/.test(body), 'render should collapse blank-line runs');
  });

  it('produces identical output on a second request (shared /g regexes carry no lastIndex)', async () => {
    const first = extractBody(await batchExport({ [SAMPLE_NAME]: SAMPLE }), SAMPLE_REL);
    const second = extractBody(await batchExport({ [SAMPLE_NAME]: SAMPLE }), SAMPLE_REL);
    assert.equal(second, first);
    assert.equal(first, convertReference(SAMPLE));
  });
});
