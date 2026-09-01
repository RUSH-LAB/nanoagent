import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';

const routes = loadRoute('assets');
const owner = Object.freeze({userId: 'ada', workspaceId: 'lab', membershipId: 'm1', role: 'owner'});
const editor = Object.freeze({...owner, role: 'editor'});
const viewer = Object.freeze({...owner, role: 'viewer'});

function storage() {
  const values = new Map();
  return {
    values,
    async put(key, body) { values.set(key, Buffer.from(body)); },
    async get(key) { return values.get(key) ?? null; },
    async remove(key) { return values.delete(key); },
  };
}

describe('workspace assets', () => {
  it('uploads, lists, and serves an asset from the verified workspace', async () => {
    const objectStorage = storage();
    const ctx = makeCtx({objectStorage});
    const uploaded = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/assets', query: {path: 'books/assets/plot.png'},
      body: 'png bytes', ctx, requestContext: editor,
    });
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.payload.asset.path, 'books/assets/plot.png');

    const listed = await invoke(routes, {
      path: '/api/workspaces/lab/assets', ctx, requestContext: viewer,
    });
    assert.deepEqual(listed.payload.assets.map(asset => asset.path), ['books/assets/plot.png']);

    const served = await invoke(routes, {
      path: '/api/workspaces/lab/assets', query: {path: 'books/assets/plot.png'},
      ctx, requestContext: viewer,
    });
    assert.equal(served.written.status, 200);
    assert.equal(served.written.headers['Content-Type'], 'image/png');
    assert.equal(served.written.body.toString(), 'png bytes');

    const servedById = await invoke(routes, {
      path: '/api/workspaces/lab/assets', query: {id: uploaded.payload.asset.id},
      ctx, requestContext: viewer,
    });
    assert.equal(servedById.written.status, 200);
    assert.equal(servedById.written.body.toString(), 'png bytes');
  });

  it('does not expose the same logical path in another workspace', async () => {
    const objectStorage = storage();
    const ctx = makeCtx({objectStorage});
    await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/assets', query: {path: 'plot.png'},
      body: 'secret', ctx, requestContext: editor,
    });
    const other = await invoke(routes, {
      path: '/api/workspaces/other/assets', query: {path: 'plot.png'}, ctx,
      requestContext: {...viewer, workspaceId: 'other'},
    });
    assert.equal(other.status, 404);

    const id = ctx.assets.list(editor)[0].id;
    const otherById = await invoke(routes, {
      path: '/api/workspaces/other/assets', query: {id}, ctx,
      requestContext: {...viewer, workspaceId: 'other'},
    });
    assert.equal(otherById.status, 404);
  });

  it('refuses uploads from viewers and unsafe asset types', async () => {
    const ctx = makeCtx({objectStorage: storage()});
    const denied = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/assets', query: {path: 'plot.png'},
      body: 'x', ctx, requestContext: viewer,
    });
    assert.equal(denied.status, 403);
    const unsafe = await invoke(routes, {
      method: 'PUT', path: '/api/workspaces/lab/assets', query: {path: '../script.svg'},
      body: 'x', ctx, requestContext: owner,
    });
    assert.equal(unsafe.status, 400);
  });
});
