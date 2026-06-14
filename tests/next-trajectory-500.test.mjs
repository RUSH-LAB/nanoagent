import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load the real module via createRequire the
// way the sibling cached-first route suites in this same module do
// (next-pagerank-500, next-citedensity-500), so this characterization test drives
// the genuine GET /api/references/trajectory handler instead of a reimplementation.
//
// It pins that handler's OUTER CATCH. The handler clears two guards before the
// failing region: a pre-try `if (!key) return json(res, 400, {error: 'Missing
// key'})` (content-analysis-a.js:1057) and an in-try `if (!refs[key]) return
// json(res, 404, {error: 'Reference not found'})` (:1060). The try opens at :1058;
// `const refs = loadReferencesCached(fs, path, PROJECT_ROOT)` at :1059; the per-key
// memo `cached('trajectory:' + key, 60000, () => {…})` at :1069; the closure's
// first op is the content-tree walk `for (const entry of fs.readdirSync(dir,
// {withFileTypes: true}))` at :1074, OUTSIDE the closure's inner try/catch
// (:1079-1095, which wraps only the per-file readFileSync/statSync/front-matter
// parse); the success path `json(res, 200, {key, title: refs[key].title,
// trajectory, totalCitations})` at :1102; the outer catch at :1103-1104 returns
// `json(res, 500, {error: 'Trajectory analysis failed'})`.
//
// loadReferencesCached is the swallowing bibliography loader (server/routes/
// references.js): a missing or broken references.yaml makes it return {} rather
// than throw, which would surface as the 404, never the 500. So this test does NOT
// rely on that loader failing; it feeds the loader a VALID references.yaml (a
// throwing statSync that skips its mtime/size memo, plus a readFileSync returning
// 'K:\n  title: T\n', which js-yaml parses to {K: {title: 'T'}}) so refs['K'] is
// truthy and the 404 is bypassed, then steers the failure into the region AFTER
// both guards via the two seams below.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

const PROJECT_ROOT = '/virtual-root';

// The single citation key driven through the handler. The per-key memo key is the
// static 'trajectory:' + KEY, so it is clock-independent; the only date use in the
// handler is the per-file stat.mtime on the success path, which these 500 tests
// never reach.
const KEY = 'K';
const TRAJECTORY_CACHE_KEY = 'trajectory:' + KEY; // 'trajectory:K'

// references.yaml fed to loadReferencesCached so refs['K'] is seeded truthy and
// the 404 'Reference not found' guard is bypassed. js-yaml parses this to
// {K: {title: 'T'}}, the same parse the loader runs internally via its own
// require('js-yaml').
const REFERENCES_YAML = 'K:\n  title: T\n';

// The exact reply the outer catch emits, captured in the {status, body} shape used
// by the json() stub below.
const GOLDEN_500 = { status: 500, body: { error: 'Trajectory analysis failed' } };

// The 200 projection at :1102 is {key, title: refs[key].title, trajectory,
// totalCitations}; its distinctive fields are title/trajectory/totalCitations
// (`key` merely echoes the query param). The never-reached proof asserts that none
// of these surfaces in any captured reply.
const SUCCESS_KEYS = ['title', 'trajectory', 'totalCitations'];

// A cached() that throws synchronously, modelling a failure of the memo layer
// itself: the scan closure is never invoked, so the throw at the
// cached('trajectory:' + key, …) call (content-analysis-a.js:1069) lands directly
// in the outer catch.
function throwingCached() {
  return () => { throw new Error('cache layer unavailable'); };
}

// A faithful pass-through cached(key, ttl, fn) that actually runs the closure, the
// way the live memo does on a cold key. Paired with a throwing fs.readdirSync so
// the failure comes from INSIDE the scan closure (its first directory walk) yet
// still reaches the SAME outer catch, proving the 500 is independent of where in
// the try the throw originates.
function passthroughCached() {
  return (_key, _ttl, fn) => fn();
}

// fs for the cache-throw seam (a). statSync THROWS so loadReferencesCached skips
// its mtime/size memo and re-reads the file fresh; readFileSync serves the seeded
// references.yaml the loader reads; readdirSync RECORDS its calls and returns an
// empty listing. Because cached() throws before invoking the scan closure,
// readdirSync must stay uncalled (readdirCalls === 0).
function recordingFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    statSync() { throw new Error('stat unavailable'); },
    readFileSync() { return REFERENCES_YAML; },
    readdirSync() { readdirCalls++; return []; },
  };
}

// fs for the in-closure seam (b). Same loader seams (throwing statSync, seeded
// references.yaml from readFileSync), but readdirSync THROWS on its first call —
// the scan closure's walk of PROJECT_ROOT/content at content-analysis-a.js:1074,
// which sits in the for…of header OUTSIDE the per-file inner try/catch
// (:1079-1095). The throw therefore escapes the closure and the cached() call and
// lands in the SAME outer catch as the cache-throw seam.
function throwingReaddirFs() {
  let readdirCalls = 0;
  return {
    get readdirCalls() { return readdirCalls; },
    statSync() { throw new Error('stat unavailable'); },
    readFileSync() { return REFERENCES_YAML; },
    readdirSync() { readdirCalls++; throw new Error('content dir unreadable'); },
  };
}

// Drive the real GET /api/references/trajectory?key=K handler over a mocked ctx.
// The caller supplies the two seams used to steer the post-guard region into the
// outer catch: `cached` and `fs`. Every json(res, status, payload) write is
// captured in `replies` so a test can assert the 500 is the ONLY reply and neither
// guard nor the success projection fired; every cached(key, ttl) invocation is
// recorded so a test can prove the throw originates at the one memo call this
// route reaches.
async function runTrajectory({ cached, fs }) {
  const replies = [];
  const cachedCalls = [];
  const ctx = {
    json(_res, status, payload) { const r = { status, body: payload }; replies.push(r); return r; },
    cached(key, ttl, fn) { cachedCalls.push([key, ttl]); return cached(key, ttl, fn); },
    fs,
    path,
    PROJECT_ROOT,
    ALLOWED_EXTS: ['.md', '.mdx'],
  };
  const pathname = '/api/references/trajectory';
  const url = new URL(`http://localhost${pathname}?key=${encodeURIComponent(KEY)}`);
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = { writableEnded: false };
  await routes(req, res, url, pathname, ctx);
  return { replies, cachedCalls };
}

// The invariant both seams must satisfy: the handler emits EXACTLY the outer
// catch's lone 500, neither pre-failure guard fired (no 400 'Missing key' because
// ?key=K is present, no 404 'Reference not found' because refs['K'] is seeded
// truthy), and the success 200 projection never surfaced. The replies.length === 1
// check anchors the never-reached proof so it cannot pass vacuously on an empty
// replies array.
function assertLone500NeitherGuard(replies) {
  assert.equal(replies.length, 1);
  assert.deepStrictEqual(replies[0], GOLDEN_500);
  assert.equal(replies.some((r) => r.status === 200), false, 'success 200 must never be emitted');
  assert.equal(replies.some((r) => r.status === 400), false, 'the Missing key 400 guard must not fire');
  assert.equal(replies.some((r) => r.status === 404), false, 'the Reference not found 404 guard must not fire');
  assert.equal(
    replies.some((r) => r.body && SUCCESS_KEYS.some((k) => k in r.body)),
    false,
    'no reply carries the 200 projection fields title/trajectory/totalCitations',
  );
}

describe('GET /api/references/trajectory outer catch returns 500 Trajectory analysis failed', () => {
  it('seam (a): a throw from the cached(trajectory:K) memo call lands in the outer catch as the lone 500, content tree never walked', async () => {
    const fs = recordingFs();
    const { replies, cachedCalls } = await runTrajectory({ cached: throwingCached(), fs });

    // The lone reply is the catch's 500, and neither guard nor the success
    // projection fired.
    assertLone500NeitherGuard(replies);

    // The throw originates at the one memo call the handler reaches after both
    // guards: cached('trajectory:K', 60000, fn).
    assert.deepStrictEqual(cachedCalls, [[TRAJECTORY_CACHE_KEY, 60000]]);

    // cached threw before invoking the closure, so the content tree was never
    // walked (no readdirSync).
    assert.equal(fs.readdirCalls, 0, 'the scan closure never ran (no readdirSync)');
  });

  it('seam (a): never emits the success 200 {key, title, trajectory, totalCitations} projection and fires neither guard', async () => {
    const { replies } = await runTrajectory({ cached: throwingCached(), fs: recordingFs() });

    // Anchored never-reached proof: exactly the lone 500, no 200/400/404, and none
    // of the projection's distinctive fields in any reply body.
    assertLone500NeitherGuard(replies);
  });

  it('seam (b): returns the same lone 500 when the throw comes from INSIDE the scan closure (fs.readdirSync), with cached running it', async () => {
    const fs = throwingReaddirFs();
    const { replies, cachedCalls } = await runTrajectory({ cached: passthroughCached(), fs });

    // The pass-through cached runs the closure, whose first directory walk hits the
    // throwing readdirSync; the throw escapes the closure (the inner try/catch
    // wraps only the per-file read) and lands in the SAME outer catch as seam (a).
    assert.deepStrictEqual(cachedCalls, [[TRAJECTORY_CACHE_KEY, 60000]]);
    assert.ok(fs.readdirCalls > 0, 'the scan closure entered and walked the content dir');
    assertLone500NeitherGuard(replies);
  });
});
