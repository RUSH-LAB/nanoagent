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

describe('GET /api/content-reading-path (READING_PATH_WIKI_RE hoisted to module scope)', () => {
  // A real temp content dir, so the handler walks the genuine fs and runs the
  // shared module-scope READING_PATH_WIKI_RE over real files. Three pages form an
  // unambiguous chain start -> middle -> end: every wiki-link target is the suffix
  // of exactly one file path, so link resolution never depends on fs.readdirSync
  // order, and the reading path is fully deterministic.
  //
  //   start.md  links to [[middle]]
  //   middle.md links to [[end|the end]]   (alias form exercises the |alias branch)
  //   end.md    has no outgoing links
  //
  // The regex is reset before each file's exec loop, so it is exercised across
  // multiple files within a single request as well as across requests.
  let tmpRoot;
  let ctx;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'readpath-wikire-'));
    const contentDir = path.join(tmpRoot, 'content');
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'start.md'), '---\ntitle: Start\n---\n\nStart here, then read [[middle]].\n');
    fs.writeFileSync(path.join(contentDir, 'middle.md'), '---\ntitle: Middle\n---\n\nContinue to [[end|the end]] when ready.\n');
    fs.writeFileSync(path.join(contentDir, 'end.md'), '---\ntitle: End\n---\n\nYou have arrived.\n');
    ctx = { fs, path, PROJECT_ROOT: tmpRoot, ALLOWED_EXTS, isValidFilePath: () => true };
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const EXPECTED = {
    startPath: 'content/start.md',
    readingPath: [
      { path: 'content/start.md', title: 'Start', depth: 0 },
      { path: 'content/middle.md', title: 'Middle', depth: 1 },
      { path: 'content/end.md', title: 'End', depth: 2 },
    ],
    totalPages: 3,
    maxDepthReached: 2,
  };

  it('walks the wiki-link chain and reports the reading path', async () => {
    const r = await invoke({ pathname: '/api/content-reading-path', search: '?start=content/start.md', ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, EXPECTED);
  });

  it('returns identical results across two consecutive requests (cross-request response stability)', async () => {
    // READING_PATH_WIKI_RE is now shared module state instead of a fresh per-request
    // allocation, so this pins that two consecutive requests stay byte-identical.
    // Note: this is a response-stability pin, not a true lastIndex-carryover guard.
    // The handler's exec loop always drains to null (no early break), and a /g regex
    // auto-resets lastIndex to 0 on a null exec result, so lastIndex is already 0 at
    // every loop boundary whether or not the explicit reset runs. The regex is not
    // exported, so there is no hook to assert on lastIndex directly. The explicit
    // `READING_PATH_WIKI_RE.lastIndex = 0` reset is kept as defensive hygiene against
    // any future early-break change that could otherwise strand a non-zero lastIndex.
    const first = await invoke({ pathname: '/api/content-reading-path', search: '?start=content/start.md', ctx });
    const second = await invoke({ pathname: '/api/content-reading-path', search: '?start=content/start.md', ctx });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(first.payload, EXPECTED);
    assert.deepEqual(second.payload, first.payload);
  });

  it('honors the depth cutoff (depth=0 yields only the start page)', async () => {
    const r = await invoke({ pathname: '/api/content-reading-path', search: '?start=content/start.md&depth=0', ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      startPath: 'content/start.md',
      readingPath: [{ path: 'content/start.md', title: 'Start', depth: 0 }],
      totalPages: 1,
      maxDepthReached: 0,
    });
  });

  it('rejects an invalid start path with 400', async () => {
    const r = await invoke({
      pathname: '/api/content-reading-path',
      search: '?start=../secret',
      ctx: { ...ctx, isValidFilePath: () => false },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload, { error: 'Invalid start path' });
  });
});
