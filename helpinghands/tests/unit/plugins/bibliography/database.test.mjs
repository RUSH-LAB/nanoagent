import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {
  CONTENT_DIR,
  PROJECT_ROOT,
  invoke,
  makeCtx,
  mockFs,
  newStore,
} from '../../_harness.mjs';

const require = createRequire(import.meta.url);
const routes = require('../../../../plugins/bibliography/server.js');
const manifest = require('../../../../plugins/bibliography/plugin.json');
const BIBLIOGRAPHY = {name: 'bibliography', requires: manifest.requires};
const BIB = path.join(CONTENT_DIR, 'bibliography', 'references.yaml');

function context(workspaceId, userId, role = 'editor') {
  return {workspaceId, workspaceSlug: workspaceId, membershipId: `${workspaceId}:${userId}`, userId, role};
}

describe('database-backed organization bibliography', () => {
  it('does not treat legacy YAML as a live bibliography source', async () => {
    const legacy = [
      'real2024:',
      '  title: A Real Paper',
      '__test_1780134850531_import:',
      '  title: Imported Test Paper',
      'wftest-1780241027128_ref:',
      '  title: Workflow Test Reference Paper',
      'author2025:',
      '  title: Test Paper __rem_1788057713997',
      '',
    ].join('\n');
    const ctx = makeCtx({fs: mockFs({[BIB]: legacy})});
    const r = await invoke(routes, {plugin: BIBLIOGRAPHY, path: '/api/references', ctx});
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.references, {});
  });

  it('keeps two organizations libraries separate in the same database', async () => {
    const {scoped} = newStore();
    const fs = mockFs({
      [path.join(PROJECT_ROOT, 'content', 'org-a', 'bibliography', 'references.yaml')]: '',
      [path.join(PROJECT_ROOT, 'content', 'org-b', 'bibliography', 'references.yaml')]: '',
    });
    const make = () => makeCtx({
      scoped,
      fs,
      contentRootFor: orgId => path.join(PROJECT_ROOT, 'content', orgId),
    });

    await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      method: 'POST',
      path: '/api/references',
      body: {key: 'private-to-a', entry: {title: 'Organization A Paper'}},
      requestContext: context('org-a', 'alice'),
      ctx: make(),
    });

    const a = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      path: '/api/references',
      requestContext: context('org-a', 'alice'),
      ctx: make(),
    });
    const b = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      path: '/api/references',
      requestContext: context('org-b', 'bob'),
      ctx: make(),
    });
    assert.ok(a.payload.references['private-to-a']);
    assert.equal(b.payload.references['private-to-a'], undefined);
  });

  it('stores and range-serves an organization PDF', async () => {
    const fs = mockFs({[BIB]: 'paper:\n  title: Paper\n'});
    const ctx = makeCtx({fs});
    ctx.scoped.collection('plugin:bibliography:papers').put(
      ctx.scopeFor({auth: {userId: 'test-user'}}), 'paper', {title: 'Paper'},
    );
    const pdf = '%PDF-example-payload';
    const uploaded = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      method: 'POST',
      path: '/api/references/paper/pdf',
      headers: {'content-type': 'application/pdf', 'x-file-name': 'paper.pdf'},
      body: pdf,
      ctx,
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.payload.file.mimeType, 'application/pdf');

    const served = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      path: '/api/references/paper/pdf',
      headers: {range: 'bytes=0-4'},
      ctx,
    });
    assert.equal(served.written.status, 206);
    assert.equal(served.written.body.toString(), '%PDF-');
    assert.equal(served.written.headers['Content-Range'], `bytes 0-4/${pdf.length}`);
  });

  it('shares annotations with members of the same organization only', async () => {
    const {scoped} = newStore();
    const fs = mockFs({
      [path.join(PROJECT_ROOT, 'content', 'org-a', 'bibliography', 'references.yaml')]: 'paper:\n  title: Paper\n',
      [path.join(PROJECT_ROOT, 'content', 'org-b', 'bibliography', 'references.yaml')]: '',
    });
    const make = () => makeCtx({scoped, fs, contentRootFor: orgId => path.join(PROJECT_ROOT, 'content', orgId)});
    scoped.collection('plugin:bibliography:papers').put(
      {workspaceId: 'org-a', userId: 'alice'}, 'paper', {title: 'Paper'},
    );
    const created = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      method: 'POST',
      path: '/api/references/paper/annotations',
      body: {page: 3, quote: 'Important result', body: 'Check this proof.'},
      requestContext: context('org-a', 'alice'),
      ctx: make(),
    });
    assert.equal(created.status, 201);
    assert.equal(created.payload.annotation.visibility, 'org');

    const teammate = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      path: '/api/references/paper/annotations',
      requestContext: context('org-a', 'bob', 'viewer'),
      ctx: make(),
    });
    assert.equal(teammate.payload.annotations.length, 1);
    assert.equal(teammate.payload.annotations[0].body, 'Check this proof.');

    const outsider = await invoke(routes, {
      plugin: BIBLIOGRAPHY,
      path: '/api/references/paper/annotations',
      requestContext: context('org-b', 'mallory', 'viewer'),
      ctx: make(),
    });
    assert.equal(outsider.status, 404);
  });
});
