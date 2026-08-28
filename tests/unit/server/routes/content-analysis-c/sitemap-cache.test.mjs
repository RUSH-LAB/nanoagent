import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other server route
// tests do.
const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/content-analysis-c.js');

// A real TTL memo standing in for ctx.cached. It runs the thunk only on a miss
// and records how many times each key's thunk actually executes, so a test can
// assert the 'sitemap-xml' scan runs exactly once across two requests.
function makeCountingCache() {
  const store = {};
  const runs = {};
  function cached(key, ttlMs, fn) {
    const entry = store[key];
    if (entry && Date.now() - entry.time < ttlMs) return entry.data;
    runs[key] = (runs[key] || 0) + 1;
    const data = fn();
    store[key] = { data, time: Date.now() };
    return data;
  }
  cached.runs = runs;
  return cached;
}

// Drive the GET /api/sitemap.xml handler with a mocked ctx and capture the XML
// body it streams through res.writeHead / res.end. The json fallback records the
// error path so a thrown handler surfaces as a failed assertion rather than
// silence.
async function invokeSitemap(ctx) {
  const pathname = '/api/sitemap.xml';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  let status = null, headers = null, body = null, errored = null;
  const res = {
    writableEnded: false,
    writeHead(s, h) { status = s; headers = h; },
    end(b) { this.writableEnded = true; body = b; return this; },
  };
  const fullCtx = {
    json(_res, s, payload) { errored = { status: s, payload }; res.writableEnded = true; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { status, headers, body, errored };
}

// Independent reference walk of the same content tree, mirroring the handler's
// traversal (depth-first in readdir order, same dot/underscore/extension
// filters, same path transforms and mtime slicing) WITHOUT going through cached.
// The handler must emit a document byte identical to the string returned here.
//
// The path-transform regex below is intentionally a verbatim copy of the
// handler's, so this stays a faithful mirror of the traversal. That makes the
// byte-identity check (test 2) a structural oracle rather than a fully
// independent one; the third test backstops it by asserting literal loc strings
// computed without this regex, so a shared-regex bug would still surface.
function directSitemapXml(projectRoot, allowedExts) {
  const contentDir = path.join(projectRoot, 'content');
  const urls = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(fp); continue; }
      if (!allowedExts.some(ext => entry.name.endsWith(ext))) continue;
      const stat = fs.statSync(fp);
      let urlPath = '/' + path.relative(contentDir, fp)
        .replace(/\.(mdx?|md)$/, '').replace(/\\/g, '/');
      if (urlPath.endsWith('/index')) urlPath = urlPath.slice(0, -6);
      urls.push({ loc: urlPath, lastmod: stat.mtime.toISOString().slice(0, 10) });
    }
  }
  scan(contentDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `<url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>`;
}

describe('GET /api/sitemap.xml caches its content-tree walk', () => {
  let tmpRoot;
  const ALLOWED_EXTS = ['.md', '.mdx'];
  const CORS_ORIGIN = '*';
  // Fixed epoch seconds so each <lastmod> is wall-clock and timezone independent
  // (toISOString is UTC). Files are stamped one day apart to prove per-file
  // lastmod fidelity, not a single shared date.
  const BASE = 1700000000; // 2023-11-14T22:13:20Z
  const DAY = 86400;
  const dateOf = secs => new Date(secs * 1000).toISOString().slice(0, 10);
  const ctxBase = () => ({
    fs,
    path,
    PROJECT_ROOT: tmpRoot,
    ALLOWED_EXTS,
    CORS_ORIGIN,
  });

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-cache-'));
    const contentDir = path.join(tmpRoot, 'content');
    fs.mkdirSync(path.join(contentDir, 'guide'), { recursive: true });
    // A root page, an .mdx page, a nested page, and a nested index page that
    // exercises the `/index` suffix stripping (guide/index -> /guide).
    const files = [
      ['about.md', 0],
      ['intro.mdx', 1],
      ['guide/setup.md', 2],
      ['guide/index.md', 3],
    ];
    for (const [rel, dayOffset] of files) {
      const fp = path.join(contentDir, rel);
      fs.writeFileSync(fp, `---\ntitle: "${rel}"\n---\n\nBody of ${rel}\n`, 'utf-8');
      const t = BASE + dayOffset * DAY;
      fs.utimesSync(fp, t, t);
    }
    // Decoys the walk must skip: a dot file, an underscore file, and a
    // non-markdown file, each stamped newest so a broken filter would surface
    // them in the output.
    const newest = BASE + 100 * DAY;
    for (const name of ['.hidden.md', '_draft.md', 'notes.txt']) {
      const fp = path.join(contentDir, name);
      fs.writeFileSync(fp, `decoy ${name}\n`, 'utf-8');
      fs.utimesSync(fp, newest, newest);
    }
  });

  after(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('walks the content tree exactly once across two successive requests', async () => {
    const cached = makeCountingCache();
    const ctx = { ...ctxBase(), cached };

    const first = await invokeSitemap(ctx);
    const second = await invokeSitemap(ctx);

    assert.equal(first.errored, null, 'first request stayed off the error path');
    assert.equal(second.errored, null, 'second request stayed off the error path');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    assert.equal(cached.runs['sitemap-xml'], 1, 'the scan thunk ran exactly once for both requests');
    assert.deepEqual(Object.keys(cached.runs), ['sitemap-xml'], 'only the sitemap-xml scan ran');
    assert.equal(first.body, second.body, 'both requests serve the identical cached document');
  });

  it('emits XML byte identical to a direct walk of the same content tree', async () => {
    // Fixtures are stamped once in before() and never re-touched, so building the
    // reference before invoking the handler reads the same mtimes both walks see.
    const referenceXml = directSitemapXml(tmpRoot, ALLOWED_EXTS);
    const ctx = { ...ctxBase(), cached: makeCountingCache() };
    const { status, headers, body } = await invokeSitemap(ctx);

    assert.equal(status, 200);
    assert.equal(body, referenceXml, 'body matches the direct walk byte for byte');
    assert.equal(headers['Content-Type'], 'application/xml; charset=utf-8', 'XML content type preserved');
    assert.equal(headers['Access-Control-Allow-Origin'], CORS_ORIGIN, 'CORS header preserved');
  });

  it('renders each loc and lastmod and skips dot, underscore, and non-md files', async () => {
    const ctx = { ...ctxBase(), cached: makeCountingCache() };
    const { body } = await invokeSitemap(ctx);

    // Concrete url lines (independent of the reference walk) catch a shared-logic
    // bug the byte-identity check alone could miss.
    assert.ok(body.includes(`<url><loc>/about</loc><lastmod>${dateOf(BASE)}</lastmod></url>`), 'root .md page present');
    assert.ok(body.includes(`<url><loc>/intro</loc><lastmod>${dateOf(BASE + DAY)}</lastmod></url>`), '.mdx extension stripped');
    assert.ok(body.includes(`<url><loc>/guide/setup</loc><lastmod>${dateOf(BASE + 2 * DAY)}</lastmod></url>`), 'nested page recursed into');
    assert.ok(body.includes(`<url><loc>/guide</loc><lastmod>${dateOf(BASE + 3 * DAY)}</lastmod></url>`), 'guide/index collapsed to /guide');

    assert.equal((body.match(/<url>/g) || []).length, 4, 'exactly the four real pages, decoys excluded');
    assert.ok(!body.includes('hidden'), 'dot file skipped');
    assert.ok(!body.includes('draft'), 'underscore file skipped');
    assert.ok(!body.includes('notes'), 'non-markdown file skipped');
  });
});
