import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createOpenRouterKeys, CREDIT, TOTAL} = require('../../../src/server/openrouter-keys.js');

/** OpenRouter's /keys and /workspaces, in memory: each key's limit and usage by hash, and the budgets. */
function fakeOpenRouter({workspace = false} = {}) {
  const keys = new Map();
  const calls = [];
  const budgets = {};
  let next = 0;
  let made = workspace;
  const fetchImpl = async (url, init) => {
    const full = new URL(url).pathname.replace('/api/v1', '');
    assert.equal(init.headers.Authorization, 'Bearer mgmt');
    const answer = body => new Response(JSON.stringify(body), {status: 200});
    if (full.startsWith('/workspaces')) {
      calls.push(`${init.method} ${full}`);
      if (init.method === 'GET') return made ? answer({data: {id: 'ws1'}}) : new Response('{"error":"not found"}', {status: 404});
      if (init.method === 'POST') {
        assert.deepEqual(JSON.parse(init.body), {name: 'Mochi', slug: 'mochi'});
        made = true;
        return answer({data: {id: 'ws1'}});
      }
      budgets[full] = JSON.parse(init.body);
      return answer({data: {}});
    }
    const path = full.replace('/keys', '');
    calls.push(`${init.method} ${path || '/'}`);
    if (init.method === 'POST') {
      const {limit, workspace_id: workspaceId} = JSON.parse(init.body);
      assert.equal(workspaceId, 'ws1');
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
  return {keys, calls, budgets, fetchImpl};
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
    assert.equal(await keys.give('u1'), 'sk-or-v1-0000000000h1');
    assert.deepEqual(openrouter.keys.get('h1'), {limit: CREDIT, usage: 0});
    assert.equal(grants.rows.get('u1'), 'h1');
  });

  it('makes Mochi\'s workspace once, with every member\'s budget together, and finds it after', async () => {
    const openrouter = fakeOpenRouter();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants: fakeGrants(), fetchImpl: openrouter.fetchImpl});
    await keys.give('u1');
    await keys.give('u2');
    assert.deepEqual(openrouter.budgets, {'/workspaces/ws1/budgets/lifetime': {limit_usd: TOTAL}});
    assert.deepEqual(openrouter.calls.filter(call => call.includes('workspaces')), [
      'GET /workspaces/mochi', 'POST /workspaces', 'PUT /workspaces/ws1/budgets/lifetime',
    ]);
    const found = fakeOpenRouter({workspace: true});
    const again = createOpenRouterKeys({managementKey: 'mgmt', grants: fakeGrants(), fetchImpl: found.fetchImpl});
    assert.equal(await again.workspaceId(), 'ws1');
    assert.deepEqual(found.calls, ['GET /workspaces/mochi', 'PUT /workspaces/ws1/budgets/lifetime']);
  });

  it('replaces a member\'s key with one holding what it had left, and none once it is spent', async () => {
    const openrouter = fakeOpenRouter();
    const grants = fakeGrants();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants, fetchImpl: openrouter.fetchImpl});
    await keys.give('u1');
    openrouter.keys.get('h1').usage = 3.5;
    assert.equal(await keys.give('u1'), 'sk-or-v1-0000000000h2');
    assert.deepEqual([...openrouter.keys], [['h2', {limit: 1.5, usage: 0}]]);
    assert.equal(grants.rows.get('u1'), 'h2');
    openrouter.keys.get('h2').usage = 1.5;
    assert.equal(await keys.give('u1'), null);
    assert.deepEqual(openrouter.calls.filter(call => !call.includes('workspaces')), ['POST /', 'GET /h1', 'POST /', 'DELETE /h1', 'GET /h2']);
  });

  it('makes one key at a time for a member, so two computers at once share one credit', async () => {
    const openrouter = fakeOpenRouter();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', grants: fakeGrants(), fetchImpl: openrouter.fetchImpl});
    await Promise.all([keys.give('u1'), keys.give('u1')]);
    assert.deepEqual([...openrouter.keys.keys()], ['h2']);
    assert.equal(openrouter.keys.get('h2').limit, CREDIT);
  });

  it('fails clearly when OpenRouter refuses', async () => {
    const keys = createOpenRouterKeys({
      managementKey: 'mgmt', grants: fakeGrants(), fetchImpl: async () => new Response('{"error":"bad key"}', {status: 401}),
    });
    await assert.rejects(keys.give('u1'), /OpenRouter GET \/workspaces\/mochi failed \(401\)/);
  });
});
