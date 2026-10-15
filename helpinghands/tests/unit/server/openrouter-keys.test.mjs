import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createOpenRouterKeys, TOTAL} = require('../../../src/server/openrouter-keys.js');

/** OpenRouter's /keys and /workspaces, in memory: each key by hash, and the budgets set. */
function fakeOpenRouter({workspace = false, pageSize = 2, slug = 'mochi', name = 'Mochi'} = {}) {
  const keys = new Map();
  const calls = [];
  const budgets = {};
  let next = 0;
  let made = workspace;
  const fetchImpl = async (url, init) => {
    const {pathname, searchParams} = new URL(url);
    const path = pathname.replace('/api/v1', '');
    calls.push(`${init.method} ${path}`);
    assert.equal(init.headers.Authorization, 'Bearer mgmt');
    const answer = body => new Response(JSON.stringify(body), {status: 200});
    if (path === `/workspaces/${slug}`) return made ? answer({data: {id: 'ws1'}}) : new Response('{"error":"not found"}', {status: 404});
    if (path === '/workspaces') {
      assert.deepEqual(JSON.parse(init.body), {name, slug});
      made = true;
      return answer({data: {id: 'ws1'}});
    }
    if (path.startsWith('/workspaces/')) {
      budgets[path] = JSON.parse(init.body);
      return answer({data: {}});
    }
    if (path === '/keys' && init.method === 'GET') {
      assert.equal(searchParams.get('workspace_id'), 'ws1');
      assert.equal(searchParams.get('include_disabled'), 'true');
      const offset = Number(searchParams.get('offset'));
      return answer({data: [...keys.values()].slice(offset, offset + pageSize)});
    }
    if (path === '/keys') {
      const body = JSON.parse(init.body);
      assert.equal(body.workspace_id, 'ws1');
      const hash = `h${next += 1}`;
      keys.set(hash, {hash, name: body.name, usage: 0, disabled: false});
      return answer({data: {hash}, key: `sk-or-${hash}`});
    }
    Object.assign(keys.get(path.replace('/keys/', '')), JSON.parse(init.body));
    return answer({data: {}});
  };
  return {keys, calls, budgets, fetchImpl};
}

describe('the OpenRouter key Mochi gives a member (server/openrouter-keys.js)', () => {
  it('makes Mochi\'s workspace once, with every member\'s budget together, and finds it after', async () => {
    const openrouter = fakeOpenRouter();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', production: true, fetchImpl: openrouter.fetchImpl});
    assert.equal(await keys.give('u1'), 'sk-or-h1');
    await keys.give('u2');
    assert.deepEqual(openrouter.budgets, {'/workspaces/ws1/budgets/lifetime': {limit_usd: TOTAL}});
    assert.deepEqual(openrouter.calls.filter(call => call.includes('workspaces')), [
      'GET /workspaces/mochi', 'POST /workspaces', 'PUT /workspaces/ws1/budgets/lifetime',
    ]);
    const found = fakeOpenRouter({workspace: true});
    const again = createOpenRouterKeys({managementKey: 'mgmt', production: true, fetchImpl: found.fetchImpl});
    assert.equal(await again.workspaceId(), 'ws1');
    assert.deepEqual(found.calls, ['GET /workspaces/mochi', 'PUT /workspaces/ws1/budgets/lifetime']);
  });

  it('keeps every other site\'s keys, whose accounts copy production\'s, in a workspace of their own', async () => {
    const openrouter = fakeOpenRouter({slug: 'mochi-dev', name: 'Mochi (development)'});
    const keys = createOpenRouterKeys({managementKey: 'mgmt', production: false, fetchImpl: openrouter.fetchImpl});
    assert.equal(keys.workspace, 'mochi-dev');
    await keys.give('u1');
    assert.deepEqual(openrouter.calls.slice(0, 2), ['GET /workspaces/mochi-dev', 'POST /workspaces']);
    assert.throws(() => createOpenRouterKeys({managementKey: 'mgmt'}), /production: true or false/);
  });

  it('gives a member a new key, disabling their others, and counts what they spent on all of them', async () => {
    const openrouter = fakeOpenRouter();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', production: true, fetchImpl: openrouter.fetchImpl});
    await keys.give('u1');
    await keys.give('u2');
    openrouter.keys.get('h1').usage = 1.5;
    openrouter.keys.get('h2').usage = 4;
    assert.equal(await keys.give('u1'), 'sk-or-h3');
    openrouter.keys.get('h3').usage = 0.25;
    assert.deepEqual([...openrouter.keys.values()].map(key => [key.hash, key.name, key.disabled]), [
      ['h1', 'Mochi u1', true], ['h2', 'Mochi u2', false], ['h3', 'Mochi u1', false],
    ]);
    assert.equal(await keys.spent('u1'), 1.75);
    assert.equal(await keys.spent('u2'), 4);
    assert.equal(await keys.spent('u3'), 0);
  });

  it('makes one key at a time for a member, so two computers at once leave one enabled', async () => {
    const openrouter = fakeOpenRouter();
    const keys = createOpenRouterKeys({managementKey: 'mgmt', production: true, fetchImpl: openrouter.fetchImpl});
    await Promise.all([keys.give('u1'), keys.give('u1')]);
    assert.deepEqual([...openrouter.keys.values()].filter(key => !key.disabled).map(key => key.hash), ['h2']);
  });

  it('fails clearly when OpenRouter refuses', async () => {
    const keys = createOpenRouterKeys({
      managementKey: 'mgmt', production: true, fetchImpl: async () => new Response('{"error":"bad key"}', {status: 401}),
    });
    await assert.rejects(keys.give('u1'), /OpenRouter GET \/workspaces\/mochi failed \(401\)/);
  });
});
