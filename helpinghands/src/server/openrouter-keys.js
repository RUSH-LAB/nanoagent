'use strict';

/**
 * The OpenRouter key a member's Mochi Lab starts with: one of their own, made
 * on Mochi's OpenRouter account with OPENROUTER_MANAGEMENT_KEY and capped at
 * CREDIT dollars in all. Mochi keeps its hash, never the key (grants), so a
 * computer that comes without one is given a new key with what the last one
 * has left, and the last one is deleted. A member who saves a key of their own
 * is given none.
 */
const API = 'https://openrouter.ai/api/v1/keys';
const ENV = 'OPENROUTER_API_KEY';
const CREDIT = 5;

function createOpenRouterKeys({managementKey, grants, fetchImpl = fetch}) {
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

  return Object.freeze({
    ENV,
    /** A new key for the member, with what is left of their credit; null once it is spent. */
    async give(userId) {
      const previous = await grants.hash(userId);
      const left = previous ? (await call('GET', `/${previous}`)).data.limit_remaining : CREDIT;
      if (!(left > 0)) return null;
      const made = await call('POST', '', {name: `Mochi ${userId}`, limit: left});
      await grants.put(userId, made.data.hash);
      if (previous) await call('DELETE', `/${previous}`);
      return made.key;
    },
  });
}

module.exports = {createOpenRouterKeys, CREDIT};
