import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {describe, test} from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createPostgresBenchmarkWorker} = require('../../../src/server/postgres/benchmark-worker.js');
const benchmarkWorkerRoute = require('../../../src/server/routes/benchmark-worker.js');
const {checkWorkers} = require('../../../src/server/benchmark/plan.js');
const {DEFAULT_LIMITS} = require('../../../src/server/benchmark/limits.js');

const config = {leaseSeconds: 60, uncertainDeadlineSeconds: 3600, memberBudgetUsd: 25, workspaceBudgetUsd: 100};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/** A pool whose clients record every statement with its values, answering `answers[prefix]` rows for a statement starting with that prefix. */
function recordingPool(answers = {}) {
  const statements = [];
  return {
    statements,
    async connect() {
      return {
        async query(sql, values) {
          const text = String(sql.text ?? sql).replace(/\s+/g, ' ').trim();
          const params = sql.values ?? values ?? [];
          statements.push({text, params});
          const key = Object.keys(answers).find(prefix => text.startsWith(prefix));
          return key ? {rows: answers[key], rowCount: answers[key].length} : {rows: [], rowCount: 0};
        },
        release() {},
      };
    },
  };
}

describe('benchmark worker credentials', () => {
  test('mints a random token and stores only its SHA-256, as the member', async () => {
    const pool = recordingPool({'insert into benchmark_worker_credential': [{created_at: 'now'}]});
    const worker = createPostgresBenchmarkWorker({pool, config});
    const first = await worker.mintCredential('user-a', 'laptop');
    const second = await worker.mintCredential('user-a', 'laptop');
    assert.match(first.token, /^rwk_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.token, second.token);
    const insert = pool.statements.find(s => s.text.startsWith('insert into benchmark_worker_credential'));
    assert.deepEqual(insert.params.slice(1), ['user-a', 'laptop', sha256(first.token)]);
    assert.ok(pool.statements.every(s => !s.params.includes(first.token)), 'the token itself is never sent to the database');
    assert.ok(pool.statements.some(s => s.text.includes("set_config('app.user_id', 'user-a'") && s.text.includes("set_config('app.benchmark_system', 'off'")));
  });

  test('resolves a bearer by the hash of an unrevoked credential, and refuses any other', async () => {
    const known = recordingPool({'update benchmark_worker_credential': [{user_id: 'user-a'}]});
    assert.equal(await createPostgresBenchmarkWorker({pool: known, config}).authenticate('rwk_x'), 'user-a');
    const lookup = known.statements.find(s => s.text.startsWith('update benchmark_worker_credential'));
    assert.match(lookup.text, /token_sha256 = \$1 and revoked_at is null/);
    assert.deepEqual(lookup.params, [sha256('rwk_x')]);
    assert.equal(await createPostgresBenchmarkWorker({pool: recordingPool(), config}).authenticate('rwk_x'), null);
  });

  test('revokes only the member\'s own credential, and answers null for any other', async () => {
    const pool = recordingPool();
    assert.equal(await createPostgresBenchmarkWorker({pool, config}).revokeCredential('user-a', 'c1'), null);
    const revoke = pool.statements.find(s => s.text.startsWith('update benchmark_worker_credential'));
    assert.match(revoke.text, /revoked_at = coalesce\(revoked_at, now\(\)\) where credential_id = \$1 and user_id = \$2/);
    assert.deepEqual(revoke.params, ['c1', 'user-a']);
  });

  test('a claim leases only the credential\'s member\'s runs and keeps capabilities per member and label', async () => {
    const pool = recordingPool();
    await createPostgresBenchmarkWorker({pool, config}).claim('user-a', 'w', 'mock', {...DEFAULT_LIMITS, models: ['vendor/model']});
    const select = pool.statements.find(s => s.text.startsWith('select r.run_id, r.limits from benchmark_run'));
    assert.match(select.text, /r\.user_id = \$1 and r\.endpoint_label = \$2/);
    assert.deepEqual(select.params, ['user-a', 'mock']);
    const advertise = pool.statements.find(s => s.text.startsWith('insert into benchmark_worker_capability'));
    assert.match(advertise.text, /on conflict \(user_id, endpoint_label\)/);
    assert.deepEqual(advertise.params.slice(0, 3), ['user-a', 'mock', 'w']);
  });

  test('a lease renewal keeps its member\'s worker advertised for the attempt\'s label', async () => {
    const future = new Date(Date.now() + 60_000);
    const pool = recordingPool({
      'select a.*': [{fence: 3, state: 'leased', execution_status: 'running', lease_expires_at: future, endpoint_label: 'openrouter'}],
      'select $1::timestamptz < now()': [{expired: false}],
      'update benchmark_attempt set lease_expires_at': [{lease_expires_at: future}],
    });
    await createPostgresBenchmarkWorker({pool, config}).renew('user-a', 'attempt-1', 3);
    const seen = pool.statements.find(s => s.text.startsWith('update benchmark_worker_capability set updated_at = now()'));
    assert.match(seen.text, /where user_id = \$1 and endpoint_label = \$2/);
    assert.deepEqual(seen.params, ['user-a', 'openrouter']);
  });

  test('a fenced route finds only the member\'s own attempts', async () => {
    const pool = recordingPool();
    await assert.rejects(createPostgresBenchmarkWorker({pool, config}).renew('user-b', 'attempt-1', 1), {code: 'unknown_attempt', status: 404});
    const lookup = pool.statements.find(s => s.text.includes('from benchmark_attempt a join benchmark_run r'));
    assert.match(lookup.text, /a\.attempt_id = \$1 and r\.user_id = \$2/);
    assert.deepEqual(lookup.params, ['attempt-1', 'user-b']);
  });
});

describe('benchmark worker API authentication', () => {
  const call = async ({authorization, userId = null}) => {
    const sent = [];
    const ctx = {
      readBody: async () => ({}), json: (res, status, data) => sent.push({status, data}),
      benchmark: {worker: {authenticate: async token => (token === 'rwk_good' ? userId : null)}},
    };
    await benchmarkWorkerRoute({method: 'POST', headers: {authorization}}, {}, null, '/api/benchmark-worker/claim', ctx);
    return sent[0];
  };

  test('answers 401 for no bearer, an unknown one, a revoked one and another scheme', async () => {
    for (const authorization of [undefined, 'Bearer rwk_bad', 'Basic rwk_good', 'Bearer ']) {
      const sent = await call({authorization});
      assert.equal(sent.status, 401);
      assert.equal(sent.data.code, 'unauthorized');
    }
  });

  test('lets a known credential through to the route', async () => {
    const sent = await call({authorization: 'Bearer rwk_good', userId: 'user-a'});
    assert.equal(sent.status, 400);
    assert.equal(sent.data.code, 'invalid_request');
  });
});

describe('run creation needs the member\'s own worker', () => {
  test('refuses with worker_unavailable, telling the member to start RUSH Lab with Docker running', () => {
    assert.throws(() => checkWorkers(DEFAULT_LIMITS, 'vendor/model', null, 'mock'), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'worker_unavailable');
      assert.match(error.message, /start RUSH Lab with Docker running/);
      return true;
    });
  });
});
