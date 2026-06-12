import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import https from 'node:https';

// research-tools.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const researchToolsRoutes = require('../server/routes/research-tools.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

const realHttpsGet = https.get;

// Install a fake `https.get` that records every requested URL in call order and
// answers with an empty Semantic Scholar references payload. The real handler
// then runs its full seed-selection and fetch loop with zero network access, and
// the recorded URLs reveal which bibliography entries became seeds, and in what
// order, which is exactly what the venue-priority sort decides.
function installSeedCapturingHttps(requestedUrls) {
  https.get = (urlArg, opts, cb) => {
    if (typeof opts === 'function') cb = opts;
    requestedUrls.push(String(urlArg));
    const resStream = new EventEmitter();
    resStream.resume = () => {};
    resStream.statusCode = 200;
    if (typeof cb === 'function') cb(resStream);
    setImmediate(() => {
      resStream.emit('data', Buffer.from(JSON.stringify({ data: [] })));
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
// surfaces as an ENOENT instead of silent empty data.
async function getRecommendations(yamlText) {
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
  const pathname = '/api/recommendations';
  const url = new URL(`http://localhost${pathname}`);
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await researchToolsRoutes(req, { writableEnded: false }, url, pathname, ctx);
  return captured;
}

// Pull the seed paper IDs out of the captured S2 reference-lookup URLs, in the
// order they were requested. Each URL has the shape /paper/<id>/references?...
function seededPaperIds(requestedUrls) {
  return requestedUrls
    .map(u => u.match(/\/paper\/([^/]+)\/references/))
    .filter(Boolean)
    .map(m => decodeURIComponent(m[1]));
}

// Six entries whose venue-priority + recency scores are all distinct, so the
// seed order is fully determined. Score = (REC_TOP_VENUES.has(venue) ? 10 : 0)
// + (year - 2000), sorted descending:
//   pn NeurIPS 2021 -> 10 + 21 = 31
//   pi ICML    2019 -> 10 + 19 = 29
//   pw Workshop2024 ->  0 + 24 = 24   (recent non-top venue)
//   pc ICLR    2012 -> 10 + 12 = 22   (older top venue)
//   pa arXiv   2016 ->  0 + 16 = 16
//   po Journal 2003 ->  0 +  3 =  3   (ranked 6th, excluded from the 5 seeds)
// The pw-over-pc gap is the load-bearing case: it only holds because Workshop is
// absent from REC_TOP_VENUES while ICLR is present. If the set were emptied or
// lost ICLR, pc would fall to 12 and drop below pa, reordering the seeds.
const FIXTURE_YAML = `
pn:
  paperId: PID_NEURIPS
  title: Neurips Recent
  venue: NeurIPS
  year: 2021
pi:
  paperId: PID_ICML
  title: Icml Paper
  venue: ICML
  year: 2019
pw:
  paperId: PID_WORKSHOP
  title: Recent Workshop
  venue: Workshop on Things
  year: 2024
pc:
  paperId: PID_ICLR
  title: Iclr Older
  venue: ICLR
  year: 2012
pa:
  paperId: PID_ARXIV
  title: Arxiv Midrange
  venue: arXiv
  year: 2016
po:
  paperId: PID_OLD
  title: Old Minor Venue
  venue: Some Journal
  year: 2003
`;

describe('GET /api/recommendations (REC_TOP_VENUES hoisted to module scope)', () => {
  afterEach(() => { https.get = realHttpsGet; });

  it('picks the top five seeds in venue-priority then year order', async () => {
    const requestedUrls = [];
    installSeedCapturingHttps(requestedUrls);

    const res = await getRecommendations(FIXTURE_YAML);
    assert.equal(res.status, 200);
    // Empty S2 payloads mean no recommendations accumulate; the seed ORDER is
    // what proves the hoisted venue set still drives ranking.
    assert.deepEqual(res.body, { recommendations: [] });

    assert.deepEqual(seededPaperIds(requestedUrls), [
      'PID_NEURIPS', 'PID_ICML', 'PID_WORKSHOP', 'PID_ICLR', 'PID_ARXIV',
    ]);
  });

  it('drops the sixth-ranked paper from the seed set (slice of five)', async () => {
    const requestedUrls = [];
    installSeedCapturingHttps(requestedUrls);

    await getRecommendations(FIXTURE_YAML);
    const ids = seededPaperIds(requestedUrls);
    assert.equal(ids.length, 5, 'only five seeds are expanded');
    assert.ok(!ids.includes('PID_OLD'), 'the lowest-scored entry is not a seed');
  });

  it('returns an empty list without touching the network when no IDs resolve', async () => {
    // No entry carries a paperId/url/arxivId/doi, so the handler returns before
    // any seed selection or https.get call. Leaving the real https.get in place
    // would make a stray network call fail loudly rather than pass silently.
    const res = await getRecommendations('only:\n  title: No Identifiers\n  year: 2020\n');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { recommendations: [] });
  });

  it('still exposes the route as the module default export', () => {
    assert.equal(typeof researchToolsRoutes, 'function');
  });
});
