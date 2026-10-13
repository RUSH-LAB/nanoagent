import {useCallback, useEffect, useState} from 'react';
import API_BASE, {apiFetch} from '@site/src/utils/api';

const JSON_HEADERS = {'Content-Type': 'application/json'};

async function call(path, init) {
  const response = await apiFetch(`${API_BASE}${path}`, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function useAgents() {
  const [agents, setAgents] = useState([]);
  // The models on the member's computer (/api/ai/models) and their settings (/model reads them).
  const [ai, setAi] = useState({models: [], defaults: {}, settings: null});
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [data, {settings}, listing] = await Promise.all([call('/api/agents'), call('/api/ai/settings'), call('/api/ai/models')]);
      setAgents(Array.isArray(data.agents) ? data.agents : []);
      setAi({models: listing.models, defaults: listing.defaults, settings});
      setStatus('ready');
      setError(null);
    } catch (err) {
      setStatus('error');
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (draft) => {
    const editing = Boolean(draft.id);
    const path = editing ? `/api/agents/${encodeURIComponent(draft.id)}` : '/api/agents';
    const data = await call(path, {
      method: editing ? 'PATCH' : 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        color: draft.color,
      }),
    });
    setAgents((current) => {
      const next = editing
        ? current.map(agent => (agent.id === data.agent.id ? data.agent : agent))
        : [...current, data.agent];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
    return data.agent;
  }, []);

  const remove = useCallback(async (id) => {
    await call(`/api/agents/${encodeURIComponent(id)}`, {method: 'DELETE'});
    setAgents(current => current.filter(agent => agent.id !== id));
  }, []);

  return {agents, ai, status, error, reload: load, save, remove};
}
