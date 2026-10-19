import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {syncFiles} from '../../../src/runner/files.mjs';

/** Mochi's /api/workspaces and /fs, in memory, for one member: files by workspace id, then path. */
function fakeMochi() {
  const workspaces = [{id: 'ws-1', slug: 'comp-480-580', name: 'COMP 480/580'}];
  const files = new Map([['ws-1', new Map()]]);
  let seq = 0;
  const write = (id, filePath, body) => {
    const node = {id: files.get(id).get(filePath)?.id ?? `node-${seq + 1}`, path: filePath, kind: 'file', rev: ++seq, body: Buffer.from(body)};
    files.get(id).set(filePath, node);
    return node;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mochi');
    const send = (status, value) => res.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(value));
    if (url.pathname === '/api/workspaces') return send(200, {workspaces});
    const [, id, action] = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/fs\/(\w+)$/) ?? [];
    const tree = files.get(id);
    const at = url.searchParams.get('path');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (action === 'tree') {
      const prefix = url.searchParams.get('prefix');
      return send(200, {nodes: [...tree.values()].filter(node => node.path.startsWith(`${prefix}/`)).map(({body, ...node}) => node)});
    }
    if (action === 'file' && req.method === 'GET') {
      const node = tree.get(at);
      return res.writeHead(200, {'x-node-id': node.id, 'x-rev': String(node.rev)}).end(node.body);
    }
    if (action === 'file' && req.method === 'PUT') {
      if ((tree.get(at)?.rev ?? 0) !== Number(url.searchParams.get('baseRev'))) return send(409, {error: 'changed'});
      const {body, ...node} = write(id, at, Buffer.concat(chunks));
      return send(200, {node});
    }
    return send(404, {error: 'not here'});
  });
  return {server, workspaces, files, write};
}

const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) {
    if (await check()) return;
  }
  assert.fail('timed out');
};
const read = file => fs.readFile(file, 'utf8').catch(() => null);

describe('RUSH Lab\'s folder of the member\'s own files', () => {
  let mochi;
  let site;
  let root;

  before(async () => {
    mochi = fakeMochi();
    await new Promise(resolve => mochi.server.listen(0, '127.0.0.1', resolve));
    site = `http://127.0.0.1:${mochi.server.address().port}`;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rushlab-'));
  });
  after(async () => {
    mochi.server.close();
    await fs.rm(root, {recursive: true, force: true});
  });

  it('keeps <root>/<slug>/ in sync both ways with the member\'s home, and nothing else', async () => {
    mochi.write('ws-1', 'home/alice/Plugins/echo/out.md', 'from a run');
    mochi.write('ws-1', 'home/bob/secret.md', 'not hers');
    mochi.write('ws-1', 'books/shared.md', 'shared');
    const files = syncFiles({site, token: 't', userId: 'alice', root, log: () => {}});
    try {
      const folder = path.join(root, 'comp-480-580');
      await until(async () => await read(path.join(folder, 'Plugins/echo/out.md')) === 'from a run');
      assert.deepEqual((await fs.readdir(folder)).sort(), ['.mochi', 'Plugins']);
      await fs.writeFile(path.join(folder, 'notes.md'), 'mine');
      await files.sync();
      await until(() => mochi.files.get('ws-1').get('home/alice/notes.md')?.body.toString() === 'mine');
    } finally {
      files.stop();
    }
  });

  it('renames a workspace\'s folder when its slug changes, keeping what it synced', async () => {
    mochi.workspaces[0].slug = 'comp-480';
    const files = syncFiles({site, token: 't', userId: 'alice', root, log: () => {}});
    try {
      await until(async () => await read(path.join(root, 'comp-480', 'notes.md')) === 'mine');
      assert.deepEqual(await fs.readdir(root), ['comp-480']);
      const state = JSON.parse(await fs.readFile(path.join(root, 'comp-480', '.mochi', 'state.json'), 'utf8'));
      assert.equal(state.workspace, 'ws-1');
      assert.deepEqual(Object.keys(state.files).sort(), ['Plugins/echo/out.md', 'notes.md']);
    } finally {
      files.stop();
    }
  });
});
