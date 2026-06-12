import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readability-reuse-'));
  roots.push(root);
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body, 'utf-8');
  return root;
}

// Drive the real GET /api/file/readability handler over a temp root and capture json().
// The handler only touches url, isValidFilePath, fs, path, PROJECT_ROOT, and json on this
// path, so the stub supplies just those.
async function getReadability(root, relPath) {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    isValidFilePath: () => true,
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/file/readability?path=' + encodeURIComponent(relPath));
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/file/readability', ctx);
  return captured;
}

// Reference readability scorer using the ORIGINAL inline regex chain (pre-reuse),
// retyped independently. The handler now reuses the six shared KEYWORDS_* strip consts
// for frontmatter / fence / inline-code / link / heading / html, but each is byte
// identical (same source and flags) to the literal it replaced, so the handler output
// must still match this oracle byte for byte. The punct, sentence-split, and word-split
// patterns are reproduced inline here exactly as they remain inline in the handler.
function referenceReadability(raw) {
  let text = raw;
  text = text.replace(/^---[\s\S]*?---/, '');
  text = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/#{1,6}\s*/g, '').replace(/<[^>]+>/g, '');
  text = text.replace(/[*_~>|\\[\]]/g, '');
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 3);
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const syllableCount = words.reduce((sum, w) => {
    const clean = w.toLowerCase().replace(/[^a-z]/g, '');
    if (!clean) return sum;
    const syllables = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
    return sum + Math.max(1, syllables ? syllables.length : 1);
  }, 0);
  const wordCount = words.length;
  const sentenceCount = Math.max(sentences.length, 1);
  const avgWordsPerSentence = Math.round((wordCount / sentenceCount) * 10) / 10;
  const avgSyllablesPerWord = Math.round((syllableCount / Math.max(wordCount, 1)) * 10) / 10;
  const fleschKincaid = Math.round((0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59) * 10) / 10;
  const readingTimeMin = Math.ceil(wordCount / 200);
  let level = 'Advanced';
  if (fleschKincaid <= 6) level = 'Easy';
  else if (fleschKincaid <= 10) level = 'Intermediate';
  else if (fleschKincaid <= 14) level = 'Advanced';
  else level = 'Expert';
  return {
    wordCount, sentenceCount, avgWordsPerSentence, avgSyllablesPerWord,
    fleschKincaidGrade: fleschKincaid, readingLevel: level,
    readingTimeMinutes: readingTimeMin,
  };
}

// Representative markdown that exercises every stripped construct before scoring:
// frontmatter, a fenced code block, inline code, a link (alt text kept), headings, an
// HTML tag, the markdown punctuation class (asterisk / underscore / backslash / brackets
// / pipe), and multiple sentences ending in '.', '!', and '?'. Built from an array so
// the fenced-code backticks do not collide with a template literal.
const MARKDOWN = [
  '---',
  'title: Readability Reuse Sample',
  'tags: [demo]',
  '---',
  '',
  '# Heading One',
  '',
  'The young researchers studied machine learning and jumped between *bold* ideas.',
  'They learned that [simple sentences](https://example.com/path) improve reading!',
  'Does inline `codeSnippet` stay stripped? Computers process <em>language</em> too.',
  '',
  '```python',
  'ignored = should_not_count',
  '```',
  '',
  'More notes use under_score and back\\slash and [brackets] plus a pipe | character.',
  '',
].join('\n');

// Slice the GET /api/file/readability handler body out of the source so the structural
// assertions only look at that handler, not the keywords handler or the exports.
const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'routes', 'file-tools.js'),
  'utf-8',
);
const READABILITY_START = SRC.indexOf("pathname === '/api/file/readability'");
const READABILITY_END = SRC.indexOf("pathname === '/api/file/related'");
const READABILITY_BLOCK = SRC.slice(READABILITY_START, READABILITY_END);

const REUSED_NAMES = [
  'KEYWORDS_FRONTMATTER_RE',
  'KEYWORDS_FENCE_RE',
  'KEYWORDS_INLINE_CODE_RE',
  'KEYWORDS_LINK_RE',
  'KEYWORDS_HEADING_RE',
  'KEYWORDS_HTML_RE',
];

describe('GET /api/file/readability (reuses the shared KEYWORDS_* strip consts)', () => {
  it('returns byte-identical readability metrics to the original inline regex chain', async () => {
    const root = makeFile('content/doc.md', MARKDOWN);
    const { status, payload } = await getReadability(root, 'content/doc.md');
    assert.equal(status, 200);
    assert.deepStrictEqual(payload, referenceReadability(MARKDOWN));
    // Sanity: the prose really was scored (frontmatter/code/markup stripped, words left).
    assert.ok(payload.wordCount > 0, 'prose words survive stripping');
    assert.ok(payload.sentenceCount >= 2, 'multiple sentences detected');
  });

  it('produces identical output on back-to-back requests (shared /g instances stay safe)', async () => {
    // The six reused consts include /g instances now shared across the keywords and
    // readability handlers and across requests. String.prototype.replace resets
    // lastIndex on each call, so this pins that readability stays deterministic
    // call-to-call rather than drifting on the second or third hit.
    const root = makeFile('content/doc2.md', MARKDOWN);
    const first = await getReadability(root, 'content/doc2.md');
    const second = await getReadability(root, 'content/doc2.md');
    const third = await getReadability(root, 'content/doc2.md');
    assert.equal(first.status, 200);
    assert.deepStrictEqual(second.payload, first.payload);
    assert.deepStrictEqual(third.payload, first.payload);
  });

  it('is unaffected by a pre-seeded lastIndex on the shared global instances', async () => {
    // A stale lastIndex left by an earlier keywords request must not corrupt readability,
    // since replace() resets it to 0 before scanning. Seed a non-zero lastIndex on the
    // reused /g consts and confirm the output is identical and lastIndex resets.
    const globals = ['KEYWORDS_FENCE_RE', 'KEYWORDS_INLINE_CODE_RE', 'KEYWORDS_LINK_RE', 'KEYWORDS_HEADING_RE', 'KEYWORDS_HTML_RE'];
    for (const name of globals) routes[name].lastIndex = 7;
    const root = makeFile('content/doc3.md', MARKDOWN);
    const { status, payload } = await getReadability(root, 'content/doc3.md');
    assert.equal(status, 200);
    assert.deepStrictEqual(payload, referenceReadability(MARKDOWN));
    for (const name of globals) {
      assert.equal(routes[name].lastIndex, 0, `${name}.lastIndex resets to 0 after replace`);
    }
  });

  it('no longer inlines the frontmatter strip and references all six reused consts', () => {
    assert.ok(READABILITY_START !== -1 && READABILITY_END > READABILITY_START, 'located the readability handler block');
    assert.ok(
      !READABILITY_BLOCK.includes("replace(/^---[\\s\\S]*?---/, '')"),
      'readability handler no longer rebuilds the inline frontmatter strip literal',
    );
    for (const name of REUSED_NAMES) {
      assert.ok(READABILITY_BLOCK.includes(name), `readability handler references ${name}`);
    }
  });

  it('keeps the three genuinely-different patterns inline (not over-deduped)', () => {
    // The punct class differs from KEYWORDS_PUNCT_RE (no backtick/parens/hyphen, strips to
    // '' not ' '); the sentence-split and word-split are unique to readability. None may be
    // swapped for the keywords consts.
    assert.ok(READABILITY_BLOCK.includes('[*_~>|'), 'punct class stays inline (differs from KEYWORDS_PUNCT_RE)');
    assert.ok(READABILITY_BLOCK.includes('/[.!?]+/'), 'sentence-split stays inline');
    assert.ok(READABILITY_BLOCK.includes('/\\s+/'), 'word-split stays inline');
    assert.ok(!READABILITY_BLOCK.includes('KEYWORDS_PUNCT_RE'), 'readability does not reuse KEYWORDS_PUNCT_RE (punct differs)');
    assert.ok(!READABILITY_BLOCK.includes('KEYWORDS_SPLIT_RE'), 'readability does not reuse KEYWORDS_SPLIT_RE (split differs)');
  });

  it('reuses the exact shared regex instances exported from the module', () => {
    // The six consts the readability handler now references are the same instances the
    // keywords handler uses, proving one shared compile backs both call sites.
    const second = require(SPECIFIER);
    for (const name of REUSED_NAMES) {
      assert.ok(routes[name] instanceof RegExp, `${name} is a RegExp`);
      assert.strictEqual(second[name], routes[name], `${name} is a single shared instance`);
    }
  });
});
