/**
 * What was done to the organization, and by whom.
 *
 * One log for changes that outlast the moment and that somebody may later have
 * to account for: promotions, removals, and channels renamed, archived, or
 * deleted. Ordinary use is not audited. A message is its own record, and a log
 * of everything is a log nobody reads.
 *
 * Deliberately dependency-light, needing only the database, so that both the
 * organization module and the chat module can write to it. The organization
 * module also talks to Better Auth, and routing chat's audit through it would
 * have pulled an authentication library into the module that stores messages.
 *
 * Every write here is best-effort. An audit row that fails is worth a line on
 * the console, never a failed request for a change that has already happened.
 */
const crypto = require('crypto');
const {db} = require('./db');

/** How much history a read returns, and the ceiling on asking for more. */
const LIMIT = 50;

/** What a person is called, for a label that has to survive their account. */
function labelForUser(userId) {
  const user = db.prepare('SELECT username, name, email FROM "user" WHERE id = ?').get(userId);
  return user?.username || user?.name || user?.email || 'someone';
}

/**
 * Write one event.
 *
 * `targetId` links to an account when the subject is one, and is null when it
 * is not: a channel has no row in the user table and the column's foreign key
 * points there. `targetLabel` is what carries the subject either way, which is
 * also why it survives the account or channel being deleted afterwards.
 */
function record({orgId, action, actorId, targetId = null, targetLabel, detail = null}) {
  try {
    db.prepare(
      `INSERT INTO org_audit (id, organizationId, action, actorId, actorLabel, targetId, targetLabel, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `aud_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
      orgId, action,
      actorId ?? null, labelForUser(actorId),
      targetId, String(targetLabel),
      detail ? JSON.stringify(detail) : null,
      new Date().toISOString(),
    );
  } catch (err) {
    console.error(`Could not write the audit row for ${action}: ${err.message}`);
  }
}

/**
 * The events in this organization, newest first.
 *
 * Ties on `at` are broken by rowid, which is the order the rows were written.
 * Two events can share a millisecond, and an id is a random string, so sorting
 * by it would have put "archived" before "renamed" whenever the two happened
 * in the same instant. The same tie that once hid unread messages.
 */
function list(orgId, limit = LIMIT) {
  const capped = Math.min(Math.max(Number(limit) || LIMIT, 1), LIMIT);
  return db
    .prepare(
      `SELECT id, action, actorId, actorLabel, targetId, targetLabel, detail, at
         FROM org_audit WHERE organizationId = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
    )
    .all(orgId, capped)
    .map(row => ({...row, detail: row.detail ? JSON.parse(row.detail) : null}));
}

module.exports = {LIMIT, labelForUser, record, list};
