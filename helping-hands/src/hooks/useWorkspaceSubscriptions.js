import {useCallback, useEffect, useState} from 'react';
import API_BASE, {apiFetch, apiJson, invalidateApiJson} from '@site/src/utils/api';

const WORKSPACE_SUBSCRIPTIONS_UPDATED = 'mochi:workspace-subscriptions-updated';

function preferencesUrl(workspaceId) {
  return `${API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/member-preferences`;
}

export function isBookSubscribed(subscriptions, collectionKey) {
  const books = subscriptions?.books;
  return !Array.isArray(books) || books.includes(collectionKey);
}

export function isGroupSubscribed(subscriptions, collectionKey, groupTitle) {
  const groups = subscriptions?.groups?.[collectionKey];
  return !Array.isArray(groups) || groups.includes(groupTitle);
}

export function orderByPreference(items, order, identity = item => item) {
  if (!Array.isArray(order) || order.length === 0) return items;
  const positions = new Map(order.map((key, index) => [key, index]));
  return items
    .map((item, index) => ({item, index, position: positions.get(identity(item))}))
    .sort((a, b) => (
      (a.position ?? order.length + a.index) - (b.position ?? order.length + b.index)
    ))
    .map(entry => entry.item);
}

export default function useWorkspaceSubscriptions(workspace) {
  const [state, setState] = useState({
    workspaceId: workspace?.id ?? null,
    preferences: null,
    loading: Boolean(workspace?.id),
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const workspaceId = workspace?.id;
    setState({workspaceId: workspaceId ?? null, preferences: null, loading: Boolean(workspaceId), error: null});
    if (!workspaceId) return () => { cancelled = true; };

    apiJson(preferencesUrl(workspaceId), {cacheMs: 5 * 60_000})
      .then(result => {
        if (cancelled) return;
        setState({
          workspaceId,
          preferences: result.ok ? result.data.settings ?? {} : {},
          loading: false,
          error: result.ok ? null : result.data.error || `Request failed (${result.status})`,
        });
      })
      .catch(error => {
        if (!cancelled) setState({workspaceId, preferences: {}, loading: false, error: error.message});
      });

    return () => { cancelled = true; };
  }, [workspace?.id]);

  useEffect(() => {
    if (typeof window === 'undefined' || !workspace?.id) return undefined;
    const update = event => {
      if (event.detail?.workspaceId !== workspace.id) return;
      setState({workspaceId: workspace.id, preferences: event.detail.preferences, loading: false, error: null});
    };
    window.addEventListener(WORKSPACE_SUBSCRIPTIONS_UPDATED, update);
    return () => window.removeEventListener(WORKSPACE_SUBSCRIPTIONS_UPDATED, update);
  }, [workspace?.id]);

  const saveSubscriptions = useCallback(async subscriptions => {
    if (!workspace?.id) throw new Error('Workspace preferences are not ready');
    const url = preferencesUrl(workspace.id);
    const response = await apiFetch(url, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({settings: {subscriptions}}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not save subscriptions');
    invalidateApiJson(url);
    const preferences = data.settings ?? {subscriptions};
    setState({workspaceId: workspace.id, preferences, loading: false, error: null});
    window.dispatchEvent(new CustomEvent(WORKSPACE_SUBSCRIPTIONS_UPDATED, {
      detail: {workspaceId: workspace.id, preferences},
    }));
    return preferences;
  }, [workspace?.id]);

  const current = state.workspaceId === workspace?.id ? state : {preferences: null, loading: true, error: null};
  return {
    preferences: current.preferences,
    subscriptions: current.preferences?.subscriptions ?? null,
    loading: current.loading,
    error: current.error,
    saveSubscriptions,
  };
}
