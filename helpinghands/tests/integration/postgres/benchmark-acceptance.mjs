#!/usr/bin/env node
/**
 * Real PostgreSQL acceptance test for uploaded harness benchmarks (docs/contracts/rush-benchmark-api.md
 * in the NanoAgent project): a member publishes a benchmark (cases with a prompt, arguments, fixtures and an expected error, their references
 * kept private) and submits a run of an agent on it, a worker advertises its capabilities, claims, spends, records and finalizes its attempts
 * (a worker's own failure is retried), the run is scored and compared, and no other member or workspace sees any of it. It drives the running Node server over HTTP, signing in through a fake
 * GitHub (_fake-github.mjs) and with a fake NanoAgent that accepts any package.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';
import {fakeGithubEnv, signInWithGithub} from './_github.mjs';

const require = createRequire(import.meta.url);
const {createPool, migrate, grantRuntimeAccess} = require('../../../src/server/postgres/client.js');
const {expireLeases} = require('../../../src/server/postgres/benchmark-sweep.js');
const {MEMBER_STORAGE_BYTES} = require('../../../src/server/benchmark/limits.js');

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
// The fixtures archives the test published, by digest, which the cleanup deletes: a case set outlives its publisher.
const fixturesDigests = [];

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
      // Every benchmark runs on the server's one model through its one endpoint; the acceptance stack names the mock worker's.
      RUSH_BENCHMARK_ENDPOINT: LABEL, RUSH_BENCHMARK_MODEL: 'mock/model', ROOT_GITHUB_LOGIN: github.root.login, NANOAGENT_URL: `http://127.0.0.1:${nano.address().port}`, EDITOR_PORT: String(port), BETTER_AUTH_URL: origin,
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
  models: ['mock/model'],
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
  const claim = async (id = 'w1', {label = LABEL, capabilities = CAPS, body = {}, token} = {}) => worker('claim', {method: 'POST', token, body: {worker_id: id, endpoint_profile: {label, mode: 'mock'}, capabilities, interactive: false, ...body}});

  // ── Benchmark publishing ──
  const pluginId = pluginIds[0];
  // The catalog entry NanoAgent stores for a package (Manifest.public()): publishing checks a benchmark's task against it.
  const benchEntry = {
    name: 'Bench plugin', permissions: {network: {hosts: ['api.example.com']}, filesystem: {write: []}}, tools: [{name: 'read', description: 'Reads a file'}],
    tasks: [{id: 'sum', runner: 'agent', description: 'Add the numbers', tools: ['read']}],
  };
  const sha = await marketPlugin(alice, pluginId, benchEntry, [alice, bob]);
  const sha2 = await marketVersion(alice, pluginId, '2.0.0', benchEntry);
  const otherSha = await marketPlugin(alice, pluginIds[1], benchEntry, [alice]);
  await marketPlugin(alice, pluginIds[2], {tools: [], tasks: []}, []);
  const task = {
    kind: 'agent', egress_hosts: ['api.example.com'], description: 'Add the numbers',
    input_schema: {type: 'object', properties: {numbers: {type: 'array'}}}, output_schema: {type: 'object', properties: {sum: {type: 'number'}}},
    tools: [{name: 'read', description: 'Reads a file', input_schema: {type: 'object'}, output_schema: {type: 'object'}, writes: false}],
  };
  // A case's fixtures as a publication carries them: the gzipped tar's digest, each file's digest by its path, and the archive as base64.
  const fixturesOf = (text, files) => {
    const archive = zlib.gzipSync(Buffer.from(text));
    return {sha256: sha256(archive), files, archive: archive.toString('base64')};
  };
  const FIXTURES = fixturesOf(`fixtures ${token}`, {'inputs/a.csv': sha256('1,2')});
  const allCases = [
    {case_id: 'c1', kind: 'answer', prompt: 'Add the numbers in inputs/a.csv: 1 and 2', arguments: {numbers: [1, 2]}, fixtures: FIXTURES, expected_error: null},
    {case_id: 'r1', kind: 'refuse', prompt: 'Add the numbers: x', arguments: {numbers: 'x'}, fixtures: null, expected_error: 'numbers must be an array'},
    {case_id: 'c2', kind: 'answer', prompt: 'Add the numbers in inputs/a.csv: 3 and 4', arguments: {numbers: [3, 4]}, fixtures: FIXTURES, expected_error: null},
    {case_id: 'r2', kind: 'refuse', prompt: 'Add the numbers: none', arguments: {numbers: null}, fixtures: null, expected_error: 'numbers is required'},
  ];
  // The references live in `private`, never in a case.
  const allPrivate = {c1: {expected: 3, note: SECRET}, r1: 'numbers must be an array', c2: {expected: 7, note: SECRET}, r2: 'numbers is required'};
  const runLimits = {wall_time_ms: 60_000, max_model_calls: 3, max_output_tokens_per_call: 512, max_cost_usd: 1.5};
  // A benchmark of plugin version 1.0.0 over the named cases, as the publishing route takes it: the model and the endpoint are the server's, never the request's.
  const publication = (name, caseIds, extra = {}) => ({
    name, plugin_id: pluginId, plugin_name: 'Bench plugin', version: '1.0.0', package_sha256: sha, task_id: 'sum', task,
    cases: allCases.filter(c => caseIds.includes(c.case_id)), private: Object.fromEntries(caseIds.map(id => [id, allPrivate[id]])),
    limits: runLimits, ...extra,
  });
  const publish = (member, body) => api('/api/benchmark/benchmarks', {method: 'POST', cookie: member.cookie, body});
  const benchmarkRows = async name => (await asSystem('select count(*)::int as n from benchmark where name = $1', [name])).rows[0].n;
  const caseSetRows = async () => (await asSystem('select count(*)::int as n from benchmark_case_set where plugin_id = any($1::text[])', [pluginIds])).rows[0].n;
  fixturesDigests.push(FIXTURES.sha256);
  const fixturesRows = async () => (await asSystem('select count(*)::int as n from benchmark_fixtures where sha256 = any($1::text[]) or publisher_id = any($2::text[])', [fixturesDigests, [alice.id, bob.id, carol.id]])).rows[0].n;

  const mainName = `cases-${token}`;
  const unavailable = await publish(alice, publication(mainName, ['c1', 'r1']));
  check('a benchmark for an endpoint no worker advertised for is refused, and nothing is stored',
    unavailable.status === 409 && unavailable.body.code === 'worker_unavailable' && await benchmarkRows(mainName) === 0 && await caseSetRows() === 0 && await fixturesRows() === 0);
  check('a claim must carry capabilities, every one of them',
    (await claim('w1', {capabilities: null})).status === 400 && (await claim('w1', {capabilities: {...CAPS, pids: undefined}})).status === 400);
  check('a claim must advertise the models it prices, as a non-empty list of names',
    (await claim('w1', {capabilities: {...CAPS, models: undefined}})).status === 400 && (await claim('w1', {capabilities: {...CAPS, models: []}})).status === 400
    && (await claim('w1', {capabilities: {...CAPS, models: [1]}})).status === 400);
  check('a claim\'s installed agents are a list of command names', (await claim('w1', {capabilities: {...CAPS, installed_agents: ['Not A Command']}})).status === 400
    && (await claim('w1', {capabilities: {...CAPS, installed_agents: 'aider'}})).status === 400);
  check('a worker with nothing to claim advertises its capabilities and gets 204', (await claim('w0')).status === 204);
  const endpoints = (await api(`${base}/defaults`, {cookie: alice.cookie})).body.endpoints;
  check('the latest capabilities are kept per endpoint label', endpoints.find(entry => entry.label === LABEL)?.capabilities.memory_mb === 4096
    && JSON.stringify(endpoints.find(entry => entry.label === LABEL).capabilities.models) === '["mock/model"]');

  check('a worker that advertised makes its endpoint available', (await claim('w-stale')).status === 204
    && (await api(`${base}/defaults`, {cookie: alice.cookie})).body.endpoints.some(entry => entry.label === LABEL));
  await asSystem("update benchmark_worker_capability set updated_at = now() - interval '1 day' where endpoint_label = $1", [LABEL]);
  check('an endpoint whose workers have not claimed within the capability window is no longer available, to a listing or to a publication',
    !(await api(`${base}/defaults`, {cookie: alice.cookie})).body.endpoints.some(entry => entry.label === LABEL)
    && (await publish(alice, publication(`stale-${token}`, ['c1']))).body.code === 'worker_unavailable');
  check('a claim makes the endpoint available again', (await claim('w0')).status === 204
    && (await api(`${base}/defaults`, {cookie: alice.cookie})).body.endpoints.some(entry => entry.label === LABEL));

  const main = await publish(alice, publication(mainName, ['c1', 'r1']));
  const mainId = main.body.benchmark.benchmark_id;
  check('a member publishes a benchmark for a plugin version: named, tied to the version, with the case set and run configuration pinned',
    main.status === 201 && main.body.created === true && main.body.benchmark.name === mainName && main.body.benchmark.plugin.id === pluginId && main.body.benchmark.plugin.version === '1.0.0'
    && main.body.benchmark.plugin.sha256 === sha && main.body.benchmark.model === 'mock/model' && main.body.benchmark.endpoint_profile === LABEL
    && main.body.benchmark.limits.max_model_calls === 3 && main.body.benchmark.limits.internet_access === true && main.body.benchmark.limits.cpus === 1
    && main.body.benchmark.case_count === 2 && main.body.benchmark.answer_count === 1 && main.body.benchmark.refuse_count === 1
    && main.body.benchmark.publisher.id === alice.id && !('run_count' in main.body.benchmark) && !('coding_template' in main.body.benchmark)
    && /^[0-9a-f]{64}$/.test(main.body.benchmark.digest) && /^[0-9a-f]{64}$/.test(main.body.benchmark.case_set_digest));
  const fixtureRow = (await asSystem('select count(*)::int as n, min(publisher_id) as publisher, min(octet_length(archive)) as size from benchmark_fixtures where sha256 = $1', [FIXTURES.sha256])).rows[0];
  check('a fixtures archive is kept once per digest however many cases hold it, charged to its first publisher',
    fixtureRow.n === 1 && fixtureRow.publisher === alice.id && fixtureRow.size === Buffer.from(FIXTURES.archive, 'base64').length && await fixturesRows() === 1);
  check('the publisher\'s storage is charged the archive\'s bytes once', Number((await asSystem(
    'select coalesce(sum(octet_length(archive)), 0)::int as n from benchmark_fixtures where publisher_id = $1', [alice.id])).rows[0].n) === fixtureRow.size);
  const again = await publish(alice, publication(mainName, ['c1', 'r1']));
  check('publishing the same benchmark again answers created: false and stores nothing',
    again.status === 200 && again.body.created === false && again.body.benchmark.benchmark_id === mainId && await benchmarkRows(mainName) === 1 && await fixturesRows() === 1);
  const rewordedCases = allCases.filter(c => ['c1', 'r1'].includes(c.case_id)).map((c, index) => (index === 0 ? {...c, prompt: `${c.prompt}, exactly`} : c));
  const changed = await publish(alice, {...publication(mainName, ['c1', 'r1']), limits: {...runLimits, memory_mb: 512}});
  const changedPrompt = await publish(alice, {...publication(mainName, ['c1', 'r1']), cases: rewordedCases});
  const changedReference = await publish(alice, {...publication(mainName, ['c1', 'r1']), private: {c1: {expected: 4}, r1: allPrivate.r1}});
  check('a changed benchmark under the same name (limits, a case\'s prompt or a reference) is refused, and nothing is stored',
    changed.status === 409 && changed.body.code === 'benchmark_name_taken' && changedPrompt.body.code === 'benchmark_name_taken' && changedReference.body.code === 'benchmark_name_taken'
    && await benchmarkRows(mainName) === 1);
  check('a worker advertises for its own member only', (await claim('wb', {token: credentials.bob})).status === 204
    && !(await api(`/api/workspaces/${w2.id}/benchmark/defaults`, {cookie: carol.cookie})).body.endpoints.some(entry => entry.label === LABEL));
  const bobsOwn = await publish(bob, publication(`bobs-${token}`, ['c1', 'r1']));
  check('any member publishes a benchmark for a published plugin, and a name is unique per plugin version whoever published it',
    bobsOwn.status === 201 && bobsOwn.body.benchmark.publisher.id === bob.id
    && (await publish(bob, {...publication(mainName, ['c1', 'r1']), limits: {...runLimits, memory_mb: 512}})).body.code === 'benchmark_name_taken');
  check('identical case sets are shared between benchmarks', bobsOwn.body.benchmark.case_set_id === main.body.benchmark.case_set_id && await fixturesRows() === 1);
  // Deleting the case set's first publisher must not fail on the benchmarks that share it; the delete is rolled back.
  const deleting = await migrationPool.connect();
  try {
    await deleting.query('begin');
    // The plugin is Alice's too, and goes with her; hand it to Carol so only the case set's publisher link is tested.
    await deleting.query('update market_plugin set owner_id = $1 where id = $2', [carol.id, pluginId]);
    await deleting.query('delete from app_user where id = $1', [alice.id]);
    const kept = (await deleting.query('select publisher_id from benchmark_case_set where case_set_id = $1', [main.body.benchmark.case_set_id])).rows;
    const keptFixtures = (await deleting.query('select publisher_id from benchmark_fixtures where sha256 = $1', [FIXTURES.sha256])).rows;
    check('deleting the first publisher of a shared case set succeeds and leaves the case set and its fixtures, without a publisher',
      kept.length === 1 && kept[0].publisher_id === null && keptFixtures.length === 1 && keptFixtures[0].publisher_id === null);
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
  const fixturesAfter = await fixturesRows();
  const refused = async extra => (await publish(alice, publication(`refused-${token}`, ['c1'], extra))).body;
  // The first case of a publication of c1 alone, edited.
  const caseEdited = async edit => {
    const body = publication(`refused-${token}`, ['c1']);
    body.cases = [edit(structuredClone(body.cases[0]))];
    return (await publish(alice, body)).body;
  };
  check('limits above what the endpoint\'s workers give, internet access where they cannot, and an unknown limit are refused, and nothing is stored',
    (await refused({limits: {...runLimits, memory_mb: 8192}})).code === 'limit_exceeds_worker' && (await refused({limits: {...runLimits, memory_mb: 8192}})).exceeded[0].max === 4096
    && (await refused({limits: {nope: 1}})).code === 'invalid_request' && (await refused({limits: {concurrency: 2}})).code === 'invalid_request'
    && await benchmarkRows(`refused-${token}`) === 0 && await caseSetRows() === rowsAfter);
  check('a publication names neither a model nor an endpoint: every benchmark runs on the server\'s own',
    (await refused({model: 'other/model'})).code === 'invalid_request' && /model is not a field/.test((await refused({model: 'other/model'})).error)
    && (await refused({endpoint_profile: 'elsewhere'})).code === 'invalid_request' && /endpoint_profile is not a field/.test((await refused({endpoint_profile: 'elsewhere'})).error));
  check('the old shape is refused naming the field: a context, a coding template, task instructions and a task\'s instructions',
    /context is no longer a field/.test((await refused({context: 'Résumé: sums'})).error) && /coding_template is no longer a field/.test((await refused({coding_template: 'Do {description}'})).error)
    && /task_instructions is no longer a field/.test((await refused({task_instructions: 'Be exact.'})).error)
    && /task\.instructions is no longer a field/.test((await refused({task: {...task, instructions: 'Be exact.'}})).error)
    && await benchmarkRows(`refused-${token}`) === 0);
  check('a case needs a prompt that is not blank and does not start or end with whitespace, and takes no field the case shape lacks',
    (await caseEdited(c => ({...c, prompt: undefined}))).code === 'invalid_request' && (await caseEdited(c => ({...c, prompt: '   '}))).code === 'invalid_request'
    && /must not start or end with whitespace/.test((await caseEdited(c => ({...c, prompt: ` ${c.prompt}`}))).error)
    && /context, which is no field of a case/.test((await caseEdited(c => ({...c, context: 'old'}))).error));
  check('a refusal case pins its expected error as text, and an answer case takes none',
    (await caseEdited(c => ({...c, kind: 'refuse', expected_error: undefined}))).code === 'invalid_request'
    && (await caseEdited(c => ({...c, expected_error: 'unexpected'}))).code === 'invalid_request'
    && (await publish(alice, {...publication(`refused-${token}`, ['r1']), private: {r1: {not: 'text'}}})).body.code === 'invalid_request'
    && (await publish(alice, {...publication(`refused-${token}`, ['c1']), private: {c1: 'text'}})).body.code === 'invalid_request');
  check('fixtures are null or an object of exactly sha256, files and archive, whose archive hashes to its sha256',
    (await caseEdited(c => ({...c, fixtures: undefined}))).code === 'invalid_request'
    && (await caseEdited(c => ({...c, fixtures: {...FIXTURES, extra: 1}}))).code === 'invalid_request'
    && /does not hash to its sha256/.test((await caseEdited(c => ({...c, fixtures: {...FIXTURES, sha256: 'a'.repeat(64)}}))).error)
    && (await caseEdited(c => ({...c, fixtures: {...FIXTURES, archive: 'not base64!'}}))).code === 'invalid_request'
    && (await caseEdited(c => ({...c, fixtures: {...FIXTURES, files: {'../escape': 'a'.repeat(64)}}}))).code === 'invalid_request'
    && (await caseEdited(c => ({...c, fixtures: {...FIXTURES, files: {'/abs': 'a'.repeat(64)}}}))).code === 'invalid_request');
  check('an archive over 8 MiB is refused before it is decoded, and nothing is stored',
    (await caseEdited(c => ({...c, fixtures: {sha256: 'a'.repeat(64), files: {}, archive: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')}}))).code === 'fixtures_too_large'
    && await fixturesRows() === fixturesAfter && await caseSetRows() === rowsAfter);
  const sameName = await refused({name: 'Bad Name'});
  check('a benchmark needs a lowercase name, and cases', sameName.code === 'invalid_request' && (await refused({cases: []})).code === 'invalid_request');
  const invalid = await publish(alice, {...publication('y', ['c1', 'r1']), private: {c1: allPrivate.c1}});
  check('a benchmark whose private references do not match its cases is refused', invalid.body.code === 'invalid_request'
    && (await publish(alice, {...publication('y', ['c1']), private: {c1: allPrivate.c1, c2: allPrivate.c2}})).body.code === 'invalid_request');
  const mismatched = await publish(alice, publication(`mismatch-${token}`, ['c1'], {task: {...task, egress_hosts: ['api.example.com', 'evil.example.com']}}));
  check('a task that differs from its package is refused with 422 task_mismatch and stores nothing', mismatched.status === 422 && mismatched.body.code === 'task_mismatch' && await benchmarkRows(`mismatch-${token}`) === 0
    && await fixturesRows() === fixturesAfter);
  check('publishing needs a session and no workspace', (await api('/api/benchmark/benchmarks', {method: 'POST', body: publication('z', ['c1'])})).status === 401);
  check('private references are in no table a member can read',
    // The database owner here is a superuser, which row-level security never binds; the runtime role is bound.
    (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_case_set_private')).rowCount === 0
    && (await as({userId: alice.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_case_set_private')).rowCount === 0
    && (await as({system: true, pool: runtimePool}, 'select 1 from benchmark_case_set_private')).rowCount > 0);
  check('a fixtures archive is read by its publisher and the worker alone, and whether one is kept is a question any member may ask',
    (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_fixtures')).rowCount === 0
    && (await as({userId: alice.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_fixtures')).rowCount === 1
    && (await as({system: true, pool: runtimePool}, 'select 1 from benchmark_fixtures')).rowCount === 1
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select benchmark_fixtures_known($1) as known', [FIXTURES.sha256])).rows[0].known === true
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select benchmark_fixtures_known($1) as known', ['b'.repeat(64)])).rows[0].known === false);

  // The benchmarks the runs below use, over the same plugin version and so the same case sets where their cases are the same.
  const published = async (name, caseIds, extra) => {
    const result = await publish(alice, publication(`${name}-${token}`, caseIds, extra));
    assert.equal(result.status, 201, `${name}: ${result.text}`);
    return result.body.benchmark;
  };
  const single = await published('single', ['c2']);
  const offline = await published('offline', ['c1', 'r1'], {limits: {...runLimits, internet_access: false}});
  const cross = await published('cross', ['c1', 'c2']);
  const crowd = await published('crowd', ['c1', 'r1', 'c2', 'r2'], {limits: runLimits});
  const small = await published('small', ['c1', 'r1'], {limits: {...runLimits, memory_mb: 512}});
  const otherPlugin = (await publish(alice, {...publication(`other-${token}`, ['c1', 'r1']), plugin_id: pluginIds[1], package_sha256: otherSha})).body.benchmark;
  const shared = await published('shared', ['c1', 'r1']);
  const shared2 = (await publish(alice, publication(`shared-${token}`, ['c1', 'r1'], {version: '2.0.0', package_sha256: sha2}))).body.benchmark;

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
  check('a benchmark\'s detail shows its task and cases, in order, with each prompt, arguments and fixtures\' digest and files, but no archive and no private reference',
    detail.task.kind === 'agent' && detail.task.egress_hosts.join() === 'api.example.com' && !('instructions' in detail.task) && !('context' in detail) && !('coding_template' in detail)
    && detail.cases.map(c => `${c.case_id}:${c.kind}`).join() === 'c1:answer,r1:refuse'
    && detail.cases[0].prompt === allCases[0].prompt && detail.cases[0].prompt_sha256 === sha256(allCases[0].prompt) && detail.cases[0].arguments.numbers.join() === '1,2'
    && detail.cases[0].fixtures.sha256 === FIXTURES.sha256 && JSON.stringify(detail.cases[0].fixtures.files) === JSON.stringify(FIXTURES.files) && detail.cases[1].fixtures === null
    && detail.cases[1].expected_error === 'numbers must be an array' && detail.cases[0].expected_error === null && /^[0-9a-f]{64}$/.test(detail.cases[0].content_digest)
    && !JSON.stringify(detail).includes(SECRET) && !JSON.stringify(detail).includes(FIXTURES.archive) && !JSON.stringify(detail).includes('reference'));
  check('a benchmark\'s detail counts no runs: runs are private to the member who made them', !('run_count' in detail) && !('runner_count' in detail));
  check('an unknown benchmark is not found, nor a non-UUID one', (await api(`${base}/benchmarks/${crypto.randomUUID()}`, {cookie: alice.cookie})).body.code === 'unknown_benchmark'
    && (await api(`${base}/benchmarks/nope`, {cookie: alice.cookie})).status === 404);
  const defaults = (await api(`${base}/defaults`, {cookie: alice.cookie})).body;
  check('the defaults give the limits, the pinned model and endpoint, the harnesses a run may name and the advertised endpoints',
    defaults.limits.internet_access === true && !('concurrency' in defaults.limits) && defaults.limits.max_cost_usd === 1.5 && defaults.model === 'mock/model' && defaults.endpoint_profile === LABEL
    && ['claude', 'codex', 'dsh', 'hermes', 'nanoagent', 'pi'].every(name => defaults.harnesses.includes(name)) && defaults.endpoints.some(entry => entry.label === LABEL)
    && !('coding_template' in defaults) && !('renderer_version' in defaults));
  const removedRoutes = [
    ['POST', `${base}/previews`], ['POST', `${base}/sources`], ['POST', `${base}/sources/references/claude-code`], ['GET', `${base}/benchmarks/${mainId}/results`],
    ['GET', `${base}/leaderboard`], ['POST', '/api/benchmark/case-sets'], ['GET', `${base}/case-sets`], ['POST', `${base}/pins`],
  ];
  check('the previews, source uploads, results, leaderboard and case-set routes are gone',
    (await Promise.all(removedRoutes.map(([method, path]) => api(path, {method, cookie: alice.cookie, body: method === 'POST' ? {} : undefined})))).every(response => response.status === 404));

  // ── Harnesses ──
  const submitRun = (member, key, benchmark, harness = 'claude', extra = {}, path = base) => api(`${path}/runs`, {
    method: 'POST', cookie: member.cookie, body: {benchmark_id: benchmark.benchmark_id, harness, idempotency_key: key, ...extra},
  });
  check('a run names an agent of the shell harness, or rush <command>, and no other harness',
    (await Promise.all(['claude-code', 'shell', 'rush', 'Claude', 'rush forget', 'rush aider $(x)', '']
      .map(async harness => (await submitRun(alice, `h-${token}`, main.body.benchmark, harness)).body.code))).every(code => code === 'unknown_harness'));
  const rushRun = await submitRun(alice, `rush-${token}`, main.body.benchmark, 'rush aider');
  check('a rush <command> run is refused while no live worker of the member has the command installed',
    rushRun.status === 400 && rushRun.body.code === 'agent_not_installed');
  check('a worker advertises the commands installed on its member\'s computer',
    (await claim('w-agents', {capabilities: {...CAPS, installed_agents: ['aider']}})).status === 204
    && JSON.stringify((await api(`${base}/defaults`, {cookie: alice.cookie})).body.endpoints.find(entry => entry.label === LABEL).capabilities.installed_agents) === '["aider"]');
  const rushQueued = await submitRun(alice, `rush-${token}`, main.body.benchmark, 'rush aider');
  check('a rush <command> run is accepted once one has, and runs on that worker alone',
    rushQueued.status === 201 && rushQueued.body.run.harness.name === 'rush aider' && (await claim('w-without')).status === 204
    && (await claim('w-agents', {capabilities: {...CAPS, installed_agents: ['aider']}})).body.run.run_id === rushQueued.body.run.run_id);
  await api(`${base}/runs/${rushQueued.body.run.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  // The worker that stays: capabilities for the claims below carry no installed agents.
  await claim('w0');

  // ── Number spellings ──
  // A publication Python wrote keeps its numbers as written (1.0, 1e-05, a big int) in the stored case set, the run
  // and the worker's claim, which JavaScript's JSON.parse would have read as 1, 0.00001 and 12345678901234567000.
  const lexemePublication = JSON.stringify({...publication(`lexemes-${token}`, ['c1'], {limits: {...runLimits, max_cost_usd: 0.50}}), task: {...task, input_schema: {type: 'object', properties: {ratio: {minimum: 0.0}}}}, cases: [
    {case_id: 'c1', kind: 'answer', prompt: 'Scale the ratio', arguments: {ratio: '@@1.0@@', tiny: '@@1e-05@@', big: '@@12345678901234567890@@'}, fixtures: null, expected_error: null},
  ], private: {c1: {expected: '@@2.50@@'}}}).replace(/"@@([^@]+)@@"/g, '$1').replace('"minimum":0', '"minimum":0.0').replace('"max_cost_usd":0.5', '"max_cost_usd":0.50');
  const lexemeSet = await api('/api/benchmark/benchmarks', {method: 'POST', cookie: alice.cookie, raw: lexemePublication, body: {}});
  const lexemeId = lexemeSet.body.benchmark.benchmark_id;
  check('a benchmark whose numbers have a spelling JavaScript would change is published', lexemeSet.status === 201 && lexemeSet.body.benchmark.limits.max_cost_usd === 0.5);
  check('the stored case set keeps each number\'s spelling',
    (await api(`${base}/benchmarks/${lexemeId}`, {cookie: alice.cookie})).text.includes('"ratio":1.0,"tiny":1e-05,"big":12345678901234567890')
    && (await migrationPool.query('select arguments::text as text from benchmark_case_set_case where case_set_id = $1', [lexemeSet.body.benchmark.case_set_id])).rows[0].text.includes('1e-05'));
  const lexemeRun = await submitRun(alice, `lex-${token}`, {benchmark_id: lexemeId});
  check('the run shows them as published', lexemeRun.status === 201 && lexemeRun.text.includes('"arguments":{"ratio":1.0,"tiny":1e-05,"big":12345678901234567890}')
    && lexemeRun.body.run.cases[0].prompt === 'Scale the ratio');
  const lexemeClaim = await claim('lex');
  check('the worker\'s claim carries the numbers and the private reference as published',
    lexemeClaim.text.includes('"arguments":{"ratio":1.0,"tiny":1e-05,"big":12345678901234567890}') && lexemeClaim.text.includes('"private_reference":{"expected":2.50}')
    && lexemeClaim.text.includes('"minimum":0.0'));
  await worker(`attempts/${lexemeClaim.body.attempt_id}/finalize`, {method: 'POST', body: {fence: 1, execution: {status: 'answered'}, verdict: 'pass', coverage: {}, metrics: {}, final_cursor_expected: 0}});

  // ── Runs ──
  const created = await submitRun(alice, `key-${token}`, main.body.benchmark);
  const run = created.body.run;
  check('a run is queued with one attempt per case of the benchmark', created.status === 201 && run.cases.length === 2 && run.cases.every(c => c.attempts.length === 1 && c.attempts[0].state === 'queued'));
  check('the run pins the benchmark, harness, case set, model, limits, each case\'s prompt, fixtures and arguments, and the pinned plugin',
    run.benchmark.benchmark_id === mainId && run.benchmark.name === mainName && run.harness.name === 'claude' && run.model === 'mock/model' && run.endpoint_profile === LABEL
    && run.case_set.case_set_id === main.body.benchmark.case_set_id && run.case_set.digest === main.body.benchmark.case_set_digest && run.case_set.plugin.sha256 === sha
    && run.limits.max_model_calls === 3 && run.limits.internet_access === true && run.limits.cpus === 1 && run.unverified_egress === true && run.egress_hosts.join() === 'api.example.com'
    && run.cases.map(c => c.case_id).join() === 'c1,r1' && run.cases[0].prompt === allCases[0].prompt && run.cases[0].prompt_sha256 === sha256(allCases[0].prompt)
    && run.cases[0].fixtures.sha256 === FIXTURES.sha256 && JSON.stringify(run.cases[0].fixtures.files) === JSON.stringify(FIXTURES.files) && run.cases[1].fixtures === null
    && run.cases[1].expected_error === 'numbers must be an array' && run.cases[0].arguments.numbers.join() === '1,2' && /^[0-9a-f]{64}$/.test(run.cases[0].content_digest));
  check('a run has no policy, prompt template, dialects or selection of its own', ['policy', 'prompt', 'dialects', 'selection', 'source_sha256', 'preview_id'].every(field => !(field in run)));
  check('the run shows no score until a case is scored', run.score.value === null && run.score.scored === 0 && run.score.total === 2 && run.score.complete === false);
  const replay = await submitRun(alice, `key-${token}`, main.body.benchmark);
  check('the same idempotency key returns the original run', replay.status === 200 && replay.body.replayed === true && replay.body.run.run_id === run.run_id);
  check('the same key with another request is refused', (await submitRun(alice, `key-${token}`, main.body.benchmark, 'codex')).body.code === 'idempotency_conflict');
  check('the run holds the pinned prompts, never private references or the fixtures archive', !JSON.stringify(run).includes(SECRET) && !JSON.stringify(run).includes(FIXTURES.archive));
  const fields = {benchmark_id: mainId, harness: 'claude', idempotency_key: `k-${token}`};
  const missing = await Promise.all(Object.keys(fields).map(async field => (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: {...fields, [field]: undefined}})).status));
  check('a run takes exactly a benchmark, a harness and a key: all three are required and any other field is refused', missing.every(status => status === 400)
    && (await Promise.all([{model: 'm'}, {dialects: ['responses']}, {limits: {}}, {prompt: {}}, {selection: {}}, {endpoint_profile: LABEL}, {policy: 'coding'}, {preview_id: crypto.randomUUID()}, {source_sha256: 'e'.repeat(64)}]
      .map(async extra => (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: {...fields, ...extra}})).body.code))).every(code => code === 'invalid_request'));
  check('a run needs a benchmark that exists', (await submitRun(alice, `k-${token}`, {benchmark_id: crypto.randomUUID()})).body.code === 'unknown_benchmark'
    && (await api(`${base}/runs`, {method: 'POST', cookie: alice.cookie, body: {...fields, benchmark_id: 'nope'}})).body.code === 'invalid_request');
  const runs = (await api(`${base}/runs`, {cookie: alice.cookie})).body.runs;
  const listedRun = runs.find(entry => entry.run_id === run.run_id);
  check('the member lists their runs as run summaries',
    JSON.stringify(Object.keys(listedRun).sort()) === JSON.stringify(['benchmark', 'created_at', 'harness', 'metrics', 'model', 'plugin', 'run_id', 'score', 'status', 'user'])
    && listedRun.harness.name === 'claude' && listedRun.benchmark.name === mainName && listedRun.plugin.id === pluginId && listedRun.plugin.version === '1.0.0'
    && listedRun.model === 'mock/model' && listedRun.user.id === alice.id && listedRun.status === 'queued'
    && listedRun.metrics.total_tokens.total === 0 && listedRun.metrics.elapsed_ms.missing_attempts === 2);

  // ── Runs are private to their member ──
  const sharedRun = async (member, key, benchmark = shared, harness = 'claude') => {
    const result = await submitRun(member, key, benchmark, harness);
    assert.equal(result.status, 201, result.text);
    return result.body.run;
  };
  const aliceShared1 = await sharedRun(alice, `shared-a1-${token}`);
  const aliceShared2 = await sharedRun(alice, `shared-a2-${token}`, shared, 'codex');
  const bobShared = await sharedRun(bob, `shared-b1-${token}`);
  const shared2Run = await sharedRun(alice, `shared-a3-${token}`, shared2);
  const carolBase = `/api/workspaces/${w2.id}/benchmark`;
  const carolRefused = await publish(carol, publication(`carol-${token}`, ['c1']));
  check('a member with no worker running cannot publish or run, and is told to start RUSH Lab with Docker running',
    carolRefused.status === 409 && carolRefused.body.code === 'worker_unavailable' && /start RUSH Lab with Docker running/.test(carolRefused.body.error)
    && (await submitRun(carol, `carol-${token}`, shared, 'claude', {}, carolBase)).body.code === 'worker_unavailable');
  check('a second member\'s worker never claims the first member\'s run, though its capabilities fit and the runs are queued',
    (await claim('wc', {token: credentials.carol})).status === 204
    && (await asSystem("select count(*)::int as n from benchmark_attempt where worker_id = 'wc'")).rows[0].n === 0
    && (await asSystem("select count(*)::int as n from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id where a.state = 'queued' and r.user_id = $1 and r.endpoint_label = $2", [alice.id, LABEL])).rows[0].n > 0);
  check('no route shows how many runs a benchmark has or who ran it: its detail, results and stats are another member\'s business',
    !('run_count' in (await api(`${carolBase}/benchmarks/${shared.benchmark_id}`, {cookie: carol.cookie})).body.benchmark)
    && (await api(`${carolBase}/benchmarks/${shared.benchmark_id}/results`, {cookie: carol.cookie})).status === 404);
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
  check('benchmark_run stays owner-only to the runtime role, and no function reads another member\'s runs: results, stats and the leaderboard are gone',
    (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select user_id from benchmark_run')).rows.every(row => row.user_id === bob.id)
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select run_id from benchmark_run where run_id = $1', [aliceShared1.run_id])).rowCount === 0
    && (await asSystem("select count(*)::int as n from pg_proc where proname in ('benchmark_results', 'benchmark_stats', 'benchmark_leaderboard')")).rows[0].n === 0);
  check('the other members\' attempts and evidence stay hidden from the runtime role too',
    (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_attempt where run_id = $1', [aliceShared1.run_id])).rowCount === 0
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_run_summary where run_id = $1', [aliceShared1.run_id])).rowCount === 0
    && (await as({userId: bob.id, workspaceId: w1.id, pool: runtimePool}, 'select 1 from benchmark_run_case where run_id = $1', [aliceShared1.run_id])).rowCount === 0);
  // These runs only had to exist: cancel what a claim below would otherwise lease.
  for (const queued of [aliceShared1, aliceShared2, shared2Run]) await api(`${base}/runs/${queued.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  check('a canceled run keeps its cases and ends its queued attempts', (await api(`${base}/runs/${aliceShared1.run_id}`, {cookie: alice.cookie})).body.run.status === 'canceled'
    && (await api(`${base}/runs/${aliceShared1.run_id}`, {cookie: alice.cookie})).body.run.cases.every(c => c.attempts[0].execution.status === 'canceled'));

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
  // A worker claims runs for the server's endpoint alone, and a worker for another label has none.
  const none = await claim('w1', {label: `other-${token}`});
  check('a worker claims only runs for its endpoint profile', none.status === 204);
  const first = (await claim()).body;
  check('a claimed attempt carries its harness, limits, task, case (prompt, arguments, fixtures), plugin and private reference',
    first.kind === 'attempt' && first.fence === 1 && first.private_reference.note === SECRET && first.free_form === false && first.resume === null && first.start === null
    && first.run.run_id === run.run_id && first.run.harness === 'claude' && first.run.limits.max_model_calls === 3 && first.run.limits.internet_access === true && first.run.limits.pids === 256
    && first.run.model === 'mock/model' && first.run.endpoint_profile === LABEL && first.run.interactive === false && first.run.prompt_bound === true
    && first.task.id === 'sum' && first.task.kind === 'agent' && first.task.plugin_name === 'Bench plugin' && first.task.description === 'Add the numbers'
    && !('instructions' in first.task) && first.task.tools[0].name === 'read' && first.task.egress_hosts.join() === 'api.example.com'
    && first.task.input_schema.type === 'object' && first.task.output_schema.properties.sum.type === 'number'
    && first.case.case_id === 'c1' && first.case.kind === 'answer' && first.case.prompt === allCases[0].prompt && first.case.prompt_sha256 === sha256(allCases[0].prompt)
    && first.case.arguments.numbers.join() === '1,2' && first.case.fixtures.sha256 === FIXTURES.sha256 && JSON.stringify(first.case.fixtures.files) === JSON.stringify(FIXTURES.files)
    && first.case.expected_error === null && first.plugin.sha256 === sha && first.plugin.id === pluginId && !('case_set' in first) && !('prompt' in first));
  const second = (await claim('w2')).body;
  check('the next claim leases the next attempt, a refusal case with its expected error and no fixtures',
    second.case.case_id === 'r1' && second.case.kind === 'refuse' && second.case.fixtures === null && second.case.expected_error === 'numbers must be an array'
    && second.private_reference === 'numbers must be an array' && (await claim('w3')).status === 204);
  const fenceHeader = fence => ({'x-rush-fence': String(fence)});
  const a1 = first.attempt_id;
  const packageBytes = await worker(`attempts/${a1}/package`, {headers: fenceHeader(first.fence)});
  const fixturesBytes = await worker(`attempts/${a1}/fixtures`, {headers: fenceHeader(first.fence)});
  check('a fenced worker downloads the package and the case\'s fixtures archive, each with its sha256',
    sha256(packageBytes.body) === sha && sha256(fixturesBytes.body) === FIXTURES.sha256 && fixturesBytes.headers.get('x-rush-sha256') === FIXTURES.sha256
    && fixturesBytes.headers.get('content-type') === 'application/gzip' && fixturesBytes.body.equals(Buffer.from(FIXTURES.archive, 'base64')));
  const noFixtures = await worker(`attempts/${second.attempt_id}/fixtures`, {headers: fenceHeader(second.fence)});
  check('a case with no fixtures has no archive to download', noFixtures.status === 404 && noFixtures.body.code === 'no_fixtures'
    && (await worker(`attempts/${a1}/source`, {headers: fenceHeader(first.fence)})).status === 404);
  check('a wrong fence cannot download or renew',
    (await worker(`attempts/${a1}/package`, {headers: fenceHeader(7)})).body.code === 'lease_lost' && (await worker(`attempts/${a1}/fixtures`, {headers: fenceHeader(7)})).body.code === 'lease_lost'
    && (await worker(`attempts/${a1}/renew`, {method: 'POST', body: {fence: 7}})).body.code === 'lease_lost' && (await worker(`attempts/${a1}/fixtures`)).status === 400);
  check('another member\'s worker cannot download the fixtures of a lease it does not hold', (await worker(`attempts/${a1}/fixtures`, {token: credentials.bob, headers: fenceHeader(first.fence)})).status === 404);
  check('a lease renews', (await worker(`attempts/${a1}/renew`, {method: 'POST', body: {fence: first.fence}})).status === 200);

  // A run whose benchmark pins no internet access, and a run another worker can only claim within its capabilities.
  const inetRun = await sharedRun(alice, `inet-${token}`, single);
  const offlineRun = await sharedRun(alice, `offline-${token}`, offline, 'codex');
  check('a run pins its benchmark\'s limits: internet access off is not unverified egress',
    offlineRun.limits.internet_access === false && offlineRun.unverified_egress === false && offlineRun.harness.name === 'codex' && offlineRun.egress_hosts.join() === 'api.example.com'
    && inetRun.limits.internet_access === true && inetRun.unverified_egress === true);
  const noInternet = {...CAPS, internet_access: false};
  const offlineClaim = await claim('offline', {capabilities: noInternet});
  check('a worker that cannot give internet access is handed no run that wants it, only the run that does not',
    offlineClaim.status === 200 && offlineClaim.body.run.run_id === offlineRun.run_id && offlineClaim.body.run.harness === 'codex' && offlineClaim.body.run.limits.internet_access === false
    && offlineClaim.body.case.prompt === offlineRun.cases[0].prompt && offlineClaim.body.case.case_id === 'c1');
  await worker(`attempts/${offlineClaim.body.attempt_id}/finalize`, {method: 'POST', body: {fence: 1, execution: {status: 'execution_failed', reason: 'harness_failed'}, verdict: 'fail', coverage: {}, metrics: {}, final_cursor_expected: 0}});
  const afterOne = await claim('offline-3', {capabilities: noInternet});
  check('the next attempt of that run is claimable once the first has ended', afterOne.status === 200 && afterOne.body.run.run_id === offlineRun.run_id && afterOne.body.case.case_id === 'r1');
  await worker(`attempts/${afterOne.body.attempt_id}/finalize`, {method: 'POST', body: {fence: 1, execution: {status: 'canceled'}, coverage: {}, metrics: {}, final_cursor_expected: 0}});
  check('a run is scored from its verdicts only: failed cases count, canceled ones do not',
    (await api(`${base}/runs/${offlineRun.run_id}`, {cookie: alice.cookie})).body.run.score.scored === 1);

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
  // Which two of the four racers fit is the race's to say: settle one that was admitted.
  const admittedRacer = `race-${racers.findIndex(response => response.status === 201) + 1}`;
  const spentBefore = await spent();
  check('a settlement far past the call\'s reserve is refused, and one past the column\'s range is a 400, not a 500',
    (await settle(a2, admittedRacer, {outcome: 'settled', cost_usd: 1000, provenance: {}})).body.code === 'cost_exceeds_reserve'
    && (await settle(a2, admittedRacer, {outcome: 'settled', cost_usd: 1e13, provenance: {}})).status === 400
    && (await admit(a2, 1, 'huge', 1e13)).status === 400 && (await admit(a2, 2 ** 40, 'huge', 0.01)).status === 400
    && Math.abs(await spent() - spentBefore) < 1e-9);
  check('a settlement at the call\'s reserve is accepted', (await settle(a2, admittedRacer, {outcome: 'settled', cost_usd: 0.04, provenance: {}})).status === 200);
  const callsRun = (await api(`${base}/attempts/${a1}`, {cookie: alice.cookie})).body.attempt;
  check('an attempt shows its case kind, content digest and prompt', callsRun.kind === 'answer' && callsRun.content_digest === run.cases[0].content_digest && callsRun.prompt === run.cases[0].prompt && callsRun.prompt_sha256 === run.cases[0].prompt_sha256);

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
  check('a verifier\'s checks are names and statuses, come only with a verdict, and carry nothing else',
    (await finalize(a1, finalizeBody(3, {verdict: undefined, checks: [{name: 'sum', status: 'passed'}]}))).body.code === 'invalid_request'
    && (await finalize(a1, finalizeBody(3, {checks: [{name: 'sum', status: 'maybe'}]}))).body.code === 'invalid_request'
    && (await finalize(a1, finalizeBody(3, {checks: [{name: 'sum', status: 'passed', message: 'x = 3'}]}))).body.code === 'invalid_request'
    && (await finalize(a1, finalizeBody(3, {checks: [{name: '', status: 'passed'}]}))).body.code === 'invalid_request');
  check('a worker error has no verdict and no verifier error, and a case does not end as a free-form session does',
    (await finalize(a1, finalizeBody(3, {execution: {status: 'worker_error', reason: 'x'}}))).body.code === 'verdict_not_allowed'
    && (await finalize(a1, finalizeBody(3, {execution: {status: 'worker_error', reason: 'x'}, verdict: undefined, verifier_error: 'x'}))).body.code === 'verdict_not_allowed'
    && (await finalize(a1, finalizeBody(3, {execution: {status: 'canceled'}, verdict: undefined, verifier_error: 'x'}))).body.code === 'verdict_not_allowed'
    && (await finalize(a1, finalizeBody(3, {execution: {status: 'bogus'}}))).body.code === 'invalid_request'
    && (await finalize(a1, finalizeBody(3, {execution: {status: 'ended'}, verdict: undefined}))).body.code === 'invalid_status');
  const checkResults = [{name: 'sum is exact', status: 'failed'}, {name: 'schema', status: 'passed'}, {name: 'units', status: 'skipped'}];
  const sealedBody = finalizeBody(3, {verdict: 'fail', explanation: 'invalid_answer', checks: checkResults});
  const sealed = await finalize(a1, sealedBody);
  check('finalizing seals the attempt at its high-water mark', sealed.body.final_cursor === 3 && sealed.body.sealed && sealed.body.scoring_id === undefined);
  check('events after the seal are refused', (await post(a1, 1, [event('late', 9)])).body.code === 'sealed');
  check('a retried finalize answers the same', (await finalize(a1, sealedBody)).body.replayed === true);
  check('a different finalize is a conflicting duplicate', (await finalize(a1, finalizeBody(3, {verdict: 'pass'}))).body.code === 'conflicting_duplicate'
    && (await finalize(a1, finalizeBody(3, {verdict: 'fail', explanation: 'invalid_answer', checks: [{name: 'sum is exact', status: 'passed'}]}))).body.code === 'conflicting_duplicate');
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
  check('a run\'s summary in the list equals its detail: status, score and metric sums, with total tokens and elapsed time from the attempts',
    JSON.stringify(summary.score) === JSON.stringify(view.score) && summary.status === view.status && JSON.stringify(summary.metrics.total_tokens) === JSON.stringify(view.metrics.total_tokens)
    && JSON.stringify(summary.metrics.elapsed_ms) === JSON.stringify(view.metrics.elapsed_ms) && summary.metrics.total_tokens.total === 20 && summary.metrics.elapsed_ms.total === 200);

  // ── Rerun, verifier errors, uninstall ──
  await uninstall(alice, pluginId);
  const rerun = await api(`${base}/runs/${run.run_id}/cases/c1/rerun`, {method: 'POST', cookie: alice.cookie, body: {}});
  check('a rerun works after the plugin is uninstalled and makes a new attempt', rerun.status === 201 && rerun.body.attempt_no === 2);
  check('a case with an attempt in flight takes no rerun', (await api(`${base}/runs/${run.run_id}/cases/c1/rerun`, {method: 'POST', cookie: alice.cookie, body: {}})).body.code === 'attempt_active');
  check('a case the run does not have takes no rerun', (await api(`${base}/runs/${run.run_id}/cases/zz/rerun`, {method: 'POST', cookie: alice.cookie, body: {}})).body.code === 'unknown_case');
  const rerunJob = (await claim()).body;
  check('the rerun attempt is claimable with the retained artifacts', rerunJob.attempt_id === rerun.body.attempt_id && rerunJob.fence === 1
    && sha256((await worker(`attempts/${rerunJob.attempt_id}/package`, {headers: fenceHeader(1)})).body) === sha
    && sha256((await worker(`attempts/${rerunJob.attempt_id}/fixtures`, {headers: fenceHeader(1)})).body) === FIXTURES.sha256);
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
  const compared = await api(`${base}/compare?a=${run.run_id}&b=${offlineRun.run_id}`, {cookie: alice.cookie});
  check('two runs of one verifier compare: cases aligned by content, configuration differences, each shared case\'s prompt, and unverified egress',
    compared.status === 200 && compared.body.verifier.package_sha256 === sha && compared.body.shared.length === 2 && compared.body.only_a.length === 0 && compared.body.only_b.length === 0
    && compared.body.shared[0].a.case_id === 'c1' && compared.body.shared[1].a.verdict === 'pass' && compared.body.a.harness === 'claude' && compared.body.b.harness === 'codex'
    && ['harness', 'benchmark_id', 'limits.internet_access'].every(field => compared.body.differences.includes(field))
    && !compared.body.differences.includes('case_set_id') && !compared.body.differences.includes('model') && compared.body.unverified_egress.a === true && compared.body.unverified_egress.b === false
    && compared.body.prompt_diff.rendered.length === 2 && compared.body.prompt_diff.rendered.every(entry => entry.identical === true) && !('policy' in Object.fromEntries(compared.body.config.map(entry => [entry.field, 1]))));
  const attemptView = (await api(`${base}/attempts/${a1}`, {cookie: alice.cookie})).body.attempt;
  check('a sealed attempt shows its verdict explanation and the names and statuses of its verifier\'s checks', attemptView.verdict === 'fail' && attemptView.explanation === 'invalid_answer'
    && JSON.stringify(attemptView.checks) === JSON.stringify(checkResults));
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
  check('another member cannot compare a run they cannot see', (await api(`${base}/compare?a=${run.run_id}&b=${offlineRun.run_id}`, {cookie: bob.cookie})).status === 404);
  await api(`${base}/runs/${otherRun.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  await api(`${base}/runs/${crossRun.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});

  // ── Lease expiry, cancel ──
  await install(alice, pluginId);
  const newRun = async (key, benchmark = main.body.benchmark, harness = 'claude') => ({run: await sharedRun(alice, key, benchmark, harness)});
  const run2 = (await newRun(`key2-${token}`)).run;
  const leased = (await claim('slow')).body;
  await admit(leased.attempt_id, 1, 'swept', 0.01);
  await asSystem("update benchmark_attempt set lease_expires_at = now() - interval '1 minute' where attempt_id = $1", [leased.attempt_id]);
  await asSystem("update benchmark_admission set deadline_at = now() - interval '1 second' where call_id = 'call-2'");
  const next = await claim('fast');
  const expired = (await api(`${base}/attempts/${leased.attempt_id}`, {cookie: alice.cookie})).body.attempt;
  check('an expired lease ends the case\'s attempt as a worker error, not a failed case, and keeps its evidence', expired.state === 'final' && expired.execution.status === 'worker_error'
    && expired.execution.reason === 'The worker stopped renewing the attempt\'s lease' && expired.sealed && expired.verdict === null);
  check('the worker that lost its lease is refused', (await post(leased.attempt_id, 1, [event('z', 1)])).body.code === 'lease_lost');
  const swept = (await asSystem("select status, cost_usd::float8 as cost from benchmark_admission where call_id = 'call-2'")).rows[0];
  check('an overdue uncertain reservation settles at its reserved bound', swept.status === 'settled' && Math.abs(swept.cost - 0.4) < 1e-9);
  check('settlement is still accepted after the lease is lost', (await settle(leased.attempt_id, 'swept', {outcome: 'settled', cost_usd: 0.01, provenance: {}})).status === 200);
  const queuedRetry = (await api(`${base}/runs/${run2.run_id}`, {cookie: alice.cookie})).body.run.cases.find(c => c.case_id === expired.case_id).attempts;
  check('the case\'s next attempt is already queued, a rerun of the one that ended, so a rerun by hand waits for it',
    queuedRetry.length === 2 && queuedRetry[1].attempt_no === 2 && queuedRetry[1].state === 'queued' && queuedRetry[1].rerun_of === expired.attempt_id
    && (await api(`${base}/runs/${run2.run_id}/cases/${expired.case_id}/rerun`, {method: 'POST', cookie: alice.cookie, body: {}})).body.code === 'attempt_active');
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
  check('the periodic sweep ends an expired lease as a worker error and settles an overdue reservation with no claim or read',
    await eventually(async () => (await attemptState(stalled.attempt_id)).execution_status === 'worker_error' && (await admissionState(stalled.attempt_id, 'sweep-late')).status === 'settled'));
  const sweptRow = await admissionState(stalled.attempt_id, 'sweep-late');
  check('the overdue reservation settled at its reserved bound', Math.abs(sweptRow.cost - 0.01) < 1e-9);
  check('the other attempt of the run, still within its lease, stays leased', (await attemptState(renewing.attempt_id)).state === 'leased');
  const runView = (await api(`${base}/runs/${run3.run_id}`, {cookie: alice.cookie})).body.run;
  check('a member sees the stalled attempt as a worker error, not leased, and its case queued again',
    runView.cases.some(c => c.attempts.some(a => a.attempt_id === stalled.attempt_id && a.state === 'final' && a.execution.status === 'worker_error'))
    && runView.cases.some(c => c.attempts.some(a => a.rerun_of === stalled.attempt_id && a.state === 'queued')));

  // A member's read interrupts an expired attempt on its own, whatever the timer does.
  await asSystem("update benchmark_attempt set lease_expires_at = now() - interval '1 second' where attempt_id = $1", [renewing.attempt_id]);
  const readView = (await api(`${base}/attempts/${renewing.attempt_id}`, {cookie: alice.cookie})).body.attempt;
  check('a member read ends an attempt whose lease ran out', readView.state === 'final' && readView.execution.status === 'worker_error' && readView.sealed);
  // The retries of run3 are queued: cancel it before the claims below, which would take them.
  await api(`${base}/runs/${run3.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});

  // Sweeps racing renewals and claims: a renewed lease is never ended, an expired one is ended exactly once, with one retry queued.
  const raceRun = (await newRun(`key5-${token}`)).run;
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
  check('every expired lease ends as a worker error, once, and queues exactly one retry',
    (await attemptState(raced.attempt_id)).execution_status === 'worker_error' && (await attemptState(racedOther.attempt_id)).execution_status === 'worker_error'
    && (await asSystem("select count(*)::int as n from benchmark_attempt where run_id = $1 and execution_status = 'worker_error'", [raceRun.run_id])).rows[0].n === 2
    && (await asSystem("select count(*)::int as n from benchmark_attempt where run_id = $1 and attempt_no = 2 and rerun_of = any($2::uuid[])", [raceRun.run_id, [raced.attempt_id, racedOther.attempt_id]])).rows[0].n === 2
    && (await asSystem("select count(*)::int as n from benchmark_attempt where run_id = $1", [raceRun.run_id])).rows[0].n === 4);
  await api(`${base}/runs/${raceRun.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});

  // ── Racing claims: a run has no concurrency of its own ──
  check('a publication that still sends limits.concurrency is refused as an unknown limit',
    (await publish(alice, {...publication(`conc-${token}`, ['c1']), limits: {...runLimits, concurrency: 2}})).status === 400);
  const crowded = await newRun(`crowd-${token}`, crowd);
  const claimed = await Promise.all(Array.from({length: 8}, (_, n) => claim(`crowd-${n}`)));
  const racedClaims = claimed.filter(response => response.status === 200 && response.body.run.run_id === crowded.run.run_id);
  // A claim that finds the run held by another claim's transaction skips it (skip locked) and answers 204 for the worker's next poll, so how many of the racers
  // lease something depends on their timing; what never depends on it is that each attempt is leased once, and none is lost. A worker's next polls take the rest.
  const crowdClaims = [...racedClaims];
  for (let next = await claim('crowd-drain'); next.status === 200; next = await claim('crowd-drain')) crowdClaims.push(next);
  check('racing claims lease an attempt of a run once, with no cap of the run\'s own: every queued attempt is leased, each once',
    racedClaims.length >= 1 && claimed.every(response => response.status === 200 || response.status === 204) && crowdClaims.length === 4
    && crowdClaims.every(response => response.body.run.run_id === crowded.run.run_id) && new Set(crowdClaims.map(response => response.body.attempt_id)).size === 4
    && (await asSystem("select count(*)::int as n from benchmark_attempt where run_id = $1 and state = 'leased' and fence = 1", [crowded.run.run_id])).rows[0].n === 4
    && (await asSystem("select count(*)::int as n from benchmark_attempt where run_id = $1 and state = 'queued'", [crowded.run.run_id])).rows[0].n === 0);
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
  const storedBytes = async id => Number((await asSystem('select stored_bytes from benchmark_attempt where attempt_id = $1', [id])).rows[0].stored_bytes);
  check('the events an attempt stores are charged to its owner\'s storage', await storedBytes(bounded.attempt_id) >= 40 * 250_000);
  await asSystem('update benchmark_attempt set stored_bytes = $2 where attempt_id = $1', [bounded.attempt_id, 5 * 1024 * 1024 * 1024]);
  check('events past the member\'s storage quota are 413 storage_quota_exceeded', (await post(bounded.attempt_id, 1, [event('quota', 41)])).body.code === 'storage_quota_exceeded');
  await asSystem('update benchmark_attempt set stored_bytes = 0 where attempt_id = $1', [bounded.attempt_id]);
  check('a NUL character in an event is 400, not a database error',
    (await worker(`attempts/${bounded.attempt_id}/events`, {method: 'POST', headers: {'content-type': 'application/json'},
      raw: '{"fence":1,"events":[{"event_id":"nul","source":"s","kind":"k","sequence":41,"occurred_ns":"1","data":{"a":"x\\u0000y"}}]}'})).status === 400);
  // A trace read is cut at its byte budget: 400 spans of 30 KB are about 12 MB.
  await asSystem(`insert into benchmark_span (attempt_id, span_id, kind, name, attributes)
    select $1, 'fat-' || g, 'tool', 'n', jsonb_build_object('pad', repeat('x', 30000)) from generate_series(1, 400) g`, [bounded.attempt_id]);
  const fatTrace = await api(`${base}/attempts/${bounded.attempt_id}/spans?limit=5000`, {cookie: alice.cookie});
  check('a trace read stops at its byte budget and says it is truncated', fatTrace.status === 200 && fatTrace.body.truncated === true
    && fatTrace.body.spans.length > 0 && fatTrace.body.spans.length < 400 && fatTrace.text.length < 9 * 1024 * 1024);
  await asSystem("delete from benchmark_span where attempt_id = $1 and span_id like 'fat-%'", [bounded.attempt_id]);
  check('a trace under the budget is not truncated', (await api(`${base}/attempts/${bounded.attempt_id}/spans`, {cookie: alice.cookie})).body.truncated === false);
  await asSystem(`insert into benchmark_event (attempt_id, cursor, event_id, source, kind, sequence, data, digest)
    select $1, g, 'cap-' || g, 'worker', 'cap', g, '{}'::jsonb, 'seed' from generate_series(41, 100000) g`, [bounded.attempt_id]);
  await asSystem('update benchmark_attempt set next_cursor = 100001 where attempt_id = $1', [bounded.attempt_id]);
  const capReplay = await post(bounded.attempt_id, 1, bigEvents(1, 1));
  check('an identical event is replayed at the count cap without using another slot', capReplay.status === 200 && capReplay.body.receipts[0].duplicate === true
    && capReplay.body.receipts[0].cursor === 1 && capReplay.body.high_water_cursor === 100000);
  check('an attempt keeps a bounded number of events', (await post(bounded.attempt_id, 1, [event('over-1', 1), event('over-2', 2)])).body.code === 'too_many_events'
    && (await asSystem('select count(*)::int as n from benchmark_event where attempt_id = $1', [bounded.attempt_id])).rows[0].n === 100000);
  await asSystem("delete from benchmark_event where attempt_id = $1 and event_id like 'cap-%'", [bounded.attempt_id]);
  await asSystem('update benchmark_attempt set next_cursor = 41 where attempt_id = $1', [bounded.attempt_id]);
  await asSystem(`insert into benchmark_span (attempt_id, span_id, kind, name)
    select $1, 'cap-' || g, 'tool', 'n' from generate_series(1, 10000) g`, [bounded.attempt_id]);
  await asSystem(`insert into benchmark_link (attempt_id, kind, from_id, to_id)
    select $1, 'cap', 's' || g, 'root' from generate_series(1, 20000) g`, [bounded.attempt_id]);
  const cappedSpan = {id: 'cap-1', kind: 'tool', name: 'n', status: 'ok', end_ns: '2', attributes: {done: true}};
  const cappedLink = {kind: 'cap', from: 's1', to: 'root', method: 'recorded', attributes: {done: true}};
  const cappedTrace = body => worker(`attempts/${bounded.attempt_id}/spans`, {method: 'POST', body: {fence: 1, ...body}});
  check('existing spans and links can be updated at their count caps', (await cappedTrace({spans: [cappedSpan], links: [cappedLink]})).status === 200
    && (await asSystem("select status, end_ns::text, attributes from benchmark_span where attempt_id = $1 and span_id = 'cap-1'", [bounded.attempt_id])).rows[0].end_ns === '2'
    && (await asSystem("select method from benchmark_link where attempt_id = $1 and kind = 'cap' and from_id = 's1' and to_id = 'root'", [bounded.attempt_id])).rows[0].method === 'recorded');
  check('new spans and links past their count caps are refused atomically',
    (await cappedTrace({spans: [{...cappedSpan, status: 'changed'}, {...cappedSpan, id: 'over'}]})).body.code === 'too_many_spans'
    && (await cappedTrace({links: [{...cappedLink, from: 'over'}]})).body.code === 'too_many_spans'
    && (await asSystem("select count(*)::int as n from benchmark_span where attempt_id = $1 and (span_id = 'over' or status = 'changed')", [bounded.attempt_id])).rows[0].n === 0
    && (await asSystem('select count(*)::int as n from benchmark_link where attempt_id = $1', [bounded.attempt_id])).rows[0].n === 20000);
  await asSystem("delete from benchmark_span where attempt_id = $1 and span_id like 'cap-%'", [bounded.attempt_id]);
  await asSystem("delete from benchmark_link where attempt_id = $1 and kind = 'cap'", [bounded.attempt_id]);
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

  // ── Worker errors are retried ──
  // A worker's failure on a case is not a failed case: the case's next attempt is queued, a rerun of the one that ended, until the case has had
  // three attempts end so in a row; after the third the run is not graded, whatever its other cases scored.
  const retryRun = (await newRun(`retry-${token}`, single)).run;
  const workerError = (job, reason) => finalize(job.attempt_id, {fence: job.fence, execution: {status: 'worker_error', reason}, coverage: {}, metrics: {}, final_cursor_expected: 0});
  const tries = [];
  for (const reason of ['SandboxError: start_failed', 'the VM stopped answering', 'RuntimeError: the workspace volume vanished']) {
    const job = (await claim('wr')).body;
    tries.push(job);
    check(`attempt ${tries.length} of the run's one case is leased, ${tries.length === 1 ? 'the first' : 'the retry of the one before it'}`,
      job.run.run_id === retryRun.run_id && job.attempt_no === tries.length && (tries.length === 1 || tries[tries.length - 2].attempt_id !== job.attempt_id));
    check(`a worker error finalizes without a verdict${tries.length < 3 ? ' and queues the next attempt' : ', the third queues none'}`,
      (await workerError(job, reason)).status === 200
      && (await asSystem('select count(*)::int as n from benchmark_attempt where run_id = $1', [retryRun.run_id])).rows[0].n === (tries.length < 3 ? tries.length + 1 : 3));
    if (tries.length === 1) {
      const midway = (await api(`${base}/runs/${retryRun.run_id}`, {cookie: alice.cookie})).body.run;
      check('while the retry is queued the case reads as its newest attempt: not graded yet, not a worker error',
        midway.cases[0].attempts[0].execution.status === 'worker_error' && midway.cases[0].attempts[0].execution.reason === reason && midway.cases[0].attempts[1].state === 'queued'
        && midway.cases[0].attempts[1].rerun_of === job.attempt_id && midway.score.unavailable_reason === 'scoring_pending' && midway.status !== 'complete');
    }
  }
  const exhausted = (await api(`${base}/runs/${retryRun.run_id}`, {cookie: alice.cookie})).body.run;
  check('after the third worker error the run is not graded and is complete, with no fourth attempt claimable',
    exhausted.status === 'complete' && exhausted.score.value === null && exhausted.score.unavailable_reason === 'worker_error' && exhausted.cases[0].attempts.length === 3
    && (await claim('wr')).status === 204
    && (await api(`${base}/runs`, {cookie: alice.cookie})).body.runs.find(entry => entry.run_id === retryRun.run_id).score.unavailable_reason === 'worker_error');
  const byHand = await api(`${base}/runs/${retryRun.run_id}/cases/c2/rerun`, {method: 'POST', cookie: alice.cookie, body: {}});
  check('a member may still rerun the case by hand, which the retries do not count against', byHand.status === 201 && byHand.body.attempt_no === 4);
  await api(`${base}/runs/${retryRun.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});

  // ── A cancel racing a retry ──
  // A retry is queued by the transaction that ends the attempt (holding its row); a cancel locks the run first and then the leased attempts, so
  // whichever commits first, the retry is never left queued in a canceled run, where nothing would claim it. Two connections hold the interleavings.
  const systemTransaction = async () => {
    const client = await migrationPool.connect();
    await client.query('begin');
    await client.query("select set_config('app.user_id', '', true), set_config('app.workspace_id', '', true), set_config('app.benchmark_system', 'on', true)");
    return client;
  };
  const queuedIn = async runId => (await asSystem("select count(*)::int as n from benchmark_attempt where run_id = $1 and state = 'queued'", [runId])).rows[0].n;
  const settledWithin = async (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
  // The worker error is first: the cancel waits for the leased attempt's row, then cancels the retry the error queued.
  const raceA = (await newRun(`cancel-race-a-${token}`, single)).run;
  const leasedA = (await claim('cr-a')).body;
  const ending = await systemTransaction();
  await ending.query('select 1 from benchmark_attempt where attempt_id = $1 for update', [leasedA.attempt_id]);
  await expireLeases(ending, [leasedA.attempt_id]);
  const cancelA = api(`${base}/runs/${raceA.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  const waitedA = !(await settledWithin(cancelA, 600));
  await ending.query('commit');
  ending.release();
  const canceledA = await cancelA;
  check('a cancel that meets a worker error in flight waits for it, then cancels the retry it queued: none stays queued',
    waitedA && canceledA.status === 200 && await queuedIn(raceA.run_id) === 0
    && (await asSystem('select state, execution_status from benchmark_attempt where run_id = $1 order by attempt_no', [raceA.run_id])).rows.map(row => `${row.state}:${row.execution_status}`).join() === 'final:worker_error,final:canceled');
  // The cancel is first: the worker error finds the run canceled once it can read it, and queues no retry.
  const raceB = (await newRun(`cancel-race-b-${token}`, single)).run;
  const leasedB = (await claim('cr-b')).body;
  const canceling = await systemTransaction();
  await canceling.query('select run_id from benchmark_run where run_id = $1 for no key update', [raceB.run_id]);
  await canceling.query('update benchmark_run set canceled_at = now() where run_id = $1', [raceB.run_id]);
  await canceling.query("update benchmark_attempt set cancel_requested = true where run_id = $1 and state = 'leased'", [raceB.run_id]);
  const erroring = workerError(leasedB, 'the worker died').then(response => response);
  const waitedB = !(await settledWithin(erroring, 600));
  await canceling.query('commit');
  canceling.release();
  check('a worker error that meets a cancel in flight waits for it, and queues no retry in the canceled run',
    waitedB && (await erroring).status === 200 && await queuedIn(raceB.run_id) === 0
    && (await asSystem('select count(*)::int as n from benchmark_attempt where run_id = $1', [raceB.run_id])).rows[0].n === 1);
  // A lease that runs out in a run canceled before it is not retried either.
  const raceC = (await newRun(`cancel-race-c-${token}`, single)).run;
  const leasedC = (await claim('cr-c')).body;
  await api(`${base}/runs/${raceC.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  await asSystem("update benchmark_attempt set lease_expires_at = now() - interval '1 second' where attempt_id = $1", [leasedC.attempt_id]);
  const expiredC = (await api(`${base}/attempts/${leasedC.attempt_id}`, {cookie: alice.cookie})).body.attempt;
  check('a lease that runs out in a canceled run ends as a worker error and is not retried', expiredC.execution.status === 'worker_error' && await queuedIn(raceC.run_id) === 0
    && (await asSystem('select count(*)::int as n from benchmark_attempt where run_id = $1', [raceC.run_id])).rows[0].n === 1);

  // ── Capabilities shrink ──
  const shrunk = await claim('small', {capabilities: {...CAPS, memory_mb: 512}});
  const exceeding = await submitRun(alice, `shrunk-${token}`, main.body.benchmark);
  const smallRun = await submitRun(alice, `small-${token}`, small);
  check('a run whose limits the workers no longer cover is refused, not queued, and so is a publication',
    shrunk.status === 204 && exceeding.status === 400 && exceeding.body.code === 'limit_exceeds_worker' && smallRun.status === 201
    && (await publish(alice, publication(`big-${token}`, ['c1'], {limits: {...runLimits, memory_mb: 1024}}))).body.code === 'limit_exceeds_worker');
  await api(`${base}/runs/${smallRun.body.run.run_id}/cancel`, {method: 'POST', cookie: alice.cookie});
  check('a retry of an accepted submission still returns its run', (await submitRun(alice, `key-${token}`, main.body.benchmark)).body.replayed === true);
  await claim('big');

  // ── A worker that stops pricing the model ──
  await claim('repriced', {capabilities: {...CAPS, models: ['elsewhere/model']}});
  const unpriced = await publish(alice, publication(`unpriced-${token}`, ['c1']));
  check('a run and a publication are refused once no worker prices the benchmark\'s model, rather than queueing runs that would never run',
    unpriced.status === 400 && unpriced.body.code === 'unknown_model' && unpriced.body.models.join() === 'elsewhere/model' && await benchmarkRows(`unpriced-${token}`) === 0
    && (await submitRun(alice, `unpriced-${token}`, main.body.benchmark)).body.code === 'unknown_model');
  await claim('priced-again');
  check('the schema holds no suite, scoring, hook, preview or harness-source table', (await asSystem(
    `select count(*)::int as n from information_schema.tables where table_name like 'benchmark_suite%' or table_name in ('benchmark_scoring', 'benchmark_run_suite', 'benchmark_preview', 'benchmark_source', 'benchmark_harness_version')`)).rows[0].n === 0);

  // ── Bounded run reads ──
  // 300 reruns of 60 KB metrics must not reach the summary: it holds each case's newest attempt and the metric fields the sum reads.
  await asSystem(`insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no, state, execution_status, metrics)
    select gen_random_uuid(), $1, 'c1', 3 + g, 'final', 'answered', jsonb_build_object('total_tokens', g, 'pad', repeat('x', 60000)) from generate_series(1, 300) g`, [run.run_id]);
  const runSummaryRow = (await as({userId: alice.id, workspaceId: w1.id},
    `select jsonb_array_length(attempts) as n, octet_length(attempts::text) as size, attempts::text like '%pad%' as padded,
       (select count(*)::int from benchmark_run_case where run_id = $1) as cases, attempts
       from benchmark_run_summary where run_id = $1`, [run.run_id])).rows[0];
  check('a run summary holds one attempt per case and only the metrics the sum reads', runSummaryRow.n === runSummaryRow.cases && runSummaryRow.size < 5000 && !runSummaryRow.padded
    && runSummaryRow.attempts.find(attempt => attempt.case_id === 'c1').metrics.total_tokens === 300);
  const withReruns = await api(`${base}/runs/${run.run_id}`, {cookie: alice.cookie});
  check('the run still reads, with 300 reruns, and sums only each case\'s newest attempt', withReruns.status === 200 && withReruns.body.run.metrics.total_tokens.total >= 300
    && (await api(`${base}/runs`, {cookie: alice.cookie})).body.runs.find(entry => entry.run_id === run.run_id).metrics.total_tokens.total >= 300);
  check('a case takes no rerun past its attempt cap, 409 too_many_attempts',
    (await api(`${base}/runs/${run.run_id}/cases/c1/rerun`, {method: 'POST', cookie: alice.cookie, body: {}})).body.code === 'too_many_attempts');
  await asSystem("delete from benchmark_attempt where run_id = $1 and case_id = 'c1' and attempt_no > 3", [run.run_id]);

  // ── Publications, one at a time ──
  // A publication's body is held several times over while it is read, so a member has one in flight: a second is refused, not queued, and the
  // slot comes back when the first connection goes.
  const slow = http.request(`${origin}/api/benchmark/benchmarks`, {method: 'POST', headers: {
    cookie: alice.cookie, 'content-type': 'application/json', 'content-length': '1000', 'x-real-ip': clientIp, origin,
  }});
  slow.on('error', () => {});
  slow.write('{"name":');
  await sleep(300);
  const inFlight = await publish(alice, publication(`inflight-${token}`, ['c1']));
  check('a second publication of a member while the first is being read is refused 429 publish_in_progress, and another member\'s is not',
    inFlight.status === 429 && inFlight.body.code === 'publish_in_progress' && await benchmarkRows(`inflight-${token}`) === 0
    && (await publish(bob, publication(`bobs-inflight-${token}`, ['c1']))).status === 201);
  slow.destroy();
  const slotBack = await eventually(async () => (await publish(alice, publication(`inflight-${token}`, ['c1']))).status === 201);
  check('the slot comes back when the first connection closes', slotBack && await benchmarkRows(`inflight-${token}`) === 1);

  // ── Fixtures and the storage quota ──
  // Two publications of one member that keep the same new archive at once charge it once: the second finds it kept, though its first look came before
  // the first committed. The first is held at the storage lock with its row inserted, and the quota left fits exactly one archive.
  const RACE = fixturesOf(`race ${token}`, {'inputs/b.csv': sha256('b')});
  const FULL = fixturesOf(`full ${token}`, {'inputs/c.csv': sha256('c')});
  fixturesDigests.push(RACE.sha256, FULL.sha256);
  const raceSize = Buffer.from(RACE.archive, 'base64').length;
  const storedOf = async () => Number((await asSystem('select stored_bytes from benchmark_attempt where attempt_id = $1', [a1])).rows[0].stored_bytes);
  const usedBy = async () => Number((await asSystem(
    `select (select coalesce(sum(octet_length(archive)), 0) from benchmark_fixtures where publisher_id = $1)
          + (select coalesce(sum(p.size), 0) from benchmark_payload p join benchmark_attempt a on a.attempt_id = p.attempt_id join benchmark_run r on r.run_id = a.run_id where r.user_id = $1)
          + (select coalesce(sum(a.stored_bytes), 0) from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id where r.user_id = $1) as used`, [alice.id])).rows[0].used);
  const storedBefore = await storedOf();
  await asSystem('update benchmark_attempt set stored_bytes = 0 where attempt_id = $1', [a1]);
  const baseUsed = await usedBy();
  await asSystem('update benchmark_attempt set stored_bytes = $2 where attempt_id = $1', [a1, MEMBER_STORAGE_BYTES - raceSize - baseUsed]);
  const fixturesFrom = async digest => (await asSystem('select count(*)::int as n from benchmark_fixtures where sha256 = $1', [digest])).rows[0].n;
  const withFixtures = (name, fixtures) => {
    const body = publication(name, ['c1']);
    body.cases = [{...body.cases[0], fixtures}];
    return body;
  };
  const firstKeeper = await systemTransaction();
  await firstKeeper.query("select set_config('app.user_id', $1, true)", [alice.id]);
  await firstKeeper.query("select pg_advisory_xact_lock(hashtext($1))", [`benchmark_storage:${alice.id}`]);
  await firstKeeper.query('insert into benchmark_fixtures (sha256, publisher_id, archive) values ($1, $2, $3)', [RACE.sha256, alice.id, Buffer.from(RACE.archive, 'base64')]);
  const racing = publish(alice, withFixtures(`fixtures-race-${token}`, RACE));
  const racingWaited = !(await settledWithin(racing, 600));
  await firstKeeper.query('commit');
  firstKeeper.release();
  const keptAnswer = await racing;
  check('a publication that meets the same new archive in another transaction waits for it and finds it kept, charging it once',
    racingWaited && keptAnswer.status === 201 && await fixturesFrom(RACE.sha256) === 1 && await usedBy() === MEMBER_STORAGE_BYTES);
  const overQuota = await publish(alice, withFixtures(`fixtures-full-${token}`, FULL));
  check('a new archive past the member\'s storage quota is refused 413 storage_quota_exceeded, and nothing of it is stored',
    overQuota.status === 413 && overQuota.body.code === 'storage_quota_exceeded' && await fixturesFrom(FULL.sha256) === 0 && await benchmarkRows(`fixtures-full-${token}`) === 0);
  await asSystem('update benchmark_attempt set stored_bytes = $2 where attempt_id = $1', [a1, storedBefore]);
  const underQuota = await publish(alice, withFixtures(`fixtures-full-${token}`, FULL));
  check('the same archive is kept once the quota has room', underQuota.status === 201 && await fixturesFrom(FULL.sha256) === 1);

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
  await asSystem('delete from benchmark_fixtures where sha256 = any($1::text[])', [fixturesDigests]).catch(() => {});
  await migrationPool.query('delete from rate_limit_bucket where key like $1', [`%${clientIp}%`]).catch(() => {});
  if (savedPolicy) {
    await migrationPool.query('update platform_policy set signup_mode = $1, max_workspaces_per_user = $2',
      [savedPolicy.signup_mode, savedPolicy.max_workspaces_per_user]).catch(() => {});
  }
  nano?.close();
  await runtimePool.end();
  await migrationPool.end();
}
