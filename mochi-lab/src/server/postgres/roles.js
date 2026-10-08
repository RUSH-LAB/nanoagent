const ROLES = Object.freeze(['admin', 'user']);
const DEFAULT_ROLE = 'user';
const isValidRole = role => typeof role === 'string' && ROLES.includes(role);

function createPostgresRoles({pool, now = () => new Date().toISOString()}) {
  async function getRole(userId) {
    if (typeof userId !== 'string' || !userId) return DEFAULT_ROLE;
    return (await pool.query('select 1 from platform_admin where user_id = $1', [userId])).rowCount ? 'admin' : DEFAULT_ROLE;
  }
  async function setRole(userId, role) {
    if (!isValidRole(role)) throw new Error(`Invalid platform role: ${role}`);
    if (!(await pool.query('select 1 from app_user where id = $1', [userId])).rowCount) return false;
    if (role === 'admin') {
      await pool.query(
        `insert into platform_admin(user_id, granted_at) values ($1, $2)
         on conflict(user_id) do update set granted_at = excluded.granted_at`, [userId, now()],
      );
    } else await pool.query('delete from platform_admin where user_id = $1', [userId]);
    return true;
  }
  async function listUsers() {
    return (await pool.query(
      `select u.id, coalesce(u.display_name, u.email) as username, u.email, u.display_name as name,
              u.created_at as "createdAt", case when p.user_id is null then 'user' else 'admin' end as role,
              p.granted_at as "addedAt"
         from app_user u left join platform_admin p on p.user_id = u.id order by u.created_at`,
    )).rows;
  }
  const isAdmin = async userId => await getRole(userId) === 'admin';
  const adminCount = async () => Number((await pool.query('select count(*) from platform_admin')).rows[0].count);
  return {ROLES, DEFAULT_ROLE, isValidRole, getRole, setRole, listUsers, isAdmin, adminCount};
}

module.exports = {createPostgresRoles, ROLES, DEFAULT_ROLE, isValidRole};
