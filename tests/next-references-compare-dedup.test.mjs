import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

// study-knowledge.js is CommonJS; load it the way the other server route tests do.
const require = createRequire(import.meta.url);
const studyKnowledgeRoutes = require('../server/routes/study-knowledge.js');
const yaml = require('js-yaml');

const PROJECT_ROOT = '/proj';

// Drive GET /api/references/compare in-process with a mocked ctx and capture the
// response the handler hands to json(res, status, body). The handler requires
// js-yaml directly and reads the single references.yaml straight from fs, so a
// readFileSync stub returning a fixture YAML string is all the comparison needs.
async function compare(refs, search) {
  const refsYaml = yaml.dump(refs);
  let captured = null;
  const ctx = {
    fs: { readFileSync: () => refsYaml },
    path,
    PROJECT_ROOT,
    json: (_res, status, body) => { captured = { status, body }; },
  };
  const url = new URL(`http://localhost/api/references/compare${search}`);
  const req = { method: 'GET' };
  const res = { writableEnded: false };
  await studyKnowledgeRoutes(req, res, url, '/api/references/compare', ctx);
  return captured;
}

describe('GET /api/references/compare (sharedTitleWords deduped via a Set)', () => {
  it('collapses a title word repeated in paper2 to a single shared entry', async () => {
    const refs = {
      p1: { title: 'Neural Networks', author: ['Alice'], year: 2020, venue: 'NeurIPS' },
      p2: { title: 'Neural Networks for Neural Search', author: ['Bob'], year: 2021, venue: 'ICML' },
    };
    const r = await compare(refs, '?key1=p1&key2=p2');
    assert.equal(r.status, 200);
    // "neural" appears twice in paper2's title yet must surface once. Before the
    // Set dedup the result was ["neural", "networks", "neural"].
    assert.deepEqual(r.body.comparison.sharedTitleWords, ['neural', 'networks']);
    // The sibling sharedAuthors stays correct: Alice and Bob share nothing.
    assert.deepEqual(r.body.comparison.sharedAuthors, []);
  });

  it('leaves a no-repeat title comparison unchanged', async () => {
    const refs = {
      p1: { title: 'Deep Reinforcement Learning', author: ['Alice'], year: 2018, venue: 'NeurIPS' },
      p2: { title: 'Reinforcement Learning Theory', author: ['Bob'], year: 2019, venue: 'ICML' },
    };
    const r = await compare(refs, '?key1=p1&key2=p2');
    assert.equal(r.status, 200);
    // Words over three characters shared by both titles, in paper2's order:
    // "reinforcement", "learning". No word repeats, so the Set is a no-op here.
    assert.deepEqual(r.body.comparison.sharedTitleWords, ['reinforcement', 'learning']);
  });

  it('returns 400 when a key is missing', async () => {
    const refs = { p1: { title: 'A Neural Study' } };
    const r = await compare(refs, '?key1=p1');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Missing key1 or key2/);
  });

  it('returns 404 when a key is unknown', async () => {
    const refs = { p1: { title: 'A Neural Study' } };
    const r = await compare(refs, '?key1=p1&key2=ghost');
    assert.equal(r.status, 404);
    assert.match(r.body.error, /not found/);
  });
});
