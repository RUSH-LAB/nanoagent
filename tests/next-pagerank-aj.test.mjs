import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// content-analysis-a.js is CommonJS; load it the way the sibling route tests do.
const require = createRequire(import.meta.url);
const routes = require('../server/routes/content-analysis-a.js');

// A small bibliography exercising five references. alpha2020 is the co-citation
// hub, beta/gamma/delta are co-cited with decreasing connectivity, and
// epsilon2017 is never cited so it must settle at the PageRank floor.
const REFS_YAML =
  'alpha2020:\n' +
  '  title: Alpha Networks\n' +
  '  year: 2020\n' +
  '  venue: NeurIPS\n' +
  'beta2021:\n' +
  '  title: Beta Methods\n' +
  '  year: 2021\n' +
  '  venue: ICML\n' +
  'gamma2019:\n' +
  '  title: Gamma Theory\n' +
  '  year: 2019\n' +
  '  venue: ICLR\n' +
  'delta2018:\n' +
  '  title: Delta Systems\n' +
  '  year: 2018\n' +
  '  venue: JMLR\n' +
  'epsilon2017:\n' +
  '  title: Epsilon Foundations\n' +
  '  year: 2017\n' +
  '  venue: COLT\n';

// Three pages, each co-citing two or more keys on a single line so the inner
// O(n^2) co-occurrence loop (the exact code path the arr[j] hoist touches)
// actually runs. page1 co-cites three keys, so it emits every cross term among
// them.
//   alpha+beta: 2 (page1, page3)   alpha+gamma: 1   alpha+delta: 1   beta+gamma: 1
// Every write is symmetric, which is exactly what coOccurrences[ai][aj] and
// coOccurrences[aj][ai] maintain after the hoist.
const CONTENT = {
  'page1.md': '# Page 1\n\nWe build on [@alpha2020; @beta2021; @gamma2019] in this work.\n',
  'page2.md': '# Page 2\n\nCompare [@alpha2020; @delta2018] for context.\n',
  'page3.md': '# Page 3\n\nAs shown in [@alpha2020; @beta2021], the method holds.\n',
};

// Golden output captured from the handler before the hoist. Binding arr[j] into
// a local const aj is loop invariant within one inner iteration, so the matrix
// and every PageRank score must stay byte for byte identical to these values.
const GOLDEN_RANKINGS = [
  { key: 'alpha2020', title: 'Alpha Networks', year: 2020, venue: 'NeurIPS', rank: 1.556 },
  { key: 'beta2021', title: 'Beta Methods', year: 2021, venue: 'ICML', rank: 1.155 },
  { key: 'gamma2019', title: 'Gamma Theory', year: 2019, venue: 'ICLR', rank: 0.808 },
  { key: 'delta2018', title: 'Delta Systems', year: 2018, venue: 'JMLR', rank: 0.481 },
  { key: 'epsilon2017', title: 'Epsilon Foundations', year: 2017, venue: 'COLT', rank: 0.15 },
];

// A fake fs supplying just the two reads the pagerank thunk performs: the YAML
// bibliography and the content files surfaced by readdirSync. The content
// directory is flat, so readdirSync is called once on it and returns three files.
function makeFs() {
  return {
    readFileSync(fp) {
      const s = String(fp);
      if (s.endsWith('references.yaml')) return REFS_YAML;
      const base = path.basename(s);
      if (Object.prototype.hasOwnProperty.call(CONTENT, base)) return CONTENT[base];
      throw new Error('ENOENT: ' + s);
    },
    readdirSync(dir) {
      if (path.basename(String(dir)) === 'content') {
        return Object.keys(CONTENT).map((name) => ({ name, isDirectory() { return false; } }));
      }
      return [];
    },
  };
}

// A memoizing cached(key, ttl, fn): the pagerank handler wraps its scan in
// cached('ref-pagerank', ...), so the ctx must supply the helper. Each test
// builds its own instance, so there is no cross test cache carryover.
function makeCached() {
  const store = new Map();
  return function cached(key, _ttlMs, fn) {
    if (store.has(key)) return store.get(key);
    const data = fn();
    store.set(key, data);
    return data;
  };
}

// Invoke a content-analysis-a route handler with a mocked ctx, capturing the
// json(res, status, payload) response. Fully in process: no network, no server.
async function invoke(pathname, ctx) {
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  let jsonResp = null;
  const res = {
    writableEnded: false,
    writeHead() { return this; },
    end() { this.writableEnded = true; return this; },
  };
  const fullCtx = {
    json(_res, status, payload) { jsonResp = { status, payload }; res.writableEnded = true; return jsonResp; },
    ...ctx,
  };
  await routes(req, res, url, pathname, fullCtx);
  return { json: jsonResp };
}

const baseCtx = () => ({
  fs: makeFs(),
  path,
  PROJECT_ROOT: '/fake/root',
  ALLOWED_EXTS: ['.md', '.mdx'],
  cached: makeCached(),
});

describe('GET /api/references/pagerank: arr[j] hoist preserves the ranking', () => {
  it('ranks every reference and matches the captured PageRank scores', async () => {
    const r = await invoke('/api/references/pagerank', baseCtx());

    assert.equal(r.json.status, 200);
    assert.equal(r.json.payload.total, GOLDEN_RANKINGS.length, 'all five references are ranked');
    assert.deepEqual(
      r.json.payload.rankings,
      GOLDEN_RANKINGS,
      'rankings match the pre-hoist golden, so the arr[j] rebind is behavior preserving',
    );
  });

  it('seats an uncited reference at the 1 minus damping floor', async () => {
    const r = await invoke('/api/references/pagerank', baseCtx());
    const rankings = r.json.payload.rankings;

    const epsilon = rankings.find((e) => e.key === 'epsilon2017');
    assert.ok(epsilon, 'the uncited reference still appears in the output');
    assert.equal(epsilon.rank, 0.15, 'with no neighbors its score is exactly 1 minus damping (0.85)');
    assert.equal(rankings[rankings.length - 1].key, 'epsilon2017', 'and it sorts last');
  });

  it('returns rankings sorted by descending rank with the hub first', async () => {
    const r = await invoke('/api/references/pagerank', baseCtx());
    const rankings = r.json.payload.rankings;

    assert.equal(rankings[0].key, 'alpha2020', 'the most co-cited key ranks first');
    for (let i = 1; i < rankings.length; i++) {
      assert.ok(
        rankings[i - 1].rank >= rankings[i].rank,
        `rank ${i - 1} (${rankings[i - 1].rank}) >= rank ${i} (${rankings[i].rank})`,
      );
    }
  });
});
