import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';

// research-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');
const SOURCE_PATH = new URL('../server/routes/research-tools.js', import.meta.url);

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

const realHttpsGet = https.get;

// Install a fake `https.get` that records each requested URL and answers the
// Semantic Scholar references lookup with a per-seed payload, chosen by the paper
// id embedded in the URL (/paper/<id>/references). The real handler then runs its
// full seed loop with zero network access, so the recMap accumulation that reads
// `seed.entry.title` is exercised end to end.
function installRefPayloadHttps(requestedUrls, payloadByPaperId) {
  https.get = (urlArg, opts, cb) => {
    if (typeof opts === 'function') cb = opts;
    const urlStr = String(urlArg);
    requestedUrls.push(urlStr);
    const m = urlStr.match(/\/paper\/([^/]+)\/references/);
    const paperId = m ? decodeURIComponent(m[1]) : null;
    const payload = (paperId && payloadByPaperId[paperId]) || { data: [] };
    const resStream = new EventEmitter();
    resStream.resume = () => {};
    resStream.statusCode = 200;
    if (typeof cb === 'function') cb(resStream);
    setImmediate(() => {
      resStream.emit('data', Buffer.from(JSON.stringify(payload)));
      resStream.emit('end');
    });
    const reqStream = new EventEmitter();
    reqStream.destroy = () => {};
    return reqStream;
  };
}

// Drive GET /api/recommendations through the real route handler with the minimal
// `ctx` it touches on this path, returning whatever the handler hands to json().
// fs.readFileSync only answers for the references.yaml path so any stray read
// surfaces as an ENOENT instead of silent empty data. `existingTitles` is seeded
// from these bibliography titles, so the cited titles below stay distinct from
// the seed titles and are never filtered out.
async function getRecommendations(yamlText, payloadByPaperId, requestedUrls) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    rateLimit: () => true,
    fs: {
      readFileSync(fp) {
        if (fp === REFS_PATH) return yamlText;
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
    json: (_res, status, body) => { captured = { status, body }; },
  };
  installRefPayloadHttps(requestedUrls, payloadByPaperId);
  const pathname = '/api/recommendations';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await researchToolsRoutes(req, { writableEnded: false }, url, pathname, ctx);
  return captured;
}

// Two seeds with distinct venue+year scores so the seed order is fixed: Seed
// Alpha (year 2022 -> score 22) sorts ahead of Seed Beta (year 2021 -> 21), so
// Alpha is expanded first. Neither venue is in REC_TOP_VENUES (both omitted), so
// only recency separates them.
const FIXTURE_YAML = `
alpha:
  paperId: PID_ALPHA
  title: Seed Alpha
  year: 2022
beta:
  paperId: PID_BETA
  title: Seed Beta
  year: 2021
`;

// Both seeds cite "Shared Cited Paper" (drives the recMap.has branch, so its
// recommendedBy accumulates BOTH seed titles and its score reaches 2). Each seed
// also cites one paper unique to it (drives the array-literal branch with a
// single seed title).
const PAYLOADS = {
  PID_ALPHA: {
    data: [
      { citedPaper: { title: 'Shared Cited Paper', authors: [{ name: 'Shared Author' }], year: 2020, venue: 'Some Venue', externalIds: { ArXiv: '2001.00001' } } },
      { citedPaper: { title: 'Alpha Only Cited', authors: [{ name: 'Alpha Author' }], year: 2019, venue: '', externalIds: {} } },
    ],
  },
  PID_BETA: {
    data: [
      { citedPaper: { title: 'Shared Cited Paper', authors: [{ name: 'Shared Author' }], year: 2020, venue: 'Some Venue', externalIds: { ArXiv: '2001.00001' } } },
      { citedPaper: { title: 'Beta Only Cited', authors: [{ name: 'Beta Author' }], year: 2018, venue: '', externalIds: {} } },
    ],
  },
};

// Golden: the shared paper sorts first (score 2); the two single-seed papers tie
// at score 1 and break by year descending (2019 before 2018).
const GOLDEN_RECOMMENDATIONS = [
  { title: 'Shared Cited Paper', authors: ['Shared Author'], year: 2020, venue: 'Some Venue', arxivId: '2001.00001', score: 2, recommendedBy: ['Seed Alpha', 'Seed Beta'] },
  { title: 'Alpha Only Cited', authors: ['Alpha Author'], year: 2019, venue: '', arxivId: null, score: 1, recommendedBy: ['Seed Alpha'] },
  { title: 'Beta Only Cited', authors: ['Beta Author'], year: 2018, venue: '', arxivId: null, score: 1, recommendedBy: ['Seed Beta'] },
];

describe('GET /api/recommendations (seed.entry.title hoisted to seedTitle once per seed)', () => {
  afterEach(() => { https.get = realHttpsGet; });

  it('accumulates recommendedBy across seeds for a shared cited title and uses the array literal for distinct titles', async () => {
    const requestedUrls = [];
    const res = await getRecommendations(FIXTURE_YAML, PAYLOADS, requestedUrls);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { recommendations: GOLDEN_RECOMMENDATIONS });

    // Sanity: both seeds were expanded, in venue/year priority order.
    const seededIds = requestedUrls
      .map(u => u.match(/\/paper\/([^/]+)\/references/))
      .filter(Boolean)
      .map(m => decodeURIComponent(m[1]));
    assert.deepEqual(seededIds, ['PID_ALPHA', 'PID_BETA']);
  });

  it('hoists seed.entry.title into seedTitle once per seed in the source', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(
      source.includes('const seedTitle = seed.entry.title'),
      'expected the per-seed hoist `const seedTitle = seed.entry.title`',
    );
    assert.ok(
      !source.includes('includes(seed.entry.title)'),
      'inner-loop includes() should reference seedTitle, not seed.entry.title',
    );
    assert.ok(
      !source.includes('[seed.entry.title]'),
      'the recommendedBy array literal should reference seedTitle, not seed.entry.title',
    );
  });
});
