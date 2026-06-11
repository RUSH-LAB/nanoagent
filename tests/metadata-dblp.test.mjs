import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import https from 'node:https';

const require = createRequire(import.meta.url);
const referencesRoute = require('../server/routes/references.js');

const realHttpsGet = https.get;

// Install a fake `https.get` that serves canned JSON keyed by request URL.
// `responder(urlString)` returns either a JS value (delivered as a 200 JSON
// body) or `undefined` (delivered as a non-200 so the handler treats that
// source as unavailable). This lets the real route handler run its full fetch,
// parse, and merge path with zero network access.
function installFakeHttps(responder) {
  https.get = (urlArg, opts, cb) => {
    if (typeof opts === 'function') cb = opts;
    const payload = responder(String(urlArg));
    const resStream = new EventEmitter();
    resStream.resume = () => {};
    resStream.statusCode = payload === undefined ? 500 : 200;
    if (typeof cb === 'function') cb(resStream);
    setImmediate(() => {
      if (resStream.statusCode !== 200) return;
      resStream.emit('data', Buffer.from(JSON.stringify(payload)));
      resStream.emit('end');
    });
    const reqStream = new EventEmitter();
    reqStream.destroy = () => {};
    return reqStream;
  };
}

// Drive GET /api/metadata/search?q=... through the real route handler with the
// minimal `ctx` the handler touches on this path (only `json`), capturing the
// response that the handler hands to `json`.
async function callMetadataSearch(query) {
  const qs = query == null ? '' : `?q=${encodeURIComponent(query)}`;
  const url = new URL(`http://localhost/api/metadata/search${qs}`);
  let captured = null;
  const ctx = { json: (_res, status, body) => { captured = { status, body }; } };
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' } };
  await referencesRoute(req, {}, url, url.pathname, ctx);
  return captured;
}

function bySource(results, source) {
  return results.filter(r => r.source === source);
}

// Canned top hits describing the same paper across the three sources, in three
// deliberately different author/field formats so the merge has something real
// to reconcile.
const S2_PAYLOAD = {
  data: [
    {
      title: 'Attention Is All You Need',
      authors: [{ name: 'Ashish Vaswani' }, { name: 'N. Shazeer' }],
      year: 2017,
      venue: 'Neural Information Processing Systems',
      externalIds: { DOI: '10.5555/s2-doi', ArXiv: '1706.03762' },
      url: 'https://www.semanticscholar.org/paper/abc',
    },
    {
      title: 'A Second, Unrelated S2 Paper',
      authors: [{ name: 'Someone Else' }],
      year: 2018,
      venue: 'ICML',
      externalIds: {},
      url: 'https://example.org/second',
    },
  ],
};

const CROSSREF_PAYLOAD = {
  message: {
    items: [
      {
        title: ['Attention is all you need'],
        author: [
          { given: 'Ashish', family: 'Vaswani' },
          { given: 'Noam', family: 'Shazeer' },
        ],
        published: { 'date-parts': [[2017]] },
        'container-title': ['Advances in Neural Information Processing Systems'],
        DOI: '10.5555/crossref-doi',
        URL: 'https://doi.org/10.5555/crossref-doi',
      },
    ],
  },
};

const DBLP_PAYLOAD = {
  result: {
    hits: {
      hit: [
        {
          info: {
            title: 'Attention is All you Need.',
            authors: { author: [{ text: 'Ashish Vaswani' }, { text: 'Noam Shazeer' }] },
            year: '2017',
            venue: 'NeurIPS',
            doi: '10.5555/dblp-doi',
            ee: 'https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17',
            type: 'Conference and Workshop Papers',
            pages: '5998-6008',
            volume: '30',
          },
        },
      ],
    },
  },
};

// Route each outbound URL to the matching source payload.
function defaultResponder(urlString) {
  if (urlString.includes('api.semanticscholar.org')) return S2_PAYLOAD;
  if (urlString.includes('api.crossref.org')) return CROSSREF_PAYLOAD;
  if (urlString.includes('dblp.org')) return DBLP_PAYLOAD;
  return undefined;
}

describe('GET /api/metadata/search merge + DBLP', () => {
  afterEach(() => { https.get = realHttpsGet; });

  it('adds DBLP results while keeping the existing per-source results', async () => {
    installFakeHttps(defaultResponder);
    const { status, body } = await callMetadataSearch('attention');

    assert.equal(status, 200);
    assert.ok(Array.isArray(body.results), 'results is still an array');

    // Backward compatibility: Semantic Scholar and CrossRef entries are intact.
    const s2 = bySource(body.results, 'semanticscholar');
    const crossref = bySource(body.results, 'crossref');
    assert.equal(s2.length, 2, 'both Semantic Scholar hits are returned');
    assert.equal(crossref.length, 1);
    assert.equal(s2[0].arxivId, '1706.03762', 'per-source arxivId field preserved');
    assert.equal(crossref[0].doi, '10.5555/crossref-doi');

    // New: DBLP hits join the per-source results.
    const dblp = bySource(body.results, 'dblp');
    assert.equal(dblp.length, 1);
    assert.equal(dblp[0].venue, 'NeurIPS');
    assert.deepEqual(dblp[0].authors, ['Ashish Vaswani', 'Noam Shazeer']);
  });

  it('returns one merged best-value record with deterministic field precedence', async () => {
    installFakeHttps(defaultResponder);
    const { body } = await callMetadataSearch('attention');
    const merged = body.merged;

    assert.ok(merged && typeof merged === 'object', 'merged record is present');
    assert.equal(merged.doi, '10.5555/crossref-doi', 'CrossRef wins DOI');
    assert.equal(merged.venue, 'NeurIPS', 'DBLP wins venue');
    assert.equal(merged.title, 'Attention is all you need', 'CrossRef wins title by default order');
    assert.equal(merged.year, 2017);
    // Source-exclusive fields fall through to whichever source carries them.
    assert.equal(merged.arxivId, '1706.03762', 'arxivId filled from Semantic Scholar');
    assert.equal(merged.type, 'Conference and Workshop Papers', 'type filled from DBLP');
    assert.equal(merged.pages, '5998-6008', 'pages filled from DBLP');
    assert.equal(merged.volume, '30', 'volume filled from DBLP');
  });

  it('de-duplicates authors across name formats, keeping the fuller spelling', async () => {
    installFakeHttps((urlString) => {
      if (urlString.includes('api.crossref.org')) {
        return {
          message: {
            items: [{
              title: ['Sample'],
              author: [{ given: 'J.', family: 'Doe' }, { given: 'Jane', family: 'Smith' }],
              published: { 'date-parts': [[2021]] },
              'container-title': ['Venue'],
              DOI: '10.1/sample',
              URL: 'https://doi.org/10.1/sample',
            }],
          },
        };
      }
      if (urlString.includes('dblp.org')) {
        return {
          result: { hits: { hit: [{ info: {
            title: 'Sample.',
            authors: { author: [{ text: 'John Doe' }, { text: 'Jane Smith' }] },
            year: '2021',
            venue: 'Venue',
          } }] } },
        };
      }
      if (urlString.includes('api.semanticscholar.org')) {
        return {
          data: [{
            title: 'Sample',
            authors: [{ name: 'J. Doe' }, { name: 'Jane Smith' }, { name: 'Bob Lee' }],
            year: 2021,
            venue: 'Venue',
            externalIds: {},
            url: 'https://example.org/sample',
          }],
        };
      }
      return undefined;
    });

    const { body } = await callMetadataSearch('sample');
    // "J. Doe" (CrossRef/S2) and "John Doe" (DBLP) collapse to the fuller form,
    // and Bob Lee (only in Semantic Scholar) still appears.
    assert.deepEqual(body.merged.authors, ['John Doe', 'Jane Smith', 'Bob Lee']);
    assert.ok(!body.merged.authors.includes('J. Doe'));
  });

  it('normalizes a single-author DBLP hit delivered as an object, not an array', async () => {
    installFakeHttps((urlString) => {
      if (urlString.includes('dblp.org')) {
        return {
          result: { hits: { hit: [{ info: {
            title: 'Solo Work.',
            authors: { author: { text: 'Solo Author' } },
            year: '2019',
            venue: 'Journal',
            doi: '10.2/solo',
          } }] } },
        };
      }
      return undefined; // Semantic Scholar and CrossRef unavailable.
    });

    const { body } = await callMetadataSearch('solo');
    const dblp = bySource(body.results, 'dblp');
    assert.equal(dblp.length, 1);
    assert.deepEqual(dblp[0].authors, ['Solo Author']);
    assert.deepEqual(body.merged.authors, ['Solo Author']);
    assert.equal(body.merged.venue, 'Journal');
  });

  it('still merges when a source is unavailable', async () => {
    installFakeHttps((urlString) => {
      if (urlString.includes('dblp.org')) return undefined; // DBLP down.
      return defaultResponder(urlString);
    });

    const { body } = await callMetadataSearch('attention');
    assert.equal(bySource(body.results, 'dblp').length, 0, 'no DBLP rows when DBLP is down');
    // The merge still combines the two reachable sources.
    assert.equal(body.merged.doi, '10.5555/crossref-doi');
    assert.equal(body.merged.arxivId, '1706.03762');
    // Venue now falls through to CrossRef since DBLP is absent.
    assert.equal(body.merged.venue, 'Advances in Neural Information Processing Systems');
  });

  it('strips the source tag and stays pollution-safe against hostile upstream keys', async () => {
    // A malicious CrossRef item carrying own __proto__/constructor keys (the
    // shape JSON.parse produces) must neither pollute Object.prototype nor
    // surface in the merged record, while its legitimate fields still merge.
    const hostileCrossref = JSON.parse(
      '{"message":{"items":[{' +
        '"__proto__":{"polluted":true},"constructor":{"polluted":true},' +
        '"title":["Hostile Paper"],"author":[{"given":"Ada","family":"Lovelace"}],' +
        '"published":{"date-parts":[[2020]]},"container-title":["Venue"],' +
        '"DOI":"10.9/hostile","URL":"https://doi.org/10.9/hostile"' +
      '}]}}',
    );
    installFakeHttps((urlString) => {
      if (urlString.includes('api.crossref.org')) return hostileCrossref;
      return undefined; // Semantic Scholar and DBLP unavailable.
    });

    const { body } = await callMetadataSearch('hostile');
    assert.equal({}.polluted, undefined, 'Object.prototype is not polluted');
    assert.equal(Object.getPrototypeOf(body.merged), Object.prototype, 'merged has a clean prototype');
    assert.ok(!('polluted' in body.merged), 'no polluting field leaks into the merged record');
    assert.ok(!('source' in body.merged), 'merged record drops the per-source source tag');
    // The legitimate fields from the same hostile payload still merge normally.
    assert.equal(body.merged.doi, '10.9/hostile');
    assert.deepEqual(body.merged.authors, ['Ada Lovelace']);
  });

  it('returns 400 when the query is missing', async () => {
    // No source is contacted on this path, so no https stub is required.
    const { status, body } = await callMetadataSearch(null);
    assert.equal(status, 400);
    assert.equal(body.error, 'Missing query');
  });
});
