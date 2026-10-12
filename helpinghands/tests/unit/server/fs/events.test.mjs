import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as Y from 'yjs';
import {invoke, loadRoute, makeCtx} from '../../_harness.mjs';
import {as, migratedDatabase} from './_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresFs} = require('../../../../src/server/fs/store.js');
const {createCrdt} = require('../../../../src/server/fs/crdt.js');
const {createFsHub} = require('../../../../src/server/fs/events.js');

const member = (userId, role) => ({...as(userId), membershipId: `m-${userId}`, role});
const alice = member('alice', 'owner');
const bob = member('bob', 'editor');

/** PGlite has one session, so the streams' reads wait for each other's transactions, as pg's pool keeps them apart. */
function serialized(pool) {
  let queue = Promise.resolve();
  return {
    async connect() {
      let release;
      const turn = queue.then(() => pool.connect());
      queue = turn.then(() => new Promise(resolve => { release = resolve; }));
      const client = await turn;
      return {query: client.query, release: () => { client.release(); release(); }};
    },
  };
}

async function waitFor(condition) {
  for (let tries = 0; !condition(); tries += 1) {
    if (tries > 200) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** A stream as the hub sees it, recording what it is sent. */
async function streamOf(hub, scope) {
  const sent = [];
  const stream = await hub.listen(scope, (event, data) => sent.push({event, data}), () => sent.push({event: 'closed'}));
  return {...stream, sent, batches: () => sent.filter(item => item.event === 'changes').map(item => item.data)};
}

describe('workspace push channel', () => {
  let db;
  let fs;
  let hub;
  let crdt;

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    fs = createPostgresFs({pool: serialized(database.pool), onChange: workspaceId => hub.changed(workspaceId)});
    hub = createFsHub({fs, batchMs: 20});
    crdt = createCrdt({fs});
  });
  after(() => db?.close());

  it('sends a burst of changes as one typed batch, marked structural or content-only', async () => {
    const stream = await streamOf(hub, alice);
    await fs.write(alice, 'notes/a.txt', 'one');
    await fs.write(bob, 'notes/b.txt', 'two');
    await waitFor(() => stream.batches().length === 1);
    const [created] = stream.batches();
    assert.equal(created.structural, true);
    assert.deepEqual(created.changes.map(change => [change.op, change.kind, change.path]), [
      ['create', 'folder', 'notes'], ['create', 'file', 'notes/a.txt'], ['create', 'file', 'notes/b.txt'],
    ]);
    assert.equal(created.cursor, created.changes.at(-1).seq);

    const node = await fs.write(bob, 'notes/a.txt', 'one more');
    await waitFor(() => stream.batches().length === 2);
    const written = stream.batches()[1];
    assert.equal(written.structural, false);
    assert.deepEqual(written.changes, [{
      seq: node.rev, nodeId: node.id, op: 'write', kind: 'file', path: 'notes/a.txt', fromPath: null, rev: node.rev,
    }]);

    await fs.move(bob, 'notes/b.txt', 'notes/c.txt');
    await waitFor(() => stream.batches().length === 3);
    const [moved] = stream.batches()[2].changes;
    assert.deepEqual([moved.op, moved.fromPath, moved.path], ['move', 'notes/b.txt', 'notes/c.txt']);
    stream.stop();
  });

  it('tells each stream only what its member may see', async () => {
    const mine = await streamOf(hub, alice);
    const theirs = await streamOf(hub, bob);
    await fs.transaction(alice, async tree => {
      await tree.write('journal/today.md', 'dear diary');
      await tree.setAccess('journal', 'private');
    });
    await fs.write(alice, 'notes/shared.txt', 'hello');
    await waitFor(() => mine.batches().length && theirs.batches().length);
    await waitFor(() => mine.batches().flatMap(batch => batch.changes).some(change => change.path === 'notes/shared.txt'));
    await waitFor(() => theirs.batches().flatMap(batch => batch.changes).some(change => change.path === 'notes/shared.txt'));
    const paths = stream => stream.batches().flatMap(batch => batch.changes.map(change => change.path));
    assert.ok(paths(mine).includes('journal/today.md'));
    assert.ok(!paths(theirs).some(path => path.startsWith('journal')));
    mine.stop();
    theirs.stop();
  });

  it('stops scheduling a stream once it is stopped', async () => {
    const stream = await streamOf(hub, alice);
    stream.stop();
    await fs.write(alice, 'notes/quiet.txt', 'shh');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(stream.sent, []);
  });

  it('reads a change committed while the stream read where its feed starts', async () => {
    const late = {seq: 6, nodeId: 'n', op: 'write', kind: 'file', path: 'late.txt', fromPath: null};
    const racing = createFsHub({batchMs: 5, fs: {
      async head() {
        racing.changed('lab');
        return 5;
      },
      changes: async (_scope, {since}) => ({changes: since < 6 ? [late] : [], cursor: 6, more: false}),
    }});
    const stream = await streamOf(racing, alice);
    assert.equal(stream.cursor, 5);
    await waitFor(() => stream.batches().length === 1);
    assert.deepEqual(stream.batches()[0].changes.map(change => change.path), ['late.txt']);
    stream.stop();
  });

  it('sends live updates only to the streams following the file, and only its own member may follow', async () => {
    const node = await fs.write(alice, 'notes/live.md', 'Live.\n');
    const following = await streamOf(hub, alice);
    const other = await streamOf(hub, bob);
    assert.throws(() => hub.follow(alice, other.id, node.id), {code: 'no-stream'});
    hub.follow(alice, following.id, node.id);
    hub.follow(alice, following.id, node.id);
    assert.equal(hub.followed('lab', node.id), true);
    hub.broadcast('lab', node.id, new Uint8Array([1, 2, 3]), 7);
    hub.broadcast('lab', node.id, new Uint8Array([0, 0]), 8);
    hub.unfollow(alice, following.id, node.id);
    assert.equal(hub.followed('lab', node.id), true, 'one follow is still held');
    hub.unfollow(alice, following.id, node.id);
    hub.broadcast('lab', node.id, new Uint8Array([4, 5, 6]), 9);
    const updates = stream => stream.sent.filter(item => item.event === 'update').map(item => item.data);
    assert.deepEqual(updates(following), [{nodeId: node.id, update: Buffer.from([1, 2, 3]).toString('base64'), rev: 7}]);
    assert.deepEqual(updates(other), []);
    assert.equal(hub.followed('lab', node.id), false);
    following.stop();
    other.stop();
  });

  describe('GET /api/fs/events', () => {
    const fsRoutes = loadRoute('fs');
    let ctx;
    before(() => { ctx = makeCtx({workspaceFs: fs, crdt, fsHub: hub}); });

    /** Open the stream as `scope`; `events()` parses what it has sent. */
    function open(scope) {
      let res;
      const done = invoke(fsRoutes, {ctx, path: '/api/fs/events', requestContext: scope, onRequest: (_req, r) => { res = r; }});
      const events = () => (res?.writes ?? []).filter(chunk => chunk.startsWith('event: ')).map(chunk => {
        const [, event, data] = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
        return {event, data: JSON.parse(data)};
      });
      return {events, close: () => { res.emit('close'); return done; }};
    }

    it('starts with the stream id, then pushes the changes that follow', async () => {
      const stream = open(bob);
      await waitFor(() => stream.events().length === 1);
      const [ready] = stream.events();
      assert.equal(ready.event, 'ready');
      assert.equal(ready.data.cursor, await fs.head(bob));
      const put = await invoke(fsRoutes, {ctx, method: 'PUT', path: '/api/fs/file', query: {path: 'notes/pushed.txt'},
        body: 'pushed', requestContext: alice});
      await waitFor(() => stream.events().length === 2);
      const [, batch] = stream.events();
      assert.equal(batch.event, 'changes');
      assert.deepEqual(batch.data.changes.map(change => [change.path, change.rev]), [['notes/pushed.txt', put.payload.node.rev]]);
      await stream.close();
    });

    it('follows a live file read with the stream, and sends it the merged updates', async () => {
      await fs.write(alice, 'notes/plan.md', 'Plan.\n');
      const stream = open(bob);
      await waitFor(() => stream.events().length === 1);
      const id = stream.events()[0].data.stream;
      const read = await invoke(fsRoutes, {ctx, path: '/api/fs/crdt', query: {path: 'notes/plan.md', stream: id}, requestContext: bob});
      assert.equal(read.written.status, 200);
      const nodeId = read.res.headers['X-Node-Id'];
      assert.equal(hub.followed('lab', nodeId), true);

      const copy = new Y.Doc();
      Y.applyUpdate(copy, new Uint8Array(read.written.body));
      const before = Y.encodeStateVector(copy);
      copy.getText('markdown').insert(0, '# ');
      const edit = Buffer.from(Y.encodeStateAsUpdate(copy, before));
      const merged = await invoke(fsRoutes, {ctx: makeCtx({workspaceFs: fs, crdt, fsHub: hub, readRawBody: async () => edit}),
        method: 'POST', path: '/api/fs/crdt', query: {path: 'notes/plan.md'}, requestContext: alice});
      assert.equal(merged.status, 200);
      const update = stream.events().find(item => item.event === 'update');
      assert.equal(update.data.nodeId, nodeId);
      assert.equal(update.data.rev, merged.payload.node.rev);

      const stopped = await invoke(fsRoutes, {ctx, method: 'DELETE', path: '/api/fs/follow', query: {stream: id, node: nodeId},
        requestContext: bob});
      assert.equal(stopped.status, 200);
      assert.equal(hub.followed('lab', nodeId), false);
      const refused = await invoke(fsRoutes, {ctx, path: '/api/fs/crdt', query: {path: 'notes/plan.md', stream: id},
        requestContext: alice});
      assert.equal(refused.status, 404);
      assert.equal(refused.payload.code, 'no-stream');
      await waitFor(() => stream.events().some(item => item.event === 'changes'));
      await stream.close();
    });
  });
});
