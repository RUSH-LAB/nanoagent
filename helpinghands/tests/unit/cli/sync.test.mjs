import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncOnce} from '../../../cli/sync.mjs';

/** An in-memory workspace file system with the server's revision check. */
function fakeServer(initial = {}) {
  let seq = 0;
  let ids = 0;
  const files = new Map();
  const calls = [];
  const conflict = () => Object.assign(new Error('changed'), {status: 409});
  const write = (filePath, body) => {
    const current = files.get(filePath);
    files.set(filePath, {id: current?.id ?? `node-${++ids}`, path: filePath, body: Buffer.from(body), rev: ++seq});
    return {...files.get(filePath)};
  };
  for (const [filePath, body] of Object.entries(initial)) write(filePath, body);
  const api = {
    async list() { return [...files.values()].map(({id, path: filePath, rev}) => ({id, path: filePath, rev})); },
    async get(filePath) { return {...files.get(filePath)}; },
    async put(filePath, body, baseRev) {
      calls.push(['put', filePath, baseRev]);
      if ((files.get(filePath)?.rev ?? 0) !== baseRev) throw conflict();
      if (String(body).includes('REFUSE')) throw Object.assign(new Error('not allowed'), {status: 403});
      return write(filePath, body);
    },
    async remove(filePath, baseRev) {
      calls.push(['remove', filePath]);
      if (files.get(filePath).rev !== baseRev) throw conflict();
      files.delete(filePath);
    },
    async move(from, to, baseRev) {
      calls.push(['move', from, to]);
      const file = files.get(from);
      if (file.rev !== baseRev) throw conflict();
      files.delete(from);
      files.set(to, {...file, path: to, rev: ++seq});
      return {...files.get(to)};
    },
  };
  return {api, files, calls, write, text: filePath => files.get(filePath)?.body.toString()};
}

async function folder(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mochi-sync-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const state = {files: {}};
  const read = relative => fs.readFile(path.join(root, relative), 'utf8');
  const put = async (relative, text) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), {recursive: true});
    await fs.writeFile(path.join(root, relative), text);
  };
  const exists = relative => fs.access(path.join(root, relative)).then(() => true, () => false);
  return {root, state, read, put, exists};
}

async function syncUntilQuiet(local, server, rejected = new Map(), onlineOnly = []) {
  const options = {
    root: local.root, api: server.api, state: local.state, rejected, onlineOnly,
    saveState: async () => {}, host: 'laptop', day: '2026-10-07',
  };
  while (await syncOnce(options));
}

test('the first sync downloads every document into its folder', async t => {
  const local = await folder(t);
  const server = fakeServer({'index.md': '# Home', 'notes/week1.md': '---\ntitle: Week 1\n---\nHi'});
  await syncUntilQuiet(local, server);
  assert.equal(await local.read('index.md'), '# Home');
  assert.equal(await local.read('notes/week1.md'), '---\ntitle: Week 1\n---\nHi');
  assert.deepEqual(Object.keys(local.state.files).sort(), ['index.md', 'notes/week1.md']);
});

test('local edits, creations, and deletions reach the server', async t => {
  const local = await folder(t);
  const server = fakeServer({'a.md': 'one', 'b.md': 'two'});
  await syncUntilQuiet(local, server);
  const base = local.state.files['a.md'].rev;

  await local.put('a.md', 'one, edited');
  await local.put('drafts/c.mdx', 'three');
  await fs.rm(path.join(local.root, 'b.md'));
  await syncUntilQuiet(local, server);

  assert.equal(server.text('a.md'), 'one, edited');
  assert.deepEqual(server.calls.find(call => call[0] === 'put' && call[1] === 'a.md'), ['put', 'a.md', base]);
  assert.equal(server.text('drafts/c.mdx'), 'three');
  assert.equal(server.files.has('b.md'), false);
});

test('server edits and deletions reach the folder, removing emptied folders', async t => {
  const local = await folder(t);
  const server = fakeServer({'a.md': 'one', 'old/b.md': 'two'});
  await syncUntilQuiet(local, server);

  server.write('a.md', 'one, from the web');
  server.files.delete('old/b.md');
  await syncUntilQuiet(local, server);

  assert.equal(await local.read('a.md'), 'one, from the web');
  assert.equal(await local.exists('old'), false);
});

test('an edit on both sides keeps the server version and saves yours as a conflicted copy', async t => {
  const local = await folder(t);
  const server = fakeServer({'notes/a.md': 'base'});
  await syncUntilQuiet(local, server);

  server.write('notes/a.md', 'theirs');
  await local.put('notes/a.md', 'mine');
  await syncUntilQuiet(local, server);

  const copy = 'notes/a (conflicted copy laptop 2026-10-07).md';
  assert.equal(await local.read('notes/a.md'), 'theirs');
  assert.equal(await local.read(copy), 'mine');
  assert.equal(server.text(copy), 'mine');
  assert.equal(server.text('notes/a.md'), 'theirs');
});

test('a local delete loses to a server edit, and a server delete loses to a local edit', async t => {
  const local = await folder(t);
  const server = fakeServer({'kept-remotely.md': 'one', 'kept-locally.md': 'two'});
  await syncUntilQuiet(local, server);

  await fs.rm(path.join(local.root, 'kept-remotely.md'));
  server.write('kept-remotely.md', 'one, edited');
  await local.put('kept-locally.md', 'two, edited');
  server.files.delete('kept-locally.md');
  await syncUntilQuiet(local, server);

  assert.equal(await local.read('kept-remotely.md'), 'one, edited');
  assert.equal(server.text('kept-locally.md'), 'two, edited');
});

test('a local rename moves the document instead of recreating it', async t => {
  const local = await folder(t);
  const server = fakeServer({'a.md': 'body'});
  await syncUntilQuiet(local, server);
  const {id} = server.files.get('a.md');

  await local.put('archive/a.md', 'body');
  await fs.rm(path.join(local.root, 'a.md'));
  await syncUntilQuiet(local, server);

  assert.deepEqual(server.calls, [['move', 'a.md', 'archive/a.md']]);
  assert.equal(server.files.get('archive/a.md').id, id);
});

test('a refused upload is reported once and retried only after the file changes', async t => {
  const local = await folder(t);
  const server = fakeServer();
  const rejected = new Map();
  await local.put('bad.md', 'REFUSE');
  await syncUntilQuiet(local, server, rejected);
  await syncUntilQuiet(local, server, rejected);
  assert.equal(server.calls.filter(call => call[0] === 'put').length, 1);

  await local.put('bad.md', 'fixed');
  await syncUntilQuiet(local, server, rejected);
  assert.equal(server.text('bad.md'), 'fixed');
});

test('binary files sync, and dot paths stay on their own side', async t => {
  const local = await folder(t);
  const server = fakeServer({'.plugins/blobs/x.pdf': 'plugin data'});
  await fs.writeFile(path.join(local.root, 'photo.png'), Buffer.from([0, 255, 1, 254]));
  await local.put('.draft.md', 'hidden');
  await syncUntilQuiet(local, server);
  assert.deepEqual([...server.files.get('photo.png').body], [0, 255, 1, 254]);
  assert.equal(server.files.has('.draft.md'), false);
  assert.equal(await local.exists('.plugins'), false);
});

test('online-only folders stay in the workspace, after pending local edits are uploaded', async t => {
  const local = await folder(t);
  const server = fakeServer({'index.md': 'home', 'papers/a.pdf': 'A', 'papers/old/b.pdf': 'B'});
  await syncUntilQuiet(local, server, new Map(), ['papers/old']);
  assert.equal(await local.read('papers/a.pdf'), 'A');
  assert.equal(await local.exists('papers/old'), false);

  await local.put('papers/a.pdf', 'A2');
  await local.put('papers/new.pdf', 'N');
  await syncUntilQuiet(local, server, new Map(), ['papers']);
  assert.equal(server.text('papers/a.pdf'), 'A2');
  assert.equal(server.text('papers/new.pdf'), 'N');
  assert.equal(server.text('papers/old/b.pdf'), 'B');
  assert.equal(await local.exists('papers'), false);
  assert.deepEqual(Object.keys(local.state.files), ['index.md']);

  server.write('papers/a.pdf', 'A3');
  await syncUntilQuiet(local, server, new Map(), ['papers']);
  assert.equal(await local.exists('papers'), false);

  await syncUntilQuiet(local, server);
  assert.equal(await local.read('papers/a.pdf'), 'A3');
  assert.equal(await local.read('papers/old/b.pdf'), 'B');
});

test('moving a local file into an online-only folder moves it to the cloud', async t => {
  const local = await folder(t);
  const server = fakeServer({'draft.md': 'text'});
  await syncUntilQuiet(local, server);
  await fs.mkdir(path.join(local.root, 'archive'));
  await fs.rename(path.join(local.root, 'draft.md'), path.join(local.root, 'archive/draft.md'));
  await syncUntilQuiet(local, server, new Map(), ['archive']);
  assert.deepEqual([...server.files.keys()], ['archive/draft.md']);
  assert.deepEqual(server.calls.filter(call => call[0] !== 'put'), [['move', 'draft.md', 'archive/draft.md']]);
  assert.equal(await local.exists('archive'), false);
});
