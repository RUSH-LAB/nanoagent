'use strict';

/**
 * The OpenRouter key a member's Mochi Lab starts with: one of their own, made
 * on Mochi's OpenRouter account with OPENROUTER_MANAGEMENT_KEY and capped at
 * CREDIT dollars in all. Mochi keeps its hash and hint, never the key (grants),
 * so a computer that comes without one is given a new key with what the last
 * one has left, and the last one is deleted. A member who saves a key of their
 * own is given none.
 */
const API = 'https://openrouter.ai/api/v1/keys';
const ENV = 'OPENROUTER_API_KEY';
const CREDIT = 5;

/** How a key begins and ends, as Mochi Lab shows it (desktop supervisor.rs key_hint). */
function keyHint(value) {
  const chars = [...value];
  return chars.length < 16 ? '…' : `${chars.slice(0, 6).join('')}…${chars.slice(-4).join('')}`;
}

function createOpenRouterKeys({managementKey, grants, fetchImpl = fetch}) {
  // One give at a time for each member, so two computers at once cannot both make a key.
  const giving = new Map();

  async function call(method, path, body) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {Authorization: `Bearer ${managementKey}`, 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenRouter ${method} /keys${path} failed (${response.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  /** What is left of the member's credit, on the key Mochi made them last. */
  const left = async grant => (grant ? (await call('GET', `/${grant.hash}`)).data.limit_remaining : CREDIT);

  async function give(userId) {
    const previous = await grants.get(userId);
    const credit = await left(previous);
    if (!(credit > 0)) return null;
    const made = await call('POST', '', {name: `Mochi ${userId}`, limit: credit});
    await grants.put(userId, {hash: made.data.hash, hint: keyHint(made.key)});
    if (previous) await call('DELETE', `/${previous.hash}`);
    return made.key;
  }

  return Object.freeze({
    ENV,
    /** A new key for the member, with what is left of their credit; null once it is spent. */
    give(userId) {
      const prior = giving.get(userId) ?? Promise.resolve();
      const next = prior.catch(() => {}).then(() => give(userId));
      giving.set(userId, next);
      next.finally(() => { if (giving.get(userId) === next) giving.delete(userId); }).catch(() => {});
      return next;
    },
    /**
     * What the member has spent of their credit, `{used, total}` in dollars, when the key
     * their computer holds (by its `hint`) is the one Mochi made them; else null.
     */
    async credit(userId, hint) {
      const grant = await grants.get(userId);
      if (!grant || grant.hint !== hint) return null;
      return {used: Math.max(0, CREDIT - await left(grant)), total: CREDIT};
    },
  });
}

module.exports = {createOpenRouterKeys, keyHint, CREDIT};
