import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createOpenRouterKeys, CREDIT} = require('../../../src/server/openrouter-keys.js');

/** OpenRouter's /keys, in memory: each key's limit and usage, by hash. */
function fakeOpenRouter() {
  const keys = new Map();
  const calls = [];
  let next = 0;
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname.replace('/api/v1/keys', '');
    calls.push(`${init.method} ${path || '/'}`);
    assert.equal(init.headers.Authorization, 'Bearer mgmt');
    const answer = body => new Response(JSON.stringify(body), {status: 200});
    if (init.method === 'POST') {
      const {limit} = JSON.parse(init.body);
      const hash = `h${next += 1}`;
      keys.set(hash, {limit, usage: 0});
      return answer({data: {hash, limit}, key: `sk-or-${hash}`});
    }
    const key = keys.get(path.slice(1));
    if (!key) return new Response('{"error":"not found"}', {status: 404});
    if (init.method === 'GET') return answer({data: {limit_remaining: key.limit - key.usage}});
    keys.delete(path.slice(1));
    return answer({deleted: true});
  };
  return {keys, calls, fetchImpl};
}

function fakeGrants() {
  const rows = new Map();
  return {rows, hash: async userId => rows.get(userId) ?? null, put: async (userId, hash) => { rows.set(userId, hash); }};
}

describe('the OpenRouter key Mochi gives a member (server/openrouter-keys.js)', () => {
  it('makes a member their first key with all of their credit, keeping only its hash', async () => {
    const openrouter = fakeOpenRouter();
    const grants = fakeGrants();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants, fetchImpl: openrouter.fetchImpl});
    assert.equal(await keys.give('u1'), 'sk-or-h1');
    assert.deepEqual(openrouter.keys.get('h1'), {limit: CREDIT, usage: 0});
    assert.equal(grants.rows.get('u1'), 'h1');
  });

  it('replaces a member\'s key with one holding what it had left, and none once it is spent', async () => {
    const openrouter = fakeOpenRouter();
    const grants = fakeGrants();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants, fetchImpl: openrouter.fetchImpl});
    await keys.give('u1');
    openrouter.keys.get('h1').usage = 3.5;
    assert.equal(await keys.give('u1'), 'sk-or-h2');
    assert.deepEqual([...openrouter.keys], [['h2', {limit: 1.5, usage: 0}]]);
    assert.equal(grants.rows.get('u1'), 'h2');
    openrouter.keys.get('h2').usage = 1.5;
    assert.equal(await keys.give('u1'), null);
    assert.deepEqual(openrouter.calls, ['POST /', 'GET /h1', 'POST /', 'DELETE /h1', 'GET /h2']);
  });

  it('fails clearly when OpenRouter refuses', async () => {
    const keys = createOpenRouterKeys({
      managementKey: 'mgmt', grants: fakeGrants(), fetchImpl: async () => new Response('{"error":"bad key"}', {status: 401}),
    });
    await assert.rejects(keys.give('u1'), /OpenRouter POST \/keys failed \(401\)/);
  });
});
