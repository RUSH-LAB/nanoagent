'use strict';

const modelCatalog = require('../../ai-models.json');

const AGENT_RE = /^\/api\/agents\/([^/]+)$/;
const COLORS = new Set(['violet', 'blue', 'emerald', 'amber', 'rose', 'slate']);
const MODELS = new Set(modelCatalog.models.map(model => model.id));
const DEFAULT_MODEL = modelCatalog.defaultModel;
const DEFAULT_AGENT_ID = 'mochi';
const DEFAULTS_VERSION = 4;

function defaultAgent(now = new Date().toISOString()) {
  return {
    id: DEFAULT_AGENT_ID,
    name: 'Mochi',
    description: '',
    instructions: '',
    model: DEFAULT_MODEL,
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
  const values = await agents.values(scope);
  const normalized = await Promise.all(values.map(async agent => {
    const oldDefaultDescription = agent.id === DEFAULT_AGENT_ID
      && agent.builtin
      && agent.description === 'Your general-purpose assistant';
    const oldMochiDefaults = agent.id === DEFAULT_AGENT_ID
      && agent.builtin
      && (agent.defaultsVersion ?? 0) < DEFAULTS_VERSION;
    if (!Object.hasOwn(agent, 'provider')
      && MODELS.has(agent.model)
      && typeof agent.instructions === 'string'
      && !oldDefaultDescription
      && !oldMochiDefaults) return agent;
    const {provider: _legacyProvider, ...withoutProvider} = agent;
    const updated = {
      ...withoutProvider,
      ...(oldDefaultDescription ? {description: ''} : {}),
      instructions: typeof agent.instructions === 'string' ? agent.instructions : '',
      model: MODELS.has(agent.model) ? agent.model : DEFAULT_MODEL,
      ...(oldMochiDefaults ? {defaultsVersion: DEFAULTS_VERSION} : {}),
    };
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
  if (source.provider !== undefined) return {error: 'Model selection is managed by NanoAgent'};
  if (source.model !== undefined && !MODELS.has(source.model)) return {error: 'Unsupported AI model'};
  const name = typeof source.name === 'string' ? sanitizeText(source.name).trim() : current.name;
  const description = typeof source.description === 'string'
    ? sanitizeText(source.description).trim()
    : (current.description ?? '');
  const instructions = typeof source.instructions === 'string'
    ? sanitizeText(source.instructions).trim()
    : (current.instructions ?? '');
  const model = source.model ?? current.model ?? DEFAULT_MODEL;
  const color = COLORS.has(source.color) ? source.color : (current.color || 'violet');

  if (!name) return {error: 'Agent name is required'};
  const {provider: _legacyProvider, ...withoutProvider} = current;
  return {agent: {...withoutProvider, name, description, instructions, model, tools: current.tools ?? [], color}};
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
    if (!rateLimit(`agents-write:${req.auth?.userId}`, 30)) {
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
    if (current.builtin) return json(res, 400, {error: 'The default Mochi agent cannot be deleted'});
    await agents.remove(scope, agentId);
    return json(res, 200, {deleted: true});
  }
};

module.exports.AGENT_RE = AGENT_RE;
module.exports.cleanAgent = cleanAgent;
module.exports.defaultAgent = defaultAgent;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
module.exports.MODELS = MODELS;
