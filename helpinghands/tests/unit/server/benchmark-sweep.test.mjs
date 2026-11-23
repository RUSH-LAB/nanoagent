import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createPostgresBenchmarkWorker} = require('../../../src/server/postgres/benchmark-worker.js');
const {createPostgresBenchmark} = require('../../../src/server/postgres/benchmark.js');
const {sweepExpired} = require('../../../src/server/postgres/benchmark-sweep.js');

/** A pool whose clients record every statement and answer none. */
function recordingPool() {
  const transactions = [];
  return {
    transactions,
    async connect() {
      const statements = [];
      transactions.push(statements);
      return {
        async query(sql) {
          statements.push(String(sql.text ?? sql).replace(/\s+/g, ' ').trim());
          return {rows: [], rowCount: 0};
        },
        release() {},
      };
    },
  };
}

const {DEFAULT_LIMITS} = require('../../../src/server/benchmark/limits.js');

const config = {leaseSeconds: 60, uncertainDeadlineSeconds: 3600, memberBudgetUsd: 25, workspaceBudgetUsd: 100};

describe('benchmark expiry sweep', () => {
  test('ends expired attempts and settles overdue reservations, each taking only unlocked rows', async () => {
    const pool = recordingPool();
    const client = await pool.connect();
    await sweepExpired(client);
    const [attempts, admissions] = pool.transactions[0];
    assert.match(attempts, /select attempt_id from benchmark_attempt where state = 'leased' and lease_expires_at < now\(\).*for update skip locked/);
    assert.match(admissions, /update benchmark_admission set status = 'settled', cost_usd = reserve_usd.*deadline_at < now\(\).*for update skip locked/);
    assert.equal(pool.transactions[0].length, 2);
  });

  test('the worker sweeps in one system transaction without a claim', async () => {
    const pool = recordingPool();
    await createPostgresBenchmarkWorker({pool, config}).sweep();
    const [transaction] = pool.transactions;
    assert.equal(pool.transactions.length, 1);
    assert.ok(transaction.some(sql => sql.includes("app.benchmark_system', 'on'")));
    assert.equal(transaction.filter(sql => sql.includes('skip locked')).length, 2);
    assert.equal(transaction.at(-1), 'commit');
  });

  test('a claim sweeps before it leases anything', async () => {
    const pool = recordingPool();
    assert.equal(await createPostgresBenchmarkWorker({pool, config}).claim('u', 'w', 'mock', {...DEFAULT_LIMITS, models: ['vendor/model']}, false), null);
    const sql = pool.transactions[0];
    const lastSweep = sql.findLastIndex(statement => statement.includes('skip locked') && statement.startsWith('update'));
    const firstSelect = sql.findIndex(statement => statement.startsWith('select r.run_id, r.limits from benchmark_run'));
    assert.ok(lastSweep >= 0 && firstSelect > lastSweep);
  });

  test('a member reading a run, an attempt, the run list or accounting sweeps first, as the system', async () => {
    for (const read of [
      repository => repository.run({userId: 'u', workspaceId: 'w'}, 'r'),
      repository => repository.attempt({userId: 'u', workspaceId: 'w'}, 'a'),
      repository => repository.listRuns({userId: 'u', workspaceId: 'w'}, {limit: 10, before: null}),
      repository => repository.accounting({userId: 'u', workspaceId: 'w'}, 'a'),
    ]) {
      const pool = recordingPool();
      await read(createPostgresBenchmark({pool}));
      const [first, second] = pool.transactions;
      assert.ok(first.some(sql => sql.includes("app.benchmark_system', 'on'")) && first.filter(sql => sql.includes('skip locked')).length === 2);
      assert.ok(second.every(sql => !sql.includes('skip locked')));
    }
  });

  test('a failing sweep rolls back and releases the connection', async () => {
    let released = false;
    const statements = [];
    const pool = {
      async connect() {
        return {
          async query(sql) {
            const text = String(sql.text ?? sql);
            statements.push(text.trim().split(/\s+/)[0]);
            if (text.includes('benchmark_admission')) throw new Error('boom');
            return {rows: []};
          },
          release() { released = true; },
        };
      },
    };
    await assert.rejects(createPostgresBenchmarkWorker({pool, config}).sweep(), /boom/);
    assert.ok(statements.includes('rollback') && released);
  });
});
