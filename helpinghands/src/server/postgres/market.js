'use strict';
const {withRequestContext} = require('./client');

// What one user's uploads may hold in all; each package is also capped by NanoAgent.
const USER_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The marketplace's uploads (migrations 0012, 0013): NanoAgent plugin packages any
 * signed-in user may download, each replaced or removed only by its uploader.
 * Row-level security holds both rules; publish checks the owner first to say
 * "that id is taken", and an upload's owner never changes, so the check holds
 * (a race it loses still fails on the policy, which the route reports alike).
 */
function createPostgresMarket({pool}) {
  const run = (userId, operation) => withRequestContext(pool, {userId, workspaceId: null}, operation);
  const listing = row => ({
    ...row.entry,
    sha256: row.sha256,
    size: row.size,
    source: 'upload',
    repository: row.repository,
    // Its author is its publisher's GitHub account.
    owner: {id: row.owner_id, name: row.owner_name, github: row.owner_github},
    updatedAt: row.updated_at,
  });
  const COLUMNS = 'm.entry, m.repository, m.sha256, m.size, m.owner_id, u.display_name as owner_name, u.github_login as owner_github, m.updated_at';
  const FROM = 'from market_plugin m join app_user u on u.id = m.owner_id';

  return Object.freeze({
    async list(userId) {
      return run(userId, async client => (await client.query(`select ${COLUMNS} ${FROM} order by m.updated_at desc`)).rows.map(listing));
    },
    /** One upload and its package bytes, or null. */
    async get(userId, id) {
      return run(userId, async client => {
        const row = (await client.query(`select ${COLUMNS}, m.package ${FROM} where m.id = $1`, [id])).rows[0];
        return row ? {...listing(row), package: Buffer.from(row.package)} : null;
      });
    },
    /** Store a checked package, packed from `repository`, as the caller's: new, or a new version of their own. */
    async publish(userId, entry, data, repository) {
      return run(userId, async client => {
        const current = (await client.query('select owner_id from market_plugin where id = $1', [entry.id])).rows[0];
        if (current && current.owner_id !== userId) {
          const error = new Error(`Someone else already publishes a plugin named ${entry.id}`);
          error.status = 409;
          error.code = 'taken';
          throw error;
        }
        const {sha256, size, ...stored} = entry;
        const others = (await client.query(
          'select coalesce(sum(size), 0)::bigint as total from market_plugin where owner_id = $1 and id <> $2', [userId, entry.id],
        )).rows[0].total;
        if (Number(others) + size > USER_MAX_BYTES) {
          const error = new Error(`Your uploads may hold ${USER_MAX_BYTES / 1024 / 1024} MB in all; remove one to make room`);
          error.status = 413;
          error.code = 'quota';
          throw error;
        }
        await client.query(
          `insert into market_plugin(id, owner_id, version, entry, repository, package, sha256, size)
           values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
           on conflict (id) do update set version = excluded.version, entry = excluded.entry,
             repository = excluded.repository, package = excluded.package, sha256 = excluded.sha256,
             size = excluded.size, updated_at = now()`,
          [entry.id, userId, entry.version, JSON.stringify(stored), JSON.stringify(repository), data, sha256, size],
        );
        return listing((await client.query(`select ${COLUMNS} ${FROM} where m.id = $1`, [entry.id])).rows[0]);
      });
    },
    /** Remove the caller's upload `id`: whether there was one. */
    async remove(userId, id) {
      return run(userId, async client => (await client.query(
        'delete from market_plugin where id = $1 and owner_id = $2', [id, userId],
      )).rowCount === 1);
    },
  });
}

module.exports = {createPostgresMarket, USER_MAX_BYTES};
