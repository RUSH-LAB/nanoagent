'use strict';

const AGENT_RE = /^\/api\/agents\/([^/]+)$/;
const COLORS = new Set(['violet', 'blue', 'emerald', 'amber', 'rose', 'slate']);

function cleanAgent(body, sanitizeText, current = {}) {
  const source = body && typeof body === 'object' ? body : {};
  if (typeof source.name === 'string' && source.name.length > 60) return {error: 'Agent name must be 60 characters or fewer'};
  if (typeof source.description === 'string' && source.description.length > 180) return {error: 'Description must be 180 characters or fewer'};
  if (typeof source.instructions === 'string' && source.instructions.length > 10000) return {error: 'Instructions must be 10000 characters or fewer'};
  const name = typeof source.name === 'string' ? sanitizeText(source.name).trim() : current.name;
  const description = typeof source.description === 'string'
    ? sanitizeText(source.description).trim()
    : (current.description ?? '');
  const instructions = typeof source.instructions === 'string'
    ? sanitizeText(source.instructions).trim()
    : current.instructions;
  const color = COLORS.has(source.color) ? source.color : (current.color || 'violet');

  if (!name) return {error: 'Agent name is required'};
  if (!instructions) return {error: 'Agent instructions are required'};
  return {agent: {...current, name, description, instructions, color}};
}

module.exports = async function agent_routes(req, res, _url, pathname, ctx) {
  const match = AGENT_RE.exec(pathname);
  if (pathname !== '/api/agents' && !match) return;
  const {json, readBody, rateLimit, sanitizeText, collection, scopeFor, requireWorkspacePermission, crypto} = ctx;
  const agents = collection('agents');
  const scope = scopeFor(req);

  if (pathname === '/api/agents' && req.method === 'GET') {
    const values = await agents.values(scope);
    return json(res, 200, {agents: values.sort((a, b) => a.name.localeCompare(b.name))});
  }

  if (pathname === '/api/agents' && req.method === 'POST') {
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
    await agents.remove(scope, agentId);
    return json(res, 200, {deleted: true});
  }
};

module.exports.AGENT_RE = AGENT_RE;
module.exports.cleanAgent = cleanAgent;
