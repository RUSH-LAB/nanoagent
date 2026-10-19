'use strict';
const {gt} = require('@renovatebot/pep440');
const {withRequestContext} = require('./client');

// What one user's uploads may hold in all; each package is also capped by NanoAgent.
const USER_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The marketplace's uploads (migrations 0012, 0013, 0041, 0042): NanoAgent plugin packages any
 * signed-in user may download, each published and removed only by its uploader.
 * Each version is one package for good, newer than every version before it; an
 * upload is listed as its latest, and keeps that and each version a member stays on.
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
    publishedAt: row.published_at,
    // Its author is its publisher's GitHub account.
    owner: {id: row.owner_id, name: row.owner_name, github: row.owner_github},
    updatedAt: row.updated_at,
  });
  /**
   * Remove the versions of the caller's upload `id` that no member stays on
   * but its latest: user_plugin_version_fkey refuses each one a member does,
   * which then stays.
   */
  async function prune(client, id) {
    const versions = (await client.query(
      `select v.version from market_plugin_version v join market_plugin m on m.id = v.plugin_id
        where v.plugin_id = $1 and v.version <> m.version`, [id],
    )).rows;
    for (const {version} of versions) {
      await client.query('savepoint prune');
      try {
        await client.query('delete from market_plugin_version where plugin_id = $1 and version = $2', [id, version]);
        await client.query('release savepoint prune');
      } catch (error) {
        if (error.code !== '23503') throw error;
        await client.query('rollback to savepoint prune');
      }
    }
  }
  const COLUMNS = 'v.entry, v.repository, v.sha256, v.size, v.published_at, m.owner_id, u.display_name as owner_name, u.github_login as owner_github, m.updated_at';
  // Each upload at its latest version; `get` names another.
  const FROM = 'from market_plugin m join app_user u on u.id = m.owner_id join market_plugin_version v on v.plugin_id = m.id';

  return Object.freeze({
    async list(userId) {
      return run(userId, async client => (await client.query(
        `select ${COLUMNS} ${FROM} where v.version = m.version order by m.updated_at desc`,
      )).rows.map(listing));
    },
    /** One upload at `version`, its latest when null, and its package bytes, or null. */
    async get(userId, id, version = null) {
      return run(userId, async client => {
        const row = (await client.query(
          `select ${COLUMNS}, v.package ${FROM} where m.id = $1 and v.version = coalesce($2, m.version)`, [id, version],
        )).rows[0];
        return row ? {...listing(row), package: Buffer.from(row.package)} : null;
      });
    },
    /** Store a checked package, packed from `repository`, as the caller's: new, or a new version of their own. */
    async publish(userId, entry, data, repository) {
      return run(userId, async client => {
        const current = (await client.query('select owner_id, version from market_plugin where id = $1', [entry.id])).rows[0];
        if (current && current.owner_id !== userId) {
          const error = new Error(`Someone else already publishes a plugin named ${entry.id}`);
          error.status = 409;
          error.code = 'taken';
          throw error;
        }
        const {sha256, size, ...stored} = entry;
        if (current && !gt(entry.version, current.version)) {
          const error = new Error(`${entry.id} ${entry.version} is not newer than its latest version, ${current.version}. Raise version in nanoagent.yaml and pyproject.toml to publish this code.`);
          error.status = 409;
          error.code = 'published';
          throw error;
        }
        if (current) await prune(client, entry.id);
        // Every version kept counts.
        const held = (await client.query(
          `select coalesce(sum(v.size), 0)::bigint as total
             from market_plugin_version v join market_plugin m on m.id = v.plugin_id where m.owner_id = $1`, [userId],
        )).rows[0].total;
        if (Number(held) + size > USER_MAX_BYTES) {
          const error = new Error(`Your uploads may hold ${USER_MAX_BYTES / 1024 / 1024} MB in all; remove one to make room`);
          error.status = 413;
          error.code = 'quota';
          throw error;
        }
        await client.query(
          `insert into market_plugin(id, owner_id, version) values ($1, $2, $3)
           on conflict (id) do update set version = excluded.version, updated_at = now()`,
          [entry.id, userId, entry.version],
        );
        await client.query(
          `insert into market_plugin_version(plugin_id, version, entry, repository, package, sha256, size)
           values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)`,
          [entry.id, entry.version, JSON.stringify(stored), JSON.stringify(repository), data, sha256, size],
        );
        return listing((await client.query(`select ${COLUMNS} ${FROM} where m.id = $1 and v.version = m.version`, [entry.id])).rows[0]);
      });
    },
    /** Remove the caller's upload `id`, every version: whether there was one. */
    async remove(userId, id) {
      return run(userId, async client => (await client.query(
        'delete from market_plugin where id = $1 and owner_id = $2', [id, userId],
      )).rowCount === 1);
    },
  });
}

module.exports = {createPostgresMarket, USER_MAX_BYTES};
