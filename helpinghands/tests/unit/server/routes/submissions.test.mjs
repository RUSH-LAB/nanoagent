import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {makeCtx, invoke} from '../../_harness.mjs';
import {migratedDatabase} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresMarket} = require('../../../../src/server/postgres/market.js');
const {createPostgresSubmissions} = require('../../../../src/server/postgres/submissions.js');
const routes = require('../../../../src/server/routes/submissions.js');

const STATEMENT = 'I voluntarily agree that my original contribution to Lab may be open-sourced under the MIT License.';

describe('workspace submissions', () => {
  let db;
  let pool;
  let ctx;
  const repositoryOf = url => ({owner: 'someone', repo: url, ref: 'HEAD', path: '', commit: 'c'.repeat(40)});
  // GitHub's archive of a repository is its name, and NanoAgent's package of it is that plugin at 1.0.0.
  const github = {source: async url => ({value: {repository: repositoryOf(url), archive: Buffer.from(url)}})};
  const ai = {
    packages: async () => ({value: {packages: []}}),
    packageSource: async archive => (archive.toString() === 'broken'
      ? {error: 'the plugin is refused: missing LICENSE', status: 422}
      : {value: {package: {id: archive.toString(), name: archive.toString(), version: '1.0.0', sha256: `sha-${archive}`, size: 7}, data: archive.toString('base64')}}),
  };
  let asked = {submissions: {statement: STATEMENT}};
  const workspaceSettings = {get: async () => asked};
  // alice owns `lab`, bob edits it, vic views it; carol owns `other`.
  const roles = {alice: 'owner', bob: 'editor', vic: 'viewer', carol: 'owner'};
  const call = (userId, method, body, workspaceId = 'lab') => invoke(routes, {
    ctx, method, path: `/api/workspaces/${workspaceId}/submissions`, body,
    auth: {userId, account: {id: userId, githubLogin: userId}},
    requestContext: {userId, workspaceId, membershipId: `m-${userId}`, role: roles[userId]},
  });

  before(async () => {
    const database = await migratedDatabase();
    db = database.db;
    pool = database.pool;
    await db.exec('update app_user set github_login = id');
    ctx = makeCtx({
      ai, github, workspaceSettings,
      market: createPostgresMarket({pool: database.pool}),
      submissions: createPostgresSubmissions({pool: database.pool}),
    });
  });
  after(() => db?.close());

  it('publishes the plugin and records the statement its submitter agreed to', async () => {
    const submitted = await call('vic', 'POST', {url: 'vic-agent', statement: STATEMENT});
    assert.equal(submitted.status, 201);
    const {submission} = submitted.payload;
    assert.deepEqual(submission.plugin, {id: 'vic-agent', version: '1.0.0', sha256: 'sha-vic-agent', repository: repositoryOf('vic-agent')});
    assert.equal(submission.statement, STATEMENT);
    assert.deepEqual(submission.submitter, {id: 'vic', name: 'Vic', github: 'vic'});
    const listed = (await ctx.market.list('alice')).map(plugin => plugin.id);
    assert.deepEqual(listed, ['vic-agent']);
  });

  it('refuses a statement other than the workspace\'s, and a plugin NanoAgent refuses', async () => {
    const changed = await call('bob', 'POST', {url: 'bob-agent', statement: 'I agree to something else'});
    assert.equal(changed.status, 409);
    assert.match(changed.payload.error, /has changed/);
    const broken = await call('bob', 'POST', {url: 'broken', statement: STATEMENT});
    assert.deepEqual([broken.status, broken.payload.error], [422, 'the plugin is refused: missing LICENSE']);
    assert.deepEqual((await call('bob', 'GET')).payload.submissions, []);
  });

  it('shows an owner every submission and any other member their own', async () => {
    await call('bob', 'POST', {url: 'bob-agent', statement: STATEMENT});
    const ids = async (userId, workspaceId) => (await call(userId, 'GET', undefined, workspaceId)).payload.submissions
      .map(submission => submission.plugin.id).sort();
    assert.deepEqual(await ids('alice'), ['bob-agent', 'vic-agent']);
    assert.deepEqual(await ids('bob'), ['bob-agent']);
    assert.deepEqual(await ids('vic'), ['vic-agent']);
    assert.deepEqual(await ids('carol', 'other'), []);
  });

  it('lets nobody change or remove a submission, not even an owner', async () => {
    const client = await pool.connect();
    try {
      await client.query("select set_config('app.user_id', 'alice', false), set_config('app.workspace_id', 'lab', false)");
      assert.equal((await client.query("update workspace_submission set statement = 'edited'")).rowCount, 0);
      assert.equal((await client.query('delete from workspace_submission')).rowCount, 0);
      assert.equal((await client.query('select count(*)::int as n from workspace_submission')).rows[0].n, 2);
    } finally {
      client.release();
    }
  });

  it('takes nothing in a workspace that asks for no submissions', async () => {
    asked = {};
    try {
      const refused = await call('bob', 'POST', {url: 'later-agent', statement: STATEMENT});
      assert.deepEqual([refused.status, refused.payload.error], [409, 'This workspace takes no submissions']);
    } finally {
      asked = {submissions: {statement: STATEMENT}};
    }
  });
});
