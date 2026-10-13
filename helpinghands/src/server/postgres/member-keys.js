'use strict';
const crypto = require('crypto');
const {withRequestContext} = require('./client');

// The keys a member may give Mochi, by the name NanoAgent reads each from (KEY_NAME there).
const MEMBER_KEYS = Object.freeze({OPENROUTER_API_KEY: 'OpenRouter'});
const KEY_LENGTH = 1000;
const VERSION = 'v1';

/** The AES-256 key every member key is sealed with, derived from Mochi's auth secret. */
function sealingKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'mochi member api keys', 32));
}

/**
 * `value` as AES-256-GCM ciphertext, bound to its member and name so a row
 * copied to another member or key does not open.
 */
function seal(key, userId, env, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${userId}\n${env}`));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body].map(part => (typeof part === 'string' ? part : part.toString('base64'))).join('.');
}

function open(key, userId, env, sealed) {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION) throw new Error(`${env} is sealed as ${version}, not ${VERSION}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(`${userId}\n${env}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}

/** Enough of a key for its owner to tell which it is, as Mochi Lab shows one (supervisor.rs key_hint). */
function keyHint(value) {
  const chars = [...value];
  return chars.length < 16 ? '…' : `${chars.slice(0, 6).join('')}…${chars.slice(-4).join('')}`;
}

/** `changes` checked: {error} or {value: [[name, key or null], …]}. */
function checkChanges(changes) {
  const pairs = changes && typeof changes === 'object' && !Array.isArray(changes) ? Object.entries(changes) : [];
  if (!pairs.length) return {error: 'changes must name at least one key'};
  for (const [name, value] of pairs) {
    if (!MEMBER_KEYS[name]) return {error: `${name} is not a key Mochi keeps`};
    if (value !== null && (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim()) || value.length > KEY_LENGTH)) {
      return {error: `${name} must be one key, without spaces, or null to remove it`};
    }
  }
  return {value: pairs.map(([name, value]) => [name, value === null ? null : value.trim()])};
}

/**
 * Members' own API keys, kept by Mochi (migration 0021): sealed at rest, only
 * ever read back for the member's own runs, and shown to them by hint alone.
 * Row-level security keeps each member to their own rows.
 */
function createPostgresMemberKeys({pool, secret}) {
  const key = sealingKey(secret);
  const run = (userId, operation) => withRequestContext(pool, {userId, workspaceId: null}, operation);

  /** Which keys the member gave Mochi, as Settings → AI lists them: {env, label, set, hint}. */
  async function list(userId) {
    const rows = await run(userId, async client => (await client.query(
      'select env, hint from member_api_key where user_id = $1', [userId],
    )).rows);
    const hints = new Map(rows.map(row => [row.env, row.hint]));
    return Object.entries(MEMBER_KEYS).map(([env, label]) => ({
      env, label, set: hints.has(env), hint: hints.get(env) ?? null,
    }));
  }

  return Object.freeze({
    list,
    /** The member's keys by name, opened, for a run of theirs. */
    async values(userId) {
      const rows = await run(userId, async client => (await client.query(
        'select env, ciphertext from member_api_key where user_id = $1', [userId],
      )).rows);
      return Object.fromEntries(rows.map(row => [row.env, open(key, userId, row.env, row.ciphertext)]));
    },
    /** Set (a key) or remove (null) the member's keys: {error} or {value: their list}. */
    async save(userId, changes) {
      const checked = checkChanges(changes);
      if (checked.error) return checked;
      await run(userId, async client => {
        for (const [env, value] of checked.value) {
          if (value === null) {
            await client.query('delete from member_api_key where user_id = $1 and env = $2', [userId, env]);
          } else {
            await client.query(
              `insert into member_api_key (user_id, env, ciphertext, hint, updated_at) values ($1, $2, $3, $4, now())
               on conflict (user_id, env) do update set ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = now()`,
              [userId, env, seal(key, userId, env, value), keyHint(value)],
            );
          }
        }
      });
      return {value: await list(userId)};
    },
  });
}

module.exports = {MEMBER_KEYS, createPostgresMemberKeys, sealingKey, seal, open, keyHint, checkChanges};
