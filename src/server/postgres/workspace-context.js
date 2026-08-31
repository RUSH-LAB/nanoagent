const {withRequestContext} = require('./client');
const {normalizeWorkspaceRole} = require('../workspace-context');

function createPostgresWorkspaceContextResolver({pool}) {
  const fromRow = row => row ? Object.freeze({
    userId: row.userId,
    workspaceId: row.workspaceId,
    membershipId: row.membershipId,
    role: normalizeWorkspaceRole(row.role),
  }) : null;

  async function resolve(userId, value, column) {
    if (typeof userId !== 'string' || !userId || typeof value !== 'string' || !value) return null;
    const workspaceId = column === 'id'
      ? value
      : await withRequestContext(pool, {userId, workspaceId: null}, async client =>
        (await client.query('select id from list_user_workspaces($1) where slug = $2', [userId, value])).rows[0]?.id);
    if (!workspaceId) return null;
    return withRequestContext(pool, {userId, workspaceId}, async client => fromRow((await client.query(
      `select w.id as "workspaceId", w.slug as "workspaceSlug", m.id as "membershipId",
              m.user_id as "userId", m.role
         from workspace w join workspace_member m on m.workspace_id = w.id
        where w.id = $1 and w.status = 'active' and m.user_id = $2 limit 1`,
      [workspaceId, userId],
    )).rows[0]));
  }

  return Object.freeze({
    byId: (userId, workspaceId) => resolve(userId, workspaceId, 'id'),
    bySlug: (userId, workspaceSlug) => resolve(userId, workspaceSlug, 'slug'),
  });
}

module.exports = {createPostgresWorkspaceContextResolver};
