import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// references.js is CommonJS; load it the way the other route tests do.
const require = createRequire(import.meta.url);
const referencesRoutes = require('../server/routes/references.js');

const PROJECT_ROOT = '/fake/root';
const REFS_PATH = path.join(PROJECT_ROOT, 'bibliography', 'references.yaml');

// Drive GET /api/references/similar with a mocked ctx and capture the json()
// response. fs.readFileSync only answers for the references.yaml path so an
// accidental extra read would surface as an ENOENT rather than silent reuse.
async function getSimilar(yamlText, key) {
  let captured = null;
  const ctx = {
    path,
    PROJECT_ROOT,
    fs: {
      readFileSync(fp) {
        if (fp === REFS_PATH) return yamlText;
        const e = new Error(`ENOENT: ${fp}`); e.code = 'ENOENT'; throw e;
      },
    },
    json: (_res, status, body) => { captured = { status, body }; return captured; },
  };
  const url = new URL(`http://localhost/api/references/similar?key=${encodeURIComponent(key)}`);
  await referencesRoutes({ method: 'GET' }, { writableEnded: false }, url, '/api/references/similar', ctx);
  return captured;
}

// Target: title words (length > 3) are {deep, learning, neural, networks};
// authors {alice smith, bob jones}; venue icml; year 2020. Each candidate's
// score below is the sum of: +3 per shared author, +2 for a matching venue,
// +1 for a year within 2, and +0.5 per shared title word (the targetWords path).
//
//   c1 = 3(alice) + 2(icml) + 1(2021) + 0.5(deep) + 0.5(learning)        = 7.0
//   c2 = 0        + 2(icml) + 1(2019) + 0.5(neural) + 0.5(networks)      = 4.0
//   c3 = 3(bob)   + 0       + 0       + 0.5(neural)                      = 3.5  (fractional .5 score)
//   c4 = 0        + 0       + 1(2020) + 0.5(deep) + 0.5(neural)          = 2.0
//   c5 = 0        + 0       + 0       + 0.5(deep)                        = 0.5  (score > 1 fails → dropped)
//   c6 = 0        + 0       + 1(2018) + 0.5(networks) + 0.5(learning)    = 2.0  (ties c4; stays after it)
//
// Sorted by descending score with a stable tie-break (insertion order): c4 keeps
// its place ahead of c6 because it appears earlier in the document.
const FIXTURE = `
target:
  title: Deep Learning Neural Networks
  author: [Alice Smith, Bob Jones]
  venue: ICML
  year: 2020
c1:
  title: Deep Learning for Vision
  author: [Alice Smith]
  venue: ICML
  year: 2021
c2:
  title: Neural Networks Theory
  author: [Carol White]
  venue: ICML
  year: 2019
c3:
  title: Robotics Neural Control
  author: [Bob Jones]
  venue: AAAI
  year: 2010
c4:
  title: Deep Neural Architectures
  author: [Dave Brown]
  venue: CVPR
  year: 2020
c5:
  title: Deep Reinforcement Methods
  author: [Eve Black]
  venue: TACL
  year: 2005
c6:
  title: Networks for Learning
  author: [Frank Green]
  venue: EMNLP
  year: 2018
`;

describe('GET /api/references/similar (targetWords hoisted out of the candidates loop)', () => {
  it('deep-equals the expected similar payload, scores and ordering included', async () => {
    const res = await getSimilar(FIXTURE, 'target');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      key: 'target',
      similar: [
        { key: 'c1', title: 'Deep Learning for Vision', year: 2021, venue: 'ICML', authors: ['Alice Smith'], score: 7 },
        { key: 'c2', title: 'Neural Networks Theory', year: 2019, venue: 'ICML', authors: ['Carol White'], score: 4 },
        { key: 'c3', title: 'Robotics Neural Control', year: 2010, venue: 'AAAI', authors: ['Bob Jones'], score: 3.5 },
        { key: 'c4', title: 'Deep Neural Architectures', year: 2020, venue: 'CVPR', authors: ['Dave Brown'], score: 2 },
        { key: 'c6', title: 'Networks for Learning', year: 2018, venue: 'EMNLP', authors: ['Frank Green'], score: 2 },
      ],
    });

    // deepEqual on the array already pins order, but spell it out to make the
    // stable tie-break (c4 before c6) and the c5 exclusion explicit.
    assert.deepEqual(res.body.similar.map(s => s.key), ['c1', 'c2', 'c3', 'c4', 'c6']);
    assert.ok(!res.body.similar.some(s => s.key === 'c5'), 'c5 scores 0.5 and must be dropped by the score > 1 gate');
  });

  it('applies the title-word overlap contribution from targetWords exactly', async () => {
    // m1 and m2 are identical in every scoring dimension except title words, so
    // the score gap is purely the targetWords contribution: m1 shares two words
    // (graph, signal) with the target, m2 shares none.
    const MINI = `
target:
  title: Graph Signal Processing
  author: [Zed Alpha]
  venue: KDD
  year: 2015
m1:
  title: Graph Signal Sampling
  author: [Zed Alpha]
  venue: KDD
  year: 2015
m2:
  title: Robotic Hand Manipulation
  author: [Zed Alpha]
  venue: KDD
  year: 2015
`;
    const res = await getSimilar(MINI, 'target');
    assert.equal(res.status, 200);
    const m1 = res.body.similar.find(s => s.key === 'm1');
    const m2 = res.body.similar.find(s => s.key === 'm2');
    assert.equal(m1.score, 7); // 3 author + 2 venue + 1 year + 1.0 title overlap
    assert.equal(m2.score, 6); // 3 author + 2 venue + 1 year + 0   title overlap
    assert.equal(m1.score - m2.score, 1); // exactly the two shared title words × 0.5
  });

  it('handles a target with no title (empty targetWords, zero title contribution)', async () => {
    const NO_TITLE = `
nt_target:
  author: [Solo One]
  venue: WWW
  year: 2012
nt_c1:
  title: Some Long Title Words Here
  author: [Solo One]
  venue: WWW
  year: 2012
`;
    const res = await getSimilar(NO_TITLE, 'nt_target');
    assert.equal(res.status, 200);
    const c = res.body.similar.find(s => s.key === 'nt_c1');
    assert.equal(c.score, 6); // 3 author + 2 venue + 1 year, no title overlap
  });

  it('404s for an unknown key', async () => {
    const res = await getSimilar(FIXTURE, 'does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Reference not found' });
  });
});
