import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {migratedDatabase, as} from './fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresMarket} = require('../../../src/server/postgres/market.js');
const {createPostgresWorkspacePlugins} = require('../../../src/server/postgres/workspace-plugins.js');
const {createWorkspaceApps} = require('../../../src/server/workspace-apps.js');

const BUILT_IN = {id: 'bibtex-check', name: 'BibTeX Check', version: '0.1.0', status: 'ready', sha256: 'b'.repeat(64), size: 3};
const UPLOAD = {id: 'notes', name: 'Notes', version: '1.0.0', status: 'ready', readme: '# Notes\n', sha256: 'c'.repeat(64), size: 5};
const REPOSITORY = {owner: 'alice', repo: 'notes', ref: 'HEAD', path: '', commit: 'd'.repeat(40)};

describe('a workspace\'s apps', () => {
  let db;
  let apps;
  let market;
  // NanoAgent's installs, by sha256, and every package it was sent.
  const installs = new Map();
  const sent = [];
  const ai = {
    packages: async () => ({value: {packages: [BUILT_IN]}}),
    packageFile: async id => (id === BUILT_IN.id ? {value: Buffer.from('nanoagent package')} : {error: 'package not found', status: 404}),
    install: async sha256 => (installs.has(sha256)
      ? {value: {plugin: installs.get(sha256)}}
      : {error: 'not installed', status: 404}),
    installPackage: async (sha256, data) => {
      sent.push([sha256, data.toString()]);
      const plugin = {...[BUILT_IN, UPLOAD].find(entry => entry.sha256 === sha256), uiVersion: '0123456789abcdef'};
      installs.set(sha256, plugin);
      return {value: {plugin}};
    },
  };

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    market = createPostgresMarket({pool: database.pool});
    apps = createWorkspaceApps({ai, market, plugins: createPostgresWorkspacePlugins({pool: database.pool})});
    await market.publish('alice', UPLOAD, Buffer.from('upload package'), REPOSITORY);
  });
  after(() => db?.close());

  it('offers NanoAgent\'s plugins and the uploads', async () => {
    const offered = (await apps.catalog('bob')).value;
    assert.deepEqual([...offered].map(([id, {source}]) => [id, source]), [['bibtex-check', 'nanoagent'], ['notes', 'upload']]);
  });

  it('starts with no apps, and lists what an owner adds, to every member', async () => {
    assert.deepEqual((await apps.list(as('vic'))).value, []);
    assert.equal((await apps.add(as('alice'), 'bibtex-check')).value.source, 'nanoagent');
    assert.equal((await apps.add(as('alice'), 'notes')).value.source, 'upload');
    // Adding it again changes nothing.
    await apps.add(as('alice'), 'notes');
    assert.deepEqual((await apps.list(as('vic'))).value.map(app => [app.id, app.source]), [['bibtex-check', 'nanoagent'], ['notes', 'upload']]);
    assert.deepEqual((await apps.list(as('carol', 'other'))).value, []);
  });

  it('adds only what the marketplace has, and only as an owner', async () => {
    assert.deepEqual(await apps.add(as('alice'), 'missing'), {error: 'No plugin named missing in the marketplace', status: 404});
    await assert.rejects(apps.add(as('bob'), 'bibtex-check'), /row-level security/);
  });

  it('opens an app installed, sending its package to NanoAgent once', async () => {
    const opened = await apps.open(as('bob'), 'notes');
    assert.equal(opened.value.sha256, UPLOAD.sha256);
    assert.equal(opened.value.uiVersion, '0123456789abcdef');
    await apps.open(as('vic'), 'notes');
    const builtIn = await apps.open(as('bob'), 'bibtex-check');
    assert.equal(builtIn.value.source, 'nanoagent');
    assert.deepEqual(sent, [[UPLOAD.sha256, 'upload package'], [BUILT_IN.sha256, 'nanoagent package']]);
    assert.deepEqual(await apps.open(as('carol', 'other'), 'notes'), {error: 'This workspace has no plugin named notes', status: 404});
  });

  it('runs an upload\'s latest version', async () => {
    const next = {...UPLOAD, version: '1.1.0', sha256: 'e'.repeat(64)};
    await market.publish('alice', next, Buffer.from('upload package 1.1'), REPOSITORY);
    installs.set(next.sha256, {...next, uiVersion: 'fedcba9876543210'});
    assert.equal((await apps.open(as('bob'), 'notes')).value.version, '1.1.0');
  });

  it('loses an upload its uploader removes, and an owner removes the rest', async () => {
    await market.remove('alice', 'notes');
    assert.deepEqual((await apps.list(as('bob'))).value.map(app => app.id), ['bibtex-check']);
    assert.equal(await apps.remove(as('bob'), 'bibtex-check'), false);
    assert.equal(await apps.remove(as('alice'), 'bibtex-check'), true);
    assert.deepEqual((await apps.list(as('alice'))).value, []);
  });
});
