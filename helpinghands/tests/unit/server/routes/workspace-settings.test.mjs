import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {invoke, makeCtx} from '../../_harness.mjs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const routes = require('../../../../src/server/routes/workspace-settings.js');
const context = (role, workspaceId = 'lab') => ({
  userId: 'ada', workspaceId, membershipId: `member-${workspaceId}`, role,
});

describe('workspace settings routes', () => {
  it('lets every member read shared settings', async () => {
    const ctx = makeCtx();
    const owner = context('owner');
    await invoke(routes, {method: 'PUT', path: '/api/workspaces/lab/settings', body: {settings: {brand: 'Mochi'}}, ctx, requestContext: owner});
    const read = await invoke(routes, {path: '/api/workspaces/lab/settings', ctx, requestContext: context('viewer')});
    assert.equal(read.payload.settings.brand, 'Mochi');
  });

  it('only lets owners change shared settings', async () => {
    const denied = await invoke(routes, {method: 'PUT', path: '/api/workspaces/lab/settings', body: {settings: {brand: 'Nope'}}, requestContext: context('editor')});
    assert.equal(denied.status, 403);
    assert.equal(denied.payload.code, 'workspace-permission-denied');
  });

  it('keeps member preferences separate inside a workspace', async () => {
    const ctx = makeCtx();
    await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/member-preferences', ctx,
      body: {settings: {sidebar: 'compact', subscriptions: {
        books: ['survey'], groups: {blog: ['Research']},
      }}},
      requestContext: context('viewer'),
    });
    const own = await invoke(routes, {path: '/api/workspaces/lab/member-preferences', ctx, requestContext: context('viewer')});
    assert.deepEqual(own.payload.settings.subscriptions, {
      books: ['survey'], groups: {blog: ['Research']},
    });
    const other = {...context('viewer'), userId: 'grace', membershipId: 'member-2'};
    const read = await invoke(routes, {path: '/api/workspaces/lab/member-preferences', ctx, requestContext: other});
    assert.deepEqual(read.payload.settings, {});
  });

  it('does not derive organization configuration from document paths', async () => {
    const ctx = makeCtx();
    const owner = context('owner');
    await ctx.documents.create(owner, {path: 'books/math/0-intro.md', markdown: '# Math'});
    await ctx.documents.create(owner, {path: 'posts/research/paper.md', markdown: '# Paper'});
    const read = await invoke(routes, {path: '/api/workspaces/lab/site', ctx, requestContext: context('viewer')});
    assert.equal(read.status, 200);
    assert.deepEqual(read.payload.site.navigation, []);
    assert.deepEqual(read.payload.site.collections, []);
    assert.ok(read.payload.plugins.some(plugin => plugin.name === 'bibliography' && plugin.scope === 'workspace'));
  });

  it('only lets owners save validated workspace site configuration', async () => {
    const ctx = makeCtx();
    const denied = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/site', ctx,
      requestContext: context('editor'), body: {site: {navigation: []}},
    });
    assert.equal(denied.status, 403);

    const saved = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/site', ctx,
      requestContext: context('owner'),
      body: {site: {site: {title: 'Ada Lab'}, navigation: [{label: 'Math', path: 'books/math/0-intro.md'}]}},
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.site.site.title, 'Ada Lab');
    assert.deepEqual(saved.payload.site.navigation, [{label: 'Math', path: 'books/math/0-intro.md'}]);
  });

  it('updates only navbar order and visibility without replacing site structure', async () => {
    const ctx = makeCtx();
    const owner = context('owner');
    await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/site', ctx, requestContext: owner,
      body: {site: {
        site: {title: 'Lab'},
        navigation: [
          {label: 'Docs', path: 'books/docs'},
          {label: 'News', path: 'posts/news'},
        ],
        collections: [{key: 'docs', type: 'docs', pathPrefix: 'books/docs', title: 'Documentation'}],
      }},
    });

    const saved = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/site/navigation', ctx, requestContext: owner,
      body: {navigation: [
        {label: 'News', path: 'posts/news'},
        {label: 'Docs', path: 'books/docs', hidden: true},
      ]},
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.payload.site.site.title, 'Lab');
    assert.deepEqual(saved.payload.site.collections, [
      {key: 'docs', type: 'docs', pathPrefix: 'books/docs', title: 'Documentation', description: null, sidebarTitle: null, landingPath: null, showReadingTime: false},
    ]);
    assert.deepEqual(saved.payload.site.navigation, [
      {label: 'News', path: 'posts/news'},
      {label: 'Docs', path: 'books/docs', hidden: true},
    ]);

    const edited = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/site/navigation', ctx, requestContext: owner,
      body: {navigation: [{label: 'Different', path: 'elsewhere'}]},
    });
    assert.equal(edited.status, 400);
    assert.match(edited.payload.error, /only be reordered or shown and hidden/);
  });

  it('keeps branding, navigation, and plugin switches isolated by workspace', async () => {
    const ctx = makeCtx();
    const alpha = context('owner', 'alpha');
    const beta = context('owner', 'beta');
    await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/alpha/site', ctx, requestContext: alpha,
      body: {site: {
        site: {title: 'Alpha'},
        navigation: [{label: 'Handbook', path: 'handbook/intro.md'}],
        plugins: {bibliography: {enabled: false}},
      }},
    });
    await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/beta/site', ctx, requestContext: beta,
      body: {site: {
        site: {title: 'Beta'},
        navigation: [{label: 'Updates', path: 'updates'}],
        plugins: {bibliography: {enabled: true}},
      }},
    });

    const alphaRead = await invoke(routes, {path: '/api/workspaces/alpha/site', ctx, requestContext: alpha});
    const betaRead = await invoke(routes, {path: '/api/workspaces/beta/site', ctx, requestContext: beta});
    assert.equal(alphaRead.payload.site.site.title, 'Alpha');
    assert.equal(betaRead.payload.site.site.title, 'Beta');
    assert.deepEqual(alphaRead.payload.site.navigation, [{label: 'Handbook', path: 'handbook/intro.md'}]);
    assert.deepEqual(betaRead.payload.site.navigation, [{label: 'Updates', path: 'updates'}]);
    assert.equal(alphaRead.payload.site.plugins.bibliography.enabled, false);
    assert.equal(betaRead.payload.site.plugins.bibliography.enabled, true);
  });
});
