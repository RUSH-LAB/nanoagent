#!/usr/bin/env node
/**
 * Migration 0055 removes `concurrency` from the limits stored with benchmarks, runs and previews, and touches nothing
 * else. The database is already migrated, so the test seeds rows as an old deployment left them and applies the
 * migration's SQL again, in a transaction it rolls back. Foreign keys are off for the seed (replica role): the rows
 * need only the columns the migration reads.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {createPool} = require('../../../src/server/postgres/client.js');

if (!process.env.DATABASE_MIGRATION_URL) throw new Error('DATABASE_MIGRATION_URL is required');

const migration = fs.readFileSync(fileURLToPath(new URL('../../../src/server/postgres/migrations/0055_benchmark_limits_no_concurrency.sql', import.meta.url)), 'utf8');
const pool = createPool({...process.env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL}, {max: 1});
const client = await pool.connect();
const uuid = () => crypto.randomUUID();
const hex = () => crypto.randomBytes(32).toString('hex');
const kept = {wall_time_ms: 600000, max_model_calls: 50};
const withConcurrency = {...kept, concurrency: 4};

try {
  await client.query('begin');
  await client.query("set local session_replication_role = 'replica'");
  const [benchmarkOld, benchmarkNew, runOld, runNew, previewOld, previewNew] = [uuid(), uuid(), uuid(), uuid(), uuid(), uuid()];
  for (const [id, limits] of [[benchmarkOld, withConcurrency], [benchmarkNew, kept]]) {
    await client.query(
      `insert into benchmark (benchmark_id, name, plugin_id, plugin_version, case_set_id, model, endpoint_label, limits, coding_template, task_instructions, digest, publisher_id)
       values ($1, $2, 'p', '1', 'c', 'm', 'e', $3, '', '', $4, 'u')`, [id, `n-${id}`, JSON.stringify(limits), hex()]);
  }
  for (const [id, limits] of [[runOld, withConcurrency], [runNew, kept]]) {
    await client.query(
      `insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, preview_id, source_sha256, model, endpoint_label, dialects, policy, prompt_text, limits,
         selection, renderer_version, benchmark_id, benchmark_name, harness_name, harness_version, case_set_id, case_set_digest, publisher, plugin_id, plugin_name, version,
         package_sha256, task_id, task, context)
       values ($1, 'w', 'u', $4, $2, $1, $2, 'm', 'e', '[]', 'coding', '', $3, '{}', 'r', $1, 'b', 'h', '1', 'c', $2, '{}', 'p', 'p', '1', $2, 't', '{}', '')`,
      [id, hex(), JSON.stringify(limits), `key-${id}`]);
  }
  for (const [id, plan] of [[previewOld, {limits: withConcurrency, model: 'm'}], [previewNew, {limits: kept, model: 'm'}]]) {
    await client.query("insert into benchmark_preview (preview_id, workspace_id, user_id, plan, plan_digest) values ($1, 'w', 'u', $2, 'd')", [id, JSON.stringify(plan)]);
  }

  await client.query(migration);

  const limitsOf = async (table, key, id) => (await client.query(`select limits from ${table} where ${key} = $1`, [id])).rows[0].limits;
  assert.deepEqual(await limitsOf('benchmark', 'benchmark_id', benchmarkOld), kept, 'a benchmark loses concurrency');
  assert.deepEqual(await limitsOf('benchmark', 'benchmark_id', benchmarkNew), kept, 'a benchmark without it is unchanged');
  assert.deepEqual(await limitsOf('benchmark_run', 'run_id', runOld), kept, 'a run loses concurrency');
  assert.deepEqual(await limitsOf('benchmark_run', 'run_id', runNew), kept, 'a run without it is unchanged');
  const plans = new Map((await client.query('select preview_id, plan from benchmark_preview where preview_id = any($1::uuid[])', [[previewOld, previewNew]])).rows.map(row => [row.preview_id, row.plan]));
  assert.deepEqual(plans.get(previewOld), {limits: kept, model: 'm'}, 'a preview keeps its plan, minus concurrency');
  assert.deepEqual(plans.get(previewNew), {limits: kept, model: 'm'}, 'a preview without it is unchanged');
  const forced = (await client.query("select relname, relforcerowsecurity from pg_class where relname in ('benchmark', 'benchmark_run', 'benchmark_preview')")).rows;
  assert.ok(forced.length === 3 && forced.every(row => row.relforcerowsecurity), 'row-level security is forced again on all three tables');
  console.log('benchmark limits migration: 7 checks passed');
} finally {
  await client.query('rollback').catch(() => {});
  client.release();
  await pool.end();
}
