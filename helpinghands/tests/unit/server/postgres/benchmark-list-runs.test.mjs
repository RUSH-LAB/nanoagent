/**
 * Paging a member's runs through the real SQL (PGlite, every migration applied): the first page and every later one order and cut by the
 * same key, the creation time truncated to the millisecond a `before` cursor carries, then the run id.
 */
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {as, migratedDatabase, pgQuery} from '../fs/_pglite.mjs';

const require = createRequire(import.meta.url);
const {createPostgresBenchmark} = require('../../../../src/server/postgres/benchmark.js');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Runs 1 to 3 were created in one millisecond (microseconds apart), in the order of their ids reversed; 4 is older and 5 newer.
const CREATED = {1: '2026-01-01 00:00:00.123900+00', 2: '2026-01-01 00:00:00.123500+00', 3: '2026-01-01 00:00:00.123100+00', 4: '2026-01-01 00:00:00.100000+00', 5: '2026-01-01 00:00:00.200000+00'};
const EXPECTED = [5, 1, 2, 3, 4].map(id);

let db;
let repository;

/** Every run of alice's, `limit` at a time, as the route pages: the next page's `before` is the last row's time and `before_id` its id. */
async function pages(limit) {
  const seen = [];
  let cursor = {before: null, beforeId: null};
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await repository.listRuns(as('alice'), {limit, ...cursor});
    seen.push(...page.map(run => run.run_id));
    if (page.length < limit) return seen;
    const last = page.at(-1);
    cursor = {before: new Date(last.created_at).toISOString(), beforeId: last.run_id};
  }
  throw new Error('paging did not end');
}

describe('listing a member\'s runs', () => {
  before(async () => {
    const migrated = await migratedDatabase();
    db = migrated.db;
    const pool = {
      async connect() {
        const client = await migrated.pool.connect();
        const query = pgQuery(db);
        const counted = result => ({...result, rowCount: result.rows.length || result.rowCount});
        return {...client, query: (sql, values) => (typeof sql === 'string' ? query(sql, values) : query(sql.text, sql.values)).then(result => (Array.isArray(result) ? result : counted(result)))};
      },
    };
    repository = createPostgresBenchmark({pool});
    for (const [n, created] of Object.entries(CREATED)) {
      await db.exec(`
        insert into benchmark_run (run_id, workspace_id, user_id, idempotency_key, request_digest, model, endpoint_label, limits, benchmark_id, benchmark_name,
            harness_name, publisher, plugin_id, created_at)
          values ('${id(n)}', 'lab', 'alice', 'k${n}', '${sha256(n)}', 'm', 'openrouter', '{}', '${id(n)}', 'b', 'claude', '{}', 'p', '${created}');
        insert into benchmark_run_case (run_id, case_id, position, kind, prompt, prompt_sha256, arguments, content_digest)
          values ('${id(n)}', 'c1', 0, 'answer', 'x', '${sha256('x')}', '{}', '${sha256(n)}');
        insert into benchmark_attempt (attempt_id, run_id, case_id, attempt_no) values ('${id(Number(n) + 100)}', '${id(n)}', 'c1', 1);`);
    }
  });

  after(async () => db?.close());

  it('orders runs by millisecond, then run id, whatever their microseconds', async () => {
    assert.deepEqual((await repository.listRuns(as('alice'), {limit: 10, before: null})).map(run => run.run_id), EXPECTED);
  });

  it('lists every run once whatever the page size, though three share a millisecond', async () => {
    for (const limit of [1, 2, 3, 4]) assert.deepEqual(await pages(limit), EXPECTED, `limit ${limit}`);
  });

  it('cuts a page without a run id on the same millisecond key, so a run in the cursor\'s millisecond is not listed after it', async () => {
    const ids = (await repository.listRuns(as('alice'), {limit: 10, before: '2026-01-01T00:00:00.123Z'})).map(run => run.run_id);
    assert.deepEqual(ids, [id(4)]);
    assert.deepEqual((await repository.listRuns(as('alice'), {limit: 10, before: '2026-01-01T00:00:00.124Z'})).map(run => run.run_id), [id(1), id(2), id(3), id(4)]);
  });
});
