import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const routes = require('../../../../../src/server/routes/misc-tools.js');

function makeState(records) {
  return {reads: 0, records: structuredClone(records)};
}

async function callSuggest(state, text) {
  const pathname = '/api/suggest';
  const url = new URL(`http://localhost${pathname}?text=${encodeURIComponent(text)}`);
  const req = {method: 'GET', context: {workspaceId: 'workspace-1', userId: 'user-1'}};
  const res = {writableEnded: false};
  let captured = null;
  const ctx = {
    references: {
      openPapers: () => ({
        entries() {
          state.reads++;
          return structuredClone(state.records);
        },
      }),
    },
    collection() {},
    scopeFor: () => ({workspaceId: 'workspace-1', userId: 'user-1'}),
    fs: {existsSync: () => false},
    path: require('node:path'),
    contentRootFor: () => '/content/workspace-1',
    flatFiles: () => [],
    json(_res, status, payload) {
      captured = {status, payload};
      res.writableEnded = true;
      return captured;
    },
  };
  await routes(req, res, url, pathname, ctx);
  return captured;
}

describe('GET /api/suggest database-backed references', () => {
  const initial = {
    vaswani2017: {title: 'Attention Is All You Need', author: ['Ashish Vaswani']},
    goodfellow2016: {title: 'Deep Learning', author: ['Ian Goodfellow']},
  };

  it('matches references from the scoped database', async () => {
    const state = makeState(initial);
    const result = await callSuggest(state, 'attention transformer');
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload, {
      references: [{key: 'vaswani2017', title: 'Attention Is All You Need', relevance: 1}],
      pages: [],
    });
  });

  it('reads the scoped records for each request', async () => {
    const state = makeState(initial);
    const first = await callSuggest(state, 'attention transformer');
    const second = await callSuggest(state, 'attention transformer');
    assert.deepEqual(second.payload, first.payload);
    assert.equal(state.reads, 2);
  });

  it('reflects database updates without a filesystem cache', async () => {
    const state = makeState(initial);
    const before = await callSuggest(state, 'attention transformer');
    assert.equal(before.payload.references.length, 1);
    state.records.goodfellow2016.title = 'Transformer Architectures';
    const after = await callSuggest(state, 'attention transformer');
    assert.deepEqual(after.payload.references, [
      {key: 'vaswani2017', title: 'Attention Is All You Need', relevance: 1},
      {key: 'goodfellow2016', title: 'Transformer Architectures', relevance: 1},
    ]);
  });

  it('returns no reference matches for an empty database', async () => {
    const result = await callSuggest(makeState({}), 'attention transformer');
    assert.deepEqual(result.payload, {references: [], pages: []});
  });
});
