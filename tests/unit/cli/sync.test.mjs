import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncOnce} from '../../../cli/sync.mjs';

/** An in-memory document API with the server's revision check. */
function fakeServer(initial = {}) {
  let clock = 0;
  let ids = 0;
  const documents = new Map();
  const calls = [];
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString();
  const conflict = () => Object.assign(new Error('changed'), {status: 409});
  const write = (documentPath, markdown) => {
    const current = documents.get(documentPath);
    documents.set(documentPath, {id: current?.id ?? `doc-${++ids}`, path: documentPath, markdown, updatedAt: stamp()});
    return {...documents.get(documentPath)};
  };
  for (const [documentPath, markdown] of Object.entries(initial)) write(documentPath, markdown);
  const api = {
    async list() { return [...documents.values()].map(({markdown, ...rest}) => rest); },
    async get(documentPath) { return {...documents.get(documentPath)}; },
    async create(documentPath, markdown) {
      calls.push(['create', documentPath]);
      if (documents.has(documentPath)) throw conflict();
      if (markdown.includes('<Broken')) throw Object.assign(new Error('invalid MDX'), {status: 422});
      return write(documentPath, markdown);
    },
    async save(documentPath, markdown, baseUpdatedAt) {
      calls.push(['save', documentPath, baseUpdatedAt]);
      if (documents.get(documentPath).updatedAt !== baseUpdatedAt) throw conflict();
      return write(documentPath, markdown);
    },
    async remove(documentPath, baseUpdatedAt) {
      calls.push(['remove', documentPath]);
      if (documents.get(documentPath).updatedAt !== baseUpdatedAt) throw conflict();
      documents.delete(documentPath);
    },
    async move(from, to) {
      calls.push(['move', from, to]);
      const document = documents.get(from);
      documents.delete(from);
      documents.set(to, {...document, path: to, updatedAt: stamp()});
      return {...documents.get(to)};
    },
  };
  return {api, documents, calls, write};
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

async function syncUntilQuiet(local, server, rejected = new Map()) {
  const options = {
    root: local.root, api: server.api, state: local.state, rejected,
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
  const base = local.state.files['a.md'].updatedAt;

  await local.put('a.md', 'one, edited');
  await local.put('drafts/c.mdx', 'three');
  await fs.rm(path.join(local.root, 'b.md'));
  await syncUntilQuiet(local, server);

  assert.equal(server.documents.get('a.md').markdown, 'one, edited');
  assert.deepEqual(server.calls.find(call => call[0] === 'save'), ['save', 'a.md', base]);
  assert.equal(server.documents.get('drafts/c.mdx').markdown, 'three');
  assert.equal(server.documents.has('b.md'), false);
});

test('server edits and deletions reach the folder, removing emptied folders', async t => {
  const local = await folder(t);
  const server = fakeServer({'a.md': 'one', 'old/b.md': 'two'});
  await syncUntilQuiet(local, server);

  server.write('a.md', 'one, from the web');
  server.documents.delete('old/b.md');
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
  assert.equal(server.documents.get(copy).markdown, 'mine');
  assert.equal(server.documents.get('notes/a.md').markdown, 'theirs');
});

test('a local delete loses to a server edit, and a server delete loses to a local edit', async t => {
  const local = await folder(t);
  const server = fakeServer({'kept-remotely.md': 'one', 'kept-locally.md': 'two'});
  await syncUntilQuiet(local, server);

  await fs.rm(path.join(local.root, 'kept-remotely.md'));
  server.write('kept-remotely.md', 'one, edited');
  await local.put('kept-locally.md', 'two, edited');
  server.documents.delete('kept-locally.md');
  await syncUntilQuiet(local, server);

  assert.equal(await local.read('kept-remotely.md'), 'one, edited');
  assert.equal(server.documents.get('kept-locally.md').markdown, 'two, edited');
});

test('a local rename moves the document instead of recreating it', async t => {
  const local = await folder(t);
  const server = fakeServer({'a.md': 'body'});
  await syncUntilQuiet(local, server);
  const {id} = server.documents.get('a.md');

  await local.put('archive/a.md', 'body');
  await fs.rm(path.join(local.root, 'a.md'));
  await syncUntilQuiet(local, server);

  assert.deepEqual(server.calls.filter(call => call[0] !== 'save'), [['move', 'a.md', 'archive/a.md']]);
  assert.equal(server.documents.get('archive/a.md').id, id);
});

test('a refused upload is reported once and retried only after the file changes', async t => {
  const local = await folder(t);
  const server = fakeServer();
  const rejected = new Map();
  await local.put('bad.mdx', '<Broken');
  await syncUntilQuiet(local, server, rejected);
  await syncUntilQuiet(local, server, rejected);
  assert.equal(server.calls.filter(call => call[0] === 'create').length, 1);

  await local.put('bad.mdx', 'fixed');
  await syncUntilQuiet(local, server, rejected);
  assert.equal(server.documents.get('bad.mdx').markdown, 'fixed');
});

test('files other than Markdown and dotfiles stay local', async t => {
  const local = await folder(t);
  const server = fakeServer();
  await local.put('photo.png', 'bytes');
  await local.put('.draft.md', 'hidden');
  await syncUntilQuiet(local, server);
  assert.equal(server.documents.size, 0);
});
