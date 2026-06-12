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
// the supplied YAML. `json` captures the status and body the handler emits.
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
    // The handler wraps its fold in cached(key, ttl, fn); this pass-through runs
    // fn() every call so the byte-identity assertions below are unaffected.
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

// Differential oracle: the ORIGINAL pre-refactor algorithm, including the
// double-scan fieldCoverage expression it replaced. Asserting the live handler
// deep-equals this for the same parsed refs pins the refactor as byte-identical
// to prior behavior, independently of the hand-computed literals below.
function originalCompleteness(refs) {
  const FIELDS = ['title', 'author', 'year', 'venue', 'doi', 'url'];
  const results = [];
  let totalComplete = 0;
  for (const [key, entry] of Object.entries(refs)) {
    const missing = FIELDS.filter(f => !entry[f] || (Array.isArray(entry[f]) && entry[f].length === 0));
    const present = FIELDS.filter(f => entry[f] && (!Array.isArray(entry[f]) || entry[f].length > 0));
    const completeness = Math.round((present.length / FIELDS.length) * 100);
    if (completeness === 100) totalComplete++;
    results.push({ key, title: entry.title || key, completeness, missing, presentCount: present.length });
  }
  results.sort((a, b) => a.completeness - b.completeness);
  const avgCompleteness = results.length > 0 ? Math.round(results.reduce((s, r) => s + r.completeness, 0) / results.length) : 0;
  return {
    averageCompleteness: avgCompleteness,
    totalReferences: results.length,
    fullyComplete: totalComplete,
    incomplete: results.filter(r => r.completeness < 100).slice(0, 30),
    fieldCoverage: FIELDS.map(f => ({
      field: f,
      count: Object.values(refs).filter(e => e[f] && (!Array.isArray(e[f]) || e[f].length > 0)).length,
      percentage: Math.round(Object.values(refs).filter(e => e[f] && (!Array.isArray(e[f]) || e[f].length > 0)).length / Math.max(Object.keys(refs).length, 1) * 100),
    })),
  };
}

// A representative fixture spanning fully complete, partial, and empty entries
// so every field-coverage count and percentage is non-trivial.
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
d: {}
`;

describe('/api/references/completeness', () => {
  it('returns the expected shape and values for a representative fixture', async () => {
    const out = await callCompleteness(FIXTURE);
    assert.ok(out, 'handler did not emit a response');
    assert.equal(out.status, 200);

    const expected = {
      averageCompleteness: 50,
      totalReferences: 4,
      fullyComplete: 1,
      incomplete: [
        { key: 'd', title: 'd', completeness: 0, missing: ['title', 'author', 'year', 'venue', 'doi', 'url'], presentCount: 0 },
        { key: 'c', title: 'C title', completeness: 33, missing: ['author', 'venue', 'doi', 'url'], presentCount: 2 },
        { key: 'b', title: 'B title', completeness: 67, missing: ['doi', 'url'], presentCount: 4 },
      ],
      fieldCoverage: [
        { field: 'title', count: 3, percentage: 75 },
        { field: 'author', count: 2, percentage: 50 },
        { field: 'year', count: 3, percentage: 75 },
        { field: 'venue', count: 2, percentage: 50 },
        { field: 'doi', count: 1, percentage: 25 },
        { field: 'url', count: 1, percentage: 25 },
      ],
    };

    assert.deepEqual(out.body, expected);
    // Byte-identical check: same values AND same key ordering as the response
    // the previous (double-scan) implementation produced.
    assert.equal(JSON.stringify(out.body), JSON.stringify(expected));
  });

  it('is byte-identical to the original double-scan implementation', async () => {
    const out = await callCompleteness(FIXTURE);
    const oracle = originalCompleteness(yaml.load(FIXTURE) || {});
    assert.deepEqual(out.body, oracle);
    assert.equal(JSON.stringify(out.body), JSON.stringify(oracle));
  });

  it('derives each fieldCoverage percentage from a single per-field count', async () => {
    const { body } = await callCompleteness(FIXTURE);
    // The fixture holds 4 references; assert against that independent literal so
    // a drifted denominator (the exact semantic the refactor touched) is caught.
    assert.equal(body.totalReferences, 4);
    for (const fc of body.fieldCoverage) {
      assert.equal(fc.percentage, Math.round((fc.count / 4) * 100));
    }
    const counts = Object.fromEntries(body.fieldCoverage.map(fc => [fc.field, fc.count]));
    assert.deepEqual(counts, { title: 3, author: 2, year: 3, venue: 2, doi: 1, url: 1 });
  });

  it('handles an empty reference set without dividing by zero', async () => {
    const out = await callCompleteness('');
    assert.ok(out, 'handler did not emit a response');
    assert.equal(out.status, 200);
    const expected = {
      averageCompleteness: 0,
      totalReferences: 0,
      fullyComplete: 0,
      incomplete: [],
      fieldCoverage: [
        { field: 'title', count: 0, percentage: 0 },
        { field: 'author', count: 0, percentage: 0 },
        { field: 'year', count: 0, percentage: 0 },
        { field: 'venue', count: 0, percentage: 0 },
        { field: 'doi', count: 0, percentage: 0 },
        { field: 'url', count: 0, percentage: 0 },
      ],
    };
    assert.deepEqual(out.body, expected);
    assert.deepEqual(out.body, originalCompleteness({}));
  });

  it('preserves the ascending sort and 30-item cap on incomplete for large inputs', async () => {
    // 40 references, none fully complete (url is always absent), so the
    // incomplete list is truncated by slice(0, 30).
    const refs = {};
    for (let i = 0; i < 40; i++) {
      const e = { title: `T${i}`, year: 2000 + (i % 25) };
      if (i % 2 === 0) e.author = [`A${i}`];
      if (i % 3 === 0) e.venue = `V${i}`;
      if (i % 5 === 0) e.doi = `10.x/${i}`;
      refs[`k${String(i).padStart(3, '0')}`] = e;
    }
    const yamlText = yaml.dump(refs);
    const parsed = yaml.load(yamlText);

    const out = await callCompleteness(yamlText);
    assert.ok(out, 'handler did not emit a response');
    assert.deepEqual(out.body, originalCompleteness(parsed));
    assert.equal(out.body.totalReferences, 40);
    assert.equal(out.body.incomplete.length, 30);
    for (let i = 1; i < out.body.incomplete.length; i++) {
      assert.ok(out.body.incomplete[i - 1].completeness <= out.body.incomplete[i].completeness);
    }
  });
});
