'use strict';

/**
 * The per-feature data store (store/index.js's `collection(domain)`) kept as
 * files in the workspace file system, so what people make in the apps is in
 * the same drive as everything else.
 *
 * Each record is one JSON file, `{"key": …, "value": …}`, so records keep
 * their own revisions and history and two members editing different records
 * never touch the same file:
 *
 *   .apps/<domain>/<key>.json                          the workspace's (glossary, schedule, whiteboards, agents)
 *   .plugins/<plugin>/records/<collection>/<key>.json  a plugin's collection (plugin:<plugin>:<collection>)
 *   home/<user>/.apps/<domain>/<key>.json              one member's (bookmarks, tasks, notes, …), private to them
 *
 * Every folder starts with a dot: records are app state, which the Explorer
 * and the sync clients leave out and /api/fs does not write
 * (docs/plans/filesystem-layout.md).
 *
 * Internal state that is not content (page analytics, study streaks, snapshots
 * of the tree) stays in the legacy store, which `legacy` serves.
 */
const crypto = require('crypto');
const {isDomain, isPerUser} = require('../store/domains');

const SYSTEM_DOMAINS = new Set(['analytics', 'streaks', 'snapshots']);
const MAX_KEY_LENGTH = 512;
const MAX_NAME_LENGTH = 120;

function checkKey(key) {
  if (typeof key !== 'string' || !key) throw new TypeError('A store key must be a non-empty string');
  if (key.length > MAX_KEY_LENGTH) throw new TypeError(`A store key must be ${MAX_KEY_LENGTH} characters or fewer`);
  return key;
}

/** A file name for `key`: readable when it can be, a hash when it is too long. */
function fileNameFor(key) {
  const encoded = encodeURIComponent(key).replace(/^\./, '%2E');
  return encoded.length <= MAX_NAME_LENGTH
    ? `${encoded}.json`
    : `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`;
}

function folderFor(domain, scope) {
  if (!scope?.workspaceId) {
    throw Object.assign(new Error('This action needs an active workspace'), {status: 409, code: 'no-workspace'});
  }
  if (domain.startsWith('plugin:')) {
    const [, plugin, ...collection] = domain.split(':');
    return `.plugins/${encodeURIComponent(plugin)}/records/${collection.map(part => encodeURIComponent(part)).join('/')}`;
  }
  if (!isPerUser(domain)) return `.apps/${domain}`;
  if (!scope.userId) {
    throw Object.assign(new Error(`The ${domain} store holds one person's items and this request has no signed-in user`),
      {status: 401, code: 'no-identity'});
  }
  return `home/${scope.userId}/.apps/${domain}`;
}

const parse = row => {
  const record = JSON.parse(row.body.toString('utf8'));
  return {key: record.key, value: record.value, createdAt: row.createdAt, updatedAt: row.updatedAt};
};
const serialize = (key, value) => `${JSON.stringify({key, value}, null, 2)}\n`;

function createFsRecords({fs, legacy}) {
  function collection(domain) {
    if (!isDomain(domain)) throw new Error(`Unknown store domain: ${domain}. Add it to server/store/domains.js.`);
    if (SYSTEM_DOMAINS.has(domain)) return legacy.collection(domain);

    const api = {
      domain,
      async list(scope) {
        const rows = await fs.readMany(scope, {prefix: folderFor(domain, scope)});
        return rows
          .filter(row => row.path.endsWith('.json') && row.path.split('/').length === folderFor(domain, scope).split('/').length + 1)
          .map(parse)
          .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a.key).localeCompare(String(b.key)));
      },
      async values(scope) { return (await api.list(scope)).map(item => item.value); },
      async entries(scope) {
        const out = Object.create(null);
        for (const item of await api.list(scope)) out[item.key] = item.value;
        return out;
      },
      async get(scope, key) {
        const found = await fs.read(scope, `${folderFor(domain, scope)}/${fileNameFor(checkKey(key))}`);
        return found ? parse({...found.node, body: found.body}).value : undefined;
      },
      async has(scope, key) { return (await api.get(scope, key)) !== undefined; },
      async put(scope, key, value) {
        if (value === undefined) throw new TypeError('Cannot store undefined; use remove() to delete an item');
        const folder = folderFor(domain, scope);
        await fs.write(scope, `${folder}/${fileNameFor(checkKey(key))}`, serialize(key, value));
        return value;
      },
      async update(scope, key, transform) {
        const folder = folderFor(domain, scope);
        const filePath = `${folder}/${fileNameFor(checkKey(key))}`;
        return fs.transaction(scope, async tree => {
          const node = await tree.nodeAt(filePath, {lock: true});
          const current = node ? JSON.parse((await tree.bodyOf(node.contentHash)).toString('utf8')).value : undefined;
          const next = transform(current);
          if (next === undefined) {
            if (node) await tree.remove(filePath);
            return undefined;
          }
          await tree.write(filePath, serialize(key, next), node ? {baseRev: node.rev} : {baseRev: 0});
          return next;
        });
      },
      async remove(scope, key) {
        return Boolean(await fs.remove(scope, `${folderFor(domain, scope)}/${fileNameFor(checkKey(key))}`));
      },
      async clear(scope) {
        const items = await api.list(scope);
        await fs.transaction(scope, async tree => {
          for (const item of items) await tree.remove(`${folderFor(domain, scope)}/${fileNameFor(item.key)}`);
        });
        return items.length;
      },
      async count(scope) { return (await api.list(scope)).length; },
      async replaceAll(scope, object) {
        const folder = folderFor(domain, scope);
        const items = await api.list(scope);
        await fs.transaction(scope, async tree => {
          for (const item of items) {
            if (!Object.prototype.hasOwnProperty.call(object ?? {}, item.key)) await tree.remove(`${folder}/${fileNameFor(item.key)}`);
          }
          for (const [key, value] of Object.entries(object ?? {})) {
            await tree.write(`${folder}/${fileNameFor(checkKey(key))}`, serialize(key, value));
          }
        });
        return object ?? {};
      },
    };
    return Object.freeze(api);
  }
  return {collection};
}

module.exports = {SYSTEM_DOMAINS, createFsRecords, fileNameFor, folderFor, serialize};
