'use strict';

// A workspace agent is a name and instructions; the model each member's chat with it
// runs on is theirs to choose (Settings → AI, ai-settings.js).
const AGENT_RE = /^\/api\/agents\/([^/]+)$/;
const COLORS = new Set(['violet', 'blue', 'emerald', 'amber', 'rose', 'slate']);
const DEFAULT_AGENT_ID = 'rush';
// The default agent's id before version 8 named it after RUSH Lab.
const OLD_DEFAULT_AGENT_ID = 'mochi';
const DEFAULTS_VERSION = 8;
// What agents once carried to choose their model.
const MODEL_FIELDS = ['provider', 'model', 'profileId'];

function defaultAgent(now = new Date().toISOString()) {
  return {
    id: DEFAULT_AGENT_ID,
    name: 'RUSH',
    description: '',
    instructions: '',
    tools: [],
    color: 'violet',
    builtin: true,
    defaultsVersion: DEFAULTS_VERSION,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function ensureDefaultAgent(agents, scope) {
  const values = await Promise.all((await agents.values(scope)).map(async agent => {
    if (agent.id !== OLD_DEFAULT_AGENT_ID || !agent.builtin) return agent;
    const moved = {...agent, id: DEFAULT_AGENT_ID};
    await agents.put(scope, moved.id, moved);
    await agents.remove(scope, OLD_DEFAULT_AGENT_ID);
    return moved;
  }));
  const normalized = await Promise.all(values.map(async agent => {
    const oldDefaultDescription = agent.id === DEFAULT_AGENT_ID
      && agent.builtin
      && agent.description === 'Your general-purpose assistant';
    const oldMochiDefaults = agent.id === DEFAULT_AGENT_ID
      && agent.builtin
      && (agent.defaultsVersion ?? 0) < DEFAULTS_VERSION;
    if (!MODEL_FIELDS.some(field => Object.hasOwn(agent, field))
      && typeof agent.instructions === 'string'
      && !oldDefaultDescription
      && !oldMochiDefaults) return agent;
    const updated = Object.fromEntries(Object.entries({
      ...agent,
      ...(oldDefaultDescription ? {description: ''} : {}),
      instructions: typeof agent.instructions === 'string' ? agent.instructions : '',
      ...(oldMochiDefaults ? {defaultsVersion: DEFAULTS_VERSION} : {}),
      // Version 7 renamed the default agent Mochi to RUSH; a name its workspace chose stays.
      ...(oldMochiDefaults && agent.name === 'Mochi' ? {name: 'RUSH'} : {}),
    }).filter(([key]) => !MODEL_FIELDS.includes(key)));
    await agents.put(scope, updated.id, updated);
    return updated;
  }));
  if (normalized.some(agent => agent.id === DEFAULT_AGENT_ID)) return normalized;
  const agent = defaultAgent();
  await agents.put(scope, agent.id, agent);
  return [...normalized, agent];
}

function cleanAgent(body, sanitizeText, current = {}) {
  const source = body && typeof body === 'object' ? body : {};
  if (typeof source.name === 'string' && source.name.length > 60) return {error: 'Agent name must be 60 characters or fewer'};
  if (typeof source.description === 'string' && source.description.length > 180) return {error: 'Description must be 180 characters or fewer'};
  if (typeof source.instructions === 'string' && source.instructions.length > 10000) return {error: 'Instructions must be 10000 characters or fewer'};
  if (MODEL_FIELDS.some(field => source[field] !== undefined)) {
    return {error: 'An agent chooses no model: each member chooses theirs in Settings → AI'};
  }
  const name = typeof source.name === 'string' ? sanitizeText(source.name).trim() : current.name;
  const description = typeof source.description === 'string'
    ? sanitizeText(source.description).trim()
    : (current.description ?? '');
  const instructions = typeof source.instructions === 'string'
    ? sanitizeText(source.instructions).trim()
    : (current.instructions ?? '');
  const color = COLORS.has(source.color) ? source.color : (current.color || 'violet');

  if (!name) return {error: 'Agent name is required'};
  const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !MODEL_FIELDS.includes(key)));
  return {agent: {...kept, name, description, instructions, tools: current.tools ?? [], color}};
}

module.exports = async function agent_routes(req, res, _url, pathname, ctx) {
  const match = AGENT_RE.exec(pathname);
  if (pathname !== '/api/agents' && !match) return;
  const {json, readBody, rateLimit, sanitizeText, collection, scopeFor, requireWorkspacePermission, crypto} = ctx;
  const agents = collection('agents');
  const scope = scopeFor(req);
  const existing = await ensureDefaultAgent(agents, scope);

  if (req.method === 'GET' && pathname === '/api/agents') {
    return json(res, 200, {agents: existing.sort((a, b) => a.name.localeCompare(b.name))});
  }

  if (req.method === 'POST' && pathname === '/api/agents') {
    requireWorkspacePermission(req.context, 'content:edit');
    if (!await rateLimit(`agents-write:${req.auth?.userId}`, 30)) {
      return json(res, 429, {error: 'Too many requests. Try again in a minute.'});
    }
    try {
      const parsed = cleanAgent(await readBody(req), sanitizeText);
      if (parsed.error) return json(res, 400, {error: parsed.error});
      const now = new Date().toISOString();
      const agent = {
        ...parsed.agent,
        id: crypto.randomUUID(),
        createdBy: req.auth?.userId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      await agents.put(scope, agent.id, agent);
      return json(res, 201, {agent});
    } catch (error) {
      if (error?.status) throw error;
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method !== 'PATCH' && req.method !== 'DELETE') return;
  requireWorkspacePermission(req.context, 'content:edit');
  const agentId = decodeURIComponent(match[1]);
  const current = await agents.get(scope, agentId);
  if (!current) return json(res, 404, {error: 'Agent not found'});

  if (req.method === 'PATCH') {
    try {
      const parsed = cleanAgent(await readBody(req), sanitizeText, current);
      if (parsed.error) return json(res, 400, {error: parsed.error});
      const agent = {...parsed.agent, id: current.id, updatedAt: new Date().toISOString()};
      await agents.put(scope, agent.id, agent);
      return json(res, 200, {agent});
    } catch (error) {
      if (error?.status) throw error;
      return json(res, 400, {error: 'Invalid request'});
    }
  }

  if (req.method === 'DELETE') {
    if (current.builtin) return json(res, 400, {error: 'The default agent cannot be deleted'});
    await agents.remove(scope, agentId);
    return json(res, 200, {deleted: true});
  }
};

module.exports.AGENT_RE = AGENT_RE;
module.exports.cleanAgent = cleanAgent;
module.exports.defaultAgent = defaultAgent;
