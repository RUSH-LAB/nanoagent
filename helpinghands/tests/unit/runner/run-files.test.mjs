import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {runFiles} from '../../../src/runner/run-files.mjs';

/** NanoAgent's scratch workspaces, in memory: files by workspace, then path. */
function fakeNanoAgent() {
  const workspaces = new Map();
  const removed = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://nanoagent');
    const [, id, rest] = url.pathname.match(/^\/v1\/workspaces\/([^/]+)(\/.*)?$/) ?? [];
    const send = (status, value) => res.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(value));
    if (req.headers.authorization !== 'Bearer nano-secret') return send(401, {error: 'no token'});
    if (!workspaces.has(id)) workspaces.set(id, new Map());
    const files = workspaces.get(id);
    const file = rest?.startsWith('/files/') ? decodeURIComponent(rest.slice('/files/'.length)) : null;
    if (req.method === 'DELETE' && !rest) {
      workspaces.delete(id);
      removed.push(id);
      return send(200, {deleted: true});
    }
    if (req.method === 'GET' && rest === '/files') {
      if (id === 'run-broken') return send(500, {error: 'broken'});
      return send(200, {files: [...files.keys()].sort().map(name => ({path: name})), folders: [], truncated: false});
    }
    if (req.method === 'GET' && file) return res.writeHead(200).end(files.get(file));
    if (req.method === 'PUT' && file) {
      files.set(file, Buffer.concat(chunks));
      return send(200, {path: file});
    }
    return send(404, {error: 'not here'});
  });
  return {server, workspaces, removed};
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const read = file => fs.readFile(file, 'utf8').catch(() => null);

describe('a plugin run\'s files, on the member\'s computer (runner/run-files.mjs)', () => {
  let nano; let url; let root; let plugin; let synced; let files;

  before(async () => {
    nano = fakeNanoAgent();
    url = await listen(nano.server);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-files-'));
    // The folder of the workspace ws-1, as file sync made it (files.mjs).
    await fs.mkdir(path.join(root, 'comp-480-580', '.mochi'), {recursive: true});
    await fs.writeFile(path.join(root, 'comp-480-580', '.mochi', 'state.json'), JSON.stringify({workspace: 'ws-1', files: {}}));
    plugin = path.join(root, 'comp-480-580', 'plugins', 'arxiv-source', 'files');
    await fs.mkdir(path.join(plugin, 'papers'), {recursive: true});
    for (const [name, body] of [['papers/a.tex', 'a'], ['papers/b.tex', 'b'], ['papers/c.tex', 'c'], ['notes.md', 'n'], ['.hidden', 'h']]) {
      await fs.writeFile(path.join(plugin, name), body);
    }
    await fs.mkdir(path.join(root, 'comp-480-580', 'plugins', 'other', 'files'), {recursive: true});
    await fs.writeFile(path.join(root, 'comp-480-580', 'plugins', 'other', 'files', 'x.md'), 'x');
    synced = 0;
    files = runFiles({root, nanoagent: url, nanoagentToken: 'nano-secret', sync: async () => { synced += 1; }});
  });

  after(async () => {
    nano.server.closeAllConnections();
    await new Promise(resolve => nano.server.close(resolve));
    await fs.rm(root, {recursive: true, force: true});
  });

  it('fills the run\'s folder from the member\'s files for its plugin, once they are synced, and writes back what it did', async () => {
    const folder = await files.prepare({workspace: 'ws-1', plugin: 'arxiv-source'}, 'run-1');
    assert.equal(synced, 1);
    const scratch = nano.workspaces.get('run-1');
    assert.deepEqual([...scratch.keys()].sort(), ['notes.md', 'papers/a.tex', 'papers/b.tex', 'papers/c.tex']);

    // The run changes a.tex and b.tex, deletes c.tex and notes.md, and adds d.tex; meanwhile the
    // member edits b.tex and notes.md.
    scratch.set('papers/a.tex', Buffer.from('a by the run'));
    scratch.set('papers/b.tex', Buffer.from('b by the run'));
    scratch.delete('papers/c.tex');
    scratch.delete('notes.md');
    scratch.set('papers/d.tex', Buffer.from('d'));
    await fs.writeFile(path.join(plugin, 'papers/b.tex'), 'b by the member');
    await fs.writeFile(path.join(plugin, 'notes.md'), 'n by the member');

    await files.finish('arxiv-source', 'run-1', folder);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(await read(path.join(plugin, 'papers/a.tex')), 'a by the run');
    assert.equal(await read(path.join(plugin, 'papers/b.tex')), 'b by the member');
    assert.equal(await read(path.join(plugin, `papers/b (conflicted copy arxiv-source run ${day}).tex`)), 'b by the run');
    assert.equal(await read(path.join(plugin, 'papers/c.tex')), null);
    assert.equal(await read(path.join(plugin, 'notes.md')), 'n by the member');
    assert.equal(await read(path.join(plugin, 'papers/d.tex')), 'd');
    assert.equal(await read(path.join(plugin, '.hidden')), 'h');
    assert.deepEqual(nano.removed, ['run-1']);
    // File sync takes it to RUSH.
    assert.equal(synced, 2);
  });

  it('runs no plugin in a workspace whose files are not on this computer', async () => {
    await assert.rejects(files.prepare({workspace: 'ws-2', plugin: 'arxiv-source'}, 'run-2'), /no folder of this workspace's files on this computer/);
    assert.equal(nano.workspaces.has('run-2'), false);
  });

  it('removes the run\'s folder when writing back fails, and says why', async () => {
    const folder = await files.prepare({workspace: 'ws-1', plugin: 'arxiv-source'}, 'run-broken');
    await assert.rejects(files.finish('arxiv-source', 'run-broken', folder), /refused GET \/v1\/workspaces\/run-broken\/files \(500\): broken/);
    assert.ok(nano.removed.includes('run-broken'));
  });
});
