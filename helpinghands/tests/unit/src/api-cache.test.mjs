import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

const originalFetch = globalThis.fetch;
const api = await import(`../../../src/utils/api.js?cache-test=${Date.now()}`);

afterEach(() => {
  globalThis.fetch = originalFetch;
  api.invalidateApiJson();
});

describe('read-only API response cache', () => {
  it('deduplicates concurrent requests and reuses a warm response', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({value: calls}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      });
    };
    const url = 'http://localhost:3001/api/health?cache=dedupe';
    const [first, second] = await Promise.all([
      api.apiJson(url, {cacheMs: 10_000}),
      api.apiJson(url, {cacheMs: 10_000}),
    ]);
    const third = await api.apiJson(url, {cacheMs: 10_000});

    assert.equal(calls, 1);
    assert.deepEqual(first.data, {value: 1});
    assert.deepEqual(second.data, {value: 1});
    assert.deepEqual(third.data, {value: 1});
    assert.deepEqual(api.getCachedApiJson(url)?.data, {value: 1});
  });

  it('drops matching entries after a mutation invalidates their prefix', async () => {
    let calls = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({value: ++calls}), {status: 200});
    const root = 'http://localhost:3001/api/workspaces/lab/documents';
    await api.apiJson(`${root}?path=a`, {cacheMs: 10_000});
    api.invalidateApiJson(root);
    const refreshed = await api.apiJson(`${root}?path=a`, {cacheMs: 10_000});

    assert.equal(calls, 2);
    assert.deepEqual(refreshed.data, {value: 2});
  });

  it('does not retain failed responses', async () => {
    let calls = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({error: 'missing'}), {status: ++calls === 1 ? 404 : 200});
    const url = 'http://localhost:3001/api/health?cache=errors';
    assert.equal((await api.apiJson(url, {cacheMs: 10_000})).status, 404);
    assert.equal((await api.apiJson(url, {cacheMs: 10_000})).status, 200);
    assert.equal(calls, 2);
  });
});

describe('account-wide API paths on a workspace page', () => {
  it('asks for runner status unscoped on a workspace the member is not in', async () => {
    const {installClientPlatform, resetClientPlatform} = await import('../../../src/platform/client.js');
    installClientPlatform({runtimeConfig: () => ({}), location: {pathname: () => '/w/not-mine/docs'}});
    const asked = [];
    globalThis.fetch = async input => {
      asked.push(typeof input === 'string' ? input : input.url);
      return new Response(JSON.stringify({connected: true}), {status: 200});
    };
    try {
      assert.deepEqual(await api.apiRequest('/api/runner/status'), {connected: true});
      assert.deepEqual(asked, ['/api/runner/status']);
    } finally {
      resetClientPlatform();
    }
  });

  it('reads benchmarks in the workspace the page is in, the list with its query too', async () => {
    const {installClientPlatform, resetClientPlatform} = await import('../../../src/platform/client.js');
    installClientPlatform({runtimeConfig: () => ({}), location: {pathname: () => '/w/mine/apps'}});
    const asked = [];
    globalThis.fetch = async input => {
      const url = typeof input === 'string' ? input : input.url;
      asked.push(url);
      return new Response(JSON.stringify(url.endsWith('/api/workspaces') ? {workspaces: [{slug: 'mine', id: 'w1'}]} : {}), {status: 200});
    };
    try {
      await api.apiRequest('/api/benchmark/benchmarks?plugin_id=p');
      await api.apiRequest('/api/benchmark/benchmarks/b1');
      assert.deepEqual(asked.filter(url => url.includes('benchmarks')), ['/api/workspaces/w1/benchmark/benchmarks?plugin_id=p', '/api/workspaces/w1/benchmark/benchmarks/b1']);
    } finally {
      resetClientPlatform();
    }
  });
});
