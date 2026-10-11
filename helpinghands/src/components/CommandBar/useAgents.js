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
  const [profileCatalog, setProfileCatalog] = useState({defaultProfile: '', profiles: []});
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [data, catalog] = await Promise.all([
        call('/api/agents'),
        call('/api/ai/profiles'),
      ]);
      setAgents(Array.isArray(data.agents) ? data.agents : []);
      setProfileCatalog({
        defaultProfile: typeof catalog.defaultProfile === 'string' ? catalog.defaultProfile : '',
        profiles: Array.isArray(catalog.profiles) ? catalog.profiles : [],
      });
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
        profileId: draft.profileId,
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

  return {agents, profileCatalog, status, error, reload: load, save, remove};
}
