import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// content-analysis-c.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-c.js');

// Fixture for GET /api/admin/health-summary. HEALTH_WIKI_LINK_RE was hoisted to
// module scope, so one shared instance now scans every file and every request.
// Both files carry wiki-links so the shared regex is exercised across files within
// a single request, and the handler resets HEALTH_WIKI_LINK_RE.lastIndex = 0
// before each file's exec loop.
//
// Each file holds one self-link and one missing-target link. Self-links resolve no
// matter the walk order (a page's id is added to the seen set before its own body is
// scanned), and the missing targets are never a page id nor a suffix of one, so they
// break no matter the order. That makes totalLinks/brokenLinks fully deterministic
// without depending on the platform-defined fs.readdirSync order.
const FIXTURE = {
  'target.md': `---
title: Target
tags: [demo]
---

# Target

This canonical note links to [[target]] and to [[missing-alpha]].
`,
  'hub.md': `---
title: Hub
---

See [[hub]] for the index and [[missing-beta]] which does not exist.
`,
};

// Hand-computed link-health stats for the fixture above:
//   • 2 files, both with a title; only target.md carries tags.
//   • 4 wiki-links total ([[target]], [[missing-alpha]], [[hub]], [[missing-beta]]).
//   • 2 broken (the two missing-* targets); the self-links resolve.
//   • linkHealth = round(((4 - 2) / 4) * 20) = 10.
const EXPECTED_STATS = { totalFiles: 2, filesWithTitle: 2, filesWithTags: 1, totalLinks: 4, brokenLinks: 2 };
const EXPECTED_LINK_HEALTH = 10;

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'healthsum-hoist-wikire-'));
  for (const [rel, body] of Object.entries(FIXTURE)) {
    const full = path.join(root, 'content', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Drive the real GET /api/admin/health-summary handler over the fixture content
// dir and return the captured json() response.
async function runHealthSummary() {
  let captured = null;
  const ctx = {
    fs, path,
    PROJECT_ROOT: root,
    ALLOWED_EXTS: ['.md', '.mdx'],
    // The handler now wraps its scan in cached(key, ttl, fn). Inject a pass-through
    // so this guard keeps re-running the real scan on every call (its back-to-back
    // and stale-lastIndex assertions depend on the scan actually executing), which
    // preserves this test's behavior exactly as before the cache wrap.
    cached: (_k, _t, fn) => fn(),
    json: (_res, status, payload) => { captured = { status, payload }; },
  };
  const url = new URL('http://localhost/api/admin/health-summary');
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, '/api/admin/health-summary', ctx);
  return captured;
}

describe('GET /api/admin/health-summary (hoisted module-scope HEALTH_WIKI_LINK_RE)', () => {
  it('reports the expected link-health stats over the fixture', async () => {
    const { status, payload } = await runHealthSummary();
    assert.equal(status, 200);
    assert.deepEqual(payload.stats, {
      ...EXPECTED_STATS,
      totalWords: payload.stats.totalWords, // word count is incidental to this guard
    });
    assert.equal(payload.breakdown.linkHealth, EXPECTED_LINK_HEALTH);
  });

  it('returns identical stats on two back-to-back calls (no stale lastIndex bleed)', async () => {
    const first = await runHealthSummary();
    const second = await runHealthSummary();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // The shared module-scope regex is reset before each file's exec loop, so a
    // second request over the same content produces a byte-identical payload. If a
    // future change leaked lastIndex across requests, the second pass would miss
    // leading links and the link-health stats would drift.
    assert.deepEqual(second.payload, first.payload);
    assert.deepEqual(second.payload.stats, { ...EXPECTED_STATS, totalWords: second.payload.stats.totalWords });
  });

  it('stays correct when HEALTH_WIKI_LINK_RE carries a stale lastIndex (per-file reset is load-bearing)', async () => {
    // The handler resets HEALTH_WIKI_LINK_RE.lastIndex to 0 before each file's exec
    // loop. Pre-seed a large lastIndex to simulate state leaking in from a prior
    // request, then confirm the link counts are unaffected. Without the reset, the
    // first file walked would start its scan past its own content, exec would return
    // null at once, and that file's links would silently vanish, dropping totalLinks
    // below 4 and brokenLinks below 2. This proves the reset, not the loop's natural
    // drain-to-null, is what guarantees correctness against a leaked lastIndex.
    // (linkHealth is deliberately not asserted here: with this symmetric fixture a
    // dropped file leaves a 1/2 broken ratio, so the score stays 10 either way and
    // would not flag the regression. totalLinks/brokenLinks discriminate it.)
    assert.ok(routes.HEALTH_WIKI_LINK_RE instanceof RegExp, 'handler regex is exported for this guard');
    routes.HEALTH_WIKI_LINK_RE.lastIndex = 100000;
    const { status, payload } = await runHealthSummary();
    assert.equal(status, 200);
    assert.equal(payload.stats.totalLinks, EXPECTED_STATS.totalLinks);
    assert.equal(payload.stats.brokenLinks, EXPECTED_STATS.brokenLinks);
  });
});
