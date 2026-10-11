import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

const {memoryStore} = await import('../../../src/utils/documentCache.js');
const {createFsReplica} = await import('../../../src/utils/fsReplica.js');

const scope = {userId: 'ada', workspaceId: 'lab'};
const root = '/api/workspaces/lab/fs';

/** A file system server: `files` maps path to {text, rev}; every change bumps one global seq. */
function fakeServer(initial = {}) {
  let seq = 0;
  const server = {files: new Map(), changes: [], offline: false};
  server.put = (path, text) => {
    seq += 1;
    server.files.set(path, {text, rev: seq});
    server.changes.push({seq, path});
    return seq;
  };
  server.drop = path => {
    seq += 1;
    server.files.delete(path);
    server.changes.push({seq, path});
  };
  for (const [path, text] of Object.entries(initial)) server.put(path, text);
  server.request = async (method, url, {body} = {}) => {
    if (server.offline) throw new TypeError('fetch failed');
    const target = new URL(url, 'http://test');
    const path = target.searchParams.get('path');
    if (method === 'GET' && target.pathname === `${root}/changes`) {
      const since = Number(target.searchParams.get('since'));
      const changes = server.changes.filter(change => change.seq > since);
      return {ok: true, status: 200, data: {changes, cursor: changes.at(-1)?.seq ?? since, more: false}};
    }
    if (method === 'GET' && target.pathname === `${root}/tree`) {
      const nodes = [...server.files].map(([nodePath, file]) => ({path: nodePath, kind: 'file', rev: file.rev}));
      return {ok: true, status: 200, data: {nodes}};
    }
    if (method === 'GET' && target.pathname === `${root}/file`) {
      const file = server.files.get(path);
      return file ? {ok: true, status: 200, text: file.text, rev: file.rev} : {ok: false, status: 404, data: {}};
    }
    if (method === 'PUT' && target.pathname === `${root}/file`) {
      const baseRev = Number(target.searchParams.get('baseRev'));
      const current = server.files.get(path);
      if ((current?.rev ?? 0) !== baseRev) {
        return {ok: false, status: 409, data: {code: current && baseRev === 0 ? 'exists' : 'stale-revision'}};
      }
      return {ok: true, status: 200, data: {node: {path, rev: server.put(path, body)}}};
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return server;
}

function replicaFor(server, options = {}) {
  const events = [];
  const replica = createFsReplica({
    store: memoryStore(), request: server.request, emit: event => events.push(event), now: () => Date.UTC(2026, 9, 7), ...options,
  });
  return {replica, events};
}

describe('browser file system replica', () => {
  it('lists the tree, then follows only what changed', async () => {
    const server = fakeServer({'notes/a.md': 'a', 'notes/b.md': 'b'});
    const {replica} = replicaFor(server);
    assert.equal(await replica.refresh(scope), true);
    assert.deepEqual((await replica.tree(scope)).map(node => node.path), ['notes/a.md', 'notes/b.md']);
    assert.equal(await replica.refresh(scope), false);
    server.put('notes/c.md', 'c');
    assert.equal(await replica.refresh(scope), true);
    assert.equal((await replica.tree(scope)).length, 3);
  });

  it('refetches kept files that changed and drops deleted ones', async () => {
    const server = fakeServer({'a.md': 'one', 'b.md': 'two'});
    const {replica} = replicaFor(server);
    await replica.refresh(scope);
    await replica.remember(scope, 'a.md', {text: 'one', rev: server.files.get('a.md').rev});
    await replica.remember(scope, 'b.md', {text: 'two', rev: server.files.get('b.md').rev});
    server.put('a.md', 'one, edited');
    server.drop('b.md');
    await replica.refresh(scope);
    assert.equal((await replica.read(scope, 'a.md')).text, 'one, edited');
    assert.equal(await replica.read(scope, 'b.md'), null);
  });

  it('uploads a save made offline once the server answers', async () => {
    const server = fakeServer({'a.md': 'one'});
    const {replica, events} = replicaFor(server);
    await replica.refresh(scope);
    const rev = server.files.get('a.md').rev;
    server.offline = true;
    await replica.queueWrite(scope, {path: 'a.md', text: 'offline', baseRev: rev});
    assert.equal(await replica.refresh(scope), false);
    assert.deepEqual((await replica.held(scope)).get('a.md'), {pinned: false, pending: true});
    server.offline = false;
    await replica.refresh(scope);
    assert.equal(server.files.get('a.md').text, 'offline');
    assert.equal(events.find(event => event.uploaded).path, 'a.md');
    assert.deepEqual((await replica.held(scope)).get('a.md'), {pinned: false, pending: false});
  });

  it('keeps an offline save as a conflicted copy when the file changed meanwhile', async () => {
    const server = fakeServer({'notes/a.md': 'base'});
    const {replica, events} = replicaFor(server);
    await replica.queueWrite(scope, {path: 'notes/a.md', text: 'mine', baseRev: server.files.get('notes/a.md').rev});
    server.put('notes/a.md', 'theirs');
    await replica.refresh(scope);
    const copy = 'notes/a (conflicted copy 2026-10-07).md';
    assert.equal(server.files.get(copy).text, 'mine');
    assert.equal(server.files.get('notes/a.md').text, 'theirs');
    assert.equal(events.find(event => event.conflictedCopy).conflictedCopy, copy);
  });

  it('downloads a pinned file and keeps it through eviction', async () => {
    let clock = 0;
    const server = fakeServer({'kept.md': 'kept', 'a.md': 'a', 'b.md': 'b'});
    const {replica} = replicaFor(server, {limit: 1, now: () => ++clock});
    await replica.setPinned(scope, 'kept.md', true);
    await replica.remember(scope, 'a.md', {text: 'a', rev: 2});
    await replica.remember(scope, 'b.md', {text: 'b', rev: 3});
    assert.equal((await replica.read(scope, 'kept.md')).text, 'kept');
    assert.deepEqual([...(await replica.held(scope)).keys()].sort(), ['b.md', 'kept.md']);
  });
});
