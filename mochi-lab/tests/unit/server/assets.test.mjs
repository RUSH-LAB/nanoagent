import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {migratedDatabase} from '../_harness.mjs';

const require = createRequire(import.meta.url);
const {createAssets} = require('../../../src/server/assets.js');

describe('workspace asset metadata', () => {
  it('binds reads and deletes to the verified workspace context', () => {
    const db = migratedDatabase();
    const assets = createAssets({db, newId: () => 'asset-1', now: () => '2026-08-31T12:00:00.000Z'});
    const alpha = {workspaceId: 'workspace-a', userId: 'user-1'};
    const beta = {workspaceId: 'workspace-b', userId: 'user-2'};

    const created = assets.create(alpha, {
      path: 'papers/file.pdf',
      objectKey: 'workspace-a/assets/asset-1/file.pdf',
      contentType: 'application/pdf',
      byteSize: 12,
      sha256: 'abc123',
    });

    assert.equal(created.id, 'asset-1');
    assert.equal(assets.get(alpha, 'asset-1').objectKey, created.objectKey);
    assert.equal(assets.getByPath(alpha, 'papers/file.pdf').id, 'asset-1');
    assert.deepEqual(assets.list(alpha).map(asset => asset.path), ['papers/file.pdf']);
    assert.equal(assets.get(beta, 'asset-1'), null);
    assert.equal(assets.remove(beta, 'asset-1'), false);
    assert.equal(assets.remove(alpha, 'asset-1'), true);
    assert.equal(assets.get(alpha, 'asset-1'), null);
  });

  it('replaces metadata at one logical path without exposing another workspace', () => {
    const db = migratedDatabase();
    let id = 0;
    const assets = createAssets({db, newId: () => `asset-${++id}`});
    const alpha = {workspaceId: 'workspace-a', userId: 'user-1'};
    const beta = {workspaceId: 'workspace-b', userId: 'user-2'};
    assets.put(alpha, {path: 'images/plot.png', objectKey: 'old', contentType: 'image/png', byteSize: 1, sha256: 'a'});
    const replaced = assets.put(alpha, {path: 'images/plot.png', objectKey: 'new', contentType: 'image/png', byteSize: 2, sha256: 'b'});
    assert.equal(replaced.objectKey, 'new');
    assert.equal(assets.list(alpha).length, 1);
    assert.equal(assets.getByPath(beta, 'images/plot.png'), null);
  });

  it('refuses unverified contexts', () => {
    const assets = createAssets({db: migratedDatabase()});
    assert.throws(() => assets.get({workspaceId: 'workspace-a'}, 'asset-1'), /verified workspace context/);
    assert.throws(() => assets.create({userId: 'user-1'}, {}), /verified workspace context/);
  });
});
