import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createOpenRouterKeys, keyHint, CREDIT} = require('../../../src/server/openrouter-keys.js');

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
      return answer({data: {hash, limit}, key: `sk-or-v1-0000000000${hash}`});
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
  return {rows, get: async userId => rows.get(userId) ?? null, put: async (userId, grant) => { rows.set(userId, grant); }};
}

describe('the OpenRouter key Mochi gives a member (server/openrouter-keys.js)', () => {
  it('makes a member their first key with all of their credit, keeping only its hash', async () => {
    const openrouter = fakeOpenRouter();
    const grants = fakeGrants();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants, fetchImpl: openrouter.fetchImpl});
    assert.equal(await keys.give('u1'), 'sk-or-v1-0000000000h1');
    assert.deepEqual(openrouter.keys.get('h1'), {limit: CREDIT, usage: 0});
    assert.deepEqual(grants.rows.get('u1'), {hash: 'h1', hint: 'sk-or-…00h1'});
  });

  it('replaces a member\'s key with one holding what it had left, and none once it is spent', async () => {
    const openrouter = fakeOpenRouter();
    const grants = fakeGrants();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants, fetchImpl: openrouter.fetchImpl});
    await keys.give('u1');
    openrouter.keys.get('h1').usage = 3.5;
    assert.equal(await keys.give('u1'), 'sk-or-v1-0000000000h2');
    assert.deepEqual([...openrouter.keys], [['h2', {limit: 1.5, usage: 0}]]);
    assert.equal(grants.rows.get('u1').hash, 'h2');
    openrouter.keys.get('h2').usage = 1.5;
    assert.equal(await keys.give('u1'), null);
    assert.deepEqual(openrouter.calls, ['POST /', 'GET /h1', 'POST /', 'DELETE /h1', 'GET /h2']);
  });

  it('makes one key at a time for a member, so two computers at once share one credit', async () => {
    const openrouter = fakeOpenRouter();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants: fakeGrants(), fetchImpl: openrouter.fetchImpl});
    await Promise.all([keys.give('u1'), keys.give('u1')]);
    assert.deepEqual([...openrouter.keys.keys()], ['h2']);
    assert.equal(openrouter.keys.get('h2').limit, CREDIT);
  });

  it('tells what is spent of the credit, in all, only for the key Mochi made the member', async () => {
    const openrouter = fakeOpenRouter();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants: fakeGrants(), fetchImpl: openrouter.fetchImpl});
    const first = await keys.give('u1');
    openrouter.keys.get('h1').usage = 2;
    const second = await keys.give('u1');
    openrouter.keys.get('h2').usage = 0.5;
    assert.deepEqual(await keys.credit('u1', keyHint(second)), {used: 2.5, total: CREDIT});
    assert.equal(await keys.credit('u1', keyHint(first)), null);
    assert.equal(await keys.credit('u1', 'sk-or-…mine'), null);
    assert.equal(await keys.credit('u2', keyHint(second)), null);
  });

  it('fails clearly when OpenRouter refuses', async () => {
    const keys = createOpenRouterKeys({
      managementKey: 'mgmt', grants: fakeGrants(), fetchImpl: async () => new Response('{"error":"bad key"}', {status: 401}),
    });
    await assert.rejects(keys.give('u1'), /OpenRouter POST \/keys failed \(401\)/);
  });
});
