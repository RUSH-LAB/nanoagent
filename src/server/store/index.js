/**
 * Scoped storage for the per-workspace features.
 *
 * This is the module that answers "whose is it?", and it answers structurally.
 * A handler asks a collection for a list and passes the scope it was given; it
 * never writes a WHERE clause, never names an organization, and has no method
 * available that would let it name somebody else's. The organization and the
 * owner are applied here, on every statement, from a scope that came out of a
 * verified session.
 *
 * That property is the point. The alternative, which is what the thirteen JSON
 * stores were, is that each feature scopes itself: thirteen chances to write
 * the predicate, and a cross-tenant read the first time one is missed, with
 * nothing failing to announce it. Isolation that depends on remembering is not
 * isolation; it is a habit.
 *
 * The same reasoning is why Postgres row-level security is the eventual answer
 * (see ../db.js). This layer is not a stand-in for it that comes out later.
 * When the database can enforce the predicate too, a handler still reaches its
 * data through here, and the two locks are independent: RLS catches a query
 * this module got wrong, and this module catches a connection that forgot to
 * set the RLS variable.
 *
 * Values are JSON. These features store what they always stored, and the
 * migration off their files is a reshaping of where rows live rather than of
 * what they hold. Content is deliberately not one of them: it needs versions
 * and full-text search, so it gets real columns of its own.
 */
const {db: defaultDb} = require('../db');
const {isDomain, isPerUser, DOMAIN_NAMES} = require('./domains');

/**
 * A scope names one workspace and one person: `{orgId, userId}`.
 *
 * Both come from `req.auth`, which comes from the verified session. Nothing in
 * a request can influence either, which is the same rule content isolation
 * follows and the reason neither has a query parameter.
 */

/** Raised when a caller has no workspace to read or write in. */
class NoWorkspaceError extends Error {
  constructor() {
    super('This action needs an active workspace');
    this.name = 'NoWorkspaceError';
    // What server/index.js turns into a status. 409 rather than 403: the caller
    // is allowed, there is simply nowhere yet to put the thing, and the fix is
    // to create or join a workspace rather than to ask for permission.
    this.status = 409;
    this.code = 'no-workspace';
  }
}

/** Raised when a per-user domain is reached without knowing who is asking. */
class NoIdentityError extends Error {
  constructor(domain) {
    super(`The ${domain} store holds one person's items and this request has no signed-in user`);
    this.name = 'NoIdentityError';
    this.status = 401;
    this.code = 'no-identity';
  }
}

/**
 * The organization and owner columns for one call, or a throw.
 *
 * Validated on every operation rather than once when the collection is made,
 * because a collection is module-scoped and shared by every in-flight request
 * while the scope is per request. A collection that had captured a scope would
 * be serving whichever request built it last.
 */
function columnsFor(domain, scope) {
  const orgId = scope?.orgId;
  if (!orgId || typeof orgId !== 'string') throw new NoWorkspaceError();

  if (!isPerUser(domain)) return {orgId, ownerId: null};

  const userId = scope?.userId;
  if (!userId || typeof userId !== 'string') throw new NoIdentityError(domain);
  return {orgId, ownerId: userId};
}

/**
 * Keys are supplied by features and some of them are page paths, so they are
 * strings from the outside world. They are only ever bound as SQL parameters,
 * never concatenated, so the bound is about storing something absurd rather
 * than about injection.
 */
const MAX_KEY_LENGTH = 512;

function checkKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('A store key must be a non-empty string');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new TypeError(`A store key must be ${MAX_KEY_LENGTH} characters or fewer`);
  }
  return key;
}

/**
 * Build a store over `db`. Exported so tests can drive a throwaway database,
 * and so the eventual Postgres connection is a constructor argument rather
 * than a rewrite.
 *
 * `now` is injectable for the same reason: a test that asserts on updatedAt
 * should not be asserting on the clock.
 */
function createStore({db = defaultDb, now = () => new Date().toISOString()} = {}) {
  // Prepared once. better-sqlite3 caches the plan, and these run on every
  // request that touches any of the thirteen features.
  //
  // Every statement carries organizationId and the COALESCE the unique index is
  // built on, so a row belonging to another workspace or another person is not
  // filtered out late, it is never a candidate.
  const OWNER = `coalesce("ownerId", '') = coalesce(?, '')`;

  const statements = {
    // Ties on createdAt are broken by rowid, the order the rows were written,
    // and not by the key, which for generated ids is a random string. Two items
    // created in the same millisecond do that, and creating several at once is
    // ordinary: a deck of flashcards added in one sitting came back in an order
    // that depended on which random suffix sorted lower. Same tie, and the same
    // fix, as the membership ordering in ../auth.js and ../audit.js.
    //
    // An upsert keeps its original rowid, so editing an item does not move it.
    list: db.prepare(
      `SELECT "key", "value", "createdAt", "updatedAt" FROM store_item
        WHERE "organizationId" = ? AND "domain" = ? AND ${OWNER}
        ORDER BY "createdAt", "rowid"`,
    ),
    get: db.prepare(
      `SELECT "value" FROM store_item
        WHERE "organizationId" = ? AND "domain" = ? AND ${OWNER} AND "key" = ?`,
    ),
    put: db.prepare(
      `INSERT INTO store_item
         ("organizationId", "ownerId", "domain", "key", "value", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT ("organizationId", "domain", coalesce("ownerId", ''), "key")
       DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"`,
    ),
    remove: db.prepare(
      `DELETE FROM store_item
        WHERE "organizationId" = ? AND "domain" = ? AND ${OWNER} AND "key" = ?`,
    ),
    clear: db.prepare(
      `DELETE FROM store_item
        WHERE "organizationId" = ? AND "domain" = ? AND ${OWNER}`,
    ),
    count: db.prepare(
      `SELECT COUNT(*) AS n FROM store_item
        WHERE "organizationId" = ? AND "domain" = ? AND ${OWNER}`,
    ),
  };

  /**
   * One feature's data, reachable only within a scope.
   *
   * Every method takes the scope as its first argument and derives the columns
   * from it. There is deliberately no method that takes an organization, an
   * owner, or a raw predicate: the absence is the guarantee.
   */
  function collection(domain) {
    if (!isDomain(domain)) {
      throw new Error(`Unknown store domain: ${domain}. Add it to server/store/domains.js.`);
    }

    return {
      domain,

      /** Every item in scope, oldest first, as `{key, value, createdAt, updatedAt}`. */
      list(scope) {
        const {orgId, ownerId} = columnsFor(domain, scope);
        return statements.list.all(orgId, domain, ownerId).map(row => ({
          key: row.key,
          value: JSON.parse(row.value),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
      },

      /** Just the values, which is what most handlers serialize straight out. */
      values(scope) {
        return this.list(scope).map(item => item.value);
      },

      /** The whole collection as a plain object, for handlers shaped that way. */
      entries(scope) {
        const out = Object.create(null);
        for (const item of this.list(scope)) out[item.key] = item.value;
        return out;
      },

      /** One item's value, or undefined. */
      get(scope, key) {
        const {orgId, ownerId} = columnsFor(domain, scope);
        const row = statements.get.get(orgId, domain, ownerId, checkKey(key));
        return row ? JSON.parse(row.value) : undefined;
      },

      /** Whether `key` is present in scope. */
      has(scope, key) {
        return this.get(scope, key) !== undefined;
      },

      /** Insert or replace, returning the value stored. */
      put(scope, key, value) {
        const {orgId, ownerId} = columnsFor(domain, scope);
        if (value === undefined) {
          throw new TypeError('Cannot store undefined; use remove() to delete an item');
        }
        const at = now();
        statements.put.run(orgId, ownerId, domain, checkKey(key), JSON.stringify(value), at, at);
        return value;
      },

      /**
       * Read, transform, write, in one transaction.
       *
       * The read-modify-write that every list-shaped handler does (load the
       * array, push, save) is a lost update when two requests interleave, which
       * the JSON files could not avoid and this should not reproduce.
       */
      update(scope, key, transform) {
        const run = db.transaction(() => {
          const next = transform(this.get(scope, key));
          if (next === undefined) {
            this.remove(scope, key);
            return undefined;
          }
          return this.put(scope, key, next);
        });
        return run();
      },

      /** Delete one item. True when there was one. */
      remove(scope, key) {
        const {orgId, ownerId} = columnsFor(domain, scope);
        return statements.remove.run(orgId, domain, ownerId, checkKey(key)).changes > 0;
      },

      /** Delete everything in scope. Returns how many rows went. */
      clear(scope) {
        const {orgId, ownerId} = columnsFor(domain, scope);
        return statements.clear.run(orgId, domain, ownerId).changes;
      },

      /** How many items are in scope. */
      count(scope) {
        const {orgId, ownerId} = columnsFor(domain, scope);
        return statements.count.get(orgId, domain, ownerId).n;
      },

      /** Replace the whole collection with `object`, atomically. */
      replaceAll(scope, object) {
        const run = db.transaction(() => {
          this.clear(scope);
          for (const [key, value] of Object.entries(object ?? {})) this.put(scope, key, value);
        });
        run();
      },
    };
  }

  // Built once, since a collection holds no per-request state. Frozen so a
  // route cannot bolt an unscoped helper onto one.
  const collections = Object.freeze(
    Object.fromEntries(DOMAIN_NAMES.map(name => [name, Object.freeze(collection(name))])),
  );

  return {collection: name => collections[name] ?? collection(name), collections, db};
}

const store = createStore();

module.exports = {
  ...store,
  createStore,
  NoWorkspaceError,
  NoIdentityError,
  MAX_KEY_LENGTH,
  DOMAIN_NAMES,
};
