import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

const {createDocumentCache, memoryStore} = await import('../../../src/utils/documentCache.js');

const scope = {userId: 'ada', workspaceId: 'lab'};
const root = '/api/workspaces/lab/documents';
const view = path => ({
  document: {id: `id-${path}`, path, title: path, updatedAt: '2026-10-07T10:00:00.000Z'},
  markdown: `# ${path}`,
  tree: {type: 'root', children: []},
  frontmatter: {},
});

/** A server answering the cache's requests from `documents`; `offline` makes every call throw. */
function fakeServer(documents) {
  const server = {documents, offline: false, calls: []};
  server.request = async (method, path, body) => {
    server.calls.push([method, path, body]);
    if (server.offline) throw new TypeError('fetch failed');
    if (method === 'GET' && path.startsWith(`${root}/tree`)) {
      return {ok: true, status: 200, data: {documents: Object.values(server.documents).map(item => item.document)}};
    }
    if (method === 'GET' && path.startsWith(`${root}?path=`)) {
      const found = server.documents[decodeURIComponent(path.slice(`${root}?path=`.length))];
      return found ? {ok: true, status: 200, data: found} : {ok: false, status: 404, data: {}};
    }
    if (method === 'PUT') {
      const current = server.documents[body.path];
      if (current.document.updatedAt !== body.baseUpdatedAt) {
        return {ok: false, status: 409, data: {code: 'document-conflict'}};
      }
      const document = {...current.document, updatedAt: '2026-10-07T12:00:00.000Z'};
      server.documents[body.path] = {...current, document, markdown: body.markdown};
      return {ok: true, status: 200, data: {document, tree: {type: 'root', children: ['saved']}, frontmatter: {}}};
    }
    if (method === 'POST') {
      if (server.documents[body.path]) return {ok: false, status: 409, data: {code: 'path-taken'}};
      server.documents[body.path] = {...view(body.path), markdown: body.markdown};
      return {ok: true, status: 201, data: {document: server.documents[body.path].document}};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return server;
}

function cacheFor(server, options = {}) {
  const events = [];
  const cache = createDocumentCache({
    store: memoryStore(), request: server.request, emit: event => events.push(event),
    now: () => Date.UTC(2026, 9, 7), ...options,
  });
  return {cache, events};
}

describe('browser document cache', () => {
  it('keeps documents per user and workspace', async () => {
    const {cache} = cacheFor(fakeServer({}));
    await cache.remember(scope, '?path=a.md', view('a.md'));
    assert.equal((await cache.read(scope, '?path=a.md')).data.markdown, '# a.md');
    assert.equal(await cache.read({userId: 'bob', workspaceId: 'lab'}, '?path=a.md'), null);
    assert.equal(await cache.read({userId: 'ada', workspaceId: 'other'}, '?path=a.md'), null);
  });

  it('evicts the least recently opened documents beyond its limit', async () => {
    let clock = 0;
    const {cache} = cacheFor(fakeServer({}), {limit: 2, now: () => ++clock});
    await cache.remember(scope, '?path=a.md', view('a.md'));
    await cache.remember(scope, '?path=b.md', view('b.md'));
    await cache.read(scope, '?path=a.md');
    await cache.remember(scope, '?path=c.md', view('c.md'));
    assert.ok(await cache.read(scope, '?path=a.md'));
    assert.equal(await cache.read(scope, '?path=b.md'), null);
    assert.ok(await cache.read(scope, '?path=c.md'));
  });

  it('refetches documents changed on the server and drops deleted ones', async () => {
    const server = fakeServer({'a.md': view('a.md'), 'b.md': view('b.md')});
    const {cache, events} = cacheFor(server);
    await cache.remember(scope, '?path=a.md', view('a.md'));
    await cache.remember(scope, '?path=b.md', view('b.md'));

    server.documents['a.md'] = {
      ...view('a.md'), markdown: 'edited on the web',
      document: {...view('a.md').document, updatedAt: '2026-10-07T11:00:00.000Z'},
    };
    delete server.documents['b.md'];
    await cache.refresh(scope);

    assert.equal((await cache.read(scope, '?path=a.md')).data.markdown, 'edited on the web');
    assert.equal(await cache.read(scope, '?path=b.md'), null);
    assert.deepEqual(events.map(event => event.view), ['?path=a.md']);
  });

  it('refetches listings only when the workspace changed', async () => {
    const server = fakeServer({'a.md': view('a.md')});
    const {cache} = cacheFor(server);
    await cache.remember(scope, '/tree?prefix=docs', {documents: []});
    await cache.refresh(scope);
    await cache.refresh(scope);
    const listings = server.calls.filter(([, path]) => path === `${root}/tree?prefix=docs`);
    assert.equal(listings.length, 1);
  });

  it('uploads a save queued offline once the server is reachable', async () => {
    const server = fakeServer({'a.md': view('a.md')});
    const {cache, events} = cacheFor(server);
    await cache.remember(scope, '?path=a.md', view('a.md'));
    server.offline = true;
    await cache.queueSave(scope, {
      path: 'a.md', markdown: 'written offline', baseUpdatedAt: '2026-10-07T10:00:00.000Z', tree: null, frontmatter: {},
    });
    await cache.refresh(scope);
    assert.equal((await cache.read(scope, '?path=a.md')).data.markdown, 'written offline');
    assert.equal(server.documents['a.md'].markdown, '# a.md');

    server.offline = false;
    await cache.refresh(scope);
    assert.equal(server.documents['a.md'].markdown, 'written offline');
    const cached = (await cache.read(scope, '?path=a.md')).data;
    assert.equal(cached.document.updatedAt, '2026-10-07T12:00:00.000Z');
    assert.deepEqual(cached.tree, {type: 'root', children: ['saved']});
    assert.equal(events.at(-1).uploaded, true);
  });

  it('keeps an offline save as a conflicted copy when the server version changed', async () => {
    const server = fakeServer({'notes/a.md': view('notes/a.md')});
    const {cache, events} = cacheFor(server);
    await cache.queueSave(scope, {
      path: 'notes/a.md', markdown: 'mine', baseUpdatedAt: '2026-10-07T09:00:00.000Z', tree: null, frontmatter: {},
    });
    await cache.refresh(scope);
    const copy = 'notes/a (conflicted copy 2026-10-07).md';
    assert.equal(server.documents[copy].markdown, 'mine');
    assert.equal(server.documents['notes/a.md'].markdown, '# notes/a.md');
    assert.equal(events.at(-1).conflictedCopy, copy);
  });

  it('reports a refused save once and keeps its text', async () => {
    const server = fakeServer({'a.md': view('a.md')});
    server.request = async (method, path, body) => method === 'PUT'
      ? {ok: false, status: 422, data: {error: 'This document could not be rendered'}}
      : fakeServer(server.documents).request(method, path, body);
    const {cache, events} = cacheFor(server);
    await cache.queueSave(scope, {
      path: 'a.md', markdown: '<Broken', baseUpdatedAt: '2026-10-07T10:00:00.000Z', tree: null, frontmatter: {},
    });
    await cache.refresh(scope);
    await cache.refresh(scope);
    assert.deepEqual(events.filter(event => event.error).length, 1);
  });

  it('downloads a document kept on this computer and never evicts it', async () => {
    let clock = 0;
    const server = fakeServer({'kept.md': view('kept.md')});
    const {cache} = cacheFor(server, {limit: 1, now: () => ++clock});
    await cache.setPinned(scope, 'kept.md', true);
    await cache.remember(scope, '?path=a.md', view('a.md'));
    await cache.remember(scope, '?path=b.md', view('b.md'));
    assert.ok(await cache.read(scope, '?path=kept.md'));
    assert.deepEqual([...await cache.cachedPaths(scope)], [
      ['b.md', {pinned: false, pending: false}],
      ['kept.md', {pinned: true, pending: false}],
    ]);

    await cache.setPinned(scope, 'kept.md', false);
    assert.deepEqual([...(await cache.cachedPaths(scope)).keys()], ['kept.md']);
  });

  it('reports a document edited offline as waiting to upload', async () => {
    const {cache} = cacheFor(fakeServer({}));
    await cache.remember(scope, '?path=a.md', view('a.md'));
    await cache.queueSave(scope, {path: 'a.md', markdown: 'x', baseUpdatedAt: 'then', tree: null});
    assert.deepEqual((await cache.cachedPaths(scope)).get('a.md'), {pinned: false, pending: true});
  });

  it('forgets everything on clear, including the remembered account', async () => {
    const {cache} = cacheFor(fakeServer({}));
    await cache.remember(scope, '?path=a.md', view('a.md'));
    await cache.rememberAccount({userId: 'ada', workspaces: []});
    assert.deepEqual(await cache.account(), {userId: 'ada', workspaces: []});
    await cache.clear();
    assert.equal(await cache.read(scope, '?path=a.md'), null);
    assert.equal(await cache.account(), undefined);
  });
});
