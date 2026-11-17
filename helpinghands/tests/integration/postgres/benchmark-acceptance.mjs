#!/usr/bin/env node
/**
 * Real PostgreSQL acceptance test for uploaded harness benchmarks (docs/contracts/rush-benchmark-api.md
 * in the NanoAgent project): a member publishes a case set, a member previews and submits a run, a
 * worker advertises its capabilities, claims, spends, records and finalizes its attempts, the run is
 * scored and compared, and other members and workspaces see none of it. It drives the running Node server over HTTP, signing in through a fake
 * GitHub (_fake-github.mjs) and with a fake NanoAgent that accepts any package.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {strToU8, zipSync} from 'fflate';
import {fakeGithubEnv, signInWithGithub} from './_github.mjs';

const require = createRequire(import.meta.url);
const {createPool, migrate, grantRuntimeAccess} = require('../../../src/server/postgres/client.js');

if (!process.env.DATABASE_URL || !process.env.DATABASE_MIGRATION_URL) {
  throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL are required');
}

const migrationPool = createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 2});
const runtimePool = createPool(process.env, {max: 2});
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const domain = `bench-${token}.invalid`;
const githubId = offset => 2_200_000_000 + parseInt(token.slice(0, 5), 16) * 8 + offset;
const github = Object.fromEntries(['root', 'alice', 'bob', 'carol'].map((name, offset) => [name, {
  id: githubId(offset), login: `${name}-${token}`, name, email: `${name}@${domain}`, verified: true,
}]));
const clientIp = `203.0.113.${1 + (parseInt(token.slice(0, 2), 16) % 250)}`;
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
};
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const availablePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const {port: selected} = probe.address();
    probe.close(error => error ? reject(error) : resolve(selected));
  });
});
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
let server;
let nano;
let logs = '';
let savedPolicy = null;
const createdUsers = [];
const pluginIds = [`bench-plugin-${token}`, `bench-plain-${token}`, `bench-unused-${token}`];
const nanoRequests = [];

/** One request: `{status, body, headers}`, the body parsed when it is JSON. */
async function api(path, {method = 'GET', cookie, body, headers = {}, raw} = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {'content-type': 'application/json'}),
      ...(cookie ? {cookie} : {}), 'x-real-ip': clientIp, origin, ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: 'manual',
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let parsed = buffer;
  if ((response.headers.get('content-type') ?? '').includes('json')) parsed = JSON.parse(buffer.toString());
  return {status: response.status, body: parsed, headers: response.headers, text: buffer.toString()};
}
// Each member's worker credential, minted below; a worker call is alice's unless it names `token`.
const credentials = {};
const worker = (path, {token: credential = credentials.alice, ...options} = {}) => api(`/api/benchmark-worker/${path}`, {...options, headers: {authorization: `Bearer ${credential}`, ...options.headers}});

async function userIdOf(user) {
  return (await migrationPool.query(
    "select user_id from auth_account where provider_id = 'github' and account_id = $1", [String(user.id)],
  )).rows[0]?.user_id;
}
/** A request as the GitHub sign-in helper wants it: the fetch Response itself. */
const request = (path, {method = 'GET', cookie, body} = {}) => fetch(`${origin}${path}`, {
  method,
  headers: {...(body === undefined ? {} : {'content-type': 'application/json'}), ...(cookie ? {cookie} : {}), 'x-real-ip': clientIp, origin},
  body: body === undefined ? undefined : JSON.stringify(body),
  redirect: 'manual',
});
async function signIn(name) {
  const {cookie, error} = await signInWithGithub(request, github[name].login);
  assert.ok(cookie, `${name} signs in with GitHub (${error})`);
  const id = await userIdOf(github[name]);
  createdUsers.push(id);
  return {id, cookie};
}

/** A statement as the database owner under forced row-level security, with a member's identity and/or the system's. */
async function as(identity, sql, values) {
  return (await asMany(identity, [[sql, values]])).at(-1);
}
/** Several statements in one transaction, for what a deferred constraint checks at commit. */
async function asMany({userId = '', workspaceId = '', system = false, pool = migrationPool}, statements) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true), set_config('app.benchmark_system', $3, true)",
      [userId, workspaceId, system ? 'on' : 'off']);
    const results = [];
    for (const [sql, values] of statements) results.push(await client.query(sql, values));
    await client.query('commit');
    return results;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
const asSystem = (sql, values) => as({system: true}, sql, values);

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited before it became ready\n${logs}`);
    try { if ((await fetch(`${origin}/api/health`)).status === 200) return; } catch {}
    await sleep(200);
  }
  throw new Error(`server did not become ready within 30 seconds\n${logs}`);
}
async function startServer(extra = {}) {
  server = spawn(process.execPath, ['src/server/index.js'], {
    cwd: repositoryRoot,
    env: {
      ...process.env, NODE_ENV: 'test', OPENROUTER_MANAGEMENT_KEY: 'acceptance-unused', ...fakeGithubEnv(Object.values(github)),
      ROOT_GITHUB_LOGIN: github.root.login, NANOAGENT_URL: `http://127.0.0.1:${nano.address().port}`, EDITOR_PORT: String(port), BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: `bench-${token}`.padEnd(48, 'x'), ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  await waitForServer();
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(5_000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

/** Publish `id` to the marketplace as `owner` and install it for `installers`. */
async function marketPlugin(owner, id, entry, installers) {
  const data = Buffer.from(`package of ${id} ${token}`);
  const digest = sha256(data);
  await asMany({userId: owner.id}, [
    ['insert into market_plugin (id, owner_id, version) values ($1, $2, $3)', [id, owner.id, '1.0.0']],
    ['insert into market_plugin_version (plugin_id, version, entry, package, sha256, size) values ($1, $2, $3, $4, $5, $6)',
      [id, '1.0.0', JSON.stringify({id, name: id, version: '1.0.0', status: 'ready', ...entry}), data, digest, data.length]],
  ]);
  for (const user of installers) await install(user, id);
  return digest;
}
/** Publish version `version` of the marketplace plugin `id`, as its owner: the package's digest. */
async function marketVersion(owner, id, version, entry) {
  const data = Buffer.from(`package of ${id} ${version} ${token}`);
  const digest = sha256(data);
  await as({userId: owner.id}, 'insert into market_plugin_version (plugin_id, version, entry, package, sha256, size) values ($1, $2, $3, $4, $5, $6)',
    [id, version, JSON.stringify({id, name: id, version, status: 'ready', ...entry}), data, digest, data.length]);
  return digest;
}
const install = (user, id) => as({userId: user.id}, "insert into user_plugin (user_id, plugin_id, source) values ($1, $2, 'upload')", [user.id, id]);
const uninstall = (user, id) => as({userId: user.id}, 'delete from user_plugin where user_id = $1 and plugin_id = $2', [user.id, id]);

const SECRET = `secret-reference-${token}`;
const LABEL = `mock-${token}`;
// What the test worker says it can do: every limit's maximum, whether it gives a harness internet access, and the models it prices.
const CAPS = {
  wall_time_ms: 600_000, max_model_calls: 100, max_output_tokens_per_call: 8192, max_cost_usd: 5, cpus: 4, memory_mb: 4096, pids: 1024,
  workspace_bytes: 1 << 30, workspace_files: 50_000, tmp_bytes: 1 << 28, build_wall_ms: 1_200_000, build_memory_mb: 4096,
  build_output_bytes: 1 << 30, build_files: 100_000, build_tmp_bytes: 1 << 29, internet_access: true,
  models: ['mock/model', 'other/model', 'bobs/model'],
};

try {
  nano = http.createServer((req, res) => {
    nanoRequests.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/v1/packages' ? JSON.stringify({packages: []}) : '{}');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => nano.once('listening', resolve));
  await migrate(migrationPool);
  await grantRuntimeAccess(migrationPool, runtimePool);
  savedPolicy = (await migrationPool.query('select * from platform_policy')).rows[0];
  await migrationPool.query("update platform_policy set signup_mode = 'open', max_workspaces_per_user = 5");

  await startServer({BENCHMARK_MEMBER_BUDGET_USD: '1.5', BENCHMARK_LEASE_SECONDS: '30', BENCHMARK_SWEEP_SECONDS: '1'});
  check('the worker API refuses a missing or unknown credential',
    (await api('/api/benchmark-worker/claim', {method: 'POST', body: {}})).status === 401
    && (await api('/api/benchmark-worker/claim', {method: 'POST', body: {}, headers: {authorization: 'Bearer nope'}})).status === 401);

  createdUsers.push(await userIdOf(github.root));
  const alice = await signIn('alice');
  const bob = await signIn('bob');
  const carol = await signIn('carol');
  const w1 = (await api('/api/workspaces', {method: 'POST', cookie: alice.cookie, body: {name: 'Bench One', slug: `b1-${token}`}})).body.workspace;
  const w2 = (await api('/api/workspaces', {method: 'POST', cookie: carol.cookie, body: {name: 'Bench Two', slug: `b2-${token}`}})).body.workspace;
  await migrationPool.query(
    "insert into workspace_member (id, workspace_id, user_id, role) values (gen_random_uuid()::text, $1, $2, 'viewer')", [w1.id, bob.id]);
  const w3 = (await api('/api/workspaces', {method: 'POST', cookie: alice.cookie, body: {name: 'Bench Three', slug: `b3-${token}`}})).body.workspace;
  const base = `/api/workspaces/${w1.id}/benchmark`;

  // ── Worker credentials ──
  const mint = (member, name = 'laptop') => api('/api/benchmark/worker-credentials', {method: 'POST', cookie: member.cookie, body: {name}});
  const minted = {alice: await mint(alice), bob: await mint(bob), carol: await mint(carol)};
  credentials.alice = minted.alice.body.token;
  credentials.bob = minted.bob.body.token;
  credentials.carol = minted.carol.body.token;
  check('a member mints a worker credential: a random token shown once',
    minted.alice.status === 201 && /^rwk_[A-Za-z0-9_-]{43}$/.test(credentials.alice) && credentials.alice !== credentials.bob && minted.alice.body.name === 'laptop');
  check('the token is stored only as its SHA-256',
    (await asSystem('select token_sha256 from benchmark_worker_credential where credential_id = $1', [minted.alice.body.credential_id])).rows[0].token_sha256 === sha256(credentials.alice)
    && (await asSystem('select count(*)::int as n from benchmark_worker_credential where token_sha256 = $1', [credentials.alice])).rows[0].n === 0);
  const credentialList = await api('/api/benchmark/worker-credentials', {cookie: alice.cookie});
  check('a member lists only their own credentials, never a token',
    credentialList.status === 200 && credentialList.body.credentials.length === 1 && credentialList.body.credentials[0].credential_id === minted.alice.body.credential_id
    && credentialList.body.credentials[0].revoked_at === null && !JSON.stringify(credentialList.body).includes(credentials.alice));
  check('minting and listing need a session and a name',
    (await api('/api/benchmark/worker-credentials', {method: 'POST', body: {name: 'x'}})).status === 401 && (await api('/api/benchmark/worker-credentials')).status === 401
    && (await api('/api/benchmark/worker-credentials', {method: 'POST', cookie: alice.cookie, body: {}})).status === 400);
  const spare = (await mint(carol, 'spare')).body;
  check('a credential works on the worker API until it is revoked, and only its owner revokes it',
    (await worker('claim', {method: 'POST', token: spare.token, body: {}})).status === 400
    && (await api(`/api/benchmark/worker-credentials/${spare.credential_id}`, {method: 'DELETE', cookie: bob.cookie})).status === 404
    && (await api(`/api/benchmark/worker-credentials/${spare.credential_id}`, {method: 'DELETE', cookie: carol.cookie})).status === 200
    && (await worker('claim', {method: 'POST', token: spare.token, body: {}})).status === 401
    && (await api('/api/benchmark/worker-credentials', {cookie: carol.cookie})).body.credentials.find(entry => entry.credential_id === spare.credential_id).revoked_at !== null
    && (await worker('claim', {method: 'POST', token: credentials.carol, body: {}})).status === 400);
  check('a member credential opens no member route', (await api(`${base}/runs`, {headers: {authorization: `Bearer ${credentials.alice}`}})).status !== 200);
  const suspended = (await mint(carol, 'suspended')).body;
  const suspendCarol = banned => migrationPool.query(`update app_user set banned_at = ${banned ? 'now()' : 'null'} where id = $1`, [carol.id]);
  const beforeSuspension = (await worker('claim', {method: 'POST', token: suspended.token, body: {}})).status;
  await suspendCarol(true);
  const whileSuspended = (await worker('claim', {method: 'POST', token: suspended.token, body: {}})).status;
  await suspendCarol(false);
  check('a suspended member\'s credential is refused until the member is reinstated', [beforeSuspension, whileSuspended, (await worker('claim', {method: 'POST', token: suspended.token, body: {}})).status].join() === '400,401,400');

  // ── Worker capabilities ──
  const claim = async (id = 'w1', {label = LABEL, capabilities = CAPS, body = {}, token} = {}) => worker('claim', {method: 'POST', token, body: {worker_id: id, endpoint_profile: {label, mode: 'mock'}, capabilities, ...body}});

  // ── Benchmark publishing ──
  const pluginId = pluginIds[0];
  // The catalog entry NanoAgent stores for a package (Manifest.public()): publishing checks a benchmark's task against it.
  const benchEntry = {
    name: 'Bench plugin', permissions: {network: {hosts: ['api.example.com']}, filesystem: {write: []}}, tools: [{name: 'read', description: 'Reads a file'}],
    tasks: [{id: 'sum', runner: 'agent', description: 'Add the numbers', tools: ['read'], instructions: 'Add the numbers.\nBe exact.'}],
  };
  const sha = await marketPlugin(alice, pluginId, benchEntry, [alice, bob]);
  const sha2 = await marketVersion(alice, pluginId, '2.0.0', benchEntry);
  const otherSha = await marketPlugin(alice, pluginIds[1], benchEntry, [alice]);
  await marketPlugin(alice, pluginIds[2], {tools: [], tasks: []}, []);
  const task = {
    kind: 'agent', egress_hosts: ['api.example.com'], description: 'Add the numbers', instructions: 'Add the numbers.\nBe exact.',
    input_schema: {type: 'object', properties: {numbers: {type: 'array'}}}, output_schema: {type: 'object', properties: {sum: {type: 'number'}}},
    tools: [{name: 'read', description: 'Reads a file', input_schema: {type: 'object'}, output_schema: {type: 'object'}, writes: false}],
  };
  const allCases = [
    {case_id: 'c1', kind: 'answer', arguments: {numbers: [1, 2]}},
    {case_id: 'r1', kind: 'refuse', arguments: {numbers: 'x'}, expected_error: 'numbers must be an array'},
    {case_id: 'c2', kind: 'answer', arguments: {numbers: [3, 4]}},
    {case_id: 'r2', kind: 'refuse', arguments: {numbers: null}, expected_error: 'numbers is required'},
  ];
  const allPrivate = {c1: {expected: 3, note: SECRET}, r1: 'numbers must be an array', c2: {expected: 7, note: SECRET}, r2: 'numbers is required'};
  const runLimits = {wall_time_ms: 60_000, max_model_calls: 3, max_output_tokens_per_call: 512, max_cost_usd: 1.5};
  // A benchmark of plugin version 1.0.0 over the named cases, as the publishing route takes it.
  const publication = (name, caseIds, extra = {}) => ({
    name, plugin_id: pluginId, plugin_name: 'Bench plugin', version: '1.0.0', package_sha256: sha, task_id: 'sum', task, context: 'Résumé: sums',
    cases: allCases.filter(c => caseIds.includes(c.case_id)), private: Object.fromEntries(caseIds.map(id => [id, allPrivate[id]])),
    model: 'mock/model', endpoint_profile: LABEL, limits: runLimits, coding_template: null, task_instructions: null, ...extra,
  });
  const publish = (member, body) => api('/api/benchmark/benchmarks', {method: 'POST', cookie: member.cookie, body});
  const benchmarkRows = async name => (await asSystem('select count(*)::int as n from benchmark where name = $1', [name])).rows[0].n;
  const caseSetRows = async () => (await asSystem('select count(*)::int as n from benchmark_case_set where plugin_id = any($1::text[])', [pluginIds])).rows[0].n;

  const mainName = `cases-${token}`;
  const unavailable = await publish(alice, publication(mainName, ['c1', 'r1']));
  check('a benchmark for an endpoint no worker advertised for is refused, and nothing is stored',
    unavailable.status === 409 && unavailable.body.code === 'worker_unavailable' && await benchmarkRows(mainName) === 0 && await caseSetRows() === 0);
  check('a claim must carry capabilities, every one of them',
    (await claim('w1', {capabilities: null})).status === 400 && (await claim('w1', {capabilities: {...CAPS, pids: undefined}})).status === 400);
  check('a claim must advertise the models it prices, as a non-empty list of names',
    (await claim('w1', {capabilities: {...CAPS, models: undefined}})).status === 400 && (await claim('w1', {capabilities: {...CAPS, models: []}})).status === 400
    && (await claim('w1', {capabilities: {...CAPS, models: [1]}})).status === 400);
  check('a worker with nothing to claim advertises its capabilities and gets 204', (await claim('w0')).status === 204);
  const endpoints = (await api(`${base}/defaults`, {cookie: alice.cookie})).body.endpoints;
  check('the latest capabilities are kept per endpoint label', endpoints.find(entry => entry.label === LABEL)?.capabilities.memory_mb === 4096);

  const staleLabel = `${LABEL}-stale`;
  check('a worker that advertised is listed for its label', (await claim('w-stale', {label: staleLabel})).status === 204
    && (await api(`${base}/defaults`, {cookie: alice.cookie})).body.endpoints.some(entry => entry.label === staleLabel));
  await asSystem("update benchmark_worker_capability set updated_at = now() - interval '1 day' where endpoint_label = $1", [staleLabel]);
  check('a label whose workers have not claimed within the capability window is no longer available, to a listing or to a publication',
    !(await api(`${base}/defaults`, {cookie: alice.cookie})).body.endpoints.some(entry => entry.label === staleLabel)
    && (await publish(alice, publication(`stale-${token}`, ['c1'], {endpoint_profile: staleLabel}))).body.code === 'worker_unavailable');

  const main = await publish(alice, publication(mainName, ['c1', 'r1']));
  const mainId = main.body.benchmark.benchmark_id;
  check('a member publishes a benchmark for a plugin version: named, tied to the version, with the case set and run configuration pinned',
    main.status === 201 && main.body.created === true && main.body.benchmark.name === mainName && main.body.benchmark.plugin.id === pluginId && main.body.benchmark.plugin.version === '1.0.0'
    && main.body.benchmark.plugin.sha256 === sha && main.body.benchmark.model === 'mock/model' && main.body.benchmark.endpoint_profile === LABEL
    && main.body.benchmark.limits.max_model_calls === 3 && main.body.benchmark.limits.internet_access === true && main.body.benchmark.limits.cpus === 1
    && main.body.benchmark.case_count === 2 && main.body.benchmark.answer_count === 1 && main.body.benchmark.refuse_count === 1
    && main.body.benchmark.run_count === 0 && main.body.benchmark.runner_count === 0 && main.body.benchmark.publisher.id === alice.id
    && /^[0-9a-f]{64}$/.test(main.body.benchmark.digest) && /^[0-9a-f]{64}$/.test(main.body.benchmark.case_set_digest));
  check('the benchmark pins both prompts as text: the default coding template and the task\'s instructions',
    main.body.benchmark.coding_template.startsWith('Task: {description}.') && main.body.benchmark.task_instructions === 'Add the numbers.\nBe exact.');
  const again = await publish(alice, publication(mainName, ['c1', 'r1']));
  check('publishing the same benchmark again answers created: false and stores nothing',
    again.status === 200 && again.body.created === false && again.body.benchmark.benchmark_id === mainId && await benchmarkRows(mainName) === 1);
  const rowsBefore = await caseSetRows();
  const changed = await publish(alice, publication(mainName, ['c1', 'r1'], {model: 'other/model'}));
  const changedReference = await publish(alice, {...publication(mainName, ['c1', 'r1']), private: {c1: {expected: 4}, r1: allPrivate.r1}});
  check('a changed benchmark under the same name is refused, and nothing is stored',
    changed.status === 409 && changed.body.code === 'benchmark_name_taken' && changedReference.body.code === 'benchmark_name_taken' && await benchmarkRows(mainName) === 1 && await caseSetRows() === rowsBefore);
  check('a worker advertises for its own member only', (await claim('wb', {token: credentials.bob})).status === 204
    && !(await api(`/api/workspaces/${w2.id}/benchmark/defaults`, {cookie: carol.cookie})).body.endpoints.some(entry => entry.label === LABEL));
  const bobsOwn = await publish(bob, publication(`bobs-${token}`, ['c1', 'r1']));
  check('any member publishes a benchmark for a published plugin, and a name is unique per plugin version whoever published it',
    bobsOwn.status === 201 && bobsOwn.body.benchmark.publisher.id === bob.id
    && (await publish(bob, publication(mainName, ['c1', 'r1'], {model: 'bobs/model'}))).body.code === 'benchmark_name_taken');
  check('identical case sets are shared between benchmarks', bobsOwn.body.benchmark.case_set_id === main.body.benchmark.case_set_id);
  // Deleting the case set's first publisher must not fail on the benchmarks that share it; the delete is rolled back.
  const deleting = await migrationPool.connect();
  try {
    await deleting.query('begin');
    // The plugin is Alice's too, and goes with her; hand it to Carol so only the case set's publisher link is tested.
    await deleting.query('update market_plugin set owner_id = $1 where id = $2', [carol.id, pluginId]);
    await deleting.query('delete from app_user where id = $1', [alice.id]);
    const kept = (await deleting.query('select publisher_id from benchmark_case_set where case_set_id = $1', [main.body.benchmark.case_set_id])).rows;
    check('deleting the first publisher of a shared case set succeeds and leaves the case set, without a publisher', kept.length === 1 && kept[0].publisher_id === null);
  } finally {
    await deleting.query('rollback');
    deleting.release();
  }
  const main2 = await publish(alice, {...publication(mainName, ['c1', 'r1'], {version: '2.0.0', package_sha256: sha2})});
  check('the same name is free for another plugin version, with a case set of its own',
    main2.status === 201 && main2.body.benchmark.plugin.version === '2.0.0' && main2.body.benchmark.benchmark_id !== mainId && main2.body.benchmark.case_set_id !== main.body.benchmark.case_set_id);
  check('a version never published has no benchmark',
    (await publish(alice, publication('x', ['c1'], {version: '9.9.9'}))).body.code === 'unknown_plugin_version'
    && (await publish(alice, publication('x', ['c1'], {package_sha256: 'f'.repeat(64)}))).body.code === 'unknown_plugin_version');
  const rowsAfter = await caseSetRows();
  const refused = async extra => (await publish(alice, publication(`refused-${token}`, ['c1'], extra))).body;
  check('limits above what the endpoint\'s workers give, internet access where they cannot, and an unknown limit are refused, and nothing is stored',
    (await refused({limits: {memory_mb: 8192}})).code === 'limit_exceeds_worker' && (await refused({limits: {memory_mb: 8192}})).exceeded[0].max === 4096
    && (await refused({limits: {nope: 1}})).code === 'invalid_request'
    && await benchmarkRows(`refused-${token}`) === 0 && await caseSetRows() === rowsAfter);
  const unpriced = await api('/api/benchmark/benchmarks', {method: 'POST', cookie: alice.cookie, body: publication(`unpriced-${token}`, ['c1'], {model: 'nobody/prices-this'})});
  check('a model no worker on the endpoint prices is refused as unknown_model, and nothing is stored',
    unpriced.status === 400 && unpriced.body.code === 'unknown_model' && unpriced.body.models.includes('mock/model')
    && await benchmarkRows(`unpriced-${token}`) === 0 && await caseSetRows() === rowsAfter);
  check('a template with an unknown placeholder, blank text and blank instructions are refused',
    (await refused({coding_template: 'Do {bogus}'})).code === 'invalid_template' && (await refused({coding_template: 'a } b'})).code === 'invalid_template'
    && (await refused({coding_template: '  '})).code === 'empty_template' && (await refused({task_instructions: ''})).code === 'empty_instructions');
  check('a benchmark needs a model, an endpoint and a name',
    (await refused({model: undefined})).code === 'invalid_request' && (await refused({endpoint_profile: undefined})).code === 'invalid_request' && (await refused({name: 'Bad Name'})).code === 'invalid_request');
  const invalid = await publish(alice, {...publication('y', ['c1', 'r1']), cases: allCases.slice(0, 2), private: {c1: allPrivate.c1}});
  check('a benchmark whose private references do not match its cases is refused', invalid.body.code === 'invalid_request');
  check('publishing needs a session and no workspace', (await api('/api/benchmark/benchmarks', {method: 'POST', body: publication('z', ['c1'])})).status === 401);
  check('private references are in no table a member can read',
    // The database owner here is a superuser, which row-level security never binds; the runtime role is bound.
    (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_case_set_private')).rowCount === 0
    && (await as({userId: alice.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_case_set_private')).rowCount === 0
    && (await as({system: true, pool: runtimePool}, 'select 1 from benchmark_case_set_private')).rowCount > 0);

  // The benchmarks the runs below use, over the same plugin version and so the same case sets where their cases are the same.
  const published = async (name, caseIds, extra) => {
    const result = await publish(alice, publication(`${name}-${token}`, caseIds, extra));
    assert.equal(result.status, 201, `${name}: ${result.text}`);
    return result.body.benchmark;
  };
  const single = await published('single', ['c2']);
  const withTools = await published('tools', ['c1', 'r1'], {limits: {...runLimits, internet_access: false}, task_instructions: 'Use read first.'});
  const cross = await published('cross', ['c1', 'c2']);
  const crowd = await published('crowd', ['c1', 'r1', 'c2', 'r2'], {limits: runLimits});
  const small = await published('small', ['c1', 'r1'], {limits: {...runLimits, memory_mb: 512}});
  const custom = await published('custom', ['c1', 'r1'], {coding_template: 'Do {description}\r\nin {workspace} {{ok}}', limits: {...runLimits, internet_access: false}});
  const mismatched = await publish(alice, publication(`mismatch-${token}`, ['c1'], {task: {...task, egress_hosts: ['api.example.com', 'evil.example.com']}}));
  check('a task that differs from its package is refused with 422 task_mismatch and stores nothing', mismatched.status === 422 && mismatched.body.code === 'task_mismatch' && await benchmarkRows(`mismatch-${token}`) === 0);
  const otherPlugin = (await publish(alice, {...publication(`other-${token}`, ['c1', 'r1']), plugin_id: pluginIds[1], package_sha256: otherSha})).body.benchmark;
  const SHARED = `shared-${token}`;
  check('a worker for the shared endpoint advertises', (await claim('w-shared', {label: SHARED})).status === 204);
  const shared = await published('shared', ['c1', 'r1'], {endpoint_profile: SHARED});
  const shared2 = (await publish(alice, publication(`shared-${token}`, ['c1', 'r1'], {endpoint_profile: SHARED, version: '2.0.0', package_sha256: sha2}))).body.benchmark;

  // ── Benchmarks, defaults ──
  const listed = (await api(`${base}/benchmarks`, {cookie: alice.cookie})).body.benchmarks;
  check('every signed-in member lists the published benchmarks, with who published them',
    listed.filter(entry => entry.name === mainName).length === 2 && listed.every(entry => typeof entry.publisher.name === 'string' && 'github' in entry.publisher)
    && (await api(`/api/workspaces/${w2.id}/benchmark/benchmarks?plugin_id=${pluginId}`, {cookie: carol.cookie})).body.benchmarks.some(entry => entry.benchmark_id === mainId)
    && (await api(`${base}/benchmarks?plugin_id=nothing`, {cookie: alice.cookie})).body.benchmarks.length === 0);
  check('the benchmark lists take a before cursor of any date, and a limit',
    (await api(`${base}/benchmarks?before=1`, {cookie: alice.cookie})).body.benchmarks.length === 0
    && (await api(`${base}/benchmarks?limit=1`, {cookie: alice.cookie})).body.benchmarks.length === 1
    && (await api(`${base}/runs?before=1`, {cookie: alice.cookie})).status === 200 && (await api(`${base}/benchmarks?before=nope`, {cookie: alice.cookie})).status === 400);
  const byVersion = (await api(`${base}/benchmarks?plugin_id=${pluginId}&version=2.0.0`, {cookie: bob.cookie})).body.benchmarks;
  check('the list filters to one plugin version, and a version needs its plugin',
    byVersion.length >= 2 && byVersion.every(entry => entry.plugin.version === '2.0.0') && byVersion.some(entry => entry.benchmark_id === main2.body.benchmark.benchmark_id)
    && (await api(`${base}/benchmarks?version=2.0.0`, {cookie: bob.cookie})).body.code === 'invalid_request');
  const detail = (await api(`${base}/benchmarks/${mainId}`, {cookie: bob.cookie})).body.benchmark;
  check('a benchmark\'s detail shows its task, context and cases, in order, but no private reference',
    detail.task.kind === 'agent' && detail.task.egress_hosts.join() === 'api.example.com' && detail.context === 'Résumé: sums' && detail.cases.map(c => `${c.case_id}:${c.kind}`).join() === 'c1:answer,r1:refuse'
    && detail.cases[1].expected_error === 'numbers must be an array' && detail.cases[0].arguments.numbers.join() === '1,2' && !JSON.stringify(detail).includes(SECRET)
    && !JSON.stringify(detail).includes('reference') && /^[0-9a-f]{64}$/.test(detail.cases[0].content_digest) && detail.coding_template === main.body.benchmark.coding_template);
  check('an unknown benchmark is not found, nor a non-UUID one', (await api(`${base}/benchmarks/${crypto.randomUUID()}`, {cookie: alice.cookie})).body.code === 'unknown_benchmark'
    && (await api(`${base}/benchmarks/nope`, {cookie: alice.cookie})).status === 404 && (await api(`${base}/benchmarks/${crypto.randomUUID()}/results`, {cookie: alice.cookie})).status === 404);
  const defaults = (await api(`${base}/defaults`, {cookie: alice.cookie})).body;
  check('the defaults give the limits, the coding template and the advertised endpoints',
    defaults.limits.internet_access === true && !('concurrency' in defaults.limits) && defaults.limits.max_cost_usd === 1.5 && defaults.renderer_version === 'rush.prompt.v1'
    && defaults.coding_template.startsWith('Task: {description}.') && defaults.endpoints.some(entry => entry.label === LABEL));
  check('there is no route that publishes a case set alone', (await api('/api/benchmark/case-sets', {method: 'POST', cookie: alice.cookie, body: publication('x', ['c1'])})).status === 404
    && (await api(`${base}/case-sets`, {cookie: alice.cookie})).status === 404 && (await api(`${base}/pins`, {method: 'POST', cookie: alice.cookie, body: {}})).status === 404);

  // ── Previews ──
  const preview = async (benchmarkId, policy = 'coding', member = alice) => api(`${base}/previews`, {method: 'POST', cookie: member.cookie, body: {benchmark_id: benchmarkId, policy}});
  const coding = await preview(mainId);
  const shown = coding.body;
  check('a coding preview resolves every case of the benchmark and shows its pinned template',
    coding.status === 200 && shown.cases.map(c => c.case_id).join() === 'c1,r1' && shown.prompt.source === 'benchmark' && shown.prompt.text === main.body.benchmark.coding_template
    && shown.policy === 'coding' && shown.renderer_version === 'rush.prompt.v1' && shown.benchmark.benchmark_id === mainId && shown.model === 'mock/model' && shown.endpoint_profile === LABEL);
  check('a preview renders each case prompt, {system, user, sha256}, with the workspace and the case context',
    shown.cases.every(c => c.prompt.system === null && c.prompt.user.includes('/rush/workspace/answer.json') && c.prompt.sha256.length === 64)
    && shown.cases[0].prompt.user.includes('Résumé: sums') && shown.cases[0].prompt.user.includes('"numbers": [\n    1,\n    2\n  ]'));
  check('a preview shows the benchmark\'s effective limits and the capabilities, and flags internet access as unverified egress',
    shown.limits.effective.internet_access === true && shown.limits.effective.max_model_calls === 3 && shown.limits.capabilities.memory_mb === 4096 && shown.limits.defaults === undefined
    && shown.unverified_egress === true && shown.egress_hosts === null);
  const badPreview = async body => (await api(`${base}/previews`, {method: 'POST', cookie: alice.cookie, body})).body.code;
  check('a preview takes a benchmark and a policy and nothing else: no model, limits, dialects, prompt, selection or endpoint',
    await badPreview({benchmark_id: mainId, policy: 'other'}) === 'invalid_request' && await badPreview({policy: 'coding'}) === 'invalid_request'
    && await badPreview({benchmark_id: 'x', policy: 'coding'}) === 'invalid_request'
    && (await Promise.all([{model: 'm'}, {limits: {}}, {dialects: ['responses']}, {prompt: {}}, {selection: {}}, {endpoint_profile: 'mock'}]
      .map(extra => badPreview({benchmark_id: mainId, policy: 'coding', ...extra})))).every(code => code === 'invalid_request'));
  check('an unknown benchmark cannot be previewed', await badPreview({benchmark_id: crypto.randomUUID(), policy: 'coding'}) === 'unknown_benchmark');
  const customPreview = await preview(custom.benchmark_id);
  check('a benchmark\'s own template is normalized, rendered and pinned, and internet off is not unverified egress',
    customPreview.body.prompt.text === 'Do {description}\nin {workspace} {{ok}}' && customPreview.body.cases[0].prompt.user === 'Do Add the numbers\nin /rush/workspace {ok}' && customPreview.body.unverified_egress === false);
  const tools = await preview(mainId, 'task_tools');
  check('a task tools preview renders the system prompt from the benchmark\'s instructions and the user prompt from the input',
    tools.body.prompt.source === 'benchmark' && tools.body.prompt.text === 'Add the numbers.\nBe exact.' && tools.body.egress_hosts.join() === 'api.example.com'
    && tools.body.cases[0].prompt.system.includes('Task: Add the numbers.\nAdd the numbers.\nBe exact.\n\nWhen the task is done, call submit with its result.')
    && tools.body.cases[0].prompt.user === 'Task input:\n{\n  "numbers": [\n    1,\n    2\n  ]\n}');
  const toolsOwn = await preview(withTools.benchmark_id, 'task_tools');
  check('a benchmark that pins other instructions renders them', toolsOwn.body.prompt.text === 'Use read first.' && toolsOwn.body.cases.every(c => c.prompt.system.includes('Use read first.')));

  // ── Sources ──
  const harnessZip = (name, version, comment = '', dialects = '[chat_completions]') => Buffer.from(zipSync({
    'harness.yaml': strToU8(`protocol: rush.harness.v1\n${name === null ? '' : `name: ${name}\n`}${version === null ? '' : `version: "${version}"\n`}dialects: ${dialects}\ntoolchain: go-1\nlockfiles: []\nbuild: {argv: [go, build], outputs: [harness]}\nrun: {argv: [/harness/harness]}\n# ${comment}\n`),
    'main.go': strToU8('package main'),
  }));
  const upload = (member, raw, headers = {'content-type': 'application/zip'}) => api(`${base}/sources`, {method: 'POST', cookie: member.cookie, raw, headers});
  const zipA = harnessZip('my-harness', '1', 'alice');
  check('a source must be sent as application/zip', (await upload(alice, zipA, {'content-type': 'text/plain'})).status === 415);
  check('a source that is no ZIP is refused', (await upload(alice, Buffer.from('not a zip')).then(r => r.body.code)) === 'invalid_zip');
  check('a ZIP without harness.yaml at its root is refused', (await upload(alice, Buffer.from(zipSync({'sub/harness.yaml': strToU8('x')})))).body.code === 'missing_manifest');
  const noName = await upload(alice, harnessZip(null, '1'));
  const noVersion = await upload(alice, harnessZip('my-harness', null));
  check('a manifest without name or version is refused, naming the problem',
    noName.status === 400 && noName.body.code === 'invalid_manifest' && noName.body.error.includes("'name'") && noVersion.body.code === 'invalid_manifest' && noVersion.body.error.includes("'version'")
    && (await upload(alice, Buffer.from(zipSync({'harness.yaml': strToU8('protocol: rush.harness.v1\nname: x\nversion: "1"\ntoolchain: go-1\nlockfiles: []\nbuild: {argv: [go], outputs: [h]}\nrun: {argv: [/h]}\n')})))).body.error.includes("'dialects'")
    && (await upload(alice, harnessZip('Bad Name', '1'))).body.code === 'invalid_manifest');
  const sourceRows = async () => (await asSystem('select count(*)::int as n from benchmark_source where user_id = $1', [alice.id])).rows[0].n;
  const sourcesBefore = await sourceRows();
  const source = (await upload(alice, zipA)).body;
  check('a source is stored under its digest, with the harness its manifest declares',
    source.source_sha256 === sha256(zipA) && source.size === zipA.length && JSON.stringify(source.harness) === '{"name":"my-harness","version":"1","dialects":["chat_completions"]}' && await sourceRows() === sourcesBefore + 1);
  const sameAgain = await upload(alice, zipA);
  check('the same ZIP again is accepted any number of times', sameAgain.status === 201 && sameAgain.body.source_sha256 === source.source_sha256 && await sourceRows() === sourcesBefore + 1);
  const taken = await upload(alice, harnessZip('my-harness', '1', 'changed'));
  check('a different ZIP under the same name and version is refused with the pinned digest, and nothing is stored',
    taken.status === 409 && taken.body.code === 'harness_version_taken' && taken.body.pinned_sha256 === source.source_sha256 && taken.body.harness.name === 'my-harness' && taken.body.harness.version === '1'
    && await sourceRows() === sourcesBefore + 1);
  const nextVersion = await upload(alice, harnessZip('my-harness', '2', 'alice'));
  check('a new version is a new pin', nextVersion.status === 201 && nextVersion.body.harness.version === '2');
  const bobsSource = (await upload(bob, harnessZip('my-harness', '1', 'bob'))).body;
  check('another member uses the same name and version for a ZIP of their own', bobsSource.source_sha256 !== source.source_sha256 && bobsSource.harness.name === 'my-harness' && bobsSource.harness.version === '1');
  check('a harness version is pinned for its member whatever the workspace',
    (await api(`/api/workspaces/${w3.id}/benchmark/sources`, {method: 'POST', cookie: alice.cookie, raw: harnessZip('my-harness', '1', 'other workspace'), headers: {'content-type': 'application/zip'}})).body.code === 'harness_version_taken');
  const responsesSource = (await upload(alice, harnessZip('two-dialects', '1', '', '[chat_completions, responses]'))).body;
  const reference = (member, name, raw, headers = {'content-type': 'application/zip'}) => api(`${base}/sources/references/${name}`, {method: 'POST', cookie: member.cookie, raw, headers});
  const reserved = await upload(alice, harnessZip('claude-code', '1'));
  check('a member\'s own upload may not take a reference harness\'s name', reserved.status === 400 && reserved.body.code === 'reserved_harness_name' && await sourceRows() === sourcesBefore + 3);
  const claude = await reference(alice, 'claude-code', harnessZip('claude-code', 'abc123'));
  check('the reference path takes the reference\'s ZIP under its own name, and echoes the derived version',
    claude.status === 201 && claude.body.harness.name === 'claude-code' && claude.body.harness.version === 'abc123' && (await reference(alice, 'claude-code', harnessZip('claude-code', 'abc123'))).status === 201);
  const changedClaude = await reference(alice, 'claude-code', harnessZip('claude-code', 'abc123', 'changed'));
  check('a changed reference under one derived version is refused as any version pin is', changedClaude.status === 409 && changedClaude.body.code === 'harness_version_taken');
  check('the reference path refuses a ZIP whose manifest names another harness, and a name that is no reference',
    (await reference(alice, 'claude-code', harnessZip('codex', '1'))).body.code === 'reference_name_mismatch'
    && (await reference(alice, 'my-harness', harnessZip('my-harness', '1'))).body.code === 'unknown_reference'
    && (await reference(alice, 'claude-code', harnessZip('claude-code', '1'), {'content-type': 'text/plain'})).status === 415);

  // ── Number spellings ──
  // A publication Python wrote keeps its numbers as written (1.0, 1e-05, a big int) in the stored case set, the pinned prompt,
  // the run and the worker's claim, which JavaScript's JSON.parse would have read as 1, 0.00001 and 12345678901234567000.
  const lexemeLabel = `lexemes-${token}`;
  check('an advertising worker for the lexemes endpoint gets nothing yet', (await claim('lex', {label: lexemeLabel})).status === 204);
  const lexemePublication = JSON.stringify({...publication(`lexemes-${token}`, ['c1'], {endpoint_profile: lexemeLabel, limits: {max_cost_usd: 0.50}}), task: {...task, input_schema: {type: 'object', properties: {ratio: {minimum: 0.0}}}}, cases: [
    {case_id: 'c1', kind: 'answer', arguments: {ratio: '@@1.0@@', tiny: '@@1e-05@@', big: '@@12345678901234567890@@'}},
  ], private: {c1: {expected: '@@2.50@@'}}}).replace(/"@@([^@]+)@@"/g, '$1').replace('"minimum":0', '"minimum":0.0').replace('"max_cost_usd":0.5', '"max_cost_usd":0.50');
  const lexemeSet = await api('/api/benchmark/benchmarks', {method: 'POST', cookie: alice.cookie, raw: lexemePublication, body: {}});
  const lexemeId = lexemeSet.body.benchmark.benchmark_id;
  check('a benchmark whose numbers have a spelling JavaScript would change is published', lexemeSet.status === 201 && lexemeSet.body.benchmark.limits.max_cost_usd === 0.5);
  check('the stored case set keeps each number\'s spelling',
    (await api(`${base}/benchmarks/${lexemeId}`, {cookie: alice.cookie})).text.includes('"ratio":1.0,"tiny":1e-05,"big":12345678901234567890')
    && (await migrationPool.query('select arguments::text as text from benchmark_case_set_case where case_set_id = $1', [lexemeSet.body.benchmark.case_set_id])).rows[0].text.includes('1e-05'));
  const lexemePreview = (await preview(lexemeId)).body;
  check('the preview prints the numbers as Python\'s json.dumps does',
    lexemePreview.cases[0].prompt.user.includes('"ratio": 1.0,\n  "tiny": 1e-05,\n  "big": 12345678901234567890') && lexemePreview.cases[0].prompt.user.includes('"minimum": 0.0'));
  const lexemeRun = await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: {
    benchmark_id: lexemeId, policy: 'coding', idempotency_key: `lex-${token}`, preview_id: lexemePreview.preview_id, source_sha256: source.source_sha256,
  }});
  check('the run shows them as published', lexemeRun.status === 201 && lexemeRun.text.includes('"arguments":{"ratio":1.0,"tiny":1e-05,"big":12345678901234567890}')
    && lexemeRun.body.run.cases[0].prompt.user === lexemePreview.cases[0].prompt.user);
  const lexemeClaim = await claim('lex', {label: lexemeLabel});
  check('the worker\'s claim carries the numbers and the private reference as published',
    lexemeClaim.text.includes('"arguments":{"ratio":1.0,"tiny":1e-05,"big":12345678901234567890}') && lexemeClaim.text.includes('"private_reference":{"expected":2.50}')
    && lexemeClaim.text.includes('"minimum":0.0'));

  // ── Runs ──
  const runBody = (key, previewId, body) => ({...body, idempotency_key: key, preview_id: previewId, source_sha256: source.source_sha256});
  const firstSetup = {benchmark_id: mainId, policy: 'coding'};
  const firstPreview = coding.body;
  const created = await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`key-${token}`, firstPreview.preview_id, firstSetup)});
  const run = created.body.run;
  check('a run is queued with one attempt per case of the benchmark', created.status === 201 && run.cases.length === 2 && run.cases.every(c => c.attempts.length === 1 && c.attempts[0].state === 'queued'));
  check('the run pins the benchmark, harness, case set, policy, prompt, the benchmark\'s limits and model, and the pinned plugin',
    run.benchmark.benchmark_id === mainId && run.benchmark.name === mainName && JSON.stringify(run.harness) === '{"name":"my-harness","version":"1","dialects":["chat_completions"]}'
    && run.dialects.join() === 'chat_completions' && run.model === 'mock/model' && run.endpoint_profile === LABEL
    && run.case_set.case_set_id === main.body.benchmark.case_set_id && run.case_set.digest === main.body.benchmark.case_set_digest && run.case_set.plugin.sha256 === sha && run.policy === 'coding'
    && run.prompt.source === 'benchmark' && run.prompt.text === main.body.benchmark.coding_template && run.prompt.renderer_version === 'rush.prompt.v1'
    && run.limits.max_model_calls === 3 && run.limits.internet_access === true && run.limits.cpus === 1 && run.unverified_egress === true
    && JSON.stringify(run.selection) === '{"case_ids":["c1","r1"]}' && run.cases.map(c => c.case_id).join() === 'c1,r1' && run.cases[0].prompt.sha256 === firstPreview.cases[0].prompt.sha256);
  check('the run shows no score until a case is scored', run.score.value === null && run.score.scored === 0 && run.score.total === 2 && run.score.complete === false);
  const replay = await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`key-${token}`, firstPreview.preview_id, firstSetup)});
  check('the same idempotency key returns the original run', replay.status === 200 && replay.body.replayed === true && replay.body.run.run_id === run.run_id);
  check('the same key with another request is refused',
    (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`key-${token}`, firstPreview.preview_id, {...firstSetup, policy: 'task_tools'})})).body.code === 'idempotency_conflict');
  check('the run holds the pinned prompts, never private references', !JSON.stringify(run).includes(SECRET));
  const stale = await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`stale-${token}`, firstPreview.preview_id, {...firstSetup, policy: 'task_tools'})});
  check('a run that no longer resolves to its preview is stale, naming what changed and showing the current setup',
    stale.status === 409 && stale.body.code === 'stale_preview' && stale.body.stale.includes('prompt') && stale.body.stale.includes('policy') && stale.body.current.policy === 'task_tools');
  const missing = await Promise.all(['benchmark_id', 'policy', 'preview_id', 'source_sha256', 'idempotency_key']
    .map(async field => (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: {...runBody(`k-${token}`, firstPreview.preview_id, firstSetup), [field]: undefined}})).status));
  check('a run takes exactly a benchmark, policy, preview, source and key: all five are required and any other field is refused', missing.every(status => status === 400)
    && (await Promise.all([{model: 'm'}, {dialects: ['responses']}, {limits: {}}, {prompt: {}}, {selection: {}}, {endpoint_profile: LABEL}]
      .map(async extra => (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: {...runBody(`k-${token}`, firstPreview.preview_id, firstSetup), ...extra}})).body.code))).every(code => code === 'invalid_request'));
  check('a run needs a benchmark that exists, a source it has and a preview it made',
    (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`k-${token}`, firstPreview.preview_id, {...firstSetup, benchmark_id: crypto.randomUUID()})})).body.code === 'unknown_benchmark'
    && (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: {...runBody(`k-${token}`, firstPreview.preview_id, firstSetup), source_sha256: 'e'.repeat(64)}})).body.code === 'unknown_source'
    && (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`k-${token}`, '00000000-0000-4000-8000-000000000000', firstSetup)})).body.code === 'unknown_preview'
    && (await api(`${base}/runs`, {method: 'POST', cookie: bob.cookie, body: runBody(`k-${token}`, firstPreview.preview_id, firstSetup)})).status === 404);
  const runs = (await api(`${base}/runs`, {cookie: alice.cookie})).body.runs;
  const listedRun = runs.find(entry => entry.run_id === run.run_id);
  check('the member lists their runs as run summaries',
    JSON.stringify(Object.keys(listedRun).sort()) === JSON.stringify(['benchmark', 'created_at', 'harness', 'metrics', 'model', 'plugin', 'policy', 'run_id', 'score', 'status', 'user'])
    && listedRun.harness.name === 'my-harness' && listedRun.harness.version === '1' && listedRun.benchmark.name === mainName && listedRun.plugin.id === pluginId && listedRun.plugin.version === '1.0.0'
    && listedRun.model === 'mock/model' && listedRun.policy === 'coding' && listedRun.user.id === alice.id && listedRun.status === 'queued'
    && listedRun.metrics.total_tokens.total === 0 && listedRun.metrics.elapsed_ms.missing_attempts === 2);

  // ── Results, stats and visibility ──
  const sharedRun = async (member, key, benchmark = shared, policy = 'coding', sourceOf = source) => {
    const body = {benchmark_id: benchmark.benchmark_id, policy};
    const made = (await preview(benchmark.benchmark_id, policy, member)).body;
    const result = await api(`${base}/runs`, {method: 'POST', cookie: member.cookie, body: {...body, idempotency_key: key, preview_id: made.preview_id, source_sha256: sourceOf.source_sha256}});
    assert.equal(result.status, 201, result.text);
    return result.body.run;
  };
  const aliceShared1 = await sharedRun(alice, `shared-a1-${token}`);
  const aliceShared2 = await sharedRun(alice, `shared-a2-${token}`, shared, 'task_tools');
  await claim('wb-shared', {label: SHARED, token: credentials.bob});
  const bobShared = await sharedRun(bob, `shared-b1-${token}`, shared, 'coding', bobsSource);
  const shared2Run = await sharedRun(alice, `shared-a3-${token}`, shared2);
  const carolBase = `/api/workspaces/${w2.id}/benchmark`;
  const carolRefused = await publish(carol, publication(`carol-${token}`, ['c1']));
  check('a member with no worker running cannot publish, and is told to start RUSH Lab with Docker running',
    carolRefused.status === 409 && carolRefused.body.code === 'worker_unavailable' && /start RUSH Lab with Docker running/.test(carolRefused.body.error)
    && (await api(`${carolBase}/previews`, {method: 'POST', cookie: carol.cookie, body: {benchmark_id: shared.benchmark_id, policy: 'coding'}})).body.code === 'worker_unavailable');
  check('a second member\'s worker never claims the first member\'s run, though its capabilities fit and the runs are queued',
    (await claim('wc', {label: SHARED, token: credentials.carol})).status === 204
    && (await asSystem("select count(*)::int as n from benchmark_attempt where worker_id = 'wc'")).rows[0].n === 0
    && (await asSystem("select count(*)::int as n from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id where a.state = 'queued' and r.user_id = $1 and r.endpoint_label = $2", [alice.id, SHARED])).rows[0].n > 0);
  const statsOf = async id => (await api(`${carolBase}/benchmarks/${id}`, {cookie: carol.cookie})).body.benchmark;
  const sharedStats = await statsOf(shared.benchmark_id);
  check('a benchmark counts every member\'s runs and its distinct runners', sharedStats.run_count === 3 && sharedStats.runner_count === 2);
  check('runs of another plugin version are absent from a benchmark\'s counts', (await statsOf(shared2.benchmark_id)).run_count === 1 && (await statsOf(shared2.benchmark_id)).runner_count === 1
    && (await statsOf(mainId)).run_count === 1);
  const results = (await api(`${base}/benchmarks/${shared.benchmark_id}/results`, {cookie: alice.cookie})).body.runs;
  const bobsRow = results.find(entry => entry.run_id === bobShared.run_id);
  check('a member sees every member\'s runs of a benchmark as run summaries, newest first, with who ran them',
    results.map(entry => entry.run_id).join() === [bobShared.run_id, aliceShared2.run_id, aliceShared1.run_id].join()
    && bobsRow.user.id === bob.id && bobsRow.user.name === 'bob' && bobsRow.user.github === github.bob.login && bobsRow.harness.name === 'my-harness' && bobsRow.benchmark.name === `shared-${token}`
    && bobsRow.plugin.version === '1.0.0' && bobsRow.policy === 'coding' && results.find(entry => entry.run_id === aliceShared2.run_id).policy === 'task_tools'
    && results.every(entry => !results.some(other => other !== entry && other.run_id === entry.run_id)));
  check('a results row has the summary\'s fields and nothing else: no source sha256, no evidence, no workspace',
    results.every(entry => JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['benchmark', 'created_at', 'harness', 'metrics', 'model', 'plugin', 'policy', 'run_id', 'score', 'status', 'user']))
    && !JSON.stringify(results).includes(source.source_sha256) && !JSON.stringify(results).includes(bobsSource.source_sha256) && !JSON.stringify(results).includes(w1.id));
  check('results page by time and size', (await api(`${base}/benchmarks/${shared.benchmark_id}/results?limit=1`, {cookie: alice.cookie})).body.runs.length === 1
    && (await api(`${base}/benchmarks/${shared.benchmark_id}/results?before=${encodeURIComponent(bobsRow.created_at)}`, {cookie: alice.cookie})).body.runs.length === 2
    && (await api(`${base}/benchmarks/${shared.benchmark_id}/results?limit=0`, {cookie: alice.cookie})).status === 400
    && (await api(`${base}/benchmarks/${shared.benchmark_id}/results?before=x`, {cookie: alice.cookie})).status === 400);
  check('another workspace\'s member reads the same results',
    (await api(`/api/workspaces/${w2.id}/benchmark/benchmarks/${shared.benchmark_id}/results`, {cookie: carol.cookie})).body.runs.length === 3);
  check('runs of another plugin version are absent from its results',
    (await api(`${carolBase}/benchmarks/${shared2.benchmark_id}/results`, {cookie: carol.cookie})).body.runs.map(entry => entry.run_id).join() === shared2Run.run_id
    && !results.some(entry => entry.run_id === shared2Run.run_id));
  const aliceShared1Attempts = aliceShared1.cases.map(c => c.attempts[0].attempt_id);
  check('another member\'s row opens nothing: its run, attempts, events, spans, payloads, accounting, cancel and rerun answer 404',
    (await api(`${base}/runs/${aliceShared1.run_id}`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${aliceShared1Attempts[0]}`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${aliceShared1Attempts[0]}/events`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${aliceShared1Attempts[0]}/spans`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${aliceShared1Attempts[0]}/accounting`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${aliceShared1Attempts[0]}/payloads/${'a'.repeat(64)}`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/runs/${aliceShared1.run_id}/cancel`, {method: 'POST', cookie: bob.cookie})).status === 404
    && (await api(`${base}/runs/${aliceShared1.run_id}/cases/c1/rerun`, {method: 'POST', cookie: bob.cookie, body: {}})).status === 404
    && (await api(`${base}/compare?a=${aliceShared1.run_id}&b=${bobShared.run_id}`, {cookie: bob.cookie})).status === 404);
  check('a member\'s own run list holds only their own runs',
    (await api(`${base}/runs`, {cookie: bob.cookie})).body.runs.map(entry => entry.run_id).join() === bobShared.run_id
    && !(await api(`${base}/runs`, {cookie: alice.cookie})).body.runs.some(entry => entry.run_id === bobShared.run_id));
  check('benchmark_run stays owner-only to the runtime role: a member reads their rows, and the definer functions give the rest',
    (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select user_id from benchmark_run')).rows.every(row => row.user_id === bob.id)
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select run_id from benchmark_run where run_id = $1', [aliceShared1.run_id])).rowCount === 0
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select run_id from benchmark_results($1, 10, null)', [shared.benchmark_id])).rowCount === 3
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select * from benchmark_stats($1)', [shared.benchmark_id])).rows[0].run_count === '3'
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select run_id from benchmark_run where run_id = $1', [aliceShared1.run_id])).rowCount === 0);
  check('the other members\' attempts and evidence stay hidden from the runtime role too',
    (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_attempt where run_id = $1', [aliceShared1.run_id])).rowCount === 0
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_run_summary where run_id = $1', [aliceShared1.run_id])).rowCount === 0);

  // Isolation: another member of the workspace, and another workspace.
  const attempts = run.cases.map(c => c.attempts[0].attempt_id);
  check('another member of the workspace cannot open, or search a run',
    (await api(`${base}/runs`, {cookie: bob.cookie})).body.runs.every(entry => entry.run_id !== run.run_id)
    && (await api(`${base}/runs/${run.run_id}`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${attempts[0]}`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${attempts[0]}/spans?q=a`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${attempts[0]}/events`, {cookie: bob.cookie})).status === 404
    && (await api(`${base}/attempts/${attempts[0]}/stream`, {cookie: bob.cookie})).status === 404);
  check('a member of another workspace cannot reach the workspace or its run',
    (await api(`${base}/runs/${run.run_id}`, {cookie: carol.cookie})).status === 404
    && (await api(`/api/workspaces/${w2.id}/benchmark/runs/${run.run_id}`, {cookie: carol.cookie})).status === 404
    && (await api(`/api/workspaces/${w2.id}/benchmark/attempts/${attempts[0]}`, {cookie: carol.cookie})).status === 404);
  check('another member cannot cancel or rerun a run',
    (await api(`${base}/runs/${run.run_id}/cancel`, {method: 'POST', cookie: bob.cookie})).status === 404
    && (await api(`${base}/runs/${run.run_id}/cases/c1/rerun`, {method: 'POST', cookie: bob.cookie, body: {}})).status === 404);

  // ── Claiming ──
  const none = await claim('w1', {label: `other-${token}`});
  check('a worker claims only runs for its endpoint profile', none.status === 204);
  const first = (await claim()).body;
  check('a claimed attempt carries its policy, limits, task, case, prompt, plugin and private reference',
    first.kind === 'attempt' && first.fence === 1 && first.private_reference.note === SECRET
    && first.run.policy === 'coding' && first.run.limits.max_model_calls === 3 && first.run.limits.internet_access === true && first.run.limits.pids === 256
    && first.run.model === 'mock/model' && first.run.endpoint_profile === LABEL && first.run.source_sha256 === source.source_sha256 && first.run.prompt_source === 'benchmark' && first.run.dialects.join() === 'chat_completions'
    && first.task.id === 'sum' && first.task.kind === 'agent' && first.task.plugin_name === 'Bench plugin' && first.task.description === 'Add the numbers'
    && first.task.instructions === 'Add the numbers.\nBe exact.' && first.task.tools[0].name === 'read' && first.task.egress_hosts.join() === 'api.example.com'
    && first.case.case_id === 'c1' && first.case.kind === 'answer' && first.case.context === 'Résumé: sums' && first.case.input_schema.type === 'object'
    && first.case.output_schema.properties.sum.type === 'number' && first.case.content_digest === run.cases[0].content_digest
    && first.prompt.system === null && first.prompt.user === run.cases[0].prompt.user && first.prompt.sha256 === run.cases[0].prompt.sha256
    && first.plugin.sha256 === sha && first.case_set.digest === run.case_set.digest);
  const second = (await claim('w2')).body;
  check('the next claim leases the next attempt', second.case.case_id === 'r1' && second.case.kind === 'refuse' && (await claim('w3')).status === 204);
  const fenceHeader = fence => ({'x-rush-fence': String(fence)});
  const a1 = first.attempt_id;
  const sourceBytes = await worker(`attempts/${a1}/source`, {headers: fenceHeader(first.fence)});
  const packageBytes = await worker(`attempts/${a1}/package`, {headers: fenceHeader(first.fence)});
  check('a fenced worker downloads the source and the package', sha256(sourceBytes.body) === source.source_sha256 && sha256(packageBytes.body) === sha);
  check('a wrong fence cannot download or renew',
    (await worker(`attempts/${a1}/source`, {headers: fenceHeader(7)})).body.code === 'lease_lost'
    && (await worker(`attempts/${a1}/renew`, {method: 'POST', body: {fence: 7}})).body.code === 'lease_lost');
  check('a lease renews', (await worker(`attempts/${a1}/renew`, {method: 'POST', body: {fence: first.fence}})).status === 200);

  // A task tools run, and a run another worker can only claim within its capabilities.
  const inetRun = await sharedRun(alice, `inet-${token}`, single);
  const toolsRun = await sharedRun(alice, `tools-${token}`, withTools, 'task_tools');
  check('a task tools run pins its instructions and a system and user prompt per case',
    toolsRun.policy === 'task_tools' && toolsRun.prompt.source === 'benchmark' && toolsRun.prompt.text === 'Use read first.' && toolsRun.limits.internet_access === false
    && toolsRun.unverified_egress === false && toolsRun.egress_hosts.join() === 'api.example.com' && run.egress_hosts === null && toolsRun.cases.every(c => c.prompt.system.includes('Use read first.') && c.prompt.user.startsWith('Task input:\n')));
  const noInternet = {...CAPS, internet_access: false};
  const offline = await claim('offline', {capabilities: noInternet});
  check('a worker that cannot give internet access is handed no run that wants it, only the run that does not',
    offline.status === 200 && offline.body.run.run_id === toolsRun.run_id && offline.body.run.policy === 'task_tools' && offline.body.run.limits.internet_access === false
    && offline.body.task.instructions === 'Use read first.' && offline.body.prompt.system === toolsRun.cases[0].prompt.system && offline.body.prompt.user === toolsRun.cases[0].prompt.user);
  await worker(`attempts/${offline.body.attempt_id}/finalize`, {method: 'POST', body: {fence: 1, execution: {status: 'execution_failed', reason: 'harness_failed'}, verdict: 'fail', coverage: {}, metrics: {}, final_cursor_expected: 0}});
  const afterOne = await claim('offline-3', {capabilities: noInternet});
  check('the next attempt of that run is claimable once the first has ended', afterOne.status === 200 && afterOne.body.run.run_id === toolsRun.run_id && afterOne.body.case.case_id === 'r1');
  await worker(`attempts/${afterOne.body.attempt_id}/finalize`, {method: 'POST', body: {fence: 1, execution: {status: 'canceled'}, coverage: {}, metrics: {}, final_cursor_expected: 0}});
  check('a task tools run is scored from its verdicts only: failed cases count, canceled ones do not',
    (await api(`${base}/runs/${toolsRun.run_id}`, {cookie: alice.cookie})).body.run.score.scored === 1);

  await api(`${base}/runs/${inetRun.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});

  // ── Spend ──
  const admit = (id, fence, call, reserve) => worker(`attempts/${id}/admissions`, {method: 'POST', body: {fence, call_id: call, reserve_usd: reserve}});
  check('a call is admitted with a reservation', (await admit(a1, 1, 'call-1', 0.4)).status === 201);
  check('a duplicate call id is refused', (await admit(a1, 1, 'call-1', 0.4)).body.code === 'duplicate_call');
  check('a second call fits', (await admit(a1, 1, 'call-2', 0.4)).status === 201);
  const over = await admit(a1, 1, 'call-3', 1.0);
  check('the attempt\'s cost budget (the run\'s max_cost_usd) refuses a call past it', over.status === 402 && over.body.code === 'budget_exhausted' && over.body.scope === 'attempt');
  const settle = (id, call, body) => worker(`attempts/${id}/admissions/${call}/settle`, {method: 'POST', body});
  check('a call settles at its cost, and again the same way', (await settle(a1, 'call-1', {outcome: 'settled', cost_usd: 0.1, provenance: {source: 'usage'}})).status === 200
    && (await settle(a1, 'call-1', {outcome: 'settled', cost_usd: 0.1, provenance: {source: 'usage'}})).status === 200);
  check('a settled call settles no differently', (await settle(a1, 'call-1', {outcome: 'settled', cost_usd: 0.2, provenance: {}})).body.code === 'already_settled');
  check('an uncertain call keeps its reservation', (await settle(a1, 'call-2', {outcome: 'uncertain', provenance: {reason: 'disconnect'}})).body.status === 'uncertain');
  const spent = async () => Number((await asSystem(
    "select committed_usd::float8 as c from benchmark_budget where scope_kind = 'member' and scope_id = $1", [alice.id])).rows[0].c);
  check('the member\'s committed spend is the settled cost plus the uncertain reservation', Math.abs(await spent() - 0.5) < 1e-9);
  const a2 = second.attempt_id;
  check('another attempt fits under the member cap', (await admit(a2, 1, 'call-a', 0.9)).status === 201);
  const memberOver = await admit(a2, 1, 'call-b', 0.2);
  check('the member\'s budget refuses a call past it', memberOver.status === 402 && memberOver.body.scope === 'member');
  const racers = await Promise.all([1, 2, 3, 4].map(n => admit(a2, 1, `race-${n}`, 0.04)));
  check('concurrent admissions never overspend the member', racers.filter(r => r.status === 201).length === 2 && Math.abs(await spent() - 1.48) < 1e-9);
  const spentBefore = await spent();
  check('a settlement far past the call\'s reserve is refused, and one past the column\'s range is a 400, not a 500',
    (await settle(a2, 'race-1', {outcome: 'settled', cost_usd: 1000, provenance: {}})).body.code === 'cost_exceeds_reserve'
    && (await settle(a2, 'race-1', {outcome: 'settled', cost_usd: 1e13, provenance: {}})).status === 400
    && (await admit(a2, 1, 'huge', 1e13)).status === 400 && (await admit(a2, 2 ** 40, 'huge', 0.01)).status === 400
    && Math.abs(await spent() - spentBefore) < 1e-9);
  check('a settlement at the call\'s reserve is accepted', (await settle(a2, 'race-1', {outcome: 'settled', cost_usd: 0.04, provenance: {}})).status === 200);
  const callsRun = (await api(`${base}/attempts/${a1}`, {cookie: alice.cookie})).body.attempt;
  check('an attempt shows its case kind, content digest and rendered prompt', callsRun.kind === 'answer' && callsRun.content_digest === run.cases[0].content_digest && callsRun.prompt.sha256 === run.cases[0].prompt.sha256);

  // ── Evidence ──
  const event = (id, sequence, extra = {}) => ({event_id: id, source: 'gateway', kind: 'model_call', sequence, occurred_ns: '1700000000123456789', data: {n: sequence, text: 'é'}, ...extra});
  const post = (id, fence, events) => worker(`attempts/${id}/events`, {method: 'POST', body: {fence, events}});
  const appended = await post(a1, 1, [event('e1', 1), event('e2', 2)]);
  check('events get serial cursors', appended.body.receipts.map(r => r.cursor).join() === '1,2' && appended.body.high_water_cursor === 2);
  const retried = await post(a1, 1, [event('e2', 2), event('e3', 3)]);
  check('an identical retry gets the same cursor', retried.body.receipts.map(r => `${r.cursor}${r.duplicate ? 'd' : ''}`).join() === '2d,3');
  check('a conflicting duplicate is refused', (await post(a1, 1, [event('e1', 1, {data: {n: 99}})])).body.code === 'conflicting_duplicate');
  check('events from a stale fence are refused', (await post(a1, 9, [event('e9', 9)])).body.code === 'lease_lost');
  const payload = Buffer.from('{"prompt":"hi"}');
  const payloadSha = sha256(payload);
  const put = (id, digest, data, headers = {}) => worker(`attempts/${id}/payloads/${digest}`, {method: 'PUT', raw: data, headers: {'x-rush-fence': '1', 'x-rush-redaction': 'redacted', 'content-type': 'application/json', ...headers}});
  check('a payload is stored when its bytes hash to its digest', (await put(a1, payloadSha, payload)).body.created === true);
  check('a payload that does not hash to its digest is refused', (await put(a1, sha256('other'), payload)).body.code === 'digest_mismatch');
  const spans = await worker(`attempts/${a1}/spans`, {method: 'POST', body: {fence: 1, spans: [
    {id: 'root', kind: 'agent', name: 'harness', start_ns: '1700000000000000000', provenance: 'harness'},
    {id: 's1', kind: 'tool', name: 'read-file', parent: 'root', status: 'ok', target: '/rush/workspace/config.yaml', start_ns: '1700000000100000000', end_ns: '1700000000200000000'},
  ], links: [{kind: 'caused_by', from: 's1', to: 'root', method: 'broker'}]}});
  check('spans and links are indexed', spans.body.spans === 2 && spans.body.links === 1);
  const events = (await api(`${base}/attempts/${a1}/events?after=1&limit=10`, {cookie: alice.cookie})).body;
  check('events replay after a cursor, in order', events.events.map(e => e.cursor).join() === '2,3' && events.events[0].data.text === 'é' && events.events[0].occurred_ns === '1700000000123456789' && !events.sealed);
  check('the span index is searchable',
    (await api(`${base}/attempts/${a1}/spans?kind=tool&q=config`, {cookie: alice.cookie})).body.spans.length === 1
    && (await api(`${base}/attempts/${a1}/spans?status=nothing`, {cookie: alice.cookie})).body.spans.length === 0
    && (await api(`${base}/attempts/${a1}/spans`, {cookie: alice.cookie})).body.links.length === 1);
  const download = await api(`${base}/attempts/${a1}/payloads/${payloadSha}`, {cookie: alice.cookie});
  check('the member downloads a payload with its redaction status', download.text === payload.toString() && download.headers.get('x-rush-redaction') === 'redacted');
  check('another member cannot download it', (await api(`${base}/attempts/${a1}/payloads/${payloadSha}`, {cookie: bob.cookie})).status === 404);

  // Live stream of the second attempt: it ends when the attempt seals.
  const live = fetch(`${origin}${base}/attempts/${a2}/stream?after=0`, {headers: {cookie: alice.cookie, 'x-real-ip': clientIp}}).then(async response => {
    let text = '';
    for await (const chunk of response.body) text += Buffer.from(chunk).toString();
    return text;
  });
  await sleep(500);
  await post(a2, 1, [event('l1', 1)]);
  await sleep(400);
  const finalizeBody = (cursor, extra = {}) => ({
    fence: 1, execution: {status: 'answered'}, verdict: 'pass', coverage: {status: 'complete'}, metrics: {total_tokens: 10, input_tokens: 6, output_tokens: 4, elapsed_ms: 100},
    final_cursor_expected: cursor, ...extra,
  });
  const finalize = (id, body) => worker(`attempts/${id}/finalize`, {method: 'POST', body});
  const a2done = await finalize(a2, finalizeBody(1, {execution: {status: 'refused'}}));
  const streamed = await live;
  check('a live stream emits committed events, then sealed with the final cursor',
    streamed.includes('id: 1\nevent: event') && streamed.includes('event: sealed\ndata: {"final_cursor":1}') && a2done.body.sealed === true);

  const premature = await finalize(a1, finalizeBody(2));
  check('finalizing at the wrong cursor is refused with the high-water mark', premature.body.code === 'cursor_mismatch' && premature.body.high_water_cursor === 3);
  check('a verdict other than pass or fail is refused', (await finalize(a1, finalizeBody(3, {verdict: 'correct'}))).body.code === 'invalid_request');
  check('an explanation is one of the verifier\'s codes and comes only with a fail', (await finalize(a1, finalizeBody(3, {verdict: 'fail', explanation: 'because'}))).body.code === 'invalid_request'
    && (await finalize(a1, finalizeBody(3, {verdict: 'pass', explanation: 'invalid_answer'}))).body.code === 'invalid_request');
  check('a canceled attempt carries no verdict', (await finalize(a1, finalizeBody(3, {execution: {status: 'canceled'}}))).body.code === 'verdict_not_allowed');
  const sealed = await finalize(a1, finalizeBody(3, {verdict: 'fail', explanation: 'invalid_answer'}));
  check('finalizing seals the attempt at its high-water mark', sealed.body.final_cursor === 3 && sealed.body.sealed && sealed.body.scoring_id === undefined);
  check('events after the seal are refused', (await post(a1, 1, [event('late', 9)])).body.code === 'sealed');
  check('a retried finalize answers the same', (await finalize(a1, finalizeBody(3, {verdict: 'fail', explanation: 'invalid_answer'}))).body.replayed === true);
  check('a different finalize is a conflicting duplicate', (await finalize(a1, finalizeBody(3, {verdict: 'pass'}))).body.code === 'conflicting_duplicate');
  check('accounting is accepted after the seal and versioned', (await worker(`attempts/${a1}/accounting`, {method: 'POST', body: {call_id: 'call-1', version: 1, record: {cost_usd: 0.1, generation_id: 'gen-1'}}})).body.created === true
    && (await worker(`attempts/${a1}/accounting`, {method: 'POST', body: {call_id: 'call-1', version: 1, record: {cost_usd: 0.3}}})).body.code === 'conflicting_duplicate'
    && (await worker(`attempts/${a1}/accounting`, {method: 'POST', body: {call_id: 'call-1', version: 2, record: {cost_usd: 0.1, generation_id: 'gen-1', provider: 'x'}}})).body.created === true);
  const accounting = (await api(`${base}/attempts/${a1}/accounting`, {cookie: alice.cookie})).body;
  check('the member reads the latest accounting beside each admission',
    accounting.calls.find(c => c.call_id === 'call-1').accounting.version === 2 && accounting.totals.uncertain_calls === 1 && accounting.calls.length === 2);
  check('events were not rewritten by accounting', (await api(`${base}/attempts/${a1}/events`, {cookie: alice.cookie})).body.events.length === 3);
  check('accounting is bounded: a record past its byte limit is 413 and a version past the limit is 400',
    (await worker(`attempts/${a1}/accounting`, {method: 'POST', body: {call_id: 'call-1', version: 3, record: {pad: 'x'.repeat(70_000)}}})).status === 413
    && (await worker(`attempts/${a1}/accounting`, {method: 'POST', body: {call_id: 'call-1', version: 11, record: {}}})).status === 400);
  const sealedStream = (await api(`${base}/attempts/${a1}/stream?after=2`, {cookie: alice.cookie})).text;
  check('a sealed attempt streams what is left and ends', sealedStream.includes('id: 3') && sealedStream.includes('event: sealed') && !sealedStream.includes('id: 2\n'));

  // ── Score ──
  let view = (await api(`${base}/runs/${run.run_id}`, {cookie: alice.cookie})).body.run;
  const c1 = view.cases[0].attempts[0];
  check('the run scores passed over scored: one pass of two scored cases',
    view.score.value === 0.5 && view.score.passed === 1 && view.score.scored === 2 && view.score.total === 2 && view.score.complete === true && view.status === 'complete');
  check('the run shows each verdict with its explanation, coverage and metrics, and no scale',
    c1.verdict === 'fail' && c1.verifier_error === null && c1.coverage.status === 'complete' && view.metrics.total_tokens.total === 20 && c1.explanation === 'invalid_answer' && !('scale' in view));
  check('no member response carries a private reference', !JSON.stringify(view).includes(SECRET));
  const summary = (await api(`${base}/runs`, {cookie: alice.cookie})).body.runs.find(entry => entry.run_id === run.run_id);
  const summaryInResults = (await api(`${base}/benchmarks/${mainId}/results`, {cookie: bob.cookie})).body.runs.find(entry => entry.run_id === run.run_id);
  check('a run\'s summary, in the list and in everyone\'s results, equals its detail: status, score and metric sums, with total tokens and elapsed time from the attempts',
    JSON.stringify(summary.score) === JSON.stringify(view.score) && summary.status === view.status && JSON.stringify(summary.metrics.total_tokens) === JSON.stringify(view.metrics.total_tokens)
    && JSON.stringify(summary.metrics.elapsed_ms) === JSON.stringify(view.metrics.elapsed_ms) && summary.metrics.total_tokens.total === 20 && summary.metrics.elapsed_ms.total === 200
    && JSON.stringify(summaryInResults) === JSON.stringify(summary));

  // ── Rerun, verifier errors, uninstall ──
  await uninstall(alice, pluginId);
  const rerun = await api(`${base}/runs/${run.run_id}/cases/c1/rerun`, {method: 'POST', cookie: alice.cookie, body: {}});
  check('a rerun works after the plugin is uninstalled and makes a new attempt', rerun.status === 201 && rerun.body.attempt_no === 2);
  check('a case with an attempt in flight takes no rerun', (await api(`${base}/runs/${run.run_id}/cases/c1/rerun`, {method: 'POST', cookie: alice.cookie, body: {}})).body.code === 'attempt_active');
  check('a case the run does not have takes no rerun', (await api(`${base}/runs/${run.run_id}/cases/zz/rerun`, {method: 'POST', cookie: alice.cookie, body: {}})).body.code === 'unknown_case');
  const rerunJob = (await claim()).body;
  check('the rerun attempt is claimable with the retained artifacts', rerunJob.attempt_id === rerun.body.attempt_id && rerunJob.fence === 1
    && sha256((await worker(`attempts/${rerunJob.attempt_id}/package`, {headers: fenceHeader(1)})).body) === sha);
  const rerunDone = await finalize(rerunJob.attempt_id, finalizeBody(0, {verdict: undefined, verifier_error: 'verifier crashed: secret detail'}));
  check('a verifier error finalizes with no verdict', rerunDone.status === 200);
  view = (await api(`${base}/runs/${run.run_id}`, {cookie: alice.cookie})).body.run;
  check('a case whose newest attempt hit a verifier error is left out of the score',
    view.score.scored === 1 && view.score.passed === 1 && view.score.value === 1 && view.score.verifier_errors === 1 && view.score.unscored === 1
    && view.cases[0].attempts[1].verifier_error.includes('verifier crashed') && view.cases[0].latest_attempt_id === rerunJob.attempt_id);
  const rerun2 = await api(`${base}/runs/${run.run_id}/cases/c1/rerun`, {method: 'POST', cookie: alice.cookie, body: {}});
  const rerunJob2 = (await claim()).body;
  await finalize(rerunJob2.attempt_id, finalizeBody(0));
  view = (await api(`${base}/runs/${run.run_id}`, {cookie: alice.cookie})).body.run;
  check('a rerun that passes replaces the earlier verdict in the score', rerun2.body.attempt_no === 3 && view.score.passed === 2 && view.score.scored === 2 && view.score.value === 1);

  // ── Compare ──
  const sealedAttempts = await api(`${base}/compare/attempts?a=${a1}&b=${rerunJob2.attempt_id}`, {cookie: alice.cookie});
  check('two sealed attempts of one pinned case compare through NanoAgent, with the case\'s content digest in the header',
    sealedAttempts.status === 200 && sealedAttempts.body.header.case.content_digest === run.cases[0].content_digest && sealedAttempts.body.header.case.package_sha256 === sha);
  const compared = await api(`${base}/compare?a=${run.run_id}&b=${toolsRun.run_id}`, {cookie: alice.cookie});
  check('two runs of one verifier compare: cases aligned by content, configuration and prompt differences, and unverified egress',
    compared.status === 200 && compared.body.verifier.package_sha256 === sha && compared.body.shared.length === 2 && compared.body.only_a.length === 0 && compared.body.only_b.length === 0
    && compared.body.shared[0].a.case_id === 'c1' && compared.body.shared[1].a.verdict === 'pass'
    && ['policy', 'benchmark_id', 'limits.internet_access'].every(field => compared.body.differences.includes(field))
    && !compared.body.differences.includes('case_set_id') && compared.body.unverified_egress.a === true && compared.body.unverified_egress.b === false
    && compared.body.prompt_diff.a_kind === 'template' && compared.body.prompt_diff.b_kind === 'instructions' && compared.body.prompt_diff.text.some(part => part.type !== 'same')
    && compared.body.prompt_diff.rendered.every(entry => entry.identical === false));
  const attemptView = (await api(`${base}/attempts/${a1}`, {cookie: alice.cookie})).body.attempt;
  check('a sealed attempt shows its verdict explanation', attemptView.verdict === 'fail' && attemptView.explanation === 'invalid_answer');
  // a1 has one settled call and one uncertain one: its cost is unknown (null), with the uncertain call counted, never the sum with a reserve.
  const cost = (await asSystem(
    `select count(*) filter (where d.status = 'uncertain')::int as uncertain_calls,
       case when bool_and(d.status = 'settled' and d.cost_usd is not null) then sum(d.cost_usd)::float8 end as cost_usd
       from benchmark_admission d where d.attempt_id = $1`, [a1])).rows[0];
  check('an attempt with an uncertain call has a null cost and the uncertain count (the compare query)', cost.cost_usd === null && cost.uncertain_calls === 1);
  const crossRun = await sharedRun(alice, `cross-${token}`, cross);
  const differentSelection = (await api(`${base}/compare?a=${run.run_id}&b=${crossRun.run_id}`, {cookie: alice.cookie})).body;
  check('runs with different selections list the cases only one ran', differentSelection.shared.map(c => c.a.case_id).join() === 'c1' && differentSelection.only_a.map(c => c.case_id).join() === 'r1'
    && differentSelection.only_b.map(c => c.case_id).join() === 'c2' && differentSelection.differences.includes('selection') && differentSelection.differences.includes('case_set_id'));
  const otherRun = await sharedRun(alice, `otherrun-${token}`, otherPlugin);
  const notSame = await api(`${base}/compare?a=${run.run_id}&b=${otherRun.run_id}`, {cookie: alice.cookie});
  check('runs of another plugin package are not comparable', notSame.status === 409 && notSame.body.code === 'not_same_verifier' && notSame.body.differing.includes('package_sha256'));
  const versions = await api(`${base}/compare?a=${run.run_id}&b=${shared2Run.run_id}`, {cookie: alice.cookie});
  check('runs of two plugin versions with different packages are not comparable, and two runs of one benchmark are',
    versions.status === 409 && versions.body.code === 'not_same_verifier' && versions.body.differing.includes('package_sha256')
    && (await api(`${base}/compare?a=${aliceShared1.run_id}&b=${aliceShared2.run_id}`, {cookie: alice.cookie})).status === 200);
  check('another member cannot compare a run they cannot see', (await api(`${base}/compare?a=${run.run_id}&b=${toolsRun.run_id}`, {cookie: bob.cookie})).status === 404);
  await api(`${base}/runs/${otherRun.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  await api(`${base}/runs/${crossRun.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});

  // ── Lease expiry, cancel ──
  await install(alice, pluginId);
  const newRun = async (key, benchmark = main.body.benchmark) => {
    const body = {benchmark_id: benchmark.benchmark_id, policy: 'coding'};
    const made = (await preview(benchmark.benchmark_id)).body;
    return {body, preview: made, run: (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(key, made.preview_id, body)})).body.run};
  };
  const run2 = (await newRun(`key2-${token}`)).run;
  const leased = (await claim('slow')).body;
  await admit(leased.attempt_id, 1, 'swept', 0.01);
  await asSystem("update benchmark_attempt set lease_expires_at = now() - interval '1 minute' where attempt_id = $1", [leased.attempt_id]);
  await asSystem("update benchmark_admission set deadline_at = now() - interval '1 second' where call_id = 'call-2'");
  const next = await claim('fast');
  const expired = (await api(`${base}/attempts/${leased.attempt_id}`, {cookie: alice.cookie})).body.attempt;
  check('an expired lease interrupts the attempt and keeps its evidence', expired.state === 'final' && expired.execution.status === 'interrupted' && expired.sealed);
  check('the worker that lost its lease is refused', (await post(leased.attempt_id, 1, [event('z', 1)])).body.code === 'lease_lost');
  const swept = (await asSystem("select status, cost_usd::float8 as cost from benchmark_admission where call_id = 'call-2'")).rows[0];
  check('an overdue uncertain reservation settles at its reserved bound', swept.status === 'settled' && Math.abs(swept.cost - 0.4) < 1e-9);
  check('settlement is still accepted after the lease is lost', (await settle(leased.attempt_id, 'swept', {outcome: 'settled', cost_usd: 0.01, provenance: {}})).status === 200);
  const interruptedRerun = await api(`${base}/runs/${run2.run_id}/cases/${expired.case_id}/rerun`, {method: 'POST', cookie: alice.cookie, body: {}});
  check('an interrupted attempt needs a rerun with a new attempt', interruptedRerun.status === 201 && interruptedRerun.body.attempt_no === 2);
  const canceled = await api(`${base}/runs/${run2.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  check('canceling ends queued attempts and signals leased ones', canceled.status === 200 && canceled.body.canceled_attempts >= 1 && canceled.body.signaled_attempts === 1 && next.status === 200);
  check('a leased attempt learns of the cancel at renewal and admission',
    (await worker(`attempts/${next.body.attempt_id}/renew`, {method: 'POST', body: {fence: next.body.fence}})).body.code === 'canceled'
    && (await admit(next.body.attempt_id, next.body.fence, 'after-cancel', 0.01)).body.code === 'canceled');
  check('a canceled run queues nothing more', (await claim('after')).status === 204
    && (await api(`${base}/runs/${run2.run_id}/cases/r1/rerun`, {method: 'POST', cookie: alice.cookie, body: {}})).body.code === 'run_canceled');

  // ── Expiry sweep: no claim, no worker call ──
  const third = await newRun(`key4-${token}`);
  const run3 = third.run;
  const stalled = (await claim('stalled')).body;
  const renewing = (await claim('renewing')).body;
  check('both attempts of the run are leased', stalled.attempt_id && renewing.attempt_id && stalled.lease_seconds === 30 && renewing.lease_seconds === 30);
  check('a renewal tells the worker the lease length', (await worker(`attempts/${renewing.attempt_id}/renew`, {method: 'POST', body: {fence: renewing.fence}})).body.lease_seconds === 30);
  await admit(stalled.attempt_id, stalled.fence, 'sweep-late', 0.01);
  await settle(stalled.attempt_id, 'sweep-late', {outcome: 'uncertain', provenance: {source: 'outcome_unknown'}});
  await asSystem("update benchmark_admission set deadline_at = now() - interval '1 second' where attempt_id = $1", [stalled.attempt_id]);
  await asSystem("update benchmark_attempt set lease_expires_at = now() - interval '1 second' where attempt_id = $1", [stalled.attempt_id]);
  const attemptState = async id => (await asSystem('select state, execution_status, sealed from benchmark_attempt where attempt_id = $1', [id])).rows[0];
  const admissionState = async (id, call) => (await asSystem('select status, cost_usd::float8 as cost from benchmark_admission where attempt_id = $1 and call_id = $2', [id, call])).rows[0];
  const eventually = async check => {
    for (let waited = 0; waited < 15_000; waited += 250) {
      if (await check()) return true;
      await sleep(250);
    }
    return false;
  };
  check('the periodic sweep interrupts an expired lease and settles an overdue reservation with no claim or read',
    await eventually(async () => (await attemptState(stalled.attempt_id)).execution_status === 'interrupted' && (await admissionState(stalled.attempt_id, 'sweep-late')).status === 'settled'));
  const sweptRow = await admissionState(stalled.attempt_id, 'sweep-late');
  check('the overdue reservation settled at its reserved bound', Math.abs(sweptRow.cost - 0.01) < 1e-9);
  check('the other attempt of the run, still within its lease, stays leased', (await attemptState(renewing.attempt_id)).state === 'leased');
  const runView = (await api(`${base}/runs/${run3.run_id}`, {cookie: alice.cookie})).body.run;
  check('a member sees the stalled attempt interrupted, not leased',
    JSON.stringify(runView).includes('interrupted') && !runView.cases.some(c => c.attempts?.some(a => a.attempt_id === stalled.attempt_id && a.state === 'leased')));

  // A member's read interrupts an expired attempt on its own, whatever the timer does.
  await asSystem("update benchmark_attempt set lease_expires_at = now() - interval '1 second' where attempt_id = $1", [renewing.attempt_id]);
  const readView = (await api(`${base}/attempts/${renewing.attempt_id}`, {cookie: alice.cookie})).body.attempt;
  check('a member read interrupts an attempt whose lease ran out', readView.state === 'final' && readView.execution.status === 'interrupted' && readView.sealed);

  // Sweeps racing renewals and claims: a renewed lease is never interrupted, an expired one is interrupted exactly once.
  const raceRun = (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`key5-${token}`, third.preview.preview_id, third.body)})).body.run;
  const raced = (await claim('raced')).body;
  const racedOther = (await claim('raced-other')).body;
  await asSystem("update benchmark_attempt set lease_expires_at = now() + interval '1 second' where attempt_id = $1", [raced.attempt_id]);
  const responses = await Promise.all([
    ...Array.from({length: 40}, () => worker(`attempts/${raced.attempt_id}/renew`, {method: 'POST', body: {fence: raced.fence}})),
    ...Array.from({length: 40}, () => claim('racer')),
    ...Array.from({length: 20}, () => api(`${base}/runs`, {cookie: alice.cookie})),
  ]);
  check('concurrent sweeps, claims and renewals never fail', responses.every(response => response.status < 500));
  check('a renewal racing the sweeps keeps its lease', (await attemptState(raced.attempt_id)).state === 'leased');
  await asSystem("update benchmark_attempt set lease_expires_at = now() - interval '1 second' where attempt_id = any($1::uuid[])", [[raced.attempt_id, racedOther.attempt_id]]);
  const expiredResponses = await Promise.all([
    ...Array.from({length: 20}, () => claim('racer')),
    ...Array.from({length: 20}, () => api(`${base}/runs/${raceRun.run_id}`, {cookie: alice.cookie})),
  ]);
  check('concurrent sweeps of expired leases never fail', expiredResponses.every(response => response.status < 500));
  check('every expired lease ends interrupted, once',
    (await attemptState(raced.attempt_id)).execution_status === 'interrupted' && (await attemptState(racedOther.attempt_id)).execution_status === 'interrupted'
    && (await asSystem("select count(*)::int as n from benchmark_attempt where run_id = $1 and execution_status = 'interrupted'", [raceRun.run_id])).rows[0].n === 2);
  await api(`${base}/runs/${run3.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  await api(`${base}/runs/${raceRun.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});

  // ── Racing claims: a run has no concurrency of its own ──
  check('a request that still sends limits.concurrency is refused as an unknown limit',
    (await publish(alice, {...publication(`conc-${token}`, ['c1']), limits: {...runLimits, concurrency: 2}})).status === 400);
  const crowded = await newRun(`crowd-${token}`, crowd);
  const claimed = await Promise.all(Array.from({length: 8}, (_, n) => claim(`crowd-${n}`)));
  const crowdClaims = claimed.filter(response => response.status === 200 && response.body.run.run_id === crowded.run.run_id);
  check('racing claims lease every queued attempt of a run once, with no cap of the run\'s own', crowdClaims.length === 4 && new Set(crowdClaims.map(response => response.body.attempt_id)).size === 4
    && (await asSystem("select count(*)::int as n from benchmark_attempt where run_id = $1 and state = 'leased'", [crowded.run.run_id])).rows[0].n === 4);
  // ── Evidence bounds ──
  const [bounded, finalizing] = crowdClaims.map(response => response.body);
  const bigEvents = (from, count) => Array.from({length: count}, (_, n) => event(`big-${from + n}`, from + n, {data: {pad: 'x'.repeat(250_000)}}));
  check('an event past its byte limit is 413, and an out-of-range nanosecond or fence is 400',
    (await post(bounded.attempt_id, 1, [event('huge', 1, {data: {pad: 'x'.repeat(300_000)}})])).status === 413
    && (await post(bounded.attempt_id, 1, [event('ns', 1, {occurred_ns: '9999999999999999999'})])).status === 400
    && (await post(bounded.attempt_id, 2 ** 40, [event('fence', 1)])).status === 400);
  check('40 events of 250 KB commit', (await post(bounded.attempt_id, 1, bigEvents(1, 20))).status === 200 && (await post(bounded.attempt_id, 1, bigEvents(21, 20))).status === 200);
  const firstPage = (await api(`${base}/attempts/${bounded.attempt_id}/events?limit=1000`, {cookie: alice.cookie})).body;
  const secondPage = (await api(`${base}/attempts/${bounded.attempt_id}/events?limit=1000&after=${firstPage.events.at(-1).cursor}`, {cookie: alice.cookie})).body;
  check('an events page ends at its byte limit, not only its count, and the pages together hold every event',
    firstPage.events.length > 0 && firstPage.events.length < 40 && firstPage.has_more === true && !secondPage.has_more && firstPage.events.length + secondPage.events.length === 40);
  await asSystem('update benchmark_attempt set next_cursor = 100000 where attempt_id = $1', [bounded.attempt_id]);
  check('an attempt keeps a bounded number of events', (await post(bounded.attempt_id, 1, [event('over-1', 1), event('over-2', 2)])).body.code === 'too_many_events');
  await asSystem('update benchmark_attempt set next_cursor = 41 where attempt_id = $1', [bounded.attempt_id]);
  const putSpan = attributes => worker(`attempts/${bounded.attempt_id}/spans`, {method: 'POST', body: {fence: 1, spans: [{id: 'grow', kind: 'tool', name: 'n', attributes}]}});
  check('span attributes are bounded by what each report sends and by what they merge to',
    (await putSpan({a: 'x'.repeat(40_000)})).status === 413 && (await putSpan({a: 'x'.repeat(20_000)})).status === 200
    && (await putSpan({b: 'x'.repeat(20_000)})).status === 413
    && (await asSystem("select count(*)::int as n from benchmark_span where attempt_id = $1 and span_id = 'grow' and attributes ? 'b'", [bounded.attempt_id])).rows[0].n === 0);
  check('link attributes are bounded', (await worker(`attempts/${bounded.attempt_id}/spans`, {method: 'POST', body: {fence: 1, links: [{kind: 'k', from: 'a', to: 'b', attributes: {pad: 'x'.repeat(9000)}}]}})).status === 413);
  check('finalize bounds the metrics and the coverage an attempt keeps',
    (await finalize(finalizing.attempt_id, finalizeBody(0, {metrics: {pad: 'x'.repeat(70_000)}}))).status === 413
    && (await finalize(finalizing.attempt_id, finalizeBody(0, {coverage: {pad: 'x'.repeat(70_000)}}))).status === 413
    && (await finalize(finalizing.attempt_id, finalizeBody(0))).status === 200);
  await api(`${base}/runs/${crowded.run.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});

  // ── Capabilities shrink ──
  const shrunk = await claim('small', {capabilities: {...CAPS, memory_mb: 512}});
  const exceeding = await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`shrunk-${token}`, firstPreview.preview_id, firstSetup)});
  check('a run whose limits the workers no longer cover is refused, not queued, and so is a publication',
    shrunk.status === 204 && (await preview(mainId)).body.code === 'limit_exceeds_worker' && (await preview(small.benchmark_id)).status === 200 && exceeding.status === 400
    && (await publish(alice, publication(`big-${token}`, ['c1'], {limits: {memory_mb: 1024}}))).body.code === 'limit_exceeds_worker');
  check('a retry of an accepted submission still returns its run', (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`key-${token}`, firstPreview.preview_id, firstSetup)})).body.replayed === true);
  await claim('big');

  // ── A worker that stops pricing the model ──
  await claim('repriced', {capabilities: {...CAPS, models: ['elsewhere/model']}});
  check('a preview and a publication are refused once no worker prices the benchmark\'s model, rather than queueing runs that would be interrupted',
    (await preview(mainId)).body.code === 'unknown_model'
    && (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: runBody(`unpriced-${token}`, firstPreview.preview_id, firstSetup)})).body.code === 'unknown_model'
    && (await publish(alice, publication(`unpriced-2-${token}`, ['c1']))).body.code === 'unknown_model');
  await claim('priced-again');
  check('the schema holds no suite, scoring or hook table', (await asSystem(
    "select count(*)::int as n from information_schema.tables where table_name like 'benchmark_suite%' or table_name = 'benchmark_scoring' or table_name = 'benchmark_run_suite'")).rows[0].n === 0);

  // ── Previews ──
  // Previews pile up to a bound: a member keeps their newest 50.
  for (let n = 0; n < 52; n += 1) await preview(mainId);
  check('a member keeps at most 50 previews', (await asSystem('select count(*)::int as n from benchmark_preview where user_id = $1', [alice.id])).rows[0].n === 50);

  console.log(JSON.stringify({ok: true, checks: checks.length}, null, 2));
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await stopServer();
  await asSystem('delete from benchmark_run where workspace_id in (select id from workspace where slug like $1)', [`%-${token}`]).catch(() => {});
  await migrationPool.query('delete from workspace where slug like $1', [`%-${token}`]).catch(() => {});
  await migrationPool.query('delete from app_user where id = any($1::text[])', [createdUsers]).catch(() => {});
  await asSystem('delete from benchmark_budget where scope_id = any($1::text[])', [createdUsers]).catch(() => {});
  await asSystem('delete from benchmark_worker_capability where endpoint_label like $1', [`%-${token}`]).catch(() => {});
  await asSystem("delete from benchmark_package where convert_from(data, 'UTF8') like $1", [`package of bench-%${token}`]).catch(() => {});
  await migrationPool.query('delete from rate_limit_bucket where key like $1', [`%${clientIp}%`]).catch(() => {});
  if (savedPolicy) {
    await migrationPool.query('update platform_policy set signup_mode = $1, max_workspaces_per_user = $2',
      [savedPolicy.signup_mode, savedPolicy.max_workspaces_per_user]).catch(() => {});
  }
  nano?.close();
  await runtimePool.end();
  await migrationPool.end();
}
