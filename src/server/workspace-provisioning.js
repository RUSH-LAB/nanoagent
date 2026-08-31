'use strict';

const crypto = require('crypto');

const FIRST_CHANNEL = 'general';
const FIRST_CHANNEL_TOPIC = 'Everything, to start with';

/**
 * Product-side effects attached to Better Auth's organization lifecycle.
 *
 * Every operation is idempotent. Better Auth may retry a request, and a hook
 * can be replayed safely while recovering from an interrupted deployment.
 */
function createWorkspaceProvisioning({postgres, sqliteDb, now = () => new Date().toISOString(), newId = () => crypto.randomUUID()}) {
  async function postgresContext(userId, workspaceId, operation) {
    const {withRequestContext} = require('./postgres/client');
    return withRequestContext(postgres.pool, {userId, workspaceId}, operation);
  }

  async function provisionMember({member, user, organization}) {
    const workspaceId = organization.id;
    const userId = member.userId || user.id;
    const at = now();
    const isOwner = String(member.role).split(',').includes('owner');

    if (postgres?.enabled) {
      return postgresContext(userId, workspaceId, async client => {
        // workspace_settings is owner-write-only under RLS. PostgreSQL checks
        // the INSERT policy before ON CONFLICT DO NOTHING, so an invited
        // viewer/editor must not attempt this idempotent workspace setup.
        if (isOwner) {
          await client.query(
            `insert into workspace_settings(workspace_id, value, updated_at)
             values ($1, '{}'::jsonb, $2) on conflict (workspace_id) do nothing`,
            [workspaceId, at],
          );
          await client.query(
            `insert into channel(id, workspace_id, kind, name, topic, created_by, created_at)
             values ($1, $2, 'public', $3, $4, $5, $6)
             on conflict (workspace_id, name) where name is not null do nothing`,
            [newId(), workspaceId, FIRST_CHANNEL, FIRST_CHANNEL_TOPIC, userId, at],
          );
        }
        const channel = (await client.query(
          `select id from channel where workspace_id = $1 and name = $2 and kind = 'public' limit 1`,
          [workspaceId, FIRST_CHANNEL],
        )).rows[0];
        if (channel) {
          await client.query(
            `insert into channel_member(workspace_id, channel_id, user_id, joined_at)
             values ($1, $2, $3, $4) on conflict (channel_id, user_id) do nothing`,
            [workspaceId, channel.id, userId, at],
          );
        }
      });
    }

    const run = sqliteDb.transaction(() => {
      if (isOwner) {
        sqliteDb.prepare(
          `INSERT OR IGNORE INTO workspace_settings (organizationId, value, updatedAt)
           VALUES (?, ?, ?)`,
        ).run(workspaceId, '{}', at);
        sqliteDb.prepare(
          `INSERT OR IGNORE INTO channel
             (id, organizationId, kind, name, topic, dmKey, createdBy, createdAt, archivedAt)
           VALUES (?, ?, 'public', ?, ?, NULL, ?, ?, NULL)`,
        ).run(newId(), workspaceId, FIRST_CHANNEL, FIRST_CHANNEL_TOPIC, userId, at);
      }
      const channel = sqliteDb.prepare(
        `SELECT id FROM channel WHERE organizationId = ? AND name = ? AND kind = 'public' LIMIT 1`,
      ).get(workspaceId, FIRST_CHANNEL);
      if (channel) {
        sqliteDb.prepare(
          `INSERT OR IGNORE INTO channel_member (channelId, userId, joinedAt, lastReadSeq)
           VALUES (?, ?, ?, 0)`,
        ).run(channel.id, userId, at);
      }
    });
    run();
  }

  async function removeMemberChannels({member, organization}) {
    if (postgres?.enabled) {
      return postgresContext(member.userId, organization.id, client => client.query(
        `delete from channel_member
          where user_id = $1
            and channel_id in (select id from channel where workspace_id = $2)`,
        [member.userId, organization.id],
      ));
    }
    sqliteDb.prepare(
      `DELETE FROM channel_member
        WHERE userId = ?
          AND channelId IN (SELECT id FROM channel WHERE organizationId = ?)`,
    ).run(member.userId, organization.id);
  }

  async function recordWorkspaceCreation({organization, user}) {
    const at = now();
    const detail = JSON.stringify({slug: organization.slug});
    const targetLabel = organization.name;
    if (postgres?.enabled) {
      return postgresContext(user.id, organization.id, async client => {
        const exists = (await client.query(
          `select 1 from workspace_audit
            where workspace_id = $1 and action = 'org.create' limit 1`,
          [organization.id],
        )).rows[0];
        if (!exists) {
          await client.query(
            `insert into workspace_audit
              (id, workspace_id, action, actor_id, actor_label, target_id, target_label, detail, at)
             values ($1, $2, 'org.create', $3, $4, $3, $5, $6::jsonb, $7)`,
            [newId(), organization.id, user.id, user.name || user.email || 'someone', targetLabel, detail, at],
          );
        }
      });
    }

    const existing = sqliteDb.prepare(
      `SELECT 1 FROM org_audit WHERE organizationId = ? AND action = 'org.create' LIMIT 1`,
    ).get(organization.id);
    if (!existing) {
      sqliteDb.prepare(
        `INSERT INTO org_audit
          (id, organizationId, action, actorId, actorLabel, targetId, targetLabel, detail, at)
         VALUES (?, ?, 'org.create', ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId(), organization.id, user.id, user.name || user.email || 'someone',
        user.id, targetLabel, detail, at,
      );
    }
  }

  return Object.freeze({
    hooks: Object.freeze({
      afterAddMember: provisionMember,
      // Invitation acceptance has its own Better Auth hook and does not call
      // afterAddMember, even though it creates the same membership row.
      afterAcceptInvitation: provisionMember,
      beforeRemoveMember: removeMemberChannels,
      afterCreateOrganization: recordWorkspaceCreation,
    }),
    FIRST_CHANNEL,
  });
}

module.exports = {createWorkspaceProvisioning, FIRST_CHANNEL, FIRST_CHANNEL_TOPIC};
