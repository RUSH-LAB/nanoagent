import crypto from 'node:crypto';
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
  // RUSH's own NanoAgent, which offers its packages and refuses one that still has a run.sh,
  // keeping how it checked each: how many times each package was sent to it.
  const inspections = new Map();
  const inspected = new Map();
  const ai = {
    packages: async () => ({value: {packages: [BUILT_IN]}}),
    inspection: async sha256 => inspections.get(sha256) ?? {error: 'not inspected', status: 404},
    inspect: async data => {
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      inspected.set(sha256, (inspected.get(sha256) ?? 0) + 1);
      inspections.set(sha256, data.toString().includes('run.sh')
        ? {error: 'the package is refused: unexpected run.sh', status: 422}
        : {value: {package: {sha256}}});
      return inspections.get(sha256);
    },
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
    viewPackage: async (sha256, data) => {
      sent.push([sha256, data.toString()]);
      return {value: {view: {sha256, uiVersion: 'fedcba9876543210'}}};
    },
  };

  let pool;
  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    pool = () => database.pool;
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

  it('preinstalls for a new account the uploads it names that the marketplace has', async () => {
    const plugins = createPostgresUserPlugins({pool: pool()});
    assert.deepEqual(await plugins.preinstall('carol', ['notes', 'gone']), ['notes']);
    assert.deepEqual((await apps.list(as('carol', 'other'))).value.map(app => app.id), ['notes']);
    assert.deepEqual(await plugins.preinstall('carol', ['notes']), []);
    assert.equal(await apps.remove(as('carol', 'other'), 'notes'), true);
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
    const [, notes] = (await apps.list(as('bob'))).value;
    assert.deepEqual([notes.version, notes.latest, notes.autoUpdate, notes.sha256, notes.state], ['1.1.0', '1.1.0', true, next.sha256, 'ready']);
  });

  it('keeps a member on the version they choose until they update it', async () => {
    const pinned = await apps.pin(as('bob'), 'notes', '1.0.0');
    assert.deepEqual([pinned.value.version, pinned.value.latest, pinned.value.autoUpdate, pinned.value.state], ['1.0.0', '1.1.0', false, 'update']);
    const opened = (await apps.open(as('bob'), 'notes', computer)).value;
    assert.deepEqual([opened.sha256, opened.latest, opened.autoUpdate, opened.repository, opened.latestRepository],
      [UPLOAD.sha256, '1.1.0', false, REPOSITORY, REPOSITORY]);
    // A version published later reaches whoever follows the latest, not bob.
    const later = {...UPLOAD, version: '1.2.0', sha256: 'f'.repeat(64)};
    await market.publish('alice', later, Buffer.from('upload package 1.2'), REPOSITORY);
    installs.set(later.sha256, {...later, uiVersion: 'fedcba9876543210'});
    assert.equal((await apps.open(as('bob'), 'notes', computer)).value.version, '1.0.0');
    assert.equal((await apps.open(as('vic'), 'notes', computer)).value.version, '1.2.0');
    assert.deepEqual((await apps.list(as('bob'))).value[1].latest, '1.2.0');
    // Updating stays on the version updated to; following the latest again takes it.
    assert.equal((await apps.pin(as('bob'), 'notes', '1.2.0')).value.autoUpdate, false);
    const following = (await apps.pin(as('bob'), 'notes', null)).value;
    assert.deepEqual([following.version, following.autoUpdate], ['1.2.0', true]);
    // Publishing keeps the latest and each version a member stays on, and removes the rest.
    await apps.pin(as('vic'), 'notes', '1.0.0');
    await market.publish('alice', {...UPLOAD, version: '1.3.0', sha256: '1'.repeat(64)}, Buffer.from('upload package 1.3'), REPOSITORY);
    assert.deepEqual(await Promise.all(['1.0.0', '1.1.0', '1.2.0', '1.3.0'].map(async version => Boolean(await market.get('alice', 'notes', version)))),
      [true, false, true, true]);
    await apps.pin(as('vic'), 'notes', null);
    assert.deepEqual(await apps.pin(as('bob'), 'notes', '9.9.9'), {error: 'notes has no version 9.9.9', status: 404});
    assert.deepEqual(await apps.pin(as('bob'), 'bibtex-check', '0.1.0'), {error: 'You have not installed an upload named bibtex-check', status: 404});
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

  it('lists a version NanoAgent now refuses as refused, for no one to install or run, and checks each once', async () => {
    // A package is known by its sha256, as NanoAgent keeps how it checked each.
    const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
    const legacy = {...UPLOAD, id: 'legacy', name: 'Legacy', sha256: sha256('legacy package')};
    await market.publish('alice', legacy, Buffer.from('legacy package'), REPOSITORY);
    await apps.add(as('bob'), 'legacy');
    await apps.add(as('vic'), 'legacy');
    await apps.pin(as('vic'), 'legacy', '1.0.0');
    const stale = {...legacy, version: '1.1.0', sha256: sha256('legacy package with run.sh')};
    await market.publish('alice', stale, Buffer.from('legacy package with run.sh'), REPOSITORY);
    const offered = (await apps.catalog('carol')).value.get('legacy').entry;
    assert.deepEqual([offered.status, offered.refusal], ['refused', 'the package is refused: unexpected run.sh']);
    assert.deepEqual(await apps.add(as('carol'), 'legacy'), {error: 'legacy is outdated: no version of it runs here until its author publishes one that does (the package is refused: unexpected run.sh)', status: 409});
    // Who follows the latest runs the refused version, outdated; who stays on the earlier one
    // does not, and has no update to it.
    assert.deepEqual((await apps.list(as('bob'))).value.map(app => [app.version, app.status, app.state]), [['1.1.0', 'refused', 'outdated']]);
    assert.deepEqual((await apps.list(as('vic'))).value.map(app => [app.version, app.status, app.state]), [['1.0.0', 'ready', 'ready']]);
    assert.deepEqual(await apps.prepare(as('bob'), computer), {value: []});
    assert.deepEqual([inspected.get(legacy.sha256), inspected.get(stale.sha256)], [1, 1]);
    // Opened, the refused version is its page alone, to read its sessions; it takes no run.
    sent.length = 0;
    const opened = (await apps.open(as('bob'), 'legacy', computer)).value;
    assert.deepEqual(
      [opened.version, opened.sha256, opened.uiVersion, opened.status, opened.refusal, opened.name],
      ['1.1.0', stale.sha256, 'fedcba9876543210', 'refused', 'the package is refused: unexpected run.sh', 'Legacy'],
    );
    assert.deepEqual(sent, [[stale.sha256, 'legacy package with run.sh']]);
    assert.deepEqual(await apps.refusal(as('bob'), 'legacy'), {value: 'the package is refused: unexpected run.sh'});
    assert.deepEqual(await apps.refusal(as('vic'), 'legacy'), {value: null});
    assert.deepEqual(await apps.refusal(as('vic'), 'bibtex-check'), {error: 'You have not installed a plugin named bibtex-check', status: 404});
    // Once its author publishes a version that runs, staying on the refused one needs an update to it.
    await apps.pin(as('bob'), 'legacy', '1.1.0');
    await market.publish('alice', {...legacy, version: '1.2.0', sha256: sha256('legacy package 1.2')}, Buffer.from('legacy package 1.2'), REPOSITORY);
    assert.deepEqual((await apps.list(as('bob'))).value.map(app => [app.version, app.latest, app.state]), [['1.1.0', '1.2.0', 'needs-update']]);
    assert.deepEqual((await apps.list(as('vic'))).value.map(app => [app.version, app.latest, app.state]), [['1.0.0', '1.2.0', 'update']]);
  });
});
