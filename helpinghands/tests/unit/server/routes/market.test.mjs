import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadRoute, makeCtx, invoke} from '../../_harness.mjs';
import {migratedDatabase} from '../fs/_pglite.mjs';

const {createPostgresMarket, USER_MAX_BYTES} = createRequire(import.meta.url)('../../../../src/server/postgres/market.js');

const routes = loadRoute('market');
const BUILT_IN = {id: 'bibtex-check', name: 'BibTeX Check', version: '0.1.0', sha256: 'b', size: 3};
const entryFor = (id, version = '1.0.0', size = 7) => ({id, name: id, version, readme: `# ${id}\n`, sha256: `sha-${id}-${version}`, size});

describe('the plugin marketplace', () => {
  let db;
  let ctx;
  // GitHub's archive of a repository is its URL, and NanoAgent's package of it
  // names the id, version and size there: `notes@1.0.0`.
  const REPOSITORY = {owner: 'alice', repo: 'plugins', ref: 'HEAD', path: 'notes', commit: 'c'.repeat(40)};
  const github = {
    source: async url => (url === 'not github'
      ? {error: 'Give a GitHub repository URL', status: 400}
      : {value: {repository: REPOSITORY, archive: Buffer.from(url)}}),
  };
  const ai = {
    packages: async () => ({value: {packages: [BUILT_IN]}}),
    packageFile: async id => (id === BUILT_IN.id
      ? {value: Buffer.from('nanoagent package'), headers: new Headers({'content-disposition': 'attachment; filename="bibtex-check-0.1.0.tar.gz"'})}
      : {error: 'package not found', status: 404}),
    packageSource: async (archive, path) => {
      assert.equal(path, REPOSITORY.path);
      const [id, version, size] = archive.toString().split('@');
      if (id === 'broken') return {error: 'the plugin is refused: missing LICENSE', status: 422};
      return {value: {package: entryFor(id, version, size ? Number(size) : 7), data: archive.toString('base64')}};
    },
  };
  // Everyone here signed in with GitHub, as the same login, but carol-no-github.
  const as = userId => ({userId, orgId: null, account: {id: userId, githubLogin: userId === 'carol-no-github' ? null : userId}});
  const call = (userId, method, path, url) => invoke(routes, {
    ctx, method, path, auth: userId ? as(userId) : null, ...(url === undefined ? {} : {body: {url}}),
  });

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    await db.exec("update app_user set github_login = id");
    ctx = makeCtx({ai, github, market: createPostgresMarket({pool: database.pool})});
  });
  after(() => db?.close());

  it('lists NanoAgent\'s own plugins, for the signed-in only', async () => {
    const listed = await call('alice', 'GET', '/api/market');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.payload.plugins, [{...BUILT_IN, source: 'nanoagent', owner: null, mine: false}]);
    assert.equal((await call(null, 'GET', '/api/market')).status, 401);
  });

  it('publishes a GitHub plugin NanoAgent accepts, for everyone to download', async () => {
    const published = await call('alice', 'POST', '/api/market', 'notes@1.0.0');
    assert.equal(published.status, 201);
    assert.deepEqual(published.payload.plugin.owner, {id: 'alice', name: 'Alice', github: 'alice'});
    assert.deepEqual(published.payload.plugin.repository, REPOSITORY);
    const listed = await call('bob', 'GET', '/api/market');
    assert.deepEqual(listed.payload.plugins.map(plugin => [plugin.id, plugin.source, plugin.mine]), [['bibtex-check', 'nanoagent', false], ['notes', 'upload', false]]);
    const {written} = await call('bob', 'GET', '/api/market/notes/package');
    assert.equal(written.status, 200);
    assert.equal(written.headers['Content-Disposition'], 'attachment; filename="notes-1.0.0.tar.gz"');
    assert.equal(written.body.toString(), 'notes@1.0.0');
  });

  it('publishes only for an account signed in with GitHub, its author', async () => {
    const refused = await call('carol-no-github', 'POST', '/api/market', 'nameless@1.0.0');
    assert.equal(refused.status, 403);
    assert.match(refused.payload.error, /Sign in with GitHub/);
  });

  it('downloads NanoAgent\'s own plugins from NanoAgent', async () => {
    const {written} = await call('bob', 'GET', '/api/market/bibtex-check/package');
    assert.equal(written.headers['Content-Disposition'], 'attachment; filename="bibtex-check-0.1.0.tar.gz"');
    assert.equal(written.body.toString(), 'nanoagent package');
    assert.equal((await call('bob', 'GET', '/api/market/missing/package')).status, 404);
  });

  it('relays why GitHub has no such plugin', async () => {
    const refused = await call('alice', 'POST', '/api/market', 'not github');
    assert.equal(refused.status, 400);
    assert.match(refused.payload.error, /GitHub repository URL/);
    assert.equal((await invoke(routes, {ctx, method: 'POST', path: '/api/market', auth: as('alice'), body: 'nonsense'})).status, 400);
  });

  it('relays why NanoAgent refuses a plugin, and stores nothing', async () => {
    const refused = await call('alice', 'POST', '/api/market', 'broken@1.0.0');
    assert.equal(refused.status, 422);
    assert.match(refused.payload.error, /missing LICENSE/);
    assert.equal((await call('alice', 'GET', '/api/market/broken/package')).status, 404);
  });

  it('keeps every version published, and refuses one published already', async () => {
    const updated = await call('alice', 'POST', '/api/market', 'notes@1.1.0');
    assert.equal(updated.payload.plugin.version, '1.1.0');
    const again = await call('alice', 'POST', '/api/market', 'notes@1.1.0');
    assert.equal(again.status, 409);
    assert.match(again.payload.error, /notes 1\.1\.0 is published already/);
    assert.equal((await call('bob', 'GET', '/api/market/notes/package')).written.body.toString(), 'notes@1.1.0');
    assert.equal((await ctx.market.get('bob', 'notes', '1.0.0')).package.toString(), 'notes@1.0.0');
    assert.equal(await ctx.market.get('bob', 'notes', '0.1.0'), null);
  });

  it('lets only the uploader publish or remove an upload, with every version', async () => {
    assert.equal((await call('bob', 'POST', '/api/market', 'notes@9.9.9')).status, 409);
    assert.equal((await call('bob', 'DELETE', '/api/market/notes')).status, 404);
    assert.equal((await call('alice', 'DELETE', '/api/market/notes')).status, 200);
    assert.equal((await call('bob', 'GET', '/api/market/notes/package')).status, 404);
    assert.equal(await ctx.market.get('bob', 'notes', '1.0.0'), null);
  });

  it('caps what one user\'s uploads hold in all', async () => {
    const half = USER_MAX_BYTES / 2;
    assert.equal((await call('carol', 'POST', '/api/market', `big-one@1.0.0@${half}`)).status, 201);
    const over = await call('carol', 'POST', '/api/market', `big-two@1.0.0@${half + 1}`);
    assert.equal(over.status, 413);
    assert.match(over.payload.error, /50 MB in all/);
    // Each version is kept, so each counts.
    assert.equal((await call('carol', 'POST', '/api/market', `big-one@1.1.0@${half + 1}`)).status, 413);
    assert.equal((await call('carol', 'POST', '/api/market', 'big-one@1.1.0@7')).status, 201);
  });

  it('keeps NanoAgent\'s plugin ids for NanoAgent', async () => {
    const taken = await call('alice', 'POST', '/api/market', 'bibtex-check@2.0.0');
    assert.equal(taken.status, 409);
    assert.match(taken.payload.error, /NanoAgent's own plugins/);
  });

  it('refuses a write that skips the route, through row-level security', async () => {
    await call('alice', 'POST', '/api/market', 'mine@1.0.0');
    await db.exec('set role mochi_runtime');
    try {
      await db.exec("begin; select set_config('app.user_id', 'bob', true)");
      const changed = await db.query("update market_plugin set version = '6.6.6' where id = 'mine' returning id");
      assert.deepEqual(changed.rows, []);
      await db.exec("select set_config('app.user_id', 'alice', true)");
      // A version is never changed or removed, even by its uploader.
      assert.deepEqual((await db.query("update market_plugin_version set package = 'x' where plugin_id = 'mine' returning plugin_id")).rows, []);
      assert.deepEqual((await db.query("delete from market_plugin_version where plugin_id = 'mine' returning plugin_id")).rows, []);
      await db.exec('rollback');
    } finally {
      await db.exec('reset role');
    }
    assert.equal((await ctx.market.list('bob')).find(plugin => plugin.id === 'mine').version, '1.0.0');
  });
});
