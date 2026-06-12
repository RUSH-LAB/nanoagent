import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import nodePath from 'node:path';
import yaml from 'js-yaml';

// The route module is CommonJS; the default import yields its module.exports
// (the async dispatcher function).
import contentAnalysisBRoutes from '../server/routes/content-analysis-b.js';

// Invoke the real /api/references/duplicates handler with a minimal ctx. The
// handler's only filesystem touch is one readFileSync of bibliography/
// references.yaml, so we stub that single read and let the real js-yaml parse
// the supplied YAML. The handler now wraps its computation in cached(), so the
// ctx supplies a pass-through `cached` that simply runs fn(); this keeps every
// case below exercising the real fold rather than a memoized value.
async function callDuplicates(yamlText) {
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
    cached: (_key, _ttl, fn) => fn(),
    json(res, status, body) {
      captured = { status, body };
      res.writableEnded = true;
      return res;
    },
  };
  const pathname = '/api/references/duplicates';
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  const url = new URL(`http://localhost${pathname}`);
  await contentAnalysisBRoutes(req, res, url, pathname, ctx);
  return captured;
}

// Re-derive totalDuplicateEntries the way the pre-fold handler did: a reduce over
// the built duplicate groups' counts. The live handler now sums the same per-group
// g.length inside the map, so matching this proves the fold stays byte-identical
// to the old second pass.
function expectedTotal(duplicates) {
  return duplicates.reduce((s, d) => s + d.count, 0);
}

// Two title-collision groups plus singletons and skipped entries:
//   - "Attention Is All You Need" x2 (case-only difference, normalizes the same)
//   - "BERT Pre-training ..." x3 (punctuation/case differences, normalizes the same)
//   - two unique singletons (count 1, excluded from duplicates)
//   - "AI" (normalized length < 5, skipped) and an entry with no title (skipped)
// The BERT group (3) outsizes the Attention group (2), so the descending-by-count
// sort is deterministic without relying on sort stability.
const FIXTURE = `
vaswani2017:
  title: "Attention Is All You Need"
  year: 2017
  venue: "NeurIPS"
vaswani2017dup:
  title: "Attention is all you need"
  year: 2017
  venue: "arXiv"
bert1:
  title: "BERT Pre-training of Deep Bidirectional Transformers"
  year: 2019
  venue: "NAACL"
bert2:
  title: "BERT: Pre-training of Deep Bidirectional Transformers"
  year: 2018
  venue: "arXiv"
bert3:
  title: "Bert pre-training of deep bidirectional transformers"
  year: 2019
  venue: "ACL"
gan2014:
  title: "Generative Adversarial Networks"
  year: 2014
  venue: "NeurIPS"
dropout2014:
  title: "Dropout A Simple Way to Prevent Overfitting"
  year: 2014
  venue: "JMLR"
short1:
  title: "AI"
  year: 2020
  venue: "X"
notitle:
  year: 2020
  venue: "Y"
`;

describe('/api/references/duplicates total fold', () => {
  it('pins totalDuplicateEntries, totalDuplicateGroups, and the duplicates payload', async () => {
    const out = await callDuplicates(FIXTURE);
    assert.ok(out, 'handler did not emit a response');
    assert.equal(out.status, 200);

    const expected = {
      duplicates: [
        {
          title: 'BERT Pre-training of Deep Bidirectional Transformers',
          entries: [
            { key: 'bert1', title: 'BERT Pre-training of Deep Bidirectional Transformers', year: 2019, venue: 'NAACL' },
            { key: 'bert2', title: 'BERT: Pre-training of Deep Bidirectional Transformers', year: 2018, venue: 'arXiv' },
            { key: 'bert3', title: 'Bert pre-training of deep bidirectional transformers', year: 2019, venue: 'ACL' },
          ],
          count: 3,
        },
        {
          title: 'Attention Is All You Need',
          entries: [
            { key: 'vaswani2017', title: 'Attention Is All You Need', year: 2017, venue: 'NeurIPS' },
            { key: 'vaswani2017dup', title: 'Attention is all you need', year: 2017, venue: 'arXiv' },
          ],
          count: 2,
        },
      ],
      totalDuplicateGroups: 2,
      totalDuplicateEntries: 5,
    };

    assert.deepEqual(out.body, expected);
    // Same values AND same key ordering as the response shape.
    assert.equal(JSON.stringify(out.body), JSON.stringify(expected));
    // The folded total equals an independent reduce over the built groups.
    assert.equal(out.body.totalDuplicateEntries, expectedTotal(out.body.duplicates));
    // And it is the sum of the per-group counts: 3 + 2.
    assert.equal(out.body.totalDuplicateEntries, 5);
  });

  it('returns an empty payload and zero totals for no references', async () => {
    const out = await callDuplicates('');
    assert.ok(out, 'handler did not emit a response');
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { duplicates: [], totalDuplicateGroups: 0, totalDuplicateEntries: 0 });
    assert.equal(out.body.totalDuplicateEntries, expectedTotal(out.body.duplicates));
  });

  it('reports zero groups and zero entries when every title is unique', async () => {
    const out = await callDuplicates(`
a:
  title: "First Unique Title Here"
b:
  title: "Second Unique Title Here"
`);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.duplicates, []);
    assert.equal(out.body.totalDuplicateGroups, 0);
    assert.equal(out.body.totalDuplicateEntries, 0);
    assert.equal(out.body.totalDuplicateEntries, expectedTotal(out.body.duplicates));
  });

  it('totals correctly across many groups regardless of group order', async () => {
    // Group i has (i % 3) + 2 entries (2, 3, or 4), all sharing a normalized
    // title; a unique singleton is interleaved between groups and must be excluded.
    const refs = {};
    let expectedEntries = 0;
    let expectedGroups = 0;
    for (let i = 0; i < 12; i++) {
      const size = (i % 3) + 2;
      expectedGroups++;
      expectedEntries += size;
      for (let j = 0; j < size; j++) {
        refs[`g${String(i).padStart(2, '0')}_${j}`] = { title: `Shared Group Title Number ${i}` };
      }
      refs[`u${String(i).padStart(2, '0')}`] = { title: `Lonely Title Number ${i} Unique` };
    }
    const out = await callDuplicates(yaml.dump(refs));
    assert.equal(out.status, 200);
    assert.equal(out.body.totalDuplicateGroups, expectedGroups);
    assert.equal(out.body.totalDuplicateEntries, expectedEntries);
    assert.equal(out.body.totalDuplicateEntries, expectedTotal(out.body.duplicates));
    // Every reported group is a genuine collision (count > 1).
    assert.ok(out.body.duplicates.every(d => d.count > 1));
  });
});
