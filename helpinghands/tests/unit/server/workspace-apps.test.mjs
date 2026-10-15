import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {migratedDatabase, as} from './fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresMarket} = require('../../../src/server/postgres/market.js');
const {createPostgresUserPlugins} = require('../../../src/server/postgres/user-plugins.js');
const {createWorkspaceApps} = require('../../../src/server/workspace-apps.js');

const BUILT_IN = {id: 'bibtex-check', name: 'BibTeX Check', version: '0.1.0', status: 'ready', sha256: 'b'.repeat(64), size: 3};
const UPLOAD = {id: 'notes', name: 'Notes', version: '1.0.0', status: 'ready', readme: '# Notes\n', sha256: 'c'.repeat(64), size: 5};
const REPOSITORY = {owner: 'alice', repo: 'notes', ref: 'HEAD', path: '', commit: 'd'.repeat(40)};

describe('a member\'s apps', () => {
  let db;
  let apps;
  let market;
  // Mochi's own NanoAgent, which offers its packages.
  const ai = {
    packages: async () => ({value: {packages: [BUILT_IN]}}),
    packageFile: async id => (id === BUILT_IN.id ? {value: Buffer.from('nanoagent package')} : {error: 'package not found', status: 404}),
  };
  // The member's computer's NanoAgent: its installs, by sha256, and every package it was sent.
  const installs = new Map();
  const sent = [];
  const computer = {
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
    apps = createWorkspaceApps({ai, market, plugins: createPostgresUserPlugins({pool: database.pool})});
    await market.publish('alice', UPLOAD, Buffer.from('upload package'), REPOSITORY);
  });
  after(() => db?.close());

  it('offers NanoAgent\'s plugins and the uploads', async () => {
    const offered = (await apps.catalog('bob')).value;
    assert.deepEqual([...offered].map(([id, {source}]) => [id, source]), [['bibtex-check', 'nanoagent'], ['notes', 'upload']]);
  });

  it('starts with no apps, and lists what each member installs, to them alone, in every workspace', async () => {
    assert.deepEqual((await apps.list(as('bob'))).value, []);
    assert.equal((await apps.add(as('bob'), 'bibtex-check')).value.source, 'nanoagent');
    assert.equal((await apps.add(as('bob'), 'notes')).value.source, 'upload');
    // Installing it again changes nothing.
    await apps.add(as('bob'), 'notes');
    assert.deepEqual((await apps.list(as('bob'))).value.map(app => [app.id, app.source]), [['bibtex-check', 'nanoagent'], ['notes', 'upload']]);
    assert.deepEqual((await apps.list(as('bob', 'other'))).value.map(app => app.id), ['bibtex-check', 'notes']);
    assert.deepEqual((await apps.list(as('vic'))).value, []);
    assert.equal((await apps.add(as('vic'), 'notes')).value.source, 'upload');
  });

  it('installs only what the marketplace has', async () => {
    assert.deepEqual(await apps.add(as('alice'), 'missing'), {error: 'No plugin named missing in the marketplace', status: 404});
  });

  it('opens an app installed, sending its package to NanoAgent once', async () => {
    const opened = await apps.open(as('bob'), 'notes', computer);
    assert.equal(opened.value.sha256, UPLOAD.sha256);
    assert.equal(opened.value.uiVersion, '0123456789abcdef');
    await apps.open(as('vic'), 'notes', computer);
    const builtIn = await apps.open(as('bob'), 'bibtex-check', computer);
    assert.equal(builtIn.value.source, 'nanoagent');
    assert.deepEqual(sent, [[UPLOAD.sha256, 'upload package'], [BUILT_IN.sha256, 'nanoagent package']]);
    assert.deepEqual(await apps.open(as('vic'), 'bibtex-check', computer), {error: 'You have not installed a plugin named bibtex-check', status: 404});
  });

  it('prepares every app of the member\'s on a NanoAgent, ahead of its first open', async () => {
    const prepared = new Map();
    const on = {
      install: async sha256 => (prepared.has(sha256) ? {value: {plugin: prepared.get(sha256)}} : {error: 'not installed', status: 404}),
      installPackage: async sha256 => {
        prepared.set(sha256, {sha256});
        return {value: {plugin: {sha256}}};
      },
    };
    assert.deepEqual(await apps.prepare(as('bob'), on), {value: [{id: 'bibtex-check'}, {id: 'notes'}]});
    assert.deepEqual([...prepared.keys()], [BUILT_IN.sha256, UPLOAD.sha256]);
    assert.equal((await apps.open(as('bob'), 'notes', on)).value.sha256, UPLOAD.sha256);
    assert.deepEqual(await apps.prepare(as('carol'), on), {value: []});
  });

  it('runs an upload\'s latest version', async () => {
    const next = {...UPLOAD, version: '1.1.0', sha256: 'e'.repeat(64)};
    await market.publish('alice', next, Buffer.from('upload package 1.1'), REPOSITORY);
    installs.set(next.sha256, {...next, uiVersion: 'fedcba9876543210'});
    assert.equal((await apps.open(as('bob'), 'notes', computer)).value.version, '1.1.0');
  });

  it('lists the tags a member gives a plugin, to them alone', async () => {
    assert.deepEqual((await apps.list(as('bob'))).value.map(app => app.tags), [[], []]);
    assert.equal(await apps.tag(as('bob'), 'notes', ['Writing', 'Daily']), true);
    assert.deepEqual((await apps.list(as('bob'))).value.map(app => [app.id, app.tags]), [['bibtex-check', []], ['notes', ['Writing', 'Daily']]]);
    assert.equal(await apps.tag(as('bob'), 'missing', ['x']), false);
    assert.equal(await apps.tag(as('vic'), 'notes', ['Mine']), true);
    assert.deepEqual((await apps.list(as('bob'))).value[1].tags, ['Writing', 'Daily']);
  });

  it('loses an upload its uploader removes, and a member uninstalls the rest', async () => {
    await market.remove('alice', 'notes');
    assert.deepEqual((await apps.list(as('bob'))).value.map(app => app.id), ['bibtex-check']);
    assert.deepEqual((await apps.list(as('vic'))).value, []);
    assert.equal(await apps.remove(as('vic'), 'bibtex-check'), false);
    assert.equal(await apps.remove(as('bob'), 'bibtex-check'), true);
    assert.deepEqual((await apps.list(as('bob'))).value, []);
  });
});
