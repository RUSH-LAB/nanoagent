import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the sibling route tests do.
const require = createRequire(import.meta.url);
const contentAnalysisCRoutes = require('../server/routes/content-analysis-c.js');
// loadReferencesCached memoizes the parsed bibliography in a module-level singleton;
// clear it before each scenario so every case re-stats and re-reads deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');
const RQ_FILE = path.join(PROJECT_ROOT, 'data', 'research-questions.json');

// The handler interpolates a literal em-dash (U+2014, bytes e2 80 94) into the
// uncited-reference and expand-content prompt strings. Pin that exact code point in one
// place so the expected strings below cannot drift to a look-alike dash (en-dash,
// minus sign) and every prompt assertion stays byte-for-byte faithful to the source.
const EM = '—';

// Build a body of exactly n whitespace-delimited words. The tokens carry no front
// matter and no "[@" citation markers, so the low-quality scan counts precisely n words
// and the expand-content title falls back to the file name.
function body(n) {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

// A markdown file with a YAML front-matter title plus an n-word body. The front-matter
// block adds four whitespace tokens (the two fences, "title:", and a single-word title),
// so the scanned word count is n + 4. Use only a one-word title to keep that count exact.
function withFrontMatterTitle(title, n) {
  return `---\ntitle: ${title}\n---\n${body(n)}`;
}

// An in-memory fs serving `yamlText` for references.yaml and `contentFiles` (a flat
// {name: contents} map) for the content directory. Every other path throws ENOENT so a
// stray read surfaces instead of returning silent empty data. Mirrors the fixture fs in
// next-writeprompts-refs-loadcached.test.mjs.
//
// Passing '{}' as yamlText gives an empty bibliography, which routes the handler through
// its empty-refs re-read guard (content-analysis-c.js:649): that read re-parses '{}'
// cleanly and falls through with refs = {}. The cache, memo, and 500-on-broken-parse
// semantics of that guard are already pinned by the sibling refs-loadcached test, so the
// cases here only need it to yield zero uncited-reference prompts.
function makeFs(yamlText, contentFiles = {}) {
  const names = Object.keys(contentFiles);
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  return {
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: yamlText.length };
      return enoent(fp);
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) return yamlText;
      for (const n of names) {
        if (fp === path.join(CONTENT_DIR, n)) return contentFiles[n];
      }
      return enoent(fp);
    },
    readdirSync(fp) {
      if (fp === CONTENT_DIR) return names.map(n => ({ name: n, isDirectory: () => false }));
      return enoent(fp);
    },
  };
}

// Drive the real GET /api/writing-prompts handler over a mocked ctx and capture both the
// json() response and the arguments the handler passed to loadJSON and cached. The cached
// stub is a pass-through producer so the low-quality scan executes for real; the loadJSON
// stub returns the supplied research-questions payload for whatever path it is asked for.
async function runPrompts(fsMock, { questions = {} } = {}) {
  const out = {};
  const calls = { loadJSONArgs: [], cacheCalls: [] };
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    ALLOWED_EXTS: ['.md', '.mdx'],
    loadJSON: (file) => { calls.loadJSONArgs.push(file); return questions; },
    cached: (key, ttl, fn) => { calls.cacheCalls.push({ key, ttl }); return fn(); },
    json: (_res, status, jsonBody) => { out.status = status; out.json = jsonBody; },
  };
  const pathname = '/api/writing-prompts';
  const url = new URL(`http://localhost${pathname}`);
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await contentAnalysisCRoutes(req, res, url, pathname, ctx);
  return { out, calls };
}

describe('GET /api/writing-prompts (research-question and expand-content branches)', () => {
  beforeEach(() => _resetReferencesCache());

  it('emits the three prompt types in a fixed order with a combined total', async () => {
    // One cited plus one uncited reference yields a single uncited-reference prompt.
    const REFS_YAML = `cited_ref:
  title: A Cited Work
  year: 2020
uncited_ref:
  title: An Uncited Work
  year: 2021
`;
    // cited.md cites cited_ref and is too short to count as low quality (four words). The
    // two expand files are inserted largest-first so a correct ascending sort has to
    // reorder them; healthy.md has 120 words, above the low-quality ceiling, so it adds
    // nothing. The expand titles come from front matter and from the file name in turn.
    const content = {
      'cited.md': 'Refers to [@cited_ref] here.',
      'expand-from-fm.md': withFrontMatterTitle('Polished', 18), // 22 words, title from front matter
      'expand-from-filename.md': body(12),                       // 12 words, title from file name
      'healthy.md': body(120),
    };
    const questions = { questions: [
      { status: 'open', question: 'How does X work?', id: 'q-open-1' },
      { status: 'resolved', question: 'Already answered', id: 'q-res' },
      { status: 'open', question: 'Why does Y happen?', id: 'q-open-2' },
    ] };
    const { out, calls } = await runPrompts(makeFs(REFS_YAML, content), { questions });

    assert.equal(out.status, 200);
    assert.deepStrictEqual(out.json, {
      prompts: [
        { type: 'uncited-reference', prompt: `Write about "An Uncited Work" ${EM} it's in your bibliography but hasn't been cited yet.`, key: 'uncited_ref' },
        { type: 'research-question', prompt: 'Explore: "How does X work?"', id: 'q-open-1' },
        { type: 'research-question', prompt: 'Explore: "Why does Y happen?"', id: 'q-open-2' },
        { type: 'expand-content', prompt: `"expand-from-filename" only has 12 words ${EM} expand it!`, path: 'content/expand-from-filename.md' },
        { type: 'expand-content', prompt: `"Polished" only has 22 words ${EM} expand it!`, path: 'content/expand-from-fm.md' },
      ],
      total: 5,
    });
    // The research-question branch reads data/research-questions.json through loadJSON.
    assert.deepStrictEqual(calls.loadJSONArgs, [RQ_FILE]);
  });

  it('keeps only open research questions and caps them at three', async () => {
    const questions = { questions: [
      { status: 'open', question: 'Q one', id: 'q1' },
      { status: 'open', question: 'Q two', id: 'q2' },
      { status: 'resolved', question: 'Q resolved', id: 'qR' },
      { status: 'open', question: 'Q three', id: 'q3' },
      { status: 'closed', question: 'Q closed', id: 'qC' },
      { status: 'open', question: 'Q four', id: 'q4' },
    ] };
    // An empty bibliography and an empty content tree isolate the research-question
    // branch: the open questions filter to four, then slice(0, 3) drops the last one.
    const { out } = await runPrompts(makeFs('{}', {}), { questions });
    assert.equal(out.status, 200);
    assert.deepStrictEqual(out.json, {
      prompts: [
        { type: 'research-question', prompt: 'Explore: "Q one"', id: 'q1' },
        { type: 'research-question', prompt: 'Explore: "Q two"', id: 'q2' },
        { type: 'research-question', prompt: 'Explore: "Q three"', id: 'q3' },
      ],
      total: 3,
    });
  });

  it('keeps only pages with 10 < words < 100, sorted ascending by word count', async () => {
    // 10 and 100 sit on the excluded side of the strict bounds; 11 and 99 are kept. Files
    // are inserted largest-first so the ascending sort must reorder them in the output.
    const content = {
      'w100.md': body(100),
      'w99.md': body(99),
      'w11.md': body(11),
      'w10.md': body(10),
    };
    const { out, calls } = await runPrompts(makeFs('{}', content), { questions: {} });
    assert.equal(out.status, 200);
    assert.deepStrictEqual(out.json, {
      prompts: [
        { type: 'expand-content', prompt: `"w11" only has 11 words ${EM} expand it!`, path: 'content/w11.md' },
        { type: 'expand-content', prompt: `"w99" only has 99 words ${EM} expand it!`, path: 'content/w99.md' },
      ],
      total: 2,
    });
    // The low-quality scan is wrapped in cached('low-quality-pages', 60000, ...).
    assert.deepStrictEqual(calls.cacheCalls, [{ key: 'low-quality-pages', ttl: 60000 }]);
  });

  it('caps expand-content at the five lowest-word pages after sorting', async () => {
    // Six low-quality pages, read largest-first; the sort runs before the slice, so the
    // five smallest survive and the 60-word page is dropped despite being read first.
    const counts = [60, 50, 40, 30, 20, 15];
    const content = {};
    for (const n of counts) content[`p${n}.md`] = body(n);
    const { out } = await runPrompts(makeFs('{}', content), { questions: {} });
    assert.equal(out.status, 200);
    const expected = [15, 20, 30, 40, 50].map(w => ({
      type: 'expand-content',
      prompt: `"p${w}" only has ${w} words ${EM} expand it!`,
      path: `content/p${w}.md`,
    }));
    assert.deepStrictEqual(out.json, { prompts: expected, total: 5 });
  });
});
