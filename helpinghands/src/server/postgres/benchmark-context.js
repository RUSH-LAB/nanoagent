'use strict';
const {escapeLiteral, types} = require('pg');
const {BenchmarkError} = require('../benchmark/errors');
const {MAX_BIGINT, MEMBER_STORAGE_BYTES} = require('../benchmark/limits');
const {parseJson} = require('../benchmark/json');

const JSON_TYPE = 114;
// The `json` columns (a case's arguments, a task, a reference) keep the spelling of their numbers; every other type reads as pg reads it.
const LOSSLESS = {getTypeParser: (oid, format) => (oid === JSON_TYPE ? parseJson : types.getTypeParser(oid, format))};

/** What an operation queries with: `client.query`, with `json` columns read with every number's spelling kept. */
const lossless = client => ({query: (sql, values) => client.query({...(typeof sql === 'string' ? {text: sql, values} : sql), types: LOSSLESS})});

/**
 * One transaction with the identity row-level security reads: `userId` and `workspaceId` for a
 * member, and with `system` the benchmark worker API's right to write runs (migration 0052). A
 * member's reads pass no `system`; their own policies decide what they see.
 */
async function inTransaction(pool, {userId = null, workspaceId = null, system = false}, operation) {
  const client = await pool.connect();
  try {
    await client.query(`begin; select set_config('app.user_id', ${escapeLiteral(userId ?? '')}, true),
      set_config('app.workspace_id', ${escapeLiteral(workspaceId ?? '')}, true),
      set_config('app.benchmark_system', ${escapeLiteral(system ? 'on' : 'off')}, true)`);
    const result = await operation(lossless(client));
    await client.query('commit');
    return result;
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Refuse `bytes` more of member `userId`'s storage (source ZIPs, attempt payloads and the evidence an attempt stores) if it would pass MEMBER_STORAGE_BYTES. Call it in the
 * transaction that inserts: the advisory lock makes concurrent uploads of one member count each other. The total spans all the member's
 * workspaces, so it alone is read as the system; the transaction's own rights are restored for the insert that follows.
 */
async function chargeStorage(client, userId, bytes) {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`benchmark_storage:${userId}`]);
  const {prior} = (await client.query("select coalesce(current_setting('app.benchmark_system', true), 'off') as prior")).rows[0];
  await client.query("select set_config('app.benchmark_system', 'on', true)");
  const {used} = (await client.query(
    `select (select coalesce(sum(size), 0) from benchmark_source where user_id = $1)
          + (select coalesce(sum(p.size), 0) from benchmark_payload p join benchmark_attempt a on a.attempt_id = p.attempt_id
              join benchmark_run r on r.run_id = a.run_id where r.user_id = $1)
          + (select coalesce(sum(a.stored_bytes), 0) from benchmark_attempt a join benchmark_run r on r.run_id = a.run_id where r.user_id = $1) as used`, [userId],
  )).rows[0];
  await client.query("select set_config('app.benchmark_system', $1, true)", [prior]);
  if (Number(used) + bytes > MEMBER_STORAGE_BYTES) {
    throw new BenchmarkError(413, 'storage_quota_exceeded', `This would pass the ${MEMBER_STORAGE_BYTES} bytes of benchmark storage a member may keep (${used} in use)`);
  }
}

/**
 * Charge `bytes` of evidence (events, spans, links, accounting, provenance) stored for attempt `attemptId` to member `userId`'s storage, once per
 * request with the request's total. The attempt keeps the count, so deleting its run frees it.
 */
async function chargeAttemptStorage(client, userId, attemptId, bytes) {
  await chargeStorage(client, userId, bytes);
  await client.query('update benchmark_attempt set stored_bytes = stored_bytes + $2 where attempt_id = $1', [attemptId, bytes]);
}

/** Whether `sql`, a `select 1 ...`, finds a row. */
async function exists(client, sql, values) {
  return (await client.query(sql, values)).rowCount > 0;
}

/** The bytes of `value` as JSON text, which is what a stored `jsonb` of it is charged as. */
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

/** What a statement sets to end an attempt, after its `state = 'final'` and `execution_status`: finalized now, its events sealed at the last cursor. */
const SEAL = 'finalized_at = now(), sealed = true, final_cursor = next_cursor - 1';

/** Nanosecond values are bigints; JSON carries them as decimal strings. */
const NS = /^-?\d{1,19}$/;
function nanoseconds(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  // Within bigint, which 19 digits can pass.
  if (typeof value === 'string' && NS.test(value) && BigInt(value) <= MAX_BIGINT && BigInt(value) >= -MAX_BIGINT - 1n) return value;
  return undefined;
}

module.exports = {SEAL, chargeAttemptStorage, chargeStorage, exists, inTransaction, jsonBytes, nanoseconds};
