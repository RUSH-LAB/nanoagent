import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const ALLOWED_EXTS = ['.md', '.mdx'];

// Invoke a content-analysis-a route handler with a mocked ctx and capture the
// response handed to `json(res, status, payload)`. Fully in-process: no network,
// no server is started.
async function invoke({ pathname, search = '', ctx }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  let captured = null;
  const fullCtx = {
    json(_res, status, payload) { captured = { status, payload }; res.writableEnded = true; return captured; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return captured;
}

describe('GET /api/content-recommend-v2 (RECOMMEND_CITE_RE hoisted to module scope)', () => {
  // A real temp content dir, so the handler walks the genuine fs and runs the
  // module-scope RECOMMEND_CITE_RE over real files. Every body keeps its prose
  // words to 4 characters or fewer (all dropped by the length>4 keyword rule)
  // and carries no frontmatter tags, so tag and keyword scoring both contribute
  // 0 and the shared `[@key]` citations are the only positive signal. The
  // citation keys use a short (<=4 char) alpha run ("li2020", "wu2019") so their
  // split fragments ("li", "wu") never leak into the keyword set either.
  //
  //   source cites li2020 + wu2019              -> basedOn.citations = 2
  //   cand-a cites li2020          (overlap 1)  -> score 3, sharedCitations 1
  //   cand-b cites li2020 + wu2019 (overlap 2)  -> score 6, sharedCitations 2
  //
  // cand-b therefore outranks cand-a deterministically (6 > 3), independent of
  // readdir order.
  let tmpRoot;
  let ctx;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recommendv2-cite-'));
    const contentDir = path.join(tmpRoot, 'content');
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'source.md'), '---\ntitle: Source\n---\nsee [@li2020] and [@wu2019] now\n');
    fs.writeFileSync(path.join(contentDir, 'cand-a.md'), '---\ntitle: Cand A\n---\nref [@li2020] here\n');
    fs.writeFileSync(path.join(contentDir, 'cand-b.md'), '---\ntitle: Cand B\n---\nsee [@li2020] plus [@wu2019] too\n');
    ctx = { fs, path, PROJECT_ROOT: tmpRoot, ALLOWED_EXTS, isValidFilePath: () => true };
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const EXPECTED = {
    recommendations: [
      { path: 'content/cand-b.md', title: 'Cand B', score: 6, sharedTags: [], sharedCitations: 2 },
      { path: 'content/cand-a.md', title: 'Cand A', score: 3, sharedTags: [], sharedCitations: 1 },
    ],
    sourcePath: 'content/source.md',
    basedOn: { tags: 0, keywords: 0, citations: 2 },
  };

  it('ranks candidates by shared [@key] citations and reports sharedCitations', async () => {
    const r = await invoke({ pathname: '/api/content-recommend-v2', search: '?path=content/source.md', ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('returns identical results across two consecutive requests (shared module-scope regex stays consistent)', async () => {
    // RECOMMEND_CITE_RE is now shared module state instead of a fresh per-request
    // allocation, so this pins that two consecutive requests stay byte-identical.
    // The handler resets `lastIndex` to 0 before each exec loop as a defensive
    // guard against carryover; in this handler both loops always drain to null
    // (no early break), so exec() also auto-resets lastIndex to 0 and output is
    // stable regardless. This assertion is the regression pin for that stability.
    const first = await invoke({ pathname: '/api/content-recommend-v2', search: '?path=content/source.md', ctx });
    const second = await invoke({ pathname: '/api/content-recommend-v2', search: '?path=content/source.md', ctx });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(first.payload, EXPECTED);
    assert.deepEqual(second.payload, first.payload);
  });

  it('rejects an invalid path with 400', async () => {
    const r = await invoke({
      pathname: '/api/content-recommend-v2',
      search: '?path=../secret',
      ctx: { ...ctx, isValidFilePath: () => false },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid path' });
  });
});
