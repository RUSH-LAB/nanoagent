'use strict';
const {escapeLiteral, types} = require('pg');
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

/** Nanosecond values are bigints; JSON carries them as decimal strings. */
const NS = /^-?\d{1,19}$/;
function nanoseconds(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && NS.test(value)) return value;
  return undefined;
}

module.exports = {inTransaction, nanoseconds};
