import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// graph-trash-files.js is CommonJS; load it the way the other route tests do.
// This suite guards the hoist of the GET /api/file/export markdown render regexes
// (the pdf/html/latex/slides `.replace` chains) to module-scope RENDER_* consts
// plus the non-global SLIDES_H2_RE. It proves three things:
//   1. each shared regex is exported with the exact .source/.flags, so swapping the
//      inline literal for the shared instance is behavior-preserving, and the slides
//      heading regex stays non-global (separate from the global RENDER_H2_RE);
//   2. every export-format payload is byte-for-byte identical to the output captured
//      from the pre-hoist handler (the GOLDEN constant below);
//   3. sharing one /g instance leaks no lastIndex across back-to-back requests.
const require = createRequire(import.meta.url);
const SPECIFIER = '../server/routes/graph-trash-files.js';
const graphRoutes = require(SPECIFIER);

// Markdown fixture exercising every hoisted render regex: an H1/H2/H3, bold, italic,
// inline code, a link, a consecutive "- " list, a fenced code block, and a run of
// three blank lines, across two "## " sections (so the slides split yields multiple
// slides). Keep this byte-identical to the input the GOLDEN was captured from; the
// `md` case asserts body === FIXTURE as a cross-check.
const FIXTURE = [
  '---',
  'title: Render Hoist Title',
  'authors: [Ada Lovelace, Alan Turing]',
  '---',
  '# Heading One',
  '',
  '## Section Two',
  '',
  'Intro paragraph with **bold**, *italic*, and `inline` code.',
  '',
  'A [link](https://example.com) here.',
  '',
  '### Subsection',
  '',
  '- alpha',
  '- beta',
  '- gamma',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '## Section Three',
  '',
  'More text after a fence.',
  '',
  '',
  '',
  'Trailing.',
  '',
].join('\n');

// Golden payloads captured from the PRE-HOIST handler (server/routes/graph-trash-
// files.js before the RENDER_*/SLIDES_H2_RE hoist) for the FIXTURE above. The pdf
// body's footer date is non-deterministic, so it was normalized to __DATE__ at
// capture time, and the test normalizes the live pdf body the same way before the
// byte-for-byte comparison.
const GOLDEN = {
  "md": {
    "status": 200,
    "headers": {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"render-fixture.md\"",
      "Access-Control-Allow-Origin": "*"
    },
    "body": "---\ntitle: Render Hoist Title\nauthors: [Ada Lovelace, Alan Turing]\n---\n# Heading One\n\n## Section Two\n\nIntro paragraph with **bold**, *italic*, and `inline` code.\n\nA [link](https://example.com) here.\n\n### Subsection\n\n- alpha\n- beta\n- gamma\n\n```js\nconst x = 1;\n```\n\n## Section Three\n\nMore text after a fence.\n\n\n\nTrailing.\n"
  },
  "html": {
    "status": 200,
    "headers": {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"render-fixture.html\"",
      "Access-Control-Allow-Origin": "*"
    },
    "body": "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Render Hoist Title</title>\n<style>\nbody { max-width: 800px; margin: 2rem auto; padding: 0 1rem; font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; line-height: 1.6; color: #333; }\npre { background: #f5f5f5; padding: 1rem; overflow-x: auto; border-radius: 4px; }\ncode { background: #f0f0f0; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }\npre code { background: none; padding: 0; }\nblockquote { border-left: 3px solid #ddd; margin-left: 0; padding-left: 1rem; color: #666; }\na { color: #2563eb; }\n</style>\n</head>\n<body>\n<h1>Heading One</h1>\n\n<h2>Section Two</h2>\n\n<p>Intro paragraph with <strong>bold</strong>, <em>italic</em>, and <code>inline</code> code.</p>\n\n<p>A <a href=\"https://example.com\">link</a> here.</p>\n\n<h3>Subsection</h3>\n\n<ul>\n<li>alpha</li>\n<li>beta</li>\n<li>gamma</li>\n</ul>\n\n<pre><code class=\"language-js\">const x = 1;\n</code></pre>\n\n<h2>Section Three</h2>\n\n<p>More text after a fence.</p>\n\n<p>Trailing.</p>\n</body>\n</html>"
  },
  "pdf": {
    "status": 200,
    "headers": {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"render-fixture-print.html\"",
      "Access-Control-Allow-Origin": "*"
    },
    "body": "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Render Hoist Title</title>\n<style>\n@page { size: A4; margin: 2cm; }\nbody { max-width: 700px; margin: 0 auto; padding: 2rem 1rem; font-family: \"Times New Roman\", Georgia, serif; font-size: 12pt; line-height: 1.8; color: #111; }\nh1 { font-size: 20pt; margin-top: 0; border-bottom: 2px solid #333; padding-bottom: 8px; }\nh2 { font-size: 16pt; margin-top: 1.5em; }\nh3 { font-size: 13pt; margin-top: 1.2em; }\npre { background: #f5f5f5; padding: 12px; overflow-x: auto; border: 1px solid #ddd; font-size: 10pt; }\ncode { background: #f0f0f0; padding: 1px 4px; border-radius: 2px; font-size: 10pt; }\npre code { background: none; padding: 0; }\nblockquote { border-left: 3px solid #999; margin-left: 0; padding-left: 1rem; color: #555; }\na { color: #1a0dab; }\ntable { border-collapse: collapse; width: 100%; margin: 1em 0; }\nth, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }\n@media print {\n  body { max-width: none; padding: 0; }\n  a { color: inherit; text-decoration: none; }\n  pre { border: 1px solid #ccc; }\n}\n</style>\n</head>\n<body>\n<h1>Heading One</h1>\n\n<h2>Section Two</h2>\n\n<p>Intro paragraph with <strong>bold</strong>, <em>italic</em>, and <code>inline</code> code.</p>\n\n<p>A <a href=\"https://example.com\">link</a> here.</p>\n\n<h3>Subsection</h3>\n\n<ul>\n<li>alpha</li>\n<li>beta</li>\n<li>gamma</li>\n</ul>\n\n<pre><code>const x = 1;\n</code></pre>\n\n<h2>Section Three</h2>\n\n<p>More text after a fence.</p>\n\n<p>Trailing.</p>\n<footer style=\"margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ccc; font-size: 9pt; color: #888;\">\nGenerated from Mochi Lab &mdash; __DATE__\n</footer>\n</body>\n</html>"
  },
  "latex": {
    "status": 200,
    "headers": {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"render-fixture.tex\"",
      "Access-Control-Allow-Origin": "*"
    },
    "body": "\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{hyperref}\n\\title{Render Hoist Title}\n\\author{Ada Lovelace \\and Alan Turing}\n\\date{\\today}\n\\begin{document}\n\\maketitle\n\\section{Heading One}\n\n\\subsection{Section Two}\n\nIntro paragraph with \\textbf{bold}, \\textit{italic}, and \\texttt{inline} code.\n\nA \\href{https://example.com}{link} here.\n\n\\subsubsection{Subsection}\n\n\\item alpha\n\\item beta\n\\item gamma\n\n``\\texttt{js\nconst x = 1;\n}``\n\n\\subsection{Section Three}\n\nMore text after a fence.\n\n\n\nTrailing.\n\\end{document}\n"
  },
  "slides": {
    "status": 200,
    "headers": {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"render-fixture-slides.html\"",
      "Access-Control-Allow-Origin": "*"
    },
    "body": "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Render Hoist Title</title>\n<style>\n*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee}\n.slide{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:4rem 8rem;border-bottom:1px solid #333}\nh2{font-size:2.5rem;margin-bottom:1.5rem;color:#e94560}h3{font-size:1.5rem;margin:1rem 0;color:#0f3460}\np{font-size:1.2rem;line-height:1.8;margin:0.5rem 0}ul{margin:1rem 0 1rem 2rem}li{font-size:1.1rem;margin:0.3rem 0}\ncode{background:#16213e;padding:2px 6px;border-radius:3px;font-size:0.95em}\nstrong{color:#e94560}em{color:#0f3460}\nnav{position:fixed;bottom:20px;right:20px;display:flex;gap:8px}\nnav button{background:#16213e;color:#eee;border:1px solid #333;padding:8px 16px;cursor:pointer;border-radius:4px;font-size:0.9rem}\n</style></head><body>\n<section class=\"slide\" id=\"slide-title\" style=\"text-align:center\"><h1 style=\"font-size:3rem;color:#e94560\">Render Hoist Title</h1><p style=\"font-size:1.3rem;color:#888\">3 slides</p></section>\n<section class=\"slide\" id=\"slide-0\">\n<p># Heading One</p>\n</section>\n<section class=\"slide\" id=\"slide-1\">\n<h2>Section Two</h2>\n\n<p>Intro paragraph with <strong>bold</strong>, <em>italic</em>, and <code>inline</code> code.</p>\n\n<p>A [link](https://example.com) here.</p>\n\n<h3>Subsection</h3>\n\n<ul><li>alpha</li>\n<li>beta</li>\n<li>gamma</li>\n</ul>\n<p>``<code>js</p>\n<p>const x = 1;</p>\n</code>``\n</section>\n<section class=\"slide\" id=\"slide-2\">\n<h2>Section Three</h2>\n\n<p>More text after a fence.</p>\n\n\n\n<p>Trailing.</p>\n</section>\n<nav><button onclick=\"prev()\">Prev</button><button onclick=\"next()\">Next</button></nav>\n<script>\nlet cur=0;const slides=document.querySelectorAll('.slide');\nfunction show(i){slides.forEach((s,j)=>s.style.display=j===i?'flex':'none');cur=i}\nfunction next(){show(Math.min(cur+1,slides.length-1))}function prev(){show(Math.max(cur-1,0))}\nshow(0);document.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')next();if(e.key==='ArrowLeft')prev()});\n</script></body></html>"
  }
};

const PDF_DATE_TOKEN = '__DATE__';
const REL = 'content/render-fixture.md';

// [exported name, expected .source, expected .flags] for every hoisted regex.
const SPECS = [
  ['RENDER_CODE_BLOCK_RE', '```(\\w*)\\n([\\s\\S]*?)```', 'g'],
  ['RENDER_H1_RE', '^# (.+)$', 'gm'],
  ['RENDER_H2_RE', '^## (.+)$', 'gm'],
  ['RENDER_H3_RE', '^### (.+)$', 'gm'],
  ['RENDER_BOLD_RE', '\\*\\*(.+?)\\*\\*', 'g'],
  ['RENDER_ITALIC_RE', '\\*(.+?)\\*', 'g'],
  ['RENDER_INLINE_CODE_RE', '`([^`]+)`', 'g'],
  ['RENDER_LINK_RE', '\\[([^\\]]+)\\]\\(([^)]+)\\)', 'g'],
  ['RENDER_LIST_RE', '(^- .+$(\\n- .+$)*)', 'gm'],
  ['RENDER_LIST_ITEM_RE', '^- (.+)$', 'gm'],
  ['RENDER_PARA_RE', '^(?!<[a-z/])((?!\\s*$).+)$', 'gm'],
  ['RENDER_BLANK_LINES_RE', '\\n{3,}', 'g'],
  ['SLIDES_H2_RE', '^## (.+)$', 'm'],
];

let root;
before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-hoist-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

// Write a fixture under the temp root; return its PROJECT_ROOT-relative path.
function writeFixture(rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
  return rel;
}

// Drive GET /api/file/export for one format; capture the streamed body + headers.
// The success path writes through res.writeHead/res.end (not json); the stub res
// captures both, and json() is wired for the guard branches.
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

// Replace the non-deterministic pdf footer date with a stable token so the pdf body
// can be compared byte-for-byte against the normalized golden. Matching the footer
// line itself (rather than today's date string) keeps this independent of the wall
// clock, so the comparison cannot flake on a midnight rollover between render and
// assertion.
function normalizePdf(body) {
  return body.replace(/Generated from Mochi Lab &mdash; .*/, `Generated from Mochi Lab &mdash; ${PDF_DATE_TOKEN}`);
}

describe('GET /api/file/export — hoisted RENDER_* / SLIDES_H2_RE render regexes', () => {
  before(() => { writeFixture(REL, FIXTURE); });

  it('exports each render regex with the exact source + flags', () => {
    for (const [name, source, flags] of SPECS) {
      const re = graphRoutes[name];
      assert.ok(re instanceof RegExp, `${name} is a RegExp`);
      assert.equal(re.source, source, `${name}.source`);
      assert.equal(re.flags, flags, `${name}.flags`);
      assert.equal(re.global, flags.includes('g'), `${name}.global`);
      assert.equal(re.sticky, false, `${name}.sticky`);
    }
  });

  it('keeps the slides heading regex non-global and separate from the global RENDER_H2_RE', () => {
    // The trap: SLIDES_H2_RE and RENDER_H2_RE share one source but differ in flags.
    // Merging them would turn the slides single replacement into a global one and
    // change the rendered slide output.
    assert.equal(graphRoutes.SLIDES_H2_RE.source, graphRoutes.RENDER_H2_RE.source);
    assert.ok(!graphRoutes.SLIDES_H2_RE.flags.includes('g'), 'SLIDES_H2_RE.flags has no g');
    assert.equal(graphRoutes.SLIDES_H2_RE.global, false);
    assert.equal(graphRoutes.RENDER_H2_RE.global, true);
    // The per-line list item is a distinct pattern from the consecutive-block list.
    assert.notEqual(graphRoutes.RENDER_LIST_ITEM_RE.source, graphRoutes.RENDER_LIST_RE.source);
  });

  it('returns the same regex instances across two requires (built once at module load)', () => {
    const second = require(SPECIFIER);
    for (const [name] of SPECS) {
      assert.strictEqual(second[name], graphRoutes[name], `${name} stable across requires`);
    }
  });

  it('md returns the raw content unchanged (control: no render regex on this path)', async () => {
    const r = await exportFile(REL, 'md');
    assert.equal(r.status, 200);
    assert.deepEqual(r.headers, GOLDEN.md.headers);
    assert.equal(r.body, FIXTURE);
    assert.equal(r.body, GOLDEN.md.body);
  });

  for (const fmt of ['html', 'latex', 'slides']) {
    it(`${fmt} payload is byte-for-byte identical to the pre-hoist output`, async () => {
      const r = await exportFile(REL, fmt);
      assert.equal(r.status, 200);
      assert.deepEqual(r.headers, GOLDEN[fmt].headers);
      assert.equal(r.body, GOLDEN[fmt].body);
    });
  }

  it('pdf payload is byte-for-byte identical to the pre-hoist output (footer date normalized)', async () => {
    const r = await exportFile(REL, 'pdf');
    assert.equal(r.status, 200);
    assert.deepEqual(r.headers, GOLDEN.pdf.headers);
    assert.equal(normalizePdf(r.body), GOLDEN.pdf.body);
  });

  it('produces byte-identical bodies + headers on two back-to-back requests per format', async () => {
    // Each shared regex is consumed only through String.prototype.replace, which
    // resets lastIndex to 0 at the start of every global replace, so two consecutive
    // exports of the same file must match. A leaked lastIndex (from sharing one /g
    // instance) would change the second body.
    for (const fmt of ['md', 'html', 'pdf', 'latex', 'slides']) {
      const first = await exportFile(REL, fmt);
      const second = await exportFile(REL, fmt);
      assert.equal(second.status, 200, `${fmt} status`);
      assert.equal(second.body, first.body, `${fmt} body identical`);
      assert.deepEqual(second.headers, first.headers, `${fmt} headers identical`);
    }
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

describe('source structure — render regexes hoisted once, inline literals dropped', () => {
  const SRC = fs.readFileSync(new URL('../server/routes/graph-trash-files.js', import.meta.url), 'utf-8');
  const count = (hay, needle) => hay.split(needle).length - 1;

  it('defines and exports each RENDER_* / SLIDES_H2_RE const exactly once at module scope', () => {
    for (const [name] of SPECS) {
      assert.equal(count(SRC, `\nconst ${name} = `), 1, `${name} defined once`);
      assert.equal(count(SRC, `\nmodule.exports.${name} = ${name};`), 1, `${name} exported once`);
    }
  });

  it('pins the slides-trap definitions: same source, different flags', () => {
    assert.ok(SRC.includes('const SLIDES_H2_RE = /^## (.+)$/m;'));
    assert.ok(SRC.includes('const RENDER_H2_RE = /^## (.+)$/gm;'));
  });

  it('no longer allocates the hoisted render literals inline in the export branches', () => {
    // Each render literal now appears only in its const definition (count 1).
    assert.equal(count(SRC, String.raw`/\*\*(.+?)\*\*/g`), 1, 'bold literal');
    assert.equal(count(SRC, String.raw`/\[([^\]]+)\]\(([^)]+)\)/g`), 1, 'link literal');
    assert.equal(count(SRC, String.raw`/(^- .+$(\n- .+$)*)/gm`), 1, 'list-block literal');
    assert.equal(count(SRC, String.raw`/^(?!<[a-z/])((?!\s*$).+)$/gm`), 1, 'paragraph literal');
    assert.equal(count(SRC, String.raw`/\n{3,}/g`), 1, 'blank-lines literal');
  });

  it('leaves EXPORT_FM_RE / EXPORT_TITLE_RE untouched', () => {
    assert.ok(SRC.includes(String.raw`const EXPORT_FM_RE = /^---\n([\s\S]*?)\n---\n?/;`));
    assert.ok(SRC.includes(String.raw`const EXPORT_TITLE_RE = /^title:\s*["']?(.+?)["']?\s*$/m;`));
  });

  it('leaves the slides-specific <ul> wrap and the slides split regex inline (not hoisted)', () => {
    assert.equal(count(SRC, String.raw`/(<li>.*<\/li>\n?)+/g`), 1);
    assert.equal(count(SRC, String.raw`.split(/\n(?=## )/)`), 1);
  });
});
