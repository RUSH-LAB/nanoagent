'use strict';

/**
 * The OpenRouter key a member's RUSH Lab starts with: one of their own, made
 * with OPENROUTER_MANAGEMENT_KEY in RUSH's OpenRouter workspace (WORKSPACES:
 * production's, or every other site's, such as npm start's, whose accounts are
 * copies of production's and must not disable their keys), whose lifetime
 * budget of TOTAL dollars is every member's together: OpenRouter
 * stops every key in it once that is spent. Each key is named for its member,
 * and RUSH keeps none of them: a computer that comes without one is given a
 * new key, and the member's others are disabled, kept so what they spent still
 * counts as theirs. A member who saves a key of their own is given none.
 */
const API = 'https://openrouter.ai/api/v1';
const ENV = 'OPENROUTER_API_KEY';
const WORKSPACES = {
  production: {name: 'Mochi', slug: 'mochi'},
  other: {name: 'RUSH (development)', slug: 'mochi-dev'},
};
const TOTAL = 10;

const keyName = userId => `RUSH ${userId}`;

function createOpenRouterKeys({managementKey, production, fetchImpl = fetch}) {
  if (typeof production !== 'boolean') throw new Error('createOpenRouterKeys needs production: true or false');
  const {name, slug} = production ? WORKSPACES.production : WORKSPACES.other;
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

  /** The id of RUSH's workspace, made the first time with its lifetime budget of TOTAL. */
  function workspaceId() {
    if (workspace) return workspace;
    workspace = (async () => {
      const found = await call('GET', `/workspaces/${slug}`).catch(error => {
        if (error.status === 404) return call('POST', '/workspaces', {name, slug});
        throw error;
      });
      await call('PUT', `/workspaces/${found.data.id}/budgets/lifetime`, {limit_usd: TOTAL});
      return found.data.id;
    })();
    // A workspace that could not be set up is tried again next time.
    workspace.catch(() => { workspace = null; });
    return workspace;
  }

  /** Every key RUSH made the member, disabled ones too. */
  async function memberKeys(userId) {
    const id = await workspaceId();
    const keys = [];
    for (;;) {
      const page = (await call('GET', `/keys?workspace_id=${id}&include_disabled=true&offset=${keys.length}`)).data;
      if (!page.length) break;
      keys.push(...page);
    }
    return keys.filter(key => key.name === keyName(userId));
  }

  async function give(userId) {
    const others = (await memberKeys(userId)).filter(key => !key.disabled);
    const made = await call('POST', '/keys', {name: keyName(userId), workspace_id: await workspaceId()});
    for (const key of others) await call('PATCH', `/keys/${key.hash}`, {disabled: true});
    return made.key;
  }

  return Object.freeze({
    ENV,
    /** The OpenRouter workspace's slug. */
    workspace: slug,
    workspaceId,
    /** A new key for the member. */
    give(userId) {
      const prior = giving.get(userId) ?? Promise.resolve();
      const next = prior.catch(() => {}).then(() => give(userId));
      giving.set(userId, next);
      next.finally(() => { if (giving.get(userId) === next) giving.delete(userId); }).catch(() => {});
      return next;
    },
    /** What the member has spent, in dollars, on every key RUSH made them. */
    async spent(userId) {
      return (await memberKeys(userId)).reduce((sum, key) => sum + key.usage, 0);
    },
  });
}

module.exports = {createOpenRouterKeys, TOTAL};
