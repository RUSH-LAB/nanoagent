'use strict';

/**
 * The OpenRouter key a member's Mochi Lab starts with: one of their own, made
 * with OPENROUTER_MANAGEMENT_KEY in Mochi's OpenRouter workspace (WORKSPACE).
 * OpenRouter stops a key at whichever is spent first: the member's CREDIT, the
 * key's own limit, or TOTAL, the workspace's lifetime budget for every member
 * together. Mochi keeps each key's hash, never the key (grants), so a computer
 * that comes without one is given a new key with what the last one has left,
 * and the last one is deleted. A member who saves a key of their own is given
 * none.
 */
const API = 'https://openrouter.ai/api/v1';
const ENV = 'OPENROUTER_API_KEY';
const WORKSPACE = 'mochi';
const CREDIT = 5;
const TOTAL = 10;

function createOpenRouterKeys({managementKey, grants, fetchImpl = fetch}) {
  // One give at a time for each member, so two computers at once cannot both make a key.
  const giving = new Map();
  let workspace = null;

  async function call(method, path, body) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {Authorization: `Bearer ${managementKey}`, 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`OpenRouter ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`), {status: response.status});
    }
    return JSON.parse(text);
  }

  /** The id of Mochi's workspace, made the first time with its lifetime budget of TOTAL. */
  function workspaceId() {
    if (workspace) return workspace;
    workspace = (async () => {
      const found = await call('GET', `/workspaces/${WORKSPACE}`).catch(error => {
        if (error.status === 404) return call('POST', '/workspaces', {name: 'Mochi', slug: WORKSPACE});
        throw error;
      });
      await call('PUT', `/workspaces/${found.data.id}/budgets/lifetime`, {limit_usd: TOTAL});
      return found.data.id;
    })();
    // A workspace that could not be set up is tried again next time.
    workspace.catch(() => { workspace = null; });
    return workspace;
  }

  async function give(userId) {
    const workspaceIdNow = await workspaceId();
    const previous = await grants.hash(userId);
    const left = previous ? (await call('GET', `/keys/${previous}`)).data.limit_remaining : CREDIT;
    if (!(left > 0)) return null;
    const made = await call('POST', '/keys', {name: `Mochi ${userId}`, limit: left, workspace_id: workspaceIdNow});
    await grants.put(userId, made.data.hash);
    if (previous) await call('DELETE', `/keys/${previous}`);
    return made.key;
  }

  return Object.freeze({
    ENV,
    workspaceId,
    /** A new key for the member, with what is left of their credit; null once it is spent. */
    give(userId) {
      const prior = giving.get(userId) ?? Promise.resolve();
      const next = prior.catch(() => {}).then(() => give(userId));
      giving.set(userId, next);
      next.finally(() => { if (giving.get(userId) === next) giving.delete(userId); }).catch(() => {});
      return next;
    },
  });
}

module.exports = {createOpenRouterKeys, CREDIT, TOTAL};
