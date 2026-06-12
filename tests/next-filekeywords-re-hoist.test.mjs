import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// file-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const SPECIFIER = '../server/routes/file-tools.js';
const routes = require(SPECIFIER);

// Temp PROJECT_ROOTs created during the run, removed in after().
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

// Write `body` to <root>/<rel> and return the fresh temp root path.
function makeFile(rel, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filekeywords-hoist-'));
  roots.push(root);
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body, 'utf-8');
  return root;
}

// Drive the real GET /api/file/keywords handler over a temp root and capture json().
// The handler only touches url, isValidFilePath, fs, path, PROJECT_ROOT, and json on
// this path, so the stub supplies just those.
async function getKeywords(root, relPath) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    isValidFilePath: () => true,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/file/keywords?path=' + encodeURIComponent(relPath));
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/file/keywords', ctx);
  return captured;
}

// The keyword stop-word set, copied verbatim from KEYWORDS_STOP_WORDS in
// server/routes/file-tools.js so the reference extractor below filters exactly as the
// handler does. The route does not export it (out of this step's scope), so it is
// reproduced here purely as the oracle's filter.
const KEYWORDS_STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','and','but','or','nor','for','yet','so','in','on','at','to','by','of','with','from','up','about','into','through','during','before','after','above','below','between','out','off','over','under','again','further','then','once','here','there','when','where','why','how','all','each','every','both','few','more','most','other','some','such','no','not','only','own','same','than','too','very','just','because','as','until','while','this','that','these','those','it','its','he','she','they','them','their','we','our','you','your','i','me','my','what','which','who','whom','if']);

// Reference keyword extraction using the ORIGINAL inline regex chain (pre-hoist),
// retyped independently. The handler now uses the hoisted consts, so it must match
// this byte for byte; a widened or narrowed hoisted pattern would diverge here.
function referenceKeywords(raw) {
  let text = raw;
  text = text.replace(/^---[\s\S]*?---/, '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/#{1,6}\s*/g, '');
  text = text.replace(/[*_~`>|\\[\]()-]/g, ' ').replace(/<[^>]+>/g, '');
  const freq = {};
  const words = text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2 && !KEYWORDS_STOP_WORDS.has(w));
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count }));
  return { keywords, totalWords: words.length };
}

// Representative markdown that exercises all eight patterns: frontmatter, a fenced
// code block, inline code, a link (alt text kept), headings, HTML tags, the markdown
// punctuation class (hyphen/underscore/backslash/bracket), and the lowercase split.
// It mixes stop words and repeated content words so the frequency ordering matters.
const MARKDOWN = [
  '---',
  'title: Test Document',
  'tags: [alpha]',
  '---',
  '',
  '# Heading Marker',
  '',
  'This paragraph mentions kubernetes and kubernetes again, plus `inlinecode`',
  'and a [linklabel](https://example.com/path) reference about kubernetes.',
  '',
  '```python',
  'fencedblock = should_be_ignored',
  '```',
  '',
  'More scaling notes with <em>htmltag</em> and punctuation: foo-bar_baz scaling.',
  '',
].join('\n');

// [name, canonical literal] pairs. The canonical literals carry the exact bytes of
// the original inline patterns, so an equal .source/.flags proves a faithful hoist.
const SPECS = [
  ['KEYWORDS_FRONTMATTER_RE', /^---[\s\S]*?---/],
  ['KEYWORDS_FENCE_RE', /```[\s\S]*?```/g],
  ['KEYWORDS_INLINE_CODE_RE', /`[^`]*`/g],
  ['KEYWORDS_LINK_RE', /!?\[([^\]]*)\]\([^)]*\)/g],
  ['KEYWORDS_HEADING_RE', /#{1,6}\s*/g],
  ['KEYWORDS_PUNCT_RE', /[*_~`>|\\[\]()-]/g],
  ['KEYWORDS_HTML_RE', /<[^>]+>/g],
  ['KEYWORDS_SPLIT_RE', /[^a-z]+/],
];

const REPLACE_GLOBALS = ['KEYWORDS_FENCE_RE', 'KEYWORDS_INLINE_CODE_RE', 'KEYWORDS_LINK_RE', 'KEYWORDS_HEADING_RE', 'KEYWORDS_PUNCT_RE', 'KEYWORDS_HTML_RE'];

describe('keywords strip regexes (hoisted to module scope in file-tools.js)', () => {
  it('exports all eight as RegExps whose source and flags match the canonical literals', () => {
    for (const [name, canonical] of SPECS) {
      const re = routes[name];
      assert.ok(re instanceof RegExp, `${name} should be a RegExp`);
      assert.equal(re.source, canonical.source, `${name}.source`);
      assert.equal(re.flags, canonical.flags, `${name}.flags`);
    }
  });

  it('uses /g for the six replace patterns and no flags for frontmatter and split', () => {
    assert.equal(routes.KEYWORDS_FRONTMATTER_RE.global, false);
    assert.equal(routes.KEYWORDS_FRONTMATTER_RE.flags, '');
    assert.equal(routes.KEYWORDS_SPLIT_RE.global, false);
    assert.equal(routes.KEYWORDS_SPLIT_RE.flags, '');
    for (const name of REPLACE_GLOBALS) {
      assert.equal(routes[name].global, true, `${name} should be global`);
      assert.equal(routes[name].sticky, false, `${name} should not be sticky`);
    }
  });

  it('returns the same regex instances across two requires (built once at module load)', () => {
    const second = require(SPECIFIER);
    for (const [name] of SPECS) {
      assert.strictEqual(second[name], routes[name], `${name} should be a single shared instance`);
    }
  });

  it('extracts keywords identical to the original inline chain', async () => {
    const root = makeFile('content/doc.md', MARKDOWN);
    const { status, payload } = await getKeywords(root, 'content/doc.md');
    assert.equal(status, 200);
    assert.deepStrictEqual(payload, referenceKeywords(MARKDOWN));
    // Spot checks: content words survive, link alt text is kept, and code / html
    // markup / frontmatter are stripped before counting.
    const words = payload.keywords.map(k => k.word);
    assert.equal(payload.keywords[0].word, 'kubernetes');
    assert.equal(payload.keywords[0].count, 3);
    assert.ok(words.includes('linklabel'), 'link alt text is kept');
    assert.ok(words.includes('htmltag'), 'html tag markup is removed but its text remains');
    assert.ok(!words.includes('inlinecode'), 'inline code is stripped');
    assert.ok(!words.includes('fencedblock'), 'fenced code is stripped');
    assert.ok(!words.includes('document'), 'frontmatter is stripped');
  });

  it('is unaffected by a pre-seeded lastIndex on the shared global instances', async () => {
    // String.prototype.replace resets a /g regex's lastIndex to 0 before scanning, so
    // a stale lastIndex left by an earlier request cannot corrupt the next one. Seed a
    // non-zero lastIndex and confirm the output is identical and lastIndex is reset.
    for (const name of REPLACE_GLOBALS) routes[name].lastIndex = 7;
    const root = makeFile('content/doc2.md', MARKDOWN);
    const { status, payload } = await getKeywords(root, 'content/doc2.md');
    assert.equal(status, 200);
    assert.deepStrictEqual(payload, referenceKeywords(MARKDOWN));
    for (const name of REPLACE_GLOBALS) {
      assert.equal(routes[name].lastIndex, 0, `${name}.lastIndex resets to 0 after replace`);
    }
  });

  it('produces identical output on two back-to-back requests (shared instances stay safe)', async () => {
    const root = makeFile('content/doc3.md', MARKDOWN);
    const first = await getKeywords(root, 'content/doc3.md');
    const second = await getKeywords(root, 'content/doc3.md');
    assert.equal(first.status, 200);
    assert.deepStrictEqual(second.payload, first.payload);
  });
});
