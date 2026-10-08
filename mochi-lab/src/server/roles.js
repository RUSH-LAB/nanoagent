/** Platform administration, deliberately separate from workspace roles. */
const {db} = require('./db');

const ROLES = Object.freeze(['admin', 'user']);
const DEFAULT_ROLE = 'user';

function isValidRole(role) {
  return typeof role === 'string' && ROLES.includes(role);
}

function getRole(userId) {
  if (typeof userId !== 'string' || !userId) return DEFAULT_ROLE;
  return db.prepare('SELECT 1 FROM platform_admin WHERE userId = ?').get(userId)
    ? 'admin'
    : DEFAULT_ROLE;
}

function setRole(userId, role) {
  if (!isValidRole(role)) throw new Error(`Invalid platform role: ${role}`);
  if (!db.prepare('SELECT 1 FROM "user" WHERE id = ?').get(userId)) return false;
  if (role === 'admin') {
    db.prepare(
      `INSERT INTO platform_admin (userId, addedAt) VALUES (?, ?)
       ON CONFLICT(userId) DO UPDATE SET addedAt = excluded.addedAt`,
    ).run(userId, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM platform_admin WHERE userId = ?').run(userId);
  }
  return true;
}

function listUsers() {
  return db.prepare(
    `SELECT u.id, COALESCE(u.name, u.email) AS username, u.email, u.name, u.createdAt,
            CASE WHEN p.userId IS NULL THEN 'user' ELSE 'admin' END AS role,
            p.addedAt
       FROM "user" u
       LEFT JOIN platform_admin p ON p.userId = u.id
      ORDER BY u.createdAt ASC`,
  ).all();
}

function isAdmin(userId) {
  return getRole(userId) === 'admin';
}

function adminCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM platform_admin').get().n;
}

module.exports = {
  ROLES, DEFAULT_ROLE, isValidRole, getRole, setRole, listUsers, isAdmin, adminCount,
};
