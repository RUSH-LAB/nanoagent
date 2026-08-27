import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// misc-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const miscToolsRoutes = require('../../../../../server/routes/misc-tools.js');
// GET /api/suggest now reads references.yaml through the shared loadReferencesCached
// memo (a module-level singleton); clear it between scenarios so each case
// re-stats and re-reads deterministically.
const { _resetReferencesCache } = require('../../../../../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'content', 'bibliography', 'references.yaml');

// Two-entry bibliography. For the query "attention transformer" only the first
// entry matches (its title carries "attention"); the second overlaps no keyword,
// so the references list is a single, deterministic record.
const REFS_YAML = [
  'vaswani2017:',
  '  title: Attention Is All You Need',
  '  author:',
  '    - Ashish Vaswani',
  'goodfellow2016:',
  '  title: Deep Learning',
  '  author:',
  '    - Ian Goodfellow',
  '',
].join('\n');

// Updated bibliography used to prove freshness: goodfellow2016's title now carries
// "transformer", so on a re-read it joins the matches.
const REFS_YAML_V2 = [
  'vaswani2017:',
  '  title: Attention Is All You Need',
  '  author:',
  '    - Ashish Vaswani',
  'goodfellow2016:',
  '  title: Transformer Architectures',
  '  author:',
  '    - Ian Goodfellow',
  '',
].join('\n');

// A mutable fs mock serving `state.yaml` for references.yaml with a stat that
// carries mtimeMs and size, so the loadReferencesCached memo path runs the way
// the live server hits it. `state.reads` counts references.yaml reads only, so the
// memo can be asserted independently of any other file access. The content dir is
// reported absent so the handler skips its page scan and the references
// contribution stays isolated. Set `state.yaml = null` to simulate a missing file
// (both stat and read raise ENOENT).
function makeFs(initialYaml, { mtimeMs = 1 } = {}) {
  const state = { reads: 0, yaml: initialYaml, mtimeMs };
  const enoent = (fp) => { const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e; };
  const fs = {
    statSync(fp) {
      if (fp === REFS_PATH) {
        if (state.yaml === null) return enoent(fp);
        return { mtimeMs: state.mtimeMs, size: Buffer.byteLength(state.yaml) };
      }
      return enoent(fp);
    },
    readFileSync(fp) {
      if (fp === REFS_PATH) {
        if (state.yaml === null) return enoent(fp);
        state.reads++;
        return state.yaml;
      }
      return enoent(fp);
    },
    existsSync() {
      return false; // no content dir, so the page scan is skipped
    },
  };
  return { fs, state };
}

// Drive the real GET /api/suggest handler over a mocked ctx and capture what it
// hands to json(res, status, payload).
async function callSuggest(fs, text, extra = '') {
  const pathname = '/api/suggest';
  const url = new URL(`http://localhost${pathname}?text=${encodeURIComponent(text)}${extra}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const ctx = {
    fs,
    path,
    PROJECT_ROOT,
    flatFiles: () => [],
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
  };
  await miscToolsRoutes(req, res, url, pathname, ctx);
  return captured;
}

describe('GET /api/suggest (references via loadReferencesCached)', () => {
  beforeEach(() => _resetReferencesCache());

  it('matches references for a populated bibliography', async () => {
    const { fs } = makeFs(REFS_YAML);
    const r = await callSuggest(fs, 'attention transformer');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      references: [{ key: 'vaswani2017', title: 'Attention Is All You Need', relevance: 1 }],
      pages: [],
    });
  });

  it('parses references.yaml once across two identical requests (memo proven)', async () => {
    const { fs, state } = makeFs(REFS_YAML);
    const first = await callSuggest(fs, 'attention transformer');
    const second = await callSuggest(fs, 'attention transformer');
    assert.equal(first.status, 200);
    // Byte-identical output across the two requests, served from one parse.
    assert.deepEqual(second.payload, first.payload);
    assert.equal(state.reads, 1, 'second request is served from the memo, not a re-read');
  });

  it('re-reads when mtime and size change (freshness preserved)', async () => {
    const { fs, state } = makeFs(REFS_YAML);
    const before = await callSuggest(fs, 'attention transformer');
    assert.deepEqual(before.payload.references, [
      { key: 'vaswani2017', title: 'Attention Is All You Need', relevance: 1 },
    ]);
    assert.equal(state.reads, 1);

    // Rewrite the bibliography: new content (different size) at a new mtime.
    state.yaml = REFS_YAML_V2;
    state.mtimeMs = 2;
    const after = await callSuggest(fs, 'attention transformer');
    assert.equal(state.reads, 2, 'a changed file is re-read, not served stale');
    // goodfellow2016 now carries "transformer" and joins the matches.
    assert.deepEqual(after.payload.references, [
      { key: 'vaswani2017', title: 'Attention Is All You Need', relevance: 1 },
      { key: 'goodfellow2016', title: 'Transformer Architectures', relevance: 1 },
    ]);
  });

  it('returns 200 with no reference matches for a broken bibliography', async () => {
    const { fs } = makeFs('{ this: [is, unclosed');
    const r = await callSuggest(fs, 'attention transformer');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { references: [], pages: [] });
  });

  it('returns 200 with no reference matches when references.yaml is missing', async () => {
    const { fs } = makeFs(null); // both stat and read raise ENOENT
    const r = await callSuggest(fs, 'attention transformer');
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { references: [], pages: [] });
  });
});
