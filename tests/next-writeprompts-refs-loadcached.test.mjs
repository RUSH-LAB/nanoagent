import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const contentAnalysisCRoutes = require('../server/routes/content-analysis-c.js');
// loadReferencesCached memoizes in a module-level singleton; clear it between
// scenarios so each case re-stats and re-reads deterministically.
const { _resetReferencesCache } = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');
const CONTENT_DIR = path.join(PROJECT_ROOT, 'content');

// Two-entry fixture. With an empty content tree both stay uncited, so each
// becomes one 'uncited-reference' prompt in bibliography (insertion) order.
const REFS_YAML = `ref_a:
  title: First Paper
  author:
    - Ada Lovelace
  year: 2020
ref_b:
  title: Second Paper
  author:
    - Alan Turing
  year: 2021
`;

// Byte-exact prompt bodies the handler builds from REFS_YAML, with no cited
// content, no open research questions, and no low-quality pages in the tree.
const PROMPT_A = `Write about "First Paper" — it's in your bibliography but hasn't been cited yet.`;
const PROMPT_B = `Write about "Second Paper" — it's in your bibliography but hasn't been cited yet.`;

// An fs mock serving `yamlText` for references.yaml and `contentFiles` (a flat
// {name: contents} map) for the content directory. Every other path is ENOENT so
// a stray read surfaces instead of returning silent empty data. `reads` counts
// references.yaml reads only, so the memo can be asserted independently of the
// content scan (which reads its own files).
function makeFs(yamlText, contentFiles = {}) {
  const state = { reads: 0 };
  const names = Object.keys(contentFiles);
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  const fsMock = {
    statSync(fp) {
      if (fp === REFS_PATH) return { mtimeMs: 1, size: yamlText.length };
      return enoent(fp);
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) { state.reads++; return yamlText; }
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
  return { fsMock, state };
}

// Drive the real GET /api/writing-prompts handler over a mocked ctx and capture
// what it writes. The fs mock exposes statSync + readFileSync so the memo path in
// loadReferencesCached is exercised the way the live server hits it. research
// questions and low-quality scoring are neutralized (empty) so the assertions
// isolate the references-driven uncited-reference prompts.
async function runPrompts(fsMock, { questions = {} } = {}) {
  const out = {};
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: fsMock,
    ALLOWED_EXTS: ['.md', '.mdx'],
    loadJSON: () => questions,
    cached: (_key, _ttl, fn) => fn(),
    json: (_res, status, body) => { out.status = status; out.json = body; },
  };
  const pathname = '/api/writing-prompts';
  const url = new URL(`http://localhost${pathname}`);
  const res = {
    writableEnded: false,
    writeHead() {},
    end() { this.writableEnded = true; },
  };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await contentAnalysisCRoutes(req, res, url, pathname, ctx);
  return out;
}

describe('GET /api/writing-prompts (refs via loadReferencesCached)', () => {
  beforeEach(() => _resetReferencesCache());

  it('emits one uncited-reference prompt per entry, in bibliography order', async () => {
    const { fsMock } = makeFs(REFS_YAML);
    const out = await runPrompts(fsMock);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, {
      prompts: [
        { type: 'uncited-reference', prompt: PROMPT_A, key: 'ref_a' },
        { type: 'uncited-reference', prompt: PROMPT_B, key: 'ref_b' },
      ],
      total: 2,
    });
  });

  it('excludes references already cited in the content tree', async () => {
    // ref_a is cited via [@ref_a]; only ref_b remains uncited. The short file is
    // under the low-quality word threshold, so it adds no expand-content prompt.
    const { fsMock } = makeFs(REFS_YAML, { 'post.md': 'See [@ref_a] for details.' });
    const out = await runPrompts(fsMock);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, {
      prompts: [{ type: 'uncited-reference', prompt: PROMPT_B, key: 'ref_b' }],
      total: 1,
    });
  });

  it('memoizes the parse: a second request does not re-read references.yaml', async () => {
    const { fsMock, state } = makeFs(REFS_YAML);
    const first = await runPrompts(fsMock);
    const second = await runPrompts(fsMock);
    assert.equal(first.status, 200);
    assert.deepEqual(second.json, first.json);
    assert.equal(state.reads, 1, 'second request is served from the memo, not a re-read');
  });

  it('preserves the 500 fallback on a broken parse', async () => {
    const { fsMock } = makeFs('{ unclosed');
    const out = await runPrompts(fsMock);
    assert.equal(out.status, 500);
    assert.match(out.json.error, /Prompts generation failed/);
  });

  it('preserves the 500 fallback when references.yaml is missing', async () => {
    const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
    const out = await runPrompts({ statSync: enoent, readFileSync: enoent, readdirSync: enoent });
    assert.equal(out.status, 500);
    assert.match(out.json.error, /Prompts generation failed/);
  });

  it('returns prompts (200) with no uncited entries for an empty but valid bibliography', async () => {
    const { fsMock } = makeFs('{}');
    const out = await runPrompts(fsMock);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { prompts: [], total: 0 });
  });
});
