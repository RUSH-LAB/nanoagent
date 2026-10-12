const {withRequestContext} = require('./client');
const {isDomain, isPerUser} = require('../store/domains');
const MAX_KEY_LENGTH = 512;

class NoWorkspaceError extends Error {
  constructor() {
    super('This action needs an active workspace');
    this.name = 'NoWorkspaceError';
    this.status = 409;
    this.code = 'no-workspace';
  }
}

class NoIdentityError extends Error {
  constructor(domain) {
    super(`The ${domain} store holds one person's items and this request has no signed-in user`);
    this.name = 'NoIdentityError';
    this.status = 401;
    this.code = 'no-identity';
  }
}

function columnsFor(domain, scope) {
  const workspaceId = scope?.workspaceId;
  if (!workspaceId || typeof workspaceId !== 'string') throw new NoWorkspaceError();
  if (!isPerUser(domain)) return {workspaceId, ownerId: null};
  const userId = scope?.userId;
  if (!userId || typeof userId !== 'string') throw new NoIdentityError(domain);
  return {workspaceId, ownerId: userId};
}

function checkKey(key) {
  if (typeof key !== 'string' || !key) throw new TypeError('A store key must be a non-empty string');
  if (key.length > MAX_KEY_LENGTH) throw new TypeError(`A store key must be ${MAX_KEY_LENGTH} characters or fewer`);
  return key;
}

function createPostgresStore({pool, now = () => new Date().toISOString()}) {
  function referenceCollection() {
    const run = (scope, operation) => withRequestContext(pool, {
      userId: scope?.userId,
      workspaceId: columnsFor('plugin:bibliography:papers', scope).workspaceId,
    }, operation);
    const api = {
      domain: 'plugin:bibliography:papers',
      async list(scope) {
        return run(scope, async client => (await client.query(
          `select citation_key as key, value, created_at as "createdAt", updated_at as "updatedAt"
             from reference order by created_at, citation_key`,
        )).rows);
      },
      async values(scope) { return (await api.list(scope)).map(item => item.value); },
      async entries(scope) {
        const out = Object.create(null);
        for (const item of await api.list(scope)) out[item.key] = item.value;
        return out;
      },
      async get(scope, key) {
        return run(scope, async client => (await client.query(
          'select value from reference where citation_key = $1', [checkKey(key)],
        )).rows[0]?.value);
      },
      async has(scope, key) { return (await api.get(scope, key)) !== undefined; },
      async put(scope, key, value) {
        if (value === undefined) throw new TypeError('Cannot store undefined; use remove() to delete an item');
        const workspaceId = columnsFor('plugin:bibliography:papers', scope).workspaceId;
        const at = now();
        await run(scope, client => client.query(
          `insert into reference(id, workspace_id, citation_key, value, created_by, created_at, updated_at)
           values (gen_random_uuid()::text, $1, $2, $3::jsonb, $4, $5, $5)
           on conflict (workspace_id, citation_key)
           do update set value = excluded.value, updated_at = excluded.updated_at`,
          [workspaceId, checkKey(key), JSON.stringify(value), scope.userId, at],
        ));
        return value;
      },
      async update(scope, key, transform) {
        return run(scope, async client => {
          const current = (await client.query('select value from reference where citation_key = $1 for update', [checkKey(key)])).rows[0]?.value;
          const next = transform(current);
          if (next === undefined) {
            await client.query('delete from reference where citation_key = $1', [key]);
            return undefined;
          }
          const workspaceId = columnsFor('plugin:bibliography:papers', scope).workspaceId;
          const at = now();
          await client.query(
            `insert into reference(id, workspace_id, citation_key, value, created_by, created_at, updated_at)
             values (gen_random_uuid()::text, $1, $2, $3::jsonb, $4, $5, $5)
             on conflict (workspace_id, citation_key)
             do update set value = excluded.value, updated_at = excluded.updated_at`,
            [workspaceId, key, JSON.stringify(next), scope.userId, at],
          );
          return next;
        });
      },
      async remove(scope, key) {
        return run(scope, async client => (await client.query('delete from reference where citation_key = $1', [checkKey(key)])).rowCount > 0);
      },
      async clear(scope) { return run(scope, async client => (await client.query('delete from reference')).rowCount); },
      async count(scope) { return run(scope, async client => Number((await client.query('select count(*)::int as n from reference')).rows[0].n)); },
      async replaceAll(scope, object) {
        return run(scope, async client => {
          await client.query('delete from reference');
          const workspaceId = columnsFor('plugin:bibliography:papers', scope).workspaceId;
          const at = now();
          for (const [key, value] of Object.entries(object ?? {})) {
            await client.query(
              `insert into reference(id, workspace_id, citation_key, value, created_by, created_at, updated_at)
               values (gen_random_uuid()::text, $1, $2, $3::jsonb, $4, $5, $5)`,
              [workspaceId, checkKey(key), JSON.stringify(value), scope.userId, at],
            );
          }
          return object ?? {};
        });
      },
    };
    return Object.freeze(api);
  }

  function collection(domain) {
    if (!isDomain(domain)) throw new Error(`Unknown store domain: ${domain}. Add it to server/store/domains.js.`);
    if (domain === 'plugin:bibliography:papers') return referenceCollection();

    const run = (scope, operation) => {
      const {workspaceId} = columnsFor(domain, scope);
      return withRequestContext(pool, {userId: scope.userId, workspaceId}, operation);
    };

    const api = {
      domain,
      async list(scope) {
        const {workspaceId, ownerId} = columnsFor(domain, scope);
        return run(scope, async client => {
          const result = await client.query(
            `select key, value, created_at as "createdAt", updated_at as "updatedAt"
               from store_item
              where workspace_id = $1 and domain = $2 and owner_id is not distinct from $3
              order by created_at, key`,
            [workspaceId, domain, ownerId],
          );
          return result.rows.map(row => ({...row, value: row.value}));
        });
      },
      async values(scope) { return (await api.list(scope)).map(item => item.value); },
      async entries(scope) {
        const out = Object.create(null);
        for (const item of await api.list(scope)) out[item.key] = item.value;
        return out;
      },
      async get(scope, key) {
        const {workspaceId, ownerId} = columnsFor(domain, scope);
        return run(scope, async client => {
          const result = await client.query(
            `select value from store_item
              where workspace_id = $1 and domain = $2 and owner_id is not distinct from $3 and key = $4`,
            [workspaceId, domain, ownerId, checkKey(key)],
          );
          return result.rows[0]?.value;
        });
      },
      async has(scope, key) { return (await api.get(scope, key)) !== undefined; },
      async put(scope, key, value) {
        if (value === undefined) throw new TypeError('Cannot store undefined; use remove() to delete an item');
        const {workspaceId, ownerId} = columnsFor(domain, scope);
        const at = now();
        return run(scope, async client => {
          await client.query(
            `insert into store_item(workspace_id, owner_id, domain, key, value, created_at, updated_at)
             values ($1, $2, $3, $4, $5::jsonb, $6, $6)
             on conflict (workspace_id, domain, (coalesce(owner_id, '')), key)
             do update set value = excluded.value, updated_at = excluded.updated_at`,
            [workspaceId, ownerId, domain, checkKey(key), JSON.stringify(value), at],
          );
          return value;
        });
      },
      async update(scope, key, transform) {
        const {workspaceId, ownerId} = columnsFor(domain, scope);
        return run(scope, async client => {
          const locked = await client.query(
            `select value from store_item
              where workspace_id = $1 and domain = $2 and owner_id is not distinct from $3 and key = $4
              for update`,
            [workspaceId, domain, ownerId, checkKey(key)],
          );
          const next = transform(locked.rows[0]?.value);
          if (next === undefined) {
            await client.query(
              `delete from store_item
                where workspace_id = $1 and domain = $2 and owner_id is not distinct from $3 and key = $4`,
              [workspaceId, domain, ownerId, key],
            );
            return undefined;
          }
          const at = now();
          await client.query(
            `insert into store_item(workspace_id, owner_id, domain, key, value, created_at, updated_at)
             values ($1, $2, $3, $4, $5::jsonb, $6, $6)
             on conflict (workspace_id, domain, (coalesce(owner_id, '')), key)
             do update set value = excluded.value, updated_at = excluded.updated_at`,
            [workspaceId, ownerId, domain, key, JSON.stringify(next), at],
          );
          return next;
        });
      },
      async remove(scope, key) {
        const {workspaceId, ownerId} = columnsFor(domain, scope);
        return run(scope, async client => (await client.query(
          `delete from store_item
            where workspace_id = $1 and domain = $2 and owner_id is not distinct from $3 and key = $4`,
          [workspaceId, domain, ownerId, checkKey(key)],
        )).rowCount > 0);
      },
      async clear(scope) {
        const {workspaceId, ownerId} = columnsFor(domain, scope);
        return run(scope, async client => (await client.query(
          `delete from store_item where workspace_id = $1 and domain = $2 and owner_id is not distinct from $3`,
          [workspaceId, domain, ownerId],
        )).rowCount);
      },
      async count(scope) {
        const {workspaceId, ownerId} = columnsFor(domain, scope);
        return run(scope, async client => Number((await client.query(
          `select count(*)::int as n from store_item
            where workspace_id = $1 and domain = $2 and owner_id is not distinct from $3`,
          [workspaceId, domain, ownerId],
        )).rows[0].n));
      },
      async replaceAll(scope, object) {
        const {workspaceId, ownerId} = columnsFor(domain, scope);
        return run(scope, async client => {
          await client.query(
            `delete from store_item where workspace_id = $1 and domain = $2 and owner_id is not distinct from $3`,
            [workspaceId, domain, ownerId],
          );
          const at = now();
          for (const [key, value] of Object.entries(object ?? {})) {
            await client.query(
              `insert into store_item(workspace_id, owner_id, domain, key, value, created_at, updated_at)
               values ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
              [workspaceId, ownerId, domain, checkKey(key), JSON.stringify(value), at],
            );
          }
          return object ?? {};
        });
      },
    };
    return Object.freeze(api);
  }
  return {collection};
}

module.exports = {createPostgresStore};
