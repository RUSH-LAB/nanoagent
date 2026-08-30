/**
 * Application roles: who is an owner, an editor, or a viewer.
 *
 * Distinct from the organization roles Better Auth's plugin manages. These are
 * site-wide, and they are what /admin edits and what the owner-only endpoints
 * check.
 *
 * They live in the user_role table, joined to Better Auth's user table by
 * foreign key. Before that they lived in var/data/users.json, keyed by user id
 * with nothing keeping the two in step: recreating the database gave root a new
 * id, the old row stayed, and /admin ended up listing three owners of whom two
 * did not exist. The foreign key makes that unreachable.
 */
const {db} = require('./db');

/** The roles a user may hold, most privileged first. */
const ROLES = Object.freeze(['owner', 'editor', 'viewer']);

/** What an account with no explicit role can do. */
const DEFAULT_ROLE = 'viewer';

function isValidRole(role) {
  return typeof role === 'string' && ROLES.includes(role);
}

/** The role held by `userId`, or the viewer default. */
function getRole(userId) {
  if (typeof userId !== 'string' || !userId) return DEFAULT_ROLE;
  const row = db.prepare('SELECT role FROM user_role WHERE userId = ?').get(userId);
  return row?.role ?? DEFAULT_ROLE;
}

/**
 * Grant `role` to `userId`. Returns false when the user does not exist, since
 * the foreign key would reject the write anyway and a silent throw at the call
 * site reads worse than a boolean.
 */
function setRole(userId, role) {
  if (!isValidRole(role)) throw new Error(`Invalid role: ${role}`);
  const exists = db.prepare('SELECT 1 FROM "user" WHERE id = ?').get(userId);
  if (!exists) return false;
  db.prepare(
    `INSERT INTO user_role (userId, role, addedAt) VALUES (?, ?, ?)
     ON CONFLICT(userId) DO UPDATE SET role = excluded.role`,
  ).run(userId, role, new Date().toISOString());
  return true;
}

/**
 * Every account, with its role. This is the list /admin shows, so it comes from
 * the user table rather than the role table: an account with no role assigned
 * is still an account, and showing it as a viewer is how you give it one.
 */
function listUsers() {
  return db
    .prepare(
      `SELECT u.id, u.username, u.email, u.name, u.createdAt,
              COALESCE(r.role, ?) AS role, r.addedAt
         FROM "user" u
         LEFT JOIN user_role r ON r.userId = u.id
        ORDER BY u.createdAt ASC`,
    )
    .all(DEFAULT_ROLE);
}

/** Whether `userId` is an owner. The check the role endpoint gates on. */
function isOwner(userId) {
  return getRole(userId) === 'owner';
}

/** How many owners exist, so the last one cannot demote themselves. */
function ownerCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM user_role WHERE role = 'owner'").get().n;
}

module.exports = {ROLES, DEFAULT_ROLE, isValidRole, getRole, setRole, listUsers, isOwner, ownerCount};
