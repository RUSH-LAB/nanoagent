import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodePath from 'node:path';
import yaml from 'js-yaml';

// The route module is CommonJS; the default import yields its module.exports
// (the async dispatcher function).
import contentAnalysisBRoutes from '../server/routes/content-analysis-b.js';

// Invoke the real /api/references/completeness handler with a minimal ctx. The
// handler's only filesystem touch is one readFileSync of bibliography/
// references.yaml, so we stub that single read and let the real js-yaml parse
// the supplied YAML. The handler now wraps its fold in cached(key, ttl, fn), so
// the ctx supplies a pass-through cached that runs fn() every call; the average
// assertions below stay unchanged.
async function callCompleteness(yamlText) {
  let captured = null;
  const ctx = {
    fs: {
      readFileSync(p) {
        if (String(p).endsWith('references.yaml')) return yamlText;
        throw Object.assign(new Error(`unexpected read: ${p}`), { code: 'ENOENT' });
      },
    },
    path: nodePath,
    PROJECT_ROOT: '/virtual',
    cached: (_k, _t, fn) => fn(),
    json(res, status, body) {
      captured = { status, body };
      res.writableEnded = true;
      return res;
    },
  };
  const pathname = '/api/references/completeness';
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  const url = new URL(`http://localhost${pathname}`);
  await contentAnalysisBRoutes(req, res, url, pathname, ctx);
  return captured;
}

// Independently re-derive averageCompleteness the way the pre-fold handler did:
// reduce over the per-entry completeness AFTER the ascending sort. The live
// handler now accumulates the same sum inside the entry loop (completenessSum),
// so matching this proves the fold stays byte-identical to the old second pass.
function expectedAverage(refs) {
  const FIELDS = ['title', 'author', 'year', 'venue', 'doi', 'url'];
  const completeness = Object.values(refs).map(entry => {
    const present = FIELDS.filter(f => entry[f] && (!Array.isArray(entry[f]) || entry[f].length > 0));
    return Math.round((present.length / FIELDS.length) * 100);
  });
  completeness.sort((a, b) => a - b);
  return completeness.length > 0
    ? Math.round(completeness.reduce((s, c) => s + c, 0) / completeness.length)
    : 0;
}

// A mix of fully complete, partial, and empty entries. Insertion order (100,
// 67, 33, 17, 0) deliberately differs from the ascending sort the handler runs
// before the old reduce, so a correct in-loop sum must be order independent.
const FIXTURE = `
a:
  title: "A title"
  author:
    - Alice
  year: 2024
  venue: "NeurIPS"
  doi: "10.1000/a"
  url: "https://example.com/a"
b:
  title: "B title"
  author:
    - Bob
  year: 2021
  venue: "ICML"
c:
  title: "C title"
  year: 2020
d:
  title: "D title"
e: {}
`;

describe('/api/references/completeness average fold', () => {
  it('pins averageCompleteness and the full payload for a mixed fixture', async () => {
    const out = await callCompleteness(FIXTURE);
    assert.ok(out, 'handler did not emit a response');
    assert.equal(out.status, 200);

    const expected = {
      averageCompleteness: 43,
      totalReferences: 5,
      fullyComplete: 1,
      incomplete: [
        { key: 'e', title: 'e', completeness: 0, missing: ['title', 'author', 'year', 'venue', 'doi', 'url'], presentCount: 0 },
        { key: 'd', title: 'D title', completeness: 17, missing: ['author', 'year', 'venue', 'doi', 'url'], presentCount: 1 },
        { key: 'c', title: 'C title', completeness: 33, missing: ['author', 'venue', 'doi', 'url'], presentCount: 2 },
        { key: 'b', title: 'B title', completeness: 67, missing: ['doi', 'url'], presentCount: 4 },
      ],
      fieldCoverage: [
        { field: 'title', count: 4, percentage: 80 },
        { field: 'author', count: 2, percentage: 40 },
        { field: 'year', count: 3, percentage: 60 },
        { field: 'venue', count: 2, percentage: 40 },
        { field: 'doi', count: 1, percentage: 20 },
        { field: 'url', count: 1, percentage: 20 },
      ],
    };

    assert.deepEqual(out.body, expected);
    // Same values AND same key ordering as the response shape.
    assert.equal(JSON.stringify(out.body), JSON.stringify(expected));
  });

  it('matches an independent post-sort reduce of the per-entry completeness', async () => {
    const out = await callCompleteness(FIXTURE);
    const parsed = yaml.load(FIXTURE) || {};
    assert.equal(out.body.averageCompleteness, expectedAverage(parsed));
    // 217 / 5 = 43.4, so Math.round yields 43; this also exercises the rounding.
    assert.equal(out.body.averageCompleteness, 43);
  });

  it('returns averageCompleteness 0 for an empty reference set', async () => {
    const out = await callCompleteness('');
    assert.ok(out, 'handler did not emit a response');
    assert.equal(out.status, 200);
    assert.equal(out.body.totalReferences, 0);
    assert.equal(out.body.averageCompleteness, 0);
    assert.equal(out.body.averageCompleteness, expectedAverage({}));
  });

  it('stays order independent for a large input where loop order is not sorted order', async () => {
    const refs = {};
    for (let i = 0; i < 40; i++) {
      const e = { title: `T${i}`, year: 2000 + (i % 25) };
      if (i % 2 === 0) e.author = [`A${i}`];
      if (i % 3 === 0) e.venue = `V${i}`;
      if (i % 5 === 0) e.doi = `10.x/${i}`;
      if (i % 7 === 0) e.url = `https://example.com/${i}`;
      refs[`k${String(i).padStart(3, '0')}`] = e;
    }
    const yamlText = yaml.dump(refs);
    const parsed = yaml.load(yamlText);
    const out = await callCompleteness(yamlText);
    assert.ok(out, 'handler did not emit a response');
    assert.equal(out.body.totalReferences, 40);
    assert.equal(out.body.averageCompleteness, expectedAverage(parsed));
  });
});
